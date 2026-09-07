import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  DoubaoSpeechProvider,
  SPEECH_VOICES,
  SpeechProviderError,
  createSpeechProviderFromEnv,
  type SpeechProvider,
} from "../src/speech.js";
import { auth, json, login, registerTextMaterial } from "./helpers.js";

const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0xff, 0xfb]);

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
    expect(html).toContain("语音由豆包语音合成大模型生成");
  });
});
