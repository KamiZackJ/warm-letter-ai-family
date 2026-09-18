import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Response = { statusCode: number; data: unknown; header?: Record<string, string> };
type NativeRequest = {
  url: string;
  method: string;
  header: Record<string, string>;
  timeout: number;
  responseType?: string;
  success(response: Response): void;
  fail(error: unknown): void;
};

function mockWx(request: (options: NativeRequest) => unknown, readFile = vi.fn()) {
  const requestMock = vi.fn(request);
  vi.stubGlobal("wx", {
    request: requestMock,
    getStorageSync: vi.fn(() => "private-access-token"),
    getFileSystemManager: () => ({ readFile }),
  });
  return requestMock;
}

function healthResponse(options: NativeRequest): boolean {
  if (!options.url.endsWith("/health")) return false;
  options.success({ statusCode: 200, data: { deploymentMode: "test" } });
  return true;
}

describe("native HTTP and media callback deadlines", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(["json", "binary"] as const)("aborts a stalled %s request once and ignores callbacks after timeout", async (kind) => {
    let options!: NativeRequest;
    const abort = vi.fn(() => options.fail({ errMsg: "request:fail abort private native details" }));
    mockWx((request) => {
      if (healthResponse(request)) return;
      options = request;
      return { abort };
    });
    const { request, requestBinary } = await import("../src/services/http-client");
    const onSuccess = vi.fn();
    const pending = (kind === "json" ? request("/letters", { timeoutMs: 25 }) : requestBinary("/speech", { timeoutMs: 25 }))
      .then(onSuccess, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.timeout).toBe(25);
    expect(options.responseType).toBe(kind === "binary" ? "arraybuffer" : undefined);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true, message: "网络请求超时，请重试" });
    expect(abort).toHaveBeenCalledTimes(1);
    options.success({ statusCode: 200, data: kind === "binary" ? new ArrayBuffer(3) : { ok: true } });
    options.fail({ errMsg: "late failure" });
    await Promise.resolve();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries deployment verification after a missing callback or mismatch without caching failure", async () => {
    let healthCalls = 0;
    const abort = vi.fn();
    const nativeRequest = mockWx((options) => {
      if (options.url.endsWith("/health")) {
        healthCalls += 1;
        expect(options.header).toEqual({});
        if (healthCalls === 1) return { abort };
        if (healthCalls === 2) {
          options.success({ statusCode: 200, data: { deploymentMode: "production" } });
          return;
        }
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      options.success({ statusCode: 200, data: { ok: true } });
    });
    const { request } = await import("../src/services/http-client");
    const first = request("/letters").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await first).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(abort).toHaveBeenCalledTimes(1);
    await expect(request("/letters")).rejects.toMatchObject({
      code: "DEPLOYMENT_MISMATCH", retryable: false, message: "暂时无法连接暖笺，请稍后重试",
    });
    expect(nativeRequest).toHaveBeenCalledTimes(2);
    await expect(request("/letters")).resolves.toEqual({ ok: true });
    expect(healthCalls).toBe(3);
    expect(nativeRequest).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled media read and never uploads its late bytes", async () => {
    let readOptions!: { success(result: { data: ArrayBuffer }): void };
    const readFile = vi.fn((options) => { readOptions = options; });
    const nativeRequest = mockWx(() => undefined, readFile);
    const { uploadBinary } = await import("../src/services/http-client");
    const pending = uploadBinary("https://uploads.example.test/object", "/private/path.mp3", {
      "content-type": "audio/mpeg", "x-upload-credential": "upload-only",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({ code: "MEDIA_READ_TIMEOUT", retryable: true });
    readOptions.success({ data: new ArrayBuffer(3) });
    await Promise.resolve();
    expect(nativeRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the upload request and preserves isolated upload headers", async () => {
    const readFile = vi.fn((options) => options.success({ data: new ArrayBuffer(3) }));
    const abort = vi.fn();
    const nativeRequest = mockWx(() => ({ abort }), readFile);
    const { uploadBinary } = await import("../src/services/http-client");
    const pending = uploadBinary("https://uploads.example.test/object", "/file.mp3", {
      "content-type": "audio/mpeg", "x-upload-credential": "upload-only",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(nativeRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      header: { "content-type": "audio/mpeg", "x-upload-credential": "upload-only" },
    }));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts synchronous callbacks, clears timers, and sanitizes native network errors", async () => {
    const abort = vi.fn();
    mockWx((options) => {
      if (!healthResponse(options)) {
        if (options.url.endsWith("/ok")) options.success({ statusCode: 200, data: { ok: true } });
        else options.fail({ errMsg: "native failure with private URL and credential" });
      }
      return { abort };
    });
    const { request } = await import("../src/services/http-client");
    await expect(request("/ok")).resolves.toEqual({ ok: true });
    await expect(request("/fail")).rejects.toMatchObject({
      message: "网络连接失败，请检查网络后重试", code: "NETWORK_ERROR", retryable: true,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid timeout %s before any network operation", async (timeoutMs) => {
    const nativeRequest = mockWx(() => undefined);
    const { request, requestBinary } = await import("../src/services/http-client");
    await expect(request("/letters", { timeoutMs })).rejects.toMatchObject({ code: "INVALID_REQUEST_TIMEOUT", retryable: false });
    await expect(requestBinary("/speech", { timeoutMs })).rejects.toMatchObject({ code: "INVALID_REQUEST_TIMEOUT" });
    expect(nativeRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
