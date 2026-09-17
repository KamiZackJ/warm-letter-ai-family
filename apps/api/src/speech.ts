const doubaoSpeechEndpoint = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const qwenSpeechEndpoint =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const defaultTimeoutMs = 120_000;
const maximumAudioBytes = 10 * 1024 * 1024;
const maximumQwenResponseBytes = Math.ceil((maximumAudioBytes * 4) / 3) + 64 * 1024;

export interface SpeechVoice {
  id: string;
  name: string;
  description: string;
  gender: "female" | "male";
}

export const DOUBAO_SPEECH_VOICES = [
  {
    id: "zh_female_vv_uranus_bigtts",
    name: "Vivi 2.0",
    description: "柔和自然",
    gender: "female",
  },
  {
    id: "zh_female_xiaohe_uranus_bigtts",
    name: "小何 2.0",
    description: "亲切明亮",
    gender: "female",
  },
  {
    id: "zh_male_m191_uranus_bigtts",
    name: "云舟 2.0",
    description: "沉稳温和",
    gender: "male",
  },
] as const satisfies readonly SpeechVoice[];

export const QWEN_SPEECH_VOICES = [
  {
    id: "Cherry",
    name: "芊悦",
    description: "温柔清晰",
    gender: "female",
  },
  {
    id: "Serena",
    name: "苏瑶",
    description: "舒缓自然",
    gender: "female",
  },
  {
    id: "Ethan",
    name: "晨煦",
    description: "温暖有朝气",
    gender: "male",
  },
] as const satisfies readonly SpeechVoice[];

// Kept as the legacy default for callers that construct a custom provider.
export const SPEECH_VOICES = DOUBAO_SPEECH_VOICES;

export type SpeechVoiceId = string;
export type SpeechTone = "warm" | "plain" | "lively";

export interface SpeechSynthesisInput {
  text: string;
  voiceId: SpeechVoiceId;
  tone: SpeechTone;
}

export interface SpeechAudio {
  bytes: Uint8Array;
  contentType: "audio/mpeg" | "audio/wav";
}

export interface SpeechProvider {
  readonly name: string;
  readonly voices: readonly SpeechVoice[];
  synthesize(input: SpeechSynthesisInput): Promise<SpeechAudio>;
}

export class SpeechProviderError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SpeechProviderError";
  }
}

