import { environment, storageKey } from "../config/env";
import type {
  CreateLetterInput,
  GeneratedNarration,
  Letter,
  LetterDraft,
  LetterSummary,
  Material,
  ParagraphSourceAttribution,
  ReaderLetter,
  ReaderNarration,
  ReaderSource,
  Reply,
  SpeechCatalog,
} from "../types/domain";
import { createId } from "../utils/id";
import { letterDraftSpeechText } from "../utils/letter-speech";
import { mockApi } from "./mock-api";
import {
  GenerationJobFailedError,
  resolveGenerationJobId,
  waitForGenerationJob,
} from "./generation-polling";
import { HttpRequestError, request, requestBinary, uploadBinary } from "./http-client";
import { runCallbackTask } from "./async-task";
import { ensurePrivacyConsent } from "./privacy";
import { clearWarmLetterStorage, removeLetterLocally, removeNarrationFiles } from "../utils/data-deletion";

type ServerMaterial = {
  id: string;
  type: "photo" | "screenshot" | "audio" | "text";
  name: string;
  textContent?: string;
  durationSeconds?: number;
  status: "UPLOADING" | "READY" | "DELETED";
  createdAt: string;
};

type ServerDraft = {
  version: number;
  title: string;
  greeting: string;
  paragraphs: Array<{
    id: string;
    text: string;
    sourceRefs: string[];
    sourceAttribution?: ParagraphSourceAttribution;
  }>;
  closing: string;
  signature: string;
};

