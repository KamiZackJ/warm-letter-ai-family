import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AIProvider } from "./ai.js";
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

const defaultSettings: LetterSettings = { tone: "warm", length: "medium" };

export interface RegisterMaterialInput {
  type: MaterialType;
  name: string;
  contentType?: string;
  objectKey?: string;
  textContent?: string;
  uploading?: boolean;
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
  now?: () => Date;
}

export interface PublishedLetterResult {
  letter: Letter;
  shareToken: string;
  shareExpiresAt: string;
}

export class WarmLetterService {
  private readonly shareTokenTtlMs: number;
  private readonly now: () => Date;

  constructor(
    readonly repository: MemoryRepository,
    private readonly aiProvider: AIProvider,
    options: WarmLetterServiceOptions = {},
  ) {
    this.shareTokenTtlMs = options.shareTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
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

  registerMaterial(userId: string, input: RegisterMaterialInput): Material {
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

    return this.repository.saveMaterial({
      id: randomUUID(),
      userId,
      type: input.type,
      name: input.name.trim(),
      contentType: input.contentType,
      objectKey: input.objectKey,
      textContent: input.textContent?.trim(),
      status: input.uploading ? "UPLOADING" : "READY",
      createdAt: new Date().toISOString(),
    });
  }

  completeMaterial(userId: string, materialId: string, input: { textContent?: string }): Material {
    const material = this.requireOwnedMaterial(userId, materialId);
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

  enqueueGeneration(userId: string, letterId: string): GenerationJob {
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
      status: "queued",
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
    this.revokeShareAccess(letter.id);
    const share = this.issueShareAccess(letter.id);
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
        mediaExpiresAt?: string;
      }
    >;
    replies: Reply[];
  } {
    const letter = assertFound(this.repository.getLetter(letterId), "LETTER_NOT_FOUND", "家书不存在");
    const access = this.assertPublishedAccess(letter, shareToken);
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
        return {
          id: material.id,
          type: material.type,
          name: material.name,
          contentType: material.contentType,
          mediaExpiresAt: material.type === "text" ? undefined : access.expiresAt,
        };
      }),
      replies: this.repository.listReplies(letter.id),
    };
  }

  getPublicMaterial(
    letterId: string,
    materialId: string,
    shareToken: string | undefined,
  ): Material {
    const letter = assertFound(this.repository.getLetter(letterId), "LETTER_NOT_FOUND", "家书不存在");
    this.assertPublishedAccess(letter, shareToken);
    if (!letter.materialIds.includes(materialId)) {
      throw new ApiError(404, "MATERIAL_NOT_FOUND", "家书来源素材不存在");
    }
    const material = assertFound(
      this.repository.getMaterial(materialId),
      "MATERIAL_NOT_FOUND",
      "家书来源素材不存在",
    );
    if (material.status !== "READY" || material.type === "text" || !material.objectKey) {
      throw new ApiError(404, "MATERIAL_NOT_FOUND", "家书来源媒体不存在");
    }
    return material;
  }

  createReply(letterId: string, shareToken: string | undefined, text: string, authorName?: string): Reply {
    const letter = assertFound(this.repository.getLetter(letterId), "LETTER_NOT_FOUND", "家书不存在");
    this.assertPublishedAccess(letter, shareToken);
    if (!text.trim()) {
      throw new ApiError(400, "INVALID_REPLY", "回复内容不能为空");
    }
    return this.repository.saveReply({
      id: randomUUID(),
      letterId,
      text: text.trim(),
      authorName: authorName?.trim() || "家人",
      createdAt: new Date().toISOString(),
    });
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
      this.transition(letter, previousState);
      letter.updatedAt = new Date().toISOString();
      this.repository.saveLetter(letter);
      job.status = "failed";
      job.error = {
        code: apiError?.code ?? "GENERATION_FAILED",
        message: apiError?.message ?? "家书生成失败",
      };
    }
    job.updatedAt = new Date().toISOString();
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

  private assertPublishedAccess(letter: Letter, shareToken: string | undefined): ShareAccess {
    if (letter.state !== "PUBLISHED" || !letter.confirmedDraft || !letter.publishedAt) {
      throw new ApiError(409, "LETTER_NOT_PUBLISHED", "家书尚未确认发布");
    }
    if (!shareToken) {
      throw new ApiError(403, "INVALID_SHARE_TOKEN", "读信链接无效");
    }
    const access = this.repository.findShareAccessByTokenHash(this.hashShareToken(shareToken));
    if (!access || access.letterId !== letter.id) {
      throw new ApiError(403, "INVALID_SHARE_TOKEN", "读信链接无效");
    }
    if (access.revokedAt) {
      throw new ApiError(410, "SHARE_TOKEN_REVOKED", "读信链接已撤销");
    }
    if (Date.parse(access.expiresAt) <= this.now().getTime()) {
      throw new ApiError(410, "SHARE_TOKEN_EXPIRED", "读信链接已过期");
    }
    return access;
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

  private revokeShareAccess(letterId: string): void {
    const revokedAt = this.now().toISOString();
    for (const access of this.repository.listShareAccess(letterId)) {
      if (!access.revokedAt) {
        access.revokedAt = revokedAt;
        this.repository.saveShareAccess(access);
      }
    }
  }

  private hashShareToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
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
