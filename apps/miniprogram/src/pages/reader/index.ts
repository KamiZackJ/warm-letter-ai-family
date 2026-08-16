import { api } from "../../services/api";
import { environmentView } from "../../config/env";
import type { ReaderLetter, ReaderSource, Reply } from "../../types/domain";
import { formatDate } from "../../utils/date";
import { createId } from "../../utils/id";
import {
  getParagraphSourceAttribution,
  paragraphAttributionLabel,
} from "../../utils/paragraph-attribution";

type DisplayReply = Reply & { dateLabel: string };
type ImageLoadState = "loading" | "ready" | "error";
type DisplaySource = ReaderSource & {
  typeLabel: string;
  imageState: ImageLoadState;
  imageError: string;
  imageRetrying: boolean;
  imageAttempt: number;
};
type DisplayParagraphSource = {
  id: string;
  typeLabel: string;
  name: string;
  available: boolean;
};
type DisplayParagraph = ReaderLetter["draft"]["paragraphs"][number] & {
  sources: DisplayParagraphSource[];
  attributionLabel: string;
  sourceAttribution: "ai" | "sources-confirmed" | "user-supplied" | "needs-review";
  sourceSummary: string;
  sourceCount: number;
  sourcesExpanded: boolean;
};

type ReaderAudioContext = {
  src: string;
  play(): void;
  pause(): void;
  stop(): void;
  destroy?(): void;
  onEnded(callback: () => void): void;
  offEnded?(callback: () => void): void;
  onError(callback: () => void): void;
  offError?(callback: () => void): void;
};

const TYPE_LABELS: Record<string, string> = {
  photo: "生活照片",
  screenshot: "聊天截图",
  voice: "语音",
  text: "文字记录",
};
const REPLY_LIMIT = 240;

