import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionSafety } from "../src/production-safety.js";
import { MemoryRepository } from "../src/repository.js";
import { WarmLetterService } from "../src/service.js";
import { FakeAIProvider } from "../src/ai.js";
import type { ContentSafetyProvider, MediaSafetyProvider } from "../src/content-safety.js";
import type { Material } from "../src/domain.js";
import { ApiError } from "../src/errors.js";

afterEach(() => vi.useRealTimers());

function setup(normalizeMaterial?: (material: Material) => Promise<Material>, prepareMediaUrl?: (material: Material) => Promise<string>) {
  let now = new Date("2026-09-23T00:00:00.000Z");
  const repository = new MemoryRepository();
  const service = new WarmLetterService(repository, new FakeAIProvider());
  repository.saveUser({ id: "user", openId: "openid", displayName: "某人", createdAt: now.toISOString() });
  const material = repository.saveMaterial({ id: "material", userId: "user", type: "photo", name: "photo.jpg", status: "READY", contentType: "image/jpeg", objectKey: "user/photo.jpg", createdAt: now.toISOString() });
  const submitMedia = vi.fn<MediaSafetyProvider["submitMedia"]>().mockResolvedValue({ decision: "pending", traceId: "trace-1" });
  const provider: ContentSafetyProvider & MediaSafetyProvider = { name: "test", submitMedia, checkText: async () => ({ decision: "allow", traceId: "text-1" }) };
  const safety = new ProductionSafety({ repository, service, provider, normalizeMaterial, prepareMediaUrl, publicBaseUrl: "https://api.example", signingKeys: [Buffer.alloc(32, 1)], now: () => now });
  return { repository, service, material, submitMedia, safety, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

describe("durable media safety state transitions", () => {
  it("submits the prepared private copy while still requiring the authentic final receipt", async () => {
    const prepare = vi.fn(async () => "https://private.example.test/short-lived");
    const { safety, material, repository, service, submitMedia } = setup(undefined, prepare);
    const letter = service.createLetter(material.userId, { recipient: "妈妈", materialIds: [material.id] });
    await safety.submitMaterial(material);
    expect(prepare).toHaveBeenCalledOnce();
    expect(submitMedia).toHaveBeenCalledWith(expect.objectContaining({ mediaUrl: "https://private.example.test/short-lived" }));
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pending");
    expect(() => safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_PENDING" }));
    safety.acceptCallback({ traceId: "trace-1", decision: "allow" });
    expect(() => safety.assertMediaPassed(letter)).not.toThrow();
  });

  it("does not submit or approve when preparing the private copy fails", async () => {
    const { safety, material, repository, submitMedia } = setup(undefined, async () => { throw new Error("preparation unavailable"); });
    await expect(safety.submitMaterial(material)).rejects.toThrow("preparation unavailable");
    expect(submitMedia).not.toHaveBeenCalled();
    expect(repository.getLatestMediaSafetyCheck(material.id)).toBeUndefined();
  });

  it.each(["deleted", "replaced"])("does not submit a source %s while its private copy is being prepared", async (change) => {
    let finish!: (url: string) => void;
    const { safety, material, repository, submitMedia } = setup(undefined, () => new Promise<string>((resolve) => { finish = resolve; }));
    const checking = safety.submitMaterial(material);
    repository.saveMaterial({ ...material, ...(change === "deleted" ? { status: "DELETED" as const } : { objectKey: "user/new.jpg" }) });
    finish("https://private.example.test/short-lived");
    await checking;
    expect(submitMedia).not.toHaveBeenCalled();
    expect(repository.getLatestMediaSafetyCheck(material.id)).toBeUndefined();
  });
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
    safety.acceptCallback({ traceId: "trace-1", decision: "unavailable", reason: "provider", wechatErrorCode: -1008 });
    expect(repository.getLatestMediaSafetyCheck(material.id)).toMatchObject({
      status: "failed", diagnostic: { reason: "provider", wechatErrorCode: -1008 },
    });
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ statusCode: 503, code: "CONTENT_SAFETY_DOWNLOAD_FAILED" });
    expect(submitMedia).toHaveBeenCalledOnce();
    advance(60_000);
    submitMedia.mockResolvedValue({ decision: "pending", traceId: "trace-2" });
    await safety.submitMaterial(material);
    expect(submitMedia).toHaveBeenCalledTimes(2);
    expect(repository.getLatestMediaSafetyCheck(material.id)).toMatchObject({ traceId: "trace-2", status: "pending" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.diagnostic).toBeUndefined();
    expect(repository.getMediaSafetyCheck("trace-1")?.diagnostic).toEqual({ reason: "provider", wechatErrorCode: -1008 });
  });

  it.each([
    [-1008, "CONTENT_SAFETY_DOWNLOAD_FAILED"],
    [-1, "CONTENT_SAFETY_UNAVAILABLE"],
    [undefined, "CONTENT_SAFETY_UNAVAILABLE"],
  ])("keeps failed check %s distinct from pending both during cooldown and final validation", async (wechatErrorCode, code) => {
    const { safety, material, service } = setup();
    const letter = service.createLetter(material.userId, { recipient: "妈妈", materialIds: [material.id] });
    await safety.submitMaterial(material);
    expect(() => safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ statusCode: 409, code: "CONTENT_SAFETY_PENDING" }));
    safety.acceptCallback({ traceId: "trace-1", decision: "unavailable", reason: "provider", wechatErrorCode });
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ statusCode: 503, code });
    expect(() => safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ statusCode: 503, code }));
  });

  it("retains the new private-copy failure during cooldown without reusing an old download diagnostic", async () => {
    const prepare = vi.fn(async () => "https://private.example.test/short-lived");
    const { safety, material, repository, service, submitMedia, advance } = setup(undefined, prepare);
    const letter = service.createLetter(material.userId, { recipient: "妈妈", materialIds: [material.id] });
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "unavailable", reason: "provider", wechatErrorCode: -1008 });
    advance(60_000);
    prepare.mockRejectedValueOnce(new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "private signed URL must not be cached"));
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({
      statusCode: 503, code: "CONTENT_SAFETY_UNAVAILABLE", message: "素材安全检查暂时不可用，请稍后重试",
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(submitMedia).toHaveBeenCalledOnce();
    expect(repository.getLatestMediaSafetyCheck(material.id)).toMatchObject({
      traceId: "trace-1", status: "failed", diagnostic: { wechatErrorCode: -1008 },
    });
    expect(() => safety.assertMediaPassed(letter)).toThrow();
    expect(repository.listShareAccess(letter.id)).toEqual([]);
    advance(60_000);
    submitMedia.mockResolvedValueOnce({ decision: "pending", traceId: "trace-2" });
    await safety.submitMaterial(material);
    expect(repository.getLatestMediaSafetyCheck(material.id)).toMatchObject({ traceId: "trace-2", status: "pending" });
    expect(() => safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_PENDING" }));
    safety.acceptCallback({ traceId: "trace-2", decision: "allow" });
    expect(() => safety.assertMediaPassed(letter)).not.toThrow();
  });

  it("preserves a new login-required failure instead of an old failed download", async () => {
    const { safety, material, submitMedia, advance } = setup();
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "unavailable", reason: "provider", wechatErrorCode: -1008 });
    advance(60_000);
    submitMedia.mockResolvedValueOnce({ decision: "unavailable", reason: "login-required", retryable: false });
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ statusCode: 401, code: "WECHAT_LOGIN_REQUIRED" });
    await expect(safety.submitMaterial(material)).rejects.toMatchObject({ statusCode: 401, code: "WECHAT_LOGIN_REQUIRED" });
    expect(submitMedia).toHaveBeenCalledTimes(2);
  });

  it("redacts an unclassified fresh provider failure during cooldown", async () => {
    const { safety, material, submitMedia, advance } = setup();
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "unavailable", reason: "provider", wechatErrorCode: -1008 });
    advance(60_000);
    submitMedia.mockRejectedValueOnce(new Error("https://private.invalid/?signature=secret"));
    await expect(safety.submitMaterial(material)).rejects.toThrow();
    const error = await safety.submitMaterial(material).catch((value: unknown) => value);
    expect(error).toMatchObject({ statusCode: 503, code: "CONTENT_SAFETY_UNAVAILABLE" });
    expect(String(error)).not.toMatch(/signature|secret|private/);
    expect(submitMedia).toHaveBeenCalledTimes(2);
  });

  it("does not describe an absent receipt as an active check", () => {
    const { safety, material, service } = setup();
    const letter = service.createLetter(material.userId, { recipient: "妈妈", materialIds: [material.id] });
    expect(() => safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ statusCode: 503, code: "CONTENT_SAFETY_UNAVAILABLE" }));
  });

  it("requires a valid signature, unexpired credential and READY material for every moderation fetch", () => {
    const { safety, material, repository, advance } = setup();
    const url = new URL(safety.mediaUrl(material));
    const query = Object.fromEntries(url.searchParams);
    expect(safety.verifyMedia(material.id, query).id).toBe(material.id);
    expect(() => safety.verifyMedia(material.id, { ...query, signature: "0".repeat(64) })).toThrow();
    advance(45 * 60_000);
    expect(() => safety.verifyMedia(material.id, query)).toThrow();
    const freshQuery = Object.fromEntries(new URL(safety.mediaUrl(material)).searchParams);
    for (const status of ["UPLOADING", "DELETED"] as const) {
      repository.saveMaterial({ ...material, status });
      expect(() => safety.verifyMedia(material.id, freshQuery)).toThrow();
    }
  });

  it("does not retry risky content or accept late approval for a rejected record", async () => {
    const { safety, material, repository, submitMedia, advance } = setup();
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "reject", reason: "risky" });
    advance(3_600_000);
    await safety.submitMaterial(material);
    safety.acceptCallback({ traceId: "trace-1", decision: "allow" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("reject");
    expect(repository.getLatestMediaSafetyCheck(material.id)?.diagnostic).toEqual({ reason: "risky" });
    expect(submitMedia).toHaveBeenCalledOnce();
  });

  it("persists only allowlisted diagnostic fields and keeps failed checks unpublishable", async () => {
    const { safety, material, repository } = setup();
    await safety.submitMaterial(material);
    const callback = {
      traceId: "trace-1", decision: "unavailable" as const,
      reason: "https://private.invalid/?token=secret", wechatErrorCode: Number.NaN,
      rawCallback: "private正文", openid: "private-openid", errmsg: "private provider text",
    };
    safety.acceptCallback(callback as unknown as Parameters<ProductionSafety["acceptCallback"]>[0]);
    const check = repository.getLatestMediaSafetyCheck(material.id)!;
    expect(check.diagnostic).toEqual({ reason: "provider" });
    expect(JSON.stringify(check)).not.toMatch(/private|secret|NaN/);
    const createdAt = new Date().toISOString();
    expect(() => safety.assertMediaPassed({ id: "letter", userId: material.userId, recipient: "家人", materialIds: [material.id],
      settings: { tone: "warm", length: "short" }, state: "EDITING", createdAt, updatedAt: createdAt })).toThrow("安全检查");
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

  it("does not start a new media submission after late private-copy preparation", async () => {
    vi.useFakeTimers();
    let finish!: (url: string) => void;
    const { safety, material, repository, submitMedia } = setup(undefined, () => new Promise<string>((resolve) => { finish = resolve; }));
    const letter = readyLetter(repository, material);
    const result = safety.requirePublishable(material.userId, letter.id).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "CONTENT_SAFETY_TIMEOUT" });
    finish("https://private.example.test/short-lived");
    await vi.advanceTimersByTimeAsync(0);
    expect(submitMedia).not.toHaveBeenCalled();
    expect(repository.getLatestMediaSafetyCheck(material.id)).toBeUndefined();
    expect(repository.listShareAccess(letter.id)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

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
