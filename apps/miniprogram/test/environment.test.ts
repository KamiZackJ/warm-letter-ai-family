import { describe, expect, it } from "vitest";
import {
  assertRemoteDeploymentMode,
  resolveDemoRequest,
  resolveMiniProgramEnvironment,
} from "../src/config/runtime-environment";

const testProfile = {
  deploymentMode: "test",
  apiMode: "mock",
  apiBaseUrl: "http://127.0.0.1:8787/v1",
  requestTimeoutMs: 12_000,
  accountEnvironment: "develop",
  appId: "unit-test",
};

describe("resolveMiniProgramEnvironment", () => {
  it("allows mock API only in the explicit test profile", () => {
    expect(resolveMiniProgramEnvironment(testProfile)).toMatchObject({
      deploymentMode: "test",
      apiMode: "mock",
      apiBaseUrl: "http://127.0.0.1:8787/v1",
      healthUrl: "http://127.0.0.1:8787/health",
      storageNamespace: "warm_letter:test",
      demoEnabled: false,
    });
  });

  it("does not require the browser URL constructor used outside WeChat", () => {
    const savedUrl = globalThis.URL;
    try {
      Object.defineProperty(globalThis, "URL", {
        configurable: true,
        value: undefined,
        writable: true,
      });
      expect(
        resolveMiniProgramEnvironment({
          ...testProfile,
          deploymentMode: "demo",
          apiMode: "real",
          apiBaseUrl: "https://api.warmjiashu.xyz/v1?ignored=1#ignored",
        }),
      ).toMatchObject({
        apiBaseUrl: "https://api.warmjiashu.xyz/v1",
        healthUrl: "https://api.warmjiashu.xyz/health",
      });
    } finally {
      Object.defineProperty(globalThis, "URL", {
        configurable: true,
        value: savedUrl,
        writable: true,
      });
    }
  });

  it.each([
    "ftp://api.example.com/v1",
    "https://user:secret@api.example.com/v1",
    "https://api.example.com:70000/v1",
    "https://api..example.com/v1",
  ])("rejects an invalid or unsafe absolute API URL: %s", (apiBaseUrl) => {
    expect(() =>
      resolveMiniProgramEnvironment({ ...testProfile, apiBaseUrl }),
    ).toThrow(/apiBaseUrl/);
  });

  it.each(["demo", "competition", "production"])(
    "rejects mock API in %s",
    (deploymentMode) => {
      expect(() =>
        resolveMiniProgramEnvironment({ ...testProfile, deploymentMode }),
      ).toThrow("mock API 只允许");
    },
  );

  it.each([
    ["demo", "trial", "wx-demo-trial"],
    ["competition", "trial", "wx-competition"],
    ["production", "release", "wx-production"],
  ] as const)(
    "rejects unsafe API endpoints in %s",
    (deploymentMode, accountEnvironment, appId) => {
      for (const apiBaseUrl of [
        "http://api.example.com/v1",
        "https://localhost/v1",
        "https://localhost./v1",
        "https://preview.localhost/v1",
        "https://127.0.0.1:8787/v1",
        "https://127.42.17.9/v1",
        "https://127.1/v1",
        "https://2130706433/v1",
        "https://0x7f000001/v1",
        "https://0177.0.0.1/v1",
        "https://0.0.0.0/v1",
        "https://[::1]/v1",
        "https://[::ffff:127.0.0.1]/v1",
        "https://[::ffff:0.0.0.0]/v1",
        "https://[::]/v1",
        "https://[0:0:0:0:0:0:0:1]/v1",
        "https://[0:0:0:0:0:0:0:0]/v1",
        "https://[0:0:0:0:0:ffff:7f00:1]/v1",
        "https://[::ffff:7f00:1]/v1",
        "https://999.999.999.999/v1",
        "https://*.example.com/v1",
      ]) {
        const environmentName = deploymentMode === "demo" ? "demo 体验版" : deploymentMode;
        expect(() =>
          resolveMiniProgramEnvironment({
            ...testProfile,
            deploymentMode,
            apiMode: "real",
            apiBaseUrl,
            accountEnvironment,
            appId,
          }),
        ).toThrow(
          apiBaseUrl.startsWith("http:")
            ? `${environmentName} 环境必须使用 HTTPS API`
            : `${environmentName} 环境禁止使用本机、回环或通配 API 地址`,
        );
      }
    },
  );

  it.each([
    ["demo", "trial", "https://api.warmjiashu.xyz/v1"],
    ["competition", "trial", "https://evidence.example.com/v1"],
    ["production", "release", "https://api.example.com/v1"],
  ] as const)(
    "requires a real AppID in %s",
    (deploymentMode, accountEnvironment, apiBaseUrl) => {
      for (const appId of ["", "   ", "touristappid", "TOURISTAPPID"]) {
        expect(() =>
          resolveMiniProgramEnvironment({
            ...testProfile,
            deploymentMode,
            apiMode: "real",
            apiBaseUrl,
            accountEnvironment,
            appId,
          }),
        ).toThrow(
          `${deploymentMode === "demo" ? "demo 体验版" : deploymentMode} 环境必须配置真实微信 AppID`,
        );
      }
    },
  );

  it("requires the release account environment for production", () => {
    expect(() =>
      resolveMiniProgramEnvironment({
        ...testProfile,
        deploymentMode: "production",
        apiMode: "real",
        apiBaseUrl: "https://api.example.com/v1",
        accountEnvironment: "develop",
        appId: "wx-production",
      }),
    ).toThrow("production 环境必须使用微信 release 版本");
  });

  it("allows the non-production demo API in develop and trial, but never release", () => {
    for (const accountEnvironment of ["develop", "trial"] as const) {
      expect(
        resolveMiniProgramEnvironment({
          ...testProfile,
          deploymentMode: "demo",
          apiMode: "real",
          apiBaseUrl: "https://api.warmjiashu.xyz/v1",
          accountEnvironment,
          appId: "wx-demo",
        }),
      ).toMatchObject({ deploymentMode: "demo", accountEnvironment });
    }

    expect(() =>
      resolveMiniProgramEnvironment({
        ...testProfile,
        deploymentMode: "demo",
        apiMode: "real",
        apiBaseUrl: "https://api.warmjiashu.xyz/v1",
        accountEnvironment: "release",
        appId: "wx-demo",
      }),
    ).toThrow("demo 环境只允许微信 develop 或 trial 版本");
  });

  it.each([
    ["competition", "trial", "https://evidence.example.com/v1", "wx-evidence"],
    ["production", "release", "https://api.example.com/v1", "wx-production"],
  ] as const)(
    "accepts a valid real profile in %s",
    (deploymentMode, accountEnvironment, apiBaseUrl, appId) => {
      expect(
        resolveMiniProgramEnvironment({
          ...testProfile,
          deploymentMode,
          apiMode: "real",
          apiBaseUrl,
          accountEnvironment,
          appId,
        }),
      ).toMatchObject({
        deploymentMode,
        accountEnvironment,
        appId,
      });
    },
  );
});

describe("demo routing and server handshake", () => {
  it("rejects demo query routing outside the demo profile", () => {
    expect(() => resolveDemoRequest("1", false)).toThrow("禁止使用演示入口");
  });

  it("allows demo query routing only when the build enables it", () => {
    expect(resolveDemoRequest("1", true)).toBe(true);
    expect(resolveDemoRequest(undefined, true)).toBe(false);
  });

  it("rejects a server from another environment", () => {
    expect(() => assertRemoteDeploymentMode("competition", "demo")).toThrow("不一致");
  });
});
