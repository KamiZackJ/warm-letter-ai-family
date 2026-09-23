import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AIProviderError, type AIProvider } from "./ai.js";
import {
  MATERIAL_TYPES,
  PARAGRAPH_SOURCE_ATTRIBUTIONS,
  canTransition,
  type GenerationJob,
  type Letter,
  type LetterDraft,
  type LetterNarration,
  type LetterSettings,
  type Material,
  type MaterialType,
  type ParagraphSourceAttribution,
  type Reply,
  type ShareAccess,
  type User,
} from "./domain.js";
import { ApiError, assertFound } from "./errors.js";
import type { Repository } from "./repository.js";
import { requireTextSafety, type ContentSafetyProvider } from "./content-safety.js";
import { OperationDeadline } from "./deadline.js";
import {
  DeterministicReplySafetyPolicy,
  normalizeReplyAuthor,
  type ReplySafetyPolicy,
} from "./reply-safety.js";

const defaultSettings: LetterSettings = { tone: "warm", length: "medium" };
const maxRepliesPerLetter = 100;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
export const NARRATION_MEDIA_ID = "ai-narration";

export function letterDraftSpeechText(draft: LetterDraft): string {
  return [
    draft.greeting,
    ...draft.paragraphs.map((paragraph) => paragraph.text),
    draft.closing,
    draft.signature,
  ]
    .map((part) => part.normalize("NFC").trim())
    .filter(Boolean)
    .join("\n\n");
}

function speechTextFingerprint(text: string): string {
  return createHash("sha256").update(text.normalize("NFC").trim()).digest("hex");
}

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
  durationSeconds?: number;
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
  draft?: Partial<Pick<LetterDraft, "title" | "greeting" | "closing" | "signature">> & {
    paragraphs?: Array<{
      text: string;
      sourceRefs?: string[];
      sourceAttribution?: ParagraphSourceAttribution;
    }>;
  };
}

export interface WarmLetterServiceOptions {
  shareTokenTtlMs?: number;
  mediaTokenTtlMs?: number;
  mediaSigningKeys?: readonly Uint8Array[];
  authSessionTtlMs?: number;
  replySafetyPolicy?: ReplySafetyPolicy;
  replySafetyTimeoutMs?: number;
  contentSafetyProvider?: ContentSafetyProvider;
  allowDevelopmentAuth?: boolean;
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
  private readonly authSessionTtlMs: number;
  private readonly contentSafetyProvider?: ContentSafetyProvider;
  private readonly allowDevelopmentAuth: boolean;
  private readonly maxAuthSessions = 10_000;
  private readonly now: () => Date;

  constructor(
    readonly repository: Repository,
    private readonly aiProvider: AIProvider,
    options: WarmLetterServiceOptions = {},
  ) {
    this.shareTokenTtlMs = options.shareTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.mediaTokenTtlMs = options.mediaTokenTtlMs ?? 5 * 60 * 1000;
    this.authSessionTtlMs = options.authSessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.replySafetyPolicy = options.replySafetyPolicy ?? new DeterministicReplySafetyPolicy();
    this.replySafetyTimeoutMs = options.replySafetyTimeoutMs ?? 3_000;
    this.contentSafetyProvider = options.contentSafetyProvider;
    this.allowDevelopmentAuth = options.allowDevelopmentAuth ?? true;
    this.mediaSigningKeys = (options.mediaSigningKeys?.length
      ? options.mediaSigningKeys
      : [randomBytes(32)]
    ).map((key) => Buffer.from(key));
    this.now = options.now ?? (() => new Date());
    this.assertPositiveTtl(this.shareTokenTtlMs, "shareTokenTtlMs");
    this.assertPositiveTtl(this.mediaTokenTtlMs, "mediaTokenTtlMs");
    this.assertPositiveTtl(this.authSessionTtlMs, "authSessionTtlMs");
    this.assertPositiveTtl(this.replySafetyTimeoutMs, "replySafetyTimeoutMs");
    if (this.mediaSigningKeys.some((key) => key.length < 32)) {
      throw new Error("mediaSigningKeys must contain at least 32 bytes per key");
    }
  }

