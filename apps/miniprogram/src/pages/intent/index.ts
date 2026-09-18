import { api } from "../../services/api";
import { environment, environmentView } from "../../config/env";
import { resolveDemoRequest } from "../../config/runtime-environment";
import {
  GenerationJobFailedError,
  GenerationPollingTimeoutError,
} from "../../services/generation-polling";
import type { LetterLength, Tone } from "../../types/domain";
import {
  clearPendingGeneration,
  getCurrentMaterialIds,
  getPendingGeneration,
  savePendingGeneration,
} from "../../utils/storage";

export type GenerationStage = {
  label: string;
  hint: string;
  progress: number;
};

export function generationStageForElapsedSeconds(elapsedSeconds: number): GenerationStage {
  if (elapsedSeconds < 12) {
    return {
      label: "正在准备素材",
      hint: "正在连接暖笺服务，稍后会进入图片和语音理解。",
      progress: 12,
    };
  }
  if (elapsedSeconds < 75) {
    return {
      label: "正在理解图片和语音",
      hint: "只读取你主动选择的素材，不会扫描相册或聊天记录。",
      progress: Math.min(48, 12 + Math.floor((elapsedSeconds - 12) / 2)),
    };
  }
  if (elapsedSeconds < 150) {
    return {
      label: "正在整理家书",
      hint: "AI 正在组织文字并逐段核对素材依据。",
      progress: Math.min(78, 48 + Math.floor((elapsedSeconds - 75) / 3)),
    };
  }
  return {
    label: "还需要一点时间",
    hint: "较大的图片或语音可能需要更久；离开后可从最近家书继续查看。",
    progress: 86,
  };
}

Page({
  disposed: false,
  generationTimer: undefined as ReturnType<typeof setInterval> | undefined,
  generationStartedAt: 0,

  data: {
    ...environmentView,
    recipient: "",
    message: "",
    tone: "warm" as Tone,
    length: "medium" as LetterLength,
    focus: "",
    exclusions: "",
    generating: false,
    generationTimedOut: false,
    generationElapsedSeconds: 0,
    generationProgress: 8,
    generationStageLabel: "正在准备素材",
    generationStageHint: "正在连接暖笺服务，稍后会进入图片和语音理解。",
  },

  onLoad(options: { demo?: string }) {
    this.disposed = false;
    let demoMode = false;
    try {
      demoMode = resolveDemoRequest(options.demo, environment.demoEnabled);
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
      wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    if (demoMode) {
      this.setData({
        recipient: "妈妈",
        message: "告诉妈妈我最近虽然工作忙，但生活得很好，也学会做她常做的菜。",
        focus: "让她放心，也谢谢她一直惦记我。",
        exclusions: "不要提具体收入和公司名称。",
      });
    }
  },

  onUnload() {
    this.disposed = true;
    this.stopGenerationProgress();
  },

  startGenerationProgress() {
    this.stopGenerationProgress();
    this.generationStartedAt = Date.now();
    const update = () => {
      if (this.disposed) return;
      const elapsedSeconds = Math.floor((Date.now() - this.generationStartedAt) / 1000);
      const stage = generationStageForElapsedSeconds(elapsedSeconds);
      this.setData({
        generationElapsedSeconds: elapsedSeconds,
        generationProgress: stage.progress,
        generationStageLabel: stage.label,
        generationStageHint: stage.hint,
      });
    };
    update();
    this.generationTimer = setInterval(update, 1000);
  },

  stopGenerationProgress() {
    if (this.generationTimer !== undefined) {
      clearInterval(this.generationTimer);
      this.generationTimer = undefined;
    }
  },

  continueLater() {
    if (!this.data.generating && !this.data.generationTimedOut) return;
    wx.reLaunch({ url: "/pages/home/index" });
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
    this.setData({ generating: true, generationTimedOut: false });
    this.startGenerationProgress();
    const intent = {
      recipient: this.data.recipient.trim(),
      message: this.data.message.trim(),
      tone: this.data.tone,
      length: this.data.length,
      focus: this.data.focus.trim(),
      exclusions: this.data.exclusions.trim(),
    };
    const fingerprint = JSON.stringify({ materialIds, intent });
    const pending = getPendingGeneration();
    let letterId = pending?.fingerprint === fingerprint ? pending.letterId : undefined;
    try {
      if (!letterId) {
        const letter = await api.createLetter({ materialIds, intent });
        letterId = letter.id;
        savePendingGeneration({ letterId, fingerprint });
      }
      await api.generateLetter(letterId);
      clearPendingGeneration(letterId);
      if (!this.disposed) wx.redirectTo({ url: `/pages/editor/index?id=${letterId}` });
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof GenerationPollingTimeoutError) {
        this.setData({
          generationTimedOut: true,
          generationProgress: 90,
          generationStageLabel: "已转到后台整理",
          generationStageHint: "家书仍在后台生成，不需要重复提交。请回首页，在“最近家书”中打开。",
        });
        wx.showToast({ title: "任务已转到后台，请稍后从最近家书查看", icon: "none" });
      } else {
        wx.showToast({ title: (error as Error).message, icon: "none" });
      }
      if (
        letterId &&
        !(error instanceof GenerationJobFailedError) &&
        !(error instanceof GenerationPollingTimeoutError)
      ) {
        wx.redirectTo({ url: `/pages/editor/index?id=${letterId}` });
      }
    } finally {
      this.stopGenerationProgress();
      if (!this.disposed) this.setData({ generating: false });
    }
  },
});
