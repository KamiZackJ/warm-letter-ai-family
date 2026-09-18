import { environment, storageKey } from "../config/env";
import { assertRemoteDeploymentMode } from "../config/runtime-environment";
import { runCallbackTask } from "./async-task";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  data?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

function accessTokenHeader(): Record<string, string> {
  const accessToken = wx.getStorageSync(storageKey("access_token"));
  return { authorization: accessToken ? `Bearer ${accessToken}` : "" };
}

let deploymentCheck: Promise<void> | null = null;

async function ensureDeploymentMatches(): Promise<void> {
  if (!deploymentCheck) {
    deploymentCheck = executeRequest<{ deploymentMode?: unknown }>({
      url: environment.healthUrl,
      method: "GET",
      header: {},
    })
      .then((health) => {
        try {
          assertRemoteDeploymentMode(environment.deploymentMode, health?.deploymentMode);
        } catch {
          throw new HttpRequestError("暂时无法连接暖笺，请稍后重试", 0, "DEPLOYMENT_MISMATCH", false);
        }
      })
      .catch((error) => {
        deploymentCheck = null;
        throw error;
      });
  }
  await deploymentCheck;
}

const forbiddenUploadHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

function safeUploadHeaders(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || forbiddenUploadHeaders.has(name)) {
      throw new HttpRequestError("暂时无法安全上传，请稍后重试", 0, "UNSAFE_UPLOAD_HEADERS", false);
    }
    if (typeof rawValue !== "string" || /[\r\n]/.test(rawValue) || name in result) {
      throw new HttpRequestError("暂时无法安全上传，请稍后重试", 0, "INVALID_UPLOAD_HEADERS", false);
    }
    result[name] = rawValue;
  }
  return result;
}

function requestTimeout(): HttpRequestError {
  return new HttpRequestError("网络请求超时，请重试", 0, "REQUEST_TIMEOUT", true);
}

function networkFailure(error: unknown): HttpRequestError {
  if (error instanceof HttpRequestError) return error;
  const message = error && typeof error === "object" && "errMsg" in error ? String(error.errMsg) : "";
  if (/timeout/i.test(message)) return requestTimeout();
  return new HttpRequestError("网络连接失败，请检查网络后重试", 0, "NETWORK_ERROR", true);
}

function requestTimeoutMs(value?: number): number {
  const timeoutMs = value ?? environment.requestTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new HttpRequestError("暂时无法连接服务，请稍后重试", 0, "INVALID_REQUEST_TIMEOUT", false);
  }
  return timeoutMs;
}

async function executeRequest<T>(options: {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  data?: unknown;
  header: Record<string, string>;
  timeoutMs?: number;
}): Promise<T> {
  const { timeoutMs: configuredTimeout, ...nativeOptions } = options;
  const timeoutMs = requestTimeoutMs(configuredTimeout);
  const response = await runCallbackTask<{ statusCode: number; data: unknown }>(
    (callbacks) => wx.request({ ...nativeOptions, timeout: timeoutMs, ...callbacks }),
    { timeoutMs, timeoutError: requestTimeout },
  ).catch((error: unknown) => { throw networkFailure(error); });
  if (response.statusCode >= 200 && response.statusCode < 300) return response.data as T;
  const payload = response.data as {
    message?: string;
    error?: { code?: string; message?: string; retryable?: boolean };
  };
  throw new HttpRequestError(
    payload?.error?.message || payload?.message || "服务暂时不可用",
    response.statusCode,
    payload?.error?.code,
    payload?.error?.retryable,
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const timeoutMs = requestTimeoutMs(options.timeoutMs);
  await ensureDeploymentMatches();
  const header = { ...options.headers, ...accessTokenHeader() };
  if (options.data !== undefined) {
    header["content-type"] = "application/json";
  }
  return executeRequest<T>({
    url: `${environment.apiBaseUrl}${path}`,
    method: options.method || "GET",
    data: options.data,
    header,
    timeoutMs,
  });
}

function decodeBinaryError(data: unknown): {
  message?: string;
  error?: { code?: string; message?: string; retryable?: boolean };
} {
  if (!(data instanceof ArrayBuffer)) {
    return data && typeof data === "object"
      ? (data as {
          message?: string;
          error?: { code?: string; message?: string; retryable?: boolean };
        })
      : {};
  }
  try {
    const bytes = new Uint8Array(data);
    let percentEncoded = "";
    for (const byte of bytes) percentEncoded += `%${byte.toString(16).padStart(2, "0")}`;
    return JSON.parse(decodeURIComponent(percentEncoded)) as {
      message?: string;
      error?: { code?: string; message?: string; retryable?: boolean };
    };
  } catch {
    return {};
  }
}

export async function requestBinary(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const timeoutMs = requestTimeoutMs(options.timeoutMs);
  await ensureDeploymentMatches();
  const header = { ...options.headers, ...accessTokenHeader() };
  if (options.data !== undefined) header["content-type"] = "application/json";

  const response = await runCallbackTask<{
    statusCode: number;
    data: unknown;
    header?: Record<string, string>;
  }>((callbacks) => wx.request({
      url: `${environment.apiBaseUrl}${path}`,
      method: options.method || "GET",
      data: options.data,
      header,
      responseType: "arraybuffer",
      timeout: timeoutMs,
      ...callbacks,
    }), { timeoutMs, timeoutError: requestTimeout },
  ).catch((error: unknown) => { throw networkFailure(error); });
  if (response.statusCode >= 200 && response.statusCode < 300) {
    if (!(response.data instanceof ArrayBuffer)) {
      throw new HttpRequestError("朗读暂时无法播放，请重新生成", 0, "INVALID_AUDIO_RESPONSE", true);
    }
    const contentTypeEntry = Object.entries(response.header || {}).find(
      ([name]) => name.toLowerCase() === "content-type",
    );
    return {
      data: response.data,
      contentType: contentTypeEntry?.[1]?.split(";", 1)[0]?.toLowerCase() || "",
    };
  }
  const payload = decodeBinaryError(response.data);
  throw new HttpRequestError(
    payload.error?.message || payload.message || "服务暂时不可用",
    response.statusCode,
    payload.error?.code,
    payload.error?.retryable,
  );
}

export async function uploadBinary(
  uploadUrl: string,
  filePath: string,
  uploadHeaders: Record<string, string>,
): Promise<void> {
  const header = safeUploadHeaders(uploadHeaders);
  const fileResult = await runCallbackTask<{ data: ArrayBuffer | string }>((callbacks) =>
    wx.getFileSystemManager().readFile({
      filePath,
      ...callbacks,
    }), {
      timeoutMs: environment.requestTimeoutMs,
      timeoutError: () => new HttpRequestError("读取媒体文件超时，请重新选择后重试", 0, "MEDIA_READ_TIMEOUT", true),
    },
  ).catch((error: unknown) => {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError("读取媒体文件失败，请重新选择后重试", 0, "MEDIA_READ_FAILED", true);
  });
  if (!(fileResult.data instanceof ArrayBuffer)) {
    throw new HttpRequestError("读取媒体文件失败，请重新选择后重试", 0, "MEDIA_READ_FAILED", true);
  }

  await executeRequest<void>({
    url: uploadUrl,
    method: "PUT",
    data: fileResult.data,
    header,
  });
}
