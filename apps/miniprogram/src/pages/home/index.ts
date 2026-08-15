import { api } from "../../services/api";
import type { LetterSummary } from "../../types/domain";
import { formatDate } from "../../utils/date";
import { clearPendingGeneration, saveCurrentMaterialIds } from "../../utils/storage";

type DisplayLetter = LetterSummary & {
  statusLabel: string;
  dateLabel: string;
};

const STATUS_LABELS: Record<string, string> = {
  MATERIALS_READY: "待生成",
  GENERATING: "生成中",
  EDITING: "待确认",
  CONFIRMED: "已确认",
  PUBLISHED: "已寄出",
};

Page({
  data: {
    recentLetters: [] as DisplayLetter[],
    loading: true,
  },

  async onShow() {
    this.setData({ loading: true });
    try {
      const letters = await api.listLetters();
      this.setData({
        recentLetters: letters.slice(0, 3).map((letter) => ({
          ...letter,
          statusLabel: STATUS_LABELS[letter.status] || "草稿",
          dateLabel: formatDate(letter.updatedAt),
        })),
      });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  startLetter() {
    clearPendingGeneration();
    saveCurrentMaterialIds([]);
    wx.navigateTo({ url: "/pages/materials/index" });
  },

  startDemo() {
    clearPendingGeneration();
    saveCurrentMaterialIds([]);
    wx.navigateTo({ url: "/pages/materials/index?demo=1" });
  },

  openLetter(event: { currentTarget: { dataset: { id: string; status: string } } }) {
    const { id, status } = event.currentTarget.dataset;
    const page = status === "CONFIRMED" || status === "PUBLISHED" ? "reader" : "editor";
    wx.navigateTo({ url: `/pages/${page}/index?id=${id}` });
  },
});
