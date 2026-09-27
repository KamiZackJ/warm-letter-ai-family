import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionSafety } from "../src/production-safety.js";
import { MemoryRepository } from "../src/repository.js";
import { WarmLetterService } from "../src/service.js";
import { FakeAIProvider } from "../src/ai.js";
import type { ContentSafetyProvider, MediaSafetyProvider } from "../src/content-safety.js";
import type { Material } from "../src/domain.js";
import { ApiError } from "../src/errors.js";

const coordinators: ProductionSafety[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T00:00:00Z")); });
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.close(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const repository = new MemoryRepository();
  const checkText = vi.fn<ContentSafetyProvider["checkText"]>().mockResolvedValue({ decision: "allow", traceId: "text" });
  let trace = 0;
  const submitMedia = vi.fn<MediaSafetyProvider["submitMedia"]>().mockImplementation(async () => ({ decision: "pending", traceId: `trace-${++trace}` }));
  const provider: ContentSafetyProvider & MediaSafetyProvider = { name: "test", checkText, submitMedia };
  const service = new WarmLetterService(repository, new FakeAIProvider(), { contentSafetyProvider: provider });
  const prepare = vi.fn<(material: Material, signal?: AbortSignal) => Promise<string>>().mockResolvedValue("https://private.example.test/review");
  const safety = new ProductionSafety({ repository, service, provider, prepareMediaUrl: prepare,
    backgroundMediaSafety: true, publicBaseUrl: "https://api.example.test", signingKeys: [Buffer.alloc(32, 1)] });
  coordinators.push(safety);
  function material(id = "material", userId = "user", type: Material["type"] = "photo") {
    if (!repository.getUser(userId)) repository.saveUser({ id: userId, openId: `openid-${userId}`, displayName: "家人", createdAt: new Date().toISOString() });
    return repository.saveMaterial({ id, userId, type, name: `${id}.jpg`, status: "READY",
      contentType: "image/jpeg", objectKey: `${userId}/${id}.jpg`, createdAt: new Date().toISOString() });
  }
  function letter(source: Material) {
    const createdAt = new Date().toISOString();
    return repository.saveLetter({ id: `letter-${source.id}`, userId: source.userId, recipient: "妈妈", materialIds: [source.id],
      settings: { tone: "warm", length: "short" }, state: "EDITING", createdAt, updatedAt: createdAt,
      draft: { version: 1, title: "近况", greeting: "妈妈：", paragraphs: [{ id: "p", text: "今天一切都好。", sourceRefs: [source.id] }],
        closing: "保重。", signature: "我", provider: "test", generatedAt: createdAt } });
  }
  return { repository, service, safety, prepare, submitMedia, checkText, material, letter };
}

describe("bounded background media review", () => {
  it("returns pending immediately, deduplicates slow work beyond 25 seconds and still requires an authentic pass and text check", async () => {
    const f = setup();
    const source = f.material();
    const letter = f.letter(source);
    f.prepare.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve("https://private.example.test/review"), 45_000)));
    f.safety.scheduleMaterial(source);
    await expect(f.safety.requirePublishable(source.userId, letter.id)).rejects.toMatchObject({ code: "CONTENT_SAFETY_PENDING" });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(f.safety.requirePublishable(source.userId, letter.id)).rejects.toMatchObject({ code: "CONTENT_SAFETY_PENDING" });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.submitMedia).not.toHaveBeenCalled();
    expect(f.checkText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.repository.getLatestMediaSafetyCheck(source.id)?.status).toBe("pending");
    await expect(f.safety.requirePublishable(source.userId, letter.id)).rejects.toMatchObject({ code: "CONTENT_SAFETY_PENDING" });
    f.safety.acceptCallback({ traceId: "trace-1", decision: "allow" });
    await expect(f.safety.requirePublishable(source.userId, letter.id)).resolves.toMatchObject({ id: letter.id });
    expect(f.checkText).toHaveBeenCalledOnce();
    expect(f.repository.listShareAccess(letter.id)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds queue wait and active work to 125 seconds, then starts a fresh explicit retry despite a noncooperative old provider", async () => {
    const f = setup();
    const first = f.material("first");
    const queued = f.material("queued", "other");
    const letter = f.letter(first);
    const old = deferred<Awaited<ReturnType<MediaSafetyProvider["submitMedia"]>>>();
    f.submitMedia.mockImplementationOnce(() => old.promise);
    f.safety.scheduleMaterial(first);
    f.safety.scheduleMaterial(queued);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(f.submitMedia).toHaveBeenCalledOnce();
    expect(() => f.safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_TIMEOUT" }));
    expect(() => f.safety.scheduleMaterial(queued)).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_TIMEOUT" }));
    expect(f.prepare.mock.calls[0]![1]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    f.safety.scheduleMaterial(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.submitMedia).toHaveBeenCalledTimes(2);
    expect(f.repository.getLatestMediaSafetyCheck(first.id)?.status).toBe("pending");
    old.resolve({ decision: "pending", traceId: "late-old" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.getMediaSafetyCheck("late-old")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a late old rejection overwrite a newer attempt's login failure", async () => {
    const f = setup();
    const source = f.material();
    const old = deferred<Awaited<ReturnType<MediaSafetyProvider["submitMedia"]>>>();
    f.submitMedia.mockImplementationOnce(() => old.promise);
    f.safety.scheduleMaterial(source);
    await vi.advanceTimersByTimeAsync(185_000);
    f.submitMedia.mockResolvedValueOnce({ decision: "unavailable", reason: "login-required", retryable: false });
    f.safety.scheduleMaterial(source);
    await vi.advanceTimersByTimeAsync(0);
    old.reject(new Error("private provider failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(() => f.safety.scheduleMaterial(source)).toThrow(expect.objectContaining({ code: "WECHAT_LOGIN_REQUIRED" }));
  });

  it("keeps a new preparation failure distinct from an old failed download, with no automatic retry", async () => {
    const f = setup();
    const source = f.material();
    const letter = f.letter(source);
    f.repository.saveMediaSafetyCheck({ traceId: "old", materialId: source.id, userId: source.userId, status: "failed",
      diagnostic: { reason: "provider", wechatErrorCode: -1008 }, createdAt: new Date(Date.now() - 61_000).toISOString(), updatedAt: new Date(Date.now() - 61_000).toISOString() });
    f.prepare.mockRejectedValueOnce(new Error("https://private.invalid/?signature=secret"));
    f.safety.scheduleMaterial(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => f.safety.assertMediaPassed(letter)).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_UNAVAILABLE" }));
    expect(() => f.safety.scheduleMaterial(source)).toThrow(expect.objectContaining({ message: "素材安全检查暂时不可用，请稍后重试" }));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.submitMedia).not.toHaveBeenCalled();
    expect(f.repository.getLatestMediaSafetyCheck(source.id)?.traceId).toBe("old");
  });

  it.each(["material", "account", "close", "replace"])("cancels %s without late provider or database writes", async (target) => {
    const f = setup();
    const source = f.material();
    const pending = deferred<string>();
    f.prepare.mockImplementationOnce(() => pending.promise);
    f.safety.scheduleMaterial(source);
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.prepare.mock.calls[0]![1]!;
    if (target === "material") { f.service.deleteMaterial(source.userId, source.id); f.safety.cancelMaterial(source.id); }
    if (target === "account") { f.service.deleteAccount(source.userId); f.safety.cancelUser(source.userId); }
    if (target === "close") f.safety.close();
    if (target === "replace") {
      const replacement = f.repository.saveMaterial({ ...source, objectKey: "replacement.jpg" });
      f.safety.scheduleMaterial(replacement);
    }
    expect(signal.aborted).toBe(true);
    pending.resolve("https://private.example.test/obsolete");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.submitMedia).toHaveBeenCalledTimes(target === "replace" ? 1 : 0);
    expect(f.submitMedia.mock.calls.some(([input]) => input.mediaUrl.includes("obsolete"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits each owner to four slots and alternates owners while running only one preparation", async () => {
    const f = setup();
    const pending = deferred<string>();
    f.prepare.mockImplementationOnce(() => pending.promise);
    const first = f.material("a1", "a");
    f.safety.scheduleMaterial(first);
    for (let i = 2; i <= 4; i++) f.safety.scheduleMaterial(f.material(`a${i}`, "a"));
    expect(() => f.safety.scheduleMaterial(f.material("a5", "a"))).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_UNAVAILABLE" }));
    f.safety.scheduleMaterial(f.material("b1", "b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.prepare).toHaveBeenCalledOnce();
    pending.resolve("https://private.example.test/review");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.prepare.mock.calls.map(([material]) => material.id)).toEqual(["a1", "b1", "a2", "a3", "a4"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits the whole queue to 32, and cancellation frees capacity", async () => {
    const f = setup();
    f.prepare.mockImplementationOnce(() => new Promise(() => {}));
    for (let owner = 0; owner < 8; owner++) for (let index = 0; index < 4; index++) {
      f.safety.scheduleMaterial(f.material(`m${owner}-${index}`, `u${owner}`));
    }
    const overflow = f.material("overflow", "new-user");
    expect(() => f.safety.scheduleMaterial(overflow)).toThrow(expect.objectContaining({ code: "CONTENT_SAFETY_UNAVAILABLE" }));
    f.safety.cancelMaterial("m7-3");
    expect(() => f.safety.scheduleMaterial(overflow)).not.toThrow();
    f.safety.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one worker when pruning a deleted queued source reenters the drain", async () => {
    const f = setup();
    const active = deferred<string>();
    const next = deferred<string>();
    f.prepare.mockImplementationOnce(() => active.promise).mockImplementationOnce(() => next.promise);
    f.safety.scheduleMaterial(f.material("active", "a"));
    const deleted = f.material("deleted", "b");
    f.safety.scheduleMaterial(deleted);
    f.safety.scheduleMaterial(f.material("next", "c"));
    f.safety.scheduleMaterial(f.material("last", "d"));
    await vi.advanceTimersByTimeAsync(0);
    f.repository.saveMaterial({ ...deleted, status: "DELETED" });
    active.resolve("https://private.example.test/review");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.prepare.mock.calls.map(([material]) => material.id)).toEqual(["active", "next"]);
    next.resolve("https://private.example.test/review");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.prepare.mock.calls.map(([material]) => material.id)).toEqual(["active", "next", "last"]);
  });

  it("does not enqueue text, approved, rejected, or current WeChat pending material", async () => {
    const f = setup();
    f.safety.scheduleMaterial(f.material("text", "user", "text"));
    for (const status of ["pass", "reject", "pending"] as const) {
      const source = f.material(status);
      f.repository.saveMediaSafetyCheck({ traceId: status, materialId: source.id, userId: source.userId, status,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      f.safety.scheduleMaterial(source);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps rejection, text failure, and a concurrently edited draft unpublishable", async () => {
    const f = setup();
    const source = f.material();
    const letter = f.letter(source);
    f.safety.scheduleMaterial(source);
    await vi.advanceTimersByTimeAsync(0);
    f.safety.acceptCallback({ traceId: "trace-1", decision: "reject", reason: "risky" });
    await expect(f.safety.requirePublishable(source.userId, letter.id)).rejects.toMatchObject({ code: "CONTENT_SAFETY_REJECTED" });
    const allowed = f.material("allowed");
    const allowedLetter = f.letter(allowed);
    f.safety.scheduleMaterial(allowed);
    await vi.advanceTimersByTimeAsync(0);
    f.safety.acceptCallback({ traceId: "trace-2", decision: "allow" });
    f.checkText.mockRejectedValueOnce(new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "text unavailable"));
    await expect(f.safety.requirePublishable(allowed.userId, allowedLetter.id)).rejects.toMatchObject({ code: "CONTENT_SAFETY_UNAVAILABLE" });
    const text = deferred<Awaited<ReturnType<ContentSafetyProvider["checkText"]>>>();
    f.checkText.mockImplementationOnce(() => text.promise);
    const check = f.safety.requirePublishable(allowed.userId, allowedLetter.id);
    const failure = expect(check).rejects.toMatchObject({ code: "DRAFT_CHANGED" });
    await vi.advanceTimersByTimeAsync(0);
    f.repository.saveLetter({ ...allowedLetter, draft: { ...allowedLetter.draft!, title: "新标题" } });
    text.resolve({ decision: "allow", traceId: "changed-text" });
    await failure;
    expect(f.repository.listShareAccess(allowedLetter.id)).toEqual([]);
  });
});
