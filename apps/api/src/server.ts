import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createAIProviderFromEnv } from "./ai.js";
import { FileSystemObjectStorage } from "./object-storage.js";

function integerFromEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function mediaSigningKeysFromEnv(): Buffer[] | undefined {
  const raw = process.env.MEDIA_SIGNING_KEYS?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MEDIA_SIGNING_KEYS is required in production");
    }
    return undefined;
  }
  const keys = raw.split(",").map((value) => Buffer.from(value.trim(), "base64url"));
  if (keys.some((key) => key.length < 32)) {
    throw new Error("Each MEDIA_SIGNING_KEYS entry must decode to at least 32 bytes");
  }
  return keys;
}

const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const configuredMaximumUploadBytes = process.env.MAX_MEDIA_UPLOAD_BYTES
  ? Number(process.env.MAX_MEDIA_UPLOAD_BYTES)
  : undefined;
const configuredShareTokenTtlMs = integerFromEnv(
  "SHARE_TOKEN_TTL_SECONDS",
  30 * 24 * 60 * 60,
  300,
) * 1000;
const configuredMediaTokenTtlMs = integerFromEnv("MEDIA_TOKEN_TTL_SECONDS", 5 * 60, 30) * 1000;
const configuredMediaSigningKeys = mediaSigningKeysFromEnv();
if (configuredMediaTokenTtlMs >= configuredShareTokenTtlMs) {
  throw new Error("MEDIA_TOKEN_TTL_SECONDS must be shorter than SHARE_TOKEN_TTL_SECONDS");
}
const publicRateLimits = {
  windowMs: integerFromEnv("PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 60) * 1000,
  maxBuckets: integerFromEnv("PUBLIC_RATE_LIMIT_MAX_BUCKETS", 10_000),
  reader: {
    perIp: integerFromEnv("PUBLIC_READER_RATE_LIMIT_PER_IP", 120),
    perCredential: integerFromEnv("PUBLIC_READER_RATE_LIMIT_PER_CREDENTIAL", 60),
  },
  media: {
    perIp: integerFromEnv("PUBLIC_MEDIA_RATE_LIMIT_PER_IP", 600),
    perCredential: integerFromEnv("PUBLIC_MEDIA_RATE_LIMIT_PER_CREDENTIAL", 300),
  },
  reply: {
    perIp: integerFromEnv("PUBLIC_REPLY_RATE_LIMIT_PER_IP", 20),
    perCredential: integerFromEnv("PUBLIC_REPLY_RATE_LIMIT_PER_CREDENTIAL", 5),
  },
};
const objectStorage = new FileSystemObjectStorage(
  process.env.UPLOAD_DIR ?? resolve(process.cwd(), "uploads"),
);
const app = buildApp({
  logger: true,
  objectStorage,
  aiProvider: createAIProviderFromEnv(process.env, { assetReader: objectStorage }),
  corsOrigins: corsOrigins?.length ? corsOrigins : undefined,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  uploadDirectory: process.env.UPLOAD_DIR,
  maxMediaUploadBytes: configuredMaximumUploadBytes,
  shareTokenTtlMs: configuredShareTokenTtlMs,
  mediaTokenTtlMs: configuredMediaTokenTtlMs,
  mediaSigningKeys: configuredMediaSigningKeys,
  publicRateLimits,
  replySafetyTimeoutMs: integerFromEnv("REPLY_SAFETY_TIMEOUT_MS", 3_000),
});
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
