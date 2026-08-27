import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { OpenAIResponsesProvider } from "../src/ai.js";
import { buildApp } from "../src/app.js";
import { loadApiRuntimeConfig } from "../src/runtime-config.js";
import { json } from "./helpers.js";

const signingKey = Buffer.alloc(32, 7).toString("base64url");
const demoEnvironment: NodeJS.ProcessEnv = {
  DEPLOYMENT_MODE: "demo",
  NODE_ENV: "development",
  AI_PROVIDER: "fake",
  AUTH_PROVIDER: "development",
  PUBLIC_BASE_URL: "http://127.0.0.1:8787",
  CORS_ORIGINS: "http://127.0.0.1:4173,http://localhost:4173",
  UPLOAD_DIR: "./uploads",
};

function competitionEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...demoEnvironment,
    DEPLOYMENT_MODE: "competition",
    NODE_ENV: "production",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "test-api-key-not-secret",
    OPENAI_MODEL: "test-model-not-secret",
    MEDIA_SIGNING_KEYS: signingKey,
    PUBLIC_BASE_URL: "https://api.evidence.example.test",
    CORS_ORIGINS: "https://reader.evidence.example.test",
    ...overrides,
  };
}

describe("API runtime configuration", () => {
  it("accepts explicit demo and test modes", () => {
    expect(loadApiRuntimeConfig(demoEnvironment)).toMatchObject({
      deploymentMode: "demo",
      nodeEnv: "development",
      aiProviderMode: "fake",
      authProviderMode: "development",
      port: 8787,
      host: "0.0.0.0",
      corsOrigins: ["http://127.0.0.1:4173", "http://localhost:4173"],
      publicBaseUrl: "http://127.0.0.1:8787",
    });
    expect(
      loadApiRuntimeConfig({
        ...demoEnvironment,
        DEPLOYMENT_MODE: "test",
        NODE_ENV: "test",
        AUTH_PROVIDER: "wechat",
      }),
    ).toMatchObject({
      deploymentMode: "test",
      nodeEnv: "test",
      authProviderMode: "wechat",
    });
  });

  it.each([
    [{ ...demoEnvironment, DEPLOYMENT_MODE: undefined }, "DEPLOYMENT_MODE is required"],
    [{ ...demoEnvironment, DEPLOYMENT_MODE: "prod" }, "DEPLOYMENT_MODE must be one of"],
    [{ ...demoEnvironment, NODE_ENV: undefined }, "NODE_ENV is required"],
    [{ ...demoEnvironment, NODE_ENV: "production" }, "NODE_ENV must be development"],
    [{ ...demoEnvironment, AI_PROVIDER: undefined }, "AI_PROVIDER is required"],
    [{ ...demoEnvironment, AI_PROVIDER: "fallback" }, "AI_PROVIDER must be fake or openai"],
    [{ ...demoEnvironment, AUTH_PROVIDER: undefined }, "AUTH_PROVIDER is required"],
    [
      { ...demoEnvironment, AUTH_PROVIDER: "fallback" },
      "AUTH_PROVIDER must be development or wechat",
    ],
    [{ ...demoEnvironment, PUBLIC_BASE_URL: undefined }, "PUBLIC_BASE_URL is required"],
    [{ ...demoEnvironment, PUBLIC_BASE_URL: "localhost:8787" }, "absolute HTTP(S)"],
    [{ ...demoEnvironment, PUBLIC_BASE_URL: "https://user:pass@example.test" }, "HTTP(S) origin"],
    [{ ...demoEnvironment, PUBLIC_BASE_URL: "https://example.test/prefix" }, "HTTP(S) origin"],
    [{ ...demoEnvironment, PUBLIC_BASE_URL: "https://example.test?mode=demo" }, "HTTP(S) origin"],
    [{ ...demoEnvironment, PUBLIC_BASE_URL: "https://example.test#demo" }, "HTTP(S) origin"],
    [{ ...demoEnvironment, CORS_ORIGINS: "https://reader.example.test/path" }, "Invalid CORS origin"],
    [{ ...demoEnvironment, UPLOAD_DIR: undefined }, "UPLOAD_DIR is required"],
  ])("fails closed for missing or invalid configuration", (environment, message) => {
    expect(() => loadApiRuntimeConfig(environment)).toThrow(message);
  });

  it("requires real AI credentials and stable media signing in competition mode", () => {
    expect(() =>
      loadApiRuntimeConfig(competitionEnvironment({ AI_PROVIDER: "fake" })),
    ).toThrow("DEPLOYMENT_MODE=competition requires AI_PROVIDER=openai");
    expect(() =>
      loadApiRuntimeConfig(competitionEnvironment({ OPENAI_API_KEY: undefined })),
    ).toThrow("OPENAI_API_KEY is required");
    expect(() =>
      loadApiRuntimeConfig(competitionEnvironment({ MEDIA_SIGNING_KEYS: undefined })),
    ).toThrow("MEDIA_SIGNING_KEYS is required in competition mode");

    expect(loadApiRuntimeConfig(competitionEnvironment())).toMatchObject({
      deploymentMode: "competition",
      nodeEnv: "production",
      aiProviderMode: "openai",
      authProviderMode: "development",
      publicBaseUrl: "https://api.evidence.example.test",
      corsOrigins: ["https://reader.evidence.example.test"],
    });
  });

  it.each([
    ["userinfo", "https://user:pass@api.evidence.example.test", "HTTP(S) origin"],
    ["path", "https://api.evidence.example.test/v1", "HTTP(S) origin"],
    ["query", "https://api.evidence.example.test?mode=competition", "HTTP(S) origin"],
    ["fragment", "https://api.evidence.example.test#competition", "HTTP(S) origin"],
    ["HTTP", "http://api.evidence.example.test", "must use HTTPS"],
    ["localhost", "https://localhost", "must not use localhost"],
    ["localhost trailing dot", "https://localhost.", "must not use localhost"],
    ["localhost subdomain", "https://sub.localhost", "must not use localhost"],
    ["IPv4 loopback", "https://127.0.0.1", "must not use localhost"],
    ["IPv4 loopback second address", "https://127.0.0.2", "must not use localhost"],
    ["IPv4 loopback upper boundary", "https://127.255.255.254", "must not use localhost"],
    ["IPv4 wildcard", "https://0.0.0.0", "must not use localhost"],
    ["IPv6 loopback", "https://[::1]", "must not use localhost"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]", "must not use localhost"],
    [
      "IPv4-mapped IPv6 loopback upper boundary",
      "https://[::ffff:127.255.255.254]",
      "must not use localhost",
    ],
    ["IPv6 wildcard", "https://[::]", "must not use localhost"],
    ["wildcard hostname", "https://*.evidence.example.test", "must not use localhost"],
  ])("rejects unsafe competition PUBLIC_BASE_URL: %s", (_case, value, message) => {
    expect(() =>
      loadApiRuntimeConfig(competitionEnvironment({ PUBLIC_BASE_URL: value })),
    ).toThrow(message);
  });

  it.each([
    ["userinfo", "https://user:pass@reader.evidence.example.test", "Invalid CORS origin"],
    ["path", "https://reader.evidence.example.test/path", "Invalid CORS origin"],
    ["query", "https://reader.evidence.example.test?mode=competition", "Invalid CORS origin"],
    ["fragment", "https://reader.evidence.example.test#competition", "Invalid CORS origin"],
    ["HTTP", "http://reader.evidence.example.test", "must use HTTPS"],
    ["localhost", "https://localhost", "must not use localhost"],
    ["localhost trailing dot", "https://localhost.", "must not use localhost"],
    ["localhost subdomain", "https://sub.localhost", "must not use localhost"],
    ["IPv4 loopback", "https://127.0.0.1", "must not use localhost"],
    ["IPv4 loopback second address", "https://127.0.0.2", "must not use localhost"],
    ["IPv4 loopback upper boundary", "https://127.255.255.254", "must not use localhost"],
    ["IPv4 wildcard", "https://0.0.0.0", "must not use localhost"],
    ["IPv6 loopback", "https://[::1]", "must not use localhost"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]", "must not use localhost"],
    [
      "IPv4-mapped IPv6 loopback upper boundary",
      "https://[::ffff:127.255.255.254]",
      "must not use localhost",
    ],
    ["IPv6 wildcard", "https://[::]", "must not use localhost"],
    ["wildcard hostname", "https://*.evidence.example.test", "must not use localhost"],
  ])("rejects unsafe competition CORS_ORIGINS: %s", (_case, value, message) => {
    expect(() =>
      loadApiRuntimeConfig(competitionEnvironment({ CORS_ORIGINS: value })),
    ).toThrow(message);
  });

  it("rejects the entire CORS list when one origin is unsafe", () => {
    expect(() =>
      loadApiRuntimeConfig(
        competitionEnvironment({
          CORS_ORIGINS:
            "https://reader.evidence.example.test,https://127.255.255.254,https://family.evidence.example.test",
        }),
      ),
    ).toThrow("must not use localhost");
  });

  it("blocks production while development adapters remain in the composition root", () => {
    expect(() =>
      loadApiRuntimeConfig(
        competitionEnvironment({ DEPLOYMENT_MODE: "production" }),
      ),
    ).toThrow(/MemoryRepository.*FileSystemObjectStorage/);
    expect(() =>
      loadApiRuntimeConfig(
        competitionEnvironment({
          DEPLOYMENT_MODE: "production",
          AI_PROVIDER: "fake",
          OPENAI_API_KEY: undefined,
          OPENAI_MODEL: undefined,
        }),
      ),
    ).toThrow(/FakeAIProvider/);
  });
});

