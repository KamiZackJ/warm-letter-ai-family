import { environmentView } from "../../config/env";
import { api } from "../../services/api";
import type { Letter, Material, SpeechCatalog } from "../../types/domain";
import { draftNeedsSourceReview } from "../../utils/paragraph-attribution";

type PreviewAudioContext = {
  src: string;
  play(): void;
  pause(): void;
  stop(): void;
  destroy?(): void;
  onEnded(callback: () => void): void;
  onError(callback: () => void): void;
};

const emptySpeechCatalog: SpeechCatalog = { available: false, voices: [] };

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
  disposed: false,
  audioContext: null as PreviewAudioContext | null,
  generatedFilePath: "",

  data: {
    ...environmentView,
    letterId: "",
    letter: null as Letter | null,
    photos: [] as Material[],
    loading: true,
    loadError: "",
    regenerating: false,
    confirming: false,
    shareReady: false,
    shareToken: "",
    speechCatalog: emptySpeechCatalog,
    selectedVoiceIndex: 0,
    speechLoading: false,
    speechPath: "",
    speechPlaying: false,
    speechError: "",
  },

  async onLoad(options: { id?: string }) {
    this.disposed = false;
    this.setupAudio();
    wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
    if (!options.id) {
      this.setData({ loading: false, loadError: "缺少家书编号，请返回重新预览。" });
      return;
    }
    this.setData({ letterId: options.id });
    await this.loadPreview();
  },

  onUnload() {
    this.disposed = true;
    this.teardownAudio();
    this.removeGeneratedFile();
  },

  setupAudio() {
    this.teardownAudio();
    if (this.disposed) return;
    const audioContext = wx.createInnerAudioContext() as PreviewAudioContext;
    audioContext.onEnded(() => {
      if (!this.disposed) this.setData({ speechPlaying: false });
    });
    audioContext.onError(() => {
      if (!this.disposed) {
        this.setData({
          speechPlaying: false,
          speechError: "朗读暂时无法播放，请重新生成。",
        });
      }
    });
    this.audioContext = audioContext;
  },

  teardownAudio() {
    this.audioContext?.stop();
    this.audioContext?.destroy?.();
    this.audioContext = null;
  },

  removeGeneratedFile() {
    const filePath = this.generatedFilePath;
    this.generatedFilePath = "";
    if (!filePath || !filePath.startsWith(`${wx.env.USER_DATA_PATH}/warm-letter-narration-`)) {
      return;
    }
    wx.getFileSystemManager().unlink({ filePath, fail: () => undefined });
  },

  async loadPreview() {
    this.setData({ loading: true, loadError: "" });
    try {
      const [loadedLetter, materials, speechCatalog] = await Promise.all([
        api.getLetter(this.data.letterId),
        api.listMaterials(),
        api.getSpeechCatalog().catch(() => emptySpeechCatalog),
      ]);
      let letter = loadedLetter;
      if (
        (letter.status === "PUBLISHED" || letter.status === "CONFIRMED") &&
        !letter.shareToken
      ) {
        letter = await api.reissueShare(this.data.letterId);
      }
      if (!letter.draft) throw new Error("家书草稿还没有生成完成");
      if (this.disposed) return;
      if (letter.status === "EDITING" && (
        letter.audioTranscriptRevisionPending || draftNeedsSourceReview(letter.draft.paragraphs)
      )) {
        wx.showToast({ title: "请先核对草稿内容依据", icon: "none" });
        wx.redirectTo({ url: `/pages/editor/index?id=${encodeURIComponent(this.data.letterId)}` });
        return;
      }
      const materialIds = new Set(letter.materialIds);
      this.setData({
        letter,
        photos: materials.filter(
          (material) =>
            materialIds.has(material.id) &&
            (material.type === "photo" || material.type === "screenshot") &&
            Boolean(material.localPath),
        ),
        speechCatalog,
        selectedVoiceIndex: 0,
        shareReady: Boolean(letter.shareToken),
        shareToken: letter.shareToken || "",
        loadError: "",
      });
      if (letter.shareToken) wx.showShareMenu?.({ menus: ["shareAppMessage"] });
    } catch (error) {
      if (!this.disposed) {
        this.setData({ loadError: (error as Error).message || "家书预览暂时无法打开" });
      }
    } finally {
      if (!this.disposed) this.setData({ loading: false });
    }
  },

  retryLoad() {
    void this.loadPreview();
  },

  editLetter() {
    wx.navigateBack({
      fail: () =>
        wx.redirectTo({ url: `/pages/editor/index?id=${encodeURIComponent(this.data.letterId)}` }),
    });
  },

  async regenerate() {
    if (this.data.regenerating || this.data.shareReady) return;
    const confirmed = await confirmDialog("换一版文字会覆盖当前草稿，是否继续？");
    if (!confirmed) return;
    this.setData({ regenerating: true, speechError: "", speechPath: "" });
    this.teardownAudio();
    this.removeGeneratedFile();
    this.setupAudio();
    try {
      const letter = await api.generateLetter(this.data.letterId);
      if (!letter.draft) throw new Error("新草稿还没有生成完成");
      if (!this.disposed) {
        this.setData({ letter });
        if (letter.audioTranscriptRevisionPending || draftNeedsSourceReview(letter.draft.paragraphs)) {
          wx.showToast({ title: "新草稿需先核对内容依据", icon: "none" });
          wx.redirectTo({ url: `/pages/editor/index?id=${encodeURIComponent(this.data.letterId)}` });
          return;
        }
        wx.showToast({ title: "已经换了一版", icon: "success" });
      }
    } catch (error) {
      if (!this.disposed) {
        wx.showToast({ title: (error as Error).message || "重新生成失败", icon: "none" });
      }
    } finally {
      if (!this.disposed) this.setData({ regenerating: false });
    }
  },

  chooseVoice(event: { detail: { value: number | string } }) {
    this.setData({ selectedVoiceIndex: Number(event.detail.value), speechError: "" });
  },

  async generateNarration() {
    const letter = this.data.letter;
    const voice = this.data.speechCatalog.voices[this.data.selectedVoiceIndex];
    if (!letter?.draft || !voice || this.data.speechLoading || this.data.shareReady) return;
    this.setData({ speechLoading: true, speechError: "", speechPlaying: false });
    this.audioContext?.stop();
    this.removeGeneratedFile();
    try {
      const narration = await api.generateNarration(
        this.data.letterId,
        letter.draft,
        voice.id,
        letter.intent.tone,
      );
      if (this.disposed) return;
      this.generatedFilePath = narration.filePath;
      if (!this.audioContext) this.setupAudio();
      if (!this.audioContext) throw new Error("播放器初始化失败");
      this.audioContext.src = narration.filePath;
      this.audioContext.play();
      this.setData({ speechPath: narration.filePath, speechPlaying: true });
    } catch (error) {
      if (!this.disposed) {
        this.setData({ speechError: (error as Error).message || "朗读生成失败，请稍后重试" });
      }
    } finally {
      if (!this.disposed) this.setData({ speechLoading: false });
    }
  },

  toggleNarration() {
    if (!this.data.speechPath || !this.audioContext) return;
    if (this.data.speechPlaying) {
      this.audioContext.pause();
      this.setData({ speechPlaying: false });
      return;
    }
    this.audioContext.src = this.data.speechPath;
    this.audioContext.play();
    this.setData({ speechPlaying: true, speechError: "" });
  },

  previewPhoto(event: { currentTarget: { dataset: { path: string } } }) {
    const current = event.currentTarget.dataset.path;
    const urls = this.data.photos
      .map((photo) => photo.localPath)
      .filter((path): path is string => Boolean(path));
    if (current && urls.length > 0) wx.previewImage({ current, urls });
  },

  async confirmForShare() {
    const letter = this.data.letter;
    if (!letter?.draft || this.data.confirming || this.data.shareReady) return;
    const confirmed = await confirmDialog(
      `确认这封信写给“${letter.intent.recipient}”，并准备选择微信好友寄出？`,
    );
    if (!confirmed) return;
    this.setData({ confirming: true });
    try {
      const published = await api.confirmLetter(this.data.letterId, letter.draft);
      if (!published.shareToken) throw new Error("分享凭据生成失败，请重试");
      if (this.disposed) return;
      this.setData({
        letter: published,
        shareReady: true,
        shareToken: published.shareToken,
      });
      wx.showShareMenu?.({ menus: ["shareAppMessage"] });
      wx.showToast({ title: "可以选择好友了", icon: "success" });
    } catch (error) {
      if (!this.disposed) {
        wx.showToast({ title: (error as Error).message || "确认失败，请重试", icon: "none" });
      }
    } finally {
      if (!this.disposed) this.setData({ confirming: false });
    }
  },

  onShareAppMessage() {
    if (!this.data.shareReady || !this.data.shareToken) {
      return { title: "暖笺", path: "/pages/home/index" };
    }
    return {
      title: this.data.letter?.draft?.title || "一封暖笺家书",
      path: `/pages/reader/index?id=${encodeURIComponent(this.data.letterId)}&token=${encodeURIComponent(this.data.shareToken)}`,
    };
  },
});
