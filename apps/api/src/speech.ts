const doubaoSpeechEndpoint = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const defaultTimeoutMs = 120_000;
const maximumAudioBytes = 10 * 1024 * 1024;

export const SPEECH_VOICES = [
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
] as const;

export type SpeechVoiceId = (typeof SPEECH_VOICES)[number]["id"];
export type SpeechTone = "warm" | "plain" | "lively";

export interface SpeechSynthesisInput {
  text: string;
  voiceId: SpeechVoiceId;
  tone: SpeechTone;
}

export interface SpeechAudio {
  bytes: Uint8Array;
  contentType: "audio/mpeg";
}

export interface SpeechProvider {
  readonly name: string;
  readonly voices: typeof SPEECH_VOICES;
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

const toneInstructions: Record<SpeechTone, string> = {
  warm: "请用温柔、自然、像给家人读信一样的语气，语速稍慢，停顿舒缓。",
  plain: "请用平静、克制、真诚的语气朗读，语速稍慢，不要夸张表演。",
  lively: "请用亲切、轻松、自然的语气朗读，节奏舒展，不要播音腔。",
};

function isSpeechVoiceId(value: string): value is SpeechVoiceId {
  return SPEECH_VOICES.some((voice) => voice.id === value);
}

function isMp3(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
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
  readonly voices = SPEECH_VOICES;
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

export function createSpeechProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SpeechProvider | undefined {
  const apiKey = env.DOUBAO_TTS_API_KEY?.trim();
  if (!apiKey) return undefined;
  const resourceId = env.DOUBAO_TTS_RESOURCE_ID?.trim() || "seed-tts-2.0";
  if (resourceId !== "seed-tts-2.0") {
    throw new Error("DOUBAO_TTS_RESOURCE_ID 必须是 seed-tts-2.0");
  }
  const rawTimeout = env.DOUBAO_TTS_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : defaultTimeoutMs;
  return new DoubaoSpeechProvider({ apiKey, resourceId, timeoutMs });
}
