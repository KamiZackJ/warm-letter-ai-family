import { environment } from "../config/env";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  data?: unknown;
};

function accessTokenHeader(): Record<string, string> {
  const accessToken = wx.getStorageSync("warm_letter_access_token");
  return { authorization: accessToken ? `Bearer ${accessToken}` : "" };
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
        data: T | { message?: string; error?: { message?: string } };
      }) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        const payload = response.data as { message?: string; error?: { message?: string } };
        reject(new Error(payload?.error?.message || payload?.message || "服务暂时不可用"));
      },
      fail(error: { errMsg?: string }) {
        reject(new Error(error.errMsg || "网络连接失败"));
      },
    });
  });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const header = accessTokenHeader();
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
  contentType: string,
): Promise<void> {
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
    header: { ...accessTokenHeader(), "content-type": contentType },
  });
}
