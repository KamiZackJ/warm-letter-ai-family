import { api } from "../../services/api";
import { environmentView } from "../../config/env";
import type { LetterDraft, Material } from "../../types/domain";
import { createId } from "../../utils/id";
import { clearPendingGeneration } from "../../utils/storage";
import {
  draftNeedsSourceReview,
  markParagraphTextEdited,
  markParagraphUserSupplied,
  paragraphAttributionHint,
  paragraphAttributionLabel,
  setParagraphSources,
} from "../../utils/paragraph-attribution";

const emptyDraft = (): LetterDraft => ({
  title: "",
  salutation: "",
  paragraphs: [],
  closing: "",
  signature: "",
});

type ParagraphSourceChoice = {
  id: string;
  name: string;
  selected: boolean;
};

type ParagraphAttributionView = {
  id: string;
  label: string;
  hint: string;
  needsReview: boolean;
  sourcePickerOpen: boolean;
  sourceChoices: ParagraphSourceChoice[];
};

function buildParagraphAttributionViews(
  draft: LetterDraft,
  materials: Material[],
  sourcePickerOpenIds: string[],
): ParagraphAttributionView[] {
  const openIds = new Set(sourcePickerOpenIds);
  return draft.paragraphs.map((paragraph) => ({
    id: paragraph.id,
    label: paragraphAttributionLabel(paragraph),
    hint: paragraphAttributionHint(paragraph),
    needsReview: paragraph.sourceAttribution === "needs-review",
    sourcePickerOpen: openIds.has(paragraph.id),
    sourceChoices: materials.map((material) => ({
      id: material.id,
      name: material.name,
      selected: paragraph.sourceRefs.includes(material.id),
    })),
  }));
}

function confirmDialog(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: "请确认",
      content,
      confirmColor: "#245A4B",
      success: (result: { confirm: boolean }) => resolve(result.confirm),
      fail: () => resolve(false),
    });
  });
}

