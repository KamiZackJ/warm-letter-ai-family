import OpenAI, { APIConnectionTimeoutError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  AIProviderError,
  OpenAIResponsesProvider,
  createAIProviderFromEnv,
  type GenerateLetterInput,
} from "../src/ai.js";

const materialIds = {
  text: "11111111-1111-4111-8111-111111111111",
  photo: "22222222-2222-4222-8222-222222222222",
  screenshot: "33333333-3333-4333-8333-333333333333",
  audio: "44444444-4444-4444-8444-444444444444",
  unknown: "99999999-9999-4999-8999-999999999999",
} as const;

const input: GenerateLetterInput = {
  recipient: "妈妈",
  settings: {
    tone: "warm",
    length: "medium",
    focus: "告诉她项目演示顺利完成",
    excludedTopics: ["不强调疲惫"],
  },
  materials: [
    {
      id: materialIds.text,
      userId: "user-1",
      type: "text",
      name: "今日小记",
      textContent: "今天完成了项目第一次演示。",
      status: "READY",
      createdAt: "2026-08-14T10:00:00.000Z",
    },
  ],
  version: 1,
};

function clientWithOutput(output: unknown, model = "resolved-test-model"): OpenAI {
  return {
    responses: {
      parse: vi.fn().mockResolvedValue({ output_parsed: output, model }),
    },
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text: "" }),
      },
    },
  } as unknown as OpenAI;
}

function multiModalInput(): GenerateLetterInput {
  return {
    ...input,
    materials: [
      input.materials[0]!,
      {
        id: materialIds.photo,
        userId: "user-1",
        type: "photo",
        name: "晚饭.png",
        objectKey: "user-1/dinner.png",
        contentType: "image/png",
        status: "READY",
        createdAt: "2026-08-14T10:00:00.000Z",
      },
      {
        id: materialIds.screenshot,
        userId: "user-1",
        type: "screenshot",
        name: "周末日程.png",
        objectKey: "user-1/schedule.png",
        contentType: "image/png",
        status: "READY",
        createdAt: "2026-08-14T10:00:00.000Z",
      },
      {
        id: materialIds.audio,
        userId: "user-1",
        type: "audio",
        name: "报平安.mp3",
        objectKey: "user-1/voice.mp3",
        contentType: "audio/mpeg",
        status: "READY",
        createdAt: "2026-08-14T10:00:00.000Z",
      },
    ],
  };
}

function multiModalAssetReader() {
  return {
    read: vi.fn().mockImplementation(async (objectKey: string) => ({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: objectKey.endsWith(".mp3") ? "audio/mpeg" : "image/png",
    })),
  };
}

