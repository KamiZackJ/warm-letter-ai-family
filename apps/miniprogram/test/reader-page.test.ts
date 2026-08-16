import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderLetter, Reply } from "../src/types/domain";

const mocks = vi.hoisted(() => ({
  getReader: vi.fn(),
  addReply: vi.fn(),
  createInnerAudioContext: vi.fn(),
  previewImage: vi.fn(),
  reLaunch: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../src/services/api", () => ({
  api: {
    getReader: mocks.getReader,
    addReply: mocks.addReply,
  },
}));

vi.mock("../src/config/env", () => ({ environmentView: {} }));

type PageDefinition = {
  data: Record<string, unknown>;
  [key: string]: any;
};

type PageContext = PageDefinition & {
  data: Record<string, any>;
  setData(patch: Record<string, unknown>): void;
};

type AudioHarness = {
  context: {
    src: string;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    onEnded: ReturnType<typeof vi.fn>;
    offEnded: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    offError: ReturnType<typeof vi.fn>;
  };
  endedHandler?: () => void;
  errorHandler?: () => void;
};

type FileSystemModule = {
  readFileSync(path: string, encoding: "utf8"): string;
};

const runtimeProcess = (globalThis as unknown as {
  process: {
    cwd(): string;
    getBuiltinModule(name: string): unknown;
  };
}).process;
const fileSystem = runtimeProcess.getBuiltinModule("node:fs") as FileSystemModule;
const normalizedWorkingDirectory = runtimeProcess.cwd().replace(/\\/g, "/");
const miniprogramDirectory = normalizedWorkingDirectory.endsWith("/apps/miniprogram")
  ? normalizedWorkingDirectory
  : `${normalizedWorkingDirectory}/apps/miniprogram`;

let pageDefinition: PageDefinition;
let activeAudio: AudioHarness;
let audioContextsCreatedDuringImport = -1;

function createAudioHarness(): AudioHarness {
  const harness = {} as AudioHarness;
  harness.context = {
    src: "",
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    onEnded: vi.fn((callback: () => void) => {
      harness.endedHandler = callback;
    }),
    offEnded: vi.fn(),
    onError: vi.fn((callback: () => void) => {
      harness.errorHandler = callback;
    }),
    offError: vi.fn(),
  };
  return harness;
}

function createLetter(overrides: Partial<ReaderLetter> = {}): ReaderLetter {
  return {
    id: "letter-1",
    recipient: "妈妈",
    draft: {
      title: "这周的家书",
      salutation: "妈妈：",
      paragraphs: [
        { id: "paragraph-1", text: "最近一切都好。", sourceRefs: ["photo-1"] },
      ],
      closing: "祝安",
      signature: "小暖",
    },
    sources: [
      {
        id: "photo-1",
        type: "photo",
        name: "晚饭照片",
        mediaUrl: "https://media.example.com/photo-old.jpg",
        mediaExpiresAt: "2099-08-16T00:00:00.000Z",
      },
      {
        id: "voice-1",
        type: "voice",
        name: "一句问候",
        mediaUrl: "https://media.example.com/voice-old.mp3",
        mediaExpiresAt: "2099-08-16T00:00:00.000Z",
        durationSeconds: 8,
      },
    ],
    replies: [
      {
        id: "reply-old",
        text: "收到了，放心。",
        authorName: "家人",
        authorVerified: false,
        createdAt: "2026-08-16T01:00:00.000Z",
      },
    ],
    publishedAt: "2026-08-16T00:00:00.000Z",
    shareToken: "share-token",
    ...overrides,
  };
}

function createReply(overrides: Partial<Reply> = {}): Reply {
  return {
    id: "reply-new",
    text: "我也想你们",
    authorName: "家人",
    authorVerified: false,
    createdAt: "2026-08-16T02:00:00.000Z",
    ...overrides,
  };
}

