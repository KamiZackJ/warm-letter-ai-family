import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env", () => ({ environment: { apiMode: "real" } }));

describe("WeChat privacy consent", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("shares concurrent consent and allows retry after refusal", async () => {
    const authorize = vi.fn();
    vi.stubGlobal("wx", { requirePrivacyAuthorize: authorize });
    const { ensurePrivacyConsent } = await import("../src/services/privacy");
    const first = ensurePrivacyConsent().catch((error: unknown) => error);
    const second = ensurePrivacyConsent().catch((error: unknown) => error);
    expect(authorize).toHaveBeenCalledOnce();
    authorize.mock.calls[0]![0].fail({ errMsg: "private-native-data" });
    expect(await first).toMatchObject({ message: expect.stringContaining("内容没有上传") });
    expect(await second).toMatchObject({ message: expect.stringContaining("内容没有上传") });
    const retry = ensurePrivacyConsent();
    authorize.mock.calls[1]![0].success();
    await expect(retry).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not proceed if privacy APIs are unavailable", async () => {
    vi.stubGlobal("wx", {});
    const { ensurePrivacyConsent } = await import("../src/services/privacy");
    await expect(ensurePrivacyConsent()).rejects.toThrow("请更新微信");
  });

  it("times out without accepting a late consent result", async () => {
    const authorize = vi.fn();
    vi.stubGlobal("wx", { requirePrivacyAuthorize: authorize });
    const { ensurePrivacyConsent } = await import("../src/services/privacy");
    const result = ensurePrivacyConsent().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("尚未完成") });
    authorize.mock.calls[0]![0].success();
    expect(vi.getTimerCount()).toBe(0);
  });
});
