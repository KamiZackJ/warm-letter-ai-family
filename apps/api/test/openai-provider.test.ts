import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAIResponsesProvider,
  createAIProviderFromEnv,
  type GenerateLetterInput,
} from "../src/ai.js";

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
      id: "material-1",
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

function clientWithOutput(output: unknown): OpenAI {
  return {
    responses: {
      parse: vi.fn().mockResolvedValue({ output_parsed: output }),
    },
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text: "" }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAIResponsesProvider", () => {
  it("maps structured output into a traceable letter draft", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithOutput({
        title: "写给妈妈的今天",
        greeting: "亲爱的妈妈：",
        paragraphs: [
          {
            text: "今天完成了项目第一次演示，最难的一步已经走过去了。",
            sourceRefs: ["material-1"],
          },
        ],
        closing: "周末再给你打电话。",
      }),
    });

    const draft = await provider.generateLetter(input);

    expect(draft.provider).toBe("openai-responses:test-model");
    expect(draft.paragraphs[0]?.sourceRefs).toEqual(["material-1"]);
    expect(draft.version).toBe(1);
  });

  it("rejects source references that were not supplied by the user", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithOutput({
        title: "写给妈妈的今天",
        greeting: "亲爱的妈妈：",
        paragraphs: [{ text: "一段没有依据的内容。", sourceRefs: ["unknown-source"] }],
        closing: "祝好。",
      }),
    });

    await expect(provider.generateLetter(input)).rejects.toThrow("不属于当前家书");
  });

  it("sends uploaded photos to Responses as traceable image inputs", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [{ text: "晚饭已经做好了。", sourceRefs: ["photo-1"] }],
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

    await provider.generateLetter({
      ...input,
      materials: [
        {
          id: "photo-1",
          userId: "user-1",
          type: "photo",
          name: "晚饭.png",
          objectKey: "user-1/photo-1",
          contentType: "image/png",
          status: "READY",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    });

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
      ]),
    );
  });

  it("transcribes uploaded audio before structured generation", async () => {
    const client = clientWithOutput({
      title: "写给妈妈的今天",
      greeting: "亲爱的妈妈：",
      paragraphs: [{ text: "我说最近一切顺利。", sourceRefs: ["audio-1"] }],
      closing: "祝好。",
    });
    vi.mocked(client.audio.transcriptions.create).mockResolvedValue({
      text: "妈妈，我最近一切顺利。",
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      transcriptionModel: "test-transcription-model",
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
          id: "audio-1",
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
      expect.objectContaining({ model: "test-transcription-model", response_format: "json" }),
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
            id: "photo-1",
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

  it("requires explicit credentials and model when OpenAI is enabled", () => {
    expect(() => createAIProviderFromEnv({ AI_PROVIDER: "openai" })).toThrow(
      "OPENAI_API_KEY 和 OPENAI_MODEL",
    );
  });
});
