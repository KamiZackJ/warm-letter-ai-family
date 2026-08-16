import { beforeEach, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/services/api";

const accessTokenKey = "warm_letter:test:access_token";
const mediaPathsKey = "warm_letter:test:real_media_paths";
const uploadUrl = "https://uploads.example.com/v1/materials/server-photo/content";
const fileContents = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;

type WxRequestOptions = {
  url: string;
  method: string;
  data?: unknown;
  header: Record<string, string>;
  success(response: { statusCode: number; data: unknown }): void;
  fail(error: { errMsg?: string }): void;
};

const readyPhoto = {
  id: "server-photo",
  type: "photo" as const,
  name: "Family photo.png",
  status: "READY" as const,
  createdAt: "2026-08-16T08:00:00.000Z",
};

describe("real material idempotency recovery", () => {
  const storage = new Map<string, unknown>();
  const requestMock = vi.fn();
  const readFileMock = vi.fn();

  beforeEach(() => {
    storage.clear();
    storage.set(accessTokenKey, "test-token");
    requestMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockImplementation(
      ({ success }: { success(result: { data: ArrayBuffer }): void }) => {
        success({ data: fileContents });
      },
    );

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

  it("reuses the original text material id after a successful response is lost", async () => {
    let postCount = 0;
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const path = new URL(options.url).pathname;
      if (options.method === "GET" && path === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/materials") {
        postCount += 1;
        if (postCount === 1) {
          options.fail({ errMsg: "response lost after commit" });
          return;
        }
        options.success({
          statusCode: 200,
          data: {
            material: {
              id: "server-text",
              type: "text",
              name: "Daily note",
              textContent: "Dinner went well.",
              status: "READY",
              createdAt: "2026-08-16T08:00:00.000Z",
            },
          },
        });
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    const material = {
      id: "text_1786867200000_retry01",
      type: "text" as const,
      name: "Daily note",
      text: "Dinner went well.",
      createdAt: "2026-08-16T08:00:00.000Z",
    };
    await expect(realApi.saveMaterial(material)).rejects.toThrow("response lost after commit");
    await expect(realApi.saveMaterial(material)).resolves.toMatchObject({
      id: "server-text",
      text: "Dinner went well.",
    });

    const posts = requestMock.mock.calls
      .map(([options]) => options as WxRequestOptions)
      .filter((options) => new URL(options.url).pathname === "/v1/materials");
    expect(posts).toHaveLength(2);
    expect(posts.map((options) => options.header["idempotency-key"])).toEqual([
      material.id,
      material.id,
    ]);
  });

  it("continues to complete when a retried upload reports that bytes already arrived", async () => {
    let uploadCount = 0;
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const path = new URL(options.url).pathname;
      if (options.method === "GET" && path === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/materials/presign") {
        options.success({
          statusCode: 200,
          data: {
            materialId: "server-photo",
            objectKey: "owner/server-photo.png",
            completed: false,
            uploadUrl,
            headers: {
              "content-type": "image/png",
              "x-warm-letter-upload-token": "fresh-upload-token",
            },
          },
        });
        return;
      }
      if (options.method === "PUT" && options.url === uploadUrl) {
        uploadCount += 1;
        if (uploadCount === 1) {
          options.fail({ errMsg: "upload response lost after commit" });
          return;
        }
        options.success({
          statusCode: 409,
          data: { error: { code: "UPLOAD_ALREADY_RECEIVED", message: "already received" } },
        });
        return;
      }
      if (options.method === "POST" && path === "/v1/materials/complete") {
        options.success({ statusCode: 200, data: { material: readyPhoto } });
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    const material = {
      id: "photo_1786867200000_retry01",
      type: "photo" as const,
      name: "Family photo",
      localPath: "/tmp/family.png",
      createdAt: "2026-08-16T08:00:00.000Z",
    };
    await expect(realApi.saveMaterial(material)).rejects.toThrow(
      "upload response lost after commit",
    );
    await expect(realApi.saveMaterial(material)).resolves.toMatchObject({
      id: "server-photo",
      localPath: material.localPath,
    });

    const requests = requestMock.mock.calls.map(([options]) => options as WxRequestOptions);
    const presigns = requests.filter(
      (options) => new URL(options.url).pathname === "/v1/materials/presign",
    );
    expect(presigns).toHaveLength(2);
    expect(presigns.map((options) => options.header["idempotency-key"])).toEqual([
      material.id,
      material.id,
    ]);
    expect(requests.filter((options) => options.method === "PUT")).toHaveLength(2);
    expect(
      requests.filter(
        (options) => new URL(options.url).pathname === "/v1/materials/complete",
      ),
    ).toHaveLength(1);
    expect(storage.get(mediaPathsKey)).toEqual({ "server-photo": material.localPath });
  });

  it("returns the READY material when the complete response was lost", async () => {
    let ready = false;
    let completeCount = 0;
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const path = new URL(options.url).pathname;
      if (options.method === "GET" && path === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/materials/presign") {
        options.success({
          statusCode: 200,
          data: ready
            ? {
                materialId: "server-photo",
                objectKey: "owner/server-photo.png",
                completed: true,
                material: readyPhoto,
              }
            : {
                materialId: "server-photo",
                objectKey: "owner/server-photo.png",
                completed: false,
                uploadUrl,
                headers: {
                  "content-type": "image/png",
                  "x-warm-letter-upload-token": "fresh-upload-token",
                },
              },
        });
        return;
      }
      if (options.method === "PUT" && options.url === uploadUrl) {
        options.success({ statusCode: 204, data: undefined });
        return;
      }
      if (options.method === "POST" && path === "/v1/materials/complete") {
        completeCount += 1;
        ready = true;
        options.fail({ errMsg: "complete response lost after commit" });
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    const material = {
      id: "photo_1786867200000_complete01",
      type: "photo" as const,
      name: "Family photo",
      localPath: "/tmp/family.png",
      createdAt: "2026-08-16T08:00:00.000Z",
    };
    await expect(realApi.saveMaterial(material)).rejects.toThrow(
      "complete response lost after commit",
    );
    await expect(realApi.saveMaterial(material)).resolves.toMatchObject({
      id: "server-photo",
      localPath: material.localPath,
    });

    const requests = requestMock.mock.calls.map(([options]) => options as WxRequestOptions);
    expect(
      requests.filter(
        (options) => new URL(options.url).pathname === "/v1/materials/presign",
      ),
    ).toHaveLength(2);
    expect(requests.filter((options) => options.method === "PUT")).toHaveLength(1);
    expect(completeCount).toBe(1);
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(storage.get(mediaPathsKey)).toEqual({ "server-photo": material.localPath });
  });
});
