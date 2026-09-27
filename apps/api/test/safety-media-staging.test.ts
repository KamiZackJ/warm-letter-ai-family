import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "../src/repository.js";
import type { Material } from "../src/domain.js";
import type { ObjectStorage } from "../src/object-storage.js";
import { SafetyMediaStaging, type SafetyMediaRemoteStore, type SafetyMediaStagingOptions } from "../src/safety-media-staging.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("private media review staging lifecycle", () => {
  let directory: string;
  let now: number;
  let repository: MemoryRepository;
  let material: Material;
  let remoteObjects: Map<string, Buffer>;
  let remote: SafetyMediaRemoteStore;
  let staging: SafetyMediaStaging;
  let instances: SafetyMediaStaging[];
  let storage: ObjectStorage;

  function create(options: Partial<SafetyMediaStagingOptions> = {}) {
    const result = new SafetyMediaStaging({ directory, repository, objectStorage: storage, remote, now: () => new Date(now), ...options });
    instances.push(result);
    return result;
  }

  async function journal() {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json") && name !== "context.json");
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, any>));
  }

  function check(traceId: string, status: "pending" | "pass" | "reject" | "failed") {
    repository.saveMediaSafetyCheck({ traceId, materialId: material.id, userId: material.userId, status,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "warm-letter-review-staging-"));
    now = Date.parse("2026-09-27T10:00:00.000Z");
    instances = [];
    repository = new MemoryRepository();
    repository.saveUser({ id: "user", openId: "synthetic-openid", displayName: "我", createdAt: new Date(now).toISOString() });
    material = repository.saveMaterial({ id: "material", userId: "user", type: "photo", name: "private-name.jpg",
      contentType: "image/jpeg", objectKey: "user/private-source.jpg", status: "READY", createdAt: new Date(now).toISOString() });
    const bytes = Buffer.from("ffd8ffd9", "hex");
    storage = { read: vi.fn(async () => ({ bytes, contentType: "image/jpeg", sizeBytes: bytes.length })), put: vi.fn(), head: vi.fn(), delete: vi.fn() };
    remoteObjects = new Map();
    remote = {
      put: vi.fn(async (key, input) => { remoteObjects.set(key, input.bytes); }),
      delete: vi.fn(async (key) => { remoteObjects.delete(key); }),
      signedGetUrl: vi.fn(async (key) => `https://synthetic.oss.example/${key}?signature=private-signed-token`),
    };
    staging = create();
  });

  afterEach(async () => {
    for (const instance of instances) instance.close();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it("durably records an opaque object key before PUT and never writes media bytes, names or signed URLs to the journal", async () => {
    vi.mocked(remote.put).mockImplementationOnce(async (key, input, signal) => {
      const records = await journal();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ state: "uploading", objectKey: key, materialId: material.id });
      expect(key).toMatch(/^wechat-safety\/[0-9a-f-]+\.jpg$/u);
      expect(signal.aborted).toBe(false);
      remoteObjects.set(key, input.bytes);
    });
    const url = await staging.prepare(material);
    expect(url).toContain("https://synthetic.oss.example/");
    const records = await journal();
    expect(records[0]).toMatchObject({ state: "ready", uploadSettled: true, expiresAt: now + 45 * 60_000 });
    expect(JSON.stringify(records)).not.toMatch(/private-name|private-source|signature=|synthetic-openid|ffd8ffd9/u);
    expect(remote.signedGetUrl).toHaveBeenCalledWith(records[0]!.objectKey, new Date(now + 45 * 60_000), expect.any(AbortSignal));
  });

  it("coalesces concurrent preparation and reuses an unsubmitted copy without extending its expiration", async () => {
    const upload = deferred<void>();
    vi.mocked(remote.put).mockImplementationOnce(async () => upload.promise);
    const first = staging.prepare(material);
    const second = staging.prepare(material);
    await vi.waitFor(() => expect(remote.put).toHaveBeenCalledOnce());
    upload.resolve();
    expect(await first).toBe(await second);
    now += 10_000;
    await staging.prepare(material);
    expect(remote.put).toHaveBeenCalledOnce();
    expect(await journal()).toHaveLength(1);
    expect(vi.mocked(remote.signedGetUrl).mock.calls[1]![1].getTime()).toBe(now - 10_000 + 45 * 60_000);
  });

  it("ignores the old failed check, but cleans the copy after a new terminal receipt", async () => {
    check("old-failed", "failed");
    await staging.prepare(material);
    await staging.sweep();
    expect(remote.delete).not.toHaveBeenCalled();
    expect(await journal()).toHaveLength(1);
    now += 1000;
    check("new-check", "pending");
    await staging.sweep();
    expect(remote.delete).not.toHaveBeenCalled();
    check("new-check", "pass");
    await staging.sweep();
    expect(remoteObjects.size).toBe(0);
    expect(await journal()).toEqual([]);
  });

  it("retires an old failed attempt without cancelling a new upload for the same material", async () => {
    await staging.prepare(material);
    now += 1000;
    check("failed-attempt", "failed");
    const upload = deferred<void>();
    vi.mocked(remote.put).mockImplementationOnce(async (key, input) => { await upload.promise; remoteObjects.set(key, input.bytes); });
    const pending = staging.prepare(material);
    await vi.waitFor(() => expect(remote.put).toHaveBeenCalledTimes(2));
    await staging.sweep();
    upload.resolve();
    await expect(pending).resolves.toContain("https://synthetic.oss.example/");
    expect(await journal()).toHaveLength(1);
    expect(remoteObjects.size).toBe(1);
  });

  it("keeps failed remote deletions durable and resumes them after restart", async () => {
    await staging.prepare(material);
    repository.deleteUser(material.userId);
    vi.mocked(remote.delete).mockRejectedValueOnce(new Error("private provider details"));
    await staging.sweep();
    expect(await journal()).toEqual([expect.objectContaining({ state: "delete-pending" })]);
    staging.close();
    now += 30_000;
    staging = create();
    await staging.sweep();
    expect(await journal()).toEqual([]);
    expect(remoteObjects.size).toBe(0);
  });

  it("does not issue a URL after account deletion during PUT, and erases a late completed upload", async () => {
    const upload = deferred<void>();
    vi.mocked(remote.put).mockImplementationOnce(async (key, input) => { await upload.promise; remoteObjects.set(key, input.bytes); });
    const pending = staging.prepare(material).then(() => undefined, (error: unknown) => error);
    await vi.waitFor(() => expect(remote.put).toHaveBeenCalledOnce());
    repository.deleteUser(material.userId);
    await staging.sweep();
    expect(await pending).toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(remote.signedGetUrl).not.toHaveBeenCalled();
    expect(await journal()).toEqual([expect.objectContaining({ state: "delete-pending" })]);
    upload.resolve();
    await vi.waitFor(async () => {
      await staging.sweep();
      expect(remoteObjects.size).toBe(0);
      expect(await journal()).toEqual([]);
    });
  });

  it("rejects a changed material version while signing and deletes the unused copy", async () => {
    vi.mocked(remote.signedGetUrl).mockImplementationOnce(async () => {
      repository.saveMaterial({ ...material, objectKey: "new-version.jpg" });
      return "https://synthetic.oss.example/stale?signature=private-signed-token";
    });
    await expect(staging.prepare(material)).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });
    await vi.waitFor(async () => { await staging.sweep(); expect(await journal()).toEqual([]); });
    expect(remoteObjects.size).toBe(0);
  });

  it("expires abandoned copies without requiring a callback", async () => {
    await staging.prepare(material);
    now += 45 * 60_000;
    await staging.sweep();
    expect(remoteObjects.size).toBe(0);
    expect(await journal()).toEqual([]);
  });

  it("recovers an interrupted upload as a tombstone, re-deleting after its uncertainty window", async () => {
    await staging.prepare(material);
    const record = (await journal())[0]!;
    staging.close();
    await writeFile(join(directory, `${record.id}.json`), JSON.stringify({ ...record, state: "uploading", uploadSettled: false }));
    staging = create();
    await staging.sweep();
    expect(remoteObjects.size).toBe(0);
    expect(await journal()).toEqual([expect.objectContaining({ state: "delete-pending", uncertainUntil: record.expiresAt })]);
    // The old remote PUT can have survived the process that issued it.
    remoteObjects.set(record.objectKey, Buffer.from("late-bytes"));
    now = record.expiresAt;
    await staging.sweep();
    expect(remoteObjects.size).toBe(0);
    expect(await journal()).toEqual([]);
  });

  it("bounds a stalled PUT and its cleanup, retaining a recoverable record", async () => {
    staging.close();
    staging = create({ operationTimeoutMs: 50, sweepTimeoutMs: 50 });
    let uploadSignal!: AbortSignal;
    vi.mocked(remote.put).mockImplementationOnce(async (_key, _input, signal) => { uploadSignal = signal; return new Promise(() => undefined); });
    vi.mocked(remote.delete).mockImplementation(async () => new Promise(() => undefined));
    await expect(staging.prepare(material)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(uploadSignal.aborted).toBe(true);
    await staging.sweep();
    expect(await journal()).toEqual([expect.objectContaining({ state: "delete-pending" })]);
    expect(remote.signedGetUrl).not.toHaveBeenCalled();
  });

  it("fails closed on corrupt journal entries and does not call remote storage", async () => {
    staging.close();
    await writeFile(join(directory, "unexpected.json"), "{}");
    staging = create();
    await expect(staging.prepare(material)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(remote.put).not.toHaveBeenCalled();
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it("bounds outstanding copies while permitting reuse and later capacity recovery", async () => {
    staging.close();
    staging = create({ maxPendingLeases: 1 });
    await staging.prepare(material);
    await staging.prepare(material);
    const second = repository.saveMaterial({ ...material, id: "second", objectKey: "second.jpg" });
    await expect(staging.prepare(second)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(remote.put).toHaveBeenCalledOnce();
    repository.saveMaterial({ ...material, status: "DELETED" });
    await staging.sweep();
    await staging.prepare(second);
    expect(remote.put).toHaveBeenCalledTimes(2);
    expect(await journal()).toHaveLength(1);
  });

  it("cancels preparation on close without issuing a URL or losing the upload cleanup record", async () => {
    const upload = deferred<void>();
    vi.mocked(remote.put).mockImplementationOnce(async (key, input) => { await upload.promise; remoteObjects.set(key, input.bytes); });
    const pending = staging.prepare(material).then(() => undefined, (error: unknown) => error);
    await vi.waitFor(() => expect(remote.put).toHaveBeenCalledOnce());
    staging.close();
    expect(await pending).toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(remote.signedGetUrl).not.toHaveBeenCalled();
    upload.resolve();
    await vi.waitFor(async () => {
      expect(await journal()).toEqual([expect.objectContaining({ state: "delete-pending", uploadSettled: true })]);
    });
    staging = create();
    await staging.sweep();
    expect(remoteObjects.size).toBe(0);
    expect(await journal()).toEqual([]);
  });

  it("cancels only the parent worker's upload and preserves cleanup for late writes", async () => {
    const controller = new AbortController();
    const upload = deferred<void>();
    let uploadSignal!: AbortSignal;
    vi.mocked(remote.put).mockImplementationOnce(async (key, input, signal) => {
      uploadSignal = signal;
      await upload.promise;
      remoteObjects.set(key, input.bytes);
    });
    const pending = staging.prepare(material, controller.signal).then(() => undefined, (error: unknown) => error);
    await vi.waitFor(() => expect(remote.put).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(uploadSignal.aborted).toBe(true);
    expect(remote.signedGetUrl).not.toHaveBeenCalled();
    upload.resolve();
    await vi.waitFor(async () => {
      const records = await journal();
      expect(records.length === 0 || records.every((record) => record.state === "delete-pending" && record.uploadSettled)).toBe(true);
    });
    // An already-running uncertainty sweep may retain its original retry date.
    // The durable tombstone must still remove the late object by that date.
    now += 45 * 60_000;
    await vi.waitFor(async () => {
      await staging.sweep();
      expect(remoteObjects.size).toBe(0);
      expect(await journal()).toEqual([]);
    });
    expect(repository.getMaterial(material.id)?.status).toBe("READY");
  });

  it("does not start a cancelled worker's preparation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(staging.prepare(material, controller.signal)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(remote.put).not.toHaveBeenCalled();
    expect(remote.signedGetUrl).not.toHaveBeenCalled();
  });

  it("rejects untrusted directory, key prefix and URL lifetime configuration", () => {
    for (const override of [{ directory: "relative" }, { objectKeyPrefix: "../other/" }, { ttlMs: 45 * 60_000 + 1 }, { operationTimeoutMs: 105_001 }]) {
      expect(() => create(override)).toThrow();
    }
  });

  it("binds the journal to one remote namespace and never deletes from a different bucket", async () => {
    await staging.sweep();
    staging.close();
    staging = create({ namespaceId: "cn-beijing/different-bucket/wechat-safety/" });
    await expect(staging.prepare(material)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    await expect(staging.sweep()).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(remote.put).not.toHaveBeenCalled();
    expect(remote.delete).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(directory, "context.json"), "utf8"))).toEqual({
      version: 1, namespaceId: "default", objectKeyPrefix: "wechat-safety/",
    });
  });

  it("rejects a symlinked journal directory before any remote access", async () => {
    await staging.sweep();
    staging.close();
    const redirected = `${directory}-link`;
    await symlink(directory, redirected, "junction");
    try {
      staging = create({ directory: redirected });
      await expect(staging.prepare(material)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
      expect(remote.put).not.toHaveBeenCalled();
      expect(remote.delete).not.toHaveBeenCalled();
    } finally { await rm(redirected); }
  });

  it("refuses symlinked lease files and leaves their targets untouched", async () => {
    await staging.prepare(material);
    const record = (await journal())[0]!;
    staging.close();
    const leasePath = join(directory, `${record.id}.json`);
    const outside = await mkdtemp(join(tmpdir(), "warm-letter-review-target-"));
    try {
      await writeFile(join(outside, "keep.txt"), "synthetic untouched content");
      await rm(leasePath);
      await symlink(outside, leasePath, "junction");
      staging = create();
      await expect(staging.prepare(material)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("synthetic untouched content");
      expect(remote.delete).not.toHaveBeenCalled();
      expect(remote.put).toHaveBeenCalledOnce();
    } finally {
      await rm(leasePath, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rotates cleanup attempts so one stalled delete cannot starve later revoked objects", async () => {
    await staging.sweep();
    staging.close();
    // Exercise the stalled DELETE deadline without treating slow CI fsync as it.
    staging = create({ sweepTimeoutMs: 500 });
    await staging.prepare(material);
    const second = repository.saveMaterial({ ...material, id: "second", objectKey: "second.jpg" });
    await staging.prepare(second);
    const [firstKey, secondKey] = [...remoteObjects.keys()];
    vi.mocked(remote.delete).mockImplementation(async (key) => {
      if (key === firstKey) return new Promise(() => undefined);
      remoteObjects.delete(key);
    });
    repository.deleteUser(material.userId);
    await staging.sweep();
    expect(remoteObjects.has(secondKey!)).toBe(true);
    now += 30_000;
    await staging.sweep();
    expect(remoteObjects.has(firstKey!)).toBe(true);
    expect(remoteObjects.has(secondKey!)).toBe(false);
    expect((await journal()).map((record) => record.objectKey)).toEqual([firstKey]);
  });
});
