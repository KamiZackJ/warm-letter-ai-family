import OpenAI, { APIConnectionError, APIConnectionTimeoutError } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatProvider, type GenerateLetterInput } from "../src/ai.js";

const audioId = "33333333-3333-4333-8333-333333333333";
const chunk = (content: string, finish_reason: "stop" | "length" | null = null): ChatCompletionChunk => ({
  id: "test-chunk", object: "chat.completion.chunk", created: 1, model: "test-asr",
  choices: [{ index: 0, delta: { content }, finish_reason }],
});
const completed = { done: true, value: undefined } as const;

function streamWith(iterator: AsyncIterator<ChatCompletionChunk>) {
  return { controller: new AbortController(), [Symbol.asyncIterator]: () => iterator };
}

function fixture() {
  const create = vi.fn().mockResolvedValue({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      title: "近况", greeting: "家人：", paragraphs: [{ text: "今天开了个会。", sourceRefs: [audioId] }], closing: "祝平安。",
    }) } }],
  });
  const provider = new OpenAICompatibleChatProvider({
    apiKey: "test-key", model: "test-model", baseURL: "https://example.test/v1",
    audioMode: "streaming-chat-transcription", transcriptionModel: "test-asr",
    timeoutMs: 1_000, maxRetries: 5,
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    assetReader: { read: async () => ({ bytes: Uint8Array.from([1, 2, 3]), contentType: "audio/mp4" }) },
  });
  const onTranscript = vi.fn();
  const input: GenerateLetterInput = {
    recipient: "家人", settings: { tone: "warm", length: "short" }, version: 1,
    onTranscript,
    materials: [{ id: audioId, userId: "user-1", type: "audio", name: "近况.m4a", objectKey: "user-1/audio.m4a", contentType: "audio/mp4", status: "READY", createdAt: "2026-09-19T00:00:00.000Z" }],
  };
  return { create, provider, input, onTranscript };
}

function observe<T>(promise: Promise<T>) {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

describe("streaming ASR total deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("finishes on deadline before headers even if the transport ignores signal, and closes a late stream", async () => {
    const { create, provider, input, onTranscript } = fixture();
    const next = vi.fn().mockResolvedValue(completed);
    const finish = vi.fn().mockResolvedValue(completed);
    const lateStream = streamWith({ next, return: finish });
    let deliver!: (value: typeof lateStream) => void;
    create.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
    const result = observe(provider.generateLetter(input));
    await vi.advanceTimersByTimeAsync(0);
    const options = create.mock.calls[0]?.[1] as { signal: AbortSignal; timeout: number; maxRetries: number };
    expect(options).toMatchObject({ timeout: 1_000, maxRetries: 0 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT", retryable: true } });
    expect(options.signal.aborted).toBe(true);
    deliver(lateStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateStream.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("discards partial text after a stalled next(), even with stop=%s and cleanup that never ends", async (sawStop) => {
    const { create, provider, input, onTranscript } = fixture();
    const finish = vi.fn(() => new Promise<IteratorResult<ChatCompletionChunk>>(() => undefined));
    const next = vi.fn().mockResolvedValueOnce({ done: false, value: chunk("只收到这一段", sawStop ? "stop" : null) })
      .mockReturnValue(new Promise(() => undefined));
    const stream = streamWith({ next, return: finish });
    create.mockResolvedValueOnce(stream);
    const result = observe(provider.generateLetter(input));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT", message: "语音转写超时，请重试或缩短录音", retryable: true } });
    expect(stream.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never refreshes the total budget while chunks continue to arrive", async () => {
    const { create, provider, input, onTranscript } = fixture();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const next = vi.fn(() => new Promise<IteratorResult<ChatCompletionChunk>>((resolve) => {
      pending = setTimeout(() => resolve({ done: false, value: chunk("字") }), 100);
    }));
    const finish = vi.fn(async () => { clearTimeout(pending); return completed; });
    create.mockResolvedValueOnce(streamWith({ next, return: finish }));
    const result = observe(provider.generateLetter(input));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT", retryable: true } });
    expect(next.mock.calls.length).toBeGreaterThan(5);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a stream that quietly ends on abort after already reporting stop", async () => {
    const { create, provider, input, onTranscript } = fixture();
    let end!: (value: IteratorResult<ChatCompletionChunk>) => void;
    const next = vi.fn().mockResolvedValueOnce({ done: false, value: chunk("尚未完整接收", "stop") })
      .mockImplementation(() => new Promise((resolve) => { end = resolve; }));
    const stream = streamWith({ next, return: vi.fn().mockResolvedValue(completed) });
    create.mockImplementationOnce(async (_body: unknown, options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", () => end(completed), { once: true });
      return stream;
    });
    const result = observe(provider.generateLetter(input));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "AI_PROVIDER_TIMEOUT" } });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a fully completed stream, clears its timer, and ignores rejected cleanup", async () => {
    const { create, provider, input, onTranscript } = fixture();
    const next = vi.fn().mockResolvedValueOnce({ done: false, value: chunk("今天开了个会。", "stop") }).mockResolvedValue(completed);
    const finish = vi.fn().mockRejectedValue(new Error("private cleanup failure"));
    const stream = streamWith({ next, return: finish });
    create.mockResolvedValueOnce(stream);
    const result = observe(provider.generateLetter(input));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toHaveProperty("value.paragraphs");
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith({ materialId: audioId, text: "今天开了个会。", confirmed: false });
    expect(stream.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it.each([
    { failure: new APIConnectionError({ message: "private socket failure" }), code: "AI_PROVIDER_UNAVAILABLE" },
    { failure: new APIConnectionTimeoutError(), code: "AI_PROVIDER_TIMEOUT" },
    { failure: new Error("private upstream response"), code: "AI_PROVIDER_FAILED" },
  ])("preserves ordinary upstream classification $code and safely cleans up", async ({ failure, code }) => {
    const { create, provider, input, onTranscript } = fixture();
    const finish = vi.fn(() => { throw new Error("private cleanup failure"); });
    const stream = streamWith({ next: vi.fn().mockRejectedValue(failure), return: finish });
    create.mockResolvedValueOnce(stream);
    const result = observe(provider.generateLetter(input));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ error: { code, retryable: true } });
    const error = (await result as { error: Error }).error;
    expect(error.message).not.toContain("private");
    expect(onTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(stream.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
