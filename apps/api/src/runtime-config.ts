import { isIP } from "node:net";
import { resolve } from "node:path";
import type { PublicRateLimitConfig } from "./public-rate-limit.js";

export const DEPLOYMENT_MODES = ["demo", "test", "competition", "production"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];
export type AIProviderMode = "fake" | "openai";
export type AuthProviderMode = "development" | "wechat";

export interface ApiRuntimeConfig {
  deploymentMode: DeploymentMode;
  nodeEnv: "development" | "test" | "production";
  aiProviderMode: AIProviderMode;
  authProviderMode: AuthProviderMode;
  port: number;
  host: string;
  corsOrigins: string[];
  publicBaseUrl: string;
  uploadDirectory: string;
  maxMediaUploadBytes?: number;
  shareTokenTtlMs: number;
  mediaTokenTtlMs: number;
  mediaSigningKeys?: Buffer[];
  publicRateLimits: PublicRateLimitConfig;
  replySafetyTimeoutMs: number;
}

const expectedNodeEnvironments: Record<
  DeploymentMode,
  ApiRuntimeConfig["nodeEnv"]
> = {
  demo: "development",
  test: "test",
  competition: "production",
  production: "production",
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function deploymentModeFromEnv(env: NodeJS.ProcessEnv): DeploymentMode {
  const value = requiredEnv(env, "DEPLOYMENT_MODE");
  if (!DEPLOYMENT_MODES.includes(value as DeploymentMode)) {
    throw new Error(`DEPLOYMENT_MODE must be one of: ${DEPLOYMENT_MODES.join(", ")}`);
  }
  return value as DeploymentMode;
}

function nodeEnvironmentFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentMode: DeploymentMode,
): ApiRuntimeConfig["nodeEnv"] {
  const value = requiredEnv(env, "NODE_ENV");
  const expected = expectedNodeEnvironments[deploymentMode];
  if (value !== expected) {
    throw new Error(`NODE_ENV must be ${expected} when DEPLOYMENT_MODE=${deploymentMode}`);
  }
  return value;
}

function aiProviderModeFromEnv(env: NodeJS.ProcessEnv): AIProviderMode {
  const value = requiredEnv(env, "AI_PROVIDER").toLowerCase();
  if (value !== "fake" && value !== "openai") {
    throw new Error("AI_PROVIDER must be fake or openai");
  }
  return value;
}

function authProviderModeFromEnv(env: NodeJS.ProcessEnv): AuthProviderMode {
  const value = requiredEnv(env, "AUTH_PROVIDER").toLowerCase();
  if (value !== "development" && value !== "wechat") {
    throw new Error("AUTH_PROVIDER must be development or wechat");
  }
  return value;
}

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum = 1,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function mappedIpv4FromIpv6(hostname: string): number[] | undefined {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const groups = hostname.slice("::ffff:".length).split(":");
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isLoopbackOrWildcardHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!hostname || hostname.includes("*") || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const octets = hostname.split(".").map(Number);
    return octets[0] === 127 || octets.every((octet) => octet === 0);
  }
  if (ipVersion === 6) {
    if (hostname === "::" || hostname === "::1") return true;
    const mappedIpv4 = mappedIpv4FromIpv6(hostname);
    return Boolean(
      mappedIpv4 &&
        (mappedIpv4[0] === 127 || mappedIpv4.every((octet) => octet === 0)),
    );
  }
  return false;
}