interface DoubaoSpeechProviderOptions {
  apiKey: string;
  resourceId?: "seed-tts-2.0";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface DoubaoStreamItem {
  code?: number;
  message?: string;
  data?: string | null;
}

interface QwenSpeechProviderOptions {
  apiKey: string;
  model?: "qwen3-tts-flash";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface QwenSpeechResponse {
  request_id?: string;
  code?: string;
  message?: string;
  output?: {
    audio?: {
      data?: string;
      url?: string;
      expires_at?: number;
    };
  };
}

const toneInstructions: Record<SpeechTone, string> = {
  warm: "请用温柔、自然、像给家人读信一样的语气，语速稍慢，停顿舒缓。",
  plain: "请用平静、克制、真诚的语气朗读，语速稍慢，不要夸张表演。",
  lively: "请用亲切、轻松、自然的语气朗读，节奏舒展，不要播音腔。",
};

function isSpeechVoiceId(value: string): value is SpeechVoiceId {
  return DOUBAO_SPEECH_VOICES.some((voice) => voice.id === value);
}

function isMp3(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  );
}

function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function mapHttpError(status: number): SpeechProviderError {
  if (status === 401 || status === 403) {
    return new SpeechProviderError(
      503,
      "SPEECH_PROVIDER_CONFIGURATION_ERROR",
      "语音服务配置不可用",
      false,
    );
  }
  if (status === 429) {
    return new SpeechProviderError(429, "SPEECH_PROVIDER_RATE_LIMITED", "语音服务繁忙，请稍后重试", true);
  }
  return new SpeechProviderError(
    502,
    "SPEECH_PROVIDER_UNAVAILABLE",
    "语音服务暂时不可用，请稍后重试",
    status >= 500,
  );
}

export class DoubaoSpeechProvider implements SpeechProvider {
  readonly name = "doubao-seed-tts-2.0";
  readonly voices = DOUBAO_SPEECH_VOICES;
  private readonly apiKey: string;
  private readonly resourceId: "seed-tts-2.0";
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DoubaoSpeechProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Doubao TTS apiKey 不能为空");
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new Error("Doubao TTS timeoutMs 必须是 1000 到 300000 之间的整数");
    }
    this.apiKey = options.apiKey.trim();
    this.resourceId = options.resourceId ?? "seed-tts-2.0";
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(input: SpeechSynthesisInput): Promise<SpeechAudio> {
    const text = input.text.normalize("NFC").trim();
    if (!text || text.length > 4_000) {
      throw new SpeechProviderError(
        400,
        "INVALID_SPEECH_TEXT",
        "朗读文字必须为 1 到 4000 个字符",
        false,
      );
    }
    if (!isSpeechVoiceId(input.voiceId)) {
      throw new SpeechProviderError(400, "INVALID_SPEECH_VOICE", "不支持的朗读音色", false);
    }
    if (!Object.hasOwn(toneInstructions, input.tone)) {
      throw new SpeechProviderError(400, "INVALID_SPEECH_TONE", "不支持的朗读语气", false);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(doubaoSpeechEndpoint, {
        method: "POST",
        headers: {
          "X-Api-Key": this.apiKey,
          "X-Api-Resource-Id": this.resourceId,
          "X-Control-Require-Usage-Tokens-Return": "*",
          "Content-Type": "application/json",
          Connection: "keep-alive",
        },
        body: JSON.stringify({
          req_params: {
            text,
            speaker: input.voiceId,
            additions: JSON.stringify({
              disable_markdown_filter: false,
              disable_emoji_filter: false,
              enable_latex_tn: true,
              context_texts: [toneInstructions[input.tone]],
            }),
            audio_params: {
              format: "mp3",
              sample_rate: 24_000,
              enable_subtitle: true,
            },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_UNAVAILABLE",
        "语音服务暂时不可用，请稍后重试",
        true,
        error,
      );
    }
    if (!response.ok) throw mapHttpError(response.status);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let completed = false;
    const responseText = await response.text();
    for (const line of responseText.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let item: DoubaoStreamItem;
      try {
        item = JSON.parse(line) as DoubaoStreamItem;
      } catch (error) {
        throw new SpeechProviderError(
          502,
          "SPEECH_PROVIDER_INVALID_RESPONSE",
          "语音服务返回了无效响应",
          true,
          error,
        );
      }
      if (item.code === 0 && item.data) {
        const chunk = Buffer.from(item.data, "base64");
        totalBytes += chunk.length;
        if (totalBytes > maximumAudioBytes) {
          throw new SpeechProviderError(
            502,
            "SPEECH_PROVIDER_RESPONSE_TOO_LARGE",
            "语音文件过大，请缩短家书后重试",
            false,
          );
        }
        chunks.push(chunk);
      } else if (item.code === 20_000_000) {
        completed = true;
      } else if (typeof item.code === "number" && item.code > 0) {
        throw new SpeechProviderError(
          item.code === 45_000_030 ? 503 : 502,
          item.code === 45_000_030
            ? "SPEECH_PROVIDER_CONFIGURATION_ERROR"
            : "SPEECH_PROVIDER_REJECTED",
          item.code === 45_000_030 ? "语音服务配置不可用" : "语音服务拒绝了本次朗读请求",
          false,
        );
      }
    }
    const bytes = Buffer.concat(chunks);
    if (!completed || !isMp3(bytes)) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_INVALID_RESPONSE",
        "语音服务未返回完整 MP3",
        true,
      );
    }
    return { bytes, contentType: "audio/mpeg" };
  }
}

async function readLimitedResponse(
  response: Response,
  maximumBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new SpeechProviderError(
      502,
      "SPEECH_PROVIDER_RESPONSE_TOO_LARGE",
      tooLargeMessage,
      false,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_RESPONSE_TOO_LARGE",
        tooLargeMessage,
        false,
      );
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_RESPONSE_TOO_LARGE",
        tooLargeMessage,
        false,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class QwenSpeechProvider implements SpeechProvider {
  readonly name = "qwen3-tts-flash";
  readonly voices = QWEN_SPEECH_VOICES;
  private readonly apiKey: string;
  private readonly model: "qwen3-tts-flash";
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QwenSpeechProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Qwen TTS apiKey 不能为空");
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new Error("QWEN_TTS_TIMEOUT_MS 必须是 1000 到 300000 之间的整数");
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model ?? "qwen3-tts-flash";
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(input: SpeechSynthesisInput): Promise<SpeechAudio> {
    const text = input.text.normalize("NFC").trim();
    if (!text || text.length > 4_000) {
      throw new SpeechProviderError(
        400,
        "INVALID_SPEECH_TEXT",
        "朗读文字必须为 1 到 4000 个字符",
        false,
      );
    }
    if (!this.voices.some((voice) => voice.id === input.voiceId)) {
      throw new SpeechProviderError(400, "INVALID_SPEECH_VOICE", "不支持的朗读音色", false);
    }
    if (!Object.hasOwn(toneInstructions, input.tone)) {
      throw new SpeechProviderError(400, "INVALID_SPEECH_TONE", "不支持的朗读语气", false);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(qwenSpeechEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            text,
            voice: input.voiceId,
            language_type: "Chinese",
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_UNAVAILABLE",
        "语音服务暂时不可用，请稍后重试",
        true,
        error,
      );
    }
    if (!response.ok) throw mapHttpError(response.status);

    let payload: QwenSpeechResponse;
    try {
      const payloadBytes = await readLimitedResponse(
        response,
        maximumQwenResponseBytes,
        "语音服务响应过大，请缩短家书后重试",
      );
      payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as QwenSpeechResponse;
    } catch (error) {
      if (error instanceof SpeechProviderError) throw error;
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_INVALID_RESPONSE",
        "语音服务返回了无效响应",
        true,
        error,
      );
    }
    if (payload.code) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_REJECTED",
        "语音服务拒绝了本次朗读请求",
        false,
      );
    }

    const encodedAudio = payload.output?.audio?.data;
    if (encodedAudio) {
      const bytes = Buffer.from(encodedAudio, "base64");
      if (bytes.length > maximumAudioBytes) {
        throw new SpeechProviderError(
          502,
          "SPEECH_PROVIDER_RESPONSE_TOO_LARGE",
          "语音文件过大，请缩短家书后重试",
          false,
        );
      }
      if (!isWav(bytes)) {
        throw new SpeechProviderError(
          502,
          "SPEECH_PROVIDER_INVALID_RESPONSE",
          "语音服务未返回完整 WAV",
          true,
        );
      }
      return { bytes, contentType: "audio/wav" };
    }

    const audioUrl = payload.output?.audio?.url;
    if (!audioUrl) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_INVALID_RESPONSE",
        "语音服务没有返回音频",
        true,
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(audioUrl);
    } catch (error) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_INVALID_RESPONSE",
        "语音服务返回了无效音频地址",
        true,
        error,
      );
    }
    if (
      parsedUrl.protocol !== "https:" ||
      (parsedUrl.hostname !== "aliyuncs.com" && !parsedUrl.hostname.endsWith(".aliyuncs.com")) ||
      Boolean(parsedUrl.username || parsedUrl.password) ||
      Boolean(parsedUrl.port && parsedUrl.port !== "443")
    ) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_INVALID_RESPONSE",
        "语音服务返回了不受信任的音频地址",
        false,
      );
    }

    let mediaResponse: Response;
    try {
      mediaResponse = await this.fetchImpl(parsedUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_UNAVAILABLE",
        "语音文件下载失败，请稍后重试",
        true,
        error,
      );
    }
    if (!mediaResponse.ok) throw mapHttpError(mediaResponse.status);
    const bytes = await readLimitedResponse(
      mediaResponse,
      maximumAudioBytes,
      "语音文件过大，请缩短家书后重试",
    );
    if (!isWav(bytes)) {
      throw new SpeechProviderError(
        502,
        "SPEECH_PROVIDER_INVALID_RESPONSE",
        "语音服务未返回完整 WAV",
        true,
      );
    }
    return { bytes, contentType: "audio/wav" };
  }
}