function createContext(data: Record<string, unknown> = {}): PageContext {
  const pageData = {
    ...structuredClone(pageDefinition.data),
    ...data,
  };
  return {
    ...pageDefinition,
    disposed: false,
    loadRequestId: 0,
    audioContext: null,
    audioEndedHandler: null,
    audioErrorHandler: null,
    audioGeneration: 0,
    audioSourceId: "",
    replyRequestKey: "",
    replyRequestText: "",
    data: pageData,
    setData(patch: Record<string, unknown>) {
      Object.assign(pageData, patch);
    },
  } as PageContext;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  activeAudio = createAudioHarness();
  mocks.createInnerAudioContext.mockImplementation(() => activeAudio.context);
  Object.assign(globalThis, {
    wx: {
      createInnerAudioContext: mocks.createInnerAudioContext,
      previewImage: mocks.previewImage,
      reLaunch: mocks.reLaunch,
      showToast: mocks.showToast,
    },
    Page: (definition: PageDefinition) => {
      pageDefinition = definition;
    },
  });

  await import("../src/pages/reader/index");
  audioContextsCreatedDuringImport = mocks.createInnerAudioContext.mock.calls.length;
});

beforeEach(() => {
  mocks.getReader.mockReset();
  mocks.addReply.mockReset();
  mocks.createInnerAudioContext.mockReset();
  mocks.previewImage.mockReset();
  mocks.reLaunch.mockReset();
  mocks.showToast.mockReset();
  activeAudio = createAudioHarness();
  mocks.createInnerAudioContext.mockImplementation(() => activeAudio.context);
  mocks.getReader.mockResolvedValue(createLetter());
});

