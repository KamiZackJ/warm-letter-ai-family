import { api } from "../../services/api";
import { environmentView } from "../../config/env";
import type { Letter, LetterDraft, Material } from "../../types/domain";
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

type AudioTranscriptView = {
  materialId: string;
  name: string;
  text: string;
  savedText: string;
  confirmed: boolean;
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
    generationError: "",
    audioTranscripts: [] as AudioTranscriptView[],
    audioTranscriptRevisionPending: false,
    audioTranscriptUnsaved: false,
    transcriptSaving: false,
    transcriptError: "",
    errorMessage: "",
    saving: false,
  },

  async onLoad(options: { id?: string }) {
    if (!options.id) {
      this.setData({ loading: false, errorMessage: "家书链接不完整，请返回首页重新打开" });
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
        letter.status === "GENERATING" ||
        (!letter.draft && letter.status === "MATERIALS_READY")
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
      this.applyLetter(letter, sourceMaterials);
    } catch (error) {
      const message = (error as Error).message || "暂时无法打开草稿";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ loading: false, generationPending: false });
    }
  },

  applyLetter(letter: Letter, sourceMaterials: Material[]) {
    if (!letter.draft) throw new Error("草稿还没有生成完成");
    this.setData({
      draft: letter.draft,
      sourceMaterials,
      sourcePickerOpenIds: [],
      paragraphAttributionViews: buildParagraphAttributionViews(letter.draft, sourceMaterials, []),
      audioTranscripts: (letter.audioTranscripts || []).map((item) => ({
        ...item,
        savedText: item.text,
        name: sourceMaterials.find((material) => material.id === item.materialId)?.name || "语音素材",
      })),
      audioTranscriptRevisionPending: Boolean(letter.audioTranscriptRevisionPending),
      audioTranscriptUnsaved: false,
      transcriptError: "",
      generationError: "",
      errorMessage: "",
    });
  },

  updateAudioTranscript(event: {
    currentTarget: { dataset: { materialId: string } };
    detail: { value: string };
  }) {
    if (this.data.transcriptSaving || this.data.generationPending) return;
    const audioTranscripts = this.data.audioTranscripts.map((item) =>
      item.materialId === event.currentTarget.dataset.materialId
        ? { ...item, text: event.detail.value }
        : item,
    );
    this.setData({
      audioTranscripts,
      audioTranscriptUnsaved: audioTranscripts.some((item) => item.text !== item.savedText),
      transcriptError: "",
    });
  },

  async saveTranscriptsAndRegenerate() {
    if (this.data.transcriptSaving || this.data.generationPending || this.data.saving) return;
    if (this.data.audioTranscripts.some((item) => !item.text.trim() || item.text.trim().length > 50_000)) {
      this.setData({ transcriptError: "请填写每段语音文字，每段最多 50000 个字符。" });
      return;
    }
    this.setData({ transcriptSaving: true, transcriptError: "", generationError: "" });
    let transcriptSaveCompleted = false;
    try {
      const confirmed = await confirmDialog("将按你核对后的语音文字重新生成家书，覆盖当前草稿修改，是否继续？");
      if (!confirmed) return;
      const toSave = this.data.audioTranscripts.filter((item) => !item.confirmed || item.text !== item.savedText);
      for (const item of toSave) {
        const saved = await api.updateAudioTranscript(this.data.letterId, item.materialId, item.text.trim());
        const savedTranscript = saved.audioTranscripts?.find((entry) => entry.materialId === item.materialId);
        const savedText = savedTranscript?.text || item.text.trim();
        const audioTranscripts = this.data.audioTranscripts.map((entry) => entry.materialId === item.materialId
          ? { ...entry, text: savedText, savedText, confirmed: true }
          : entry);
        this.setData({
          audioTranscripts,
          audioTranscriptRevisionPending: Boolean(saved.audioTranscriptRevisionPending),
          audioTranscriptUnsaved: audioTranscripts.some((entry) => entry.text !== entry.savedText),
        });
      }
      transcriptSaveCompleted = true;
      this.setData({ generationPending: true });
      const letter = await api.generateLetter(this.data.letterId);
      this.applyLetter(letter, this.data.sourceMaterials);
      clearPendingGeneration(this.data.letterId);
      wx.showToast({ title: "已按核对后的文字生成", icon: "success" });
    } catch (error) {
      const message = (error as Error).message || "暂时无法处理语音文字";
      const recovery = this.data.audioTranscriptRevisionPending || transcriptSaveCompleted
        ? "已保存的语音文字会保留。请继续保存尚未完成的修改，或点击“重新生成家书”。"
        : "语音文字尚未保存，请重试。";
      this.setData({ transcriptError: `${message}。${recovery}` });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ transcriptSaving: false, generationPending: false });
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

  confirmParagraphSources(event: { currentTarget: { dataset: { index: number } } }) {
    const paragraph = this.data.draft.paragraphs[Number(event.currentTarget.dataset.index)];
    if (!paragraph?.sourceRefs.length) {
      wx.showToast({ title: "请先选择支持这段内容的素材", icon: "none" });
      return;
    }
    this.updateParagraphSources({
      currentTarget: event.currentTarget,
      detail: { value: paragraph.sourceRefs },
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
    if (requireResolvedSources && (this.data.audioTranscriptRevisionPending || this.data.audioTranscriptUnsaved)) {
      wx.showToast({ title: "请先保存语音文字并重新生成家书", icon: "none" });
      return false;
    }
    const hasEmptyParagraph = this.data.draft.paragraphs.some(
      (paragraph) => !paragraph.text.trim(),
    );
    if (
      !this.data.draft.title.trim() ||
      !this.data.draft.signature.trim() ||
      hasEmptyParagraph
    ) {
      wx.showToast({ title: "请补全标题、正文和署名", icon: "none" });
      return false;
    }
    if (requireResolvedSources && draftNeedsSourceReview(this.data.draft.paragraphs)) {
      wx.showToast({ title: "请先核对待确认段落的内容依据", icon: "none" });
      return false;
    }
    return true;
  },

  async saveDraft(showSuccess = true): Promise<boolean> {
    if (this.data.saving || this.data.generationPending || this.data.transcriptSaving) return false;
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
    if (this.data.generationPending || this.data.saving || this.data.transcriptSaving) return;
    if (this.data.audioTranscriptUnsaved) {
      this.setData({ transcriptError: "语音文字有未保存的修改，请使用上方“保存并重新生成”。" });
      return;
    }
    this.setData({ generationPending: true, generationError: "" });
    try {
      const confirmed = await confirmDialog("重新生成会覆盖当前修改，是否继续？");
      if (!confirmed) return;
      wx.showLoading({ title: "正在重新整理", mask: true });
      const letter = await api.generateLetter(this.data.letterId);
      this.applyLetter(letter, this.data.sourceMaterials);
      clearPendingGeneration(this.data.letterId);
    } catch (error) {
      const message = (error as Error).message || "暂时无法重新生成草稿";
      this.setData({ generationError: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      wx.hideLoading();
      this.setData({ generationPending: false });
    }
  },

  async previewLetter() {
    if (this.data.saving || this.data.generationPending || this.data.transcriptSaving) return;
    if (!this.validateDraft(true)) return;
    this.setData({ saving: true });
    try {
      await api.updateDraft(this.data.letterId, this.data.draft);
      wx.navigateTo({ url: `/pages/preview/index?id=${this.data.letterId}` });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },
});
