import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { FileSystemObjectStorage } from "../src/object-storage.js";
import { MemoryRepository } from "../src/repository.js";
import type { ReplySafetyPolicy } from "../src/reply-safety.js";
import { auth, json, login, waitForJob } from "./helpers.js";

interface PublishedFixture {
  ownerToken: string;
  letterId: string;
  materialId: string;
  shareToken: string;
  shareExpiresAt: string;
  readerUrl: string;
  mediaUrl: string;
  mediaExpiresAt: string;
}

const signingKey = Buffer.alloc(32, 7);
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function mediaPath(mediaUrl: string): string {
  const parsed = new URL(mediaUrl);
  return `${parsed.pathname}${parsed.search}`;
}

function errorCode(response: { json<T>(): T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

function nonCanonicalMediaTokenAlias(mediaToken: string): string {
  const [payload, signature] = mediaToken.split(".") as [string, string];
  const lastIndex = base64UrlAlphabet.indexOf(signature.at(-1)!);
  if (lastIndex < 0 || lastIndex % 4 !== 0) {
    throw new Error("expected a canonical 32-byte Base64URL signature");
  }
  const aliasSignature = `${signature.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
  if (!Buffer.from(aliasSignature, "base64url").equals(Buffer.from(signature, "base64url"))) {
    throw new Error("expected the alias to decode to the same signature bytes");
  }
  return `${payload}.${aliasSignature}`;
}

async function publishFixture(
  app: FastifyInstance,
  suffix: string,
  loginCode = `public-${suffix}`,
): Promise<PublishedFixture> {
  const ownerToken = await login(app, loginCode);
  const presign = await app.inject({
    method: "POST",
    url: "/v1/materials/presign",
    headers: auth(ownerToken),
    payload: { type: "photo", filename: `${suffix}.jpg`, contentType: "image/jpeg" },
  });
  expect(presign.statusCode).toBe(201);
  const presigned = json<{
    materialId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  }>(presign);
  const materialId = presigned.materialId;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: new URL(presigned.uploadUrl).pathname,
        headers: presigned.headers,
        payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/materials/complete",
        headers: auth(ownerToken),
        payload: { materialId },
      })
    ).statusCode,
  ).toBe(200);

  const created = await app.inject({
    method: "POST",
    url: "/v1/letters",
    headers: auth(ownerToken),
    payload: { recipient: "妈妈", materialIds: [materialId] },
  });
  expect(created.statusCode).toBe(201);
  const letterId = json<{ letter: { id: string } }>(created).letter.id;
  const generation = await app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/generate`,
    headers: auth(ownerToken),
  });
  expect(generation.statusCode).toBe(202);
  await waitForJob(app, ownerToken, json<{ job: { id: string } }>(generation).job.id);

  const confirmed = await app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/confirm`,
    headers: auth(ownerToken),
  });
  expect(confirmed.statusCode).toBe(200);
  const published = json<{
    shareToken: string;
    shareExpiresAt: string;
    readerUrl: string;
  }>(confirmed);
  const readerResponse = await app.inject({ method: "GET", url: published.readerUrl });
  expect(readerResponse.statusCode).toBe(200);
  const source = json<{
    reader: { sources: Array<{ id: string; mediaUrl?: string; mediaExpiresAt?: string }> };
  }>(readerResponse).reader.sources.find((item) => item.id === materialId);
  expect(source?.mediaUrl).toBeTruthy();
  expect(source?.mediaExpiresAt).toBeTruthy();

  return {
    ownerToken,
    letterId,
    materialId,
    shareToken: published.shareToken,
    shareExpiresAt: published.shareExpiresAt,
    readerUrl: published.readerUrl,
    mediaUrl: source!.mediaUrl!,
    mediaExpiresAt: source!.mediaExpiresAt!,
  };
}

describe("public share, media, and reply security", () => {
  let app: FastifyInstance;
  let repository: MemoryRepository;
  let objectStorage: FileSystemObjectStorage;
  let uploadDirectory: string;

  async function rebuild(options: Partial<BuildAppOptions> = {}): Promise<void> {
    await app.close();
    repository = options.repository ?? new MemoryRepository();
    objectStorage = new FileSystemObjectStorage(uploadDirectory);
    app = buildApp({
      deploymentMode: "test",
      repository,
      objectStorage,
      publicBaseUrl: "https://reader.example.test",
      maxMediaUploadBytes: 1024,
      mediaSigningKeys: [signingKey],
      ...options,
    });
  }

  beforeEach(async () => {
    uploadDirectory = await mkdtemp(join(tmpdir(), "warm-letter-public-"));
    repository = new MemoryRepository();
    objectStorage = new FileSystemObjectStorage(uploadDirectory);
    app = buildApp({
      deploymentMode: "test",
      repository,
      objectStorage,
      publicBaseUrl: "https://reader.example.test",
      maxMediaUploadBytes: 1024,
      mediaSigningKeys: [signingKey],
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  it("issues a short-lived media credential bound to one share, letter, and material", async () => {
    const fixture = await publishFixture(app, "independent-media");
    const parsed = new URL(fixture.mediaUrl);
    const mediaToken = parsed.searchParams.get("mediaToken");

    expect(mediaToken).toBeTruthy();
    expect(parsed.searchParams.has("token")).toBe(false);
    expect(fixture.mediaUrl).not.toContain(fixture.shareToken);
    expect(Date.parse(fixture.mediaExpiresAt)).toBeLessThan(Date.parse(fixture.shareExpiresAt));
    expect(Date.parse(fixture.mediaExpiresAt)).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

    const [encodedClaims] = mediaToken!.split(".");
    const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8")) as {
      aud: string;
      lid: string;
      mid: string;
    };
    expect(claims).toMatchObject({
      aud: "public-media",
      lid: fixture.letterId,
      mid: fixture.materialId,
    });

    const validMedia = await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) });
    expect(validMedia.statusCode).toBe(200);
    expect(validMedia.headers["cache-control"]).toBe("private, no-store");
    expect(validMedia.headers["x-content-type-options"]).toBe("nosniff");

    const [payload, signature] = mediaToken!.split(".") as [string, string];
    const tamperedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const tampered = `${payload}.${tamperedSignature}`;
    const tamperedResponse = await app.inject({
      method: "GET",
      url: `${parsed.pathname}?mediaToken=${encodeURIComponent(tampered)}`,
    });
    expect(tamperedResponse.statusCode).toBe(404);
    expect(errorCode(tamperedResponse)).toBe("PUBLIC_ACCESS_NOT_FOUND");

    const nonCanonicalAlias = nonCanonicalMediaTokenAlias(mediaToken!);
    const aliasedResponse = await app.inject({
      method: "GET",
      url: `${parsed.pathname}?mediaToken=${encodeURIComponent(nonCanonicalAlias)}`,
    });
    expect(aliasedResponse.statusCode).toBe(404);
    expect(errorCode(aliasedResponse)).toBe("PUBLIC_ACCESS_NOT_FOUND");

    const shareTokenAsMedia = await app.inject({
      method: "GET",
      url: `${parsed.pathname}?mediaToken=${encodeURIComponent(fixture.shareToken)}`,
    });
    expect(shareTokenAsMedia.statusCode).toBe(404);

    const mediaTokenAsReader = await app.inject({
      method: "GET",
      url: `/v1/letters/${fixture.letterId}/reader?token=${encodeURIComponent(mediaToken!)}`,
    });
    expect(mediaTokenAsReader.statusCode).toBe(404);

    const mediaTokenAsReply = await app.inject({
      method: "POST",
      url: `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(mediaToken!)}`,
      payload: { text: "不能使用媒体凭据回复" },
    });
    expect(mediaTokenAsReply.statusCode).toBe(404);
  });

  it("masks a missing public media object after validating the credential", async () => {
    const fixture = await publishFixture(app, "missing-public-object");
    const material = repository.getMaterial(fixture.materialId);
    expect(material?.objectKey).toBeTruthy();
    await objectStorage.delete(material!.objectKey!);

    const missingObject = await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) });
    expect(missingObject.statusCode).toBe(410);
    expect(errorCode(missingObject)).toBe("SHARE_UNAVAILABLE");
    expect(missingObject.body).not.toContain("MATERIAL_OBJECT_NOT_FOUND");
    expect(missingObject.body).not.toContain(material!.objectKey!);

    const parsed = new URL(fixture.mediaUrl);
    parsed.searchParams.set("mediaToken", "unknown");
    const invalidCredential = await app.inject({
      method: "GET",
      url: `${parsed.pathname}${parsed.search}`,
    });
    expect(invalidCredential.statusCode).toBe(404);
    expect(errorCode(invalidCredential)).toBe("PUBLIC_ACCESS_NOT_FOUND");
  });

  it("returns a uniform not-found result for missing, unknown, and wrongly bound credentials", async () => {
    const first = await publishFixture(app, "matrix-a");
    const second = await publishFixture(app, "matrix-b");
    const firstMedia = new URL(first.mediaUrl);

    const requests: Array<{ name: string; options: InjectOptions }> = [
      { name: "reader missing", options: { method: "GET", url: `/v1/letters/${first.letterId}/reader` } },
      {
        name: "reader unknown",
        options: { method: "GET", url: `/v1/letters/${first.letterId}/reader?token=unknown` },
      },
      {
        name: "reader wrong letter",
        options: {
          method: "GET",
          url: `/v1/letters/${second.letterId}/reader?token=${encodeURIComponent(first.shareToken)}`,
        },
      },
      {
        name: "reply missing",
        options: {
          method: "POST",
          url: `/v1/letters/${first.letterId}/replies`,
          payload: { text: "测试" },
        },
      },
      {
        name: "reply unknown",
        options: {
          method: "POST",
          url: `/v1/letters/${first.letterId}/replies?token=unknown`,
          payload: { text: "测试" },
        },
      },
      {
        name: "reply wrong letter",
        options: {
          method: "POST",
          url: `/v1/letters/${second.letterId}/replies?token=${encodeURIComponent(first.shareToken)}`,
          payload: { text: "测试" },
        },
      },
      {
        name: "media missing",
        options: { method: "GET", url: firstMedia.pathname },
      },
      {
        name: "media unknown",
        options: { method: "GET", url: `${firstMedia.pathname}?mediaToken=unknown` },
      },
      {
        name: "media wrong material",
        options: {
          method: "GET",
          url: `/v1/letters/${first.letterId}/sources/${second.materialId}/content${firstMedia.search}`,
        },
      },
      {
        name: "media wrong letter",
        options: {
          method: "GET",
          url: `/v1/letters/${second.letterId}/sources/${first.materialId}/content${firstMedia.search}`,
        },
      },
    ];

    for (const request of requests) {
      const response = await app.inject(request.options);
      expect(response.statusCode, request.name).toBe(404);
      expect(errorCode(response), request.name).toBe("PUBLIC_ACCESS_NOT_FOUND");
    }
  });

  it("expires media before its parent share and preserves parent expiry semantics", async () => {
    let currentTime = new Date("2026-08-15T00:00:00.000Z");
    await rebuild({
      shareTokenTtlMs: 60_000,
      mediaTokenTtlMs: 10_000,
      now: () => currentTime,
    });
    const fixture = await publishFixture(app, "expiry");

    currentTime = new Date("2026-08-15T00:00:10.000Z");
    const expiredMedia = await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) });
    expect(expiredMedia.statusCode).toBe(410);
    expect(errorCode(expiredMedia)).toBe("MEDIA_TOKEN_EXPIRED");

    const refreshedReader = await app.inject({ method: "GET", url: fixture.readerUrl });
    expect(refreshedReader.statusCode).toBe(200);
    const refreshedMediaUrl = json<{
      reader: { sources: Array<{ mediaUrl?: string }> };
    }>(refreshedReader).reader.sources.find((source) => source.mediaUrl)?.mediaUrl;
    expect(refreshedMediaUrl).toBeTruthy();
    expect(refreshedMediaUrl).not.toBe(fixture.mediaUrl);

    currentTime = new Date("2026-08-15T00:01:00.000Z");
    const parentExpiredRequests: InjectOptions[] = [
      { method: "GET", url: fixture.readerUrl },
      { method: "GET", url: mediaPath(refreshedMediaUrl!) },
      {
        method: "POST",
        url: `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`,
        payload: { text: "已过期" },
      },
    ];
    for (const request of parentExpiredRequests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(410);
      expect(errorCode(response)).toBe("SHARE_TOKEN_EXPIRED");
    }
  });

  it("revokes old reader, media, and reply capabilities on reissue and explicit revoke", async () => {
    const fixture = await publishFixture(app, "revoke");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`,
          payload: { text: "重签前回复" },
        })
      ).statusCode,
    ).toBe(201);

    const reissue = await app.inject({
      method: "POST",
      url: `/v1/letters/${fixture.letterId}/share/reissue`,
      headers: auth(fixture.ownerToken),
    });
    expect(reissue.statusCode).toBe(200);
    const replacement = json<{ shareToken: string; readerUrl: string }>(reissue);
    const oldRequests: InjectOptions[] = [
      { method: "GET", url: fixture.readerUrl },
      { method: "GET", url: mediaPath(fixture.mediaUrl) },
      {
        method: "POST",
        url: `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`,
        payload: { text: "旧凭据不可回复" },
      },
    ];
    for (const request of oldRequests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(410);
      expect(errorCode(response)).toBe("SHARE_TOKEN_REVOKED");
    }

    const replacementReader = await app.inject({ method: "GET", url: replacement.readerUrl });
    expect(replacementReader.statusCode).toBe(200);
    expect(json<{ reader: { replies: unknown[] } }>(replacementReader).reader.replies).toHaveLength(1);
    const replacementMediaUrl = json<{
      reader: { sources: Array<{ mediaUrl?: string }> };
    }>(replacementReader).reader.sources.find((source) => source.mediaUrl)?.mediaUrl;
    const ownerBeforeRevoke = json<{ letter: { confirmedDraft?: unknown } }>(
      await app.inject({
        method: "GET",
        url: `/v1/letters/${fixture.letterId}`,
        headers: auth(fixture.ownerToken),
      }),
    ).letter;
    expect(ownerBeforeRevoke.confirmedDraft).toBeTruthy();

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/letters/${fixture.letterId}/share`,
          headers: auth(fixture.ownerToken),
        })
      ).statusCode,
    ).toBe(204);
    const revokedRequests: InjectOptions[] = [
      { method: "GET", url: replacement.readerUrl },
      { method: "GET", url: mediaPath(replacementMediaUrl!) },
      {
        method: "POST",
        url: `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(replacement.shareToken)}`,
        payload: { text: "撤销后不可回复" },
      },
    ];
    for (const request of revokedRequests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(410);
      expect(errorCode(response)).toBe("SHARE_TOKEN_REVOKED");
    }
    const ownerAfterRevoke = json<{ letter: { confirmedDraft?: unknown } }>(
      await app.inject({
        method: "GET",
        url: `/v1/letters/${fixture.letterId}`,
        headers: auth(fixture.ownerToken),
      }),
    ).letter;
    expect(ownerAfterRevoke.confirmedDraft).toEqual(ownerBeforeRevoke.confirmedDraft);
  });

  it("rate limits reader, media, reply, and invalid-token guessing with Retry-After", async () => {
    let currentTime = new Date("2026-08-15T00:00:00.000Z");
    await rebuild({
      now: () => currentTime,
      publicRateLimits: {
        windowMs: 1_000,
        reader: { perIp: 100, perCredential: 2 },
        media: { perIp: 100, perCredential: 1 },
        reply: { perIp: 100, perCredential: 1 },
      },
    });
    const first = await publishFixture(app, "limits-a");
    const secondReader = await app.inject({ method: "GET", url: first.readerUrl });
    expect(secondReader.statusCode).toBe(200);
    const limitedReader = await app.inject({ method: "GET", url: first.readerUrl });
    expect(limitedReader.statusCode).toBe(429);
    expect(errorCode(limitedReader)).toBe("RATE_LIMITED");
    expect(limitedReader.headers["retry-after"]).toBe("1");

    const second = await publishFixture(app, "limits-b");
    expect((await app.inject({ method: "GET", url: second.readerUrl })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: mediaPath(first.mediaUrl) })).statusCode).toBe(200);
    const firstMediaUrl = new URL(first.mediaUrl);
    const firstMediaToken = firstMediaUrl.searchParams.get("mediaToken")!;
    const aliasMedia = await app.inject({
      method: "GET",
      url: `${firstMediaUrl.pathname}?mediaToken=${encodeURIComponent(nonCanonicalMediaTokenAlias(firstMediaToken))}`,
      remoteAddress: "198.51.100.20",
    });
    expect(aliasMedia.statusCode).toBe(404);
    const limitedMedia = await app.inject({ method: "GET", url: mediaPath(first.mediaUrl) });
    expect(limitedMedia.statusCode).toBe(429);
    expect(limitedMedia.headers["retry-after"]).toBe("1");

    const replyUrl = `/v1/letters/${first.letterId}/replies?token=${encodeURIComponent(first.shareToken)}`;
    expect(
      (await app.inject({ method: "POST", url: replyUrl, payload: { text: "第一次回复" } })).statusCode,
    ).toBe(201);
    const limitedReply = await app.inject({
      method: "POST",
      url: replyUrl,
      payload: { text: "第二次回复" },
    });
    expect(limitedReply.statusCode).toBe(429);
    expect(limitedReply.headers["retry-after"]).toBe("1");

    currentTime = new Date("2026-08-15T00:00:01.001Z");
    expect((await app.inject({ method: "GET", url: first.readerUrl })).statusCode).toBe(200);

    await rebuild({
      publicRateLimits: {
        windowMs: 60_000,
        reader: { perIp: 2, perCredential: 100 },
      },
    });
    for (const token of ["guess-a", "guess-b"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/letters/unknown/reader?token=${token}`,
            remoteAddress: "198.51.100.10",
          })
        ).statusCode,
      ).toBe(404);
    }
    const guessedTooOften = await app.inject({
      method: "GET",
      url: "/v1/letters/unknown/reader?token=guess-c",
      remoteAddress: "198.51.100.10",
    });
    expect(guessedTooOften.statusCode).toBe(429);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/letters/unknown/reader?token=guess-d",
          remoteAddress: "198.51.100.11",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("rejects unsafe, oversized, invalid, and unchecked replies without storing them", async () => {
    await rebuild({
      publicRateLimits: {
        reply: { perIp: 50, perCredential: 50 },
      },
    });
    const fixture = await publishFixture(app, "reply-safety");
    const replyUrl = `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`;
    const oversizedBody = await app.inject({
      method: "POST",
      url: replyUrl,
      payload: { text: "好".repeat(9_000) },
    });
    expect(oversizedBody.statusCode).toBe(413);
    expect(
      (
        await app.inject({
          method: "POST",
          url: replyUrl,
          payload: { text: "好".repeat(240), authorName: "家人" },
        })
      ).statusCode,
    ).toBe(201);

    const rejected: Array<{ payload: Record<string, string>; status: number; code: string }> = [
      { payload: { text: "好".repeat(241) }, status: 400, code: "REPLY_TOO_LONG" },
      { payload: { text: "我要伤害你" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      { payload: { text: "教我怎么诈骗老人" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      { payload: { text: "给我看成人视频" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      { payload: { text: "你真是个废物" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      { payload: { text: "滚开，傻逼" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      { payload: { text: "某某族都是垃圾" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      { payload: { text: "去死吧" }, status: 422, code: "REPLY_CONTENT_REJECTED" },
      {
        payload: { text: "收到，谢谢", authorName: "某某族都是垃圾" },
        status: 422,
        code: "REPLY_CONTENT_REJECTED",
      },
      {
        payload: { text: "收到，谢谢", authorName: "滚开，傻逼" },
        status: 422,
        code: "REPLY_CONTENT_REJECTED",
      },
      { payload: { text: "正常\u0000内容" }, status: 400, code: "INVALID_REPLY" },
      {
        payload: { text: "称呼过长", authorName: "家".repeat(41) },
        status: 400,
        code: "INVALID_REPLY_AUTHOR",
      },
    ];
    for (const item of rejected) {
      const response = await app.inject({ method: "POST", url: replyUrl, payload: item.payload });
      expect(response.statusCode).toBe(item.status);
      expect(errorCode(response)).toBe(item.code);
    }

    const replies = await app.inject({
      method: "GET",
      url: `/v1/letters/${fixture.letterId}/replies`,
      headers: auth(fixture.ownerToken),
    });
    expect(json<{ replies: unknown[] }>(replies).replies).toHaveLength(1);

    const unavailablePolicy: ReplySafetyPolicy = {
      validate: () => new Promise<string>(() => undefined),
    };
    await rebuild({ replySafetyPolicy: unavailablePolicy, replySafetyTimeoutMs: 5 });
    const unavailableFixture = await publishFixture(app, "reply-policy-down");
    const unavailable = await app.inject({
      method: "POST",
      url: `/v1/letters/${unavailableFixture.letterId}/replies?token=${encodeURIComponent(unavailableFixture.shareToken)}`,
      payload: { text: "正常回复" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(errorCode(unavailable)).toBe("CONTENT_SAFETY_UNAVAILABLE");
    const stored = await app.inject({
      method: "GET",
      url: `/v1/letters/${unavailableFixture.letterId}/replies`,
      headers: auth(unavailableFixture.ownerToken),
    });
    expect(json<{ replies: unknown[] }>(stored).replies).toHaveLength(0);
  });

  it("keeps public DTOs and request logs free of private fields and raw credentials", async () => {
    const logLines: string[] = [];
    await rebuild({
      logger: true,
      loggerStream: { write(message) { logLines.push(message); } },
    });
    const fixture = await publishFixture(app, "logs");
    const reader = await app.inject({
      method: "GET",
      url: fixture.readerUrl,
      headers: { referer: `https://example.test/?token=${fixture.shareToken}` },
    });
    const readerBody = reader.body;
    for (const forbidden of ["shareToken", "tokenHash", "userId", "objectKey", "openId"]) {
      expect(readerBody).not.toContain(forbidden);
    }
    const mediaToken = new URL(fixture.mediaUrl).searchParams.get("mediaToken")!;
    await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) });
    const replyText = "日志中不能出现这段回复";
    await app.inject({
      method: "POST",
      url: `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`,
      headers: { referer: `https://example.test/?token=${fixture.shareToken}` },
      payload: { text: replyText },
    });

    const logs = logLines.join("");
    expect(logs).not.toContain(fixture.ownerToken);
    expect(logs).not.toContain(fixture.shareToken);
    expect(logs).not.toContain(mediaToken);
    expect(logs).not.toContain(replyText);
    expect(logs).not.toContain("?token=");
    expect(logs).not.toContain("?mediaToken=");
    expect(logs).not.toContain("objectKey");
  });

  it("marks anonymous authors as unverified and caps reply history growth", async () => {
    await rebuild({
      publicRateLimits: {
        reply: { perIp: 200, perCredential: 200 },
      },
    });
    const fixture = await publishFixture(app, "reply-cap");
    const replyUrl = `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`;
    for (let index = 0; index < 100; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: replyUrl,
        payload: { text: `第 ${index + 1} 条回复`, authorName: "妈妈" },
      });
      expect(response.statusCode).toBe(201);
      expect(json<{ reply: { authorVerified: boolean } }>(response).reply.authorVerified).toBe(false);
    }

    const overLimit = await app.inject({
      method: "POST",
      url: replyUrl,
      payload: { text: "超过总量的回复" },
    });
    expect(overLimit.statusCode).toBe(409);
    expect(errorCode(overLimit)).toBe("REPLY_LIMIT_REACHED");

    const reader = await app.inject({ method: "GET", url: fixture.readerUrl });
    expect(json<{ reader: { replies: unknown[] } }>(reader).reader.replies).toHaveLength(100);
  });

  it("atomically caps concurrent reply creation at 100 entries", async () => {
    const concurrentRequests = 120;
    let validationCount = 0;
    let releaseValidations: (() => void) | undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidations = resolve;
    });
    const synchronizedPolicy: ReplySafetyPolicy = {
      async validate(text) {
        validationCount += 1;
        if (validationCount === concurrentRequests) releaseValidations?.();
        await validationGate;
        return text.trim();
      },
    };
    await rebuild({
      replySafetyPolicy: synchronizedPolicy,
      replySafetyTimeoutMs: 5_000,
      publicRateLimits: {
        reply: { perIp: 200, perCredential: 200 },
      },
    });
    const fixture = await publishFixture(app, "concurrent-reply-cap");
    const replyUrl = `/v1/letters/${fixture.letterId}/replies?token=${encodeURIComponent(fixture.shareToken)}`;

    const responses = await Promise.all(
      Array.from({ length: concurrentRequests }, (_, index) =>
        app.inject({
          method: "POST",
          url: replyUrl,
          payload: { text: `并发回复 ${index + 1}` },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(100);
    const rejected = responses.filter((response) => response.statusCode === 409);
    expect(rejected).toHaveLength(20);
    expect(rejected.every((response) => errorCode(response) === "REPLY_LIMIT_REACHED")).toBe(true);

    const stored = await app.inject({
      method: "GET",
      url: `/v1/letters/${fixture.letterId}/replies`,
      headers: auth(fixture.ownerToken),
    });
    expect(json<{ replies: Array<{ id: string }> }>(stored).replies).toHaveLength(100);
    expect(new Set(json<{ replies: Array<{ id: string }> }>(stored).replies.map(({ id }) => id)).size)
      .toBe(100);
  });

  it("accepts a previous media signing key during rotation and rejects it after removal", async () => {
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    await rebuild({ mediaSigningKeys: [oldKey] });
    const fixture = await publishFixture(app, "key-rotation");
    expect((await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) })).statusCode).toBe(200);

    await app.close();
    app = buildApp({
      deploymentMode: "test",
      repository,
      objectStorage,
      publicBaseUrl: "https://reader.example.test",
      maxMediaUploadBytes: 1024,
      mediaSigningKeys: [newKey, oldKey],
    });
    expect((await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) })).statusCode).toBe(200);

    await app.close();
    app = buildApp({
      deploymentMode: "test",
      repository,
      objectStorage,
      publicBaseUrl: "https://reader.example.test",
      maxMediaUploadBytes: 1024,
      mediaSigningKeys: [newKey],
    });
    const removed = await app.inject({ method: "GET", url: mediaPath(fixture.mediaUrl) });
    expect(removed.statusCode).toBe(404);
    expect(errorCode(removed)).toBe("PUBLIC_ACCESS_NOT_FOUND");
  });
});
