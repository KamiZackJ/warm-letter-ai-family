import { randomUUID } from "node:crypto";
import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { z } from "zod";
import type { LetterDraft, LetterSettings, Material } from "./domain.js";

export interface GenerateLetterInput {
  recipient: string;
  settings: LetterSettings;
  materials: Material[];
  version: number;
}

export interface AIProvider {
  readonly name: string;
  generateLetter(input: GenerateLetterInput): Promise<LetterDraft>;
}

export interface MaterialAsset {
  bytes: Uint8Array;
  contentType: string;
}

export interface MaterialAssetReader {
  read(objectKey: string): Promise<MaterialAsset | undefined>;
}

function materialSummary(material: Material): string {
  if (material.type === "text") {
    return material.textContent ?? material.name;
  }

  const descriptions: Record<Exclude<Material["type"], "text">, string> = {
    photo: `照片《${material.name}》记录了今天想分享的画面`,
    screenshot: `截图《${material.name}》保存了今天值得说起的消息`,
    audio: `语音《${material.name}》留下了今天想亲口说的话`,
  };
  return descriptions[material.type];
}

export class FakeAIProvider implements AIProvider {
  readonly name = "fake-ai-v1";

  async generateLetter(input: GenerateLetterInput): Promise<LetterDraft> {
    const paragraphs = input.materials.map((material) => ({
      id: randomUUID(),
      text: materialSummary(material),
      sourceRefs: [material.id],
    }));

    if (input.settings.focus) {
      paragraphs.push({
        id: randomUUID(),
        text: `我尤其想和你说：${input.settings.focus}`,
        sourceRefs: input.materials.map((material) => material.id),
      });
    }

    return {
      version: input.version,
      title: `写给${input.recipient}的一封暖笺`,
      greeting: `亲爱的${input.recipient}：`,
      paragraphs,
      closing: "愿你平安顺心，等我们下次再慢慢聊。",
      provider: this.name,
      generatedAt: new Date().toISOString(),
    };
  }
}

const OpenAILetterOutputSchema = z.object({
  title: z.string(),
  greeting: z.string(),
  paragraphs: z.array(
    z.object({
      text: z.string(),
      sourceRefs: z.array(z.string()),
    }),
  ),
  closing: z.string(),
});

type OpenAILetterOutput = z.infer<typeof OpenAILetterOutputSchema>;

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  model: string;
  transcriptionModel?: string;
  assetReader?: MaterialAssetReader;
  client?: OpenAI;
}

export class OpenAIResponsesProvider implements AIProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly transcriptionModel: string;
  private readonly assetReader?: MaterialAssetReader;

  constructor(options: OpenAIResponsesProviderOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.transcriptionModel = options.transcriptionModel ?? "gpt-4o-mini-transcribe";
    this.assetReader = options.assetReader;
    this.name = `openai-responses:${options.model}`;
  }

  async generateLetter(input: GenerateLetterInput): Promise<LetterDraft> {
    const allowedSourceIds = new Set(input.materials.map((material) => material.id));
    const userContent = await this.buildUserContent(input);
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        {
          role: "system",
          content: [
            "你是暖笺的家书整理助手。",
            "只能使用用户主动提供的素材，不得补充、猜测或夸大事实。",
            "每个正文段落都必须引用至少一个素材 ID，sourceRefs 只能来自输入素材。",
            "遵守用户指定的语气、篇幅、重点和禁用内容。",
            "输出自然、克制、适合家人阅读的中文家书。",
          ].join("\n"),
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      text: {
        format: zodTextFormat(OpenAILetterOutputSchema, "warm_letter_draft"),
      },
    });

    const parsed: OpenAILetterOutput | null = response.output_parsed;
    if (!parsed) {
      throw new Error("OpenAI 未返回可解析的家书草稿");
    }

    const paragraphs = parsed.paragraphs.map((paragraph) => {
      if (paragraph.sourceRefs.length === 0) {
        throw new Error("OpenAI 返回了缺少来源引用的段落");
      }
      if (paragraph.sourceRefs.some((sourceId) => !allowedSourceIds.has(sourceId))) {
        throw new Error("OpenAI 返回了不属于当前家书的来源引用");
      }
      return {
        id: randomUUID(),
        text: paragraph.text.trim(),
        sourceRefs: [...new Set(paragraph.sourceRefs)],
      };
    });

    return {
      version: input.version,
      title: parsed.title.trim(),
      greeting: parsed.greeting.trim(),
      paragraphs,
      closing: parsed.closing.trim(),
      provider: this.name,
      generatedAt: new Date().toISOString(),
    };
  }

  private async buildUserContent(input: GenerateLetterInput): Promise<ResponseInputContent[]> {
    const content: ResponseInputContent[] = [
      {
        type: "input_text",
        text: JSON.stringify({
          recipient: input.recipient,
          settings: input.settings,
          instruction: "以下内容均为用户主动选择的素材。每个事实必须引用对应素材 ID。",
        }),
      },
    ];

    for (const material of input.materials) {
      if (material.type === "text") {
        content.push({
          type: "input_text",
          text: JSON.stringify({
            materialId: material.id,
            type: material.type,
            name: material.name,
            content: material.textContent ?? "",
          }),
        });
        continue;
      }

      const asset = await this.readAsset(material);
      if (material.type === "photo" || material.type === "screenshot") {
        if (!asset.contentType.startsWith("image/")) {
          throw new Error(`素材 ${material.id} 不是可识别的图片`);
        }
        content.push({
          type: "input_text",
          text: JSON.stringify({
            materialId: material.id,
            type: material.type,
            name: material.name,
            instruction: "请读取紧随其后的图片内容和其中可见文字。",
          }),
        });
        content.push({
          type: "input_image",
          image_url: `data:${asset.contentType};base64,${Buffer.from(asset.bytes).toString("base64")}`,
          detail: material.type === "screenshot" ? "high" : "auto",
        });
        continue;
      }

      const transcription = await this.client.audio.transcriptions.create({
        file: await toFile(asset.bytes, material.name, { type: asset.contentType }),
        model: this.transcriptionModel,
        response_format: "json",
      });
      content.push({
        type: "input_text",
        text: JSON.stringify({
          materialId: material.id,
          type: material.type,
          name: material.name,
          transcript: transcription.text,
        }),
      });
    }

    return content;
  }

  private async readAsset(material: Material): Promise<MaterialAsset> {
    if (!material.objectKey || !this.assetReader) {
      throw new Error(`素材 ${material.id} 缺少可读取的媒体对象`);
    }
    const asset = await this.assetReader.read(material.objectKey);
    if (!asset) {
      throw new Error(`素材 ${material.id} 的媒体对象不存在`);
    }
    return asset;
  }
}

export function createAIProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { assetReader?: MaterialAssetReader } = {},
): AIProvider {
  if ((env.AI_PROVIDER ?? "fake").toLowerCase() !== "openai") {
    return new FakeAIProvider();
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("AI_PROVIDER=openai 时必须配置 OPENAI_API_KEY 和 OPENAI_MODEL");
  }

  return new OpenAIResponsesProvider({
    apiKey,
    model,
    transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL?.trim() || undefined,
    assetReader: options.assetReader,
  });
}
