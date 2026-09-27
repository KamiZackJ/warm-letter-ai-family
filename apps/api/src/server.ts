import { buildApp } from "./app.js";
import { createAIProviderFromEnv } from "./ai.js";
import { FileSystemObjectStorage } from "./object-storage.js";
import { loadApiRuntimeConfig } from "./runtime-config.js";
import { createSpeechProviderFromEnv } from "./speech.js";
import { createWechatAuthProviderFromEnv } from "./wechat-auth.js";
import { SqliteRepository } from "./sqlite-repository.js";
import { createContentSafetyProviderFromEnv } from "./content-safety.js";
import { WechatModerationCallbackVerifier } from "./wechat-moderation-callback.js";
import { SafetyMediaStaging } from "./safety-media-staging.js";
import { OssSafetyMediaStore } from "./oss-safety-media.js";
import { join } from "node:path";

const runtimeConfig = loadApiRuntimeConfig(process.env);
const objectStorage = new FileSystemObjectStorage(runtimeConfig.uploadDirectory);
const repository = runtimeConfig.databasePath ? new SqliteRepository({filename: runtimeConfig.databasePath}) : undefined;
repository?.recoverInterruptedJobs();
const production = runtimeConfig.deploymentMode === "production";
const safetyMediaStaging = runtimeConfig.wechatOss ? new SafetyMediaStaging({
  directory: join(runtimeConfig.uploadDirectory, ".wechat-safety-staging"),
  namespaceId: `${runtimeConfig.wechatOss.region}/${runtimeConfig.wechatOss.bucket}/wechat-safety/`,
  repository: repository!, objectStorage,
  operationTimeoutMs: 105_000,
  remote: new OssSafetyMediaStore({
    ...runtimeConfig.wechatOss,
    accessKeyId: process.env.WECHAT_OSS_ACCESS_KEY_ID!.trim(),
    accessKeySecret: process.env.WECHAT_OSS_ACCESS_KEY_SECRET!.trim(),
    namespacePrefix: "wechat-safety/", timeoutMs: 10_000, uploadTimeoutMs: 90_000,
  }),
}) : undefined;
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
  safetyMediaStaging,
  backgroundMediaSafety: Boolean(safetyMediaStaging),
  moderationCallback: production ? new WechatModerationCallbackVerifier({
    token: process.env.WECHAT_MESSAGE_TOKEN!, appId: process.env.WECHAT_APP_ID!,
    encodingAesKey: process.env.WECHAT_ENCODING_AES_KEY!,
  }) : undefined,
  aiProvider: createAIProviderFromEnv(process.env, { assetReader: objectStorage }),
  speechProvider: createSpeechProviderFromEnv(process.env),
  corsOrigins: runtimeConfig.corsOrigins,
  publicBaseUrl: runtimeConfig.publicBaseUrl,
  wechatMediaBaseUrl: runtimeConfig.wechatMediaBaseUrl,
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
