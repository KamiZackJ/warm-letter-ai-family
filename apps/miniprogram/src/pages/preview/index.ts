import { environmentView } from "../../config/env";
import { api } from "../../services/api";
import type { Letter, Material, SpeechCatalog } from "../../types/domain";
import { draftNeedsSourceReview } from "../../utils/paragraph-attribution";
import { removeDownloadedFile, type MaterialDownloadControl } from "../../services/http-client";

type PreviewPhoto = Material & { photoLoading?: boolean; photoError?: string; downloaded?: boolean };

type PreviewAudioContext = {
  src: string;
  play(): void;
  pause(): void;
  stop(): void;
  destroy?(): void;
  onEnded(callback: () => void): void;
  onError(callback: (error?: { errCode?: unknown }) => void): void;
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
  audioPlaybackActive: false,
  audioNeedsRecovery: false,
  // Numeric native diagnostics stay in page memory; never retain errMsg or paths.
  audioErrorCode: null as number | null,
  generatedFilePath: "",
  photoLoadId: 0,
  photoDownloads: [] as Array<{ id: string; control: MaterialDownloadControl }>,
  downloadedPhotoPaths: [] as string[],

  data: {
    ...environmentView,
    letterId: "",
    letter: null as Letter | null,
    photos: [] as PreviewPhoto[],
    loading: true,
    loadError: "",
    regenerating: false,
    confirming: false,
    confirmError: "",
    safetyCheckPending: false,
    shareReady: false,
    shareToken: "",
    shareResetNotice: "",
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
    this.photoDownloads = [];
    this.downloadedPhotoPaths = [];
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
    this.clearPhotoDownloads();
    this.teardownAudio();
    this.removeGeneratedFile();
  },

  onShow() {
    this.hidden = false;
  },

  onHide() {
    this.hidden = true;
    this.stopNarration();
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
      if (!this.disposed && this.audioContext === audioContext) {
        this.audioPlaybackActive = false;
        this.setData({ speechPlaying: false });
      }
    });
    audioContext.onError((error) => {
      // Empty/stopped players can report errors without a playback request.
      // A retired player must not overwrite the state of its replacement.
      if (this.disposed || this.audioContext !== audioContext || !this.audioPlaybackActive ||
        !this.data.speechPath || audioContext.src !== this.data.speechPath) return;
      this.handlePlaybackFailure(error?.errCode);
    });
    this.audioContext = audioContext;
    this.audioNeedsRecovery = false;
  },

  teardownAudio() {
    const audioContext = this.audioContext;
    this.audioContext = null;
    this.audioPlaybackActive = false;
    if (audioContext?.src) audioContext.stop();
    audioContext?.destroy?.();
  },

  stopNarration() {
    this.audioPlaybackActive = false;
    if (this.audioContext?.src) this.audioContext.stop();
  },

  handlePlaybackFailure(code?: unknown) {
    if (this.disposed) return;
    this.audioPlaybackActive = false;
    this.audioNeedsRecovery = true;
    this.audioErrorCode = typeof code === "number" && [-1, 10001, 10002, 10003, 10004].includes(code)
      ? code : null;
    this.setData({
      speechPlaying: false,
      speechError: "朗读暂时没能播放，音频已保留，请点播放按钮重试。",
    });
  },

  playSavedNarration() {
    if (this.disposed || this.hidden || !this.data.speechPath) return;
    try {
      if (!this.audioContext || this.audioNeedsRecovery) this.setupAudio();
      const audioContext = this.audioContext;
      if (!audioContext) throw new Error("Audio player unavailable");
      this.audioPlaybackActive = true;
      this.audioErrorCode = null;
      // Set state before native calls so a synchronous onError/onEnded wins.
      this.setData({ speechPlaying: true, speechError: "" });
      // Reassigning src on resume restarts the file on real devices.
      if (audioContext.src !== this.data.speechPath) audioContext.src = this.data.speechPath;
      if (this.audioPlaybackActive) audioContext.play();
    } catch {
      this.handlePlaybackFailure();
    }
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
    this.clearPhotoDownloads();
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
      let shareRestored = false;
      if (
        (letter.status === "PUBLISHED" || letter.status === "CONFIRMED") &&
        !letter.shareToken
      ) {
        letter = await api.reissueShare(letterId);
        shareRestored = true;
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
      this.stopNarration();
      this.removeGeneratedFile();
      this.setData({
        letter,
        photos: materials.filter(
          (material) =>
            materialIds.has(material.id) &&
            (material.type === "photo" || material.type === "screenshot"),
        ),
        speechCatalog,
        selectedVoiceIndex: 0,
        generatedVoiceId: "",
        generatedVoiceName: "",
        persistedVoiceKnown: false,
        voiceChangePending: false,
        speechPath: "",
        speechPlaying: false,
        speechError: "",
        shareReady: Boolean(letter.shareToken),
        shareToken: letter.shareToken || "",
        shareResetNotice: shareRestored
          ? "已恢复这封家书的分享入口。之前的分享已失效，请重新发送给家人。"
          : this.data.shareResetNotice,
        loadError: "",
      });
      if (letter.shareToken) wx.showShareMenu?.({ menus: ["shareAppMessage"] });
      for (const photo of this.data.photos) {
        if (!photo.localPath) void this.loadPhoto(photo.id);
      }
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

  clearPhotoDownloads() {
    this.photoLoadId += 1;
    for (const { control } of this.photoDownloads) {
      control.cancelled = true;
      control.abort?.();
    }
    this.photoDownloads = [];
    for (const path of this.downloadedPhotoPaths) removeDownloadedFile(path);
    this.downloadedPhotoPaths = [];
  },

  updatePhoto(id: string, patch: Partial<PreviewPhoto>) {
    this.setData({ photos: this.data.photos.map((photo) => photo.id === id ? { ...photo, ...patch } : photo) });
  },

  async loadPhoto(id: string, requestId?: number) {
    requestId ??= this.photoLoadId;
    if (this.disposed || requestId !== this.photoLoadId || this.photoDownloads.some((item) => item.id === id)) return;
    const photo = this.data.photos.find((item) => item.id === id);
    if (!photo) return;
    const control: MaterialDownloadControl = { cancelled: false };
    this.photoDownloads.push({ id, control });
    this.updatePhoto(id, { localPath: "", photoLoading: true, photoError: "" });
    try {
      const path = await api.getMaterialContent(photo, control);
      if (this.disposed || control.cancelled || requestId !== this.photoLoadId) {
        removeDownloadedFile(path);
        return;
      }
      this.downloadedPhotoPaths.push(path);
      this.updatePhoto(id, { localPath: path, photoLoading: false, photoError: "", downloaded: true });
    } catch (error) {
      if (!this.disposed && !control.cancelled && requestId === this.photoLoadId) {
        this.updatePhoto(id, { photoLoading: false, photoError: error instanceof Error ? error.message : "照片暂时无法读取，请重试" });
      }
    } finally {
      this.photoDownloads = this.photoDownloads.filter((item) => item.control !== control);
    }
  },

  retryPhoto(event: { currentTarget: { dataset: { id: string } } }) {
    void this.loadPhoto(event.currentTarget.dataset.id);
  },

  handlePhotoError(event: { currentTarget: { dataset: { id: string; path: string } } }) {
    if (this.disposed || this.data.loading) return;
    const { id, path } = event.currentTarget.dataset;
    const photo = this.data.photos.find((item) => item.id === id);
    if (!photo || photo.localPath !== path) return;
    if (photo.downloaded) {
      removeDownloadedFile(path);
      this.downloadedPhotoPaths = this.downloadedPhotoPaths.filter((item) => item !== path);
      this.updatePhoto(id, { localPath: "", photoError: "照片暂时无法显示，请重试" });
    } else {
      void this.loadPhoto(id);
    }
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
    this.stopNarration();
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
    this.stopNarration();
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
      this.setData({
        speechPath: narration.filePath, speechPlaying: false,
        generatedVoiceId: voice.id, generatedVoiceName: voice.name,
        persistedVoiceKnown: true, voiceChangePending: false,
      });
      this.setupAudio();
      this.playSavedNarration();
    } catch (error) {
      if (!this.disposed && requestId === this.speechRequestId) {
        this.setData({ speechError: (error as Error).message || "朗读生成失败，请稍后重试" });
      }
    } finally {
      if (!this.disposed && requestId === this.speechRequestId) this.setData({ speechLoading: false });
    }
  },

  toggleNarration() {
    if (this.operationBusy() || !this.data.speechPath) return;
    if (this.data.speechPlaying) {
      this.audioPlaybackActive = false;
      this.audioContext?.pause();
      this.setData({ speechPlaying: false });
      return;
    }
    this.playSavedNarration();
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
        safetyCheckPending: false,
        shareReady: true,
        shareToken: published.shareToken,
      });
      wx.showShareMenu?.({ menus: ["shareAppMessage"] });
      wx.showToast({ title: "可以选择好友了", icon: "success" });
    } catch (error) {
      if (!this.disposed) {
        const message = (error as Error).message || "确认失败，请重试";
        this.setData({
          confirmError: message,
          safetyCheckPending: (error as { code?: string } | null)?.code === "CONTENT_SAFETY_PENDING",
        });
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
