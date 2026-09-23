import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("packaged production configuration", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it.each(["develop", "trial", "release"])("keeps %s on the same real API with demo disabled", async (envVersion) => {
    vi.stubGlobal("wx", { getAccountInfoSync: () => ({ miniProgram: { appId: "wx281b5275e4a1601f", envVersion } }) });
    const { environment } = await import("../src/config/env");
    expect(environment).toMatchObject({ apiMode: "real", deploymentMode: "production", apiBaseUrl: "https://api.warmjiashu.xyz/v1", demoEnabled: false, storageNamespace: "warm_letter:production" });
  });

  it.each([() => { throw new Error("read failed"); }, () => null, () => ({})])("never silently falls back to mock when account API fails", async (getAccountInfoSync) => {
    vi.stubGlobal("wx", { getAccountInfoSync });
    await expect(import("../src/config/env")).rejects.toThrow("暂时无法读取小程序环境");
  });
});
