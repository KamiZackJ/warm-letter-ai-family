import { buildApp } from "./app.js";
import { createAIProviderFromEnv } from "./ai.js";
import { FileSystemObjectStorage } from "./object-storage.js";
import { loadApiRuntimeConfig } from "./runtime-config.js";
import { createSpeechProviderFromEnv } from "./speech.js";
import { createWechatAuthProviderFromEnv } from "./wechat-auth.js";
import { SqliteRepository } from "./sqlite-repository.js";
import { createContentSafetyProviderFromEnv } from "./content-safety.js";
import { WechatModerationCallbackVerifier } from "./wechat-moderation-callback.js";

const runtimeConfig = loadApiRuntimeConfig(process.env);
const objectStorage = new FileSystemObjectStorage(runtimeConfig.uploadDirectory);
const repository = runtimeConfig.databasePath ? new SqliteRepository({filename: runtimeConfig.databasePath}) : undefined;
repository?.recoverInterruptedJobs();
const production = runtimeConfig.deploymentMode === "production";
const app = buildApp({
  deploymentMode: runtimeConfig.deploymentMode,
  authProviderMode: runtimeConfig.authProviderMode,
  wechatAuthProvider:
    runtimeConfig.authProviderMode === "wechat"
      ? createWechatAuthProviderFromEnv(process.env, {
          timeoutMs: runtimeConfig.wechatAuthTimeoutMs,
        })
      : undefined,
  logger: true,
  objectStorage,
  repository,
  durableStorage: production,
  mediaTemporaryDirectory: process.env.MEDIA_TEMP_DIR || `${runtimeConfig.uploadDirectory}/.safety-tmp`,
  contentSafetyProvider: production ? createContentSafetyProviderFromEnv(process.env) : undefined,
  moderationCallback: production ? new WechatModerationCallbackVerifier({
    token: process.env.WECHAT_MESSAGE_TOKEN!, appId: process.env.WECHAT_APP_ID!,
    encodingAesKey: process.env.WECHAT_ENCODING_AES_KEY!,
  }) : undefined,
  aiProvider: createAIProviderFromEnv(process.env, { assetReader: objectStorage }),
  speechProvider: createSpeechProviderFromEnv(process.env),
  corsOrigins: runtimeConfig.corsOrigins,
  publicBaseUrl: runtimeConfig.publicBaseUrl,
  uploadDirectory: runtimeConfig.uploadDirectory,
  maxMediaUploadBytes: runtimeConfig.maxMediaUploadBytes,
  shareTokenTtlMs: runtimeConfig.shareTokenTtlMs,
  mediaTokenTtlMs: runtimeConfig.mediaTokenTtlMs,
  mediaSigningKeys: runtimeConfig.mediaSigningKeys,
  publicRateLimits: runtimeConfig.publicRateLimits,
  generationRateLimits: runtimeConfig.generationRateLimits,
  speechRateLimits: runtimeConfig.speechRateLimits,
  replySafetyTimeoutMs: runtimeConfig.replySafetyTimeoutMs,
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => { repository?.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

try {
  await app.listen({ port: runtimeConfig.port, host: runtimeConfig.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
