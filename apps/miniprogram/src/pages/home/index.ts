import { api } from "../../services/api";
import { environment, environmentView } from "../../config/env";
import type { LetterSummary } from "../../types/domain";
import { formatDate } from "../../utils/date";
import {
  beginCurrentMaterialSelection,
  clearPendingGeneration,
  getCurrentMaterialSelection,
  getPendingGeneration,
  restoreCurrentMaterialSelection,
  savePendingGeneration,
} from "../../utils/storage";

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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "errMsg" in error &&
    typeof error.errMsg === "string" &&
    error.errMsg
  ) {
    return error.errMsg;
  }
  return "暂时无法读取最近家书";
}

Page({
  disposed: false,
  loadRequestId: 0,

  data: {
    ...environmentView,
    recentLetters: [] as DisplayLetter[],
    loading: true,
    loadError: "",
    startingFlow: false,
  },

  async onShow() {
    this.disposed = false;
    this.setData({ startingFlow: false });
    await this.loadLetters();
  },

  onUnload() {
    this.disposed = true;
    this.loadRequestId += 1;
  },

  async loadLetters() {
    const requestId = this.loadRequestId + 1;
    this.loadRequestId = requestId;
    this.setData({ loading: true });
    try {
      const letters = await api.listLetters();
      if (this.disposed || this.loadRequestId !== requestId) return;
      this.setData({
        recentLetters: letters.slice(0, 3).map((letter) => ({
          ...letter,
          statusLabel: STATUS_LABELS[letter.status] || "草稿",
          dateLabel: formatDate(letter.updatedAt),
        })),
        loadError: "",
      });
    } catch (error) {
      if (this.disposed || this.loadRequestId !== requestId) return;
      const message = errorMessage(error);
      this.setData({ loadError: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      if (!this.disposed && this.loadRequestId === requestId) {
        this.setData({ loading: false });
      }
    }
  },

  async retryLetters() {
    if (this.data.loading) return;
    await this.loadLetters();
  },

  startLetter() {
    this.startMaterialFlow(false);
  },

  startDemo() {
    if (!environment.demoEnabled) {
      wx.showToast({ title: "当前环境不提供演示入口", icon: "none" });
      return;
    }
    this.startMaterialFlow(true);
  },

  startMaterialFlow(demo: boolean) {
    if (this.disposed || this.data.startingFlow) return;
    this.setData({ startingFlow: true });
    let previousPendingGeneration: ReturnType<typeof getPendingGeneration> = undefined;
    let canRestorePendingGeneration = false;
    try {
      const previousSelection = getCurrentMaterialSelection();
      previousPendingGeneration = getPendingGeneration();
      canRestorePendingGeneration = true;
      clearPendingGeneration();
      const sessionId = beginCurrentMaterialSelection();

      const rollbackNavigation = () => {
        try {
          const restored = restoreCurrentMaterialSelection(sessionId, previousSelection);
          if (restored) savePendingGeneration(previousPendingGeneration);
        } catch {
          // The navigation failed; keep the action unlocked even if local rollback also fails.
        } finally {
          if (!this.disposed) this.setData({ startingFlow: false });
        }
        wx.showToast({ title: "暂时无法打开素材页，请重试", icon: "none" });
      };
      const query = demo
        ? `session=${encodeURIComponent(sessionId)}&demo=1`
        : `session=${encodeURIComponent(sessionId)}`;
      try {
        wx.navigateTo({
          url: `/pages/materials/index?${query}`,
          fail: rollbackNavigation,
        });
      } catch {
        rollbackNavigation();
      }
    } catch {
      try {
        if (canRestorePendingGeneration) savePendingGeneration(previousPendingGeneration);
      } catch {
        // The start action already failed; the visible retry remains the recovery path.
      }
      if (!this.disposed) this.setData({ startingFlow: false });
      wx.showToast({ title: "暂时无法开始新家书，请重试", icon: "none" });
    }
  },

  openLetter(event: { currentTarget: { dataset: { id: string; status: string } } }) {
    const { id, status } = event.currentTarget.dataset;
    const page = status === "CONFIRMED" || status === "PUBLISHED" ? "reader" : "editor";
    wx.navigateTo({ url: `/pages/${page}/index?id=${id}` });
  },
});
