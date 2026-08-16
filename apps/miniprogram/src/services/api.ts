import { environment, storageKey } from "../config/env";
import type {
  CreateLetterInput,
  Letter,
  LetterDraft,
  LetterSummary,
  Material,
  ParagraphSourceAttribution,
  ReaderLetter,
  ReaderSource,
  Reply,
} from "../types/domain";
import { createId } from "../utils/id";
import { mockApi } from "./mock-api";
import {
  GenerationJobFailedError,
  resolveGenerationJobId,
  waitForGenerationJob,
} from "./generation-polling";
import { HttpRequestError, request, uploadBinary } from "./http-client";

type ServerMaterial = {
  id: string;
  type: "photo" | "screenshot" | "audio" | "text";
  name: string;
  textContent?: string;
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
  replies: ServerReply[];
};

const REAL_LETTER_IDS_KEY = storageKey("real_letter_ids");
const REAL_INTENTS_KEY = storageKey("real_intents");
const REAL_SIGNATURES_KEY = storageKey("real_signatures");
const REAL_MEDIA_PATHS_KEY = storageKey("real_media_paths");
const REAL_SHARE_TOKENS_KEY = storageKey("real_share_tokens");
const REAL_GENERATION_JOBS_KEY = storageKey("real_generation_jobs");
const REAL_GENERATION_REQUEST_KEYS_KEY = storageKey("real_generation_request_keys");
const ACCESS_TOKEN_KEY = storageKey("access_token");

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

function isStaleLetterIdError(error: unknown): boolean {
  return (
    error instanceof HttpRequestError &&
    error.statusCode === 404 &&
    error.code === "LETTER_NOT_FOUND"
  );
}

function saveGenerationJob(letterId: string, jobId?: string): void {
  const jobs = readRecord<string>(REAL_GENERATION_JOBS_KEY);
  if (jobId) jobs[letterId] = jobId;
  else delete jobs[letterId];
  wx.setStorageSync(REAL_GENERATION_JOBS_KEY, jobs);
}

function saveGenerationRequestKey(letterId: string, requestKey?: string): void {
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
    createdAt: material.createdAt,
  };
}