type ServerLetter = {
  id: string;
  recipient: string;
  materialIds: string[];
  settings: {
    tone: "warm" | "plain" | "lively";
    length: "short" | "medium" | "long";
    focus?: string;
    excludedTopics?: string[];
  };
  state: Letter["status"];
  draft?: ServerDraft;
  audioTranscripts?: Letter["audioTranscripts"];
  audioTranscriptRevisionPending?: boolean;
  confirmedDraft?: ServerDraft;
  shareToken?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

type ServerReply = {
  id: string;
  text: string;
  authorName: string;
  authorVerified: boolean;
  createdAt: string;
};

type ServerReaderSource = {
  id: string;
  type: ServerMaterial["type"];
  name: string;
  contentType?: string;
  mediaUrl?: string;
  mediaExpiresAt?: string;
  durationSeconds?: number;
};

type ServerReader = {
  id: string;
  recipient: string;
  draft: ServerDraft;
  publishedAt: string;
  sources: ServerReaderSource[];
  narration?: {
    id: string;
    name: string;
    voiceId: string;
    voiceName: string;
    contentType: "audio/mpeg" | "audio/wav";
    mediaUrl: string;
    mediaExpiresAt?: string;
    generatedAt: string;
  };
  replies: ServerReply[];
};

const REAL_LETTER_IDS_KEY = storageKey("real_letter_ids");
const REAL_INTENTS_KEY = storageKey("real_intents");
const REAL_MEDIA_PATHS_KEY = storageKey("real_media_paths");
const REAL_SHARE_TOKENS_KEY = storageKey("real_share_tokens");
const REAL_GENERATION_JOBS_KEY = storageKey("real_generation_jobs");
const REAL_GENERATION_REQUEST_KEYS_KEY = storageKey("real_generation_request_keys");
const ACCESS_TOKEN_KEY = storageKey("access_token");
const ACCOUNT_DELETED_KEY = storageKey("account_deleted");
const deletedLetterIds = new Set<string>();

function readRecord<T>(key: string): Record<string, T> {
  const value = wx.getStorageSync(key);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function readIds(): string[] {
  const value = wx.getStorageSync(REAL_LETTER_IDS_KEY);
  return Array.isArray(value) ? (value as string[]) : [];
}

function saveGenerationJob(letterId: string, jobId?: string): void {
  if (deletedLetterIds.has(letterId)) return;
  const jobs = readRecord<string>(REAL_GENERATION_JOBS_KEY);
  if (jobId) jobs[letterId] = jobId;
  else delete jobs[letterId];
  wx.setStorageSync(REAL_GENERATION_JOBS_KEY, jobs);
}

function saveGenerationRequestKey(letterId: string, requestKey?: string): void {
  if (deletedLetterIds.has(letterId)) return;
  const requestKeys = readRecord<string>(REAL_GENERATION_REQUEST_KEYS_KEY);
  if (requestKey) requestKeys[letterId] = requestKey;
  else delete requestKeys[letterId];
  wx.setStorageSync(REAL_GENERATION_REQUEST_KEYS_KEY, requestKeys);
}

function mapMaterial(material: ServerMaterial): Material {
  const paths = readRecord<string>(REAL_MEDIA_PATHS_KEY);
  return {
    id: material.id,
    type: material.type === "audio" ? "voice" : material.type,
    name: material.name,
    localPath: paths[material.id],
    text: material.textContent,
    durationSeconds: material.durationSeconds,
    createdAt: material.createdAt,
  };
}

function mediaUploadDescriptor(material: Material): {
  contentType: string;
  filename: string;
  localPath: string;
} {
  if (!material.localPath) {
    throw new HttpRequestError("请重新选择要添加的照片或录音", 0, "MATERIAL_FILE_REQUIRED", false);
  }
  const pathWithoutQuery = material.localPath.split("?", 1)[0] || material.localPath;
  const matchedExtension = pathWithoutQuery.match(/\.[a-zA-Z0-9]+$/)?.[0].toLowerCase();
  const fallbackExtension = material.type === "voice" ? ".mp3" : ".jpg";
  const extension = matchedExtension || fallbackExtension;
  const contentTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  };
  const contentType = contentTypes[extension];
  if (!contentType) {
    throw new HttpRequestError("暂不支持这个文件格式，请换一个文件", 0, "UNSUPPORTED_MATERIAL_FORMAT", false);
  }
  if (material.type === "voice" ? !contentType.startsWith("audio/") : !contentType.startsWith("image/")) {
    throw new HttpRequestError("请选择对应的照片或录音文件", 0, "MATERIAL_FORMAT_MISMATCH", false);
  }
  return {
    contentType,
    filename: material.name.toLowerCase().endsWith(extension)
      ? material.name
      : `${material.name}${extension}`,
    localPath: material.localPath,
  };
}

function mapReaderSource(source: ServerReaderSource): ReaderSource {
  return {
    id: source.id,
    type: source.type === "audio" ? "voice" : source.type,
    name: source.name,
    contentType: source.contentType,
    mediaUrl: source.mediaUrl,
    mediaExpiresAt: source.mediaExpiresAt,
    durationSeconds: source.durationSeconds,
  };
}

function mapReaderNarration(
  narration: NonNullable<ServerReader["narration"]>,
): ReaderNarration {
  return { ...narration };
}

async function writeNarrationFile(
  letterId: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<GeneratedNarration> {
  const normalizedContentType = contentType === "audio/x-wav" ? "audio/wav" : contentType;
  if (normalizedContentType !== "audio/wav" && normalizedContentType !== "audio/mpeg") {
    throw new HttpRequestError("朗读暂时无法播放，请重新生成", 0, "UNSUPPORTED_AUDIO_FORMAT", true);
  }
  const extension = normalizedContentType === "audio/wav" ? "wav" : "mp3";
  const safeLetterId = letterId.replace(/[^A-Za-z0-9_-]/g, "-");
  const filePath = `${wx.env.USER_DATA_PATH}/warm-letter-narration-${safeLetterId}-${createId("audio")}.${extension}`;
  const cleanup = () => {
    try { wx.getFileSystemManager().unlink({ filePath, fail: () => undefined }); } catch { /* Best effort. */ }
  };
  try {
    await runCallbackTask<void>(({ success, fail }) => {
      wx.getFileSystemManager().writeFile({
        filePath,
        data,
        success: () => success(undefined),
        fail: () => fail(new HttpRequestError("保存朗读失败，请重试", 0, "FILE_WRITE_FAILED", true)),
      });
    }, {
      timeoutMs: 12_000,
      timeoutError: () => new HttpRequestError("保存朗读音频超时，请重新生成", 0, "FILE_WRITE_TIMEOUT", true),
      onLateSuccess: cleanup,
    });
  } catch (error) {
    cleanup();
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError("保存朗读失败，请重试", 0, "FILE_WRITE_FAILED", true);
  }
  return { filePath, contentType: normalizedContentType };
}

function mapDraft(draft?: ServerDraft): LetterDraft | undefined {
  if (!draft) return undefined;
  return {
    title: draft.title,
    salutation: draft.greeting,
    paragraphs: draft.paragraphs,
    closing: draft.closing,
    signature: draft.signature,
  };
}

function fallbackIntent(letter: ServerLetter): CreateLetterInput["intent"] {
  return {
    recipient: letter.recipient,
    message: "由已选择的素材整理近况。",
    tone:
      letter.settings.tone === "plain"
        ? "concise"
        : letter.settings.tone === "lively"
          ? "lively"
          : "warm",
    length: letter.settings.length,
    focus: letter.settings.focus || "",
    exclusions: letter.settings.excludedTopics?.join("、") || "",
  };
}

function mapLetter(serverLetter: ServerLetter, replies: ServerReply[] = []): Letter {
  const intents = readRecord<CreateLetterInput["intent"]>(REAL_INTENTS_KEY);
  const shareTokens = readRecord<string>(REAL_SHARE_TOKENS_KEY);
  const draft = serverLetter.confirmedDraft || serverLetter.draft;
  return {
    id: serverLetter.id,
    status: serverLetter.state,
    materialIds: serverLetter.materialIds,
    intent: intents[serverLetter.id] || fallbackIntent(serverLetter),
    draft: mapDraft(draft),
    audioTranscripts: serverLetter.audioTranscripts,
    audioTranscriptRevisionPending: serverLetter.audioTranscriptRevisionPending,
    replies: replies.map((reply) => ({
      id: reply.id,
      text: reply.text,
      authorName: reply.authorName,
      authorVerified: reply.authorVerified,
      createdAt: reply.createdAt,
    })),
    createdAt: serverLetter.createdAt,
    updatedAt: serverLetter.updatedAt,
    confirmedAt: serverLetter.confirmedAt,
    shareToken: shareTokens[serverLetter.id],
  };
}

let loginInFlight: Promise<void> | null = null;
let accountDataEpoch = 0;

async function loginWithWeChat(): Promise<void> {
  const epoch = accountDataEpoch;
  await ensurePrivacyConsent();
  if (epoch !== accountDataEpoch) throw new Error("账号数据已清除，请重新打开首页");
  const loginResult = await runCallbackTask<{ code: string }>(({ success, fail }) => {
    wx.login({ timeout: 12_000, success, fail: () => fail(new Error("微信登录失败，请重试")) });
  }, {
    timeoutMs: 12_000,
    timeoutError: () => new HttpRequestError("微信登录超时，请重试", 0, "LOGIN_TIMEOUT", true),
  });
  const code = loginResult.code?.trim();
  if (epoch !== accountDataEpoch) throw new Error("账号数据已清除，请重新打开首页");
  if (!code && environment.deploymentMode !== "demo" && environment.deploymentMode !== "test") {
    throw new Error("微信登录未完成，请重试");
  }
  const response = await request<{ token: string }>("/auth/wx-login", {
    method: "POST",
    data: { code: code || "local-demo" },
  });
  if (epoch !== accountDataEpoch) throw new Error("账号数据已清除，请重新打开首页");
  wx.setStorageSync(ACCESS_TOKEN_KEY, response.token);
  if (wx.getStorageSync(ACCOUNT_DELETED_KEY) === true) wx.removeStorageSync(ACCOUNT_DELETED_KEY);
}

async function ensureLogin(): Promise<void> {
  if (wx.getStorageSync(ACCESS_TOKEN_KEY)) return;
  if (!loginInFlight) {
    loginInFlight = loginWithWeChat().finally(() => {
      loginInFlight = null;
    });
  }
  await loginInFlight;
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof HttpRequestError &&
    error.statusCode === 401 &&
    (error.code === "UNAUTHORIZED" || error.code === "WECHAT_LOGIN_REQUIRED")
  );
}

function clearAccessTokenIfCurrent(accessToken: unknown): void {
  if (wx.getStorageSync(ACCESS_TOKEN_KEY) === accessToken) {
    wx.removeStorageSync(ACCESS_TOKEN_KEY);
  }
}

async function authorized<T>(operation: () => Promise<T>): Promise<T> {
  const epoch = accountDataEpoch;
  const checkedOperation = async () => {
    if (epoch !== accountDataEpoch) throw new Error("账号数据已清除，请重新打开首页");
    const result = await operation();
    if (epoch !== accountDataEpoch) throw new Error("账号数据已清除，请重新打开首页");
    return result;
  };
  await ensureLogin();
  const attemptedToken = wx.getStorageSync(ACCESS_TOKEN_KEY);
  try {
    return await checkedOperation();
  } catch (error) {
    if (!isUnauthorized(error)) throw error;

    // Protected API handlers authenticate before mutations; keyed writes reuse their closure key.
    clearAccessTokenIfCurrent(attemptedToken);
    await ensureLogin();
    const retryToken = wx.getStorageSync(ACCESS_TOKEN_KEY);
    try {
      return await checkedOperation();
    } catch (retryError) {
      if (isUnauthorized(retryError)) {
        clearAccessTokenIfCurrent(retryToken);
      }
      throw retryError;
    }
  }
}

async function getServerLetter(id: string): Promise<ServerLetter> {
  const response = await authorized(() => request<{ letter: ServerLetter }>(`/letters/${id}`));
  return response.letter;
}

async function getServerReplies(id: string): Promise<ServerReply[]> {
  const response = await authorized(() =>
    request<{ replies: ServerReply[] }>(`/letters/${id}/replies`),
  );
  return response.replies;
}

function saveIntent(letterId: string, intent: CreateLetterInput["intent"]): void {
  const intents = readRecord<CreateLetterInput["intent"]>(REAL_INTENTS_KEY);
  wx.setStorageSync(REAL_INTENTS_KEY, { ...intents, [letterId]: intent });
}

function saveShareToken(letterId: string, shareToken: string): void {
  const tokens = readRecord<string>(REAL_SHARE_TOKENS_KEY);
  wx.setStorageSync(REAL_SHARE_TOKENS_KEY, { ...tokens, [letterId]: shareToken });
}

function requireShareToken(letterId: string, shareToken?: string): string {
  const token = shareToken || readRecord<string>(REAL_SHARE_TOKENS_KEY)[letterId];
  if (!token) throw new Error("阅读链接已失效，请重新确认家书");
  return token;
}

export const realApi = {
  async listMaterials(): Promise<Material[]> {
    const response = await authorized(() =>
      request<{ materials: ServerMaterial[] }>("/materials"),
    );
    return response.materials.filter((item) => item.status !== "DELETED").map(mapMaterial);
  },

  async saveMaterial(material: Material): Promise<Material> {
    await ensurePrivacyConsent();
    if (material.type !== "text") {
      const upload = mediaUploadDescriptor(material);
      const presigned = await authorized(() =>
        request<{
          materialId: string;
          uploadUrl?: string;
          headers?: Record<string, string>;
          completed?: boolean;
          material?: ServerMaterial;
        }>("/materials/presign", {
          method: "POST",
          headers: { "idempotency-key": material.id },
          data: {
            type: material.type === "voice" ? "audio" : material.type,
            filename: upload.filename,
            contentType: upload.contentType,
            durationSeconds: material.type === "voice" ? material.durationSeconds : undefined,
          },
        }),
      );
      if (presigned.completed && presigned.material?.status === "READY") {
        const paths = readRecord<string>(REAL_MEDIA_PATHS_KEY);
        wx.setStorageSync(REAL_MEDIA_PATHS_KEY, {
          ...paths,
          [presigned.material.id]: upload.localPath,
        });
        return mapMaterial(presigned.material);
      }
      if (!presigned.uploadUrl || !presigned.headers) {
        throw new Error("暂时无法上传，请稍后重试");
      }
      try {
        await uploadBinary(presigned.uploadUrl, upload.localPath, presigned.headers);
      } catch (error) {
        if (
          !(error instanceof HttpRequestError) ||
          error.statusCode !== 409 ||
          error.code !== "UPLOAD_ALREADY_RECEIVED"
        ) {
          throw error;
        }
      }
      const completed = await authorized(() =>
        request<{ material: ServerMaterial }>("/materials/complete", {
          method: "POST",
          data: { materialId: presigned.materialId },
        }),
      );
      const paths = readRecord<string>(REAL_MEDIA_PATHS_KEY);
      wx.setStorageSync(REAL_MEDIA_PATHS_KEY, {
        ...paths,
        [completed.material.id]: upload.localPath,
      });
      return mapMaterial(completed.material);
    }

    const response = await authorized(() =>
      request<{ material: ServerMaterial }>("/materials", {
        method: "POST",
        headers: { "idempotency-key": material.id },
        data: {
          type: material.type,
          name: material.name,
          textContent: material.text,
        },
      }),
    );
    return mapMaterial(response.material);
  },

  async deleteMaterial(id: string): Promise<void> {
    await authorized(() => request<void>(`/materials/${id}`, { method: "DELETE" }));
  },

  async listLetters(): Promise<LetterSummary[]> {
    // Returning to the home page after erasure must not silently recreate an account.
    if (wx.getStorageSync(ACCOUNT_DELETED_KEY) === true) return [];
    const startingIds = new Set(readIds());
    const response = await authorized(() => request<{ letters: ServerLetter[] }>("/letters"));
    const letters = response.letters.map((letter) => mapLetter(letter));
    // Preserve a local create committed while the server listing was in flight.
    wx.setStorageSync(REAL_LETTER_IDS_KEY, Array.from(new Set([
      ...readIds().filter((id) => !startingIds.has(id)),
      ...letters.map((letter) => letter.id),
    ])));
    return letters
      .map((letter) => ({
        id: letter.id,
        status: letter.status,
        intent: letter.intent,
        createdAt: letter.createdAt,
        updatedAt: letter.updatedAt,
        title: letter.draft?.title || `写给${letter.intent.recipient}的一封信`,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async deleteLetter(id: string): Promise<{ localCleanupComplete: boolean }> {
    await authorized(() => request<void>(`/letters/${encodeURIComponent(id)}`, { method: "DELETE" }));
    deletedLetterIds.add(id);
    try {
      removeLetterLocally(id);
      await removeNarrationFiles(id);
      return { localCleanupComplete: true };
    } catch { return { localCleanupComplete: false }; }
  },

  async deleteAccount(): Promise<{ localCleanupComplete: boolean }> {
    await authorized(() => request<void>("/account", { method: "DELETE" }));
    accountDataEpoch += 1;
    loginInFlight = null;
    try {
      clearWarmLetterStorage();
      wx.setStorageSync(ACCOUNT_DELETED_KEY, true);
      await removeNarrationFiles();
      return { localCleanupComplete: true };
    } catch { return { localCleanupComplete: false }; }
  },

  async createLetter(input: CreateLetterInput): Promise<Letter> {
    const response = await authorized(() =>
      request<{ letter: ServerLetter }>("/letters", {
        method: "POST",
        data: {
          recipient: input.intent.recipient,
          materialIds: input.materialIds,
          settings: {
            tone:
              input.intent.tone === "concise"
                ? "plain"
                : input.intent.tone === "lively"
                  ? "lively"
                  : "warm",
            length: input.intent.length,
            focus: input.intent.focus || input.intent.message,
            excludedTopics: input.intent.exclusions
              .split(/[、,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
          },
        },
      }),
    );
    saveIntent(response.letter.id, input.intent);
    wx.setStorageSync(
      REAL_LETTER_IDS_KEY,
      Array.from(new Set([response.letter.id, ...readIds()])),
    );
    return mapLetter(response.letter);
  },

  async getLetter(id: string): Promise<Letter> {
    const [letter, replies] = await Promise.all([
      getServerLetter(id),
      getServerReplies(id).catch(() => []),
    ]);
    return mapLetter(letter, replies);
  },

  async updateAudioTranscript(id: string, materialId: string, text: string): Promise<Letter> {
    const response = await authorized(() =>
      request<{ letter: ServerLetter }>(
        `/letters/${encodeURIComponent(id)}/audio-transcripts/${encodeURIComponent(materialId)}`,
        { method: "PATCH", data: { text } },
      ),
    );
    return mapLetter(response.letter);
  },

  async getReader(id: string, shareToken?: string): Promise<ReaderLetter> {
    const token = requireShareToken(id, shareToken);
    const response = await request<{ reader: ServerReader }>(
      `/letters/${id}/reader?token=${encodeURIComponent(token)}`,
    );
    saveShareToken(id, token);
    return {
      id: response.reader.id,
      recipient: response.reader.recipient,
      draft: mapDraft(response.reader.draft)!,
      sources: response.reader.sources.map(mapReaderSource),
      narration: response.reader.narration
        ? mapReaderNarration(response.reader.narration)
        : undefined,
      replies: response.reader.replies,
      publishedAt: response.reader.publishedAt,
      shareToken: token,
    };
  },

  async generateLetter(id: string): Promise<Letter> {
    let allowMissingJobRestart = true;
    while (true) {
      const existingJobId = readRecord<string>(REAL_GENERATION_JOBS_KEY)[id];
      let requestKey = readRecord<string>(REAL_GENERATION_REQUEST_KEYS_KEY)[id];
      const jobId = await resolveGenerationJobId(existingJobId, async () => {
        if (!requestKey) {
          requestKey = createId("generation");
          saveGenerationRequestKey(id, requestKey);
        }
        const response = await authorized(() =>
          request<{ job: { id: string } }>(`/letters/${id}/generate`, {
            method: "POST",
            headers: { "idempotency-key": requestKey! },
            data: {},
          }),
        );
        saveGenerationJob(id, response.job.id);
        return response.job;
      });
      let job;
      try {
        job = await waitForGenerationJob(
          jobId,
          (activeJobId) =>
            authorized(() =>
              request<{
                job: {
                  status: string;
                  error?: { code?: string; message?: string; retryable?: boolean };
                };
              }>(`/jobs/${activeJobId}`),
            ).then((response) => response.job),
          {
            shouldRetryError: (error) =>
              !(error instanceof HttpRequestError) ||
              error.retryable === true ||
              error.statusCode >= 500,
          },
        );
      } catch (error) {
        if (
          allowMissingJobRestart &&
          existingJobId &&
          error instanceof HttpRequestError &&
          error.code === "JOB_NOT_FOUND"
        ) {
          saveGenerationJob(id);
          allowMissingJobRestart = false;
          continue;
        }
        throw error;
      }
      if (job.status === "failed") {
        saveGenerationJob(id);
        saveGenerationRequestKey(id);
        throw new GenerationJobFailedError(
          job.error?.code === "AI_PROVIDER_TIMEOUT"
            ? "AI 处理超时，本次已停止，请重试生成"
            : job.error?.message || "家书生成失败",
          job.error?.code,
          job.error?.retryable,
        );
      }
      const letter = await realApi.getLetter(id);
      saveGenerationJob(id);
      saveGenerationRequestKey(id);
      return letter;
    }
  },

  async getSpeechCatalog(): Promise<SpeechCatalog> {
    return await authorized(() => request<SpeechCatalog>("/speech/voices"));
  },

  async generateNarration(
    id: string,
    draft: LetterDraft,
    voiceId: string,
    tone: CreateLetterInput["intent"]["tone"],
  ): Promise<GeneratedNarration> {
    const epoch = accountDataEpoch;
    const text = letterDraftSpeechText(draft);
    if (text.length > 4_000) {
      throw new Error("家书超过 4000 字，暂时无法生成整封朗读，请先精简文字");
    }
    const response = await authorized(() =>
      requestBinary(`/letters/${id}/speech`, {
        method: "POST",
        timeoutMs: 130_000,
        data: {
          text,
          voiceId,
          tone: tone === "concise" ? "plain" : tone,
          persist: true,
        },
      }),
    );
    const narration = await writeNarrationFile(id, response.data, response.contentType);
    if (epoch !== accountDataEpoch || deletedLetterIds.has(id)) {
      try { wx.getFileSystemManager().unlink({ filePath: narration.filePath, fail: () => undefined }); } catch { /* Best effort. */ }
      throw new Error("家书数据已删除，朗读已停止");
    }
    return narration;
  },

  async updateDraft(id: string, draft: LetterDraft): Promise<Letter> {
    const response = await authorized(() =>
      request<{ letter: ServerLetter }>(`/letters/${id}`, {
        method: "PATCH",
        data: {
          draft: {
            title: draft.title,
            greeting: draft.salutation,
            paragraphs: draft.paragraphs,
            closing: draft.closing,
            signature: draft.signature,
          },
        },
      }),
    );
    return mapLetter(response.letter);
  },

  async confirmLetter(id: string, draft: LetterDraft): Promise<Letter> {
    try {
      await realApi.updateDraft(id, draft);
      const response = await authorized(() =>
        request<{
          letter: ServerLetter;
          shareToken: string;
          shareExpiresAt: string;
          readerUrl: string;
        }>(`/letters/${id}/confirm`, { method: "POST", data: {} }),
      );
      saveShareToken(id, response.shareToken);
      return { ...mapLetter(response.letter), shareToken: response.shareToken };
    } catch (error) {
      if (error instanceof HttpRequestError && error.code?.startsWith("CONTENT_SAFETY_")) throw error;
      try {
        const current = await realApi.getLetter(id);
        if (current.status === "PUBLISHED" || current.status === "CONFIRMED") {
          return await realApi.reissueShare(id);
        }
      } catch {
        // Preserve the original confirmation error when recovery is unavailable.
      }
      throw error;
    }
  },

  async reissueShare(id: string): Promise<Letter> {
    const response = await authorized(() =>
      request<{
        letter: ServerLetter;
        shareToken: string;
        shareExpiresAt: string;
        readerUrl: string;
      }>(`/letters/${id}/share/reissue`, { method: "POST", data: {} }),
    );
    saveShareToken(id, response.shareToken);
    return { ...mapLetter(response.letter), shareToken: response.shareToken };
  },

  async addReply(
    id: string,
    text: string,
    shareToken?: string,
    requestKey?: string,
  ): Promise<Reply> {
    const token = requireShareToken(id, shareToken);
    await ensurePrivacyConsent();
    const response = await authorized(() => request<{ reply: ServerReply }>(
      `/letters/${id}/replies?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: requestKey ? { "idempotency-key": requestKey } : undefined,
        data: { text, authorName: "家人" },
      },
    ));
    return response.reply;
  },
};

export const api = environment.apiMode === "mock" ? mockApi : realApi;
