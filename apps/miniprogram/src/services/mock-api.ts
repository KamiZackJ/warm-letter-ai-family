import type {
  CreateLetterInput,
  DraftParagraph,
  Letter,
  LetterDraft,
  LetterSummary,
  Material,
  ReaderLetter,
  Reply,
} from "../types/domain";
import { createId } from "../utils/id";
import {
  getLetters,
  getMaterials,
  saveLetters,
  saveMaterials,
} from "../utils/storage";
import { getParagraphSourceAttribution } from "../utils/paragraph-attribution";

const wait = <T>(value: T, delay = 280): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), delay));

const replyRequestsByKey = new Map<
  string,
  { requestFingerprint: string; replyId: string }
>();

function sameMaterial(left: Material, right: Material): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.name === right.name &&
    left.localPath === right.localPath &&
    left.text === right.text &&
    left.durationSeconds === right.durationSeconds &&
    left.createdAt === right.createdAt
  );
}

function replyFingerprint(text: string): string {
  return JSON.stringify({ text: text.normalize("NFKC").trim(), authorName: "家人" });
}

function idempotencyConflict(subject: "素材" | "回复"): Error {
  return new Error(`该${subject}请求标识已用于其他内容`);
}

function requireLetter(id: string): Letter {
  const letter = getLetters().find((item) => item.id === id);
  if (!letter) {
    throw new Error("没有找到这封家书");
  }
  return letter;
}

function updateLetter(updated: Letter): Letter {
  const letters = getLetters();
  const next = letters.map((item) => (item.id === updated.id ? updated : item));
  saveLetters(next);
  return updated;
}

function materialSummary(material: Material): string {
  if (material.type === "text") {
    return material.text?.trim() || "一段文字记录";
  }
  if (material.type === "voice") {
    return `一段约 ${material.durationSeconds || 0} 秒的语音`;
  }
  return material.type === "photo" ? "一张生活照片" : "一张聊天截图";
}

function generateDraft(letter: Letter): LetterDraft {
  const materials = getMaterials().filter((item) => letter.materialIds.includes(item.id));
  const textMaterial = materials.find((item) => item.type === "text" && item.text);
  const visualMaterials = materials.filter(
    (item) => item.type === "photo" || item.type === "screenshot",
  );
  const voiceMaterial = materials.find((item) => item.type === "voice");
  const paragraphs: DraftParagraph[] = [];

  paragraphs.push({
    id: createId("paragraph"),
    text:
      letter.intent.message.trim() ||
      "最近的日子过得平稳，也有一些小事想慢慢说给你听。",
    sourceRefs: textMaterial ? [textMaterial.id] : materials.slice(0, 1).map((item) => item.id),
    sourceAttribution: "ai",
  });

  if (visualMaterials.length > 0) {
    paragraphs.push({
      id: createId("paragraph"),
      text: `我还挑了${visualMaterials.length}张最近的画面。它们不是什么大事，却很适合留在这封信里，等我们见面时再一起细看。`,
      sourceRefs: visualMaterials.map((item) => item.id),
      sourceAttribution: "ai",
    });
  }

  if (voiceMaterial) {
    paragraphs.push({
      id: createId("paragraph"),
      text: "有些话写下来还是不够，我也留了一段声音。希望你读到这里时，能像平常聊天一样听见我的语气。",
      sourceRefs: [voiceMaterial.id],
      sourceAttribution: "ai",
    });
  }

  if (textMaterial?.text && textMaterial.text.trim() !== letter.intent.message.trim()) {
    paragraphs.push({
      id: createId("paragraph"),
      text: textMaterial.text.trim(),
      sourceRefs: [textMaterial.id],
      sourceAttribution: "ai",
    });
  }

  if (letter.intent.focus.trim()) {
    paragraphs.push({
      id: createId("paragraph"),
      text: `最想告诉你的是：${letter.intent.focus.trim()}`,
      sourceRefs: materials.map((item) => item.id).slice(0, 2),
      sourceAttribution: "ai",
    });
  }

  const toneClosing = {
    warm: "愿你每天都吃好、睡好。我们不用等到特别的日子，也可以常常说说近况。",
    concise: "一切都好，勿念。也请照顾好自己。",
    lively: "等下次见面，我再把这些小故事讲得更仔细。记得给我回信。",
  }[letter.intent.tone];

  return {
    title: `写给${letter.intent.recipient || "家人"}的一封信`,
    salutation: `${letter.intent.recipient || "家人"}：`,
    paragraphs,
    closing: toneClosing,
    signature: "想念你的我",
  };
}

