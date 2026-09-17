import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmLetterResponseSchema,
  GetLetterReaderResponseSchema,
  GetLetterResponseSchema,
} from "@warm-letter/contracts";
import { buildApp } from "../src/app.js";
import {
  DoubaoSpeechProvider,
  QWEN_SPEECH_VOICES,
  QwenSpeechProvider,
  SPEECH_VOICES,
  SpeechProviderError,
  createSpeechProviderFromEnv,
  type SpeechProvider,
} from "../src/speech.js";
import type {
  ObjectStorage,
  StoredObject,
  StoredObjectMetadata,
} from "../src/object-storage.js";
import { letterDraftSpeechText } from "../src/service.js";
import { auth, json, login, registerTextMaterial, waitForJob } from "./helpers.js";

const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0xff, 0xfb]);
const wavBytes = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);

class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  async put(
    objectKey: string,
    input: { bytes: Buffer; contentType: string },
  ): Promise<StoredObjectMetadata> {
    const stored = {
      bytes: Buffer.from(input.bytes),
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
    };
    this.objects.set(objectKey, stored);
    return { contentType: stored.contentType, sizeBytes: stored.sizeBytes };
  }

  async head(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    const stored = this.objects.get(objectKey);
    return stored
      ? { contentType: stored.contentType, sizeBytes: stored.sizeBytes }
      : undefined;
  }

  async read(objectKey: string): Promise<StoredObject | undefined> {
    const stored = this.objects.get(objectKey);
    return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : undefined;
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

function doubaoResponse(bytes = mp3Bytes): Response {
  return new Response(
    [
      JSON.stringify({ code: 0, message: "", data: bytes.toString("base64") }),
      JSON.stringify({ code: 20_000_000, message: "OK", data: null }),
    ].join("\n"),
    { status: 200 },
  );
}

describe("Doubao Seed-TTS provider", () => {
  it("uses the V3 resource header, selected 2.0 voice, and combines MP3 chunks", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        doubaoResponse(),
    );
    const provider = new DoubaoSpeechProvider({
      apiKey: "test-doubao-key",
      fetchImpl: fetchMock as typeof fetch,
    });

    const audio = await provider.synthesize({
      text: "爸爸，今天一切都好。",
      voiceId: "zh_female_vv_uranus_bigtts",
      tone: "warm",
    });

    expect(Buffer.from(audio.bytes)).toEqual(mp3Bytes);
    expect(audio.contentType).toBe("audio/mpeg");
    const [url, request] = fetchMock.mock.calls[0] as Parameters<typeof fetch>;
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional");
    const headers = new Headers(request?.headers);
    expect(headers.get("X-Api-Key")).toBe("test-doubao-key");
    expect(headers.get("X-Api-Resource-Id")).toBe("seed-tts-2.0");
    const payload = JSON.parse(String(request?.body)) as {
      req_params: { speaker: string; additions: string; audio_params: Record<string, unknown> };
    };
    expect(payload.req_params.speaker).toBe("zh_female_vv_uranus_bigtts");
    expect(JSON.parse(payload.req_params.additions)).toMatchObject({
      context_texts: [expect.stringContaining("温柔")],
    });
    expect(payload.req_params.audio_params).toMatchObject({ format: "mp3", sample_rate: 24_000 });
  });

  it("rejects unknown voices before contacting the provider", async () => {
    const fetchMock = vi.fn();
    const provider = new DoubaoSpeechProvider({
      apiKey: "test-doubao-key",
      fetchImpl: fetchMock as typeof fetch,
    });
    await expect(
      provider.synthesize({
        text: "测试",
        voiceId: "unknown-voice" as never,
        tone: "warm",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SPEECH_VOICE", statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream authorization failures without exposing the response body", async () => {
    const provider = new DoubaoSpeechProvider({
      apiKey: "test-doubao-key",
      fetchImpl: vi.fn(async () => new Response("secret upstream detail", { status: 403 })) as typeof fetch,
    });
    await expect(
      provider.synthesize({
        text: "测试",
        voiceId: "zh_female_vv_uranus_bigtts",
        tone: "plain",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SpeechProviderError>>({
        code: "SPEECH_PROVIDER_CONFIGURATION_ERROR",
        statusCode: 503,
      }),
    );
  });

  it("stays disabled without a key and validates the 2.0 resource id", () => {
    expect(createSpeechProviderFromEnv({})).toBeUndefined();
    expect(() =>
      createSpeechProviderFromEnv({
        DOUBAO_TTS_API_KEY: "configured",
        DOUBAO_TTS_RESOURCE_ID: "volc.seedtts.default",
      }),
    ).toThrow("DOUBAO_TTS_RESOURCE_ID 必须是 seed-tts-2.0");
  });
});

describe("Qwen3 TTS provider", () => {
  it("reuses a DashScope key, requests an approved voice, and downloads WAV audio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "request-1",
            output: {
              audio: {
                url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(wavBytes, {
          status: 200,
          headers: { "content-type": "audio/x-wav", "content-length": String(wavBytes.length) },
        }),
      );
    const provider = new QwenSpeechProvider({
      apiKey: "test-qwen-key",
      fetchImpl: fetchMock as typeof fetch,
    });

    const audio = await provider.synthesize({
      text: "妈妈，最近一切都好。",
      voiceId: "Cherry",
      tone: "warm",
    });

    expect(Buffer.from(audio.bytes)).toEqual(wavBytes);
    expect(audio.contentType).toBe("audio/wav");
    const [endpoint, request] = fetchMock.mock.calls[0] as Parameters<typeof fetch>;
    expect(endpoint).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer test-qwen-key");
    const payload = JSON.parse(String(request?.body)) as {
      model: string;
      input: { voice: string; language_type: string };
    };
    expect(payload).toMatchObject({
      model: "qwen3-tts-flash",
      input: { voice: "Cherry", language_type: "Chinese" },
    });
    const [, mediaRequest] = fetchMock.mock.calls[1] as Parameters<typeof fetch>;
    expect(mediaRequest?.redirect).toBe("error");
  });

  it("upgrades a trusted DashScope HTTP media URL and forbids download redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "request-upgrade",
            output: {
              audio: {
                url: "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(wavBytes, { status: 200 }));
    const provider = new QwenSpeechProvider({
      apiKey: "test-qwen-key",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(
      provider.synthesize({ text: "测试", voiceId: "Cherry", tone: "warm" }),
    ).resolves.toMatchObject({ contentType: "audio/wav" });
    const [mediaUrl, mediaRequest] = fetchMock.mock.calls[1] as Parameters<typeof fetch>;
    expect(String(mediaUrl)).toBe(
      "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav",
    );
    expect(mediaRequest?.redirect).toBe("error");
  });

  it("rejects an untrusted media host before downloading audio", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          request_id: "request-untrusted",
          output: { audio: { url: "https://example.test/audio.wav" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new QwenSpeechProvider({
      apiKey: "test-qwen-key",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(
      provider.synthesize({ text: "测试", voiceId: "Cherry", tone: "warm" }),
    ).rejects.toMatchObject({ code: "SPEECH_PROVIDER_INVALID_RESPONSE", statusCode: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selects Qwen automatically for the verified DashScope-compatible deployment", () => {
    const provider = createSpeechProviderFromEnv({
      OPENAI_COMPATIBLE_API_KEY: "configured",
      OPENAI_COMPATIBLE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    expect(provider).toBeInstanceOf(QwenSpeechProvider);
    expect(provider?.voices).toEqual(QWEN_SPEECH_VOICES);
  });
});

describe("Speech API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("lists approved voices and returns AI-generated audio for an owned letter", async () => {
    const synthesize = vi.fn(async () => ({ bytes: mp3Bytes, contentType: "audio/mpeg" as const }));
    const speechProvider: SpeechProvider = {
      name: "test-speech",
      voices: SPEECH_VOICES,
      synthesize,
    };
    app = buildApp({ deploymentMode: "test", speechProvider });
    const token = await login(app);
    const materialId = await registerTextMaterial(app, token);
    const created = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "爸爸", materialIds: [materialId] },
    });
    const letterId = json<{ letter: { id: string } }>(created).letter.id;

    const voices = await app.inject({
      method: "GET",
      url: "/v1/speech/voices",
      headers: auth(token),
    });
    expect(voices.statusCode).toBe(200);
    expect(json<{ available: boolean; voices: unknown[] }>(voices)).toMatchObject({
      available: true,
      voices: SPEECH_VOICES,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/speech`,
      headers: auth(token),
      payload: {
        text: "爸爸：\n今天一切都好。\n想念你的我",
        voiceId: "zh_female_vv_uranus_bigtts",
        tone: "warm",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/mpeg");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-ai-generated"]).toBe("true");
    expect(response.rawPayload).toEqual(mp3Bytes);
    expect(synthesize).toHaveBeenCalledWith({
      text: "爸爸：\n今天一切都好。\n想念你的我",
      voiceId: "zh_female_vv_uranus_bigtts",
      tone: "warm",
    });
  });

  it("persists a generated narration and exposes it only through the shared reader", async () => {
    const synthesize = vi.fn(async () => ({ bytes: wavBytes, contentType: "audio/wav" as const }));
    const speechProvider: SpeechProvider = {
      name: "qwen3-tts-flash",
      voices: QWEN_SPEECH_VOICES,
      synthesize,
    };
    app = buildApp({
      deploymentMode: "test",
      speechProvider,
      objectStorage: new MemoryObjectStorage(),
      publicBaseUrl: "https://api.example.test",
    });
    const token = await login(app);
    const materialId = await registerTextMaterial(app, token);
    const created = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "妈妈", materialIds: [materialId] },
    });
    const letterId = json<{ letter: { id: string } }>(created).letter.id;
    const generation = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: auth(token),
      payload: {},
    });
    await waitForJob(
      app,
      token,
      json<{ job: { id: string } }>(generation).job.id,
    );
    const owned = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}`,
      headers: auth(token),
    });
    const draft = json<{
      letter: { draft: Parameters<typeof letterDraftSpeechText>[0] };
    }>(owned).letter.draft;
    expect(() => GetLetterResponseSchema.parse(json<unknown>(owned))).not.toThrow();
    const narrationText = letterDraftSpeechText(draft);

    const speech = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/speech`,
      headers: auth(token),
      payload: {
        text: narrationText,
        voiceId: "Cherry",
        tone: "warm",
        persist: true,
      },
    });
    expect(speech.statusCode).toBe(200);
    expect(speech.headers["content-type"]).toBe("audio/wav");

    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/confirm`,
      headers: auth(token),
      payload: {},
    });
    expect(() => ConfirmLetterResponseSchema.parse(json<unknown>(confirmed))).not.toThrow();
    const shareToken = json<{ shareToken: string }>(confirmed).shareToken;
    const readerResponse = await app.inject({
      method: "GET",
      url: `/v1/letters/${letterId}/reader?token=${encodeURIComponent(shareToken)}`,
    });
    expect(() => GetLetterReaderResponseSchema.parse(json<unknown>(readerResponse))).not.toThrow();
    const narration = json<{
      reader: {
        narration: { name: string; voiceName: string; mediaUrl: string; mediaToken?: string };
      };
    }>(readerResponse).reader.narration;
    expect(narration).toMatchObject({ name: "AI 朗读全文", voiceName: "芊悦" });
    expect(narration.mediaToken).toBeUndefined();

    const mediaUrl = new URL(narration.mediaUrl);
    const media = await app.inject({ method: "GET", url: `${mediaUrl.pathname}${mediaUrl.search}` });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toBe("audio/wav");
    expect(media.rawPayload).toEqual(wavBytes);
  });

  it("requires authentication and reports an unconfigured provider", async () => {
    app = buildApp({ deploymentMode: "test" });
    const unauthorized = await app.inject({ method: "GET", url: "/v1/speech/voices" });
    expect(unauthorized.statusCode).toBe(401);
    const token = await login(app);
    const materialId = await registerTextMaterial(app, token);
    const created = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "奶奶", materialIds: [materialId] },
    });
    const letterId = json<{ letter: { id: string } }>(created).letter.id;
    const response = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/speech`,
      headers: auth(token),
      payload: { text: "测试", voiceId: SPEECH_VOICES[0].id, tone: "warm" },
    });
    expect(response.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(response).error.code).toBe(
      "SPEECH_PROVIDER_UNAVAILABLE",
    );
  });

  it("rate limits costly speech generation by authenticated user", async () => {
    const synthesize = vi.fn(async () => ({ bytes: mp3Bytes, contentType: "audio/mpeg" as const }));
    app = buildApp({
      deploymentMode: "test",
      speechProvider: { name: "test-speech", voices: SPEECH_VOICES, synthesize },
      speechRateLimits: { perIp: 10, perUser: 1 },
    });
    const token = await login(app, "speech-rate-limit-user");
    const materialId = await registerTextMaterial(app, token);
    const created = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: { recipient: "奶奶", materialIds: [materialId] },
    });
    const letterId = json<{ letter: { id: string } }>(created).letter.id;
    const request = (remoteAddress: string) =>
      app!.inject({
        method: "POST",
        url: `/v1/letters/${letterId}/speech`,
        headers: auth(token),
        remoteAddress,
        payload: { text: "奶奶，最近一切都好。", voiceId: SPEECH_VOICES[0].id, tone: "warm" },
      });

    expect((await request("198.51.100.30")).statusCode).toBe(200);
    const limited = await request("198.51.100.31");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(json<{ error: { code: string } }>(limited).error.code).toBe("RATE_LIMITED");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});

describe("Public creator controls", () => {
  it("offers copy style, optional revision notes, and natural voice selection", async () => {
    const html = await readFile(
      new URL("../../../docs/product-demo/create.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain('id="tone"');
    expect(html).toContain('id="revisionNotes"');
    expect(html).toContain('id="voice"');
    expect(html).toContain('id="generateSpeech"');
    expect(html).toContain("/v1/speech/voices");
    expect(html).toContain("/speech`");
    expect(html).toContain("语音由当前暖笺 API 配置的语音合成模型生成");
    expect(html).toContain("'audio/wav'");
  });
});