Page({
  data: {
    ...environmentView,
    letterId: "",
    draft: emptyDraft(),
    sourceMaterials: [] as Material[],
    sourcePickerOpenIds: [] as string[],
    paragraphAttributionViews: [] as ParagraphAttributionView[],
    loading: true,
    generationPending: false,
    errorMessage: "",
    saving: false,
  },

  async onLoad(options: { id?: string }) {
    if (!options.id) {
      this.setData({ loading: false, errorMessage: "缺少家书编号，请返回首页重新选择" });
      return;
    }
    this.setData({ letterId: options.id });
    await this.loadLetter();
  },

  async loadLetter() {
    this.setData({ loading: true, errorMessage: "" });
    try {
      let letter = await api.getLetter(this.data.letterId);
      if (
        !letter.draft &&
        (letter.status === "GENERATING" || letter.status === "MATERIALS_READY")
      ) {
        this.setData({ generationPending: true });
        letter = await api.generateLetter(this.data.letterId);
      }
      if (!letter.draft) {
        throw new Error("草稿还没有生成完成");
      }
      const materials = await api.listMaterials();
      const sourceMaterials = materials.filter((material) => letter.materialIds.includes(material.id));
      clearPendingGeneration(this.data.letterId);
      this.setData({
        draft: letter.draft,
        sourceMaterials,
        sourcePickerOpenIds: [],
        paragraphAttributionViews: buildParagraphAttributionViews(
          letter.draft,
          sourceMaterials,
          [],
        ),
        errorMessage: "",
      });
    } catch (error) {
      const message = (error as Error).message || "暂时无法打开草稿";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ loading: false, generationPending: false });
    }
  },

  updateField(event: {
    currentTarget: { dataset: { field: "title" | "salutation" | "closing" | "signature" } };
    detail: { value: string };
  }) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [`draft.${field}`]: event.detail.value });
  },

  updateParagraph(event: {
    currentTarget: { dataset: { index: number } };
    detail: { value: string };
  }) {
    const index = Number(event.currentTarget.dataset.index);
    const paragraph = this.data.draft.paragraphs[index];
    if (!paragraph) return;
    const paragraphs = [...this.data.draft.paragraphs];
    paragraphs[index] = markParagraphTextEdited(paragraph, event.detail.value);
    const draft = { ...this.data.draft, paragraphs };
    const sourcePickerOpenIds = Array.from(
      new Set([...this.data.sourcePickerOpenIds, paragraph.id]),
    );
    this.setData({
      draft,
      sourcePickerOpenIds,
      paragraphAttributionViews: buildParagraphAttributionViews(
        draft,
        this.data.sourceMaterials,
        sourcePickerOpenIds,
      ),
    });
  },

  addParagraph() {
    const paragraph = {
      id: createId("paragraph"),
      text: "",
      sourceRefs: [],
      sourceAttribution: "needs-review" as const,
    };
    const draft = {
      ...this.data.draft,
      paragraphs: [...this.data.draft.paragraphs, paragraph],
    };
    const sourcePickerOpenIds = [...this.data.sourcePickerOpenIds, paragraph.id];
    this.setData({
      draft,
      sourcePickerOpenIds,
      paragraphAttributionViews: buildParagraphAttributionViews(
        draft,
        this.data.sourceMaterials,
        sourcePickerOpenIds,
      ),
    });
  },

  async removeParagraph(event: { currentTarget: { dataset: { index: number } } }) {
    if (this.data.draft.paragraphs.length <= 1) {
      wx.showToast({ title: "至少保留一段正文", icon: "none" });
      return;
    }
    const index = Number(event.currentTarget.dataset.index);
    const confirmed = await confirmDialog("删除这一段文字？删除后仍可重新生成草稿。");
    if (!confirmed) return;
    const removed = this.data.draft.paragraphs[index];
    const draft = {
      ...this.data.draft,
      paragraphs: this.data.draft.paragraphs.filter((_, itemIndex) => itemIndex !== index),
    };
    const sourcePickerOpenIds = removed
      ? this.data.sourcePickerOpenIds.filter((id) => id !== removed.id)
      : this.data.sourcePickerOpenIds;
    this.setData({
      draft,
      sourcePickerOpenIds,
      paragraphAttributionViews: buildParagraphAttributionViews(
        draft,
        this.data.sourceMaterials,
        sourcePickerOpenIds,
      ),
    });
  },

  beginParagraphSourceReview(event: { currentTarget: { dataset: { index: number } } }) {
    const paragraph = this.data.draft.paragraphs[Number(event.currentTarget.dataset.index)];
    if (!paragraph) return;
    const sourcePickerOpenIds = Array.from(
      new Set([...this.data.sourcePickerOpenIds, paragraph.id]),
    );
    this.setData({
      sourcePickerOpenIds,
      paragraphAttributionViews: buildParagraphAttributionViews(
        this.data.draft,
        this.data.sourceMaterials,
        sourcePickerOpenIds,
      ),
    });
  },

  updateParagraphSources(event: {
    currentTarget: { dataset: { index: number } };
    detail: { value: string[] };
  }) {
    const index = Number(event.currentTarget.dataset.index);
    const paragraph = this.data.draft.paragraphs[index];
    if (!paragraph) return;
    const paragraphs = [...this.data.draft.paragraphs];
    paragraphs[index] = setParagraphSources(paragraph, event.detail.value);
    const draft = { ...this.data.draft, paragraphs };
    this.setData({
      draft,
      paragraphAttributionViews: buildParagraphAttributionViews(
        draft,
        this.data.sourceMaterials,
        this.data.sourcePickerOpenIds,
      ),
    });
  },

  markParagraphUserSupplied(event: { currentTarget: { dataset: { index: number } } }) {
    const index = Number(event.currentTarget.dataset.index);
    const paragraph = this.data.draft.paragraphs[index];
    if (!paragraph) return;
    const paragraphs = [...this.data.draft.paragraphs];
    paragraphs[index] = markParagraphUserSupplied(paragraph);
    const draft = { ...this.data.draft, paragraphs };
    const sourcePickerOpenIds = this.data.sourcePickerOpenIds.filter((id) => id !== paragraph.id);
    this.setData({
      draft,
      sourcePickerOpenIds,
      paragraphAttributionViews: buildParagraphAttributionViews(
        draft,
        this.data.sourceMaterials,
        sourcePickerOpenIds,
      ),
    });
  },

  validateDraft(requireResolvedSources = false): boolean {
    const hasEmptyParagraph = this.data.draft.paragraphs.some(
      (paragraph) => !paragraph.text.trim(),
    );
    if (!this.data.draft.title.trim() || hasEmptyParagraph) {
      wx.showToast({ title: "请补全标题和正文", icon: "none" });
      return false;
    }
    if (requireResolvedSources && draftNeedsSourceReview(this.data.draft.paragraphs)) {
      wx.showToast({ title: "请先处理修改段落的内容依据", icon: "none" });
      return false;
    }
    return true;
  },

  async saveDraft(showSuccess = true): Promise<boolean> {
    if (!this.validateDraft()) return false;
    this.setData({ saving: true });
    try {
      await api.updateDraft(this.data.letterId, this.data.draft);
      if (showSuccess) wx.showToast({ title: "草稿已保存", icon: "success" });
      return true;
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
      return false;
    } finally {
      this.setData({ saving: false });
    }
  },

  async regenerate() {
    const confirmed = await confirmDialog("重新生成会覆盖当前修改，是否继续？");
    if (!confirmed) return;
    wx.showLoading({ title: "正在重新整理", mask: true });
    this.setData({ generationPending: true, errorMessage: "" });
    try {
      await api.generateLetter(this.data.letterId);
      await this.loadLetter();
    } catch (error) {
      const message = (error as Error).message || "暂时无法重新生成草稿";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      wx.hideLoading();
      this.setData({ generationPending: false });
    }
  },

  async confirmLetter() {
    if (!this.validateDraft(true)) return;
    const confirmed = await confirmDialog(
      "请确认内容准确且没有不想寄出的信息。确认后将进入家书阅读页。",
    );
    if (!confirmed) return;
    this.setData({ saving: true });
    try {
      await api.confirmLetter(this.data.letterId, this.data.draft);
      wx.redirectTo({ url: `/pages/reader/index?id=${this.data.letterId}` });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },
});
