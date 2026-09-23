import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSafetyMaterial } from "../src/safety-materials.js";
import { MemoryRepository } from "../src/repository.js";
import type { ObjectStorage, StoredObject } from "../src/object-storage.js";
import type { Material } from "../src/domain.js";
import type { ReviewMedia } from "../src/media-safety-transcode.js";

const mp3 = Buffer.from("49443301000000000000", "hex");
const mp4 = Buffer.from("0000000c667479706d346120", "hex");
const now = new Date().toISOString();
const temporaryDirectory = join(tmpdir(), "safety-material-test");
afterEach(() => vi.useRealTimers());

function setup(status: Material["status"] = "READY") {
  const repository = new MemoryRepository();
  repository.saveUser({ id: "owner", openId: "open", displayName: "称呼", createdAt: now });
  const material = repository.saveMaterial({ id: "media", userId: "owner", type: "audio", name: "录音.m4a", objectKey: "owner/source.m4a", contentType: "audio/mp4", status, createdAt: now });
  const objects = new Map<string, StoredObject>([[material.objectKey!, { bytes: mp4, contentType: "audio/mp4", sizeBytes: mp4.length }]]);
  const put = vi.fn<ObjectStorage["put"]>(async (key, value) => {
    const metadata = { sizeBytes: value.bytes.length, contentType: value.contentType };
    objects.set(key, { ...value, ...metadata });
    return metadata;
  });
  const storage: ObjectStorage = { put, read: async (key) => objects.get(key), head: async (key) => objects.get(key), delete: async (key) => { objects.delete(key); } };
  const prepareMedia = vi.fn(async (_input: ReviewMedia) => ({ bytes: mp3, contentType: "audio/mpeg" }));
  return { repository, material, objects, storage, put, prepareMedia, options: { temporaryDirectory, prepareMedia } };
}

describe("normalizing legacy and current safety materials", () => {
  it.each(["READY", "UPLOADING"] as const)("converts %s media, invalidates old review, and atomically schedules only the old file", async (status) => {
    const { repository, storage, material, options, put } = setup(status);
    repository.saveMediaSafetyCheck({ traceId: "old-pass", materialId: material.id, userId: material.userId, status: "pass", createdAt: now, updatedAt: now });
    const saved = await normalizeSafetyMaterial(repository, storage, material, options);
    expect(saved).toMatchObject({ id: material.id, status, contentType: "audio/mpeg", name: "录音.mp3" });
    expect(saved.objectKey).not.toBe(material.objectKey);
    expect(repository.getLatestMediaSafetyCheck(material.id)).toBeUndefined();
    expect(repository.listObjectDeletions()).toEqual([material.objectKey]);
    expect(put).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent requests and reads the persisted latest object for stale callers", async () => {
    const { repository, storage, material, options, prepareMedia, put } = setup();
    const first = normalizeSafetyMaterial(repository, storage, material, options);
    const second = normalizeSafetyMaterial(repository, storage, material, options);
    expect(first).toBe(second);
    const saved = await first;
    await second;
    expect(prepareMedia).toHaveBeenCalledOnce();
    await expect(normalizeSafetyMaterial(repository, storage, material, { temporaryDirectory })).resolves.toEqual(saved);
    expect(put).toHaveBeenCalledOnce();
  });

  it("does not recreate a deleted material after asynchronous conversion", async () => {
    const { repository, storage, material, options, put } = setup();
    options.prepareMedia.mockImplementationOnce(async () => {
      repository.saveMaterial({ ...material, status: "DELETED" });
      return { bytes: mp3, contentType: "audio/mpeg" };
    });
    await expect(normalizeSafetyMaterial(repository, storage, material, options)).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });
    expect(put).not.toHaveBeenCalled();
    expect(repository.getMaterial(material.id)?.status).toBe("DELETED");
  });

  it.each(["deletion", "replacement"])("discards a new file losing its CAS to %s", async (change) => {
    const { repository, storage, material, options, put } = setup();
    put.mockImplementationOnce(async (_key, value) => {
      repository.saveMaterial(change === "deletion" ? { ...material, status: "DELETED" } : { ...material, objectKey: "winner.mp3", contentType: "audio/mpeg" });
      return { contentType: value.contentType, sizeBytes: value.bytes.length };
    });
    await expect(normalizeSafetyMaterial(repository, storage, material, options)).rejects.toMatchObject({ code: change === "deletion" ? "MATERIAL_NOT_FOUND" : "MATERIAL_CHANGED" });
    const newKey = put.mock.calls[0]![0];
    expect(repository.listObjectDeletions()).toEqual([newKey]);
    expect(repository.getMaterial(material.id)?.objectKey).toBe(change === "deletion" ? material.objectKey : "winner.mp3");
  });

  it("queues cleanup even when a storage error happens after committing the new bytes", async () => {
    const { repository, storage, material, options, put } = setup();
    put.mockRejectedValueOnce(new Error("synthetic storage interruption"));
    await expect(normalizeSafetyMaterial(repository, storage, material, options)).rejects.toThrow("synthetic storage interruption");
    expect(repository.getMaterial(material.id)).toEqual(material);
    expect(repository.listObjectDeletions()).toEqual([put.mock.calls[0]![0]]);
  });

  it("re-enqueues a timed-out write when it completes after an earlier cleanup attempt", async () => {
    vi.useFakeTimers();
    const { repository, storage, material, options, put } = setup();
    let finish!: () => void;
    put.mockImplementationOnce((_key, value) => new Promise((resolve) => {
      finish = () => resolve({ contentType: value.contentType, sizeBytes: value.bytes.length });
    }));
    const result = normalizeSafetyMaterial(repository, storage, material, { ...options, timeoutMs: 500 })
      .then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ code: "MEDIA_REVIEW_PREPARATION_TIMEOUT" });
    const newKey = put.mock.calls[0]![0];
    repository.completeObjectDeletion(newKey);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.listObjectDeletions()).toEqual([newKey]);
    expect(repository.getMaterial(material.id)).toEqual(material);
  });

  it("fails closed for legacy unsupported images and changed stored metadata", async () => {
    const { repository, storage, material, objects, prepareMedia, put } = setup();
    const image = repository.saveMaterial({ ...material, type: "photo", contentType: "image/webp", name: "old.webp" });
    objects.set(image.objectKey!, { bytes: Buffer.from("RIFF0000WEBP"), contentType: "image/webp", sizeBytes: 12 });
    await expect(normalizeSafetyMaterial(repository, storage, image, { temporaryDirectory })).rejects.toMatchObject({ code: "UNSUPPORTED_SAFETY_MEDIA" });
    objects.set(image.objectKey!, { bytes: mp3, contentType: "audio/mpeg", sizeBytes: mp3.length });
    await expect(normalizeSafetyMaterial(repository, storage, image, { temporaryDirectory, prepareMedia })).rejects.toMatchObject({ code: "UPLOAD_METADATA_MISMATCH" });
    expect(prepareMedia).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
