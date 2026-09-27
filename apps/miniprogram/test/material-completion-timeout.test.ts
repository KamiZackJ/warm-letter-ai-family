import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "../src/types/domain";

vi.mock("../src/services/privacy", () => ({ ensurePrivacyConsent: vi.fn(async () => undefined) }));

type NativeRequest = {
  url: string;
  method: string;
  timeout: number;
  success(result: { statusCode: number; data: unknown }): void;
  fail(error: unknown): void;
};

const photo: Material = {
  id: "local-photo", type: "photo", name: "photo.jpg", localPath: "wxfile://selected/photo.jpg",
  createdAt: "2026-09-27T11:00:00Z",
};
const completedMaterial = {
  id: "server-photo", type: "photo", name: "photo.jpg", status: "READY", createdAt: photo.createdAt,
};

function setup() {
  const storage = new Map<string, unknown>([["warm_letter:test:access_token", "test-token"]]);
  let completion!: NativeRequest;
  const abort = vi.fn(() => completion.fail({ errMsg: "request:fail abort" }));
  const request = vi.fn((options: NativeRequest) => {
    if (options.url.endsWith("/health")) {
      options.success({ statusCode: 200, data: { deploymentMode: "test" } });
    } else if (options.url.endsWith("/materials/presign")) {
      options.success({ statusCode: 200, data: {
        materialId: completedMaterial.id, uploadUrl: "https://api.example.test/upload/photo",
        headers: { "content-type": "image/jpeg", "x-upload-credential": "test-upload-only" },
      } });
    } else if (options.method === "PUT") {
      options.success({ statusCode: 204, data: undefined });
    } else if (options.url.endsWith("/materials/complete")) {
      completion = options;
      return { abort };
    } else throw new Error("Unexpected request in completion test");
  });
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    getFileSystemManager: () => ({
      readFile: (options: { success(result: { data: ArrayBuffer }): void }) => options.success({ data: new ArrayBuffer(3) }),
    }),
    request,
  });
  return { storage, request, abort, completion: () => completion };
}

describe("material completion request budget", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("accepts completion after 12 seconds while keeping health, presign and upload at their normal budget", async () => {
    const mocks = setup();
    const { realApi } = await import("../src/services/api");
    const resolved = vi.fn();
    const pending = realApi.saveMaterial(photo).then(resolved);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.completion().timeout).toBe(65_000);
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    for (const [request] of mocks.request.mock.calls) {
      if (!request.url.endsWith("/materials/complete")) expect(request.timeout).toBe(12_000);
    }
    mocks.completion().success({ statusCode: 200, data: { material: completedMaterial } });
    await pending;
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ id: "server-photo", localPath: photo.localPath }));
    expect(mocks.storage.get("warm_letter:test:real_media_paths")).toEqual({ "server-photo": photo.localPath });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts once at 65 seconds and does not save a late successful completion", async () => {
    const mocks = setup();
    const { realApi } = await import("../src/services/api");
    const resolved = vi.fn();
    const pending = realApi.saveMaterial(photo).then(resolved, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(64_999);
    expect(mocks.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true });
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    mocks.completion().success({ statusCode: 200, data: { material: completedMaterial } });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).not.toHaveBeenCalled();
    expect(mocks.storage.has("warm_letter:test:real_media_paths")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
