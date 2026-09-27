import { createHmac, timingSafeEqual } from "node:crypto";
import type { ContentSafetyProvider, MediaSafetyProvider } from "./content-safety.js";
import type { Letter, Material } from "./domain.js";
import { ApiError } from "./errors.js";
import { OperationDeadline } from "./deadline.js";
import type { MediaSafetyCheck, Repository } from "./repository.js";
import type { WarmLetterService } from "./service.js";
import type { MediaCheckCallback } from "./wechat-moderation-callback.js";

type BackgroundMediaTask = { material: Material; fingerprint: string; deadline: OperationDeadline };

function materialFingerprint(material: Material): string {
  return JSON.stringify([material.id, material.userId, material.type, material.objectKey, material.contentType]);
}

/** Private media fetch credentials are independent of upload and public-share tokens. */
export class ProductionSafety {
  private readonly submissions = new Map<string, { fingerprint: string; promise: Promise<void>; signal?: AbortSignal }>();
  private readonly submissionRetryAfter = new Map<string, { fingerprint: string; until: number; failure: ApiError }>();
  private readonly backgroundTasks = new Map<string, BackgroundMediaTask>();
  private readonly backgroundQueue: BackgroundMediaTask[] = [];
  private backgroundRunning?: BackgroundMediaTask;
  private lastBackgroundUser?: string;
  private closed = false;
  constructor(private readonly options: {
    repository: Repository;
    service: WarmLetterService;
    provider: ContentSafetyProvider & MediaSafetyProvider;
    publicBaseUrl: string;
    signingKeys: readonly Uint8Array[];
    normalizeMaterial?: (material: Material) => Promise<Material>;
    prepareMediaUrl?: (material: Material, signal?: AbortSignal) => Promise<string>;
    backgroundMediaSafety?: boolean;
    now?: () => Date;
  }) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }

  private currentSource(material: Material): boolean {
    const current = this.options.repository.getMaterial(material.id);
    return Boolean(current && current.status === "READY" && materialFingerprint(current) === materialFingerprint(material) &&
      this.options.repository.getUser(material.userId));
  }

  private pending(): ApiError {
    return new ApiError(409, "CONTENT_SAFETY_PENDING", "照片或语音正在安全检查中，草稿已保存，请稍后再确认分享");
  }

  /** In-memory work, bounded to 125 seconds including queue time. Explicit requests retry after restart. */
  scheduleMaterial(material: Material): void {
    if (!this.options.backgroundMediaSafety || this.closed) throw this.mediaCheckFailure();
    if (material.type === "text") return;
    if (!this.currentSource(material)) throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
    this.pruneBackground();
    const fingerprint = materialFingerprint(material);
    const existing = this.backgroundTasks.get(material.id);
    if (existing?.fingerprint === fingerprint) return;
    if (existing) this.cancelMaterial(material.id);
    const check = this.options.repository.getLatestMediaSafetyCheck(material.id);
    const now = this.now().getTime();
    if (check?.status === "pass" || check?.status === "reject" ||
      (check?.status === "pending" && now - Date.parse(check.createdAt) < 35 * 60_000)) return;
    const retry = this.submissionRetryAfter.get(material.id);
    if (retry?.fingerprint === fingerprint && retry.until > now) throw retry.failure;
    if (check?.status === "failed" && now - Date.parse(check.updatedAt) < 60_000) throw this.mediaCheckFailure(check);
    if (this.backgroundTasks.size >= 32 || [...this.backgroundTasks.values()].filter(task => task.material.userId === material.userId).length >= 4) {
      throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查繁忙，请稍后重试");
    }
    const task: BackgroundMediaTask = { material: structuredClone(material), fingerprint,
      deadline: new OperationDeadline(125_000, () => this.backgroundTimeout()) };
    this.backgroundTasks.set(material.id, task);
    task.deadline.addCleanup(() => {
      // This also expires waiting tasks, so a full queue never means hours of pending.
      if (this.backgroundTasks.get(task.material.id) !== task) return;
      if (!this.closed && this.currentSource(task.material)) {
        this.submissionRetryAfter.set(task.material.id, { fingerprint: task.fingerprint,
          until: this.now().getTime() + 60_000, failure: this.backgroundTimeout() });
      }
      this.removeBackgroundTask(task);
      this.drainBackground();
    });
    this.backgroundQueue.push(task);
    this.drainBackground();
  }

  cancelMaterial(materialId: string): void {
    const task = this.backgroundTasks.get(materialId);
    if (!task) return;
    this.removeBackgroundTask(task);
    this.submissionRetryAfter.delete(materialId);
    task.deadline.dispose();
    this.drainBackground();
  }

  private removeBackgroundTask(task: BackgroundMediaTask): void {
    if (this.backgroundTasks.get(task.material.id) === task) this.backgroundTasks.delete(task.material.id);
    const index = this.backgroundQueue.indexOf(task);
    if (index !== -1) this.backgroundQueue.splice(index, 1);
    const submission = this.submissions.get(task.material.id);
    if (submission?.signal === task.deadline.signal) this.submissions.delete(task.material.id);
  }

  private backgroundTimeout(): ApiError {
    return new ApiError(504, "CONTENT_SAFETY_TIMEOUT", "安全检查等待超时，草稿已保存，请稍后再确认分享");
  }

  cancelUser(userId: string): void {
    for (const task of this.backgroundTasks.values()) if (task.material.userId === userId) this.cancelMaterial(task.material.id);
  }

  close(): void {
    this.closed = true;
    for (const task of this.backgroundTasks.values()) this.cancelMaterial(task.material.id);
  }

  private pruneBackground(): void {
    for (const task of this.backgroundTasks.values()) if (!this.currentSource(task.material)) this.cancelMaterial(task.material.id);
  }

  private drainBackground(): void {
    if (this.closed || this.backgroundRunning) return;
    this.pruneBackground();
    if (this.closed || this.backgroundRunning) return;
    // Prefer another owner between jobs; each owner can hold at most four slots.
    const next = this.backgroundQueue.findIndex(task => task.material.userId !== this.lastBackgroundUser);
    const task = this.backgroundQueue.splice(Math.max(0, next), 1)[0];
    if (!task) return;
    this.backgroundRunning = task;
    this.lastBackgroundUser = task.material.userId;
    // Both the worker and this finalizer consume rejection. No unobserved retry loop.
    void this.runBackground(task).finally(() => {
      this.removeBackgroundTask(task);
      task.deadline.dispose();
      if (this.backgroundRunning === task) this.backgroundRunning = undefined;
      this.drainBackground();
    }).catch(() => undefined);
  }

  private async runBackground(task: BackgroundMediaTask): Promise<void> {
    const deadline = task.deadline;
    const assertRegistered = () => {
      deadline.check();
      if (this.closed || this.backgroundTasks.get(task.material.id) !== task) throw this.mediaCheckFailure();
    };
    const assertActive = () => {
      assertRegistered();
      if (!this.currentSource(task.material)) throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
    };
    try {
      assertActive();
      if (this.options.normalizeMaterial) {
        const material = await deadline.wait(() => this.options.normalizeMaterial!(task.material));
        assertRegistered();
        if (!this.currentSource(material)) throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
        task.material = material;
        task.fingerprint = materialFingerprint(material);
      }
      assertActive();
      await deadline.wait(() => this.submitMaterial(task.material, assertActive, deadline.signal));
    } catch (error) {
      if (!this.closed && this.backgroundTasks.get(task.material.id) === task && this.currentSource(task.material)) {
        // Long work may outlive its initial retry timer. Start cooldown at failure.
        this.submissionRetryAfter.set(task.material.id, { fingerprint: task.fingerprint,
          until: this.now().getTime() + 60_000, failure: this.submissionFailure(error) });
      }
    }
  }

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

  private mediaCheckFailure(check?: MediaSafetyCheck): ApiError {
    if (check?.status === "failed" && check.diagnostic?.wechatErrorCode === -1008) {
      return new ApiError(503, "CONTENT_SAFETY_DOWNLOAD_FAILED", "图片或录音的安全检查暂未成功，草稿和素材已保留，请稍后重试");
    }
    return new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查暂时不可用，请稍后重试");
  }

  private submissionFailure(error: unknown): ApiError {
    // Only retain known classifications, never a provider message or signed URL.
    // A failed preparation has no new WeChat trace; an older download failure
    // must not be presented as the result of this newer attempt.
    switch (error instanceof ApiError ? error.code : undefined) {
      case "WECHAT_LOGIN_REQUIRED":
        return new ApiError(401, "WECHAT_LOGIN_REQUIRED", "请重新打开小程序并登录后重试");
      case "CONTENT_SAFETY_TIMEOUT":
        return new ApiError(504, "CONTENT_SAFETY_TIMEOUT", "安全检查等待超时，草稿已保存，请稍后再确认分享");
      case "MATERIAL_NOT_FOUND":
        return new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
      default:
        return this.mediaCheckFailure();
    }
  }

  async submitMaterial(material: Material, assertActive: () => void = () => {}, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw this.mediaCheckFailure();
    assertActive();
    if (material.type === "text") return;
    const fingerprint = materialFingerprint(material);
    const active = this.submissions.get(material.id);
    if (active?.fingerprint === fingerprint && !active.signal?.aborted) return active.promise;
    const submission = this.performSubmission(material, assertActive, signal).catch((error: unknown) => {
      const retry = this.submissionRetryAfter.get(material.id);
      if (this.submissions.get(material.id)?.promise === submission && retry?.fingerprint === fingerprint) retry.failure = this.submissionFailure(error);
      throw error;
    }).finally(() => { if (this.submissions.get(material.id)?.promise === submission) this.submissions.delete(material.id); });
    this.submissions.set(material.id, { fingerprint, promise: submission, signal });
    return submission;
  }

  private async performSubmission(material: Material, assertActive: () => void, signal?: AbortSignal): Promise<void> {
    const repository = this.options.repository;
    const previous = repository.getLatestMediaSafetyCheck(material.id);
    const nowMs = this.now().getTime();
    if (previous?.status === "pass" || previous?.status === "reject") return;
    if (previous?.status === "pending" && nowMs - Date.parse(previous.createdAt) < 35 * 60_000) return;
    const retry = this.submissionRetryAfter.get(material.id);
    if (retry?.fingerprint === materialFingerprint(material) && retry.until > nowMs) throw retry.failure;
    if (previous?.status === "failed" && nowMs - Date.parse(previous.updatedAt) < 60_000) {
      throw this.mediaCheckFailure(previous);
    }
    const current = repository.getMaterial(material.id);
    const user = repository.getUser(material.userId);
    if (!current || current.status !== "READY" || !user) throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
    // Provider failure may not yield a trace ID. Bound local retries in that case too.
    for (const [id, entry] of this.submissionRetryAfter) if (entry.until <= nowMs) this.submissionRetryAfter.delete(id);
    if (this.submissionRetryAfter.size >= 10_000) throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查繁忙，请稍后重试");
    this.submissionRetryAfter.set(material.id, { fingerprint: materialFingerprint(current), until: nowMs + 60_000, failure: this.mediaCheckFailure() });
    const mediaUrl = this.options.prepareMediaUrl
      ? await this.options.prepareMediaUrl(current, signal)
      : this.mediaUrl(current);
    // Preparation can finish after the enclosing publication request expired.
    // Keep the private copy tracked for cleanup, but never start a late submission.
    assertActive();
    if (this.closed || signal?.aborted) throw this.mediaCheckFailure();
    const prepared = repository.getMaterial(material.id);
    if (!prepared || prepared.status !== "READY" || prepared.objectKey !== current.objectKey ||
      prepared.contentType !== current.contentType || prepared.userId !== user.id || !repository.getUser(user.id)) {
      this.submissionRetryAfter.delete(material.id);
      return;
    }
    const result = await this.options.provider.submitMedia({
      mediaUrl, mediaType: material.type === "audio" ? "audio" : "image", openId: user.openId, scene: 4,
    });
    // A closed/timed-out background worker must not persist a late receipt.
    assertActive();
    if (this.closed || signal?.aborted) throw this.mediaCheckFailure();
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
        if (this.options.backgroundMediaSafety) {
          this.scheduleMaterial(material);
          materials.push(material);
          continue;
        }
        if (this.options.normalizeMaterial) {
          const current = material;
          material = await deadline.wait(() => this.options.normalizeMaterial!(current));
        }
        materials.push(material);
        const readyMaterial = material;
        await deadline.wait(() => this.submitMaterial(readyMaterial, () => deadline.check()));
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
      if (check?.status === "pass") continue;
      const task = this.backgroundTasks.get(id);
      if (task?.fingerprint === materialFingerprint(material)) throw this.pending();
      if (this.options.backgroundMediaSafety) {
        const retry = this.submissionRetryAfter.get(id);
        if (retry?.fingerprint === materialFingerprint(material) && retry.until > this.now().getTime()) throw retry.failure;
      }
      if (check?.status === "pending") throw this.pending();
      throw this.mediaCheckFailure(check);
    }
  }
}
