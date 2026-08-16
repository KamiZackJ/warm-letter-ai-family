import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import {
  ClientJobSchema,
  GenerateLetterResponseSchema,
  GetJobResponseSchema,
  type ClientJob,
} from "@warm-letter/contracts";
import { resolve } from "node:path";
import { FakeAIProvider, OpenAIResponsesProvider, type AIProvider } from "./ai.js";
import type { GenerationJob, Material } from "./domain.js";
import { ApiError } from "./errors.js";
import {
  resolveMediaUploadPolicy,
  supportedMediaContentTypes,
  validateMediaBytes,
} from "./media-policy.js";
import {
  FileSystemObjectStorage,
  ObjectAlreadyExistsError,
  type ObjectStorage,
} from "./object-storage.js";
import { MemoryRepository } from "./repository.js";
import {
  PublicRateLimiter,
  type PublicRateLimitConfig,
  type PublicRouteKind,
} from "./public-rate-limit.js";
import type { ReplySafetyPolicy } from "./reply-safety.js";
import {
  assertApiDeploymentSupported,
  type AIProviderMode,
  type DeploymentMode,
} from "./runtime-config.js";
import {
  canonicalMediaCredential,
  WarmLetterService,
  type CreateLetterInput,
  type EditLetterInput,
  type RegisterMaterialInput,
} from "./service.js";
import { UploadCredentialService, uploadCredentialHeader } from "./upload-credential.js";

function serializeGenerationJob(job: GenerationJob): ClientJob {
  return ClientJobSchema.parse({
    id: job.id,
    letterId: job.letterId,
    status: job.status,
    type: job.type,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    error: job.error
      ? {
          code: job.error.code,
          retryable: job.error.retryable ?? false,
        }
      : undefined,
  });
}

function idempotencyKeyFrom(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 120 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "请求标识无效");
  }
  return value;
}

export interface BuildAppOptions {
  deploymentMode: DeploymentMode;
  repository?: MemoryRepository;
  aiProvider?: AIProvider;
  logger?: boolean;
  corsOrigins?: string[];
  objectStorage?: ObjectStorage;
  uploadDirectory?: string;
  publicBaseUrl?: string;
  maxMediaUploadBytes?: number;
  shareTokenTtlMs?: number;
  mediaTokenTtlMs?: number;
  mediaSigningKeys?: readonly Uint8Array[];
  uploadTokenTtlMs?: number;
  publicRateLimits?: PublicRateLimitConfig;
  replySafetyPolicy?: ReplySafetyPolicy;
  replySafetyTimeoutMs?: number;
  loggerStream?: { write(message: string): void };
  now?: () => Date;
}

const defaultMaximumMediaBytes = 25 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_BODY", `${field} 必须是字符串`);
  }
  return value;
}

