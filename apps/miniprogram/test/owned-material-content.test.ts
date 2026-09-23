import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "../src/types/domain";
import type { MaterialDownloadControl } from "../src/services/http-client";

const photo: Material = { id: "owned-photo", type: "photo", name: "生活照片", createdAt: "2026-09-23T00:00:00Z" };

describe("authenticated owner photo recovery", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function setup() {
    const storage = new Map<string, unknown>([["warm_letter:production:access_token", "test-session"]]);
    const unlink = vi.fn((options: any) => options.success?.());
    const abort = vi.fn();
    const downloadFile = vi.fn((options: any) => {
      options.success({ statusCode: 200, tempFilePath: "wxfile://temporary/owned-photo.jpg" });
      return { abort };
    });
    const login = vi.fn((options: any) => options.success({ code: "new-login-code" }));
    const request = vi.fn((options: any) => {
      if (options.url.endsWith("/health")) options.success({ statusCode: 200, data: { deploymentMode: "production" } });
      else if (options.url.endsWith("/auth/wx-login")) options.success({ statusCode: 200, data: { token: "refreshed-session" } });
      else if (options.url.endsWith("/account") && options.method === "DELETE") options.success({ statusCode: 204, data: undefined });
      else throw new Error("Unexpected test request");
    });
    vi.stubGlobal("wx", {
      getAccountInfoSync: () => ({ miniProgram: { appId: "wx281b5275e4a1601f", envVersion: "trial" } }),
      requirePrivacyAuthorize: (options: any) => options.success(),
      env: { USER_DATA_PATH: "wxfile://owned" },
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
      getFileSystemManager: () => ({ unlink, readdir: (options: any) => options.success({ files: [] }) }),
      request, login, downloadFile,
    });
    return { storage, unlink, abort, downloadFile, login, request };
  }

  it("downloads only from the fixed API with a bearer header and no credential in the URL", async () => {
    const mocks = setup();
    const { realApi } = await import("../src/services/api");
    await expect(realApi.getMaterialContent(photo, { cancelled: false })).resolves.toBe("wxfile://temporary/owned-photo.jpg");
    expect(mocks.downloadFile).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.warmjiashu.xyz/v1/materials/owned-photo/content",
      header: { authorization: "Bearer test-session" }, timeout: 12_000,
    }));
    expect(mocks.storage.has("warm_letter:production:real_media_paths")).toBe(false);
    expect(mocks.unlink).not.toHaveBeenCalled();
    await expect(realApi.getMaterialContent({ ...photo, type: "voice" }, { cancelled: false })).rejects.toThrow("只能预览");
    expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("cleans the 401 response file and retries once with a fresh authenticated session", async () => {
    const mocks = setup();
    mocks.downloadFile.mockImplementationOnce((options) => {
      options.success({ statusCode: 401, tempFilePath: "wxfile://temporary/unauthorized.json" });
      return { abort: mocks.abort };
    });
    const { realApi } = await import("../src/services/api");
    await expect(realApi.getMaterialContent(photo, { cancelled: false })).resolves.toContain("owned-photo.jpg");
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
    expect(mocks.downloadFile.mock.calls[1]![0].header).toEqual({ authorization: "Bearer refreshed-session" });
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "wxfile://temporary/unauthorized.json" }));
  });

  it("does not bypass a non-owner response or expose the downloaded error file", async () => {
    const mocks = setup();
    mocks.downloadFile.mockImplementation((options) => {
      options.success({ statusCode: 404, tempFilePath: "wxfile://temporary/not-owned.json" });
      return { abort: mocks.abort };
    });
    const { realApi } = await import("../src/services/api");
    await expect(realApi.getMaterialContent(photo, { cancelled: false })).rejects.toMatchObject({ statusCode: 404, code: "MATERIAL_DOWNLOAD_FAILED" });
    expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "wxfile://temporary/not-owned.json" }));
  });

  it("normalizes native failures without leaking private paths", async () => {
    const mocks = setup();
    mocks.downloadFile.mockImplementation((options) => {
      options.fail({ errMsg: "downloadFile:fail private wxfile://path" });
      return { abort: mocks.abort };
    });
    const { realApi } = await import("../src/services/api");
    const error = await realApi.getMaterialContent(photo, { cancelled: false }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "NETWORK_ERROR" });
    expect((error as Error).message).not.toContain("wxfile:");
  });

  it("aborts on timeout and cleans any later successful native download", async () => {
    vi.useFakeTimers();
    const mocks = setup();
    mocks.downloadFile.mockImplementation(() => ({ abort: mocks.abort }));
    const { realApi } = await import("../src/services/api");
    const pending = realApi.getMaterialContent(photo, { cancelled: false }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    mocks.downloadFile.mock.calls[0]![0].success({ statusCode: 200, tempFilePath: "wxfile://temporary/late-timeout.jpg" });
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "wxfile://temporary/late-timeout.jpg" }));
  });

  it("cancels on page exit even when abort supplies no callback, then cleans late success", async () => {
    const mocks = setup();
    mocks.downloadFile.mockImplementation(() => ({ abort: mocks.abort }));
    const { realApi } = await import("../src/services/api");
    const control: MaterialDownloadControl = { cancelled: false };
    const pending = realApi.getMaterialContent(photo, control).catch((error: unknown) => error);
    await vi.waitFor(() => expect(control.abort).toBeTypeOf("function"));
    control.cancelled = true;
    control.abort!();
    expect(await pending).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    mocks.downloadFile.mock.calls[0]![0].success({ statusCode: 200, tempFilePath: "wxfile://temporary/late-exit.jpg" });
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "wxfile://temporary/late-exit.jpg" }));
  });

  it("removes a photo arriving after account deletion instead of restoring local data", async () => {
    const mocks = setup();
    mocks.downloadFile.mockImplementation(() => ({ abort: mocks.abort }));
    const { realApi } = await import("../src/services/api");
    const pending = realApi.getMaterialContent(photo, { cancelled: false }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(1));
    await realApi.deleteAccount();
    mocks.downloadFile.mock.calls[0]![0].success({ statusCode: 200, tempFilePath: "wxfile://temporary/deleted-account.jpg" });
    expect(await pending).toMatchObject({ message: "账号数据已清除，请重新打开首页" });
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "wxfile://temporary/deleted-account.jpg" }));
    expect(mocks.storage.has("warm_letter:production:access_token")).toBe(false);
  });
});
