import { describe, expect, it } from "vitest";
import {
  assertRemoteDeploymentMode,
  resolveWebRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config";

const base = {
  appEnv: "test",
  expectedMode: "test",
  demoEnabled: "false",
  apiBaseUrl: "http://127.0.0.1:8787/v1",
};

describe("resolveWebRuntimeConfig", () => {
  it("resolves an explicit test profile", () => {
    expect(resolveWebRuntimeConfig(base)).toMatchObject({
      deploymentMode: "test",
      demoEnabled: false,
      demoCase: "synthetic",
      apiBaseUrl: "http://127.0.0.1:8787/v1",
      healthUrl: "http://127.0.0.1:8787/health",
    });
  });

  it("resolves the controlled teammate-material demo profile", () => {
    expect(
      resolveWebRuntimeConfig({
        appEnv: "demo",
        expectedMode: "demo",
        demoEnabled: "true",
        demoCase: "case-001",
        apiBaseUrl: "http://127.0.0.1:8787/v1",
      }),
    ).toMatchObject({
      deploymentMode: "demo",
      demoEnabled: true,
      demoCase: "case-001",
      environmentLabel: "受控演示环境",
      environmentDetail: "队友 CASE-001 固定审核稿 / 受控本地媒体",
    });
  });

  it("labels the default demo as synthetic and without teammate media", () => {
    const config = resolveWebRuntimeConfig({
      appEnv: "demo",
      expectedMode: "demo",
      demoEnabled: "true",
      demoCase: "synthetic",
      apiBaseUrl: "http://127.0.0.1:8787/v1",
    });

    expect(config.environmentLabel).toBe("演示环境");
    expect(config.environmentDetail).toContain("未加载队友真实媒体");
  });

  it.each([
    [{ ...base, appEnv: undefined }, "VITE_APP_ENV"],
    [{ ...base, appEnv: "staging" }, "VITE_APP_ENV"],
    [{ ...base, demoEnabled: undefined }, "VITE_DEMO_ENABLED"],
    [{ ...base, demoEnabled: "true" }, "只有 demo 环境"],
    [{ ...base, demoCase: "unknown" }, "VITE_DEMO_CASE"],
    [{ ...base, expectedMode: "production" }, "不一致"],
    [{ ...base, apiBaseUrl: "" }, "VITE_API_BASE_URL"],
  ])("rejects an invalid configuration", (input, message) => {
    expect(() => resolveWebRuntimeConfig(input)).toThrow(message);
  });

  for (const appEnv of ["competition", "production"] as const) {
    it.each([
      "http://api.example.com/v1",
      "https://localhost:8787/v1",
      "https://localhost.:8787/v1",
      "https://reader.localhost/v1",
      "https://127.0.0.1:8787/v1",
      "https://127.0.0.2:8787/v1",
      "https://127.255.255.254:8787/v1",
      "https://0.0.0.0:8787/v1",
      "https://[::1]:8787/v1",
      "https://[::]:8787/v1",
      "https://[::ffff:127.0.0.2]:8787/v1",
      "https://*.example.com/v1",
    ])(`rejects an unsafe ${appEnv} API URL: %s`, (apiBaseUrl) => {
      expect(() =>
        resolveWebRuntimeConfig({
          appEnv,
          expectedMode: appEnv,
          demoEnabled: "false",
          apiBaseUrl,
        }),
      ).toThrow(RuntimeConfigurationError);
    });
  }

  it("accepts a non-loopback HTTPS competition endpoint", () => {
    expect(
      resolveWebRuntimeConfig({
        appEnv: "competition",
        expectedMode: "competition",
        demoEnabled: "false",
        apiBaseUrl: "https://evidence.example.com/v1/",
      }),
    ).toMatchObject({
      deploymentMode: "competition",
      apiBaseUrl: "https://evidence.example.com/v1",
    });
  });
});

describe("assertRemoteDeploymentMode", () => {
  it("accepts a matching server mode", () => {
    expect(() => assertRemoteDeploymentMode("competition", "competition")).not.toThrow();
  });

  it("rejects a cross-environment server", () => {
    expect(() => assertRemoteDeploymentMode("production", "demo")).toThrow("不一致");
  });
});
