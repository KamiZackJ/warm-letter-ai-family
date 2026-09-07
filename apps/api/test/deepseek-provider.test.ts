import OpenAI, { APIConnectionTimeoutError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  AIProviderError,
  DeepSeekChatProvider,
  createAIProviderFromEnv,
  type GenerateLetterInput,
} from "../src/ai.js";

const firstMaterialId = "11111111-1111-4111-8111-111111111111";
const secondMaterialId = "22222222-2222-4222-8222-222222222222";

function input(version = 1): GenerateLetterInput {
  return {
    recipient: "妈妈",
    settings: {
      tone: "warm",
      length: "medium",
      focus: "告诉她项目演示顺利完成",
      excludedTopics: ["不强调疲惫"],
    },
    materials: [
      {
        id: firstMaterialId,
        userId: "user-1",
        type: "text",
        name: "项目进展",
        textContent: "今天第一次把小程序完整演示给队友看，上传照片和生成家书都跑通了。",
        status: "READY",
        createdAt: "2026-09-07T10:00:00.000Z",
      },
      {
        id: secondMaterialId,
        userId: "user-1",
        type: "text",
        name: "周末安排",
        textContent: "周六下午会回家，想吃妈妈做的番茄炒蛋。",
        status: "READY",
        createdAt: "2026-09-07T10:01:00.000Z",
      },
    ],
    version,
  };
}

function clientWithContent(content: string, model = "resolved-deepseek-model"): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          model,
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

function validOutput() {
  return JSON.stringify({
    title: "周六见，妈妈",
    greeting: "妈妈：",
    paragraphs: [
      {
        text: "今天终于把小程序从上传照片到生成家书完整演示了一遍，我第一个就想把这个消息告诉你。",
        sourceRefs: [firstMaterialId],
      },
      {
        text: "周六下午我会回家。番茄炒蛋先别急着做太多，给我留一盘就好。",
        sourceRefs: [secondMaterialId],
      },
    ],
    closing: "到家前我给你发消息。",
  });
}

describe("DeepSeekChatProvider", () => {
  it("generates a traceable text-only letter through chat completions", async () => {
    const client = clientWithContent(validOutput());
    const provider = new DeepSeekChatProvider({
      apiKey: "test-key",
      model: "test-model",
      client,
    });

    const draft = await provider.generateLetter(input());

    expect(draft.provider).toBe("deepseek-chat:resolved-deepseek-model");
    expect(draft.paragraphs.flatMap((paragraph) => paragraph.sourceRefs)).toEqual([
      firstMaterialId,
      secondMaterialId,
    ]);
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        temperature: 0.95,
        response_format: { type: "json_object" },
      }),
    );
  });

  it("changes the explicit writing direction between rewrite versions", async () => {
    const firstClient = clientWithContent(validOutput());
    const secondClient = clientWithContent(validOutput());
    await new DeepSeekChatProvider({ apiKey: "test-key", model: "test-model", client: firstClient })
      .generateLetter(input(1));
    await new DeepSeekChatProvider({ apiKey: "test-key", model: "test-model", client: secondClient })
      .generateLetter(input(2));

    const firstRequest = vi.mocked(firstClient.chat.completions.create).mock.calls[0]?.[0];
    const secondRequest = vi.mocked(secondClient.chat.completions.create).mock.calls[0]?.[0];
    const firstUserMessage = firstRequest?.messages[1]?.content;
    const secondUserMessage = secondRequest?.messages[1]?.content;
    expect(firstUserMessage).toContain("从一个具体瞬间切入");
    expect(secondUserMessage).toContain("像晚饭后的语音消息");
    expect(firstUserMessage).not.toBe(secondUserMessage);
  });

  it("rejects media instead of pretending a text model understood it", async () => {
    const client = clientWithContent(validOutput());
    const provider = new DeepSeekChatProvider({ apiKey: "test-key", model: "test-model", client });
    const withPhoto: GenerateLetterInput = {
      ...input(),
      materials: [
        {
          id: firstMaterialId,
          userId: "user-1",
          type: "photo",
          name: "晚饭.jpg",
          objectKey: "user-1/dinner.jpg",
          contentType: "image/jpeg",
          status: "READY",
          createdAt: "2026-09-07T10:00:00.000Z",
        },
      ],
    };

    await expect(provider.generateLetter(withPhoto)).rejects.toMatchObject({
      code: "AI_MATERIAL_UNSUPPORTED",
      retryable: false,
    } satisfies Partial<AIProviderError>);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON and invented source references", async () => {
    const invalidJsonProvider = new DeepSeekChatProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithContent("not-json"),
    });
    await expect(invalidJsonProvider.generateLetter(input())).rejects.toMatchObject({
      code: "AI_OUTPUT_INVALID",
      retryable: false,
    });

    const inventedSourceProvider = new DeepSeekChatProvider({
      apiKey: "test-key",
      model: "test-model",
      client: clientWithContent(
        JSON.stringify({
          title: "一封信",
          greeting: "妈妈：",
          paragraphs: [{ text: "没有依据的内容。", sourceRefs: ["invented-source"] }],
          closing: "祝好。",
        }),
      ),
    });
    await expect(inventedSourceProvider.generateLetter(input())).rejects.toThrow("不属于当前家书");
  });

  it("maps SDK timeouts to the shared retryable error", async () => {
    const client = clientWithContent(validOutput());
    vi.mocked(client.chat.completions.create).mockRejectedValue(new APIConnectionTimeoutError());
    const provider = new DeepSeekChatProvider({ apiKey: "test-key", model: "test-model", client });

    await expect(provider.generateLetter(input())).rejects.toMatchObject({
      code: "AI_PROVIDER_TIMEOUT",
      retryable: true,
    } satisfies Partial<AIProviderError>);
  });

  it("requires DeepSeek credentials and validates retry settings", () => {
    expect(() => createAIProviderFromEnv({ AI_PROVIDER: "deepseek" })).toThrow(
      "DEEPSEEK_API_KEY 和 DEEPSEEK_MODEL",
    );
    const base = {
      AI_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_MODEL: "deepseek-chat",
    };
    expect(createAIProviderFromEnv(base).name).toBe("deepseek-chat:deepseek-chat");
    expect(() => createAIProviderFromEnv({ ...base, DEEPSEEK_TIMEOUT_MS: "999" })).toThrow(
      "DEEPSEEK_TIMEOUT_MS",
    );
    expect(() => createAIProviderFromEnv({ ...base, DEEPSEEK_MAX_RETRIES: "6" })).toThrow(
      "DEEPSEEK_MAX_RETRIES",
    );
  });
});
