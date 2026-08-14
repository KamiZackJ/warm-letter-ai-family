import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createAIProviderFromEnv } from "./ai.js";
import { FileSystemObjectStorage } from "./object-storage.js";

const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const configuredMaximumUploadBytes = process.env.MAX_MEDIA_UPLOAD_BYTES
  ? Number(process.env.MAX_MEDIA_UPLOAD_BYTES)
  : undefined;
const configuredShareTokenTtlMs = process.env.SHARE_TOKEN_TTL_SECONDS
  ? Number(process.env.SHARE_TOKEN_TTL_SECONDS) * 1000
  : undefined;
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
});
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
