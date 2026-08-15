import { buildApp } from "./app.js";
import { createAIProviderFromEnv } from "./ai.js";
import { FileSystemObjectStorage } from "./object-storage.js";
import { loadApiRuntimeConfig } from "./runtime-config.js";

const runtimeConfig = loadApiRuntimeConfig(process.env);
const objectStorage = new FileSystemObjectStorage(runtimeConfig.uploadDirectory);
const app = buildApp({
  deploymentMode: runtimeConfig.deploymentMode,
  logger: true,
  objectStorage,
  aiProvider: createAIProviderFromEnv(process.env, { assetReader: objectStorage }),
  corsOrigins: runtimeConfig.corsOrigins,
  publicBaseUrl: runtimeConfig.publicBaseUrl,
  uploadDirectory: runtimeConfig.uploadDirectory,
  maxMediaUploadBytes: runtimeConfig.maxMediaUploadBytes,
  shareTokenTtlMs: runtimeConfig.shareTokenTtlMs,
  mediaTokenTtlMs: runtimeConfig.mediaTokenTtlMs,
  mediaSigningKeys: runtimeConfig.mediaSigningKeys,
  publicRateLimits: runtimeConfig.publicRateLimits,
  replySafetyTimeoutMs: runtimeConfig.replySafetyTimeoutMs,
});

try {
  await app.listen({ port: runtimeConfig.port, host: runtimeConfig.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
