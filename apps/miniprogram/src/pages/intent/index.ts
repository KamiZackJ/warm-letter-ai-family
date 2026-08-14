import { api } from "../../services/api";
import type { LetterLength, Tone } from "../../types/domain";
import { getCurrentMaterialIds } from "../../utils/storage";

Page({
  data: {
    recipient: "",
    message: "",
    tone: "warm" as Tone,
    length: "medium" as LetterLength,
    focus: "",
    exclusions: "",
    generating: false,
  },

  onLoad(options: { demo?: string }) {
    if (options.demo === "1") {
      this.setData({
        recipient: "妈妈",
        message: "告诉妈妈我最近虽然工作忙，但生活得很好，也学会做她常做的菜。",
        focus: "让她放心，也谢谢她一直惦记我。",
        exclusions: "不要提具体收入和公司名称。",
      });
    }
  },

  updateRecipient(event: { detail: { value: string } }) {
    this.setData({ recipient: event.detail.value });
  },

  updateMessage(event: { detail: { value: string } }) {
    this.setData({ message: event.detail.value });
  },

  updateFocus(event: { detail: { value: string } }) {
    this.setData({ focus: event.detail.value });
  },

  updateExclusions(event: { detail: { value: string } }) {
    this.setData({ exclusions: event.detail.value });
  },

  chooseTone(event: { currentTarget: { dataset: { value: Tone } } }) {
    this.setData({ tone: event.currentTarget.dataset.value });
  },

  chooseLength(event: { currentTarget: { dataset: { value: LetterLength } } }) {
    this.setData({ length: event.currentTarget.dataset.value });
  },

  async generate() {
    if (!this.data.recipient.trim() || !this.data.message.trim()) {
      wx.showToast({ title: "请填写收信人和想说的话", icon: "none" });
      return;
    }
    const materialIds = getCurrentMaterialIds();
    if (materialIds.length === 0) {
      wx.showToast({ title: "请先添加素材", icon: "none" });
      return;
    }
    this.setData({ generating: true });
    wx.showLoading({ title: "正在整理家书", mask: true });
    try {
      const letter = await api.createLetter({
        materialIds,
        intent: {
          recipient: this.data.recipient.trim(),
          message: this.data.message.trim(),
          tone: this.data.tone,
          length: this.data.length,
          focus: this.data.focus.trim(),
          exclusions: this.data.exclusions.trim(),
        },
      });
      await api.generateLetter(letter.id);
      wx.redirectTo({ url: `/pages/editor/index?id=${letter.id}` });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      wx.hideLoading();
      this.setData({ generating: false });
    }
  },
});
