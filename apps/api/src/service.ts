import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AIProviderError, type AIProvider } from "./ai.js";
import {
  MATERIAL_TYPES,
  canTransition,
  type GenerationJob,
  type Letter,
  type LetterDraft,
  type LetterSettings,
  type Material,
  type MaterialType,
  type Reply,
  type ShareAccess,
  type User,
} from "./domain.js";
import { ApiError, assertFound } from "./errors.js";
import { MemoryRepository } from "./repository.js";
import {
  DeterministicReplySafetyPolicy,
  normalizeReplyAuthor,
  type ReplySafetyPolicy,
} from "./reply-safety.js";

const defaultSettings: LetterSettings = { tone: "warm", length: "medium" };
const maxRepliesPerLetter = 100;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

function replyRequestFingerprint(text: string, authorName?: string): string {
  return JSON.stringify({
    text: text.normalize("NFKC").trim(),
    authorName: authorName?.normalize("NFKC").trim() || "家人",
  });
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!value || !base64UrlPattern.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalMediaCredential(mediaToken: string | undefined): string | undefined {
  if (!mediaToken) return undefined;
  const [payload, encodedSignature, extra] = mediaToken.split(".");
  if (!payload || !encodedSignature || extra !== undefined) return undefined;
  if (!decodeCanonicalBase64Url(payload) || !decodeCanonicalBase64Url(encodedSignature)) {
    return undefined;
  }
  return mediaToken;
}

export interface RegisterMaterialInput {
  type: MaterialType;
  name: string;
  contentType?: string;
  objectKey?: string;
  textContent?: string;
  uploading?: boolean;
}

export interface RegisterMaterialResult {
  material: Material;
  replayed: boolean;
}

export interface CreateLetterInput {
  recipient: string;
  materialIds?: string[];
  settings?: Partial<LetterSettings>;
}

export interface EditLetterInput {
  recipient?: string;
  materialIds?: string[];
  settings?: Partial<LetterSettings>;
  draft?: Partial<Pick<LetterDraft, "title" | "greeting" | "closing">> & {
    paragraphs?: Array<{ text: string; sourceRefs?: string[] }>;
  };
}

export interface WarmLetterServiceOptions {
  shareTokenTtlMs?: number;
  mediaTokenTtlMs?: number;
  mediaSigningKeys?: readonly Uint8Array[];
  replySafetyPolicy?: ReplySafetyPolicy;
  replySafetyTimeoutMs?: number;
  now?: () => Date;
}

export interface PublishedLetterResult {
  letter: Letter;
  shareToken: string;
  shareExpiresAt: string;
}

export class WarmLetterService {
  private readonly shareTokenTtlMs: number;
  private readonly mediaTokenTtlMs: number;
  private readonly replySafetyPolicy: ReplySafetyPolicy;
  private readonly replySafetyTimeoutMs: number;
  private readonly mediaSigningKeys: readonly Buffer[];
  private readonly now: () => Date;

  constructor(
    readonly repository: MemoryRepository,
    private readonly aiProvider: AIProvider,
    options: WarmLetterServiceOptions = {},
  ) {
    this.shareTokenTtlMs = options.shareTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.mediaTokenTtlMs = options.mediaTokenTtlMs ?? 5 * 60 * 1000;
    this.replySafetyPolicy = options.replySafetyPolicy ?? new DeterministicReplySafetyPolicy();
    this.replySafetyTimeoutMs = options.replySafetyTimeoutMs ?? 3_000;
    this.mediaSigningKeys = (options.mediaSigningKeys?.length
      ? options.mediaSigningKeys
      : [randomBytes(32)]
    ).map((key) => Buffer.from(key));
    this.now = options.now ?? (() => new Date());
    this.assertPositiveTtl(this.shareTokenTtlMs, "shareTokenTtlMs");
    this.assertPositiveTtl(this.mediaTokenTtlMs, "mediaTokenTtlMs");
    this.assertPositiveTtl(this.replySafetyTimeoutMs, "replySafetyTimeoutMs");
    if (this.mediaSigningKeys.some((key) => key.length < 32)) {
      throw new Error("mediaSigningKeys must contain at least 32 bytes per key");
    }
  }

  login(code: string, displayName = "暖笺用户"): { user: User; token: string } {
    const normalizedCode = code.trim() || "local-demo";
    const openId = `dev-${createHash("sha256").update(normalizedCode).digest("hex").slice(0, 16)}`;
    let user = this.repository.findUserByOpenId(openId);
    if (!user) {
      user = this.repository.saveUser({
        id: randomUUID(),
        openId,
        displayName,
        createdAt: new Date().toISOString(),
      });
    }
    return { user, token: `dev.${user.id}` };
  }

  authenticate(token: string | undefined): User {
    if (!token?.startsWith("dev.")) {
      throw new ApiError(401, "UNAUTHORIZED", "请先完成微信登录");
    }
    const user = this.repository.getUser(token.slice(4));
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "登录状态无效");
    }
    return user;
  }

  registerMaterial(
    userId: string,
    input: RegisterMaterialInput,
    idempotencyKey?: string,
  ): RegisterMaterialResult {
    if (!MATERIAL_TYPES.includes(input.type)) {
      throw new ApiError(400, "INVALID_MATERIAL_TYPE", "不支持的素材类型");
    }
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ApiError(400, "INVALID_MATERIAL", "素材名称不能为空");
    }
    if (!input.uploading && input.type === "text" && !input.textContent?.trim()) {
      throw new ApiError(400, "INVALID_MATERIAL", "文字素材内容不能为空");
    }
    if (!input.uploading && input.type !== "text" && !input.objectKey?.trim()) {
      throw new ApiError(400, "INVALID_MATERIAL", "媒体素材必须包含 objectKey");
    }

    const normalizedName = input.name.trim();
    const normalizedTextContent = input.textContent?.trim();
    const requestFingerprint = JSON.stringify({
      type: input.type,
      name: normalizedName,
      contentType: input.contentType,
      textContent: normalizedTextContent,
      uploading: input.uploading === true,
    });
    const result = this.repository.saveMaterialIdempotently(
      {
        id: randomUUID(),
        userId,
        type: input.type,
        name: normalizedName,
        contentType: input.contentType,
        objectKey: input.objectKey,
        textContent: normalizedTextContent,
        status: input.uploading ? "UPLOADING" : "READY",
        createdAt: new Date().toISOString(),
      },
      idempotencyKey,
      requestFingerprint,
    );
    if (result.replayed && result.requestFingerprint !== requestFingerprint) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该素材请求标识已用于其他内容");
    }
    return { material: result.material, replayed: result.replayed };
  }

  completeMaterial(userId: string, materialId: string, input: { textContent?: string }): Material {
    const material = this.requireOwnedMaterial(userId, materialId);
    if (material.status === "READY") {
      return material;
    }
    if (material.status !== "UPLOADING") {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材不处于上传状态");
    }
    if (material.type === "text" && !input.textContent?.trim()) {
      throw new ApiError(400, "INVALID_MATERIAL", "文字素材内容不能为空");
    }
    material.textContent = input.textContent?.trim() ?? material.textContent;
    material.status = "READY";
    return this.repository.saveMaterial(material);
  }

  listMaterials(userId: string): Material[] {
    return this.repository.listMaterials(userId);
  }

  deleteMaterial(userId: string, materialId: string): void {
    const material = this.requireOwnedMaterial(userId, materialId);
    if (material.status === "DELETED") {
      return;
    }
    material.status = "DELETED";
    material.deletedAt = new Date().toISOString();
    this.repository.saveMaterial(material);
  }

  createLetter(userId: string, input: CreateLetterInput): Letter {
    if (typeof input.recipient !== "string" || !input.recipient.trim()) {
      throw new ApiError(400, "INVALID_RECIPIENT", "收信人不能为空");
    }
    if (input.materialIds !== undefined && !this.isStringArray(input.materialIds)) {
      throw new ApiError(400, "INVALID_MATERIAL_IDS", "materialIds 必须是字符串数组");
    }
    const materialIds = this.validateReadyMaterials(userId, input.materialIds ?? []);
    const now = new Date().toISOString();
    const letter: Letter = {
      id: randomUUID(),
      userId,
      recipient: input.recipient.trim(),
      materialIds,
      settings: this.mergeSettings(defaultSettings, input.settings),
      state: materialIds.length > 0 ? "MATERIALS_READY" : "DRAFT",
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.saveLetter(letter);
  }

  getLetter(userId: string, letterId: string): Letter {
    return this.requireOwnedLetter(userId, letterId);
  }

  editLetter(userId: string, letterId: string, input: EditLetterInput): Letter {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (["GENERATING", "CONFIRMED", "PUBLISHED"].includes(letter.state)) {
      throw new ApiError(409, "INVALID_LETTER_STATE", `当前状态 ${letter.state} 不允许编辑`);
    }

    if (input.recipient !== undefined) {
      if (!input.recipient.trim()) {
        throw new ApiError(400, "INVALID_RECIPIENT", "收信人不能为空");
      }
      letter.recipient = input.recipient.trim();
    }
    if (input.materialIds !== undefined) {
      if (!this.isStringArray(input.materialIds)) {
        throw new ApiError(400, "INVALID_MATERIAL_IDS", "materialIds 必须是字符串数组");
      }
      letter.materialIds = this.validateReadyMaterials(userId, input.materialIds);
    }
    if (input.settings !== undefined) {
      letter.settings = this.mergeSettings(letter.settings, input.settings);
    }
    if (input.draft !== undefined) {
      if (letter.state !== "EDITING" || !letter.draft) {
        throw new ApiError(409, "INVALID_LETTER_STATE", "只有生成后的草稿可以编辑正文");
      }
      letter.draft = this.mergeDraft(letter, input.draft);
    }

    if (letter.state !== "EDITING") {
      this.transition(letter, letter.materialIds.length > 0 ? "MATERIALS_READY" : "DRAFT");
    }
    letter.updatedAt = new Date().toISOString();
    return this.repository.saveLetter(letter);
  }

  enqueueGeneration(userId: string, letterId: string, idempotencyKey?: string): GenerationJob {
    if (idempotencyKey) {
      const existingJob = this.repository.findGenerationJobByIdempotencyKey(
        userId,
        letterId,
        idempotencyKey,
      );
      if (existingJob) return existingJob;
    }
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "MATERIALS_READY" && letter.state !== "EDITING") {
      throw new ApiError(409, "INVALID_LETTER_STATE", "请先准备素材，再生成家书");
    }
    this.validateReadyMaterials(userId, letter.materialIds);
    const previousState = letter.state;
    this.transition(letter, "GENERATING");
    letter.updatedAt = new Date().toISOString();
    this.repository.saveLetter(letter);

    const now = new Date().toISOString();
    const job = this.repository.saveJob({
      id: randomUUID(),
      userId,
      letterId,
      idempotencyKey,
      status: "queued",
      type: "generate_letter",
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    setTimeout(() => void this.runGeneration(job.id, previousState), 0);
    return job;
  }

  getJob(userId: string, jobId: string): GenerationJob {
    const job = assertFound(this.repository.getJob(jobId), "JOB_NOT_FOUND", "生成任务不存在");
    if (job.userId !== userId) {
      throw new ApiError(404, "JOB_NOT_FOUND", "生成任务不存在");
    }
    return job;
  }

  confirmAndPublish(userId: string, letterId: string): PublishedLetterResult {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "EDITING" || !letter.draft) {
      throw new ApiError(409, "LETTER_NOT_READY", "请先生成并确认家书草稿");
    }
    this.validateReadyMaterials(userId, letter.materialIds);
    for (const paragraph of letter.draft.paragraphs) {
      if (paragraph.sourceRefs.some((materialId) => !letter.materialIds.includes(materialId))) {
        throw new ApiError(409, "INVALID_SOURCE_REF", "家书仍引用已移除的素材，请先修改草稿");
      }
    }
    const now = new Date().toISOString();
    letter.confirmedDraft = structuredClone(letter.draft);
    letter.confirmedAt = now;
    this.transition(letter, "CONFIRMED");
    letter.publishedAt = now;
    this.transition(letter, "PUBLISHED");
    letter.updatedAt = now;
    const savedLetter = this.repository.saveLetter(letter);
    const share = this.issueShareAccess(letter.id);
    return {
      letter: savedLetter,
      shareToken: share.token,
      shareExpiresAt: share.access.expiresAt,
    };
  }

  reissueShare(userId: string, letterId: string): PublishedLetterResult {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "PUBLISHED" || !letter.confirmedDraft || !letter.publishedAt) {
      throw new ApiError(409, "LETTER_NOT_PUBLISHED", "家书尚未确认发布");
    }
    const previousAccess = this.repository
      .listShareAccess(letter.id)
      .filter((access) => !access.revokedAt);
    const share = this.issueShareAccess(letter.id);
    this.revokeShareAccessEntries(previousAccess);
    return {
      letter,
      shareToken: share.token,
      shareExpiresAt: share.access.expiresAt,
    };
  }

  revokeShare(userId: string, letterId: string): void {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "PUBLISHED") {
      throw new ApiError(409, "LETTER_NOT_PUBLISHED", "家书尚未确认发布");
    }
    this.revokeShareAccess(letter.id);
  }

  getReader(letterId: string, shareToken: string | undefined): {
    id: string;
    recipient: string;
    draft: LetterDraft;
    publishedAt: string;
    sources: Array<
      Pick<Material, "id" | "type" | "name" | "contentType"> & {
        mediaToken?: string;
        mediaExpiresAt?: string;
      }
    >;
    replies: Reply[];
  } {
    const { letter, access } = this.resolveShareAccess(letterId, shareToken);
    return {
      id: letter.id,
      recipient: letter.recipient,
      draft: letter.confirmedDraft!,
      publishedAt: letter.publishedAt!,
      sources: letter.materialIds.map((materialId) => {
        const material = assertFound(
          this.repository.getMaterial(materialId),
          "MATERIAL_NOT_FOUND",
          "家书来源素材不存在",
        );
        if (material.status !== "READY") {
          throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书暂时无法阅读");
        }
        if (material.type === "text") {
          return {
            id: material.id,
            type: material.type,
            name: material.name,
          };
        }
        if (!material.objectKey || !material.contentType) {
          throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书的媒体暂时不可用");
        }
        const mediaAccess = this.issueMediaAccess(letter.id, material.id, access);
        return {
          id: material.id,
          type: material.type,
          name: material.name,
          contentType: material.contentType,
          mediaToken: mediaAccess.token,
          mediaExpiresAt: mediaAccess.expiresAt,
        };
      }),
      replies: this.repository.listReplies(letter.id),
    };
  }

  getPublicMaterial(
    letterId: string,
    materialId: string,
    mediaToken: string | undefined,
  ): Material {
    const { letter } = this.resolveMediaAccess(letterId, materialId, mediaToken);
    if (!letter.materialIds.includes(materialId)) {
      throw new ApiError(404, "PUBLIC_ACCESS_NOT_FOUND", "公开访问凭据无效");
    }
    const material = this.repository.getMaterial(materialId);
    if (!material || material.status !== "READY" || material.type === "text" || !material.objectKey) {
      throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书的媒体暂时不可用");
    }
    return material;
  }

  async createReply(
    letterId: string,
    shareToken: string | undefined,
    text: string,
    authorName?: string,
    idempotencyKey?: string,
  ): Promise<Reply> {
    const { letter } = this.resolveShareAccess(letterId, shareToken);
    const requestFingerprint = replyRequestFingerprint(text, authorName);
    if (idempotencyKey) {
      const replay = this.repository.findReplyByIdempotencyKey(letter.id, idempotencyKey);
      if (replay) {
        if (replay.requestFingerprint !== requestFingerprint) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该回复请求标识已用于其他内容");
        }
        return replay.reply;
      }
    }
    let safeText: string;
    let safeAuthorName: string;
    try {
      safeText = await this.validateReplySafety(text);
      safeAuthorName = normalizeReplyAuthor(
        await this.validateReplySafety(normalizeReplyAuthor(authorName)),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "回复安全检查暂时不可用，请稍后重试");
    }
    this.resolveShareAccess(letter.id, shareToken);
    const reply = {
      id: randomUUID(),
      letterId,
      text: safeText,
      authorName: safeAuthorName,
      authorVerified: false,
      createdAt: this.now().toISOString(),
    } satisfies Reply;
    const result = this.repository.saveReplyIdempotentlyIfBelowLimit(
      reply,
      maxRepliesPerLetter,
      requestFingerprint,
      idempotencyKey,
    );
    if (!result) {
      throw new ApiError(409, "REPLY_LIMIT_REACHED", "这封家书的回复数量已达到上限");
    }
    if (
      result.replayed &&
      result.requestFingerprint !== requestFingerprint
    ) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该回复请求标识已用于其他内容");
    }
    return result.reply;
  }

  findReplyReplay(
    letterId: string,
    shareToken: string | undefined,
    text: string,
    authorName: string | undefined,
    idempotencyKey: string,
  ): Reply | undefined {
    const { letter } = this.resolveShareAccess(letterId, shareToken);
    const replay = this.repository.findReplyByIdempotencyKey(letter.id, idempotencyKey);
    if (!replay) return undefined;
    if (replay.requestFingerprint !== replyRequestFingerprint(text, authorName)) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该回复请求标识已用于其他内容");
    }
    return replay.reply;
  }

  listReplies(userId: string, letterId: string): Reply[] {
    this.requireOwnedLetter(userId, letterId);
    return this.repository.listReplies(letterId);
  }

  private async runGeneration(jobId: string, previousState: "MATERIALS_READY" | "EDITING"): Promise<void> {
    const job = this.repository.getJob(jobId);
    if (!job) return;
    const letter = this.repository.getLetter(job.letterId);
    if (!letter) return;

    job.status = "running";
    job.attempts = 1;
    job.updatedAt = new Date().toISOString();
    this.repository.saveJob(job);

    try {
      const materials = letter.materialIds.map((id) => this.requireReadyMaterial(letter.userId, id));
      letter.draft = await this.aiProvider.generateLetter({
        recipient: letter.recipient,
        settings: letter.settings,
        materials,
        version: (letter.draft?.version ?? 0) + 1,
      });
      this.transition(letter, "EDITING");
      letter.updatedAt = new Date().toISOString();
      this.repository.saveLetter(letter);
      job.status = "succeeded";
    } catch (error) {
      const apiError = error instanceof ApiError ? error : undefined;
      const providerError = error instanceof AIProviderError ? error : undefined;
      this.transition(letter, previousState);
      letter.updatedAt = new Date().toISOString();
      this.repository.saveLetter(letter);
      job.status = "failed";
      job.error = {
        code: providerError?.code ?? apiError?.code ?? "GENERATION_FAILED",
        message: providerError?.message ?? apiError?.message ?? "家书生成失败",
        retryable: providerError?.retryable ?? false,
      };
    }
    const finishedAt = new Date().toISOString();
    job.updatedAt = finishedAt;
    job.finishedAt = finishedAt;
    this.repository.saveJob(job);
  }

  private mergeDraft(letter: Letter, input: NonNullable<EditLetterInput["draft"]>): LetterDraft {
    const current = letter.draft!;
    if (input.paragraphs !== undefined && !Array.isArray(input.paragraphs)) {
      throw new ApiError(400, "INVALID_DRAFT", "paragraphs 必须是数组");
    }
    const paragraphs = input.paragraphs?.map((paragraph, index) => {
      if (!paragraph || typeof paragraph.text !== "string" || !paragraph.text.trim()) {
        throw new ApiError(400, "INVALID_DRAFT", "家书段落不能为空");
      }
      const previous = current.paragraphs[index];
      const sourceRefs = paragraph.sourceRefs ?? previous?.sourceRefs ?? [];
      if (!this.isStringArray(sourceRefs)) {
        throw new ApiError(400, "INVALID_SOURCE_REF", "sourceRefs 必须是字符串数组");
      }
      for (const materialId of sourceRefs) {
        if (!letter.materialIds.includes(materialId)) {
          throw new ApiError(400, "INVALID_SOURCE_REF", "段落引用了不属于该家书的素材");
        }
      }
      return { id: previous?.id ?? randomUUID(), text: paragraph.text.trim(), sourceRefs };
    });
    return {
      ...current,
      title: input.title?.trim() || current.title,
      greeting: input.greeting?.trim() || current.greeting,
      closing: input.closing?.trim() || current.closing,
      paragraphs: paragraphs ?? current.paragraphs,
    };
  }

  private mergeSettings(current: LetterSettings, input?: Partial<LetterSettings>): LetterSettings {
    const tone = input?.tone ?? current.tone;
    const length = input?.length ?? current.length;
    if (!["warm", "plain", "lively"].includes(tone)) {
      throw new ApiError(400, "INVALID_SETTINGS", "不支持的家书语气");
    }
    if (!["short", "medium", "long"].includes(length)) {
      throw new ApiError(400, "INVALID_SETTINGS", "不支持的家书篇幅");
    }
    if (input?.excludedTopics !== undefined && !this.isStringArray(input.excludedTopics)) {
      throw new ApiError(400, "INVALID_SETTINGS", "excludedTopics 必须是字符串数组");
    }
    return {
      tone,
      length,
      focus: input?.focus?.trim() ?? current.focus,
      excludedTopics: input?.excludedTopics ?? current.excludedTopics,
    };
  }

  private validateReadyMaterials(userId: string, ids: string[]): string[] {
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) this.requireReadyMaterial(userId, id);
    return uniqueIds;
  }

  private requireReadyMaterial(userId: string, id: string): Material {
    const material = this.requireOwnedMaterial(userId, id);
    if (material.status !== "READY") {
      throw new ApiError(409, "MATERIAL_NOT_READY", "素材未上传完成或已被删除");
    }
    return material;
  }

  private requireOwnedMaterial(userId: string, id: string): Material {
    const material = assertFound(this.repository.getMaterial(id), "MATERIAL_NOT_FOUND", "素材不存在");
    if (material.userId !== userId) {
      throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
    }
    return material;
  }

  private requireOwnedLetter(userId: string, id: string): Letter {
    const letter = assertFound(this.repository.getLetter(id), "LETTER_NOT_FOUND", "家书不存在");
    if (letter.userId !== userId) {
      throw new ApiError(404, "LETTER_NOT_FOUND", "家书不存在");
    }
    return letter;
  }

  private resolveShareAccess(
    letterId: string,
    shareToken: string | undefined,
  ): { letter: Letter; access: ShareAccess } {
    if (!shareToken) {
      throw new ApiError(404, "PUBLIC_ACCESS_NOT_FOUND", "公开访问凭据无效");
    }
    const access = this.repository.findShareAccessByTokenHash(this.hashShareToken(shareToken));
    if (!access || access.letterId !== letterId) {
      throw new ApiError(404, "PUBLIC_ACCESS_NOT_FOUND", "公开访问凭据无效");
    }
    if (access.revokedAt) {
      throw new ApiError(410, "SHARE_TOKEN_REVOKED", "读信链接已撤销");
    }
    if (Date.parse(access.expiresAt) <= this.now().getTime()) {
      throw new ApiError(410, "SHARE_TOKEN_EXPIRED", "读信链接已过期");
    }
    const letter = this.repository.getLetter(letterId);
    if (!letter || letter.state !== "PUBLISHED" || !letter.confirmedDraft || !letter.publishedAt) {
      throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书暂时无法阅读");
    }
    return { letter, access };
  }

  private issueShareAccess(letterId: string): { access: ShareAccess; token: string } {
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const access = this.repository.saveShareAccess({
      id: randomUUID(),
      letterId,
      tokenHash: this.hashShareToken(token),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.shareTokenTtlMs).toISOString(),
    });
    return { access, token };
  }

  private issueMediaAccess(
    letterId: string,
    materialId: string,
    shareAccess: ShareAccess,
  ): { expiresAt: string; token: string } {
    const createdAt = this.now();
    const expiresAt = new Date(
      Math.min(createdAt.getTime() + this.mediaTokenTtlMs, Date.parse(shareAccess.expiresAt)),
    );
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        aud: "public-media",
        sid: shareAccess.id,
        lid: letterId,
        mid: materialId,
        exp: Math.floor(expiresAt.getTime() / 1000),
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.mediaSigningKeys[0]!).update(payload).digest("base64url");
    return { expiresAt: expiresAt.toISOString(), token: `${payload}.${signature}` };
  }

  private resolveMediaAccess(
    letterId: string,
    materialId: string,
    mediaToken: string | undefined,
  ): { letter: Letter } {
    if (!mediaToken) {
      throw new ApiError(404, "PUBLIC_ACCESS_NOT_FOUND", "公开访问凭据无效");
    }
    const claims = this.verifyMediaToken(mediaToken);
    if (!claims || claims.lid !== letterId || claims.mid !== materialId) {
      throw new ApiError(404, "PUBLIC_ACCESS_NOT_FOUND", "公开访问凭据无效");
    }
    const shareAccess = this.repository.getShareAccess(claims.sid);
    if (!shareAccess || shareAccess.letterId !== letterId) {
      throw new ApiError(404, "PUBLIC_ACCESS_NOT_FOUND", "公开访问凭据无效");
    }
    if (shareAccess.revokedAt) {
      throw new ApiError(410, "SHARE_TOKEN_REVOKED", "读信链接已撤销");
    }
    if (Date.parse(shareAccess.expiresAt) <= this.now().getTime()) {
      throw new ApiError(410, "SHARE_TOKEN_EXPIRED", "读信链接已过期");
    }
    if (claims.exp * 1000 <= this.now().getTime()) {
      throw new ApiError(410, "MEDIA_TOKEN_EXPIRED", "媒体访问凭据已过期");
    }
    const letter = this.repository.getLetter(letterId);
    if (!letter || letter.state !== "PUBLISHED" || !letter.confirmedDraft || !letter.publishedAt) {
      throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书暂时无法阅读");
    }
    return { letter };
  }

  private verifyMediaToken(mediaToken: string): {
    sid: string;
    lid: string;
    mid: string;
    exp: number;
  } | undefined {
    if (canonicalMediaCredential(mediaToken) !== mediaToken) return undefined;
    const [payload, encodedSignature] = mediaToken.split(".") as [string, string];
    const signature = decodeCanonicalBase64Url(encodedSignature)!;
    if (signature.length !== 32) return undefined;
    const validSignature = this.mediaSigningKeys.some((key) => {
      const expected = createHmac("sha256", key).update(payload).digest();
      return timingSafeEqual(expected, signature);
    });
    if (!validSignature) return undefined;
    try {
      const parsed = JSON.parse(decodeCanonicalBase64Url(payload)!.toString("utf8")) as Record<
        string,
        unknown
      >;
      if (
        parsed.v !== 1 ||
        parsed.aud !== "public-media" ||
        typeof parsed.sid !== "string" ||
        typeof parsed.lid !== "string" ||
        typeof parsed.mid !== "string" ||
        typeof parsed.exp !== "number" ||
        !Number.isSafeInteger(parsed.exp)
      ) {
        return undefined;
      }
      return { sid: parsed.sid, lid: parsed.lid, mid: parsed.mid, exp: parsed.exp };
    } catch {
      return undefined;
    }
  }

  private async validateReplySafety(text: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("reply safety policy timed out")),
        this.replySafetyTimeoutMs,
      );
      Promise.resolve(this.replySafetyPolicy.validate(text)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private revokeShareAccess(letterId: string): void {
    this.revokeShareAccessEntries(this.repository.listShareAccess(letterId));
  }

  private revokeShareAccessEntries(accesses: ShareAccess[]): void {
    const revokedAt = this.now().toISOString();
    for (const access of accesses) {
      if (!access.revokedAt) {
        access.revokedAt = revokedAt;
        this.repository.saveShareAccess(access);
      }
    }
  }

  private hashShareToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private assertPositiveTtl(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${field} must be a positive safe integer`);
    }
  }

  private transition(letter: Letter, target: Letter["state"]): void {
    if (letter.state === target) return;
    if (!canTransition(letter.state, target)) {
      throw new ApiError(409, "INVALID_LETTER_STATE", `不能从 ${letter.state} 进入 ${target}`);
    }
    letter.state = target;
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}
