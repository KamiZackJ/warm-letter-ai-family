import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../src/services/mock-api";
import type { Letter, Material } from "../src/types/domain";
import {
  getLetters,
  getMaterials,
  saveLetters,
  saveMaterials,
} from "../src/utils/storage";

const storage = new Map<string, unknown>();

function confirmedLetter(id: string): Letter {
  return {
    id,
    status: "CONFIRMED",
    materialIds: [],
    intent: {
      recipient: "奶奶",
      message: "报个平安",
      tone: "warm",
      length: "short",
      focus: "最近一切都好",
      exclusions: "",
    },
    draft: {
      title: "写给奶奶的一封信",
      salutation: "奶奶：",
      paragraphs: [],
      closing: "愿你每天都好。",
      signature: "想念你的我",
    },
    replies: [],
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T08:00:00.000Z",
    confirmedAt: "2026-08-16T08:00:00.000Z",
    shareToken: `share-${id}`,
  };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe("mock API idempotency", () => {
  beforeEach(() => {
    storage.clear();
    vi.useFakeTimers();
    Object.assign(globalThis, {
      wx: {
        getStorageSync(key: string) {
          return storage.get(key);
        },
        setStorageSync(key: string, value: unknown) {
          storage.set(key, value);
        },
        removeStorageSync(key: string) {
          storage.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays the same material ID and rejects changed content", async () => {
    const material: Material = {
      id: "text-stable-request",
      type: "text",
      name: "今天的近况",
      text: "晚饭吃得很好。",
      createdAt: "2026-08-16T08:00:00.000Z",
    };
    saveMaterials([]);

    const first = await settle(mockApi.saveMaterial(material));
    const replay = await settle(mockApi.saveMaterial({ ...material }));

    expect(replay).toEqual(first);
    expect(getMaterials()).toEqual([material]);
    await expect(
      mockApi.saveMaterial({ ...material, text: "同一个 ID 改成了另一段内容。" }),
    ).rejects.toThrow("该素材请求标识已用于其他内容");
    expect(getMaterials()).toEqual([material]);
  });

  it("replays the original reply for the same key and rejects changed text", async () => {
    const letter = confirmedLetter("letter-reply-idempotency");
    const requestKey = "reply_retry_after_lost_response_20260816";
    saveLetters([letter]);

    const first = await settle(
      mockApi.addReply(letter.id, "  收到信了  ", letter.shareToken, requestKey),
    );
    const replay = await settle(
      mockApi.addReply(letter.id, "收到信了", letter.shareToken, requestKey),
    );

    expect(replay).toEqual(first);
    expect(replay.text).toBe("收到信了");
    expect(getLetters()[0]?.replies).toEqual([first]);
    await expect(
      mockApi.addReply(letter.id, "同一个键改成另一条回复", letter.shareToken, requestKey),
    ).rejects.toThrow("该回复请求标识已用于其他内容");
    expect(getLetters()[0]?.replies).toEqual([first]);
  });

  it("rejects forged AI attribution for edited mock drafts", async () => {
    const now = "2026-08-17T08:00:00.000Z";
    const aiParagraph = {
      id: "paragraph-ai",
      text: "AI 根据照片整理的一段话。",
      sourceRefs: ["photo-1"],
      sourceAttribution: "ai" as const,
    };
    const draft = {
      title: "写给奶奶的一封信",
      salutation: "奶奶：",
      paragraphs: [aiParagraph],
      closing: "愿你每天都好。",
      signature: "想念你的我",
    };
    const letter: Letter = {
      id: "letter-attribution",
      status: "EDITING",
      materialIds: ["photo-1"],
      intent: {
        recipient: "奶奶",
        message: "报个平安",
        tone: "warm",
        length: "short",
        focus: "最近一切都好",
        exclusions: "",
      },
      draft,
      replies: [],
      createdAt: now,
      updatedAt: now,
    };
    saveLetters([letter]);

    await expect(
      mockApi.updateDraft(letter.id, {
        ...draft,
        paragraphs: [{ ...aiParagraph, text: "写信人改写后的内容。" }],
      }),
    ).rejects.toThrow("只有原始 AI 整理段落可以保留 AI 归因");
    expect(getLetters()[0]?.draft).toEqual(draft);
  });

  it("normalizes valid signatures and rejects empty mock signatures", async () => {
    const letter = confirmedLetter("letter-signature-validation");
    letter.status = "EDITING";
    saveLetters([letter]);

    const updated = await settle(
      mockApi.updateDraft(letter.id, { ...letter.draft!, signature: "  阿宁  " }),
    );
    expect(updated.draft?.signature).toBe("阿宁");

    await expect(
      mockApi.updateDraft(letter.id, { ...updated.draft!, signature: "   " }),
    ).rejects.toThrow("署名必须为 1 到 30 个字符");
  });
});