function tokenFrom(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function queryTokenFrom(request: FastifyRequest, field: "token" | "mediaToken"): string | undefined {
  const query = (request.query ?? {}) as Record<string, unknown>;
  return typeof query[field] === "string" ? query[field] : undefined;
}

function requireOwnedMaterial(
  service: WarmLetterService,
  userId: string,
  materialId: string,
): Material {
  const material = service.repository.getMaterial(materialId);
  if (!material || material.userId !== userId) {
    throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
  }
  return material;
}

function mediaContentType(request: FastifyRequest): string | undefined {
  const value = request.headers["content-type"];
  return typeof value === "string" ? value.split(";", 1)[0]?.trim().toLowerCase() : undefined;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const aiProvider = options.aiProvider ?? new FakeAIProvider();
  const aiProviderMode: AIProviderMode | "custom" =
    aiProvider instanceof OpenAIResponsesProvider
      ? "openai"
      : aiProvider instanceof FakeAIProvider
        ? "fake"
        : "custom";
  assertApiDeploymentSupported(options.deploymentMode, aiProviderMode);

  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req(request: FastifyRequest) {
              return {
                method: request.method,
                url: request.url.split("?", 1)[0],
                host: request.hostname,
                remoteAddress: request.ip,
              };
            },
          },
          redact: [
            "req.headers.authorization",
            "headers.authorization",
            `req.headers["${uploadCredentialHeader}"]`,
            `headers["${uploadCredentialHeader}"]`,
          ],
          stream: options.loggerStream,
        }
      : false,
  });
  const objectStorage =
    options.objectStorage ??
    new FileSystemObjectStorage(options.uploadDirectory ?? resolve(process.cwd(), "uploads"));
  const publicBaseUrl = (options.publicBaseUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const maxMediaUploadBytes = options.maxMediaUploadBytes ?? defaultMaximumMediaBytes;
  if (!Number.isSafeInteger(maxMediaUploadBytes) || maxMediaUploadBytes < 1) {
    throw new Error("maxMediaUploadBytes must be a positive safe integer");
  }
  const uploadCredentials = new UploadCredentialService({
    signingKeys: options.mediaSigningKeys,
    ttlMs: options.uploadTokenTtlMs,
    now: options.now,
  });
  const service = new WarmLetterService(
    options.repository ?? new MemoryRepository(),
    aiProvider,
    {
      shareTokenTtlMs: options.shareTokenTtlMs,
      mediaTokenTtlMs: options.mediaTokenTtlMs,
      mediaSigningKeys: options.mediaSigningKeys,
      replySafetyPolicy: options.replySafetyPolicy,
      replySafetyTimeoutMs: options.replySafetyTimeoutMs,
      now: options.now,
    },
  );
  const publicRateLimiter = new PublicRateLimiter(
    options.publicRateLimits,
    () => (options.now?.() ?? new Date()).getTime(),
  );

  function enforcePublicRateLimit(
    kind: PublicRouteKind,
    request: FastifyRequest,
    reply: FastifyReply,
    credential: string | undefined,
  ): void {
    const result = publicRateLimiter.check(kind, request.ip, credential);
    if (!result.allowed) {
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试");
    }
  }

  app.addContentTypeParser(
    supportedMediaContentTypes,
    { parseAs: "buffer", bodyLimit: maxMediaUploadBytes },
    (_request, body, done) => done(null, body),
  );

  void app.register(cors, {
    origin: options.corsOrigins ?? ["http://127.0.0.1:4173", "http://localhost:4173"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.decorate("warmLetterService", service);
  app.decorate("objectStorage", objectStorage);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof Error) {
      const clientError = error as Error & { statusCode?: number; code?: string };
      if (
        typeof clientError.statusCode === "number" &&
        clientError.statusCode >= 400 &&
        clientError.statusCode < 500
      ) {
        return reply.status(clientError.statusCode).send({
          error: {
            code: clientError.code ?? "BAD_REQUEST",
            message:
              clientError.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
                ? "请求体不能为空"
                : clientError.message,
          },
        });
      }
    }
    app.log.error(error);
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "warm-letter-api",
    deploymentMode: options.deploymentMode,
    nonProduction: true,
    capabilities: {
      ai: aiProviderMode,
      authentication: "development",
      repository: "memory",
      objectStorage: "local-filesystem",
      replySafety: "deterministic",
    },
  }));

  app.post("/v1/auth/wx-login", async (request, reply) => {
    const body = record(request.body);
    const code = stringValue(body.code, "code", false) ?? "local-demo";
    const displayName = stringValue(body.displayName, "displayName", false);
    return reply.send(service.login(code, displayName));
  });

  app.get("/v1/materials", async (request) => {
    const user = service.authenticate(tokenFrom(request));
    return { materials: service.listMaterials(user.id) };
  });

  app.post("/v1/materials", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const body = record(request.body);
    if (body.type !== "text") {
      throw new ApiError(400, "MEDIA_UPLOAD_REQUIRED", "媒体素材必须通过上传流程提交");
    }
    const { material, replayed } = service.registerMaterial(
      user.id,
      {
        type: "text",
        name: stringValue(body.name, "name")!,
        textContent: stringValue(body.textContent, "textContent")!,
      },
      idempotencyKeyFrom(request),
    );
    return reply.status(replayed ? 200 : 201).send({ material });
  });

  app.post("/v1/materials/presign", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const body = record(request.body);
    const name = stringValue(body.filename ?? body.name, "filename")!;
    const policy = resolveMediaUploadPolicy(
      body.type as RegisterMaterialInput["type"],
      name,
      stringValue(body.contentType, "contentType", false),
    );
    const objectKey = `${user.id}/${crypto.randomUUID()}${policy.extension}`;
    const { material, replayed } = service.registerMaterial(
      user.id,
      {
        type: body.type as RegisterMaterialInput["type"],
        name,
        contentType: policy.contentType,
        objectKey,
        uploading: true,
      },
      idempotencyKeyFrom(request),
    );
    if (!material.objectKey) {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材缺少上传信息");
    }
    reply.header("cache-control", "no-store");
    if (material.status === "READY") {
      return reply.status(200).send({
        materialId: material.id,
        objectKey: material.objectKey,
        completed: true,
        material,
      });
    }
    if (material.status !== "UPLOADING") {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材不处于上传状态");
    }
    return reply.status(replayed ? 200 : 201).send({
      materialId: material.id,
      objectKey: material.objectKey,
      completed: false,
      uploadUrl: `${publicBaseUrl}/v1/materials/${material.id}/content`,
      headers: {
        "content-type": policy.contentType,
        [uploadCredentialHeader]: uploadCredentials.issue(material.id, policy.contentType),
      },
    });
  });

  app.put("/v1/materials/:id/content", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rawCredential = request.headers[uploadCredentialHeader];
    const verification = uploadCredentials.verify(
      typeof rawCredential === "string" ? rawCredential : undefined,
    );
    if (verification.status === "expired") {
      throw new ApiError(410, "UPLOAD_CREDENTIAL_EXPIRED", "上传地址已过期，请重新上传");
    }
    if (verification.status !== "valid" || verification.claims.materialId !== id) {
      throw new ApiError(404, "UPLOAD_CREDENTIAL_INVALID", "上传地址无效");
    }
    const material = service.repository.getMaterial(id);
    if (!material || material.contentType !== verification.claims.contentType) {
      throw new ApiError(404, "UPLOAD_CREDENTIAL_INVALID", "上传地址无效");
    }
    if (material.status !== "UPLOADING") {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材不处于上传状态");
    }
    if (!material.objectKey || !material.contentType) {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材缺少上传信息");
    }

    const requestContentType = mediaContentType(request);
    if (requestContentType !== material.contentType) {
      throw new ApiError(415, "MIME_MISMATCH", "上传 MIME 类型与申请信息不一致");
    }
    if (!Buffer.isBuffer(request.body)) {
      throw new ApiError(400, "INVALID_UPLOAD_BODY", "上传内容必须是二进制文件");
    }
    const policy = resolveMediaUploadPolicy(material.type, material.name, material.contentType);
    validateMediaBytes(request.body, policy, maxMediaUploadBytes);
    try {
      await objectStorage.put(material.objectKey, {
        bytes: request.body,
        contentType: material.contentType,
      });
    } catch (error) {
      if (error instanceof ObjectAlreadyExistsError) {
        throw new ApiError(409, "UPLOAD_ALREADY_RECEIVED", "上传文件已经接收，不能重复覆盖");
      }
      throw error;
    }
    return reply.status(204).send();
  });

  app.post("/v1/materials/complete", async (request) => {
    const user = service.authenticate(tokenFrom(request));
    const body = record(request.body);
    const materialId = stringValue(body.materialId, "materialId")!;
    const material = requireOwnedMaterial(service, user.id, materialId);
    if (material.status === "READY") {
      return { material };
    }
    if (material.status !== "UPLOADING") {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材不处于上传状态");
    }
    if (!material.objectKey || !material.contentType) {
      throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材缺少上传信息");
    }
    const storedObject = await objectStorage.read(material.objectKey);
    if (!storedObject) {
      throw new ApiError(409, "UPLOAD_NOT_FOUND", "尚未收到上传文件");
    }
    if (storedObject.contentType !== material.contentType) {
      throw new ApiError(409, "UPLOAD_METADATA_MISMATCH", "上传文件元数据不一致");
    }
    const policy = resolveMediaUploadPolicy(material.type, material.name, material.contentType);
    validateMediaBytes(storedObject.bytes, policy, maxMediaUploadBytes);
    const textContent = stringValue(body.textContent, "textContent", false);
    return { material: service.completeMaterial(user.id, materialId, { textContent }) };
  });

  app.get("/v1/materials/:id/content", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    const material = requireOwnedMaterial(service, user.id, id);
    if (material.status !== "READY" || !material.objectKey) {
      throw new ApiError(404, "MATERIAL_NOT_FOUND", "素材不存在");
    }
    const storedObject = await objectStorage.read(material.objectKey);
    if (!storedObject) {
      throw new ApiError(404, "MATERIAL_OBJECT_NOT_FOUND", "素材文件不存在");
    }
    return reply
      .header("content-type", storedObject.contentType)
      .header("content-length", storedObject.sizeBytes)
      .header("cache-control", "private, no-store")
      .send(storedObject.bytes);
  });

  app.delete("/v1/materials/:id", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    const material = requireOwnedMaterial(service, user.id, id);
    if (material.objectKey) {
      await objectStorage.delete(material.objectKey);
    }
    service.deleteMaterial(user.id, id);
    return reply.status(204).send();
  });

  app.post("/v1/letters", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const body = record(request.body);
    const letter = service.createLetter(user.id, body as unknown as CreateLetterInput);
    return reply.status(201).send({ letter });
  });

  app.get("/v1/letters/:id", async (request) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    return { letter: service.getLetter(user.id, id) };
  });

  app.patch("/v1/letters/:id", async (request) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    const body = record(request.body);
    return { letter: service.editLetter(user.id, id, body as unknown as EditLetterInput) };
  });

  app.post("/v1/letters/:id/generate", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    const job = service.enqueueGeneration(user.id, id, idempotencyKeyFrom(request));
    return reply
      .status(202)
      .send(GenerateLetterResponseSchema.parse({ job: serializeGenerationJob(job) }));
  });

  app.get("/v1/jobs/:id", async (request) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    return GetJobResponseSchema.parse({ job: serializeGenerationJob(service.getJob(user.id, id)) });
  });

  app.post("/v1/letters/:id/confirm", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    const published = service.confirmAndPublish(user.id, id);
    reply.header("cache-control", "no-store");
    return {
      ...published,
      readerUrl: `/v1/letters/${published.letter.id}/reader?token=${encodeURIComponent(published.shareToken)}`,
    };
  });

  app.post("/v1/letters/:id/share/reissue", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    const published = service.reissueShare(user.id, id);
    reply.header("cache-control", "no-store");
    return {
      ...published,
      readerUrl: `/v1/letters/${published.letter.id}/reader?token=${encodeURIComponent(published.shareToken)}`,
    };
  });

  app.delete("/v1/letters/:id/share", async (request, reply) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    service.revokeShare(user.id, id);
    return reply.status(204).send();
  });

  app.get("/v1/letters/:id/reader", async (request, reply) => {
    const { id } = request.params as { id: string };
    const shareToken = queryTokenFrom(request, "token");
    enforcePublicRateLimit("reader", request, reply, shareToken);
    const reader = service.getReader(id, shareToken);
    reply
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff");
    return {
      reader: {
        ...reader,
        sources: reader.sources.map((source) => {
          const { mediaToken, ...publicSource } = source;
          return source.type === "text"
            ? publicSource
            : {
                ...publicSource,
                mediaUrl: `${publicBaseUrl}/v1/letters/${id}/sources/${source.id}/content?mediaToken=${encodeURIComponent(mediaToken!)}`,
              };
        }),
      },
    };
  });

  app.get("/v1/letters/:letterId/sources/:materialId/content", async (request, reply) => {
    const { letterId, materialId } = request.params as { letterId: string; materialId: string };
    const mediaToken = queryTokenFrom(request, "mediaToken");
    enforcePublicRateLimit("media", request, reply, canonicalMediaCredential(mediaToken));
    const material = service.getPublicMaterial(letterId, materialId, mediaToken);
    const storedObject = await objectStorage.read(material.objectKey!);
    if (!storedObject) {
      throw new ApiError(410, "SHARE_UNAVAILABLE", "这封家书的媒体暂时不可用");
    }
    return reply
      .header("content-type", storedObject.contentType)
      .header("content-length", storedObject.sizeBytes)
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .send(storedObject.bytes);
  });

  app.post(
    "/v1/letters/:id/replies",
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shareToken = queryTokenFrom(request, "token");
      let text: string;
      let authorName: string | undefined;
      let idempotencyKey: string | undefined;
      try {
        const body = record(request.body);
        text = stringValue(body.text, "text")!;
        authorName = stringValue(body.authorName, "authorName", false);
        idempotencyKey = idempotencyKeyFrom(request);
      } catch (error) {
        enforcePublicRateLimit("reply", request, reply, shareToken);
        throw error;
      }
      if (idempotencyKey) {
        try {
          const replayedReply = service.findReplyReplay(
            id,
            shareToken,
            text,
            authorName,
            idempotencyKey,
          );
          if (replayedReply) {
            return reply
              .header("cache-control", "no-store")
              .status(201)
              .send({ reply: replayedReply });
          }
        } catch (error) {
          if (error instanceof ApiError && error.code === "IDEMPOTENCY_KEY_REUSED") {
            throw error;
          }
          enforcePublicRateLimit("reply", request, reply, shareToken);
          throw error;
        }
      }
      enforcePublicRateLimit("reply", request, reply, shareToken);
      const createdReply = await service.createReply(
        id,
        shareToken,
        text,
        authorName,
        idempotencyKey,
      );
      return reply
        .header("cache-control", "no-store")
        .status(201)
        .send({ reply: createdReply });
    },
  );

  app.get("/v1/letters/:id/replies", async (request) => {
    const user = service.authenticate(tokenFrom(request));
    const { id } = request.params as { id: string };
    return { replies: service.listReplies(user.id, id) };
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    warmLetterService: WarmLetterService;
    objectStorage: ObjectStorage;
  }
}
