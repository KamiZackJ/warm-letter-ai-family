import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIProviderError,
  OpenAICompatibleChatProvider,
  createAIProviderFromEnv,
  type GenerateLetterInput,
  type MaterialAssetReader,
} from "../src/ai.js";
import { buildApp } from "../src/app.js";
import { json } from "./helpers.js";

const textId = "11111111-1111-4111-8111-111111111111";
const imageId = "22222222-2222-4222-8222-222222222222";
const audioId = "33333333-3333-4333-8333-333333333333";

function inputWith(materials: GenerateLetterInput["materials"]): GenerateLetterInput {
  return {
    recipient: "妈妈",
    settings: {
      tone: "warm",
      length: "medium",
      focus: "说说今天的近况",
      excludedTopics: [],
    },
    materials,
    version: 1,
  };
}

function textMaterial(): GenerateLetterInput["materials"][number] {
  return {
    id: textId,
    userId: "user-1",
    type: "text",
    name: "今日近况",
    textContent: "今天把小程序演示给队友看了。",
    status: "READY",
    createdAt: "2026-09-15T10:00:00.000Z",
  };
}

function imageMaterial(): GenerateLetterInput["materials"][number] {
  return {
    id: imageId,
    userId: "user-1",
    type: "photo",
    name: "货架.jpg",
    objectKey: "user-1/shelf.jpg",
    contentType: "image/jpeg",
    status: "READY",
    createdAt: "2026-09-15T10:01:00.000Z",
  };
}

function audioMaterial(contentType = "audio/mpeg", name = "近况.mp3"):
  GenerateLetterInput["materials"][number] {
  return {
    id: audioId,
    userId: "user-1",
    type: "audio",
    name,
    objectKey: `user-1/${name}`,
    contentType,
    status: "READY",
    createdAt: "2026-09-15T10:02:00.000Z",
  };
}

function validOutput(sourceIds: string[]): string {
  return JSON.stringify({
    title: "今天的近况",
    greeting: "妈妈：",
    paragraphs: [{ text: "今天有一件想告诉你的事。", sourceRefs: sourceIds }],
    closing: "等有空再慢慢聊。",
  });
}

function compatibleClient(sourceIds: string[]): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          model: "resolved-proxy-model",
          choices: [{ message: { content: validOutput(sourceIds) } }],
        }),
      },
    },
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text: "开会有点累，外卖送的饮品让我很开心。" }),
      },
    },
  } as unknown as OpenAI;
}

function assetReader(contentType: string): MaterialAssetReader {
  return {
    read: vi.fn().mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType,
    }),
  };
}

function streamingChunks(
  chunks: Array<
    | string
    | null
    | undefined
    | { content?: string | null; finishReason?: "stop" | "length" }
  >,
  failure?: Error,
  includeNormalStop = true,
): AsyncIterable<{
  choices: Array<{
    delta: { content?: string | null };
    finish_reason?: "stop" | "length";
  }>;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        const content = typeof chunk === "object" && chunk !== null ? chunk.content : chunk;
        const finishReason =
          typeof chunk === "object" && chunk !== null ? chunk.finishReason : undefined;
        yield { choices: [{ delta: { content }, finish_reason: finishReason }] };
      }
      if (failure) throw failure;
      if (includeNormalStop && !chunks.some(
        (chunk) => typeof chunk === "object" && chunk !== null && chunk.finishReason,
      )) {
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      }
    },
  };
}

function qwenProvider(
  client: OpenAI,
  reader: MaterialAssetReader,
  overrides: Partial<ConstructorParameters<typeof OpenAICompatibleChatProvider>[0]> = {},
): OpenAICompatibleChatProvider {
  return new OpenAICompatibleChatProvider({
    apiKey: "test-key",
    model: "qwen3.8-flash",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    imageMode: "native",
    audioMode: "streaming-chat-transcription",
    transcriptionModel: "qwen3.5-omni-flash",
    jsonMode: "json-object",
    imageDetail: "omit",
    storeMode: "omit",
    verificationProfile: "dashscope-qwen-2026-09-16",
    assetReader: reader,
    client,
    ...overrides,
  });
}

