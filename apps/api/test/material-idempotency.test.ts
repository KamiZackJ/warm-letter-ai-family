import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  ObjectAlreadyExistsError,
  type ObjectStorage,
  type StoredObject,
  type StoredObjectMetadata,
} from "../src/object-storage.js";
import { auth, json, login } from "./helpers.js";

class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  async put(
    objectKey: string,
    input: { bytes: Buffer; contentType: string },
  ): Promise<StoredObjectMetadata> {
    if (this.objects.has(objectKey)) throw new ObjectAlreadyExistsError();
    const stored = {
      bytes: Buffer.from(input.bytes),
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
    };
    this.objects.set(objectKey, stored);
    return { contentType: stored.contentType, sizeBytes: stored.sizeBytes };
  }

  async head(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    const stored = this.objects.get(objectKey);
    return stored
      ? { contentType: stored.contentType, sizeBytes: stored.sizeBytes }
      : undefined;
  }

  async read(objectKey: string): Promise<StoredObject | undefined> {
    const stored = this.objects.get(objectKey);
    return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : undefined;
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

function idempotentAuth(token: string, key: string): Record<string, string> {
  return { ...auth(token), "idempotency-key": key };
}

describe("material idempotency", () => {
  let app: FastifyInstance;
  let now: Date;

  beforeEach(() => {
    now = new Date("2026-08-16T08:00:00.000Z");
    app = buildApp({
      deploymentMode: "test",
      objectStorage: new MemoryObjectStorage(),
      publicBaseUrl: "https://uploads.example.test",
      now: () => now,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("replays text creation, rejects changed content, and isolates keys by user", async () => {
    const firstToken = await login(app, "material-text-owner-one");
    const secondToken = await login(app, "material-text-owner-two");
    const key = "text_1786867200000_retry01";
    const payload = { type: "text", name: "Daily note", textContent: "Dinner went well." };

    const first = await app.inject({
      method: "POST",
      url: "/v1/materials",
      headers: idempotentAuth(firstToken, key),
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/materials",
      headers: idempotentAuth(firstToken, key),
      payload: { ...payload, textContent: "  Dinner went well.  " },
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    const firstMaterial = json<{ material: { id: string } }>(first).material;
    expect(json<{ material: { id: string } }>(replay).material.id).toBe(firstMaterial.id);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/materials",
      headers: idempotentAuth(firstToken, key),
      payload: { ...payload, textContent: "Changed content." },
    });
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );

    const otherUser = await app.inject({
      method: "POST",
      url: "/v1/materials",
      headers: idempotentAuth(secondToken, key),
      payload,
    });
    expect(otherUser.statusCode).toBe(201);
    expect(json<{ material: { id: string } }>(otherUser).material.id).not.toBe(firstMaterial.id);

    const concurrentKey = "text_1786867200000_concurrent01";
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: "POST",
          url: "/v1/materials",
          headers: idempotentAuth(firstToken, concurrentKey),
          payload: { ...payload, textContent: "Created concurrently." },
        }),
      ),
    );
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(
      new Set(
        concurrent.map(
          (response) => json<{ material: { id: string } }>(response).material.id,
        ),
      ).size,
    ).toBe(1);

    const list = await app.inject({
      method: "GET",
      url: "/v1/materials",
      headers: auth(firstToken),
    });
    expect(json<{ materials: unknown[] }>(list).materials).toHaveLength(2);
  });

  it("recovers media retries without duplicate READY or orphaned UPLOADING materials", async () => {
    const token = await login(app, "material-media-owner");
    const key = "photo_1786867200000_retry01";
    const payload = {
      type: "photo",
      filename: "family.jpg",
      contentType: "image/jpeg",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: idempotentAuth(token, key),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstPresign = json<{
      materialId: string;
      objectKey: string;
      completed: boolean;
      uploadUrl: string;
      headers: Record<string, string>;
    }>(first);
    expect(firstPresign.completed).toBe(false);

    now = new Date("2026-08-16T08:00:02.000Z");
    const uploadingReplay = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: idempotentAuth(token, key),
      payload,
    });
    expect(uploadingReplay.statusCode).toBe(200);
    const replayedPresign = json<{
      materialId: string;
      objectKey: string;
      completed: boolean;
      uploadUrl: string;
      headers: Record<string, string>;
    }>(uploadingReplay);
    expect(replayedPresign).toMatchObject({
      materialId: firstPresign.materialId,
      objectKey: firstPresign.objectKey,
      completed: false,
      uploadUrl: firstPresign.uploadUrl,
    });
    expect(replayedPresign.headers).not.toEqual(firstPresign.headers);

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04]);
    const upload = await app.inject({
      method: "PUT",
      url: new URL(firstPresign.uploadUrl).pathname,
      headers: firstPresign.headers,
      payload: jpegBytes,
    });
    expect(upload.statusCode).toBe(204);

    const replayAfterLostUploadResponse = await app.inject({
      method: "PUT",
      url: new URL(replayedPresign.uploadUrl).pathname,
      headers: replayedPresign.headers,
      payload: jpegBytes,
    });
    expect(replayAfterLostUploadResponse.statusCode).toBe(409);
    expect(
      json<{ error: { code: string } }>(replayAfterLostUploadResponse).error.code,
    ).toBe("UPLOAD_ALREADY_RECEIVED");

    const complete = await app.inject({
      method: "POST",
      url: "/v1/materials/complete",
      headers: auth(token),
      payload: { materialId: firstPresign.materialId },
    });
    expect(complete.statusCode).toBe(200);
    expect(json<{ material: { status: string } }>(complete).material.status).toBe("READY");

    const completeReplay = await app.inject({
      method: "POST",
      url: "/v1/materials/complete",
      headers: auth(token),
      payload: { materialId: firstPresign.materialId },
    });
    expect(completeReplay.statusCode).toBe(200);
    expect(json<{ material: { id: string } }>(completeReplay).material.id).toBe(
      firstPresign.materialId,
    );

    const replayAfterLostCompleteResponse = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: idempotentAuth(token, key),
      payload,
    });
    expect(replayAfterLostCompleteResponse.statusCode).toBe(200);
    expect(
      json<{
        materialId: string;
        objectKey: string;
        completed: boolean;
        material: { id: string; status: string };
        uploadUrl?: string;
        headers?: Record<string, string>;
      }>(replayAfterLostCompleteResponse),
    ).toEqual({
      materialId: firstPresign.materialId,
      objectKey: firstPresign.objectKey,
      completed: true,
      material: expect.objectContaining({ id: firstPresign.materialId, status: "READY" }),
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/materials/presign",
      headers: idempotentAuth(token, key),
      payload: { ...payload, filename: "different.jpg" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );

    const list = await app.inject({
      method: "GET",
      url: "/v1/materials",
      headers: auth(token),
    });
    expect(json<{ materials: Array<{ id: string; status: string }> }>(list).materials).toEqual([
      expect.objectContaining({ id: firstPresign.materialId, status: "READY" }),
    ]);
  });
});