function assertCompetitionOrigin(
  url: URL,
  field: string,
  deploymentMode: DeploymentMode,
): void {
  if (deploymentMode !== "competition" && deploymentMode !== "production") return;
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use HTTPS in ${deploymentMode} mode`);
  }
  if (isLoopbackOrWildcardHostname(url.hostname)) {
    throw new Error(
      `${field} must not use localhost, loopback, or wildcard hosts in ${deploymentMode} mode`,
    );
  }
}

function publicBaseUrlFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentMode: DeploymentMode,
): string {
  const value = requiredEnv(env, "PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PUBLIC_BASE_URL must be an absolute HTTP(S) origin");
  }
  assertCompetitionOrigin(url, "PUBLIC_BASE_URL", deploymentMode);
  return url.origin;
}

function corsOriginsFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentMode: DeploymentMode,
): string[] {
  const values = requiredEnv(env, "CORS_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error("CORS_ORIGINS must contain at least one origin");
  }
  return values.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid CORS origin");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid CORS origin");
    }
    assertCompetitionOrigin(url, "CORS_ORIGINS", deploymentMode);
    return url.origin;
  });
}

function mediaSigningKeysFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentMode: DeploymentMode,
): Buffer[] | undefined {
  const raw = env.MEDIA_SIGNING_KEYS?.trim();
  if (!raw) {
    if (deploymentMode === "competition" || deploymentMode === "production") {
      throw new Error(`MEDIA_SIGNING_KEYS is required in ${deploymentMode} mode`);
    }
    return undefined;
  }
  const encodedKeys = raw.split(",").map((value) => value.trim());
  if (encodedKeys.some((value) => !/^[A-Za-z0-9_-]+$/.test(value))) {
    throw new Error("MEDIA_SIGNING_KEYS must contain canonical base64url values");
  }
  const keys = encodedKeys.map((value) => Buffer.from(value, "base64url"));
  if (
    keys.some(
      (key, index) => key.length < 32 || key.toString("base64url") !== encodedKeys[index],
    )
  ) {
    throw new Error("Each MEDIA_SIGNING_KEYS entry must decode to at least 32 bytes");
  }
  return keys;
}

export function assertApiDeploymentSupported(
  deploymentMode: DeploymentMode,
  aiProviderMode: AIProviderMode | "custom",
  authProviderMode: AuthProviderMode = "development",
): void {
  if (deploymentMode === "competition" && aiProviderMode !== "openai") {
    throw new Error("DEPLOYMENT_MODE=competition requires AI_PROVIDER=openai");
  }
  if (deploymentMode !== "production") return;

  const blockers = ["MemoryRepository", "FileSystemObjectStorage", "DeterministicReplySafetyPolicy"];
  blockers.unshift(
    authProviderMode === "development"
      ? "development wx-login authentication"
      : "Wechat code2Session authentication adapter",
  );
  if (aiProviderMode === "fake") blockers.push("FakeAIProvider");
  throw new Error(
    `DEPLOYMENT_MODE=production is unavailable while these adapters are active: ${blockers.join(", ")}`,
  );
}

export function loadApiRuntimeConfig(env: NodeJS.ProcessEnv): ApiRuntimeConfig {
  const deploymentMode = deploymentModeFromEnv(env);
  const nodeEnv = nodeEnvironmentFromEnv(env, deploymentMode);
  const aiProviderMode = aiProviderModeFromEnv(env);
  const authProviderMode = authProviderModeFromEnv(env);
  assertApiDeploymentSupported(deploymentMode, aiProviderMode, authProviderMode);

  if (aiProviderMode === "openai") {
    requiredEnv(env, "OPENAI_API_KEY");
    requiredEnv(env, "OPENAI_MODEL");
  }

  const publicBaseUrl = publicBaseUrlFromEnv(env, deploymentMode);
  const corsOrigins = corsOriginsFromEnv(env, deploymentMode);
  const uploadDirectory = resolve(requiredEnv(env, "UPLOAD_DIR"));
  const mediaSigningKeys = mediaSigningKeysFromEnv(env, deploymentMode);
  const shareTokenTtlMs =
    integerFromEnv(env, "SHARE_TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60, 300) * 1000;
  const mediaTokenTtlMs = integerFromEnv(env, "MEDIA_TOKEN_TTL_SECONDS", 5 * 60, 30) * 1000;
  if (mediaTokenTtlMs >= shareTokenTtlMs) {
    throw new Error("MEDIA_TOKEN_TTL_SECONDS must be shorter than SHARE_TOKEN_TTL_SECONDS");
  }

  return {
    deploymentMode,
    nodeEnv,
    aiProviderMode,
    authProviderMode,
    port: integerFromEnv(env, "PORT", 8787, 1, 65_535),
    host: env.HOST?.trim() || "0.0.0.0",
    corsOrigins,
    publicBaseUrl,
    uploadDirectory,
    maxMediaUploadBytes: optionalIntegerFromEnv(env, "MAX_MEDIA_UPLOAD_BYTES"),
    shareTokenTtlMs,
    mediaTokenTtlMs,
    mediaSigningKeys,
    publicRateLimits: {
      windowMs: integerFromEnv(env, "PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 60) * 1000,
      maxBuckets: integerFromEnv(env, "PUBLIC_RATE_LIMIT_MAX_BUCKETS", 10_000),
      reader: {
        perIp: integerFromEnv(env, "PUBLIC_READER_RATE_LIMIT_PER_IP", 120),
        perCredential: integerFromEnv(env, "PUBLIC_READER_RATE_LIMIT_PER_CREDENTIAL", 60),
      },
      media: {
        perIp: integerFromEnv(env, "PUBLIC_MEDIA_RATE_LIMIT_PER_IP", 600),
        perCredential: integerFromEnv(env, "PUBLIC_MEDIA_RATE_LIMIT_PER_CREDENTIAL", 300),
      },
      reply: {
        perIp: integerFromEnv(env, "PUBLIC_REPLY_RATE_LIMIT_PER_IP", 20),
        perCredential: integerFromEnv(env, "PUBLIC_REPLY_RATE_LIMIT_PER_CREDENTIAL", 5),
      },
    },
    replySafetyTimeoutMs: integerFromEnv(env, "REPLY_SAFETY_TIMEOUT_MS", 3_000),
  };
}