describe("OpenAICompatibleChatProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Chat Completions without mislabeling the provider as OpenAI, DeepSeek, or Gemini", async () => {
    const client = compatibleClient([textId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      client,
    });

    const draft = await provider.generateLetter(inputWith([textMaterial()]));

    expect(provider.providerMode).toBe("openai-compatible");
    expect(provider.inputCapabilities).toEqual({
      text: "native",
      image: "unsupported",
      audio: "unsupported",
    });
    expect(draft.provider).toBe("openai-compatible-chat:resolved-proxy-model");
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(client.chat.completions.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: "proxy-model",
        store: false,
        response_format: { type: "json_object" },
        max_tokens: 1_050,
      }),
    );
    for (const [request] of vi.mocked(client.chat.completions.create).mock.calls) {
      expect(request).not.toHaveProperty("enable_thinking");
    }
  });

  it("disables Qwen default thinking only for the verified profile and preserves factual review", async () => {
    for (const verificationProfile of ["dashscope-qwen-2026-09-16", "unverified"] as const) {
      const client = compatibleClient([textId]);
      const provider = qwenProvider(client, assetReader("image/jpeg"), { verificationProfile });

      await provider.generateLetter(inputWith([textMaterial()]));

      const requests = vi.mocked(client.chat.completions.create).mock.calls;
      expect(requests).toHaveLength(2);
      for (const [request] of requests) {
        if (verificationProfile === "dashscope-qwen-2026-09-16") {
          expect(request).toHaveProperty("enable_thinking", false);
        } else {
          expect(request).not.toHaveProperty("enable_thinking");
        }
        expect(request).not.toHaveProperty("extra_body");
      }
      expect(JSON.stringify(requests[1]?.[0].messages)).toContain("严格事实审校员");
    }
  });

  it.each([
    { stage: "draft", finishReason: "length", code: "AI_OUTPUT_TRUNCATED", retryable: true },
    { stage: "review", finishReason: "length", code: "AI_OUTPUT_TRUNCATED", retryable: true },
    { stage: "draft", finishReason: "content_filter", code: "AI_OUTPUT_FILTERED", retryable: false },
    { stage: "review", finishReason: "content_filter", code: "AI_OUTPUT_FILTERED", retryable: false },
    { stage: "draft", finishReason: "tool_calls", code: "AI_OUTPUT_INVALID", retryable: false },
    { stage: "review", finishReason: null, code: "AI_OUTPUT_INVALID", retryable: false },
  ] as const)("rejects parseable JSON when $stage ends with $finishReason", async ({ stage, finishReason, code, retryable }) => {
    const client = compatibleClient([textId]);
    const create = vi.mocked(client.chat.completions.create);
    if (stage === "review") {
      create.mockResolvedValueOnce({
        model: "resolved-proxy-model",
        choices: [{ finish_reason: "stop", message: { content: validOutput([textId]) } }],
      } as never);
    }
    create.mockResolvedValueOnce({
      model: "resolved-proxy-model",
      choices: [{ finish_reason: finishReason, message: { content: validOutput([textId]) } }],
    } as never);
    const provider = qwenProvider(client, assetReader("image/jpeg"));

    await expect(provider.generateLetter(inputWith([textMaterial()]))).rejects.toMatchObject({
      code,
      retryable,
    } satisfies Partial<AIProviderError>);
    expect(create).toHaveBeenCalledTimes(stage === "draft" ? 1 : 2);
  });

  it("accepts normally completed draft and review responses", async () => {
    const client = compatibleClient([textId]);
    vi.mocked(client.chat.completions.create).mockResolvedValue({
      model: "resolved-proxy-model",
      choices: [{ finish_reason: "stop", message: { content: validOutput([textId]) } }],
    } as never);
    const provider = qwenProvider(client, assetReader("image/jpeg"));

    const draft = await provider.generateLetter(inputWith([textMaterial()]));

    expect(draft.paragraphs[0]?.sourceRefs).toEqual([textId]);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it.each(["", " \n\t ", "{}", " { \n } "])(
    "recovers one normally completed empty draft (%j) without repeating ASR or material preparation",
    async (emptyContent) => {
      const client = compatibleClient([audioId]);
      const create = vi.mocked(client.chat.completions.create);
      create.mockResolvedValueOnce(streamingChunks(["今天开了个会。"]) as never);
      create.mockResolvedValueOnce({
        choices: [{ finish_reason: "stop", message: { content: emptyContent } }],
      } as never);
      const reader = assetReader("audio/mp4");
      const provider = qwenProvider(client, reader);
      const onTranscript = vi.fn();

      const draft = await provider.generateLetter({
        ...inputWith([audioMaterial("audio/mp4", "近况.m4a")]),
        onTranscript,
      });

      expect(draft.paragraphs[0]?.sourceRefs).toEqual([audioId]);
      expect(create).toHaveBeenCalledTimes(4); // ASR, draft, one recovery, review.
      expect(reader.read).toHaveBeenCalledTimes(1);
      expect(onTranscript).toHaveBeenCalledTimes(1);
      const draftRequest = create.mock.calls[1]![0];
      const [recovery, options] = create.mock.calls[2]!;
      expect(recovery).toMatchObject({ ...draftRequest, temperature: 0, messages: expect.any(Array) });
      expect(recovery.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(recovery.messages.slice(1)).toEqual(draftRequest.messages.slice(1));
      expect(recovery.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("四个字段") });
      expect(recovery.messages[0]?.content).toContain(draftRequest.messages[0]?.content);
      expect(options).toMatchObject({ maxRetries: 0, timeout: 30_000 });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(create.mock.calls[3]![0].messages)).toContain("严格事实审校员");
    },
  );

  it.each(["", "{}"])("allows at most one empty-draft recovery when the recovery is also %j", async (emptyContent) => {
    const client = compatibleClient([textId]);
    const create = vi.mocked(client.chat.completions.create);
    create.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: emptyContent } }],
    } as never);
    const provider = qwenProvider(client, assetReader("image/jpeg"));

    await expect(provider.generateLetter(inputWith([textMaterial()]))).rejects.toMatchObject({ code: "AI_OUTPUT_INVALID" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    { content: "{broken", finishReason: "stop", code: "AI_OUTPUT_INVALID" },
    { content: '{"title":"only a title"}', finishReason: "stop", code: "AI_OUTPUT_INVALID" },
    { content: "[]", finishReason: "stop", code: "AI_OUTPUT_INVALID" },
    { content: "null", finishReason: "stop", code: "AI_OUTPUT_INVALID" },
    { content: null, finishReason: "stop", code: "AI_OUTPUT_INVALID" },
    { content: "", finishReason: "length", code: "AI_OUTPUT_TRUNCATED" },
    { content: "{}", finishReason: "content_filter", code: "AI_OUTPUT_FILTERED" },
    { content: "", finishReason: null, code: "AI_OUTPUT_INVALID" },
    { content: "{}", finishReason: undefined, code: "AI_OUTPUT_INVALID" },
    { content: "{}", finishReason: "tool_calls", code: "AI_OUTPUT_INVALID" },
  ])("does not recover nonempty/invalid or interrupted drafts ($content, $finishReason)", async ({ content, finishReason, code }) => {
    const client = compatibleClient([textId]);
    const create = vi.mocked(client.chat.completions.create);
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: finishReason, message: { content } }],
    } as never);
    const provider = qwenProvider(client, assetReader("image/jpeg"));

    await expect(provider.generateLetter(inputWith([textMaterial()]))).rejects.toMatchObject({ code });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not recover an empty review response", async () => {
    const client = compatibleClient([textId]);
    const create = vi.mocked(client.chat.completions.create);
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: "stop", message: { content: validOutput([textId]) } }],
    } as never).mockResolvedValueOnce({
      choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    } as never);
    const provider = qwenProvider(client, assetReader("image/jpeg"));

    await expect(provider.generateLetter(inputWith([textMaterial()]))).rejects.toMatchObject({ code: "AI_OUTPUT_INVALID" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("still rejects invalid source references after normal review without an empty recovery", async () => {
    const client = compatibleClient(["not-a-selected-material"]);
    const provider = qwenProvider(client, assetReader("image/jpeg"));

    await expect(provider.generateLetter(inputWith([textMaterial()]))).rejects.toMatchObject({ code: "AI_OUTPUT_INVALID" });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    for (const [, options] of vi.mocked(client.chat.completions.create).mock.calls) {
      expect(options).toBeUndefined();
    }
  });

  it("keeps short-letter completions bounded on both the draft and review calls", async () => {
    const client = compatibleClient([textId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      client,
    });

    const input = inputWith([textMaterial()]);
    await provider.generateLetter({
      ...input,
      settings: { ...input.settings, length: "short" },
    });

    for (const [request] of vi.mocked(client.chat.completions.create).mock.calls) {
      expect(request).toHaveProperty("max_tokens", 720);
    }
  });

  it("guards against unsupported duration, intensity, quantity, and edge-person expansions", async () => {
    const client = compatibleClient([textId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      client,
    });

    await provider.generateLetter(inputWith([textMaterial()]));

    const calls = vi.mocked(client.chat.completions.create).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [request] of calls) {
      const systemPrompt = JSON.stringify(request.messages[0]?.content);
      expect(systemPrompt).toContain("原话和可见事实清单");
      expect(systemPrompt).toContain("程度、数量或时长");
      expect(systemPrompt).toContain("数字、量词、程度词");
      expect(systemPrompt).toContain("画面边缘人物");
    }
  });

  it("sends image bytes only when native image input is explicitly enabled", async () => {
    const client = compatibleClient([imageId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      imageMode: "native",
      imageDetail: "high",
      assetReader: assetReader("image/jpeg"),
      client,
    });

    await provider.generateLetter(inputWith([imageMaterial()]));

    const request = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0];
    expect(request?.messages[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,AQID", detail: "high" },
        }),
      ]),
    );
    expect(provider.inputCapabilities.image).toBe("native");
  });

  it("rejects image material before reading bytes when image capability is disabled", async () => {
    const client = compatibleClient([imageId]);
    const reader = assetReader("image/jpeg");
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      assetReader: reader,
      client,
    });

    await expect(provider.generateLetter(inputWith([imageMaterial()]))).rejects.toMatchObject({
      code: "AI_MATERIAL_UNSUPPORTED",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(reader.read).not.toHaveBeenCalled();
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("supports explicit native MP3 audio input but fails closed for M4A", async () => {
    const client = compatibleClient([audioId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "native",
      assetReader: assetReader("audio/mpeg"),
      client,
    });

    await provider.generateLetter(inputWith([audioMaterial()]));
    const request = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0];
    expect(request?.messages[1]?.content).toEqual(
      expect.arrayContaining([
        {
          type: "input_audio",
          input_audio: { data: "AQID", format: "mp3" },
        },
      ]),
    );

    const m4aClient = compatibleClient([audioId]);
    const m4aProvider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "native",
      assetReader: assetReader("audio/mp4"),
      client: m4aClient,
    });
    await expect(
      m4aProvider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_AUDIO_FORMAT_UNSUPPORTED",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(m4aClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it("can transcribe M4A through an explicitly configured compatible transcription endpoint", async () => {
    const client = compatibleClient([audioId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "transcription",
      transcriptionModel: "proxy-transcription-model",
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")]));

    expect(client.audio.transcriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "proxy-transcription-model",
        response_format: "json",
      }),
    );
    const request = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0];
    expect(JSON.stringify(request?.messages[1]?.content)).toContain("外卖送的饮品");
    expect(provider.inputCapabilities.audio).toBe("transcription");
  });

  it("applies the transcript character limit to the non-streaming transcription mode", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.audio.transcriptions.create).mockResolvedValueOnce({
      text: "一二三四五六",
    } as never);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "transcription",
      transcriptionModel: "proxy-transcription-model",
      maxTranscriptCharacters: 5,
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await expect(
      provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_TRANSCRIPTION_TOO_LONG",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("combines multiple streaming chat transcription chunks before letter generation", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks(["开会有点", undefined, "累，", "但项目顺利。"]) as never,
    );
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      assetReader: assetReader("audio/mp4"),
      client,
    });

    const onTranscript = vi.fn();
    const input = {
      ...inputWith([audioMaterial("audio/mp4", "近况.m4a")]),
      audioTranscripts: [{ materialId: audioId, text: "未经确认的文字不能覆盖识别结果", confirmed: false }],
      onTranscript,
    };
    await provider.generateLetter(input);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    const firstGenerationRequest = vi.mocked(client.chat.completions.create).mock.calls[1]?.[0];
    expect(JSON.stringify(firstGenerationRequest?.messages[1]?.content)).toContain(
      "开会有点累，但项目顺利。",
    );
    expect(onTranscript).toHaveBeenCalledWith({
      materialId: audioId, text: "开会有点累，但项目顺利。", confirmed: false,
    });
    await provider.generateLetter({
      ...input,
      audioTranscripts: [{ materialId: audioId, text: "今天开了个会。", confirmed: true }],
    });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(5);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const regenerated = vi.mocked(client.chat.completions.create).mock.calls[3]?.[0];
    expect(JSON.stringify(regenerated?.messages[1]?.content)).toContain("今天开了个会。");
    expect(JSON.stringify(regenerated?.messages[1]?.content)).not.toContain("开会有点累");
  });

  it("fails closed when streaming chat transcription returns no text", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks([undefined, null, "   "]) as never,
    );
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await expect(
      provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_TRANSCRIPTION_EMPTY",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("stops an overlong streaming transcript before letter generation", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks(["一二三", "四五六"]) as never,
    );
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      maxTranscriptCharacters: 5,
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await expect(
      provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_TRANSCRIPTION_TOO_LONG",
      message: "语音转写内容超过处理上限，请缩短录音后重试",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("maps a mid-stream transcription failure without starting letter generation", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks(["已收到一段"], new Error("secret upstream stream failure")) as never,
    );
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await expect(
      provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_FAILED",
      message: "AI 服务暂时不可用，请稍后重试",
      retryable: true,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-empty streaming transcript when the model stops at its length limit", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks([{ content: "只有半段", finishReason: "length" }]) as never,
    );
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await expect(
      provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_TRANSCRIPTION_TRUNCATED",
      message: "语音转写未完整结束，请缩短录音后重试",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a streaming transcript when the response ends without a normal stop marker", async () => {
    const client = compatibleClient([audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks(["看似完整但没有终止标记"], undefined, false) as never,
    );
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      assetReader: assetReader("audio/mp4"),
      client,
    });

    await expect(
      provider.generateLetter(inputWith([audioMaterial("audio/mp4", "近况.m4a")])),
    ).rejects.toMatchObject({
      code: "AI_TRANSCRIPTION_INCOMPLETE",
      message: "语音转写响应未完整结束，请重试",
      retryable: true,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("uses the exact probed Qwen profile while omitting raw audio, store, and image detail from letter requests", async () => {
    const client = compatibleClient([imageId, audioId]);
    vi.mocked(client.chat.completions.create).mockResolvedValueOnce(
      streamingChunks(["语音里的今日近况。"]) as never,
    );
    const reader: MaterialAssetReader = {
      read: vi.fn(async (objectKey: string) => ({
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: objectKey.endsWith(".jpg") ? "image/jpeg" : "audio/mp4",
      })),
    };
    const provider = qwenProvider(client, reader);

    const draft = await provider.generateLetter(
      inputWith([imageMaterial(), audioMaterial("audio/mp4", "近况.m4a")]),
    );

    expect(provider.inputCapabilityVerification).toBe("profile-match");
    expect(draft.provider).toBe(
      "openai-compatible-chat:resolved-proxy-model+audio:qwen3.5-omni-flash",
    );
    const transcriptionRequest = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0];
    expect(transcriptionRequest).toMatchObject({
      model: "qwen3.5-omni-flash",
      stream: true,
      modalities: ["text"],
    });
    expect(transcriptionRequest).not.toHaveProperty("enable_thinking");
    expect(JSON.stringify(transcriptionRequest)).toContain("data:;base64,AQID");

    for (const [request] of vi.mocked(client.chat.completions.create).mock.calls.slice(1)) {
      expect(request).not.toHaveProperty("store");
      expect(JSON.stringify(request)).not.toContain("input_audio");
      expect(JSON.stringify(request)).not.toContain("data:;base64,AQID");
      const imagePart = (
        request.messages[1]?.content as unknown as Array<Record<string, unknown>>
      ).find((part) => part.type === "image_url");
      expect(imagePart).toEqual({
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,AQID" },
      });
      expect(JSON.stringify(request.messages[1]?.content)).toContain("语音里的今日近况");
    }
  });

  it("rejects an excessive combined media payload before any upstream request", async () => {
    const client = compatibleClient([imageId, audioId]);
    const reader: MaterialAssetReader = {
      read: vi.fn(async (objectKey: string) => ({
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: objectKey.endsWith(".jpg") ? "image/jpeg" : "audio/mp4",
      })),
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      imageMode: "native",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "proxy-omni-model",
      maxTotalMediaBytes: 5,
      assetReader: reader,
      client,
    });

    await expect(
      provider.generateLetter(
        inputWith([imageMaterial(), audioMaterial("audio/mp4", "近况.m4a")]),
      ),
    ).rejects.toMatchObject({
      code: "AI_MATERIAL_LIMIT_EXCEEDED",
      message: "所选图片和语音总大小超过 AI 处理上限，请减少素材后重试",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(client.audio.transcriptions.create).not.toHaveBeenCalled();
  });

  it("requires explicit author review of image-derived paragraphs even after AI review", async () => {
    const client = compatibleClient([imageId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      imageMode: "native",
      assetReader: assetReader("image/jpeg"),
      client,
    });
    const draft = await provider.generateLetter(inputWith([imageMaterial()]));
    expect(draft.paragraphs[0]?.sourceAttribution).toBe("needs-review");
    expect(draft.paragraphs[0]?.sourceRefs).toEqual([imageId]);
  });

  it("supports prompt-only JSON compatibility mode", async () => {
    const client = compatibleClient([textId]);
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      jsonMode: "prompt-only",
      client,
    });

    await provider.generateLetter(inputWith([textMaterial()]));

    const request = vi.mocked(client.chat.completions.create).mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("response_format");
  });

  it("requires separate compatible credentials and secure endpoint configuration", () => {
    expect(() => createAIProviderFromEnv({ AI_PROVIDER: "openai-compatible" })).toThrow(
      "OPENAI_COMPATIBLE_API_KEY",
    );
    const environment = {
      AI_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_API_KEY: "test-key",
      OPENAI_COMPATIBLE_MODEL: "proxy-model",
      OPENAI_COMPATIBLE_BASE_URL: "https://proxy.example.test/v1",
    };
    expect(createAIProviderFromEnv(environment)).toMatchObject({
      providerMode: "openai-compatible",
      name: "openai-compatible-chat:proxy-model",
    });
    expect(() =>
      createAIProviderFromEnv({
        ...environment,
        OPENAI_COMPATIBLE_BASE_URL: "https://user:pass@proxy.example.test/v1",
      }),
    ).toThrow("OpenAI-compatible baseURL");
    expect(() =>
      createAIProviderFromEnv({
        ...environment,
        OPENAI_COMPATIBLE_AUDIO_MODE: "transcription",
      }),
    ).toThrow("transcriptionModel");
  });

  it("discloses compatible provider input modes without exposing endpoint, model, or key", async () => {
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "health-test-key",
      model: "health-test-model",
      baseURL: "https://health-proxy.example.test/v1",
      imageMode: "native",
      audioMode: "native",
      client: compatibleClient([textId]),
    });
    const app = buildApp({ deploymentMode: "test", aiProvider: provider });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(json<{ capabilities: Record<string, unknown> }>(response).capabilities).toMatchObject({
        ai: "openai-compatible",
        aiInputs: {
          configured: { text: "native", image: "native", audio: "native" },
          verification: "configured-only",
        },
      });
      expect(response.body).not.toContain("health-test-key");
      expect(response.body).not.toContain("health-test-model");
      expect(response.body).not.toContain("health-proxy.example.test");
    } finally {
      await app.close();
    }
  });

  it("reports an exact Qwen profile as a profile match rather than a live runtime probe", async () => {
    const provider = qwenProvider(
      compatibleClient([textId]),
      assetReader("image/jpeg"),
    );
    const app = buildApp({ deploymentMode: "competition", aiProvider: provider });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(json<{ capabilities: Record<string, unknown> }>(response).capabilities).toMatchObject({
        ai: "openai-compatible",
        aiInputs: {
          configured: { text: "native", image: "native", audio: "transcription" },
          verification: "profile-match",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("blocks a compatible competition app when multimodal capabilities remain unverified", () => {
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test-key",
      model: "proxy-model",
      baseURL: "https://proxy.example.test/v1",
      client: compatibleClient([textId]),
    });

    expect(() => buildApp({ deploymentMode: "competition", aiProvider: provider })).toThrow(
      "competition mode requires a probed OpenAI-compatible profile with image and audio capabilities",
    );
  });
});