export function createSpeechProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SpeechProvider | undefined {
  const explicitQwenKey = env.QWEN_TTS_API_KEY?.trim();
  if (explicitQwenKey) {
    const model = env.QWEN_TTS_MODEL?.trim() || "qwen3-tts-flash";
    if (model !== "qwen3-tts-flash") {
      throw new Error("QWEN_TTS_MODEL 必须是 qwen3-tts-flash");
    }
    const rawTimeout = env.QWEN_TTS_TIMEOUT_MS?.trim();
    const timeoutMs = rawTimeout ? Number(rawTimeout) : defaultTimeoutMs;
    return new QwenSpeechProvider({ apiKey: explicitQwenKey, model, timeoutMs });
  }

  const doubaoKey = env.DOUBAO_TTS_API_KEY?.trim();
  if (doubaoKey) {
    const resourceId = env.DOUBAO_TTS_RESOURCE_ID?.trim() || "seed-tts-2.0";
    if (resourceId !== "seed-tts-2.0") {
      throw new Error("DOUBAO_TTS_RESOURCE_ID 必须是 seed-tts-2.0");
    }
    const rawTimeout = env.DOUBAO_TTS_TIMEOUT_MS?.trim();
    const timeoutMs = rawTimeout ? Number(rawTimeout) : defaultTimeoutMs;
    return new DoubaoSpeechProvider({ apiKey: doubaoKey, resourceId, timeoutMs });
  }

  const compatibleKey = env.OPENAI_COMPATIBLE_API_KEY?.trim();
  const compatibleBaseUrl = env.OPENAI_COMPATIBLE_BASE_URL?.trim();
  if (compatibleKey && compatibleBaseUrl) {
    let hostname = "";
    try {
      hostname = new URL(compatibleBaseUrl).hostname;
    } catch {
      return undefined;
    }
    if (hostname === "dashscope.aliyuncs.com") {
      return new QwenSpeechProvider({ apiKey: compatibleKey });
    }
  }
  return undefined;
}