  login(code: string, displayName = "暖笺用户"): { user: User; token: string } {
    if (!this.allowDevelopmentAuth) throw new ApiError(401, "UNAUTHORIZED", "请使用微信登录");
    const normalizedCode = code.trim() || "local-demo";
    const openId = `dev-${createHash("sha256").update(normalizedCode).digest("hex").slice(0, 16)}`;
    const user = this.findOrCreateUser(openId, displayName);
    return { user, token: `dev.${user.id}` };
  }

  loginWithWechatOpenId(openId: string, displayName = "暖笺用户"): { user: User; token: string } {
    const normalizedOpenId = openId.trim();
    if (!normalizedOpenId || normalizedOpenId.length > 128) throw new Error("openId is invalid");
    const user = this.findOrCreateUser(normalizedOpenId, displayName);
    this.removeExpiredAuthSessions();
    const token = `wx.${randomBytes(32).toString("base64url")}`;
    this.repository.saveAuthSession({
      tokenHash: this.authSessionKey(token),
      userId: user.id,
      createdAt: this.now().getTime(),
      expiresAt: this.now().getTime() + this.authSessionTtlMs,
    });
    this.repository.pruneAuthSessions(this.now().getTime(), this.maxAuthSessions);
    return { user, token };
  }

  authenticate(token: string | undefined): User {
    if (!token) throw new ApiError(401, "UNAUTHORIZED", "请先完成微信登录");
    if (token.startsWith("dev.")) {
      if (!this.allowDevelopmentAuth) throw new ApiError(401, "UNAUTHORIZED", "请使用微信登录");
      const user = this.repository.getUser(token.slice(4));
      if (!user) throw new ApiError(401, "UNAUTHORIZED", "登录状态无效");
      return user;
    }
    if (!token.startsWith("wx.")) {
      throw new ApiError(401, "UNAUTHORIZED", "请先完成微信登录");
    }
    const sessionKey = this.authSessionKey(token);
    const session = this.repository.getAuthSession(sessionKey);
    if (!session || session.expiresAt <= this.now().getTime()) {
      this.repository.deleteAuthSession(sessionKey);
      throw new ApiError(401, "UNAUTHORIZED", "登录状态已过期，请重新登录");
    }
    const user = this.repository.getUser(session.userId);
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "登录状态无效");
    }
    return user;
  }

  private findOrCreateUser(openId: string, displayName: string): User {
    let user = this.repository.findUserByOpenId(openId);
    if (!user) {
      user = this.repository.saveUser({
        id: randomUUID(),
        openId,
        displayName,
        createdAt: this.now().toISOString(),
      });
    } else if (displayName.trim() && user.displayName !== displayName.trim()) {
      user.displayName = displayName.trim();
      this.repository.saveUser(user);
    }
    return user;
  }

  private removeExpiredAuthSessions(): void {
    this.repository.pruneAuthSessions(this.now().getTime());
  }

  private authSessionKey(token: string): string {
    return createHash("sha256").update(token).digest("hex");
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
    if (
      input.durationSeconds !== undefined &&
      (input.type !== "audio" ||
        !Number.isSafeInteger(input.durationSeconds) ||
        input.durationSeconds < 1 ||
        input.durationSeconds > 24 * 60 * 60)
    ) {
      throw new ApiError(400, "INVALID_MATERIAL", "语音时长必须是 1 到 86400 之间的整数秒");
    }

    const normalizedName = input.name.trim();
    const normalizedTextContent = input.textContent?.trim();
    const requestFingerprint = JSON.stringify({
      type: input.type,
      name: normalizedName,
      contentType: input.contentType,
      textContent: normalizedTextContent,
      durationSeconds: input.durationSeconds,
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
        durationSeconds: input.durationSeconds,
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
    this.repository.transaction(() => {
      this.repository.saveMaterial(material);
      if (material.objectKey) this.repository.scheduleObjectDeletion(material.objectKey);
    });
  }

  listLetters(userId: string): Letter[] {
    return this.repository.listLetters(userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  deleteLetter(userId: string, letterId: string): void {
    const letter = this.requireOwnedLetter(userId, letterId);
    this.repository.transaction(() => {
      if (letter.narration) this.repository.scheduleObjectDeletion(letter.narration.objectKey);
      this.repository.deleteLetter(letter.id);
    });
  }

  deleteAccount(userId: string): void {
    this.repository.transaction(() => {
      for (const material of this.repository.listMaterials(userId)) {
        if (material.objectKey) this.repository.scheduleObjectDeletion(material.objectKey);
      }
      for (const letter of this.repository.listLetters(userId)) {
        if (letter.narration) this.repository.scheduleObjectDeletion(letter.narration.objectKey);
      }
      this.repository.deleteUser(userId);
    });
  }

  async checkText(userId: string, content: string, scene: 1 | 2 | 3 | 4 = 4): Promise<void> {
    if (!this.contentSafetyProvider || !content.trim()) return;
    const user = assertFound(this.repository.getUser(userId), "UNAUTHORIZED", "请重新登录");
    const characters = Array.from(content.normalize("NFKC"));
    if (characters.length > 10_000) throw new ApiError(400, "CONTENT_TOO_LONG", "一次最多检查 10000 个字符，请精简内容");
    // Check every character; overlap keeps boundary-spanning phrases in context.
    const deadline = new OperationDeadline(15_000, () => new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "内容安全检查超时，请稍后重试"));
    try {
      for (let offset = 0; offset < characters.length; offset += 2300) {
        await deadline.wait(() => requireTextSafety(this.contentSafetyProvider!, {
          content: characters.slice(offset, offset + 2500).join(""), openId: user.openId, scene,
        }));
      }
    } finally { deadline.dispose(); }
    if (!this.repository.getUser(userId)) throw new ApiError(401, "UNAUTHORIZED", "账号已删除，请重新登录");
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

  getNarrationText(userId: string, letterId: string): string {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "EDITING" || !letter.draft) {
      throw new ApiError(409, "LETTER_NOT_READY", "请先生成家书草稿，再生成朗读");
    }
    this.assertTranscriptRevisionApplied(letter);
    return letterDraftSpeechText(letter.draft);
  }

  attachNarration(
    userId: string,
    letterId: string,
    expectedText: string,
    input: Omit<LetterNarration, "draftFingerprint" | "generatedAt">,
  ): { narration: LetterNarration; previousObjectKey?: string } {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "EDITING" || !letter.draft) {
      throw new ApiError(409, "LETTER_NOT_READY", "请先生成家书草稿，再生成朗读");
    }
    this.assertTranscriptRevisionApplied(letter);
    const currentText = letterDraftSpeechText(letter.draft);
    if (currentText !== expectedText.normalize("NFC").trim()) {
      throw new ApiError(409, "DRAFT_CHANGED", "草稿已更新，请重新生成朗读");
    }
    const previousObjectKey = letter.narration?.objectKey;
    const narration: LetterNarration = {
      ...input,
      draftFingerprint: speechTextFingerprint(currentText),
      generatedAt: this.now().toISOString(),
    };
    letter.narration = narration;
    letter.updatedAt = this.now().toISOString();
    this.repository.saveLetter(letter);
    return { narration, previousObjectKey };
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

  updateAudioTranscript(userId: string, letterId: string, materialId: string, text: string): Letter {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "EDITING" || !letter.draft) {
      throw new ApiError(409, "INVALID_LETTER_STATE", "请在编辑草稿时核对语音转写");
    }
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText || normalizedText.length > 50_000) {
      throw new ApiError(400, "INVALID_AUDIO_TRANSCRIPT", "语音转写必须为 1 到 50000 个字符");
    }
    if (!letter.materialIds.includes(materialId)) {
      throw new ApiError(404, "AUDIO_TRANSCRIPT_NOT_FOUND", "当前家书没有这份语音转写");
    }
    const material = this.requireReadyMaterial(userId, materialId);
    const previous = letter.audioTranscripts?.find((item) => item.materialId === materialId);
    if (material.type !== "audio" || !previous) {
      throw new ApiError(404, "AUDIO_TRANSCRIPT_NOT_FOUND", "当前家书没有这份语音转写");
    }
    if (previous.confirmed && previous.text === normalizedText) return letter;
    letter.audioTranscripts = letter.audioTranscripts!.map((item) =>
      item.materialId === materialId
        ? { materialId, text: normalizedText, confirmed: true }
        : item,
    );
    // Keep the old text visible until generation succeeds, but never publish or
    // narrate it as though the newly corrected evidence had already been used.
    letter.audioTranscriptRevisionPending = true;
    letter.draft.paragraphs = letter.draft.paragraphs.map((paragraph) =>
      paragraph.sourceRefs.includes(materialId)
        ? { ...paragraph, sourceAttribution: "needs-review" }
        : paragraph,
    );
    letter.updatedAt = this.now().toISOString();
    return this.repository.saveLetter(letter);
  }

  private assertTranscriptRevisionApplied(letter: Letter): void {
    if (letter.audioTranscriptRevisionPending) {
      throw new ApiError(
        409,
        "AUDIO_TRANSCRIPT_REGENERATION_REQUIRED",
        "语音转写已更新，请先重新生成家书",
      );
    }
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
    const now = new Date().toISOString();
    const job = this.repository.transaction(() => {
      this.repository.saveLetter(letter);
      return this.repository.saveJob({
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
    });
    setTimeout(() => void this.runGeneration(job.id, previousState), 0);
    return job;
  }

  findGenerationReplay(
    userId: string,
    letterId: string,
    idempotencyKey: string,
  ): GenerationJob | undefined {
    return this.repository.findGenerationJobByIdempotencyKey(userId, letterId, idempotencyKey);
  }

  getJob(userId: string, jobId: string): GenerationJob {
    const job = assertFound(this.repository.getJob(jobId), "JOB_NOT_FOUND", "生成任务不存在");
    if (job.userId !== userId) {
      throw new ApiError(404, "JOB_NOT_FOUND", "生成任务不存在");
    }
    return job;
  }

  confirmAndPublish(userId: string, letterId: string): PublishedLetterResult {
    return this.repository.transaction(() => {
    const letter = this.requireOwnedLetter(userId, letterId);
    if (letter.state !== "EDITING" || !letter.draft) {
      throw new ApiError(409, "LETTER_NOT_READY", "请先生成并确认家书草稿");
    }
    this.assertTranscriptRevisionApplied(letter);
    this.validateReadyMaterials(userId, letter.materialIds);
    letter.draft.signature = this.normalizeSignature(letter.draft.signature);
    for (const paragraph of letter.draft.paragraphs) {
      const sourceAttribution = paragraph.sourceAttribution ?? "ai";
      if (sourceAttribution === "needs-review") {
        throw new ApiError(
          409,
          "SOURCE_REVIEW_REQUIRED",
          "请先为待核对的段落确认素材依据，或标记为本人补充",
        );
      }
      if (sourceAttribution === "sources-confirmed" && paragraph.sourceRefs.length === 0) {
        throw new ApiError(
          409,
          "SOURCE_REVIEW_REQUIRED",
          "已核对依据的段落至少需要选择一份素材",
        );
      }
      if (sourceAttribution === "user-supplied" && paragraph.sourceRefs.length > 0) {
        throw new ApiError(
          409,
          "INVALID_SOURCE_ATTRIBUTION",
          "本人补充的段落不能保留素材引用",
        );
      }
      if (sourceAttribution === "ai" && paragraph.sourceRefs.length === 0) {
        throw new ApiError(
          409,
          "SOURCE_REVIEW_REQUIRED",
          "AI 整理的段落必须保留至少一份素材依据",
        );
      }
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
    });
  }

  reissueShare(userId: string, letterId: string): PublishedLetterResult {
    return this.repository.transaction(() => {
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
    });
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
      Pick<Material, "id" | "type" | "name" | "contentType" | "durationSeconds"> & {
        mediaToken?: string;
        mediaExpiresAt?: string;
      }
    >;
    narration?: Pick<
      LetterNarration,
      "contentType" | "voiceId" | "voiceName" | "generatedAt"
    > & {
      id: string;
      name: string;
      mediaToken: string;
      mediaExpiresAt: string;
    };
    replies: Reply[];
  } {
    const { letter, access } = this.resolveShareAccess(letterId, shareToken);
    const narration =
      letter.narration &&
      letter.confirmedDraft &&
      letter.narration.draftFingerprint ===
        speechTextFingerprint(letterDraftSpeechText(letter.confirmedDraft))
        ? letter.narration
        : undefined;
    const narrationAccess = narration
      ? this.issueMediaAccess(letter.id, NARRATION_MEDIA_ID, access)
      : undefined;
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
          durationSeconds: material.durationSeconds,
          mediaToken: mediaAccess.token,
          mediaExpiresAt: mediaAccess.expiresAt,
        };
      }),
      narration:
        narration && narrationAccess
          ? {
              id: NARRATION_MEDIA_ID,
              name: "AI 朗读全文",
              contentType: narration.contentType,
              voiceId: narration.voiceId,
              voiceName: narration.voiceName,
              generatedAt: narration.generatedAt,
              mediaToken: narrationAccess.token,
              mediaExpiresAt: narrationAccess.expiresAt,
            }
          : undefined,
      replies: this.repository.listReplies(letter.id),
    };
  }

  getPublicNarration(
    letterId: string,
    mediaToken: string | undefined,
  ): LetterNarration {
    const { letter } = this.resolveMediaAccess(
      letterId,
      NARRATION_MEDIA_ID,
      mediaToken,
    );
    const narration = letter.narration;
    if (
      !narration ||
      !letter.confirmedDraft ||
      narration.draftFingerprint !==
        speechTextFingerprint(letterDraftSpeechText(letter.confirmedDraft))
    ) {
      throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书的朗读暂时不可用");
    }
    return narration;
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
    authorUserId?: string,
  ): Promise<Reply> {
    const { letter } = this.resolveShareAccess(letterId, shareToken);
    const requestFingerprint = replyRequestFingerprint(text, authorName);
    if (idempotencyKey) {
      const replay = this.repository.findReplyByIdempotencyKey(letter.id, idempotencyKey);
      if (replay) {
        if (replay.reply.authorUserId !== authorUserId) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该回复请求标识已用于其他账号");
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
      if (authorUserId) await this.checkText(authorUserId, `${safeAuthorName}\n${safeText}`, 2);
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
      authorUserId,
      authorVerified: Boolean(authorUserId),
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
    authorUserId?: string,
  ): Reply | undefined {
    const { letter } = this.resolveShareAccess(letterId, shareToken);
    const replay = this.repository.findReplyByIdempotencyKey(letter.id, idempotencyKey);
    if (!replay) return undefined;
    if (replay.reply.authorUserId !== authorUserId) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该回复请求标识已用于其他账号");
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
    if (!job || job.status !== "queued") return;
    const letter = this.repository.getLetter(job.letterId);
    if (!letter || letter.state !== "GENERATING") return;
    const stillActive = () => this.repository.getJob(jobId)?.status === "running" &&
      this.repository.getLetter(job.letterId)?.state === "GENERATING" &&
      Boolean(this.repository.getUser(job.userId));

    job.status = "running";
    job.attempts = 1;
    job.updatedAt = new Date().toISOString();
    this.repository.saveJob(job);
    const deadline = new OperationDeadline(165_000, () => new AIProviderError("AI_TIMEOUT", "生成超时，素材已保存，请稍后重试", true));
    try {
      const materials = letter.materialIds.map((id) => this.requireReadyMaterial(letter.userId, id));
      await deadline.wait(() => this.checkText(letter.userId, [letter.recipient, letter.settings.focus,
        ...(letter.settings.excludedTopics ?? []), ...materials.map((item) => item.textContent)].filter(Boolean).join("\n")));
      if (!stillActive()) return;
      const previousSignature = letter.draft?.signature;
      const generatedDraft = await deadline.wait(() => this.aiProvider.generateLetter({
        recipient: letter.recipient,
        settings: letter.settings,
        materials,
        version: (letter.draft?.version ?? 0) + 1,
        audioTranscripts: letter.audioTranscripts?.filter((transcript) =>
          materials.some((material) => material.id === transcript.materialId && material.type === "audio"),
        ),
        onTranscript: (transcript) => {
          if (!stillActive()) throw new ApiError(409, "GENERATION_CANCELLED", "家书已删除或生成已停止");
          const material = materials.find((item) => item.id === transcript.materialId);
          if (material?.type !== "audio" || !transcript.text.trim() || transcript.text.length > 50_000) {
            throw new AIProviderError("AI_OUTPUT_INVALID", "AI 返回了无效的语音转写", false);
          }
          const otherTranscripts = (letter.audioTranscripts ?? []).filter(
            (item) => item.materialId !== transcript.materialId,
          );
          letter.audioTranscripts = [
            ...otherTranscripts,
            { materialId: material.id, text: transcript.text.trim(), confirmed: false },
          ];
          this.repository.saveLetter(letter);
        },
      }));
      if (!stillActive()) return;
      await deadline.wait(() => this.checkText(letter.userId, [generatedDraft.title, letterDraftSpeechText(generatedDraft)].join("\n")));
      if (!stillActive()) return;
      this.validateReadyMaterials(letter.userId, letter.materialIds);
      const unconfirmedAudioIds = new Set(
        (letter.audioTranscripts ?? []).filter((item) => !item.confirmed).map((item) => item.materialId),
      );
      letter.draft = {
        ...generatedDraft,
        paragraphs: generatedDraft.paragraphs.map((paragraph) =>
          paragraph.sourceRefs.some((materialId) => unconfirmedAudioIds.has(materialId))
            ? { ...paragraph, sourceAttribution: "needs-review" }
            : paragraph,
        ),
        signature: this.normalizeSignature(previousSignature ?? generatedDraft.signature),
      };
      letter.audioTranscriptRevisionPending = false;
      this.transition(letter, "EDITING");
      letter.updatedAt = new Date().toISOString();
      job.status = "succeeded";
    } catch (error) {
      if (!stillActive()) return;
      const apiError = error instanceof ApiError ? error : undefined;
      const providerError = error instanceof AIProviderError ? error : undefined;
      this.transition(letter, previousState);
      letter.updatedAt = new Date().toISOString();
      job.status = "failed";
      job.error = {
        code: providerError?.code ?? apiError?.code ?? "GENERATION_FAILED",
        message: providerError?.message ?? apiError?.message ?? "家书生成失败",
        retryable: providerError?.retryable ?? false,
      };
    } finally { deadline.dispose(); }
    const finishedAt = new Date().toISOString();
    job.updatedAt = finishedAt;
    job.finishedAt = finishedAt;
    this.repository.transaction(() => {
      this.repository.saveLetter(letter);
      this.repository.saveJob(job);
    });
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
      const text = paragraph.text.trim();
      const textChanged = !previous || previous.text !== text;
      const requestedAttribution = this.parseParagraphSourceAttribution(
        paragraph.sourceAttribution,
      );
      if (paragraph.sourceRefs !== undefined && !this.isStringArray(paragraph.sourceRefs)) {
        throw new ApiError(400, "INVALID_SOURCE_REF", "sourceRefs 必须是字符串数组");
      }
      let sourceRefs: string[];
      let sourceAttribution: ParagraphSourceAttribution;

      if (requestedAttribution === "needs-review") {
        const preservedUnconfirmedRefs =
          !textChanged && previous?.sourceAttribution === "needs-review" &&
          this.sameSourceRefs(paragraph.sourceRefs ?? [], previous.sourceRefs);
        if (paragraph.sourceRefs && paragraph.sourceRefs.length > 0 && !preservedUnconfirmedRefs) {
          throw new ApiError(400, "INVALID_SOURCE_ATTRIBUTION", "待核对段落不能保留素材引用");
        }
        sourceRefs = preservedUnconfirmedRefs ? previous.sourceRefs : [];
        sourceAttribution = "needs-review";
      } else if (requestedAttribution === "user-supplied") {
        if (paragraph.sourceRefs && paragraph.sourceRefs.length > 0) {
          throw new ApiError(400, "INVALID_SOURCE_ATTRIBUTION", "本人补充不能引用素材");
        }
        sourceRefs = [];
        sourceAttribution = "user-supplied";
      } else if (requestedAttribution === "sources-confirmed") {
        if (!paragraph.sourceRefs || paragraph.sourceRefs.length === 0) {
          throw new ApiError(400, "INVALID_SOURCE_ATTRIBUTION", "重新核对依据时至少选择一份素材");
        }
        sourceRefs = paragraph.sourceRefs;
        sourceAttribution = "sources-confirmed";
      } else if (requestedAttribution === "ai") {
        if (
          textChanged ||
          !previous ||
          (previous.sourceAttribution !== undefined && previous.sourceAttribution !== "ai")
        ) {
          throw new ApiError(
            400,
            "INVALID_SOURCE_ATTRIBUTION",
            "只有原始 AI 整理段落可以保留 AI 归因，请重新核对依据或标记为本人补充",
          );
        }
        if (
          paragraph.sourceRefs !== undefined &&
          !this.sameSourceRefs(paragraph.sourceRefs, previous.sourceRefs)
        ) {
          throw new ApiError(
            400,
            "INVALID_SOURCE_ATTRIBUTION",
            "AI 整理段落不能由客户端更换素材引用",
          );
        }
        sourceRefs = previous.sourceRefs;
        sourceAttribution = "ai";
      } else if (textChanged) {
        // A legacy client may send old sourceRefs after editing. Discard them rather than
        // allowing a human rewrite to appear as an AI-supported claim.
        sourceRefs = [];
        sourceAttribution = "needs-review";
      } else {
        // Legacy clients post every paragraph and its existing refs. Treat missing attribution
        // as no attribution decision; source changes require an explicit confirmed state.
        sourceRefs = previous?.sourceRefs ?? [];
        sourceAttribution = previous?.sourceAttribution ?? "ai";
      }

      sourceRefs = [...new Set(sourceRefs)];
      for (const materialId of sourceRefs) {
        if (!letter.materialIds.includes(materialId)) {
          throw new ApiError(400, "INVALID_SOURCE_REF", "段落引用了不属于该家书的素材");
        }
      }
      return { id: previous?.id ?? randomUUID(), text, sourceRefs, sourceAttribution };
    });
    return {
      ...current,
      title: input.title?.trim() || current.title,
      greeting: input.greeting?.trim() || current.greeting,
      closing: input.closing?.trim() || current.closing,
      signature:
        input.signature === undefined
          ? current.signature
          : this.normalizeSignature(input.signature),
      paragraphs: paragraphs ?? current.paragraphs,
    };
  }

  private normalizeSignature(value: unknown): string {
    if (typeof value !== "string") {
      throw new ApiError(400, "INVALID_DRAFT", "署名必须是字符串");
    }
    const signature = value.trim();
    if (!signature || signature.length > 30) {
      throw new ApiError(400, "INVALID_DRAFT", "署名必须为 1 到 30 个字符");
    }
    return signature;
  }

  private parseParagraphSourceAttribution(
    value: unknown,
  ): ParagraphSourceAttribution | undefined {
    if (value === undefined) return undefined;
    if (
      typeof value !== "string" ||
      !PARAGRAPH_SOURCE_ATTRIBUTIONS.includes(value as ParagraphSourceAttribution)
    ) {
      throw new ApiError(400, "INVALID_SOURCE_ATTRIBUTION", "不支持的段落来源归因状态");
    }
    return value as ParagraphSourceAttribution;
  }

  private sameSourceRefs(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const rightRefs = new Set(right);
    return new Set(left).size === left.length && left.every((sourceRef) => rightRefs.has(sourceRef));
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
    if (uniqueIds.length > 30) {
      throw new ApiError(400, "INVALID_MATERIAL_IDS", "一封家书最多选择 30 份素材");
    }
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