describe("reader page recovery", () => {
  it("keeps the font and load-error controls while exposing inline recovery actions", () => {
    const template = fileSystem.readFileSync(
      `${miniprogramDirectory}/src/pages/reader/index.wxml`,
      "utf8",
    );

    expect(template).toContain('data-value="normal"');
    expect(template).toContain('data-value="large"');
    expect(template).toContain('data-value="extra"');
    expect(template).toContain('bindtap="retryLoad"');
    expect(template).toContain('bindtap="backFromError"');
    expect(template).toContain('bindload="handleImageLoad"');
    expect(template).toContain('binderror="handleImageError"');
    expect(template).toContain('data-url="{{item.mediaUrl}}"');
    expect(template).toContain('data-attempt="{{item.imageAttempt}}"');
    expect(template).toContain('disabled="{{item.imageState !== \'ready\'}}"');
    expect(template).toContain('bindtap="retryImage"');
    expect(template).toContain("重新获取");
    expect(template).toContain('bindtap="retryVoice"');
    expect(template).toContain('bindtap="retryReply"');
    expect(template).toContain("重新发送");
    expect(template).toContain('wx:for="{{paragraphs}}"');
    expect(template).toContain('bindtap="toggleParagraphSources"');
    expect(template).toContain('aria-expanded="{{paragraph.sourcesExpanded}}"');
    expect(template).toContain("内容来源");
    expect(template).toContain('maxlength="{{replyLimit}}"');
    expect(template).toContain("{{replyCount}} / {{replyLimit}}");
    expect(template).toContain('aria-role="alert"');
    expect(template).toContain('aria-live="assertive"');
  });

  it("maps each paragraph to its exact sources and exposes manual or unavailable provenance", async () => {
    mocks.getReader.mockResolvedValueOnce(
      createLetter({
        draft: {
          ...createLetter().draft,
          paragraphs: [
            {
              id: "paragraph-traced",
              text: "这一段来自两份素材。",
              sourceRefs: ["voice-1", "photo-1", "voice-1"],
            },
            { id: "paragraph-manual", text: "这一段由写信人补充。", sourceRefs: [] },
            { id: "paragraph-missing", text: "这一段的来源已失效。", sourceRefs: ["missing-1"] },
          ],
        },
      }),
    );
    const context = createContext();

    await context.onLoad({ id: "letter-1", token: "share-token" });

    expect(context.data.paragraphs[0]).toEqual(
      expect.objectContaining({
        id: "paragraph-traced",
        sourceSummary: "语音、生活照片",
        sourceCount: 2,
        sourcesExpanded: false,
      }),
    );
    expect(context.data.paragraphs[0].sources).toEqual([
      expect.objectContaining({ id: "voice-1", typeLabel: "语音", name: "一句问候" }),
      expect.objectContaining({ id: "photo-1", typeLabel: "生活照片", name: "晚饭照片" }),
    ]);
    expect(context.data.paragraphs[1]).toEqual(
      expect.objectContaining({ sourceSummary: "写信人补充", sourceCount: 0 }),
    );
    expect(context.data.paragraphs[2].sources).toEqual([
      {
        id: "missing-1",
        typeLabel: "来源",
        name: "素材暂不可用",
        available: false,
      },
    ]);

    context.toggleParagraphSources({
      currentTarget: { dataset: { id: "paragraph-traced" } },
    });
    expect(context.data.paragraphs[0].sourcesExpanded).toBe(true);
    context.toggleParagraphSources({
      currentTarget: { dataset: { id: "paragraph-traced" } },
    });
    expect(context.data.paragraphs[0].sourcesExpanded).toBe(false);
  });

  it("keeps an expanded paragraph linked to refreshed source metadata", async () => {
    const refreshedLetter = createLetter({
      sources: [
        { ...createLetter().sources[0]!, name: "更新后的晚饭照片" },
        createLetter().sources[1]!,
      ],
    });
    mocks.getReader
      .mockResolvedValueOnce(createLetter())
      .mockResolvedValueOnce(refreshedLetter);
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    context.toggleParagraphSources({
      currentTarget: { dataset: { id: "paragraph-1" } },
    });

    await context.refreshMediaAccess();

    expect(context.data.paragraphs[0]).toEqual(
      expect.objectContaining({ sourcesExpanded: true }),
    );
    expect(context.data.paragraphs[0].sources[0].name).toBe("更新后的晚饭照片");
  });

  it("scales reply input, errors, count, and helper text in large modes", () => {
    const styles = fileSystem.readFileSync(
      `${miniprogramDirectory}/src/pages/reader/index.wxss`,
      "utf8",
    );

    expect(styles).toMatch(/\.font-large \.reply-input\s*\{[^}]*font-size: 34rpx;/s);
    expect(styles).toMatch(/\.font-extra \.reply-input\s*\{[^}]*font-size: 38rpx;/s);
    expect(styles).toContain(".font-large .reply-action-error-text,");
    expect(styles).toContain(".font-extra .reply-action-error-text,");
    expect(styles).toContain(".font-large .reply-helper,");
    expect(styles).toContain(".font-extra .reply-helper,");
    expect(styles).toContain(".font-large .reply-count {");
    expect(styles).toContain(".font-extra .reply-count {");
    expect(styles).toContain(".font-large .reader-error-detail {");
    expect(styles).toContain(".font-extra .reader-error-detail {");
  });

  it("counts visible reply characters and clears the count after delivery", async () => {
    mocks.addReply.mockResolvedValueOnce(createReply({ text: "好🙂" }));
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });

    context.updateReply({ detail: { value: "好🙂" } });
    expect(context.data.replyCount).toBe(2);

    await context.sendReply();

    expect(context.data.replyText).toBe("");
    expect(context.data.replyCount).toBe(0);
  });

  it("creates audio only during onLoad and cleans every handler during onUnload", async () => {
    expect(audioContextsCreatedDuringImport).toBe(0);
    const context = createContext();

    await context.onLoad({ id: "letter-1", token: "share-token" });

    expect(mocks.createInnerAudioContext).toHaveBeenCalledTimes(1);
    expect(activeAudio.context.onEnded).toHaveBeenCalledTimes(1);
    expect(activeAudio.context.onError).toHaveBeenCalledTimes(1);

    context.onUnload();

    expect(activeAudio.context.offEnded).toHaveBeenCalledWith(activeAudio.endedHandler);
    expect(activeAudio.context.offError).toHaveBeenCalledWith(activeAudio.errorHandler);
    expect(activeAudio.context.stop).toHaveBeenCalledTimes(1);
    expect(activeAudio.context.destroy).toHaveBeenCalledTimes(1);
    expect(context.audioContext).toBeNull();
  });

  it("hides a failed image and isolates a refreshed attempt even when its URL is unchanged", async () => {
    const refreshedLetter = createLetter({
      sources: [
        {
          id: "photo-1",
          type: "photo",
          name: "晚饭照片",
          mediaUrl: "https://media.example.com/photo-old.jpg",
          mediaExpiresAt: "2099-08-16T00:00:00.000Z",
        },
        createLetter().sources[1]!,
      ],
    });
    mocks.getReader
      .mockResolvedValueOnce(createLetter())
      .mockResolvedValueOnce(refreshedLetter);
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });

    expect(context.data.imageMaterials[0].imageState).toBe("loading");
    context.handleImageError({
      currentTarget: {
        dataset: {
          id: "photo-1",
          url: "https://media.example.com/photo-old.jpg",
          attempt: 0,
        },
      },
    });
    expect(context.data.imageMaterials[0]).toEqual(
      expect.objectContaining({
        imageState: "error",
        imageError: "图片加载失败，请重新获取。",
      }),
    );

    await context.retryImage({ currentTarget: { dataset: { id: "photo-1" } } });

    expect(context.data.letter.draft.title).toBe("这周的家书");
    expect(context.data.imageMaterials[0]).toEqual(
      expect.objectContaining({
        mediaUrl: "https://media.example.com/photo-old.jpg",
        imageState: "loading",
        imageAttempt: 1,
      }),
    );
    context.handleImageError({
      currentTarget: {
        dataset: {
          id: "photo-1",
          url: "https://media.example.com/photo-old.jpg",
          attempt: 0,
        },
      },
    });
    expect(context.data.imageMaterials[0].imageState).toBe("loading");
    context.handleImageLoad({
      currentTarget: {
        dataset: {
          id: "photo-1",
          url: "https://media.example.com/photo-old.jpg",
          attempt: 1,
        },
      },
    });
    await context.previewImage({ currentTarget: { dataset: { id: "photo-1" } } });

    expect(context.data.imageMaterials[0].imageState).toBe("ready");
    expect(mocks.previewImage).toHaveBeenCalledWith({
      current: "https://media.example.com/photo-old.jpg",
      urls: ["https://media.example.com/photo-old.jpg"],
    });
  });

  it("renders an expired image as a recoverable placeholder before loading bytes", async () => {
    const expiredLetter = createLetter({
      sources: [
        {
          ...createLetter().sources[0]!,
          mediaExpiresAt: "2020-08-16T00:00:00.000Z",
        },
        createLetter().sources[1]!,
      ],
    });
    mocks.getReader.mockResolvedValueOnce(expiredLetter);
    const context = createContext();

    await context.onLoad({ id: "letter-1", token: "share-token" });

    expect(context.data.imageMaterials[0]).toEqual(
      expect.objectContaining({
        imageState: "error",
        imageError: "图片访问已到期",
      }),
    );
    await context.previewImage({ currentTarget: { dataset: { id: "photo-1" } } });
    expect(mocks.previewImage).not.toHaveBeenCalled();
  });

  it("keeps the letter, reply draft, and old replies when media refresh fails", async () => {
    mocks.getReader
      .mockResolvedValueOnce(createLetter())
      .mockRejectedValueOnce(new Error("网络暂时不可用"));
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    context.setData({ replyText: "不会丢失的回复" });
    context.handleImageError({
      currentTarget: {
        dataset: {
          id: "photo-1",
          url: "https://media.example.com/photo-old.jpg",
          attempt: 0,
        },
      },
    });
    const retainedLetter = context.data.letter;
    const retainedReplies = context.data.replies;

    await context.retryImage({ currentTarget: { dataset: { id: "photo-1" } } });

    expect(context.data.letter).toBe(retainedLetter);
    expect(context.data.replies).toBe(retainedReplies);
    expect(context.data.replyText).toBe("不会丢失的回复");
    expect(context.data.loadError).toBe("");
    expect(context.data.imageMaterials[0]).toEqual(
      expect.objectContaining({
        imageState: "error",
        imageError: "图片重新获取失败，请稍后再试。",
      }),
    );
  });

  it("keeps audio failures visible, refreshes access, and retries playback", async () => {
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    const event = { currentTarget: { dataset: { id: "voice-1" } } };

    await context.playVoice(event);
    expect(activeAudio.context.src).toBe("https://media.example.com/voice-old.mp3");
    expect(activeAudio.context.play).toHaveBeenCalledTimes(1);
    activeAudio.errorHandler?.();

    expect(context.data.playingId).toBe("");
    expect(context.data.audioErrorId).toBe("voice-1");
    expect(context.data.audioError).toContain("重新播放");

    await context.retryVoice(event);

    expect(mocks.getReader).toHaveBeenCalledTimes(2);
    expect(activeAudio.context.play).toHaveBeenCalledTimes(2);
    expect(context.data.playingId).toBe("voice-1");
    expect(context.data.audioError).toBe("");
  });

  it("isolates stale callbacks when switching from a paused voice", async () => {
    const letter = createLetter({
      sources: [
        createLetter().sources[0]!,
        createLetter().sources[1]!,
        {
          id: "voice-2",
          type: "voice",
          name: "第二段问候",
          mediaUrl: "https://media.example.com/voice-two.mp3",
          mediaExpiresAt: "2099-08-16T00:00:00.000Z",
          durationSeconds: 5,
        },
      ],
    });
    mocks.getReader.mockResolvedValueOnce(letter);
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    const firstAudio = activeAudio;

    await context.playVoice({ currentTarget: { dataset: { id: "voice-1" } } });
    expect(firstAudio.context.play).toHaveBeenCalledTimes(1);
    await context.playVoice({ currentTarget: { dataset: { id: "voice-1" } } });
    expect(firstAudio.context.pause).toHaveBeenCalledTimes(1);
    expect(context.data.playingId).toBe("");

    const secondAudio = createAudioHarness();
    activeAudio = secondAudio;
    await context.playVoice({ currentTarget: { dataset: { id: "voice-2" } } });

    expect(firstAudio.context.offEnded).toHaveBeenCalledWith(firstAudio.endedHandler);
    expect(firstAudio.context.offError).toHaveBeenCalledWith(firstAudio.errorHandler);
    expect(firstAudio.context.stop).toHaveBeenCalledTimes(1);
    expect(firstAudio.context.destroy).toHaveBeenCalledTimes(1);
    expect(secondAudio.context.src).toBe("https://media.example.com/voice-two.mp3");
    expect(secondAudio.context.play).toHaveBeenCalledTimes(1);
    expect(context.data.playingId).toBe("voice-2");

    firstAudio.endedHandler?.();
    firstAudio.errorHandler?.();

    expect(context.data.playingId).toBe("voice-2");
    expect(context.data.audioErrorId).toBe("");
    expect(context.data.audioError).toBe("");
  });

  it("preserves reply input and old replies after failure, blocks duplicates, and retries with the same key", async () => {
    const failedRequest = createDeferred<Reply>();
    mocks.addReply.mockReturnValueOnce(failedRequest.promise);
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    context.updateReply({ detail: { value: "  我也想你们  " } });
    const retainedReplies = context.data.replies;

    const firstSend = context.sendReply();
    const duplicateSend = context.sendReply();
    expect(mocks.addReply).toHaveBeenCalledTimes(1);
    expect(context.data.sendingReply).toBe(true);
    const requestKey = mocks.addReply.mock.calls[0]?.[3];
    expect(requestKey).toEqual(expect.any(String));
    expect(requestKey).not.toBe("");

    failedRequest.reject(new Error("回复发送超时"));
    await Promise.all([firstSend, duplicateSend]);

    expect(context.data.replyText).toBe("  我也想你们  ");
    expect(context.data.replies).toBe(retainedReplies);
    expect(context.data.replyError).toBe("回复发送超时");

    mocks.addReply.mockResolvedValueOnce(createReply());
    await context.retryReply();

    expect(mocks.addReply).toHaveBeenLastCalledWith(
      "letter-1",
      "我也想你们",
      "share-token",
      requestKey,
    );
    expect(mocks.addReply.mock.calls[1]?.[3]).toBe(requestKey);
    expect(context.data.replyText).toBe("");
    expect(context.data.replyError).toBe("");
    expect(context.data.replies.map((reply: { id: string }) => reply.id)).toEqual([
      "reply-old",
      "reply-new",
    ]);
  });

  it("keeps newer input when a pending reply succeeds", async () => {
    const pendingReply = createDeferred<Reply>();
    mocks.addReply.mockReturnValueOnce(pendingReply.promise);
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    context.updateReply({ detail: { value: "先发送这一句" } });

    const send = context.sendReply();
    context.updateReply({ detail: { value: "这是下一条还没发送的回复" } });
    pendingReply.resolve(createReply({ text: "先发送这一句" }));
    await send;

    expect(context.data.replyText).toBe("这是下一条还没发送的回复");
    expect(context.data.replies.map((reply: Reply) => reply.id)).toEqual([
      "reply-old",
      "reply-new",
    ]);
    expect(context.data.letter.replies.map((reply: Reply) => reply.id)).toEqual([
      "reply-old",
      "reply-new",
    ]);
  });

  it("does not lose a submitted reply when an older media refresh finishes later", async () => {
    const mediaRefresh = createDeferred<ReaderLetter>();
    const pendingReply = createDeferred<Reply>();
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    mocks.getReader.mockReturnValueOnce(mediaRefresh.promise);
    mocks.addReply.mockReturnValueOnce(pendingReply.promise);

    const refresh = context.refreshMediaAccess();
    context.updateReply({ detail: { value: "媒体刷新时发送的回复" } });
    const send = context.sendReply();
    pendingReply.resolve(createReply({ text: "媒体刷新时发送的回复" }));
    await send;

    mediaRefresh.resolve(
      createLetter({
        sources: [
          {
            ...createLetter().sources[0]!,
            mediaUrl: "https://media.example.com/photo-refreshed.jpg",
          },
          createLetter().sources[1]!,
        ],
      }),
    );
    await refresh;

    expect(context.data.imageMaterials[0].mediaUrl).toBe(
      "https://media.example.com/photo-refreshed.jpg",
    );
    expect(context.data.replies.map((reply: Reply) => reply.id)).toEqual([
      "reply-old",
      "reply-new",
    ]);
    expect(context.data.letter.replies.map((reply: Reply) => reply.id)).toEqual([
      "reply-old",
      "reply-new",
    ]);
  });

  it("ignores media and reply completions after the page unloads", async () => {
    const mediaRefresh = createDeferred<ReaderLetter>();
    const pendingReply = createDeferred<Reply>();
    const context = createContext();
    await context.onLoad({ id: "letter-1", token: "share-token" });
    mocks.getReader.mockReturnValueOnce(mediaRefresh.promise);
    mocks.addReply.mockReturnValueOnce(pendingReply.promise);
    const postUnloadWrites: Record<string, unknown>[] = [];
    const applyData = context.setData.bind(context);
    context.setData = (patch: Record<string, unknown>) => {
      if (context.disposed) postUnloadWrites.push(patch);
      applyData(patch);
    };

    const refresh = context.refreshMediaAccess();
    context.updateReply({ detail: { value: "离开页面前发送" } });
    const send = context.sendReply();
    context.onUnload();

    mediaRefresh.resolve(
      createLetter({
        draft: { ...createLetter().draft, title: "不应写入的刷新结果" },
      }),
    );
    pendingReply.resolve(createReply({ text: "离开页面前发送" }));
    await Promise.all([refresh, send]);

    expect(postUnloadWrites).toEqual([]);
    expect(context.data.letter.draft.title).toBe("这周的家书");
    expect(context.data.replies.map((reply: Reply) => reply.id)).toEqual(["reply-old"]);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
