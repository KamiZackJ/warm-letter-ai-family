import OpenAI, { APIConnectionError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatProvider, createAIProviderFromEnv, type GenerateLetterInput, type MaterialAsset } from "../src/ai.js";

const materialId = "33333333-3333-4333-8333-333333333333";
const output = {
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    title: "今天的近况", greeting: "家人：", paragraphs: [{ text: "今天开了个会。", sourceRefs: [materialId] }], closing: "祝平安。",
  }) } }],
};

function fixture(generationTimeoutMs = 1_000) {
  const create = vi.fn().mockResolvedValue(output);
  const transcribe = vi.fn().mockResolvedValue({ text: "今天开了个会。" });
  const read = vi.fn().mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), contentType: "audio/mp4" });
  const onTranscript = vi.fn();
  const options = {
    apiKey: "test-key", model: "test-model", baseURL: "https://example.test/v1",
    audioMode: "streaming-chat-transcription" as const, transcriptionModel: "test-asr",
    timeoutMs: 60_000, generationTimeoutMs,
    client: { chat: { completions: { create } }, audio: { transcriptions: { create: transcribe } } } as unknown as OpenAI,
    assetReader: { read },
  };
  const input: GenerateLetterInput = {
    recipient: "家人", settings: { tone: "warm", length: "short" }, version: 1, onTranscript,
    materials: [{ id: materialId, userId: "user-1", type: "text", name: "近况", textContent: "今天开了个会。", status: "READY", createdAt: "2026-09-19T00:00:00.000Z" }],
  };
  const audioInput: GenerateLetterInput = {
    ...input,
    materials: [{ ...input.materials[0]!, type: "audio", name: "近况.m4a", contentType: "audio/mp4", objectKey: "user-1/audio.m4a" }],
  };
  return { create, transcribe, read, options, input, audioInput, onTranscript };
}

function observe<T>(promise: Promise<T>) {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

describe("complete compatible generation deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("bounds media reads before any AI call and ignores late media", async () => {
    const { options, read, create, audioInput, onTranscript } = fixture();
    let deliver!: (asset: MaterialAsset) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(audioInput));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT", retryable: true } });
    deliver({ bytes: Uint8Array.from([1, 2, 3]), contentType: "audio/mp4" });
    await vi.advanceTimersByTimeAsync(0);
    expect(create).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a streaming ASR stage when the whole budget ends before its own 60-second timeout", async () => {
    const { options, create, audioInput, onTranscript } = fixture();
    const finish = vi.fn().mockReturnValue(new Promise(() => undefined));
    const iterator = { next: vi.fn().mockReturnValue(new Promise(() => undefined)), return: finish };
    const stream = { controller: new AbortController(), [Symbol.asyncIterator]: () => iterator };
    create.mockResolvedValueOnce(stream);
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(audioInput));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT", retryable: true } });
    expect(stream.controller.signal.aborted).toBe(true);
    expect(create.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never forwards a late non-streaming transcript or starts writing after the deadline", async () => {
    const { options, transcribe, create, audioInput, onTranscript } = fixture();
    let deliver!: (value: { text: string }) => void;
    transcribe.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
    const provider = new OpenAICompatibleChatProvider({ ...options, audioMode: "transcription" });
    const result = observe(provider.generateLetter(audioInput));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(transcribe.mock.calls[0]?.[1].signal.aborted).toBe(true);
    deliver({ text: "过期后到达的转写" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start review when a draft arrives after the caller already timed out", async () => {
    const { options, create, input } = fixture();
    let deliver!: (value: typeof output) => void;
    create.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(input));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(create.mock.calls[0]?.[1].signal.aborted).toBe(true);
    deliver(output);
    await vi.advanceTimersByTimeAsync(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the original deadline with factual review instead of granting another full budget", async () => {
    const { options, create, input } = fixture();
    create.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(output), 600)));
    create.mockReturnValueOnce(new Promise(() => undefined));
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(input));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1].signal).toBe(create.mock.calls[0]?.[1].signal);
    expect(create.mock.calls[1]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the one allowed empty-draft recovery at the earlier overall deadline", async () => {
    const { options, create, input } = fixture();
    create.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }), 600)));
    create.mockReturnValueOnce(new Promise(() => undefined));
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(input));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1]).toMatchObject({ timeout: 30_000, maxRetries: 0 });
    expect(create.mock.calls[1]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still imposes the shorter 30-second recovery deadline when the overall budget is longer", async () => {
    const { options, create, input } = fixture(150_000);
    create.mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    create.mockReturnValueOnce(new Promise(() => undefined));
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(input));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a successful generation without overriding bounded SDK retries", async () => {
    const { options, create, input } = fixture();
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(input));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toHaveProperty("value.paragraphs");
    expect(create).toHaveBeenCalledTimes(2);
    for (const [, requestOptions] of create.mock.calls) {
      expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
      expect(requestOptions.signal.aborted).toBe(true);
      expect(requestOptions.maxRetries).toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves ordinary error classification and clears the total timer", async () => {
    const { options, create, input } = fixture();
    create.mockRejectedValueOnce(new APIConnectionError({ message: "private upstream connection details" }));
    const result = observe(new OpenAICompatibleChatProvider(options).generateLetter(input));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_UNAVAILABLE", retryable: true } });
    expect((await result as { error: Error }).error.message).not.toContain("private");
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates the new environment setting and keeps the default total budget at 150 seconds", async () => {
    const environment = { AI_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_API_KEY: "test", OPENAI_COMPATIBLE_MODEL: "model", OPENAI_COMPATIBLE_BASE_URL: "https://example.test/v1" };
    for (const invalid of ["999", "300001", "not-a-number"]) {
      expect(() => createAIProviderFromEnv({ ...environment, OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS: invalid })).toThrow("OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS");
    }
    expect(() => createAIProviderFromEnv({ ...environment, OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS: "1000" })).not.toThrow();
    const { options, create, input } = fixture();
    create.mockReturnValueOnce(new Promise(() => undefined));
    const { generationTimeoutMs: _timeout, ...defaults } = options;
    const result = observe(new OpenAICompatibleChatProvider(defaults).generateLetter(input));
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(149_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