function normalizeDraftAttribution(previous: LetterDraft | undefined, draft: LetterDraft): LetterDraft {
  const signature = draft.signature.trim();
  if (!signature || signature.length > 30) {
    throw new Error("署名必须为 1 到 30 个字符");
  }
  return {
    ...draft,
    signature,
    paragraphs: draft.paragraphs.map((paragraph, index) => {
      const previousParagraph = previous?.paragraphs[index];
      const textChanged = !previousParagraph || previousParagraph.text !== paragraph.text;
      if (!paragraph.sourceAttribution) {
        if (textChanged) {
          return { ...paragraph, sourceRefs: [], sourceAttribution: "needs-review" };
        }
        return {
          ...paragraph,
          sourceRefs: previousParagraph.sourceRefs,
          sourceAttribution: previousParagraph.sourceAttribution ?? "ai",
        };
      }
      if (paragraph.sourceAttribution === "ai") {
        if (
          textChanged ||
          (previousParagraph?.sourceAttribution !== undefined &&
            previousParagraph.sourceAttribution !== "ai")
        ) {
          throw new Error(
            "只有原始 AI 整理段落可以保留 AI 归因，请重新核对依据或标记为本人补充",
          );
        }
        if (!sameSourceRefs(paragraph.sourceRefs, previousParagraph?.sourceRefs ?? [])) {
          throw new Error("AI 整理段落不能由客户端更换素材引用");
        }
        return {
          ...paragraph,
          sourceRefs: previousParagraph?.sourceRefs ?? [],
          sourceAttribution: "ai",
        };
      }
      return {
        ...paragraph,
        sourceAttribution:
          paragraph.sourceAttribution ?? previousParagraph?.sourceAttribution ?? "ai",
      };
    }),
  };
}

function sameSourceRefs(left: string[], right: string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length) return false;
  const rightRefs = new Set(right);
  return left.every((sourceRef) => rightRefs.has(sourceRef));
}

function assertDraftReadyForConfirmation(draft: LetterDraft): void {
  for (const paragraph of draft.paragraphs) {
    const sourceAttribution = getParagraphSourceAttribution(paragraph);
    if (sourceAttribution === "needs-review") {
      throw new Error("请先为修改后的段落重新核对素材依据，或标记为本人补充");
    }
    if (sourceAttribution === "sources-confirmed" && paragraph.sourceRefs.length === 0) {
      throw new Error("已核对依据的段落至少需要选择一份素材");
    }
    if (sourceAttribution === "user-supplied" && paragraph.sourceRefs.length > 0) {
      throw new Error("本人补充的段落不能保留素材引用");
    }
    if (sourceAttribution === "ai" && paragraph.sourceRefs.length === 0) {
      throw new Error("AI 整理的段落必须保留至少一份素材依据");
    }
  }
}