describe("OpenAIResponsesProvider", () => {
  it("maps structured output into a traceable letter draft", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [
        {
          text: "今天完成了项目第一次演示，最难的一步已经走过去了。",
          sourceRefs: [materialIds.text],
        },
      ],
      closing: "周末再给你打电话。",
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
    });

    const draft = await provider.generateLetter(input);

    expect(draft.provider).toBe("openai-responses:resolved-test-model");
    expect(draft.paragraphs[0]?.sourceRefs).toEqual([materialIds.text]);
    expect(draft.version).toBe(1);
    expect(vi.mocked(client.responses.parse).mock.calls[0]?.[0]).toMatchObject({ store: false });
  });

  it("rejects source references that were not supplied by the user", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithOutput({
        title: "写给妈妈的今天",
        greeting: "亲爱的妈妈：",
        paragraphs: [{ text: "一段没有依据的内容。", sourceRefs: [materialIds.unknown] }],
        closing: "祝好。",
      }),
    });

    await expect(provider.generateLetter(input)).rejects.toThrow("不属于当前家书");
  });

  it("sends uploaded photos and screenshots with task-appropriate detail", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [
        {
          text: "晚饭已经做好了，日程写着周六回家。",
          sourceRefs: [materialIds.photo, materialIds.photo, materialIds.screenshot],
        },
      ],
      closing: "祝好。",
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
      assetReader: {
        read: vi.fn().mockResolvedValue({
          bytes: Uint8Array.from([1, 2, 3]),
          contentType: "image/png",
        }),
      },
    });

    const draft = await provider.generateLetter({
      ...input,
      materials: [
        {
          id: materialIds.photo,
          userId: "user-1",
          type: "photo",
          name: "晚饭.png",
          objectKey: "user-1/photo-1",
          contentType: "image/png",
          status: "READY",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
        {
          id: materialIds.screenshot,
          userId: "user-1",
          type: "screenshot",
          name: "周末日程.png",
          objectKey: "user-1/screen-1",
          contentType: "image/png",
          status: "READY",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    });

    expect(draft.paragraphs[0]?.sourceRefs).toEqual([materialIds.photo, materialIds.screenshot]);

    const request = vi.mocked(client.responses.parse).mock.calls[0]?.[0] as {
      input: Array<{ content: unknown }>;
    };
    expect(request.input[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input_image",
          image_url: "data:image/png;base64,AQID",
          detail: "auto",
        }),
        expect.objectContaining({
          type: "input_image",
          image_url: "data:image/png;base64,AQID",
          detail: "original",
        }),
      ]),
    );
  });

  it("transcribes uploaded audio before structured generation", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [{ text: "我说最近一切顺利。", sourceRefs: [materialIds.audio] }],
      closing: "祝好。",
    });
    vi.mocked(client.audio.transcriptions.create).mockResolvedValue({
      text: "妈妈，我最近一切顺利。",
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
      assetReader: {
        read: vi.fn().mockResolvedValue({
          bytes: Uint8Array.from([4, 5, 6]),
          contentType: "audio/mpeg",
        }),
      },
    });

    await provider.generateLetter({
      ...input,
      materials: [
        {
          id: materialIds.audio,
          userId: "user-1",
          type: "audio",
          name: "报平安.mp3",
          objectKey: "user-1/audio-1",
          contentType: "audio/mpeg",
          status: "READY",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    });

    expect(client.audio.transcriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-transcribe", response_format: "json" }),
    );
    const request = vi.mocked(client.responses.parse).mock.calls[0]?.[0] as {
      input: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    expect(request.input[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input_text",
          text: expect.stringContaining("妈妈，我最近一切顺利。"),
        }),
      ]),
    );
  });

  it("accepts a four-material draft only when every selected source is referenced", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [
        {
          text: "演示完成了，晚饭也做好了，周六会回家，语音里也报了平安。",
          sourceRefs: [
            materialIds.text,
            materialIds.photo,
            materialIds.screenshot,
            materialIds.audio,
          ],
        },
      ],
      closing: "周末见。",
    });
    vi.mocked(client.audio.transcriptions.create).mockResolvedValue({ text: "妈妈，我最近一切顺利。" });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
      assetReader: multiModalAssetReader(),
    });

    const draft = await provider.generateLetter(multiModalInput());

    expect(draft.paragraphs[0]?.sourceRefs).toEqual([
      materialIds.text,
      materialIds.photo,
      materialIds.screenshot,
      materialIds.audio,
    ]);
  });

  it("fails closed when a four-material draft omits the screenshot source", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [
        {
          text: "演示完成了，晚饭也做好了，语音里也报了平安。",
          sourceRefs: [materialIds.text, materialIds.photo, materialIds.audio],
        },
      ],
      closing: "周末见。",
    });
    vi.mocked(client.audio.transcriptions.create).mockResolvedValue({ text: "妈妈，我最近一切顺利。" });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
      assetReader: multiModalAssetReader(),
    });

    await expect(provider.generateLetter(multiModalInput())).rejects.toMatchObject({
      code: "AI_OUTPUT_INCOMPLETE",
      retryable: true,
    });
  });

  it("fails closed when an audio transcript is empty", async () => {
    const client = clientWithOutput({});
    vi.mocked(client.audio.transcriptions.create).mockResolvedValue({ text: "   " });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
      assetReader: {
        read: vi.fn().mockResolvedValue({
          bytes: Uint8Array.from([4, 5, 6]),
          contentType: "audio/mpeg",
        }),
      },
    });

    await expect(
      provider.generateLetter({
        ...input,
        materials: [
          {
            id: materialIds.audio,
            userId: "user-1",
            type: "audio",
            name: "空白语音.mp3",
            objectKey: "user-1/audio-1",
            contentType: "audio/mpeg",
            status: "READY",
            createdAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      }),
    ).rejects.toThrow("语音转写为空");
    expect(client.responses.parse).not.toHaveBeenCalled();
  });

  it("rejects blank structured fields returned by an injected client", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithOutput({
        title: "写给妈妈的今天",
        greeting: "亲爱的妈妈：",
        paragraphs: [{ text: "   ", sourceRefs: [materialIds.text] }],
        closing: "祝好。",
      }),
    });

    await expect(provider.generateLetter(input)).rejects.toThrow("空的正文段落");
  });

  it("does not generate from missing media objects", async () => {
    const client = clientWithOutput({});
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
      assetReader: { read: vi.fn().mockResolvedValue(undefined) },
    });

    await expect(
      provider.generateLetter({
        ...input,
        materials: [
          {
            id: materialIds.photo,
            userId: "user-1",
            type: "photo",
            name: "missing.jpg",
            objectKey: "user-1/missing.jpg",
            contentType: "image/jpeg",
            status: "READY",
            createdAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      }),
    ).rejects.toThrow("媒体对象不存在");
    expect(client.responses.parse).not.toHaveBeenCalled();
  });

  it("maps OpenAI SDK timeouts to a safe retryable provider error", async () => {
    const client = clientWithOutput({});
    vi.mocked(client.responses.parse).mockRejectedValue(new APIConnectionTimeoutError());
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
    });

    await expect(provider.generateLetter(input)).rejects.toMatchObject({
      name: "AIProviderError",
      code: "AI_PROVIDER_TIMEOUT",
      retryable: true,
    } satisfies Partial<AIProviderError>);
  });

  it("uses the OpenAI SDK limited retry for a 429 before succeeding", async () => {
    const output = {
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [{ text: "今天完成了项目演示。", sourceRefs: [materialIds.text] }],
      closing: "祝好。",
    };
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after-ms": "0" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_retry_test",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "resolved-retry-model",
          output: [
            {
              id: "msg_retry_test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(output),
                  annotations: [],
                  logprobs: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new OpenAI({
      apiKey: "test-key",
      maxRetries: 1,
      timeout: 1_000,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
    });

    const draft = await provider.generateLetter(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(draft.provider).toBe("openai-responses:resolved-retry-model");
  });

  it("rejects drafts that fail the shared runtime contract", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithOutput(
        {
          title: "写给妈妈的今天",
          greeting: "亲爱的妈妈：",
          paragraphs: [{ text: "今天完成了项目演示。", sourceRefs: [materialIds.text] }],
          closing: "祝好。",
        },
        "x".repeat(101),
      ),
    });

    await expect(provider.generateLetter(input)).rejects.toMatchObject({
      code: "AI_OUTPUT_INVALID",
      retryable: false,
    });
  });

  it("requires explicit credentials and model when OpenAI is enabled", () => {
    expect(() => createAIProviderFromEnv({ AI_PROVIDER: "openai" })).toThrow(
      "OPENAI_API_KEY 和 OPENAI_MODEL",
    );
  });

  it("fails closed instead of silently selecting fake AI in production", () => {
    expect(createAIProviderFromEnv({ NODE_ENV: "development" }).name).toBe("fake-ai-v1");
    expect(() => createAIProviderFromEnv({ NODE_ENV: "production" })).toThrow(
      "AI_PROVIDER=openai",
    );
    expect(() =>
      createAIProviderFromEnv({ NODE_ENV: "production", AI_PROVIDER: "fake" }),
    ).toThrow("禁止使用 fake");
    expect(() => createAIProviderFromEnv({ AI_PROVIDER: "opena1" })).toThrow("不支持的 AI_PROVIDER");
  });

  it("rejects unsafe OpenAI runtime configuration", () => {
    const base = {
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "test-model",
    };
    expect(() => createAIProviderFromEnv({ ...base, OPENAI_TIMEOUT_MS: "999" })).toThrow(
      "OPENAI_TIMEOUT_MS",
    );
    expect(() => createAIProviderFromEnv({ ...base, OPENAI_MAX_RETRIES: "6" })).toThrow(
      "OPENAI_MAX_RETRIES",
    );
    expect(() => createAIProviderFromEnv({ ...base, OPENAI_SCREENSHOT_DETAIL: "ultra" })).toThrow(
      "OPENAI_SCREENSHOT_DETAIL",
    );
  });
});
