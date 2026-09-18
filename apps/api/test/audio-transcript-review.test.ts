import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetLetterReaderResponseSchema, GetLetterResponseSchema } from "@warm-letter/contracts";
import { OpenAICompatibleChatProvider } from "../src/ai.js";
import { buildApp } from "../src/app.js";
import type { Letter } from "../src/domain.js";
import { MemoryRepository } from "../src/repository.js";
import { letterDraftSpeechText } from "../src/service.js";
import { auth, json, login, registerTextMaterial, waitForJob } from "./helpers.js";

const initialTranscript = "今天上午开了个长会，有点累。";
const correctedTranscript = "今天上午开了个会，有点累。";

describe("private audio transcript review", () => {
  let app: FastifyInstance;
  let repository: MemoryRepository;
  let token: string;
  let audioId: string;
  let letterId: string;
  let transcribe: ReturnType<typeof vi.fn>;
  let complete: ReturnType<typeof vi.fn>;
  let synthesize: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    transcribe = vi.fn().mockResolvedValue({ text: initialTranscript });
    complete = vi.fn(async (request: {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    }) => {
      const content = request.messages.find((message) => message.role === "user")!.content;
      if (!Array.isArray(content)) throw new Error("Missing material content");
      const material = content.filter((part) => part.type === "text").map(
        (part) => JSON.parse(part.text!) as { materialId?: string; transcript?: string },
      ).find((part) => part.transcript);
      return {
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          title: "近况",
          greeting: "家里人：",
          paragraphs: [{ text: material!.transcript, sourceRefs: [material!.materialId] }],
          closing: "祝平安。",
        }) } }],
      };
    });
    const client = {
      chat: { completions: { create: complete } },
      audio: { transcriptions: { create: transcribe } },
    } as unknown as OpenAI;
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "test-model",
      baseURL: "https://example.test/v1",
      audioMode: "transcription",
      transcriptionModel: "test-asr",
      assetReader: { read: async () => ({ bytes: Uint8Array.from([1, 2, 3]), contentType: "audio/mpeg" }) },
      client,
    });
    synthesize = vi.fn().mockResolvedValue({ bytes: Uint8Array.from([1]), contentType: "audio/mpeg" });
    app = buildApp({
      deploymentMode: "test",
      repository,
      aiProvider: provider,
      speechProvider: { name: "test-tts", voices: [], synthesize },
      generationRateLimits: { perUser: 10 },
    });
    const loggedIn = await app.inject({
      method: "POST", url: "/v1/auth/wx-login", payload: { code: "transcript-owner" },
    });
    const session = json<{ token: string; user: { id: string } }>(loggedIn);
    token = session.token;
    audioId = randomUUID();
    repository.saveMaterial({
      id: audioId, userId: session.user.id, type: "audio", name: "近况.mp3",
      objectKey: `${session.user.id}/audio.mp3`, contentType: "audio/mpeg",
      status: "READY", createdAt: new Date().toISOString(),
    });
    const created = await app.inject({
      method: "POST", url: "/v1/letters", headers: auth(token),
      payload: { recipient: "家里人", materialIds: [audioId] },
    });
    expect(created.statusCode).toBe(201);
    letterId = json<{ letter: Letter }>(created).letter.id;
  });

  afterEach(async () => { await app.close(); });

  async function getLetter(): Promise<Letter> {
    const response = await app.inject({ method: "GET", url: `/v1/letters/${letterId}`, headers: auth(token) });
    expect(GetLetterResponseSchema.safeParse(response.json()).success).toBe(true);
    return json<{ letter: Letter }>(response).letter;
  }

  async function generate() {
    const response = await app.inject({ method: "POST", url: `/v1/letters/${letterId}/generate`, headers: auth(token), payload: {} });
    expect(response.statusCode).toBe(202);
    return waitForJob(app, token, json<{ job: { id: string } }>(response).job.id);
  }

  function update(text = correctedTranscript, materialId = audioId, requester = token) {
    return app.inject({
      method: "PATCH", url: `/v1/letters/${letterId}/audio-transcripts/${materialId}`,
      headers: auth(requester), payload: { text },
    });
  }

  function confirm() {
    return app.inject({ method: "POST", url: `/v1/letters/${letterId}/confirm`, headers: auth(token), payload: {} });
  }

  it("requires owner authentication and an editable generated letter", async () => {
    const noAuth = await app.inject({
      method: "PATCH", url: `/v1/letters/${letterId}/audio-transcripts/${audioId}`,
      payload: { text: correctedTranscript },
    });
    expect(noAuth.statusCode).toBe(401);
    expect((await update()).statusCode).toBe(409);
    await generate();
    const otherToken = await login(app, "transcript-other-user");
    expect((await update(correctedTranscript, audioId, otherToken)).statusCode).toBe(404);
    let releaseTranscription!: (value: { text: string }) => void;
    transcribe.mockReturnValueOnce(new Promise((resolve) => { releaseTranscription = resolve; }));
    const queued = await app.inject({ method: "POST", url: `/v1/letters/${letterId}/generate`, headers: auth(token), payload: {} });
    expect((await update()).statusCode).toBe(409);
    releaseTranscription({ text: initialTranscript });
    await waitForJob(app, token, json<{ job: { id: string } }>(queued).job.id);
    expect((await getLetter()).audioTranscripts?.[0]?.text).toBe(initialTranscript);
  });

  it("rejects unknown, non-audio, removed, and foreign material IDs and invalid text", async () => {
    await generate();
    expect((await update(correctedTranscript, randomUUID())).statusCode).toBe(404);
    const textId = await registerTextMaterial(app, token);
    await app.inject({ method: "PATCH", url: `/v1/letters/${letterId}`, headers: auth(token), payload: { materialIds: [audioId, textId] } });
    expect((await update(correctedTranscript, textId)).statusCode).toBe(404);
    const otherToken = await login(app, "foreign-material-owner");
    const foreignId = await registerTextMaterial(app, otherToken);
    expect((await update(correctedTranscript, foreignId)).statusCode).toBe(404);
    for (const text of [" ", "字".repeat(50_001)]) {
      expect((await update(text)).statusCode).toBe(400);
    }
    const malformed = await app.inject({
      method: "PATCH", url: `/v1/letters/${letterId}/audio-transcripts/${audioId}`,
      headers: auth(token), payload: { text: correctedTranscript, confirmed: true },
    });
    expect(malformed.statusCode).toBe(400);
    await app.inject({ method: "PATCH", url: `/v1/letters/${letterId}`, headers: auth(token), payload: { materialIds: [textId] } });
    expect((await update()).statusCode).toBe(404);
  });

  it("preserves raw ASR privately, requires review, and regenerates using the correction without another ASR call", async () => {
    expect((await generate()).status).toBe("succeeded");
    const first = await getLetter();
    expect(first.audioTranscripts).toEqual([{ materialId: audioId, text: initialTranscript, confirmed: false }]);
    expect(first.draft?.paragraphs[0]).toMatchObject({ text: initialTranscript, sourceAttribution: "needs-review", sourceRefs: [audioId] });
    const saved = await app.inject({
      method: "PATCH", url: `/v1/letters/${letterId}`, headers: auth(token),
      payload: { draft: { paragraphs: first.draft!.paragraphs.map(({ text, sourceRefs, sourceAttribution }) => ({ text, sourceRefs, sourceAttribution })) } },
    });
    expect(saved.statusCode).toBe(200);
    expect(json<{ error: { code: string } }>(await confirm()).error.code).toBe("SOURCE_REVIEW_REQUIRED");
    const correction = await update(`  ${correctedTranscript}  `);
    expect(correction.statusCode).toBe(200);
    const pending = json<{ letter: Letter }>(correction).letter;
    expect(pending.audioTranscripts).toEqual([{ materialId: audioId, text: correctedTranscript, confirmed: true }]);
    expect(pending.audioTranscriptRevisionPending).toBe(true);
    expect(pending.draft?.paragraphs[0]?.text).toBe(initialTranscript);
    expect(json<{ error: { code: string } }>(await confirm()).error.code).toBe("AUDIO_TRANSCRIPT_REGENERATION_REQUIRED");
    const speech = await app.inject({
      method: "POST", url: `/v1/letters/${letterId}/speech`, headers: auth(token),
      payload: { text: letterDraftSpeechText(pending.draft!), voiceId: "test", tone: "warm", persist: true },
    });
    expect(json<{ error: { code: string } }>(speech).error.code).toBe("AUDIO_TRANSCRIPT_REGENERATION_REQUIRED");
    expect(synthesize).not.toHaveBeenCalled();
    expect((await generate()).status).toBe("succeeded");
    const revised = await getLetter();
    expect(revised.audioTranscriptRevisionPending).toBe(false);
    expect(revised.draft?.paragraphs[0]).toMatchObject({ text: correctedTranscript, sourceAttribution: "ai", sourceRefs: [audioId] });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(4);
    const published = await confirm();
    expect(published.statusCode).toBe(200);
    const readerUrl = json<{ readerUrl: string }>(published).readerUrl;
    const reader = await app.inject({ method: "GET", url: readerUrl });
    expect(GetLetterReaderResponseSchema.safeParse(reader.json()).success).toBe(true);
    expect(reader.body).not.toContain("audioTranscripts");
    expect(reader.body).not.toContain("audioTranscriptRevisionPending");
    expect(reader.body).not.toContain(initialTranscript);
    expect((await update()).statusCode).toBe(409);
  });

  it("keeps corrected evidence and the publish guard when regeneration fails, then retries without ASR", async () => {
    await generate();
    await update();
    complete.mockRejectedValueOnce(new Error("private upstream detail"));
    expect((await generate()).status).toBe("failed");
    const failed = await getLetter();
    expect(failed.state).toBe("EDITING");
    expect(failed.audioTranscriptRevisionPending).toBe(true);
    expect(failed.audioTranscripts?.[0]).toMatchObject({ text: correctedTranscript, confirmed: true });
    expect(failed.draft?.paragraphs[0]?.text).toBe(initialTranscript);
    expect((await confirm()).statusCode).toBe(409);
    expect((await generate()).status).toBe("succeeded");
    expect((await getLetter()).draft?.paragraphs[0]?.text).toBe(correctedTranscript);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
