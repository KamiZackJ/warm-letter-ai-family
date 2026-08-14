import { api } from "../../services/api";
import type { ReaderLetter, ReaderSource, Reply } from "../../types/domain";
import { formatDate } from "../../utils/date";

type DisplayReply = Reply & { dateLabel: string };
type DisplaySource = ReaderSource & { typeLabel: string };

const TYPE_LABELS: Record<string, string> = {
  photo: "生活照片",
  screenshot: "聊天截图",
  voice: "语音",
  text: "文字记录",
};

const audio = wx.createInnerAudioContext();

Page({
  data: {
    letterId: "",
    shareToken: "",
    letter: null as ReaderLetter | null,
    materials: [] as DisplaySource[],
    imageMaterials: [] as DisplaySource[],
    voiceMaterials: [] as DisplaySource[],
    replies: [] as DisplayReply[],
    confirmedDate: "",
    replyText: "",
    fontMode: "large" as "normal" | "large" | "extra",
    playingId: "",
    loading: true,
    sendingReply: false,
  },

  async onLoad(options: { id?: string; token?: string }) {
    if (!options.id) {
      wx.showToast({ title: "缺少家书编号", icon: "none" });
      return;
    }
    this.setData({ letterId: options.id, shareToken: options.token || "" });
    audio.onEnded(() => this.setData({ playingId: "" }));
    audio.onError(() => {
      this.setData({ playingId: "" });
      wx.showToast({ title: "语音暂时无法播放", icon: "none" });
    });
    await this.loadLetter();
  },

  onUnload() {
    audio.stop();
  },

  async loadLetter() {
    try {
      const letter = await api.getReader(
        this.data.letterId,
        this.data.shareToken || undefined,
      );
      const materials = letter.sources.map((item) => ({
        ...item,
        typeLabel: TYPE_LABELS[item.type] || "素材",
      }));
      this.setData({
        letter,
        materials,
        shareToken: letter.shareToken,
        confirmedDate: letter.publishedAt.slice(0, 10),
        imageMaterials: materials.filter(
          (item) => item.type === "photo" || item.type === "screenshot",
        ),
        voiceMaterials: materials.filter((item) => item.type === "voice"),
        replies: letter.replies.map((reply) => ({
          ...reply,
          dateLabel: formatDate(reply.createdAt),
        })),
      });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  chooseFont(event: {
    currentTarget: { dataset: { value: "normal" | "large" | "extra" } };
  }) {
    this.setData({ fontMode: event.currentTarget.dataset.value });
  },

  previewImage(event: { currentTarget: { dataset: { path?: string } } }) {
    const path = event.currentTarget.dataset.path;
    if (!path) {
      wx.showToast({ title: "演示素材不含真实图片", icon: "none" });
      return;
    }
    const urls = this.data.imageMaterials
      .map((item) => item.mediaUrl)
      .filter((item): item is string => Boolean(item));
    wx.previewImage({ current: path, urls });
  },

  playVoice(event: { currentTarget: { dataset: { id: string; path?: string } } }) {
    const { id, path } = event.currentTarget.dataset;
    if (!path) {
      wx.showToast({ title: "演示语音仅展示播放入口", icon: "none" });
      return;
    }
    if (this.data.playingId === id) {
      audio.pause();
      this.setData({ playingId: "" });
      return;
    }
    audio.src = path;
    audio.play();
    this.setData({ playingId: id });
  },

  updateReply(event: { detail: { value: string } }) {
    this.setData({ replyText: event.detail.value });
  },

  async sendReply() {
    const text = this.data.replyText.trim();
    if (!text) {
      wx.showToast({ title: "写一句回复吧", icon: "none" });
      return;
    }
    this.setData({ sendingReply: true });
    try {
      const letter = await api.addReply(
        this.data.letterId,
        text,
        this.data.shareToken || undefined,
      );
      this.setData({
        letter,
        replyText: "",
        replies: letter.replies.map((reply) => ({
          ...reply,
          dateLabel: formatDate(reply.createdAt),
        })),
      });
      wx.showToast({ title: "回复已送达", icon: "success" });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ sendingReply: false });
    }
  },

  onShareAppMessage() {
    const token = this.data.shareToken
      ? `&token=${encodeURIComponent(this.data.shareToken)}`
      : "";
    return {
      title: this.data.letter?.draft?.title || "一封暖笺家书",
      path: `/pages/reader/index?id=${this.data.letterId}${token}`,
    };
  },
});
