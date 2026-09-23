import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import type { GenerationJob, Letter, Material, Reply, User } from "../src/domain.js";
import { MemoryRepository, type Repository } from "../src/repository.js";
import { SqliteRepository } from "../src/sqlite-repository.js";
import { ProductionSafety } from "../src/production-safety.js";
import { WarmLetterService } from "../src/service.js";
import { FakeAIProvider } from "../src/ai.js";
import { WechatModerationCallbackVerifier } from "../src/wechat-moderation-callback.js";

const now = "2026-09-23T09:00:00.000Z";
const user: User = { id: "u1", openId: "openid-1", displayName: "小暖", createdAt: now };
const material: Material = { id: "m1", userId: user.id, type: "text", name: "近况", textContent: "今天去散步了", status: "READY", createdAt: now };
const letter: Letter = {
  id: "l1", userId: user.id, recipient: "妈妈", materialIds: [material.id],
  settings: { tone: "warm", length: "short", excludedTopics: ["工作"] },
  state: "MATERIALS_READY", createdAt: now, updatedAt: now,
};
const job: GenerationJob = { id: "j1", userId: user.id, letterId: letter.id, status: "running", idempotencyKey: "generation-1", createdAt: now, updatedAt: now };
const reply: Reply = { id: "r1", letterId: letter.id, text: "照顾好自己", authorName: "妈妈", authorVerified: false, createdAt: now };
const share = { id: "s1", letterId: letter.id, tokenHash: "hashed-share-secret", createdAt: now, expiresAt: "2026-10-23T09:00:00.000Z" };
const paths: string[] = [];
const openRepositories: Repository[] = [];

function temporaryDatabase(): string {
  const root = process.platform === "win32" ? "D:/tmp/warm-letter-ai-family" : tmpdir();
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "repository-test-"));
  paths.push(directory);
  return join(directory, "letters.sqlite");
}

function sqlite(filename = temporaryDatabase()): SqliteRepository {
  const repository = new SqliteRepository({ filename });
  openRepositories.push(repository);
  return repository;
}

function seed(repository: Repository): void {
  repository.saveUser(user);
  repository.saveMaterial(material);
  repository.saveLetter(letter);
}

