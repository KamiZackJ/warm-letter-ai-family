import { api } from "../../services/api";
import { environment } from "../../config/env";
import type { LetterSummary } from "../../types/domain";
import { formatDate } from "../../utils/date";
import {
  ONBOARDING_STEPS,
  readOnboardingState,
  rememberOnboardingDismissed,
} from "../../utils/onboarding";
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
  onboardingInitialized: false,
  onboardingAutoEligible: false,
  onboardingManuallyOpened: false,
  onboardingInteracted: false,

  data: {
    recentLetters: [] as DisplayLetter[],
    loading: true,
    loadError: "",
    startingFlow: false,
    guideVisible: false,
    guideStep: 0,
    guideStepCount: ONBOARDING_STEPS.length,
    guideContent: ONBOARDING_STEPS[0] as (typeof ONBOARDING_STEPS)[number],
  },

  async onShow() {
    this.disposed = false;
    this.setData({ startingFlow: false });
    this.prepareOnboarding();
    await this.loadLetters();
  },

  onUnload() {
    this.disposed = true;
    this.loadRequestId += 1;
  },

  prepareOnboarding() {
    if (this.onboardingInitialized) return;
    this.onboardingInitialized = true;
    const state = readOnboardingState();
    this.onboardingAutoEligible = state === "new" && this.data.recentLetters.length === 0;
    this.setData({ guideVisible: this.onboardingAutoEligible });
    if (state === "returning" || this.data.recentLetters.length > 0) {
      rememberOnboardingDismissed();
    }
  },

  settleOnboarding(hasHistory: boolean) {
    if (hasHistory) {
      rememberOnboardingDismissed();
      this.onboardingAutoEligible = false;
      if (!this.onboardingManuallyOpened && !this.onboardingInteracted) {
        this.setData({ guideVisible: false });
      }
      return;
    }
    if (this.onboardingAutoEligible && !this.onboardingManuallyOpened && !this.data.startingFlow) {
      this.setData({ guideVisible: true });
    }
  },

  openGuide() {
    if (this.disposed || this.data.startingFlow) return;
    this.onboardingManuallyOpened = true;
    this.onboardingInteracted = true;
    this.onboardingAutoEligible = false;
    this.showGuideStep(0);
  },

  showGuideStep(step: number) {
    const content = ONBOARDING_STEPS[step];
    if (!content) return;
    this.setData({ guideVisible: true, guideStep: step, guideContent: content }, () => {
      if (this.disposed || !this.data.guideVisible || this.data.guideStep !== step) return;
      try {
        wx.pageScrollTo?.({ selector: `#${content.anchorId}`, duration: 0, fail: () => undefined });
      } catch { /* The inline tip stays usable if scrolling is unavailable. */ }
    });
  },

  nextGuideStep() {
    if (!this.data.guideVisible || this.data.startingFlow) return;
    this.onboardingInteracted = true;
    const next = Math.min(this.data.guideStep + 1, ONBOARDING_STEPS.length - 1);
    this.showGuideStep(next);
  },

  dismissGuide() {
    this.onboardingAutoEligible = false;
    this.onboardingManuallyOpened = false;
    this.onboardingInteracted = true;
    rememberOnboardingDismissed();
    this.setData({ guideVisible: false });
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
      this.settleOnboarding(letters.length > 0);
    } catch (error) {
      if (this.disposed || this.loadRequestId !== requestId) return;
      const message = errorMessage(error);
      this.setData({ loadError: message });
      this.settleOnboarding(this.data.recentLetters.length > 0);
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

  openSettings() {
    wx.navigateTo({ url: "/pages/settings/index" });
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
    this.dismissGuide();
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

  openLetter(event: { currentTarget: { dataset: { id?: string; status?: string } } }) {
    if (this.disposed || this.data.loading || this.data.startingFlow) return;
    const { id: rawId, status } = event.currentTarget.dataset;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) {
      wx.showToast({ title: "家书链接不完整，请重新读取列表", icon: "none" });
      return;
    }
    this.dismissGuide();
    // Owner preview can restore a missing local share token after switching devices.
    // Friend links continue to enter the reader with their existing credential.
    const page = status === "CONFIRMED" || status === "PUBLISHED" ? "preview" : "editor";
    wx.navigateTo({
      url: `/pages/${page}/index?id=${encodeURIComponent(id)}`,
      fail: () => {
        if (!this.disposed) wx.showToast({ title: "暂时无法打开家书，请重试", icon: "none" });
      },
    });
  },
});
