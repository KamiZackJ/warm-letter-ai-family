import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("owned data erasure", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const storage = new Map<string, unknown>([
      ["warm_letter:test:access_token", "session"],
      ["warm_letter:test:real_letter_ids", ["letter-1", "letter-2"]],
      ["warm_letter:test:real_intents", { "letter-1": { recipient: "妈妈" }, "letter-2": { recipient: "爸爸" } }],
      ["warm_letter:test:pending_generation", { letterId: "letter-1", fingerprint: "f" }],
      ["warm_letter:demo:letters", ["old-demo"]],
      ["other_app:value", "keep"],
    ]);
    const unlink = vi.fn((options: any) => options.success());
    const request = vi.fn((options: any) => {
      if (options.url.endsWith("/health")) options.success({ statusCode: 200, data: { deploymentMode: "test" } });
      else options.success({ statusCode: 204, data: "" });
    });
    const readdir = vi.fn((options: any) => options.success({ files: [
      "warm-letter-narration-letter-1-audio_123_x.wav", "warm-letter-narration-letter-2-audio_123_y.mp3",
      "warm-letter-narration-letter-1-child-audio_123_z.wav", "photo.jpg", "../warm-letter-narration-other.wav",
    ] }));
    vi.stubGlobal("wx", {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
      env: { USER_DATA_PATH: "wxfile://owned" }, getFileSystemManager: () => ({ unlink, readdir }), request,
    });
    return { storage, unlink, request, readdir };
  }

  it("deletes server first, removes only the target letter metadata and owned audio", async () => {
    const mocks = setup();
    const { realApi } = await import("../src/services/api");
    await expect(realApi.deleteLetter("letter-1")).resolves.toEqual({ localCleanupComplete: true });
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ url: "http://127.0.0.1:8787/v1/letters/letter-1", method: "DELETE", header: expect.objectContaining({ authorization: "Bearer session" }) }));
    expect(mocks.storage.get("warm_letter:test:real_letter_ids")).toEqual(["letter-2"]);
    expect(mocks.storage.get("warm_letter:test:real_intents")).toEqual({ "letter-2": { recipient: "爸爸" } });
    expect(mocks.storage.has("warm_letter:test:pending_generation")).toBe(false);
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "wxfile://owned/warm-letter-narration-letter-1-audio_123_x.wav" }));
  });

  it("does not clear any local data when remote deletion fails", async () => {
    const mocks = setup();
    mocks.request.mockImplementation((options: any) => {
      if (options.url.endsWith("/health")) options.success({ statusCode: 200, data: { deploymentMode: "test" } });
      else options.success({ statusCode: 503, data: { error: { code: "UNAVAILABLE", message: "请稍后重试" } } });
    });
    const original = [...mocks.storage.entries()];
    const { realApi } = await import("../src/services/api");
    await expect(realApi.deleteAccount()).rejects.toThrow("请稍后重试");
    expect([...mocks.storage.entries()]).toEqual(original);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("erases all warm-letter namespaces but preserves unrelated keys and original media", async () => {
    const mocks = setup();
    const { realApi } = await import("../src/services/api");
    await expect(realApi.deleteAccount()).resolves.toEqual({ localCleanupComplete: true });
    expect([...mocks.storage.entries()]).toEqual([["other_app:value", "keep"], ["warm_letter:test:account_deleted", true]]);
    expect(mocks.unlink).toHaveBeenCalledTimes(3);
    expect(mocks.unlink.mock.calls.every(([options]) => !options.filePath.includes("../") && !options.filePath.endsWith("photo.jpg"))).toBe(true);
    const previousCalls = mocks.request.mock.calls.length;
    await expect(realApi.listLetters()).resolves.toEqual([]);
    expect(mocks.request).toHaveBeenCalledTimes(previousCalls);
  });

  it("reports cloud erasure separately if local audio cleanup fails", async () => {
    const mocks = setup();
    mocks.readdir.mockImplementation((options: any) => options.fail({ errMsg: "private path" }));
    const { realApi } = await import("../src/services/api");
    await expect(realApi.deleteAccount()).resolves.toEqual({ localCleanupComplete: false });
    expect(mocks.storage.has("warm_letter:test:access_token")).toBe(false);
  });

  it("discards authenticated results that arrive after account erasure", async () => {
    const mocks = setup();
    let pendingMaterials: any;
    mocks.request.mockImplementation((options: any) => {
      if (options.url.endsWith("/health")) options.success({ statusCode: 200, data: { deploymentMode: "test" } });
      else if (options.url.endsWith("/materials")) pendingMaterials = options;
      else options.success({ statusCode: 204, data: "" });
    });
    const { realApi } = await import("../src/services/api");
    const pending = realApi.listMaterials().catch((error: unknown) => error);
    await vi.waitFor(() => expect(pendingMaterials).toBeDefined());
    await realApi.deleteAccount();
    pendingMaterials.success({ statusCode: 200, data: { materials: [] } });
    expect(await pending).toMatchObject({ message: "账号数据已清除，请重新打开首页" });
    expect(mocks.storage.has("warm_letter:test:access_token")).toBe(false);
  });
});