describe("API deployment disclosure", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("marks competition evidence mode as non-production and discloses current capabilities", async () => {
    app = buildApp({
      deploymentMode: "competition",
      aiProvider: new OpenAIResponsesProvider({
        apiKey: "health-test-api-key",
        model: "health-test-model",
      }),
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      status: "ok",
      service: "warm-letter-api",
      deploymentMode: "competition",
      nonProduction: true,
      capabilities: {
        ai: "openai",
        authentication: "development",
        authenticationReady: false,
        repository: "memory",
        objectStorage: "local-filesystem",
        replySafety: "deterministic",
      },
    });
    expect(response.body).not.toContain("health-test-api-key");
    expect(response.body).not.toContain("health-test-model");

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/wx-login",
      payload: { code: "must-not-be-hashed" },
    });
    expect(login.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(login).error.code).toBe(
      "AUTH_PROVIDER_UNAVAILABLE",
    );
    expect(login.body).not.toContain("dev.");
  });

  it("reports an explicitly selected but unavailable Wechat auth provider", async () => {
    app = buildApp({ deploymentMode: "test", authProviderMode: "wechat" });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(json<{ capabilities: Record<string, unknown> }>(health).capabilities).toMatchObject({
      authentication: "wechat",
      authenticationReady: false,
    });

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/wx-login",
      payload: { code: "not-sent-to-wechat" },
    });
    expect(login.statusCode).toBe(503);
    expect(json<{ error: { code: string; message: string } }>(login).error).toEqual({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      message: "微信 code2Session 鉴权适配器尚未实现",
    });
    expect(login.body).not.toContain("token");
  });

  it("also blocks direct production app construction", () => {
    expect(() => buildApp({ deploymentMode: "production" })).toThrow(
      /development wx-login authentication.*MemoryRepository/,
    );
  });
});
