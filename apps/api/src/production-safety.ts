import { createHmac, timingSafeEqual } from "node:crypto";
import type { ContentSafetyProvider, MediaSafetyProvider } from "./content-safety.js";
import type { Letter, Material } from "./domain.js";
import { ApiError } from "./errors.js";
import { OperationDeadline } from "./deadline.js";
import type { MediaSafetyCheck, Repository } from "./repository.js";
import type { WarmLetterService } from "./service.js";
import type { MediaCheckCallback } from "./wechat-moderation-callback.js";

/** Private media fetch credentials are independent of upload and public-share tokens. */
export class ProductionSafety {
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly submissionRetryAfter = new Map<string, number>();
  constructor(private readonly options: {
    repository: Repository;
    service: WarmLetterService;
    provider: ContentSafetyProvider & MediaSafetyProvider;
    publicBaseUrl: string;
    signingKeys: readonly Uint8Array[];
    normalizeMaterial?: (material: Material) => Promise<Material>;
    now?: () => Date;
  }) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }

  mediaUrl(material: Material): string {
    const expires = Math.floor(this.now().getTime() / 1000) + 45 * 60;
    const signature = this.signature(material.id, expires, this.options.signingKeys[0]!);
    return `${this.options.publicBaseUrl}/v1/safety/media/${material.id}?expires=${expires}&signature=${signature}`;
  }

  verifyMedia(id: string, query: Record<string, unknown>): Material {
    const expires = typeof query.expires === "string" && /^\d{1,12}$/.test(query.expires) ? Number(query.expires) : 0;
    const signature = typeof query.signature === "string" ? query.signature : "";
    if (expires <= this.now().getTime() / 1000 || !/^[a-f0-9]{64}$/.test(signature) ||
      !this.options.signingKeys.some((key) => timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(this.signature(id, expires, key), "hex")))) {
      throw new ApiError(404, "NOT_FOUND", "访问凭据无效");
    }
    const material = this.options.repository.getMaterial(id);
    if (!material || material.status !== "READY" || !material.objectKey) throw new ApiError(404, "NOT_FOUND", "素材不存在");
    return material;
  }

  private signature(id: string, expires: number, key: Uint8Array): string {
    return createHmac("sha256", key).update(`wechat-safety-v1\n${id}\n${expires}`).digest("hex");
  }

  async submitMaterial(material: Material): Promise<void> {
    if (material.type === "text") return;
    const active = this.submissions.get(material.id);
    if (active) return active;
    const submission = this.performSubmission(material).finally(() => this.submissions.delete(material.id));
    this.submissions.set(material.id, submission);
    return submission;
  }

  private async performSubmission(material: Material): Promise<void> {
    const repository = this.options.repository;
    const previous = repository.getLatestMediaSafetyCheck(material.id);
    const nowMs = this.now().getTime();
    if (previous?.status === "pass" || previous?.status === "reject") return;
    if (previous?.status === "pending" && nowMs - Date.parse(previous.createdAt) < 35 * 60_000) return;
    if ((previous?.status === "failed" && nowMs - Date.parse(previous.updatedAt) < 60_000) ||
      (this.submissionRetryAfter.get(material.id) ?? 0) > nowMs) {
      throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查暂时不可用，请一分钟后重试");
    }
    const current = repository.getMaterial(material.id);
    const user = repository.getUser(material.userId);
    if (!current || current.status !== "READY" || !user) throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
    // Provider failure may not yield a trace ID. Bound local retries in that case too.
    for (const [id, until] of this.submissionRetryAfter) if (until <= nowMs) this.submissionRetryAfter.delete(id);
    if (this.submissionRetryAfter.size >= 10_000) throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查繁忙，请稍后重试");
    this.submissionRetryAfter.set(material.id, nowMs + 60_000);
    const result = await this.options.provider.submitMedia({
      mediaUrl: this.mediaUrl(current), mediaType: material.type === "audio" ? "audio" : "image", openId: user.openId, scene: 4,
    });
    if (result.decision !== "pending") {
      if (result.reason === "login-required") throw new ApiError(401, "WECHAT_LOGIN_REQUIRED", "请重新打开小程序并登录后重试");
      throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查暂时不可用，请稍后重试");
    }
    // Deletion while WeChat is responding must never recreate account or material data.
    const latest = repository.getMaterial(material.id);
    if (!latest || latest.status !== "READY" || latest.objectKey !== current.objectKey ||
      latest.contentType !== current.contentType || latest.userId !== user.id || !repository.getUser(user.id)) {
      this.submissionRetryAfter.delete(material.id);
      return;
    }
    const now = this.now().toISOString();
    repository.saveMediaSafetyCheck({traceId: result.traceId, materialId: material.id, userId: user.id,
      status: "pending", createdAt: now, updatedAt: now});
    this.submissionRetryAfter.delete(material.id);
  }

  acceptCallback(result: MediaCheckCallback): void {
    const repository = this.options.repository;
    const check = repository.getMediaSafetyCheck(result.traceId);
    // A callback can race the submit response. Ask WeChat to retry rather than discard it.
    if (!check) throw new ApiError(503, "SAFETY_RECEIPT_PENDING", "检查记录尚未就绪");
    if (check.status !== "pending" || repository.getLatestMediaSafetyCheck(check.materialId)?.traceId !== result.traceId ||
      this.now().getTime() - Date.parse(check.createdAt) >= 35 * 60_000) return;
    let diagnostic: MediaSafetyCheck["diagnostic"];
    if (result.decision === "unavailable") {
      diagnostic = { reason: "provider" };
      if (Number.isSafeInteger(result.wechatErrorCode)) diagnostic.wechatErrorCode = result.wechatErrorCode;
    } else if (result.decision === "reject" && (result.reason === "risky" || result.reason === "review")) {
      diagnostic = { reason: result.reason };
    }
    repository.saveMediaSafetyCheck({...check,
      status: result.decision === "allow" ? "pass" : result.decision === "reject" ? "reject" : "failed",
      diagnostic,
      updatedAt: this.now().toISOString()});
    if (result.decision !== "allow") {
      for (const letter of repository.listLetters(check.userId)) {
        if (letter.state === "PUBLISHED" && letter.materialIds.includes(check.materialId)) this.options.service.revokeShare(check.userId, letter.id);
      }
    }
  }

  async requirePublishable(userId: string, letterId: string): Promise<Letter> {
    const deadline = new OperationDeadline(60_000, () =>
      new ApiError(504, "CONTENT_SAFETY_TIMEOUT", "安全检查等待超时，草稿已保存，请稍后再确认分享"));
    try {
      const {repository, service} = this.options;
      const snapshot = service.getLetter(userId, letterId);
      const draft = snapshot.state === "PUBLISHED" ? snapshot.confirmedDraft : snapshot.draft;
      if (!draft) throw new ApiError(409, "LETTER_NOT_READY", "请先生成家书");
      const materials: Material[] = [];
      for (const id of snapshot.materialIds) {
        let material = repository.getMaterial(id);
        if (!material || material.status !== "READY") throw new ApiError(409, "MATERIAL_NOT_READY", "素材已删除或未完成上传");
        if (this.options.normalizeMaterial) {
          const current = material;
          material = await deadline.wait(() => this.options.normalizeMaterial!(current));
        }
        materials.push(material);
        const readyMaterial = material;
        await deadline.wait(() => this.submitMaterial(readyMaterial));
      }
      this.assertMediaPassed(snapshot);
      await deadline.wait(() => service.checkText(userId, [snapshot.recipient, draft.title, draft.greeting,
        ...draft.paragraphs.map((part) => part.text), draft.closing, draft.signature, ...materials.map((part) => part.name)].join("\n")));
      const latest = service.getLetter(userId, letterId);
      if (JSON.stringify(latest) !== JSON.stringify(snapshot)) throw new ApiError(409, "DRAFT_CHANGED", "家书已更新，请重新确认");
      this.assertMediaPassed(latest);
      return latest;
    } finally {
      deadline.dispose();
    }
  }

  assertMediaPassed(letter: Letter): void {
    for (const id of letter.materialIds) {
      const material = this.options.repository.getMaterial(id);
      if (!material || material.status !== "READY") throw new ApiError(409, "MATERIAL_NOT_READY", "素材已删除或未完成上传");
      if (material.type === "text") continue;
      const check = this.options.repository.getLatestMediaSafetyCheck(id);
      if (check?.status === "reject") throw new ApiError(422, "CONTENT_SAFETY_REJECTED", "部分素材未通过安全检查，请移除后再试");
      if (check?.status !== "pass") throw new ApiError(409, "CONTENT_SAFETY_PENDING", "照片或语音正在安全检查中，草稿已保存，请稍后再确认分享");
    }
  }
}