afterEach(() => {
  for (const repository of openRepositories.splice(0)) repository.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.each(["memory", "sqlite"] as const)("%s repository contract", (kind) => {
  function create(): Repository {
    const repository = kind === "memory" ? new MemoryRepository() : sqlite();
    seed(repository);
    return repository;
  }

  it("does not expose stored records to mutation without a save", () => {
    const repository = create();
    const input = structuredClone(letter);
    const saved = repository.saveLetter(input);
    input.recipient = "输入对象被修改";
    saved.materialIds.push("unexpected");
    repository.getLetter(letter.id)!.settings.excludedTopics!.push("家人");
    repository.listLetters(user.id)[0]!.recipient = "列表对象被修改";
    expect(repository.getLetter(letter.id)).toEqual(letter);
    repository.getUser(user.id)!.displayName = "未保存的姓名";
    expect(repository.findUserByOpenId(user.openId)).toEqual(user);
    repository.saveUser({ ...user, displayName: "已保存的姓名" });
    expect(repository.getUser(user.id)?.displayName).toBe("已保存的姓名");
  });

  it("rolls back all writes and cleanup tasks when a multi-record transaction fails", () => {
    const repository = create();
    expect(() => repository.transaction(() => {
      repository.saveLetter({ ...letter, state: "GENERATING" });
      repository.saveJob(job);
      repository.scheduleObjectDeletion("private/photo.jpg");
      throw new Error("commit aborted");
    })).toThrow("commit aborted");
    expect(repository.getLetter(letter.id)?.state).toBe("MATERIALS_READY");
    expect(repository.getJob(job.id)).toBeUndefined();
    expect(repository.listObjectDeletions()).toEqual([]);
    repository.transaction(() => {
      repository.saveLetter({ ...letter, state: "GENERATING" });
      repository.saveJob(job);
    });
    expect(repository.getJob(job.id)?.status).toBe("running");
  });

  it("supports nested rollback without discarding the outer transaction", () => {
    const repository = create();
    repository.transaction(() => {
      repository.scheduleObjectDeletion("keep");
      expect(() => repository.transaction(() => {
        repository.scheduleObjectDeletion("rollback");
        throw new Error("inner failure");
      })).toThrow("inner failure");
      repository.saveUser({ ...user, displayName: "已提交" });
    });
    expect(repository.listObjectDeletions()).toEqual(["keep"]);
    expect(repository.getUser(user.id)?.displayName).toBe("已提交");
  });

  it("replays material and reply requests while preserving original fingerprints and limits", async () => {
    const repository = create();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() =>
      repository.saveMaterialIdempotently({ ...material, id: `upload-${index}` }, "same-upload", `fingerprint-${index}`),
    )));
    expect(new Set(results.map((result) => result.material.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.requestFingerprint))).toEqual(new Set(["fingerprint-0"]));
    const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() =>
      repository.saveReplyIdempotentlyIfBelowLimit({ ...reply, id: `reply-${index}` }, 1, "reply-fingerprint", "same-reply"),
    )));
    expect(new Set(replies.map((result) => result?.reply.id)).size).toBe(1);
    expect(replies.filter((result) => result?.replayed === false)).toHaveLength(1);
    expect(repository.saveReplyIdempotentlyIfBelowLimit({ ...reply, id: "overflow" }, 1, "new", "new-request")).toBeUndefined();
    expect(repository.listReplies(letter.id)).toHaveLength(1);
  });

  it("keeps generation keys unique within each user and letter", () => {
    const repository = create();
    repository.saveJob(job);
    expect(() => repository.saveJob({ ...job, id: "duplicate" })).toThrow();
    repository.saveJob({ ...job, status: "succeeded" });
    expect(repository.findGenerationJobByIdempotencyKey(user.id, letter.id, job.idempotencyKey!)?.status).toBe("succeeded");
    expect(repository.findGenerationJobByIdempotencyKey("other-user", letter.id, job.idempotencyKey!)).toBeUndefined();
  });

  it("recovers interrupted tasks as retryable failures without inventing a generated result", () => {
    const repository = create();
    repository.saveLetter({ ...letter, state: "GENERATING" });
    repository.saveJob(job);
    repository.saveJob({ ...job, id: "queued", idempotencyKey: "queued", status: "queued" });
    repository.saveJob({ ...job, id: "success", idempotencyKey: "success", status: "succeeded" });
    const recoveredAt = "2026-09-23T10:00:00.000Z";
    expect(repository.recoverInterruptedJobs(recoveredAt)).toBe(2);
    expect(repository.getJob(job.id)).toMatchObject({ status: "failed", finishedAt: recoveredAt, error: { code: "GENERATION_INTERRUPTED", retryable: true } });
    expect(repository.getJob("queued")?.status).toBe("failed");
    expect(repository.getJob("success")?.status).toBe("succeeded");
    expect(repository.getLetter(letter.id)).toMatchObject({ state: "MATERIALS_READY", updatedAt: recoveredAt });
    expect(repository.getLetter(letter.id)?.draft).toBeUndefined();
    expect(repository.recoverInterruptedJobs(recoveredAt)).toBe(0);
    expect(repository.findGenerationJobByIdempotencyKey(user.id, letter.id, job.idempotencyKey!)?.id).toBe(job.id);
  });

  it("cascades deleted letters, including idempotency indexes, but retains independent materials", () => {
    const repository = create();
    repository.saveJob(job);
    repository.saveReplyIdempotentlyIfBelowLimit(reply, 10, "fp", "reply-key");
    repository.saveShareAccess(share);
    expect(repository.deleteLetter(letter.id)).toBe(true);
    expect(repository.deleteLetter(letter.id)).toBe(false);
    expect(repository.getLetter(letter.id)).toBeUndefined();
    expect(repository.listJobs()).toEqual([]);
    expect(repository.listReplies(letter.id)).toEqual([]);
    expect(repository.findReplyByIdempotencyKey(letter.id, "reply-key")).toBeUndefined();
    expect(repository.findShareAccessByTokenHash(share.tokenHash)).toBeUndefined();
    expect(repository.getMaterial(material.id)).toEqual(material);
    repository.saveLetter(letter);
    expect(repository.saveReplyIdempotentlyIfBelowLimit({ ...reply, id: "new-reply" }, 10, "new-fp", "reply-key")?.replayed).toBe(false);
  });

  it("deletes account records and that author's cross-letter replies without removing other users' letters", () => {
    const repository = create();
    repository.saveUser({ ...user, id: "u2", openId: "openid-2" });
    repository.saveLetter({ ...letter, id: "l2", userId: "u2", materialIds: [] });
    repository.saveMaterialIdempotently({ ...material, id: "extra-upload" }, "account-upload", "upload-fp");
    repository.saveJob(job);
    repository.saveShareAccess(share);
    repository.saveReplyIdempotentlyIfBelowLimit({ ...reply, id: "cross-reply", letterId: "l2", authorUserId: user.id }, 10, "cross-fp", "cross-key");
    repository.saveReply({ ...reply, id: "other-reply", letterId: "l2", authorUserId: "u2" });
    repository.scheduleObjectDeletion("deleted-user/photo.jpg");
    expect(repository.deleteUser(user.id)).toBe(true);
    expect(repository.deleteUser(user.id)).toBe(false);
    expect(repository.findUserByOpenId(user.openId)).toBeUndefined();
    expect(repository.listMaterials(user.id)).toEqual([]);
    expect(repository.listLetters(user.id)).toEqual([]);
    expect(repository.listJobs(user.id)).toEqual([]);
    expect(repository.getShareAccess(share.id)).toBeUndefined();
    expect(repository.getLetter("l2")).toBeDefined();
    expect(repository.listReplies("l2").map((entry) => entry.id)).toEqual(["other-reply"]);
    expect(repository.findReplyByIdempotencyKey("l2", "cross-key")).toBeUndefined();
    expect(repository.listObjectDeletions()).toEqual(["deleted-user/photo.jpg"]);
    repository.saveUser(user);
    expect(repository.saveMaterialIdempotently(material, "account-upload", "new-upload")?.replayed).toBe(false);
  });

  it("does not let a late media safety callback replace the latest check and clears checks with material deletion", () => {
    const repository = create();
    const first = { traceId: "check-1", materialId: material.id, userId: user.id, status: "pending" as const, createdAt: now, updatedAt: now };
    const second = { ...first, traceId: "check-2" };
    repository.saveMediaSafetyCheck(first);
    repository.saveMediaSafetyCheck(second);
    repository.saveMediaSafetyCheck({ ...first, status: "pass", updatedAt: "2026-09-23T10:00:00.000Z" });
    expect(repository.getLatestMediaSafetyCheck(material.id)?.traceId).toBe(second.traceId);
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pending");
    expect(repository.getMediaSafetyCheck(first.traceId)?.status).toBe("pass");
    expect(() => repository.saveMediaSafetyCheck({ ...first, createdAt: "2026-09-23T10:00:00.000Z" })).toThrow("identity must not change");
    repository.invalidateMediaSafetyChecks(material.id);
    expect(repository.getLatestMediaSafetyCheck(material.id)).toBeUndefined();
    expect(repository.getMediaSafetyCheck(first.traceId)).toBeUndefined();
    repository.saveMediaSafetyCheck(second);
    repository.saveMaterial({ ...material, status: "DELETED", deletedAt: now });
    expect(repository.getLatestMediaSafetyCheck(material.id)).toBeUndefined();
    expect(repository.getMediaSafetyCheck(first.traceId)).toBeUndefined();
    expect(() => repository.saveMediaSafetyCheck(first)).toThrow("active owned material");
  });

  it("stores isolated session hashes, prunes expiry and capacity, and removes sessions with the account", () => {
    const repository = create();
    repository.saveAuthSession({ tokenHash: "expired-hash", userId: user.id, createdAt: 1, expiresAt: 10 });
    repository.saveAuthSession({ tokenHash: "old-hash", userId: user.id, createdAt: 2, expiresAt: 100 });
    repository.saveAuthSession({ tokenHash: "new-hash", userId: user.id, createdAt: 3, expiresAt: 100 });
    repository.getAuthSession("new-hash")!.expiresAt = 0;
    expect(repository.pruneAuthSessions(10, 1)).toBe(2);
    expect(repository.getAuthSession("expired-hash")).toBeUndefined();
    expect(repository.getAuthSession("old-hash")).toBeUndefined();
    expect(repository.getAuthSession("new-hash")?.expiresAt).toBe(100);
    repository.deleteAuthSession("new-hash");
    expect(repository.getAuthSession("new-hash")).toBeUndefined();
    repository.saveAuthSession({ tokenHash: "last-hash", userId: user.id, createdAt: 4, expiresAt: 100 });
    repository.deleteUser(user.id);
    expect(repository.getAuthSession("last-hash")).toBeUndefined();
  });

  it("preserves an existing draft and confirmed evidence when generation was interrupted", () => {
    const repository = create();
    const withDraft: Letter = {
      ...letter, state: "GENERATING", audioTranscriptRevisionPending: true,
      audioTranscripts: [{ materialId: material.id, text: "已核对的内容", confirmed: true }],
      draft: { version: 3, title: "一封家书", greeting: "妈妈：", closing: "想你", signature: "小暖", provider: "qwen", generatedAt: now,
        paragraphs: [{ id: "p1", text: "已有的草稿", sourceRefs: [material.id], sourceAttribution: "needs-review" }] },
    };
    repository.saveLetter(withDraft);
    repository.saveJob(job);
    repository.recoverInterruptedJobs(now);
    expect(repository.getLetter(letter.id)).toEqual({ ...withDraft, state: "EDITING" });
  });
});

