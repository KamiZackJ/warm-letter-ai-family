import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LetterDraft } from "../src/types/domain";

const draft: LetterDraft = {
  title: "近况", salutation: "家人：", paragraphs: [{ id: "p", text: "今天很好。", sourceRefs: [] }],
  closing: "祝安", signature: "我",
};

describe("native login and narration file recovery", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function setup(hasToken = false) {
    const storage = new Map<string, unknown>();
    if (hasToken) storage.set("warm_letter:test:access_token", "test-token");
    const login = vi.fn();
    const writeFile = vi.fn();
    const unlink = vi.fn();
    const request = vi.fn((options: any) => {
      if (options.url.endsWith("/health")) options.success({ statusCode: 200, data: { deploymentMode: "test" } });
      else if (options.url.endsWith("/auth/wx-login")) options.success({ statusCode: 200, data: { token: "fresh-token" } });
      else if (options.url.endsWith("/materials")) options.success({ statusCode: 200, data: { materials: [] } });
      else if (options.url.endsWith("/speech")) options.success({ statusCode: 200, data: new Uint8Array([1, 2]).buffer, header: { "content-type": "audio/wav" } });
      else throw new Error("Unexpected test request");
    });
    vi.stubGlobal("wx", {
      env: { USER_DATA_PATH: "wxfile://test-data" },
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      getFileSystemManager: () => ({ writeFile, unlink }), login, request,
    });
    return { storage, login, writeFile, unlink, request };
  }

  it("releases a hung shared login and ignores its late code before allowing a new login", async () => {
    const mocks = setup();
    const { realApi } = await import("../src/services/api");
    const result = realApi.listMaterials().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toMatchObject({ code: "LOGIN_TIMEOUT", retryable: true });
    expect(mocks.login).toHaveBeenCalledTimes(1);
    mocks.login.mock.calls[0]![0].success({ code: "late-old-code" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.login.mockImplementation((options: any) => options.success({ code: "new-code" }));
    await expect(realApi.listMaterials()).resolves.toEqual([]);
    expect(mocks.login).toHaveBeenCalledTimes(2);
    expect(mocks.storage.get("warm_letter:test:access_token")).toBe("fresh-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a hung narration file write and cleans up a late completion", async () => {
    const mocks = setup(true);
    const { realApi } = await import("../src/services/api");
    const result = realApi.generateNarration("letter-1", draft, "Cherry", "warm").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toMatchObject({ code: "FILE_WRITE_TIMEOUT", retryable: true });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const options = mocks.writeFile.mock.calls[0]![0];
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: options.filePath }));
    options.success();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a completed narration file for the player and clears the write timer", async () => {
    const mocks = setup(true);
    mocks.writeFile.mockImplementation((options: any) => options.success());
    const { realApi } = await import("../src/services/api");
    await expect(realApi.generateNarration("letter-1", draft, "Cherry", "warm")).resolves.toMatchObject({
      filePath: expect.stringContaining("warm-letter-narration-letter-1-"), contentType: "audio/wav",
    });
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up failed native writes without exposing their private file paths", async () => {
    const mocks = setup(true);
    const { realApi } = await import("../src/services/api");
    mocks.writeFile.mockImplementationOnce((options: any) => {
      options.fail({ errMsg: `writeFile:fail permission denied ${options.filePath}` });
    });
    const callbackFailure = await realApi.generateNarration("letter-1", draft, "Cherry", "warm")
      .catch((error: unknown) => error);
    expect(callbackFailure).toMatchObject({ code: "FILE_WRITE_FAILED", retryable: true });
    expect((callbackFailure as Error).message).not.toContain("wxfile://");
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    mocks.writeFile.mockImplementationOnce(() => { throw new Error("private wxfile://native-path"); });
    const thrownFailure = await realApi.generateNarration("letter-1", draft, "Cherry", "warm")
      .catch((error: unknown) => error);
    expect(thrownFailure).toMatchObject({ code: "FILE_WRITE_FAILED", retryable: true });
    expect((thrownFailure as Error).message).not.toContain("wxfile://");
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
