import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { OpenAIResponsesProvider, type GenerateLetterInput } from "../src/ai.js";
import type { Letter, LetterDraft } from "../src/domain.js";
import type { ContentSafetyProvider, MediaSafetyProvider } from "../src/content-safety.js";
import { FileSystemObjectStorage } from "../src/object-storage.js";
import { SqliteRepository } from "../src/sqlite-repository.js";
import type { SpeechAudio, SpeechProvider } from "../src/speech.js";
import { WechatModerationCallbackVerifier } from "../src/wechat-moderation-callback.js";
import { auth, json, login } from "./helpers.js";

const callbackToken = "syntheticMessageToken";
const callbackApp = "wxProductionTest";
const callbackKey = Buffer.alloc(32, 9);
const signingKey = Buffer.alloc(32, 7);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function draftFor(materialId: string): LetterDraft {
  return { version: 1, title: "一切都好", greeting: "妈妈：", paragraphs: [
    { id: "paragraph", text: "今天按时吃饭，也想起了你。", sourceRefs: [materialId], sourceAttribution: "ai" },
  ], closing: "照顾好自己。", signature: "想念你的我", provider: "synthetic-test", generatedAt: new Date().toISOString() };
}

function callbackEnvelope(traceId: string, suggest: string, errcode = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "test-nonce";
  const message = Buffer.from(JSON.stringify({ MsgType: "event", Event: "wxa_media_check", appid: callbackApp, version: 2, trace_id: traceId, errcode, result: { suggest } }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const content = Buffer.concat([Buffer.alloc(16, 1), length, message, Buffer.from(callbackApp)]);
  const padding = 32 - content.length % 32;
  const cipher = createCipheriv("aes-256-cbc", callbackKey, callbackKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const Encrypt = Buffer.concat([cipher.update(Buffer.concat([content, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
  const signature = createHash("sha1").update([callbackToken, timestamp, nonce, Encrypt].sort().join("")).digest("hex");
  return { url: `/v1/wechat/messages?timestamp=${timestamp}&nonce=${nonce}&encrypt_type=aes&msg_signature=${signature}`, payload: { Encrypt } };
}

describe("production persistence, deletion and content safety integration", () => {
  let directory: string;
  let app: FastifyInstance;
  let repository: SqliteRepository;
  let storage: FileSystemObjectStorage;
  let checkText: ReturnType<typeof vi.fn<ContentSafetyProvider["checkText"]>>;
  let submitMedia: ReturnType<typeof vi.fn<MediaSafetyProvider["submitMedia"]>>;
  let generate: ReturnType<typeof vi.fn<(input: GenerateLetterInput) => Promise<LetterDraft>>>;
  let synthesize: ReturnType<typeof vi.fn<SpeechProvider["synthesize"]>>;

  function construct(): FastifyInstance {
    const ai = new OpenAIResponsesProvider({ apiKey: "synthetic-unused", model: "synthetic-unused" });
    vi.spyOn(ai, "generateLetter").mockImplementation(generate);
    const options: BuildAppOptions = {
      deploymentMode: "production", authProviderMode: "wechat", repository, objectStorage: storage,
      durableStorage: true, publicBaseUrl: "https://api.example.test", mediaSigningKeys: [signingKey], aiProvider: ai,
      mediaTemporaryDirectory: join(directory, "media-tmp"),
      wechatAuthProvider: { exchangeCode: async (code) => ({ openId: `wechat-${code}` }) },
      contentSafetyProvider: { name: "wechat-msg-sec-check-v2", checkText, submitMedia },
      moderationCallback: new WechatModerationCallbackVerifier({ token: callbackToken, appId: callbackApp, encodingAesKey: callbackKey.toString("base64").slice(0, -1) }),
      speechProvider: { name: "synthetic-tts", voices: [{ id: "voice", name: "测试声音", description: "测试", gender: "female" }], synthesize },
    };
    return buildApp(options);
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "warm-letter-production-test-"));
    repository = new SqliteRepository({ filename: join(directory, "api.sqlite") });
    storage = new FileSystemObjectStorage(join(directory, "uploads"));
    checkText = vi.fn<ContentSafetyProvider["checkText"]>().mockResolvedValue({ decision: "allow", traceId: "text-trace" });
    submitMedia = vi.fn<MediaSafetyProvider["submitMedia"]>().mockResolvedValue({ decision: "pending", traceId: "media-trace" });
    generate = vi.fn(async (input: GenerateLetterInput) => draftFor(input.materials[0]!.id));
    synthesize = vi.fn<SpeechProvider["synthesize"]>().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: "audio/wav" });
    app = construct();
  });

  afterEach(async () => {
    await app?.close();
    repository?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fixture(token: string, media = false) {
    const user = app.warmLetterService.authenticate(token);
    const { material } = app.warmLetterService.registerMaterial(user.id, media
      ? { type: "photo", name: "photo.jpg", contentType: "image/jpeg", objectKey: `${user.id}/photo.jpg` }
      : { type: "text", name: "近况", textContent: "今天按时吃饭。" });
    const initial = app.warmLetterService.createLetter(user.id, { recipient: "妈妈", materialIds: [material.id] });
    const letter = repository.saveLetter({ ...initial, state: "EDITING", draft: draftFor(material.id) });
    return { user, material, letter };
  }

  async function publish(token: string, id: string) {
    const result = await app.inject({ method: "POST", url: `/v1/letters/${id}/confirm`, headers: auth(token), payload: {} });
    expect(result.statusCode, result.body).toBe(200);
    return json<{ shareToken: string; readerUrl: string }>(result);
  }

  async function mediaFixture(token: string) {
    const result = fixture(token, true);
    await storage.put(result.material.objectKey!, { bytes: Buffer.from("ffd8ffd9", "hex"), contentType: "image/jpeg" });
    return result;
  }

  it("retains owner login and shared letters across SQLite restart, while rejecting forged dev tokens", async () => {
    const owner = await login(app, "owner");
    const { user, letter } = fixture(owner);
    const published = await publish(owner, letter.id);
    const before = await app.inject({ method: "GET", url: "/health" });
    expect(json(before)).toMatchObject({ nonProduction: false, capabilities: { repository: "sqlite", authentication: "wechat", contentSafety: "wechat-text-and-media" } });
    await app.close();
    repository.close();
    repository = new SqliteRepository({ filename: join(directory, "api.sqlite") });
    app = construct();
    const list = await app.inject({ method: "GET", url: "/v1/letters", headers: auth(owner) });
    expect(list.statusCode).toBe(200);
    expect(json<{ letters: Letter[] }>(list).letters.map((entry) => entry.id)).toEqual([letter.id]);
    expect((await app.inject({ method: "GET", url: published.readerUrl })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/letters", headers: auth(`dev.${user.id}`) })).statusCode).toBe(401);
  });

  it("protects owner deletion and immediately revokes readers while keeping independent materials", async () => {
    const owner = await login(app, "owner");
    const stranger = await login(app, "stranger");
    const { letter, material } = fixture(owner);
    const published = await publish(owner, letter.id);
    expect((await app.inject({ method: "DELETE", url: `/v1/letters/${letter.id}`, headers: auth(stranger) })).statusCode).toBe(404);
    expect(repository.getLetter(letter.id)).toBeDefined();
    expect((await app.inject({ method: "DELETE", url: `/v1/letters/${letter.id}`, headers: auth(owner) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: published.readerUrl })).statusCode).toBe(404);
    expect(repository.getMaterial(material.id)).toBeDefined();
    expect(repository.listShareAccess(letter.id)).toEqual([]);
  });

  it("requires authenticated replies, hides author IDs, isolates retry keys and erases an author's cross-letter replies", async () => {
    const owner = await login(app, "owner");
    const author = await login(app, "author");
    const stranger = await login(app, "stranger");
    const { letter } = fixture(owner);
    const published = await publish(owner, letter.id);
    const url = `/v1/letters/${letter.id}/replies?token=${published.shareToken}`;
    const payload = { text: "收到啦，放心。", authorName: "家人" };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    const sent = await app.inject({ method: "POST", url, headers: { ...auth(author), "idempotency-key": "shared_reply_key_20260923" }, payload });
    expect(sent.statusCode, sent.body).toBe(201);
    const authorId = app.warmLetterService.authenticate(author).id;
    expect(repository.listReplies(letter.id)[0]).toMatchObject({ authorUserId: authorId, authorVerified: true });
    expect(sent.body).not.toContain(authorId);
    expect(sent.body).not.toContain("authorUserId");
    const replay = await app.inject({ method: "POST", url, headers: { ...auth(author), "idempotency-key": "shared_reply_key_20260923" }, payload });
    expect(replay.body).toBe(sent.body);
    const crossAuthor = await app.inject({ method: "POST", url, headers: { ...auth(stranger), "idempotency-key": "shared_reply_key_20260923" }, payload });
    expect(crossAuthor.statusCode).toBe(409);
    for (const response of [
      await app.inject({ method: "GET", url: published.readerUrl }),
      await app.inject({ method: "GET", url: `/v1/letters/${letter.id}/replies`, headers: auth(owner) }),
    ]) expect(response.body).not.toContain("authorUserId");
    expect((await app.inject({ method: "DELETE", url: "/v1/account", headers: auth(author) })).statusCode).toBe(204);
    expect(repository.listReplies(letter.id)).toEqual([]);
    expect(repository.getLetter(letter.id)).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/v1/letters", headers: auth(author) })).statusCode).toBe(401);
  });

  it.each(["letter", "account"])("does not restore generation or late transcripts after deleting the %s", async (target) => {
    const pending = deferred<LetterDraft>();
    generate.mockImplementationOnce(() => pending.promise);
    const owner = await login(app, "owner");
    const { letter, user, material } = fixture(owner);
    const started = await app.inject({ method: "POST", url: `/v1/letters/${letter.id}/generate`, headers: auth(owner), payload: {} });
    expect(started.statusCode).toBe(202);
    const jobId = json<{ job: { id: string } }>(started).job.id;
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const deleted = await app.inject({ method: "DELETE", url: target === "letter" ? `/v1/letters/${letter.id}` : "/v1/account", headers: auth(owner) });
    expect(deleted.statusCode).toBe(204);
    expect(() => generate.mock.calls[0]![0].onTranscript?.({ materialId: material.id, text: "迟到转写", confirmed: false })).toThrow();
    pending.resolve(draftFor(material.id));
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.getLetter(letter.id)).toBeUndefined();
    expect(repository.getJob(jobId)).toBeUndefined();
    if (target === "account") expect(repository.getUser(user.id)).toBeUndefined();
  });

  it("discards TTS that finishes after letter deletion before writing its audio", async () => {
    const pending = deferred<SpeechAudio>();
    synthesize.mockImplementationOnce(() => pending.promise);
    const put = vi.spyOn(storage, "put");
    const owner = await login(app, "owner");
    const { letter } = fixture(owner);
    const text = app.warmLetterService.getNarrationText(app.warmLetterService.authenticate(owner).id, letter.id);
    const speech = app.inject({ method: "POST", url: `/v1/letters/${letter.id}/speech`, headers: auth(owner), payload: { text, voiceId: "voice", tone: "warm", persist: true } });
    void speech.then(() => undefined);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
    expect((await app.inject({ method: "DELETE", url: `/v1/letters/${letter.id}`, headers: auth(owner) })).statusCode).toBe(204);
    pending.resolve({ bytes: new Uint8Array([1, 2]), contentType: "audio/wav" });
    expect((await speech).statusCode).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("removes a TTS object whose disk write finishes after account erasure", async () => {
    const pending = deferred<void>();
    const originalPut = storage.put.bind(storage);
    const put = vi.spyOn(storage, "put").mockImplementationOnce(async (key, input) => { await pending.promise; return originalPut(key, input); });
    const owner = await login(app, "owner");
    const { letter, user } = fixture(owner);
    const text = app.warmLetterService.getNarrationText(user.id, letter.id);
    const speech = app.inject({ method: "POST", url: `/v1/letters/${letter.id}/speech`, headers: auth(owner), payload: { text, voiceId: "voice", tone: "warm", persist: true } });
    void speech.then(() => undefined);
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect((await app.inject({ method: "DELETE", url: "/v1/account", headers: auth(owner) })).statusCode).toBe(204);
    pending.resolve();
    expect((await speech).statusCode).toBe(404);
    expect(await storage.read(put.mock.calls[0]![0])).toBeUndefined();
    expect(repository.listObjectDeletions()).toEqual([]);
  });

  it("removes an uploaded file whose disk commit finishes after account erasure", async () => {
    const pending = deferred<void>();
    const originalPut = storage.put.bind(storage);
    const put = vi.spyOn(storage, "put").mockImplementationOnce(async (key, input) => { await pending.promise; return originalPut(key, input); });
    const owner = await login(app, "owner");
    const presign = await app.inject({ method: "POST", url: "/v1/materials/presign", headers: auth(owner), payload: { type: "photo", filename: "photo.png", contentType: "image/png" } });
    expect(presign.statusCode, presign.body).toBe(201);
    const ticket = json<{ uploadUrl: string; headers: Record<string, string>; materialId: string }>(presign);
    const parsedUrl = new URL(ticket.uploadUrl);
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082", "hex");
    const upload = app.inject({ method: "PUT", url: parsedUrl.pathname + parsedUrl.search, headers: ticket.headers, payload: png });
    void upload.then(() => undefined);
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect((await app.inject({ method: "DELETE", url: "/v1/account", headers: auth(owner) })).statusCode).toBe(204);
    pending.resolve();
    expect((await upload).statusCode).toBe(404);
    expect(repository.getMaterial(ticket.materialId)).toBeUndefined();
    expect(await storage.read(put.mock.calls[0]![0])).toBeUndefined();
  });

  it("keeps pending and failed media checks from issuing shares, and rejects forged callbacks", async () => {
    const owner = await login(app, "owner");
    const { letter, material } = await mediaFixture(owner);
    const confirm = () => app.inject({ method: "POST", url: `/v1/letters/${letter.id}/confirm`, headers: auth(owner), payload: {} });
    const pending = await confirm();
    expect(pending.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(pending).error.code).toBe("CONTENT_SAFETY_PENDING");
    const envelope = callbackEnvelope("media-trace", "pass");
    const forged = await app.inject({ method: "POST", url: envelope.url.replace(/msg_signature=.*/, "msg_signature=" + "0".repeat(40)), payload: envelope.payload });
    expect(forged.statusCode).toBe(400);
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("pending");
    const failed = callbackEnvelope("media-trace", "pass", -1);
    expect((await app.inject({ method: "POST", ...failed })).statusCode).toBe(200);
    expect(repository.getLatestMediaSafetyCheck(material.id)?.status).toBe("failed");
    expect((await confirm()).statusCode).toBe(503);
    expect(repository.listShareAccess(letter.id)).toEqual([]);
    expect(repository.getLetter(letter.id)?.state).toBe("EDITING");
  });

  it.each(["pass", "risky"])("publishes media only after an authenticated %s callback permits it", async (suggest) => {
    const owner = await login(app, "owner");
    const { letter } = await mediaFixture(owner);
    const confirm = () => app.inject({ method: "POST", url: `/v1/letters/${letter.id}/confirm`, headers: auth(owner), payload: {} });
    expect((await confirm()).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", ...callbackEnvelope("media-trace", suggest) })).statusCode).toBe(200);
    expect((await confirm()).statusCode).toBe(suggest === "pass" ? 200 : 422);
    expect(repository.listShareAccess(letter.id)).toHaveLength(suggest === "pass" ? 1 : 0);
  });

  it("does not publish a different draft changed while text checking is in flight", async () => {
    const pending = deferred<{ decision: "allow"; traceId: string }>();
    checkText.mockImplementationOnce(() => pending.promise);
    const owner = await login(app, "owner");
    const { letter } = fixture(owner);
    const confirmation = app.inject({ method: "POST", url: `/v1/letters/${letter.id}/confirm`, headers: auth(owner), payload: {} });
    void confirmation.then(() => undefined);
    await vi.waitFor(() => expect(checkText).toHaveBeenCalledOnce());
    repository.saveLetter({ ...letter, draft: { ...letter.draft!, title: "另一个尚未检查的标题" } });
    pending.resolve({ decision: "allow", traceId: "text-trace" });
    const result = await confirmation;
    expect(result.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(result).error.code).toBe("DRAFT_CHANGED");
    expect(repository.listShareAccess(letter.id)).toEqual([]);
  });
});
