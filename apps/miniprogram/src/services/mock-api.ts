import type {
  CreateLetterInput,
  DraftParagraph,
  Letter,
  LetterDraft,
  LetterSummary,
  Material,
  ReaderLetter,
} from "../types/domain";
import { createId } from "../utils/id";
import {
  getLetters,
  getMaterials,
  saveLetters,
  saveMaterials,
} from "../utils/storage";

const wait = <T>(value: T, delay = 280): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), delay));

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
    sourceRefs: textMaterial ? [textMaterial.id] : [],
  });

  if (visualMaterials.length > 0) {
    paragraphs.push({
      id: createId("paragraph"),
      text: `我还挑了${visualMaterials.length}张最近的画面。它们不是什么大事，却很适合留在这封信里，等我们见面时再一起细看。`,
      sourceRefs: visualMaterials.map((item) => item.id),
    });
  }

  if (voiceMaterial) {
    paragraphs.push({
      id: createId("paragraph"),
      text: "有些话写下来还是不够，我也留了一段声音。希望你读到这里时，能像平常聊天一样听见我的语气。",
      sourceRefs: [voiceMaterial.id],
    });
  }

  if (textMaterial?.text && textMaterial.text.trim() !== letter.intent.message.trim()) {
    paragraphs.push({
      id: createId("paragraph"),
      text: textMaterial.text.trim(),
      sourceRefs: [textMaterial.id],
    });
  }

  if (letter.intent.focus.trim()) {
    paragraphs.push({
      id: createId("paragraph"),
      text: `最想告诉你的是：${letter.intent.focus.trim()}`,
      sourceRefs: materials.map((item) => item.id).slice(0, 2),
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

export const mockApi = {
  async listMaterials(): Promise<Material[]> {
    return wait(getMaterials());
  },

  async saveMaterial(material: Material): Promise<Material> {
    const next = [material, ...getMaterials().filter((item) => item.id !== material.id)];
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
    return wait(
      updateLetter({
        ...current,
        draft,
        status: "EDITING",
        updatedAt: new Date().toISOString(),
      }),
      180,
    );
  },

  async confirmLetter(id: string, draft: LetterDraft): Promise<Letter> {
    const current = requireLetter(id);
    const now = new Date().toISOString();
    return wait(
      updateLetter({
        ...current,
        draft,
        status: "CONFIRMED",
        confirmedAt: now,
        shareToken: createId("share"),
        updatedAt: now,
      }),
      280,
    );
  },

  async addReply(id: string, text: string, shareToken?: string): Promise<ReaderLetter> {
    const current = requireLetter(id);
    if (shareToken && shareToken !== current.shareToken) {
      throw new Error("阅读链接已失效，请重新确认家书");
    }
    const reply = { id: createId("reply"), text, createdAt: new Date().toISOString() };
    updateLetter({
      ...current,
      replies: [...current.replies, reply],
      updatedAt: reply.createdAt,
    });
    return mockApi.getReader(id, shareToken);
  },
};
