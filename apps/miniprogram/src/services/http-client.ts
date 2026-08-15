import { environment, storageKey } from "../config/env";
import { assertRemoteDeploymentMode } from "../config/runtime-environment";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  data?: unknown;
  headers?: Record<string, string>;
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
      throw new Error("上传服务返回了不安全的请求头");
    }
    if (typeof rawValue !== "string" || /[\r\n]/.test(rawValue) || name in result) {
      throw new Error("上传服务返回了无效的请求头");
    }
    result[name] = rawValue;
  }
  return result;
}

function executeRequest<T>(options: {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  data?: unknown;
  header: Record<string, string>;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      ...options,
      timeout: environment.requestTimeoutMs,
      success(response: {
        statusCode: number;
        data:
          | T
          | {
              message?: string;
              error?: { code?: string; message?: string; retryable?: boolean };
            };
      }) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        const payload = response.data as {
          message?: string;
          error?: { code?: string; message?: string; retryable?: boolean };
        };
        reject(
          new HttpRequestError(
            payload?.error?.message || payload?.message || "服务暂时不可用",
            response.statusCode,
            payload?.error?.code,
            payload?.error?.retryable,
          ),
        );
      },
      fail(error: { errMsg?: string }) {
        reject(new Error(error.errMsg || "网络连接失败"));
      },
    });
  });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!deploymentCheck) {
    deploymentCheck = executeRequest<{ deploymentMode?: unknown }>({
      url: environment.healthUrl,
      method: "GET",
      header: {},
    })
      .then((health) => {
        assertRemoteDeploymentMode(environment.deploymentMode, health.deploymentMode);
      })
      .catch((error) => {
        deploymentCheck = null;
        throw error;
      });
  }
  await deploymentCheck;
  const header = { ...options.headers, ...accessTokenHeader() };
  if (options.data !== undefined) {
    header["content-type"] = "application/json";
  }
  return executeRequest<T>({
    url: `${environment.apiBaseUrl}${path}`,
    method: options.method || "GET",
    data: options.data,
    header,
  });
}

export async function uploadBinary(
  uploadUrl: string,
  filePath: string,
  uploadHeaders: Record<string, string>,
): Promise<void> {
  const header = safeUploadHeaders(uploadHeaders);
  const fileData = await new Promise<ArrayBuffer>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success(result: { data: ArrayBuffer | string }) {
        if (typeof result.data === "string") {
          reject(new Error("读取媒体文件失败"));
          return;
        }
        resolve(result.data);
      },
      fail(error: { errMsg?: string }) {
        reject(new Error(error.errMsg || "读取媒体文件失败"));
      },
    });
  });

  await executeRequest<void>({
    url: uploadUrl,
    method: "PUT",
    data: fileData,
    header,
  });
}