function mediaExpired(source: ReaderSource | undefined): boolean {
  if (!source?.mediaExpiresAt) return false;
  const expiresAt = Date.parse(source.mediaExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isImageSource(source: ReaderSource): boolean {
  return source.type === "photo" || source.type === "screenshot";
}

function toDisplaySource(
  source: ReaderSource,
  previous?: DisplaySource,
): DisplaySource {
  let imageState: ImageLoadState = "ready";
  let imageError = "";
  let imageRetrying = false;
  const imageAttempt = previous?.imageAttempt || 0;

  if (isImageSource(source)) {
    if (mediaExpired(source)) {
      imageState = "error";
      imageError = "图片访问已到期";
    } else if (!source.mediaUrl) {
      imageState = "error";
      imageError = "照片暂时无法显示";
    } else if (previous?.mediaUrl === source.mediaUrl) {
      imageState = previous.imageState;
      imageError = previous.imageError;
      imageRetrying = previous.imageRetrying;
    } else {
      imageState = "loading";
    }
  }

  return {
    ...source,
    typeLabel: TYPE_LABELS[source.type] || "素材",
    imageState,
    imageError,
    imageRetrying,
    imageAttempt,
  };
}

function toDisplayReply(reply: Reply): DisplayReply {
  return { ...reply, dateLabel: formatDate(reply.createdAt) };
}

function mergeDisplayReplies(existing: DisplayReply[], incoming: Reply[]): DisplayReply[] {
  const replies = new Map<string, DisplayReply>();
  for (const reply of existing) replies.set(reply.id, reply);
  for (const reply of incoming) replies.set(reply.id, toDisplayReply(reply));
  return [...replies.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function rawReplies(replies: DisplayReply[]): Reply[] {
  return replies.map(({ dateLabel: _dateLabel, ...reply }) => reply);
}

function toDisplayParagraphs(
  letter: ReaderLetter,
  materials: DisplaySource[],
  previous: DisplayParagraph[],
): DisplayParagraph[] {
  const materialMap = new Map(materials.map((material) => [material.id, material]));
  const expandedParagraphs = new Set(
    previous.filter((paragraph) => paragraph.sourcesExpanded).map((paragraph) => paragraph.id),
  );

  return letter.draft.paragraphs.map((paragraph) => {
    const sourceAttribution = getParagraphSourceAttribution(paragraph);
    const sourceIds = [...new Set(paragraph.sourceRefs)];
    const sources = sourceIds.map((sourceId): DisplayParagraphSource => {
      const source = materialMap.get(sourceId);
      return source
        ? {
            id: source.id,
            typeLabel: source.typeLabel,
            name: source.name,
            available: true,
          }
        : {
            id: sourceId,
            typeLabel: "来源",
            name: "素材暂不可用",
            available: false,
          };
    });
    const sourceLabels = [
      ...new Set(sources.map((source) => (source.available ? source.typeLabel : "来源暂不可用"))),
    ];

    return {
      ...paragraph,
      sourceAttribution,
      sources,
      attributionLabel: paragraphAttributionLabel(paragraph),
      sourceSummary:
        sourceLabels.length > 0
          ? sourceLabels.join("、")
          : sourceAttribution === "user-supplied"
            ? "未关联素材"
            : sourceAttribution === "needs-review"
              ? "尚未核对"
              : "未提供素材",
      sourceCount: sources.length,
      sourcesExpanded: expandedParagraphs.has(paragraph.id),
    };
  });
}

function countReplyCharacters(value: string): number {
  return Array.from(value).length;
}

Page({
  disposed: false,
  loadRequestId: 0,
  audioContext: null as ReaderAudioContext | null,
  audioEndedHandler: null as (() => void) | null,
  audioErrorHandler: null as (() => void) | null,
  audioGeneration: 0,
  audioSourceId: "",
  replyRequestKey: "",
  replyRequestText: "",

  data: {
    ...environmentView,
    letterId: "",
    shareToken: "",
    letter: null as ReaderLetter | null,
    materials: [] as DisplaySource[],
    paragraphs: [] as DisplayParagraph[],
    imageMaterials: [] as DisplaySource[],
    voiceMaterials: [] as DisplaySource[],
    replies: [] as DisplayReply[],
    confirmedDate: "",
    replyText: "",
    replyCount: 0,
    replyLimit: REPLY_LIMIT,
    fontMode: "large" as "normal" | "large" | "extra",
    playingId: "",
    audioErrorId: "",
    audioError: "",
    retryingVoiceId: "",
    loading: true,
    loadError: "",
    sendingReply: false,
    replyError: "",
    refreshingMedia: false,
  },

  async onLoad(options: { id?: string; token?: string }) {
    this.disposed = false;
    this.setupAudio();
    if (!options.id) {
      this.setData({
        loading: false,
        loadError: "链接里缺少家书编号，请返回后重新打开完整分享链接。",
      });
      return;
    }
    this.setData({ letterId: options.id, shareToken: options.token || "" });
    await this.loadLetter();
  },

  onUnload() {
    this.disposed = true;
    this.loadRequestId += 1;
    this.teardownAudio();
  },

  setupAudio() {
    this.teardownAudio();
    if (this.disposed) return;
    const audioContext = wx.createInnerAudioContext() as ReaderAudioContext;
    const generation = this.audioGeneration;
    const endedHandler = () => {
      if (this.disposed || this.audioGeneration !== generation) return;
      this.setData({ playingId: "" });
    };
    const errorHandler = () => {
      if (this.disposed || this.audioGeneration !== generation) return;
      const failedId = this.audioSourceId || this.data.playingId || this.data.audioErrorId;
      this.setData({
        playingId: "",
        audioErrorId: failedId,
        audioError: "语音暂时无法播放，请重新播放。",
      });
    };

    audioContext.onEnded(endedHandler);
    audioContext.onError(errorHandler);
    this.audioContext = audioContext;
    this.audioEndedHandler = endedHandler;
    this.audioErrorHandler = errorHandler;
  },

  teardownAudio() {
    const audioContext = this.audioContext;
    const endedHandler = this.audioEndedHandler;
    const errorHandler = this.audioErrorHandler;
    this.audioGeneration += 1;
    this.audioContext = null;
    this.audioEndedHandler = null;
    this.audioErrorHandler = null;
    this.audioSourceId = "";
    if (!audioContext) return;

    if (endedHandler) {
      audioContext.offEnded?.(endedHandler);
    }
    if (errorHandler) {
      audioContext.offError?.(errorHandler);
    }
    audioContext.stop();
    audioContext.destroy?.();
  },

  async loadLetter(preserveContent = false) {
    const requestId = this.loadRequestId + 1;
    this.loadRequestId = requestId;
    if (!preserveContent) {
      this.setData({ loading: true, loadError: "" });
    }
    try {
      const letter = await api.getReader(
        this.data.letterId,
        this.data.shareToken || undefined,
      );
      if (this.disposed || this.loadRequestId !== requestId) return false;
      const previousImages = new Map(
        this.data.imageMaterials.map((item) => [item.id, item]),
      );
      const materials = letter.sources.map((item) =>
        toDisplaySource(item, previousImages.get(item.id)),
      );
      const paragraphs = toDisplayParagraphs(letter, materials, this.data.paragraphs);
      const replies = preserveContent
        ? mergeDisplayReplies(this.data.replies, letter.replies)
        : letter.replies.map(toDisplayReply);
      this.setData({
        letter: { ...letter, replies: rawReplies(replies) },
        materials,
        paragraphs,
        shareToken: letter.shareToken,
        confirmedDate: letter.publishedAt.slice(0, 10),
        imageMaterials: materials.filter(
          (item) => item.type === "photo" || item.type === "screenshot",
        ),
        voiceMaterials: materials.filter((item) => item.type === "voice"),
        replies,
        loadError: "",
      });
      return true;
    } catch (error) {
      if (this.disposed || this.loadRequestId !== requestId) return false;
      const message = (error as Error).message || "家书暂时无法打开";
      if (preserveContent) {
        wx.showToast({ title: message, icon: "none" });
      } else {
        this.setData({
          letter: null,
          materials: [],
          paragraphs: [],
          imageMaterials: [],
          voiceMaterials: [],
          replies: [],
          loadError: message,
        });
      }
      return false;
    } finally {
      if (!this.disposed && this.loadRequestId === requestId && !preserveContent) {
        this.setData({ loading: false });
      }
    }
  },

  async retryLoad() {
    await this.loadLetter();
  },

  backFromError() {
    wx.reLaunch({ url: "/pages/home/index" });
  },

  async refreshMediaAccess(): Promise<boolean> {
    if (this.disposed || this.data.refreshingMedia) return false;
    this.setData({ refreshingMedia: true });
    try {
      return await this.loadLetter(true);
    } finally {
      if (!this.disposed) this.setData({ refreshingMedia: false });
    }
  },

  chooseFont(event: {
    currentTarget: { dataset: { value: "normal" | "large" | "extra" } };
  }) {
    this.setData({ fontMode: event.currentTarget.dataset.value });
  },

  toggleParagraphSources(event: { currentTarget: { dataset: { id: string } } }) {
    const { id } = event.currentTarget.dataset;
    const paragraph = this.data.paragraphs.find((item) => item.id === id);
    if (!paragraph || paragraph.sourceCount === 0) return;
    this.setData({
      paragraphs: this.data.paragraphs.map((item) =>
        item.id === id ? { ...item, sourcesExpanded: !item.sourcesExpanded } : item,
      ),
    });
  },

  setImageState(
    id: string,
    patch: Partial<
      Pick<DisplaySource, "imageState" | "imageError" | "imageRetrying" | "imageAttempt">
    >,
  ) {
    if (this.disposed) return;
    this.setData({
      imageMaterials: this.data.imageMaterials.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  },

  handleImageLoad(event: {
    currentTarget: { dataset: { id: string; url: string; attempt: number | string } };
  }) {
    const { id, url, attempt } = event.currentTarget.dataset;
    const source = this.data.imageMaterials.find((item) => item.id === id);
    if (!source || source.mediaUrl !== url || source.imageAttempt !== Number(attempt)) return;
    if (mediaExpired(source)) {
      this.setImageState(id, {
        imageState: "error",
        imageError: "图片访问已到期",
        imageRetrying: false,
      });
      return;
    }
    this.setImageState(id, {
      imageState: "ready",
      imageError: "",
      imageRetrying: false,
    });
  },

  handleImageError(event: {
    currentTarget: { dataset: { id: string; url: string; attempt: number | string } };
  }) {
    const { id, url, attempt } = event.currentTarget.dataset;
    const source = this.data.imageMaterials.find((item) => item.id === id);
    if (!source || source.mediaUrl !== url || source.imageAttempt !== Number(attempt)) return;
    this.setImageState(id, {
      imageState: "error",
      imageError: "图片加载失败，请重新获取。",
      imageRetrying: false,
    });
  },

  async retryImage(event: { currentTarget: { dataset: { id: string } } }) {
    const { id } = event.currentTarget.dataset;
    const current = this.data.imageMaterials.find((item) => item.id === id);
    if (this.disposed || !current || current.imageRetrying || this.data.refreshingMedia) return;

    this.setImageState(id, { imageRetrying: true });
    const refreshed = await this.refreshMediaAccess();
    if (this.disposed) return;
    const source = this.data.imageMaterials.find((item) => item.id === id);
    if (!refreshed || !source?.mediaUrl || mediaExpired(source)) {
      this.setImageState(id, {
        imageState: "error",
        imageError: refreshed ? "图片仍然无法获取，请稍后再试。" : "图片重新获取失败，请稍后再试。",
        imageRetrying: false,
      });
      return;
    }

    this.setImageState(id, {
      imageState: "loading",
      imageError: "",
      imageRetrying: false,
      imageAttempt: source.imageAttempt + 1,
    });
  },

  async previewImage(event: { currentTarget: { dataset: { id: string; path?: string } } }) {
    const { id } = event.currentTarget.dataset;
    const source = this.data.imageMaterials.find((item) => item.id === id);
    if (mediaExpired(source)) {
      this.setImageState(id, {
        imageState: "error",
        imageError: "图片访问已到期",
        imageRetrying: false,
      });
      return;
    }
    const path = source?.mediaUrl;
    if (!path || source.imageState !== "ready") {
      return;
    }
    const urls = this.data.imageMaterials
      .filter((item) => item.imageState === "ready" && !mediaExpired(item))
      .map((item) => item.mediaUrl)
      .filter((item): item is string => Boolean(item));
    wx.previewImage({ current: path, urls });
  },

  async playVoice(event: { currentTarget: { dataset: { id: string; path?: string } } }) {
    const { id } = event.currentTarget.dataset;
    if (this.disposed || this.data.retryingVoiceId || this.data.refreshingMedia) return;
    if (this.data.playingId === id) {
      this.audioContext?.pause();
      this.setData({ playingId: "" });
      return;
    }

    await this.startVoice(id);
  },

  async startVoice(id: string) {
    if (this.disposed) return;

    let source = this.data.voiceMaterials.find((item) => item.id === id);
    if (mediaExpired(source)) {
      const refreshed = await this.refreshMediaAccess();
      if (this.disposed) return;
      source = this.data.voiceMaterials.find((item) => item.id === id);
      if (!refreshed) {
        this.setAudioError(id, "语音重新获取失败，请稍后再试。");
        return;
      }
    }
    if (mediaExpired(source)) {
      this.setAudioError(id, "语音访问已到期，请重新播放。");
      return;
    }
    const path = source?.mediaUrl;
    if (!path) {
      this.setAudioError(id, "语音暂时无法获取，请重新播放。");
      return;
    }

    if (this.audioContext && this.audioSourceId && this.audioSourceId !== id) {
      this.setupAudio();
    } else if (!this.audioContext) {
      this.setupAudio();
    }
    const audioContext = this.audioContext;
    if (!audioContext) {
      this.setAudioError(id, "语音播放器初始化失败，请重新播放。");
      return;
    }

    this.audioSourceId = id;
    this.setData({ playingId: id, audioErrorId: "", audioError: "" });
    try {
      audioContext.src = path;
      audioContext.play();
    } catch (error) {
      this.setAudioError(
        id,
        (error as Error).message || "语音暂时无法播放，请重新播放。",
      );
    }
  },

  setAudioError(id: string, message: string) {
    if (this.disposed) return;
    this.setData({
      playingId: "",
      audioErrorId: id,
      audioError: message,
    });
  },

  async retryVoice(event: { currentTarget: { dataset: { id: string } } }) {
    const { id } = event.currentTarget.dataset;
    if (this.disposed || this.data.retryingVoiceId || this.data.refreshingMedia) return;

    this.setData({ retryingVoiceId: id });
    try {
      const refreshed = await this.refreshMediaAccess();
      if (!refreshed) {
        this.setAudioError(id, "语音重新获取失败，请稍后再试。");
        return;
      }
      await this.startVoice(id);
    } finally {
      if (!this.disposed) this.setData({ retryingVoiceId: "" });
    }
  },

  updateReply(event: { detail: { value: string } }) {
    if (this.disposed) return;
    const replyText = event.detail.value;
    this.setData({ replyText, replyCount: countReplyCharacters(replyText) });
  },

  async sendReply() {
    if (this.disposed || this.data.sendingReply) return;
    const submittedDraft = this.data.replyText;
    const text = submittedDraft.trim();
    if (!text) {
      wx.showToast({ title: "写一句回复吧", icon: "none" });
      return;
    }
    if (!this.replyRequestKey || this.replyRequestText !== text) {
      this.replyRequestKey = createId("reply");
      this.replyRequestText = text;
    }
    const requestKey = this.replyRequestKey;
    this.setData({ sendingReply: true, replyError: "" });
    try {
      const reply = await api.addReply(
        this.data.letterId,
        text,
        this.data.shareToken || undefined,
        requestKey,
      );
      if (this.disposed) return;
      const replies = mergeDisplayReplies(this.data.replies, [reply]);
      const currentLetter = this.data.letter;
      const nextReplyText = this.data.replyText === submittedDraft ? "" : this.data.replyText;
      this.replyRequestKey = "";
      this.replyRequestText = "";
      this.setData({
        letter: currentLetter ? { ...currentLetter, replies: rawReplies(replies) } : currentLetter,
        replyText: nextReplyText,
        replyCount: countReplyCharacters(nextReplyText),
        replyError: "",
        replies,
      });
      wx.showToast({ title: "回复已送达", icon: "success" });
    } catch (error) {
      if (this.disposed) return;
      this.setData({
        replyError:
          (error as Error).message || "回复未送达，请检查网络后重新发送。",
      });
    } finally {
      if (!this.disposed) this.setData({ sendingReply: false });
    }
  },

  async retryReply() {
    await this.sendReply();
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
