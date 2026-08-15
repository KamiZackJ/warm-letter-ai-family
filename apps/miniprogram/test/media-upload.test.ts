import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_MEDIA_PATHS } from "../src/config/demo-materials";
import { realApi } from "../src/services/api";
import { uploadBinary } from "../src/services/http-client";

const accessTokenKey = "warm_letter:test:access_token";
const mediaPathsKey = "warm_letter:test:real_media_paths";
const uploadUrl = "https://uploads.example.com/material-photo";
const fileContents = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;

type WxRequestOptions = {
  url: string;
  method: string;
  data?: unknown;
  header: Record<string, string>;
  success(response: { statusCode: number; data: unknown }): void;
  fail(error: { errMsg?: string }): void;
};

describe("real media upload", () => {
  const storage = new Map<string, unknown>();
  const events: string[] = [];
  const readFileMock = vi.fn();
  const requestMock = vi.fn();

  beforeEach(() => {
    storage.clear();
    storage.set(accessTokenKey, "test-token");
    events.length = 0;
    readFileMock.mockReset();
    requestMock.mockReset();

    readFileMock.mockImplementation(
      ({ filePath, success }: { filePath: string; success(result: { data: ArrayBuffer }): void }) => {
        events.push(`readFile:${filePath}`);
        success({ data: fileContents });
      },
    );
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const url = new URL(options.url);
      events.push(`${options.method}:${url.pathname}`);

      if (options.method === "GET" && url.pathname === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && url.pathname === "/v1/materials/presign") {
        options.success({
          statusCode: 200,
          data: {
            materialId: "material-photo",
            uploadUrl,
            headers: {
              "content-type": "image/png",
              "x-warm-letter-upload-token": "signed-upload-token",
            },
          },
        });
        return;
      }
      if (options.method === "PUT" && options.url === uploadUrl) {
        options.success({ statusCode: 200, data: undefined });
        return;
      }
      if (options.method === "POST" && url.pathname === "/v1/materials/complete") {
        options.success({
          statusCode: 200,
          data: {
            material: {
              id: "material-photo",
              type: "photo",
              name: "合成演示图：周末做饭.png",
              status: "READY",
              createdAt: "2026-08-15T12:00:00.000Z",
            },
          },
        });
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    Object.assign(globalThis, {
      wx: {
        getStorageSync(key: string) {
          return storage.get(key);
        },
        setStorageSync(key: string, value: unknown) {
          storage.set(key, value);
        },
        getFileSystemManager() {
          return { readFile: readFileMock };
        },
        request: requestMock,
      },
    });
  });

  it("reads the packaged file, uploads its bytes, then completes the material", async () => {
    await expect(
      realApi.saveMaterial({
        id: "local-photo",
        type: "photo",
        name: "合成演示图：周末做饭",
        localPath: DEMO_MEDIA_PATHS.photo,
        createdAt: "2026-08-15T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      id: "material-photo",
      type: "photo",
      localPath: DEMO_MEDIA_PATHS.photo,
    });

    expect(events).toEqual([
      "GET:/health",
      "POST:/v1/materials/presign",
      `readFile:${DEMO_MEDIA_PATHS.photo}`,
      "PUT:/material-photo",
      "POST:/v1/materials/complete",
    ]);
    expect(readFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: DEMO_MEDIA_PATHS.photo }),
    );

    const uploadRequest = requestMock.mock.calls
      .map(([options]) => options as WxRequestOptions)
      .find((options) => options.method === "PUT");
    expect(uploadRequest).toMatchObject({
      url: uploadUrl,
      data: fileContents,
    });
    expect(uploadRequest?.header).toEqual({
      "content-type": "image/png",
      "x-warm-letter-upload-token": "signed-upload-token",
    });
    expect(uploadRequest?.header).not.toHaveProperty("authorization");
    expect(Object.keys(uploadRequest?.header || {}).map((name) => name.toLowerCase())).not.toContain(
      "cookie",
    );

    const presignRequest = requestMock.mock.calls
      .map(([options]) => options as WxRequestOptions)
      .find((options) => options.url.endsWith("/materials/presign"));
    const completeRequest = requestMock.mock.calls
      .map(([options]) => options as WxRequestOptions)
      .find((options) => options.url.endsWith("/materials/complete"));
    expect(presignRequest?.header).toMatchObject({
      authorization: "Bearer test-token",
      "content-type": "application/json",
    });
    expect(completeRequest?.header).toMatchObject({
      authorization: "Bearer test-token",
      "content-type": "application/json",
    });
    expect(completeRequest?.data).toEqual({ materialId: "material-photo" });
    expect(storage.get(mediaPathsKey)).toEqual({
      "material-photo": DEMO_MEDIA_PATHS.photo,
    });
  });

  it("rejects authentication and cookie headers before reading or uploading a file", async () => {
    const unsafeHeaderSets: Array<Record<string, string>> = [
      { authorization: "Bearer leaked-token", "content-type": "image/png" },
      { Cookie: "session=leaked", "content-type": "image/png" },
      { "Proxy-Authorization": "Basic leaked", "content-type": "image/png" },
    ];
    for (const unsafeHeaders of unsafeHeaderSets) {
      await expect(
        uploadBinary(uploadUrl, DEMO_MEDIA_PATHS.photo, unsafeHeaders),
      ).rejects.toThrow("不安全的请求头");
    }

    expect(readFileMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
