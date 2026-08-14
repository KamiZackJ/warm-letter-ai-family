import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { FileSystemObjectStorage } from "../src/object-storage.js";
import { auth, json, login, registerTextMaterial, waitForJob } from "./helpers.js";

async function uploadMediaMaterial(
  app: FastifyInstance,
  token: string,
  input: {
    type: "photo" | "screenshot" | "audio";
    filename: string;
    contentType: string;
    bytes: Buffer;
  },
): Promise<string> {
  const presignResponse = await app.inject({
    method: "POST",
    url: "/v1/materials/presign",
    headers: auth(token),
    payload: input,
  });
  expect(presignResponse.statusCode).toBe(201);
  const presigned = json<{ materialId: string }>(presignResponse);
  const uploadResponse = await app.inject({
    method: "PUT",
    url: `/v1/materials/${presigned.materialId}/content`,
    headers: { ...auth(token), "content-type": input.contentType },
    payload: input.bytes,
  });
  expect(uploadResponse.statusCode).toBe(204);
  const completeResponse = await app.inject({
    method: "POST",
    url: "/v1/materials/complete",
    headers: auth(token),
    payload: { materialId: presigned.materialId },
  });
  expect(completeResponse.statusCode).toBe(200);
  return presigned.materialId;
}

describe("Warm Letter API", () => {
  let app: FastifyInstance;
  let objectStorage: FileSystemObjectStorage;
  let uploadDirectory: string;

  beforeEach(async () => {
    uploadDirectory = await mkdtemp(join(tmpdir(), "warm-letter-api-"));
    objectStorage = new FileSystemObjectStorage(uploadDirectory);
    app = buildApp({
      objectStorage,
      publicBaseUrl: "https://uploads.example.test",
      maxMediaUploadBytes: 1024,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  it("reports health and requires a development login for private data", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(json(health)).toEqual({ status: "ok", service: "warm-letter-api" });

    const privateResponse = await app.inject({ method: "GET", url: "/v1/materials" });
    expect(privateResponse.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(privateResponse).error.code).toBe("UNAUTHORIZED");
  });

  it("allows configured browser origins and rejects unconfigured origins", async () => {
    await app.close();
    app = buildApp({ corsOrigins: ["https://reader.example.com"] });

    const allowedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/letters/example/reader",
      headers: {
        origin: "https://reader.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(allowedPreflight.statusCode).toBe(204);
    expect(allowedPreflight.headers["access-control-allow-origin"]).toBe(
      "https://reader.example.com",
    );

    const rejectedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/letters/example/reader",
      headers: {
        origin: "https://untrusted.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(rejectedPreflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("starts generation through a real HTTP listener", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const loginResponse = await fetch(`${address}/v1/auth/wx-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "http-smoke" }),
    });
    const loginBody = (await loginResponse.json()) as { token: string };
    const headers = {
      authorization: `Bearer ${loginBody.token}`,
      "content-type": "application/json",
    };
    const materialResponse = await fetch(`${address}/v1/materials`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "text", name: "smoke.txt", textContent: "hello" }),
    });
    const materialBody = (await materialResponse.json()) as { material: { id: string } };
    const letterResponse = await fetch(`${address}/v1/letters`, {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient: "Mom", materialIds: [materialBody.material.id] }),
    });
    const letterBody = (await letterResponse.json()) as { letter: { id: string } };
    const invalidEmptyJsonResponse = await fetch(
      `${address}/v1/letters/${letterBody.letter.id}/generate`,
      { method: "POST", headers },
    );
    expect(invalidEmptyJsonResponse.status).toBe(400);

    const generationResponse = await fetch(
      `${address}/v1/letters/${letterBody.letter.id}/generate`,
      { method: "POST", headers: { authorization: headers.authorization } },
    );

    expect(generationResponse.status).toBe(202);
  });

  it("completes the demonstrable four-material generation, edit, publish, read, and reply loop", async () => {
    const token = await login(app);
    const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const materialIds = await Promise.all([
      uploadMediaMaterial(app, token, {
        type: "photo",
        filename: "family-dinner.jpg",
        contentType: "image/jpeg",
        bytes: photoBytes,
      }),
      uploadMediaMaterial(app, token, {
        type: "screenshot",
        filename: "good-news.png",
        contentType: "image/png",
        bytes: Buffer.from("89504e470d0a1a0a", "hex"),
      }),
      uploadMediaMaterial(app, token, {
        type: "audio",
        filename: "voice-note.m4a",
        contentType: "audio/mp4",
        bytes: Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x34, 0x61, 0x20]),
      }),
      registerTextMaterial(app, token, "I learned a new recipe and thought of Mom."),
    ]);

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: {
        recipient: "Mom",
        materialIds,
        settings: { tone: "warm", length: "short", focus: "I am doing well." },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const letterId = json<{ letter: { id: string; state: string } }>(createResponse).letter.id;

    const unconfirmedReader = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}/reader?token=guessed`,
    });
    expect(unconfirmedReader.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(unconfirmedReader).error.code).toBe(
      "LETTER_NOT_PUBLISHED",
    );

    const generationResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: auth(token),
    });
    expect(generationResponse.statusCode).toBe(202);
    const jobId = json<{ job: { id: string } }>(generationResponse).job.id;
    expect(await waitForJob(app, token, jobId)).toMatchObject({ status: "succeeded" });

    const generatedResponse = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}`,
      headers: auth(token),
    });
    const generated = json<{
      letter: {
        state: string;
        draft: { paragraphs: Array<{ text: string; sourceRefs: string[] }> };
      };
    }>(generatedResponse).letter;
    expect(generated.state).toBe("EDITING");
    const tracedSources = new Set(generated.draft.paragraphs.flatMap((item) => item.sourceRefs));
    expect(tracedSources).toEqual(new Set(materialIds));

    const editedParagraphs = generated.draft.paragraphs.map((paragraph, index) => ({
      text: index === 0 ? "I edited this paragraph before sharing it with you." : paragraph.text,
      sourceRefs: paragraph.sourceRefs,
    }));
    const editResponse = await app.inject({
      method: "PATCH",
      url: `/v1/letters/${letterId}`,
      headers: auth(token),
      payload: { draft: { paragraphs: editedParagraphs } },
    });
    expect(editResponse.statusCode).toBe(200);

    const confirmResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/confirm`,
      headers: auth(token),
    });
    expect(confirmResponse.statusCode).toBe(200);
    const confirmed = json<{
      letter: { state: string };
      shareToken: string;
      shareExpiresAt: string;
      readerUrl: string;
    }>(confirmResponse);
    expect(confirmed.letter.state).toBe("PUBLISHED");
    expect(confirmed.shareToken).toHaveLength(43);
    expect(Date.parse(confirmed.shareExpiresAt)).toBeGreaterThan(Date.now());
    expect(confirmed.letter).not.toHaveProperty("shareToken");

    const readerResponse = await app.inject({ method: "GET", url: confirmed.readerUrl });
    expect(readerResponse.statusCode).toBe(200);
    const reader = json<{
      reader: {
        draft: { paragraphs: Array<{ text: string; sourceRefs: string[] }> };
        sources: Array<{ id: string; type: string; mediaUrl?: string; mediaExpiresAt?: string }>;
      };
    }>(readerResponse).reader;
    expect(reader.draft.paragraphs[0]?.text).toBe(
      "I edited this paragraph before sharing it with you.",
    );
    expect(reader.draft.paragraphs[0]?.sourceRefs).toEqual([materialIds[0]]);
    const photoSource = reader.sources.find((source) => source.id === materialIds[0]);
    expect(photoSource).toMatchObject({
      type: "photo",
      mediaUrl: expect.stringContaining(`/sources/${materialIds[0]}/content?token=`),
      mediaExpiresAt: confirmed.shareExpiresAt,
    });
    const textSource = reader.sources.find((source) => source.id === materialIds[3]);
    expect(textSource).not.toHaveProperty("mediaUrl");
    const mediaUrl = new URL(photoSource!.mediaUrl!);
    const publicMediaResponse = await app.inject({
      method: "GET",
      url: `${mediaUrl.pathname}${mediaUrl.search}`,
    });
    expect(publicMediaResponse.statusCode).toBe(200);
    expect(publicMediaResponse.rawPayload).toEqual(photoBytes);

    const wrongTokenResponse = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}/reader?token=wrong-token`,
    });
    expect(wrongTokenResponse.statusCode).toBe(403);

    const editAfterPublishResponse = await app.inject({
      method: "PATCH",
      url: `/v1/letters/${letterId}`,
      headers: auth(token),
      payload: { recipient: "Someone else" },
    });
    expect(editAfterPublishResponse.statusCode).toBe(409);

    const replyResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/replies?token=${encodeURIComponent(confirmed.shareToken)}`,
      payload: { text: "I read it. Take care of yourself.", authorName: "Mom" },
    });
    expect(replyResponse.statusCode).toBe(201);

    const repliesResponse = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}/replies`,
      headers: auth(token),
    });
    expect(json<{ replies: Array<{ text: string; authorName: string }> }>(repliesResponse).replies)
      .toEqual([
        expect.objectContaining({
          text: "I read it. Take care of yourself.",
          authorName: "Mom",
        }),
      ]);

    const reissueResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/share/reissue`,
      headers: auth(token),
    });
    expect(reissueResponse.statusCode).toBe(200);
    const reissued = json<{ shareToken: string; readerUrl: string }>(reissueResponse);
    expect(reissued.shareToken).not.toBe(confirmed.shareToken);
    expect((await app.inject({ method: "GET", url: confirmed.readerUrl })).statusCode).toBe(410);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${mediaUrl.pathname}${mediaUrl.search}`,
        })
      ).statusCode,
    ).toBe(410);
    expect((await app.inject({ method: "GET", url: reissued.readerUrl })).statusCode).toBe(200);

    const revokeResponse = await app.inject({
      method: "DELETE",
      url: `/v1/letters/${letterId}/share`,
      headers: auth(token),
    });
    expect(revokeResponse.statusCode).toBe(204);
    const revokedReply = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/replies?token=${encodeURIComponent(reissued.shareToken)}`,
      payload: { text: "This must not be accepted." },
    });
    expect(revokedReply.statusCode).toBe(410);
  });

  it("rejects generation, draft editing, and confirmation from illegal states", async () => {
    const token = await login(app);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "Dad" },
    });
    const letterId = json<{ letter: { id: string } }>(createResponse).letter.id;

    for (const request of [
      { method: "POST" as const, url: `/v1/letters/${letterId}/generate` },
      {
        method: "PATCH" as const,
        url: `/v1/letters/${letterId}`,
        payload: { draft: { title: "Not generated" } },
      },
      { method: "POST" as const, url: `/v1/letters/${letterId}/confirm` },
    ]) {
      const response = await app.inject({ ...request, headers: auth(token) });
      expect(response.statusCode).toBe(409);
    }
  });

  it("soft-deletes materials and prevents deleted evidence from entering generation", async () => {
    const token = await login(app);
    const materialId = await registerTextMaterial(app, token);
    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/v1/materials/${materialId}`,
      headers: auth(token),
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/materials",
      headers: auth(token),
    });
    expect(
      json<{ materials: Array<{ id: string; status: string; deletedAt?: string }> }>(listResponse)
        .materials,
    ).toEqual([
      expect.objectContaining({ id: materialId, status: "DELETED", deletedAt: expect.any(String) }),
    ]);

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "Grandma", materialIds: [materialId] },
    });
    expect(createResponse.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(createResponse).error.code).toBe("MATERIAL_NOT_READY");
  });

  it("keeps an existing letter unpublished if a referenced material is deleted before generation", async () => {
    const token = await login(app);
    const materialId = await registerTextMaterial(app, token);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "Grandpa", materialIds: [materialId] },
    });
    const letterId = json<{ letter: { id: string } }>(createResponse).letter.id;

    await app.inject({
      method: "DELETE",
      url: `/v1/materials/${materialId}`,
      headers: auth(token),
    });
    const generationResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: auth(token),
    });
    expect(generationResponse.statusCode).toBe(409);

    const readerResponse = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}/reader?token=anything`,
    });
    expect(readerResponse.statusCode).toBe(409);
  });

  it("blocks confirmation if source evidence is deleted after a draft was generated", async () => {
    const token = await login(app);
    const materialId = await registerTextMaterial(app, token);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "Mom", materialIds: [materialId] },
    });
    const letterId = json<{ letter: { id: string } }>(createResponse).letter.id;
    const generationResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: auth(token),
    });
    const jobId = json<{ job: { id: string } }>(generationResponse).job.id;
    await waitForJob(app, token, jobId);

    await app.inject({
      method: "DELETE",
      url: `/v1/materials/${materialId}`,
      headers: auth(token),
    });
    const confirmResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/confirm`,
      headers: auth(token),
    });
    expect(confirmResponse.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(confirmResponse).error.code).toBe(
      "MATERIAL_NOT_READY",
    );
  });

  it("rejects client-supplied media object keys outside the upload flow", async () => {
    const token = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/materials",
      headers: auth(token),
      payload: {
        type: "photo",
        name: "bypass.jpg",
        contentType: "image/jpeg",
        objectKey: "forged/object-key.jpg",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(response).error.code).toBe(
      "MEDIA_UPLOAD_REQUIRED",
    );
  });

  it("uploads, completes, reads, and physically deletes real media bytes", async () => {
    const token = await login(app);
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const presignResponse = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: auth(token),
      payload: { type: "photo", filename: "morning.jpg", contentType: "image/jpeg" },
    });
    expect(presignResponse.statusCode).toBe(201);
    const presigned = json<{
      materialId: string;
      objectKey: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }>(presignResponse);
    expect(presigned.uploadUrl).toBe(
      `https://uploads.example.test/v1/materials/${presigned.materialId}/content`,
    );
    expect(presigned.uploadUrl).not.toContain(presigned.objectKey);
    expect(presigned.headers).toEqual({ "content-type": "image/jpeg" });

    const beforeUpload = await app.inject({
      method: "GET",
      url: "/v1/materials",
      headers: auth(token),
    });
    expect(
      json<{ materials: Array<{ id: string; status: string }> }>(beforeUpload).materials.find(
        (material) => material.id === presigned.materialId,
      )?.status,
    ).toBe("UPLOADING");

    const missingUploadComplete = await app.inject({
      method: "POST",
      url: "/v1/materials/complete",
      headers: auth(token),
      payload: { materialId: presigned.materialId },
    });
    expect(missingUploadComplete.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(missingUploadComplete).error.code).toBe(
      "UPLOAD_NOT_FOUND",
    );

    const uploadResponse = await app.inject({
      method: "PUT",
      url: new URL(presigned.uploadUrl).pathname,
      headers: { ...auth(token), ...presigned.headers },
      payload: jpegBytes,
    });
    expect(uploadResponse.statusCode).toBe(204);
    expect(await objectStorage.read(presigned.objectKey)).toEqual({
      bytes: jpegBytes,
      contentType: "image/jpeg",
      sizeBytes: jpegBytes.length,
    });
    const uploadedButNotCompleted = await app.inject({
      method: "GET",
      url: "/v1/materials",
      headers: auth(token),
    });
    expect(
      json<{ materials: Array<{ id: string; status: string }> }>(
        uploadedButNotCompleted,
      ).materials.find((material) => material.id === presigned.materialId)?.status,
    ).toBe("UPLOADING");

    const completeResponse = await app.inject({
      method: "POST",
      url: "/v1/materials/complete",
      headers: auth(token),
      payload: { materialId: presigned.materialId },
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(json<{ material: { status: string } }>(completeResponse).material.status).toBe("READY");

    const readResponse = await app.inject({
      method: "GET",
      url: new URL(presigned.uploadUrl).pathname,
      headers: auth(token),
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.headers["content-type"]).toBe("image/jpeg");
    expect(readResponse.rawPayload).toEqual(jpegBytes);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/v1/materials/${presigned.materialId}`,
      headers: auth(token),
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(await objectStorage.read(presigned.objectKey)).toBeUndefined();

    const readAfterDelete = await app.inject({
      method: "GET",
      url: new URL(presigned.uploadUrl).pathname,
      headers: auth(token),
    });
    expect(readAfterDelete.statusCode).toBe(404);
  });

  it("transfers uploaded media through a real HTTP listener", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const loginResponse = await fetch(`${address}/v1/auth/wx-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "media-http-owner" }),
    });
    const token = ((await loginResponse.json()) as { token: string }).token;
    const authorization = `Bearer ${token}`;
    const presignResponse = await fetch(`${address}/v1/materials/presign`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        type: "photo",
        filename: "http-upload.jpg",
        contentType: "image/jpeg",
      }),
    });
    const presigned = (await presignResponse.json()) as {
      materialId: string;
      uploadUrl: string;
    };
    const contentPath = new URL(presigned.uploadUrl).pathname;
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x4a, 0x46, 0x49, 0x46]);

    const uploadResponse = await fetch(`${address}${contentPath}`, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg" },
      body: jpegBytes,
    });
    expect(uploadResponse.status).toBe(204);

    const completeResponse = await fetch(`${address}/v1/materials/complete`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ materialId: presigned.materialId }),
    });
    expect(completeResponse.status).toBe(200);

    const readResponse = await fetch(`${address}${contentPath}`, {
      headers: { authorization },
    });
    expect(readResponse.status).toBe(200);
    expect(Buffer.from(await readResponse.arrayBuffer())).toEqual(jpegBytes);
  });

  it("enforces material ownership across upload, completion, and controlled reads", async () => {
    const ownerToken = await login(app, "media-owner");
    const otherToken = await login(app, "other-user");
    const presignResponse = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: auth(ownerToken),
      payload: { type: "photo", filename: "family.jpg", contentType: "image/jpeg" },
    });
    const presigned = json<{ materialId: string; objectKey: string; uploadUrl: string }>(
      presignResponse,
    );
    const uploadPath = new URL(presigned.uploadUrl).pathname;
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    for (const attempt of [
      app.inject({
        method: "PUT",
        url: uploadPath,
        headers: { ...auth(otherToken), "content-type": "image/jpeg" },
        payload: jpegBytes,
      }),
      app.inject({
        method: "POST",
        url: "/v1/materials/complete",
        headers: auth(otherToken),
        payload: { materialId: presigned.materialId },
      }),
      app.inject({ method: "GET", url: uploadPath, headers: auth(otherToken) }),
    ]) {
      expect((await attempt).statusCode).toBe(404);
    }
    expect(await objectStorage.read(presigned.objectKey)).toBeUndefined();

    const ownerUpload = await app.inject({
      method: "PUT",
      url: uploadPath,
      headers: { ...auth(ownerToken), "content-type": "image/jpeg" },
      payload: jpegBytes,
    });
    expect(ownerUpload.statusCode).toBe(204);
  });

  it("rejects mismatched extensions, MIME headers, and forged binary signatures", async () => {
    const token = await login(app);
    const extensionMismatch = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: auth(token),
      payload: { type: "photo", filename: "family.png", contentType: "image/jpeg" },
    });
    expect(extensionMismatch.statusCode).toBe(415);

    const presignResponse = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: auth(token),
      payload: { type: "photo", filename: "family.jpg", contentType: "image/jpeg" },
    });
    const presigned = json<{ objectKey: string; uploadUrl: string }>(presignResponse);
    const uploadPath = new URL(presigned.uploadUrl).pathname;

    const wrongMime = await app.inject({
      method: "PUT",
      url: uploadPath,
      headers: { ...auth(token), "content-type": "image/png" },
      payload: Buffer.from("89504e470d0a1a0a", "hex"),
    });
    expect(wrongMime.statusCode).toBe(415);
    expect(json<{ error: { code: string } }>(wrongMime).error.code).toBe("MIME_MISMATCH");

    const forgedJpeg = await app.inject({
      method: "PUT",
      url: uploadPath,
      headers: { ...auth(token), "content-type": "image/jpeg" },
      payload: Buffer.from("this is not a jpeg"),
    });
    expect(forgedJpeg.statusCode).toBe(415);
    expect(json<{ error: { code: string } }>(forgedJpeg).error.code).toBe(
      "INVALID_MEDIA_CONTENT",
    );
    expect(await objectStorage.read(presigned.objectKey)).toBeUndefined();
  });

  it("rejects media larger than the configured upload limit", async () => {
    await app.close();
    app = buildApp({
      objectStorage,
      publicBaseUrl: "https://uploads.example.test",
      maxMediaUploadBytes: 8,
    });
    const token = await login(app);
    const presignResponse = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: auth(token),
      payload: { type: "photo", filename: "large.jpg", contentType: "image/jpeg" },
    });
    const presigned = json<{ objectKey: string; uploadUrl: string }>(presignResponse);
    const uploadPath = new URL(presigned.uploadUrl).pathname;
    const tooLargeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);

    const uploadResponse = await app.inject({
      method: "PUT",
      url: uploadPath,
      headers: { ...auth(token), "content-type": "image/jpeg" },
      payload: tooLargeJpeg,
    });
    expect(uploadResponse.statusCode).toBe(413);
    expect(await objectStorage.read(presigned.objectKey)).toBeUndefined();
  });
});