export const mockApi = {
  async listMaterials(): Promise<Material[]> {
    return wait(getMaterials());
  },

  async saveMaterial(material: Material): Promise<Material> {
    const materials = getMaterials();
    const existing = materials.find((item) => item.id === material.id);
    if (existing) {
      if (!sameMaterial(existing, material)) throw idempotencyConflict("素材");
      return wait(existing);
    }
    const next = [material, ...materials];
    saveMaterials(next);
    return wait(material);
  },

  async deleteMaterial(id: string): Promise<void> {
    saveMaterials(getMaterials().filter((item) => item.id !== id));
    await wait(undefined, 120);
  },

  async listLetters(): Promise<LetterSummary[]> {
    const summaries = getLetters()
      .map((letter) => ({
        id: letter.id,
        status: letter.status,
        intent: letter.intent,
        createdAt: letter.createdAt,
        updatedAt: letter.updatedAt,
        title: letter.draft?.title || `写给${letter.intent.recipient}的一封信`,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return wait(summaries, 160);
  },

  async createLetter(input: CreateLetterInput): Promise<Letter> {
    const now = new Date().toISOString();
    const letter: Letter = {
      id: createId("letter"),
      status: "MATERIALS_READY",
      materialIds: input.materialIds,
      intent: input.intent,
      replies: [],
      createdAt: now,
      updatedAt: now,
    };
    saveLetters([letter, ...getLetters()]);
    return wait(letter);
  },

  async getLetter(id: string): Promise<Letter> {
    return wait(requireLetter(id), 160);
  },

  async getReader(id: string, shareToken?: string): Promise<ReaderLetter> {
    const letter = requireLetter(id);
    if (!letter.draft || !letter.confirmedAt || !letter.shareToken) {
      throw new Error("家书尚未确认发布");
    }
    if (shareToken && shareToken !== letter.shareToken) {
      throw new Error("阅读链接已失效，请重新确认家书");
    }
    const sources = getMaterials()
      .filter((material) => letter.materialIds.includes(material.id))
      .map((material) => ({
        id: material.id,
        type: material.type,
        name: material.name,
        mediaUrl: material.localPath,
        durationSeconds: material.durationSeconds,
      }));
    return wait(
      {
        id: letter.id,
        recipient: letter.intent.recipient,
        draft: letter.draft,
        sources,
        replies: letter.replies,
        publishedAt: letter.confirmedAt,
        shareToken: letter.shareToken,
      },
      160,
    );
  },

  async generateLetter(id: string): Promise<Letter> {
    const current = requireLetter(id);
    updateLetter({ ...current, status: "GENERATING", updatedAt: new Date().toISOString() });
    const generated: Letter = {
      ...current,
      status: "EDITING",
      draft: generateDraft(current),
      updatedAt: new Date().toISOString(),
    };
    return wait(updateLetter(generated), 850);
  },

  async updateDraft(id: string, draft: LetterDraft): Promise<Letter> {
    const current = requireLetter(id);
    const normalizedDraft = normalizeDraftAttribution(current.draft, draft);
    return wait(
      updateLetter({
        ...current,
        draft: normalizedDraft,
        status: "EDITING",
        updatedAt: new Date().toISOString(),
      }),
      180,
    );
  },

  async confirmLetter(id: string, draft: LetterDraft): Promise<Letter> {
    const current = requireLetter(id);
    const normalizedDraft = normalizeDraftAttribution(current.draft, draft);
    assertDraftReadyForConfirmation(normalizedDraft);
    const now = new Date().toISOString();
    return wait(
      updateLetter({
        ...current,
        draft: normalizedDraft,
        status: "CONFIRMED",
        confirmedAt: now,
        shareToken: createId("share"),
        updatedAt: now,
      }),
      280,
    );
  },

  async addReply(
    id: string,
    text: string,
    shareToken?: string,
    requestKey?: string,
  ): Promise<Reply> {
    const current = requireLetter(id);
    if (shareToken && shareToken !== current.shareToken) {
      throw new Error("阅读链接已失效，请重新确认家书");
    }
    const normalizedText = text.normalize("NFKC").trim();
    const requestFingerprint = replyFingerprint(normalizedText);
    const lookupKey = requestKey ? JSON.stringify([id, requestKey]) : "";
    if (lookupKey) {
      const existingRequest = replyRequestsByKey.get(lookupKey);
      if (existingRequest) {
        if (existingRequest.requestFingerprint !== requestFingerprint) {
          throw idempotencyConflict("回复");
        }
        const existingReply = current.replies.find(
          (reply) => reply.id === existingRequest.replyId,
        );
        if (existingReply) return wait(existingReply);
        replyRequestsByKey.delete(lookupKey);
      }
    }
    const reply = {
      id: createId("reply"),
      text: normalizedText,
      authorName: "家人",
      authorVerified: false,
      createdAt: new Date().toISOString(),
    };
    updateLetter({
      ...current,
      replies: [...current.replies, reply],
      updatedAt: reply.createdAt,
    });
    if (lookupKey) {
      replyRequestsByKey.set(lookupKey, {
        requestFingerprint,
        replyId: reply.id,
      });
    }
    return wait(reply);
  },
};
