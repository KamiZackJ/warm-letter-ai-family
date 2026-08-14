import { api } from "../../services/api";
import type { LetterDraft, Material } from "../../types/domain";
import { createId } from "../../utils/id";

const emptyDraft = (): LetterDraft => ({
  title: "",
  salutation: "",
  paragraphs: [],
  closing: "",
  signature: "",
});

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
    letterId: "",
    draft: emptyDraft(),
    paragraphSourceLabels: [] as string[],
    loading: true,
    saving: false,
  },

  async onLoad(options: { id?: string }) {
    if (!options.id) {
      wx.showToast({ title: "缺少家书编号", icon: "none" });
      return;
    }
    this.setData({ letterId: options.id });
    await this.loadLetter();
  },

  async loadLetter() {
    try {
      const [letter, materials] = await Promise.all([
        api.getLetter(this.data.letterId),
        api.listMaterials(),
      ]);
      if (!letter.draft) {
        throw new Error("草稿还没有生成完成");
      }
      const materialMap = new Map<string, Material>(
        materials.map((material) => [material.id, material]),
      );
      const labels = letter.draft.paragraphs.map((paragraph) => {
        const names = paragraph.sourceRefs
          .map((id) => materialMap.get(id)?.name)
          .filter(Boolean);
        return names.length > 0 ? names.join("、") : "由你的创作意图整理";
      });
      this.setData({ draft: letter.draft, paragraphSourceLabels: labels });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ loading: false });
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
    this.setData({ [`draft.paragraphs[${index}].text`]: event.detail.value });
  },

  addParagraph() {
    this.setData({
      "draft.paragraphs": [
        ...this.data.draft.paragraphs,
        { id: createId("paragraph"), text: "", sourceRefs: [] },
      ],
      paragraphSourceLabels: [...this.data.paragraphSourceLabels, "由你手动补充"],
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
    this.setData({
      "draft.paragraphs": this.data.draft.paragraphs.filter((_, itemIndex) => itemIndex !== index),
      paragraphSourceLabels: this.data.paragraphSourceLabels.filter(
        (_, itemIndex) => itemIndex !== index,
      ),
    });
  },

  validateDraft(): boolean {
    const hasEmptyParagraph = this.data.draft.paragraphs.some(
      (paragraph) => !paragraph.text.trim(),
    );
    if (!this.data.draft.title.trim() || hasEmptyParagraph) {
      wx.showToast({ title: "请补全标题和正文", icon: "none" });
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
    try {
      await api.generateLetter(this.data.letterId);
      await this.loadLetter();
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  async confirmLetter() {
    if (!this.validateDraft()) return;
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