function mediaUploadDescriptor(material: Material): {
  contentType: string;
  filename: string;
  localPath: string;
} {
  if (!material.localPath) {
    throw new Error("真实模式必须选择本机图片或语音文件");
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
    throw new Error("暂不支持该媒体文件格式");
  }
  if (material.type === "voice" ? !contentType.startsWith("audio/") : !contentType.startsWith("image/")) {
    throw new Error("素材类型与文件格式不匹配");
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

function mapDraft(letterId: string, draft?: ServerDraft): LetterDraft | undefined {
  if (!draft) return undefined;
  const signatures = readRecord<string>(REAL_SIGNATURES_KEY);
  return {
    title: draft.title,
    salutation: draft.greeting,
    paragraphs: draft.paragraphs,
    closing: draft.closing,
    signature: signatures[letterId] || "想念你的我",
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
  const draft = serverLetter.confirmedDraft || serverLetter.draft;
  return {
    id: serverLetter.id,
    status: serverLetter.state,
    materialIds: serverLetter.materialIds,
    intent: intents[serverLetter.id] || fallbackIntent(serverLetter),
    draft: mapDraft(serverLetter.id, draft),
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
    shareToken: serverLetter.shareToken,
  };
}

let loginInFlight: Promise<void> | null = null;

async function loginWithWeChat(): Promise<void> {
  const loginResult = await new Promise<{ code: string }>((resolve, reject) => {
    wx.login({ success: resolve, fail: reject });
  });
  const code = loginResult.code?.trim();
  if (!code && environment.deploymentMode !== "demo" && environment.deploymentMode !== "test") {
    throw new Error("微信登录未返回有效 code，当前环境禁止开发凭据回退");
  }
  const response = await request<{ token: string }>("/auth/wx-login", {
    method: "POST",
    data: { code: code || "local-demo" },
  });
  wx.setStorageSync(ACCESS_TOKEN_KEY, response.token);
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
    error.code === "UNAUTHORIZED"
  );
}

function clearAccessTokenIfCurrent(accessToken: unknown): void {
  if (wx.getStorageSync(ACCESS_TOKEN_KEY) === accessToken) {
    wx.removeStorageSync(ACCESS_TOKEN_KEY);
  }
}

async function authorized<T>(operation: () => Promise<T>): Promise<T> {
  await ensureLogin();
  const attemptedToken = wx.getStorageSync(ACCESS_TOKEN_KEY);
  try {
    return await operation();
  } catch (error) {
    if (!isUnauthorized(error)) throw error;

    // Protected API handlers authenticate before mutations; keyed writes reuse their closure key.
    clearAccessTokenIfCurrent(attemptedToken);
    await ensureLogin();
    const retryToken = wx.getStorageSync(ACCESS_TOKEN_KEY);
    try {
      return await operation();
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

function saveSignature(letterId: string, signature: string): void {
  const signatures = readRecord<string>(REAL_SIGNATURES_KEY);
  wx.setStorageSync(REAL_SIGNATURES_KEY, { ...signatures, [letterId]: signature });
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
          },
        }),
      );
      if (presigned.completed && presigned.material?.status === "READY") {
        const paths = readRecord<string>(REAL_MEDIA_PATHS_KEY);
        wx.setStorageSync(REAL_MEDIA_PATHS_KEY, {
          ...paths,
          [presigned.material.id]: upload.localPath,
        });
        return { ...mapMaterial(presigned.material), durationSeconds: material.durationSeconds };
      }
      if (!presigned.uploadUrl || !presigned.headers) {
        throw new Error("上传服务没有返回可用的上传凭据");
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
      return { ...mapMaterial(completed.material), durationSeconds: material.durationSeconds };
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
    const ids = readIds();
    const letters = await Promise.all(
      ids.map(async (id) => {
        try {
          return mapLetter(await getServerLetter(id));
        } catch (error) {
          if (isStaleLetterIdError(error)) return null;
          throw error;
        }
      }),
    );
    if (letters.some((letter) => letter === null)) {
      const staleIds = new Set(
        ids.filter((_, index) => letters[index] === null),
      );
      wx.setStorageSync(
        REAL_LETTER_IDS_KEY,
        readIds().filter((id) => !staleIds.has(id)),
      );
    }
    return letters
      .filter((letter): letter is Letter => Boolean(letter))
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

  async getReader(id: string, shareToken?: string): Promise<ReaderLetter> {
    const token = requireShareToken(id, shareToken);
    const response = await request<{ reader: ServerReader }>(
      `/letters/${id}/reader?token=${encodeURIComponent(token)}`,
    );
    saveShareToken(id, token);
    return {
      id: response.reader.id,
      recipient: response.reader.recipient,
      draft: mapDraft(response.reader.id, response.reader.draft)!,
      sources: response.reader.sources.map(mapReaderSource),
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
          job.error?.message || "家书生成失败",
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

  async updateDraft(id: string, draft: LetterDraft): Promise<Letter> {
    saveSignature(id, draft.signature);
    const response = await authorized(() =>
      request<{ letter: ServerLetter }>(`/letters/${id}`, {
        method: "PATCH",
        data: {
          draft: {
            title: draft.title,
            greeting: draft.salutation,
            paragraphs: draft.paragraphs,
            closing: draft.closing,
          },
        },
      }),
    );
    return mapLetter(response.letter);
  },

  async confirmLetter(id: string, draft: LetterDraft): Promise<Letter> {
    await realApi.updateDraft(id, draft);
    const response = await authorized(() =>
      request<{
        letter: ServerLetter;
        shareToken: string;
        shareExpiresAt: string;
        readerUrl: string;
      }>(`/letters/${id}/confirm`, { method: "POST" }),
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
    const response = await request<{ reply: ServerReply }>(
      `/letters/${id}/replies?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: requestKey ? { "idempotency-key": requestKey } : undefined,
        data: { text, authorName: "家人" },
      },
    );
    return response.reply;
  },
};

export const api = environment.apiMode === "mock" ? mockApi : realApi;
