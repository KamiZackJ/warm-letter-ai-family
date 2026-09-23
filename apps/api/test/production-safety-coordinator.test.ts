import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionSafety } from "../src/production-safety.js";
import { MemoryRepository } from "../src/repository.js";
import { WarmLetterService } from "../src/service.js";
import { FakeAIProvider } from "../src/ai.js";
import type { ContentSafetyProvider, MediaSafetyProvider } from "../src/content-safety.js";
import type { Material } from "../src/domain.js";

afterEach(() => vi.useRealTimers());

function setup(normalizeMaterial?: (material: Material) => Promise<Material>) {
  let now = new Date("2026-09-23T00:00:00.000Z");
  const repository = new MemoryRepository();
  const service = new WarmLetterService(repository, new FakeAIProvider());
  repository.saveUser({ id: "user", openId: "openid", displayName: "某人", createdAt: now.toISOString() });
  const material = repository.saveMaterial({ id: "material", userId: "user", type: "photo", name: "photo.jpg", status: "READY", contentType: "image/jpeg", objectKey: "user/photo.jpg", createdAt: now.toISOString() });
  const submitMedia = vi.fn<MediaSafetyProvider["submitMedia"]>().mockResolvedValue({ decision: "pending", traceId: "trace-1" });
  const provider: ContentSafetyProvider & MediaSafetyProvider = { name: "test", submitMedia, checkText: async () => ({ decision: "allow", traceId: "text-1" }) };
  const safety = new ProductionSafety({ repository, service, provider, normalizeMaterial, publicBaseUrl: "https://api.example", signingKeys: [Buffer.alloc(32, 1)], now: () => now });
  return { repository, service, material, submitMedia, safety, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

describe("durable media safety state transitions", () => {
  it("keeps a received trace pending until the signed result is applied", async () => {
    const { safety, material, repository } = setup();
    await safety.submitMaterial(material);
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pending");
    safety.acceptCallback({ traceId: "trace-1", decision: "allow" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pass");
    safety.acceptCallback({ traceId: "trace-1", decision: "reject" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pass");
  });

  it("permits a failed download to be retried after a persisted cooldown, not immediately", async () => {
    const { safety, material, repository, submitMedia, advance } = setup();
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "unavailable" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("failed");
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ statusCode: 503 });
    expect(submitMedia).toHaveBeenCalledOnce();
    advance(60_000);
    submitMedia.mockResolvedValue({ decision: "pending", traceId: "trace-2" });
    await safety.submitMaterial(material);
    expect(submitMedia).toHaveBeenCalledTimes(2);
    expect(repository.getLatestMediaSafetyCheck(material.id)).toMatchObject({ traceId: "trace-2", status: "pending" });
  });

  it("does not retry risky content or accept late approval for a rejected record", async () => {
    const { safety, material, repository, submitMedia, advance } = setup();
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "reject" });
    advance(3_600_000);
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "allow" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("reject");
    expect(submitMedia).toHaveBeenCalledOnce();
  });

  it("ignores expired and superseded callbacks, while a new check can complete", async () => {
    const { safety, material, repository, submitMedia, advance } = setup();
    await safety.submitMaterial(material);
    advance(35 * 60_000);
    safety.acceptCallback({ traceId: "trace-1", decision: "allow" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pending");
    submitMedia.mockResolvedValue({ decision: "pending", traceId: "trace-2" });
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "reject" });
    expect(repository.getLatestMediaSafetyCheck(material.id)).toMatchObject({ traceId: "trace-2", status: "pending" });
    safety.acceptCallback({ traceId: "trace-2", decision: "allow" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pass");
  });

  it("coalesces concurrent submissions and bounds repeat failures without receipt IDs", async () => {
    const { safety, material, submitMedia, advance } = setup();
    let reject!: (error: Error) => void;
    submitMedia.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = safety.submitMaterial(material);
    const second = safety.submitMaterial(material);
    reject(new Error("synthetic failure"));
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ statusCode: 503 });
    expect(submitMedia).toHaveBeenCalledOnce();
    advance(60_000);
    await safety.submitMaterial(material);
    expect(submitMedia).toHaveBeenCalledTimes(2);
  });

  it("does not restore a material deleted while the provider is responding", async () => {
    const { safety, material, submitMedia, repository } = setup();
    submitMedia.mockImplementationOnce(async () => {
      repository.saveMaterial({ ...material, status: "DELETED" });
      return { decision: "pending", traceId: "late" };
    });
    await safety.submitMaterial(material);
    expect(repository.getMediaSafetyCheck("late")).toBeUndefined();
    expect(repository.getMaterial(material.id)?.status).toBe("DELETED");
  });

  it("does not attach an old submission receipt after a media version is replaced", async () => {
    const { safety, material, submitMedia, repository } = setup();
    submitMedia.mockImplementationOnce(async () => {
      repository.saveMaterial({ ...material, objectKey: "new/file.jpg" });
      return { decision: "pending", traceId: "old-file-trace" };
    });
    await safety.submitMaterial(material);
    expect(repository.getMediaSafetyCheck("old-file-trace")).toBeUndefined();
    submitMedia.mockResolvedValueOnce({ decision: "pending", traceId: "new-file-trace" });
    await safety.submitMaterial(repository.getMaterial(material.id)!);
    expect(repository.getLatestMediaSafetyCheck(material.id)?.traceId).toBe("new-file-trace");
  });
});

describe("publication uses one content snapshot and one total deadline", () => {
  function readyLetter(repository: MemoryRepository, material: Material) {
    const createdAt = new Date().toISOString();
    return repository.saveLetter({ id: "letter", userId: material.userId, recipient: "妈妈", materialIds: [material.id],
      settings: { tone: "warm", length: "short" }, state: "EDITING", createdAt, updatedAt: createdAt,
      draft: { version: 1, title: "近况", greeting: "妈妈：", paragraphs: [{ id: "p", text: "今天一切都好。", sourceRefs: [material.id] }],
        closing: "保重。", signature: "我", provider: "test", generatedAt: createdAt },
    });
  }

  it("rejects the changed letter when another request switches materials during normalization", async () => {
    let finish!: (material: Material) => void;
    const normalize = vi.fn((_material: Material) => new Promise<Material>((resolve) => { finish = resolve; }));
    const { safety, material, repository, service } = setup(normalize);
    const letter = readyLetter(repository, material);
    repository.saveMediaSafetyCheck({ traceId: "approved", materialId: material.id, userId: material.userId, status: "pass", createdAt: letter.createdAt, updatedAt: letter.createdAt });
    const checking = safety.requirePublishable(material.userId, letter.id);
    await Promise.resolve();
    const other = repository.saveMaterial({ ...material, id: "other", objectKey: "other.m4a", contentType: "audio/mp4", type: "audio" });
    repository.saveLetter({ ...letter, materialIds: [other.id] });
    finish(material);
    await expect(checking).rejects.toMatchObject({ code: "DRAFT_CHANGED" });
    expect(normalize).toHaveBeenCalledOnce();
    expect(repository.getLatestMediaSafetyCheck(other.id)).toBeUndefined();
    expect(repository.listShareAccess(letter.id)).toEqual([]);
    expect(service.getLetter(material.userId, letter.id).state).toBe("EDITING");
  });

  it("times out the whole publication at 60 seconds and never submits after late normalization", async () => {
    vi.useFakeTimers();
    let finish!: (material: Material) => void;
    const { safety, material, repository, submitMedia } = setup(() => new Promise<Material>((resolve) => { finish = resolve; }));
    const letter = readyLetter(repository, material);
    const result = safety.requirePublishable(material.userId, letter.id).then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "CONTENT_SAFETY_TIMEOUT", statusCode: 504 });
    finish(material);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitMedia).not.toHaveBeenCalled();
    expect(repository.listShareAccess(letter.id)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