describe("SQLite durability", () => {
  it("retains safe provider-error diagnostics across restart without retaining the callback payload", () => {
    const filename = temporaryDatabase();
    const first = sqlite(filename);
    seed(first);
    first.saveMaterial({ ...material, type: "photo", objectKey: "synthetic/photo.jpg", contentType: "image/jpeg" });
    first.saveMediaSafetyCheck({ traceId: "error-trace", materialId: material.id, userId: user.id, status: "pending", createdAt: now, updatedAt: now });
    const service = new WarmLetterService(first, new FakeAIProvider());
    const safety = new ProductionSafety({ repository: first, service,
      provider: { name: "synthetic", checkText: async () => ({ decision: "allow", traceId: "text" }), submitMedia: async () => ({ decision: "pending", traceId: "error-trace" }) },
      publicBaseUrl: "https://synthetic.example", signingKeys: [Buffer.alloc(32, 1)], now: () => new Date(now) });
    const token = "syntheticCallbackToken";
    const timestamp = String(Date.parse(now) / 1000);
    const nonce = "synthetic-nonce";
    const verifier = new WechatModerationCallbackVerifier({ token, appId: "synthetic-app", allowPlaintext: true, now: () => Date.parse(now) });
    const parsed = verifier.decodeMediaCheckCallback({ timestamp, nonce, signature: createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex") }, {
      MsgType: "event", Event: "wxa_media_check", appid: "synthetic-app", version: 2, trace_id: "error-trace", errcode: -1008,
      errmsg: "PRIVATE_RAW_ERROR", openid: "PRIVATE_OPENID", media_url: "https://private.invalid/?access_token=PRIVATE_CREDENTIAL",
    });
    safety.acceptCallback(parsed!);
    expect(() => safety.assertMediaPassed(letter)).toThrow("安全检查");
    first.close();
    const reopened = sqlite(filename);
    expect(reopened.getLatestMediaSafetyCheck(material.id)).toMatchObject({
      status: "failed", diagnostic: { reason: "provider", wechatErrorCode: -1008 },
    });
    const inspector = new DatabaseSync(filename, { readOnly: true });
    try {
      const data = String(inspector.prepare("SELECT data FROM media_safety_checks WHERE trace_id = ?").get("error-trace")?.data);
      expect(data).not.toMatch(/PRIVATE|openid|media_url|errmsg|access_token/);
    } finally { inspector.close(); }
  });

  it("reopens complete private letters, source evidence, share hashes, request keys and cleanup outbox", () => {
    const filename = temporaryDatabase();
    const first = sqlite(filename);
    seed(first);
    first.saveMaterialIdempotently({ ...material, id: "durable-upload" }, "request-1", "fingerprint-1");
    first.saveLetter({ ...letter, state: "GENERATING", audioTranscripts: [{ materialId: "durable-upload", text: "今天去散步了", confirmed: true }] });
    first.saveJob(job);
    first.saveShareAccess(share);
    first.saveReplyIdempotentlyIfBelowLimit(reply, 10, "reply-fp", "reply-key");
    first.scheduleObjectDeletion("private/to-delete.mp3");
    first.scheduleObjectDeletion("private/to-delete.mp3");
    first.saveMediaSafetyCheck({ traceId: "trace", materialId: material.id, userId: user.id, status: "pending", createdAt: now, updatedAt: now });
    first.saveAuthSession({ tokenHash: "hashed-token", userId: user.id, createdAt: 1, expiresAt: 100 });
    first.close();
    const reopened = sqlite(filename);
    expect(reopened.getUser(user.id)).toEqual(user);
    expect(reopened.findUserByOpenId(user.openId)).toEqual(user);
    expect(reopened.getLetter(letter.id)?.audioTranscripts?.[0]?.confirmed).toBe(true);
    expect(reopened.getJob(job.id)?.status).toBe("running"); // Recovery is an explicit startup decision.
    expect(reopened.findShareAccessByTokenHash(share.tokenHash)).toEqual(share);
    expect(reopened.findReplyByIdempotencyKey(letter.id, "reply-key")).toEqual({ reply, requestFingerprint: "reply-fp" });
    expect(reopened.saveMaterialIdempotently({ ...material, id: "ignored-upload" }, "request-1", "different")).toMatchObject({ material: { id: "durable-upload" }, replayed: true, requestFingerprint: "fingerprint-1" });
    expect(reopened.listObjectDeletions()).toEqual(["private/to-delete.mp3"]);
    expect(reopened.getMediaSafetyCheck("trace")?.status).toBe("pending");
    expect(reopened.getAuthSession("hashed-token")).toEqual({ tokenHash: "hashed-token", userId: user.id, createdAt: 1, expiresAt: 100 });
    reopened.completeObjectDeletion("private/to-delete.mp3");
    expect(reopened.listObjectDeletions()).toEqual([]);
    reopened.close();
    expect(sqlite(filename).listObjectDeletions()).toEqual([]);
  });

  it("enforces WAL, full durability, ownership foreign keys and rejects corrupt identity changes atomically", () => {
    const filename = temporaryDatabase();
    const repository = sqlite(filename);
    seed(repository);
    const inspector = new DatabaseSync(filename);
    try {
      expect(inspector.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(inspector.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(inspector.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { inspector.close(); }
    expect(() => repository.saveLetter({ ...letter, userId: "missing-user" })).toThrow();
    expect(repository.getLetter(letter.id)?.userId).toBe(user.id);
    repository.saveUser({ ...user, id: "u2", openId: "openid-2" });
    expect(() => repository.saveJob({ ...job, userId: "u2" })).toThrow();
    expect(repository.getJob(job.id)).toBeUndefined();
    expect(() => repository.saveShareAccess({ ...share, letterId: "deleted-letter" })).toThrow();
  });

  it("keeps independently opened connections consistent under simultaneous requests", async () => {
    const filename = temporaryDatabase();
    const first = sqlite(filename);
    seed(first);
    const second = sqlite(filename);
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => Promise.resolve().then(() => {
      const repository = index % 2 ? first : second;
      return repository.saveReplyIdempotentlyIfBelowLimit({ ...reply, id: `r-${index}` }, 1, "same-content", "one-send");
    })));
    expect(results.filter((result) => !result?.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result?.reply.id)).size).toBe(1);
    expect(first.listReplies(letter.id)).toEqual(second.listReplies(letter.id));
    expect(first.listReplies(letter.id)).toHaveLength(1);
  });

  it("serializes genuinely parallel writer connections without duplicate replies or exceeding the limit", async () => {
    const filename = temporaryDatabase();
    const repository = sqlite(filename);
    seed(repository);
    const require = createRequire(import.meta.url);
    const workers = Array.from({ length: 4 }, (_, index) => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { tsImport } = await import(workerData.loader);
        const { SqliteRepository } = await tsImport(workerData.repository, workerData.parentURL);
        const repository = new SqliteRepository({ filename: workerData.filename });
        parentPort.once('message', () => {
          try {
            const replay = repository.saveReplyIdempotentlyIfBelowLimit({
              ...workerData.reply, id: 'same-' + workerData.index
            }, 7, 'shared-fingerprint', 'shared-key');
            for (let i = 0; i < 10; i++) repository.saveReplyIdempotentlyIfBelowLimit({
              ...workerData.reply, id: 'unique-' + workerData.index + '-' + i
            }, 7, 'different-fingerprint', 'key-' + workerData.index + '-' + i);
            repository.close();
            parentPort.postMessage({ type: 'done', replay });
          } catch (error) { parentPort.postMessage({ type: 'failed', message: error.message }); }
        });
        parentPort.postMessage({ type: 'ready' });
      })().catch(error => parentPort.postMessage({ type: 'failed', message: error.message }));
    `, {
      eval: true,
      workerData: {
        index, filename, reply,
        loader: pathToFileURL(require.resolve("tsx/esm/api")).href,
        repository: new URL("../src/sqlite-repository.ts", import.meta.url).href,
        parentURL: import.meta.url,
      },
    }));
    try {
      await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) => message.type === "ready" ? resolve() : reject(new Error(message.message)));
      })));
      const outcomes = workers.map((worker) => new Promise<{ replay: { reply: Reply; replayed: boolean } }>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) => message.type === "done" ? resolve(message) : reject(new Error(message.message)));
      }));
      for (const worker of workers) worker.postMessage("start");
      const results = await Promise.all(outcomes);
      expect(results.filter((result) => !result.replay.replayed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.replay.reply.id)).size).toBe(1);
      expect(repository.listReplies(letter.id)).toHaveLength(7);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 15_000);

  it("refuses newer database schemas instead of damaging data", () => {
    const filename = temporaryDatabase();
    const database = new DatabaseSync(filename);
    database.exec("PRAGMA user_version = 999");
    database.close();
    expect(() => sqlite(filename)).toThrow("newer than this server");
  });
});
