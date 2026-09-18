import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoubaoSpeechProvider, QwenSpeechProvider } from "../src/speech.js";

const wav = Buffer.from("524946460400000057415645", "hex");
const qwenInput = { text: "今天一切都好。", voiceId: "Cherry", tone: "warm" as const };
const observe = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

describe("speech operation deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["qwen", "doubao"] as const)("bounds %s before headers and cleans up a late response", async (kind) => {
    let deliver!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { deliver = resolve; });
    });
    const provider = kind === "qwen"
      ? new QwenSpeechProvider({ apiKey: "test", timeoutMs: 1_000, fetchImpl: fetchImpl as typeof fetch })
      : new DoubaoSpeechProvider({ apiKey: "test", timeoutMs: 1_000, fetchImpl: fetchImpl as typeof fetch });
    const result = observe(provider.synthesize({ ...qwenInput, voiceId: provider.voices[0]!.id }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "SPEECH_PROVIDER_TIMEOUT", retryable: true } });
    expect(signal?.aborted).toBe(true);
    const cancel = vi.fn();
    deliver(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["qwen", "doubao"] as const)("rejects incomplete %s response bodies and never accepts partial audio", async (kind) => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const text = kind === "qwen"
          ? JSON.stringify({ output: { audio: { data: wav.toString("base64") } } })
          : `${JSON.stringify({ code: 0, data: Buffer.from([0x49, 0x44, 0x33]).toString("base64") })}\n${JSON.stringify({ code: 20_000_000 })}`;
        controller.enqueue(new TextEncoder().encode(text));
        // Keep the body open, even though the partial text happens to parse.
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body));
    const provider = kind === "qwen"
      ? new QwenSpeechProvider({ apiKey: "test", timeoutMs: 1_000, fetchImpl: fetchImpl as typeof fetch })
      : new DoubaoSpeechProvider({ apiKey: "test", timeoutMs: 1_000, fetchImpl: fetchImpl as typeof fetch });
    const result = observe(provider.synthesize({ ...qwenInput, voiceId: provider.voices[0]!.id }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { code: "SPEECH_PROVIDER_TIMEOUT" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one budget and cancellation signal between Qwen generation and audio download", async () => {
    const signals: AbortSignal[] = [];
    const cancel = vi.fn();
    let call = 0;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit): Promise<Response> => {
      signals.push(init!.signal!);
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({
          output: { audio: { url: "https://example.aliyuncs.com/generated.wav" } },
        }))), 800));
      }
      return Promise.resolve(new Response(new ReadableStream({ cancel })));
    });
    const provider = new QwenSpeechProvider({ apiKey: "test", timeoutMs: 1_000, fetchImpl: fetchImpl as typeof fetch });
    const result = observe(provider.synthesize(qwenInput));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ error: { code: "SPEECH_PROVIDER_TIMEOUT" } });
    expect(signals[0]?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts complete audio and clears timers, while preserving ordinary HTTP errors", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { audio: { data: wav.toString("base64") } } })))
      .mockResolvedValueOnce(new Response("private upstream details", { status: 401 }));
    const provider = new QwenSpeechProvider({ apiKey: "test", timeoutMs: 1_000, fetchImpl: fetchImpl as typeof fetch });
    await expect(provider.synthesize(qwenInput)).resolves.toMatchObject({ bytes: wav, contentType: "audio/wav" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(provider.synthesize(qwenInput)).rejects.toMatchObject({
      code: "SPEECH_PROVIDER_CONFIGURATION_ERROR", retryable: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
