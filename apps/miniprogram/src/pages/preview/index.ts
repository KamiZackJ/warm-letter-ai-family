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
  hidden: false,
  loadRequestId: 0,
  speechRequestId: 0,
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
    confirmError: "",
    shareReady: false,
    shareToken: "",
    speechCatalog: emptySpeechCatalog,
    selectedVoiceIndex: 0,
    generatedVoiceId: "",
    generatedVoiceName: "",
    persistedVoiceKnown: false,
    voiceChangePending: false,
    speechLoading: false,
    speechPath: "",
    speechPlaying: false,
    speechError: "",
  },

  async onLoad(options: { id?: string }) {
    this.disposed = false;
    this.hidden = false;
    this.setupAudio();
    wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
    if (!options.id) {
      this.setData({ loading: false, loadError: "家书链接不完整，请返回重新预览。" });
      return;
    }
    this.setData({ letterId: options.id });
    await this.loadPreview();
  },

  onUnload() {
    this.disposed = true;
    this.loadRequestId += 1;
    this.speechRequestId += 1;
    this.teardownAudio();
    this.removeGeneratedFile();
  },

  onShow() {
    this.hidden = false;
  },

  onHide() {
    this.hidden = true;
    this.audioContext?.stop();
    if (!this.disposed) this.setData({ speechPlaying: false });
  },

  operationBusy(): boolean {
    return this.disposed || this.hidden || this.data.speechLoading || this.data.regenerating || this.data.confirming;
  },

  setupAudio() {
    this.teardownAudio();
    if (this.disposed) return;
    const audioContext = wx.createInnerAudioContext() as PreviewAudioContext;
    audioContext.onEnded(() => {
      if (!this.disposed && this.audioContext === audioContext) this.setData({ speechPlaying: false });
    });
    audioContext.onError(() => {
      if (!this.disposed && this.audioContext === audioContext) {
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
    this.removeNarrationFile(filePath);
  },

  removeNarrationFile(filePath: string) {
    if (!filePath || !filePath.startsWith(`${wx.env.USER_DATA_PATH}/warm-letter-narration-`)) {
      return;
    }
    try { wx.getFileSystemManager().unlink({ filePath, fail: () => undefined }); }
    catch { /* A stale temporary file must not block leaving the preview. */ }
  },

  async loadPreview() {
    if (this.disposed || this.data.speechLoading || this.data.regenerating || this.data.confirming) return;
    const requestId = ++this.loadRequestId;
    const letterId = this.data.letterId;
    const isCurrent = () => !this.disposed && requestId === this.loadRequestId;
    this.setData({ loading: true, loadError: "" });
    try {
      const [loadedLetter, materials, speechCatalog] = await Promise.all([
        api.getLetter(letterId),
        api.listMaterials(),
        api.getSpeechCatalog().catch(() => emptySpeechCatalog),
      ]);
      if (!isCurrent()) return;
      let letter = loadedLetter;
      if (
        (letter.status === "PUBLISHED" || letter.status === "CONFIRMED") &&
        !letter.shareToken
      ) {
        letter = await api.reissueShare(letterId);
      }
      if (!letter.draft) throw new Error("家书草稿还没有生成完成");
      if (!isCurrent()) return;
      if (letter.status === "EDITING" && (
        letter.audioTranscriptRevisionPending || draftNeedsSourceReview(letter.draft.paragraphs)
      )) {
        wx.showToast({ title: "请先核对草稿内容依据", icon: "none" });
        wx.redirectTo({ url: `/pages/editor/index?id=${encodeURIComponent(this.data.letterId)}` });
        return;
      }
      const materialIds = new Set(letter.materialIds);
      this.audioContext?.stop();
      this.removeGeneratedFile();
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
        generatedVoiceId: "",
        generatedVoiceName: "",
        persistedVoiceKnown: false,
        voiceChangePending: false,
        speechPath: "",
        speechPlaying: false,
        shareReady: Boolean(letter.shareToken),
        shareToken: letter.shareToken || "",
        loadError: "",
      });
      if (letter.shareToken) wx.showShareMenu?.({ menus: ["shareAppMessage"] });
    } catch (error) {
      if (isCurrent()) {
        this.setData({ loadError: (error as Error).message || "家书预览暂时无法打开" });
      }
    } finally {
      if (isCurrent()) this.setData({ loading: false });
    }
  },

  retryLoad() {
    void this.loadPreview();
  },

  editLetter() {
    if (this.operationBusy()) return;
    wx.navigateBack({
      fail: () =>
        wx.redirectTo({ url: `/pages/editor/index?id=${encodeURIComponent(this.data.letterId)}` }),
    });
  },

  async regenerate() {
    if (this.operationBusy() || this.data.shareReady) return;
    this.setData({ regenerating: true });
    try {
      const confirmed = await confirmDialog("换一版文字会覆盖当前草稿，是否继续？");
      if (!confirmed || this.disposed || this.hidden) return;
      this.loadRequestId += 1;
      this.setData({
        speechError: "", speechPath: "", speechPlaying: false,
        generatedVoiceId: "", generatedVoiceName: "", persistedVoiceKnown: false, voiceChangePending: false,
      });
      this.teardownAudio();
      this.removeGeneratedFile();
      this.setupAudio();
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
    if (this.operationBusy() || this.data.shareReady) return;
    const selectedVoiceIndex = Number(event.detail.value);
    if (!Number.isInteger(selectedVoiceIndex) || !this.data.speechCatalog.voices[selectedVoiceIndex] ||
      selectedVoiceIndex === this.data.selectedVoiceIndex) return;
    this.audioContext?.stop();
    const voiceChangePending = !this.data.persistedVoiceKnown ||
      this.data.speechCatalog.voices[selectedVoiceIndex]!.id !== this.data.generatedVoiceId;
    this.setData({ selectedVoiceIndex, voiceChangePending, speechError: "", speechPlaying: false });
  },

  keepSavedNarration() {
    if (this.operationBusy() || this.data.shareReady) return;
    const savedIndex = this.data.persistedVoiceKnown
      ? this.data.speechCatalog.voices.findIndex((voice) => voice.id === this.data.generatedVoiceId)
      : -1;
    this.setData({
      selectedVoiceIndex: savedIndex >= 0 ? savedIndex : this.data.selectedVoiceIndex,
      voiceChangePending: false,
      speechError: "",
    });
  },

  async generateNarration() {
    const letter = this.data.letter;
    const voice = this.data.speechCatalog.voices[this.data.selectedVoiceIndex];
    if (!letter?.draft || !voice || this.operationBusy() || this.data.shareReady) return;
    const requestId = ++this.speechRequestId;
    this.loadRequestId += 1;
    // Until the response arrives we cannot know whether a failed request has
    // already replaced the saved narration. Do not claim the old voice is current.
    this.setData({
      speechLoading: true, speechError: "", speechPlaying: false,
      persistedVoiceKnown: false, voiceChangePending: true,
    });
    this.audioContext?.stop();
    try {
      const narration = await api.generateNarration(
        this.data.letterId,
        letter.draft,
        voice.id,
        letter.intent.tone,
      );
      if (this.disposed || requestId !== this.speechRequestId) {
        this.removeNarrationFile(narration.filePath);
        return;
      }
      this.removeGeneratedFile();
      this.generatedFilePath = narration.filePath;
      if (!this.audioContext) this.setupAudio();
      if (!this.audioContext) throw new Error("暂时无法播放，请重试");
      this.audioContext.src = narration.filePath;
      if (!this.hidden) this.audioContext.play();
      this.setData({
        speechPath: narration.filePath, speechPlaying: !this.hidden,
        generatedVoiceId: voice.id, generatedVoiceName: voice.name,
        persistedVoiceKnown: true, voiceChangePending: false,
      });
    } catch (error) {
      if (!this.disposed && requestId === this.speechRequestId) {
        this.setData({ speechError: (error as Error).message || "朗读生成失败，请稍后重试" });
      }
    } finally {
      if (!this.disposed && requestId === this.speechRequestId) this.setData({ speechLoading: false });
    }
  },

  toggleNarration() {
    if (this.operationBusy() || !this.data.speechPath || !this.audioContext) return;
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
    if (!letter?.draft || this.operationBusy() || this.data.shareReady) return;
    if (this.data.voiceChangePending) {
      wx.showToast({ title: "请先生成朗读，或选择暂不更换声音", icon: "none" });
      return;
    }
    this.setData({ confirming: true, confirmError: "" });
    try {
      const narrationNotice = this.data.persistedVoiceKnown
        ? `将使用已生成的“${this.data.generatedVoiceName}”朗读。`
        : "如果之前生成过朗读，会随信一起寄出。";
      const confirmed = await confirmDialog(
        `确认这封信写给“${letter.intent.recipient}”？${narrationNotice}之后可选择微信好友寄出。`,
      );
      if (!confirmed || this.disposed || this.hidden) return;
      this.loadRequestId += 1;
      const published = await api.confirmLetter(this.data.letterId, letter.draft);
      if (!published.shareToken) throw new Error("暂时无法分享，请重试");
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
        const message = (error as Error).message || "确认失败，请重试";
        this.setData({ confirmError: message });
        wx.showToast({ title: "尚未寄出，请查看提示", icon: "none" });
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
