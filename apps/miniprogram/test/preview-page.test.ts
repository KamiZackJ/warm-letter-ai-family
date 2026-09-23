import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Letter, Material, SpeechCatalog } from "../src/types/domain";

type FileSystemModule = {
  readFileSync(path: string, encoding: "utf8"): string;
};

const runtimeProcess = (globalThis as unknown as {
  process: { cwd(): string; getBuiltinModule(name: string): unknown };
}).process;
const fileSystem = runtimeProcess.getBuiltinModule("node:fs") as FileSystemModule;
const normalizedWorkingDirectory = runtimeProcess.cwd().replace(/\\/g, "/");
const miniprogramDirectory = normalizedWorkingDirectory.endsWith("/apps/miniprogram")
  ? normalizedWorkingDirectory
  : `${normalizedWorkingDirectory}/apps/miniprogram`;

const mocks = vi.hoisted(() => ({
  getLetter: vi.fn(),
  listMaterials: vi.fn(),
  getSpeechCatalog: vi.fn(),
  generateNarration: vi.fn(),
  generateLetter: vi.fn(),
  confirmLetter: vi.fn(),
  reissueShare: vi.fn(),
  createInnerAudioContext: vi.fn(),
  hideShareMenu: vi.fn(),
  showShareMenu: vi.fn(),
  showModal: vi.fn(),
  showToast: vi.fn(),
  previewImage: vi.fn(),
  navigateBack: vi.fn(),
  redirectTo: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("../src/services/api", () => ({
  api: {
    getLetter: mocks.getLetter,
    listMaterials: mocks.listMaterials,
    getSpeechCatalog: mocks.getSpeechCatalog,
    generateNarration: mocks.generateNarration,
    generateLetter: mocks.generateLetter,
    confirmLetter: mocks.confirmLetter,
    reissueShare: mocks.reissueShare,
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

const letter: Letter = {
  id: "letter-1",
  status: "EDITING",
  materialIds: ["photo-1"],
  intent: {
    recipient: "妈妈",
    message: "最近很好",
    tone: "warm",
    length: "medium",
    focus: "让她放心",
    exclusions: "",
  },
  draft: {
    title: "写给妈妈的一封信",
    salutation: "妈妈：",
    paragraphs: [
      {
        id: "paragraph-1",
        text: "最近一切都好。",
        sourceRefs: ["photo-1"],
        sourceAttribution: "ai",
      },
    ],
    closing: "祝安",
    signature: "小暖",
  },
  replies: [],
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
};

const photo: Material = {
  id: "photo-1",
  type: "photo",
  name: "今天的照片",
  localPath: "wxfile://photo-1.jpg",
  createdAt: "2026-09-17T00:00:00.000Z",
};

const speechCatalog: SpeechCatalog = {
  available: true,
  provider: "qwen3-tts-flash",
  voices: [
    { id: "Cherry", name: "芊悦", description: "温柔清晰", gender: "female" },
  ],
};

let pageDefinition: PageDefinition;
let audioContext: {
  src: string;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  onEnded: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

function createContext(data: Record<string, unknown> = {}): PageContext {
  const pageData = { ...structuredClone(pageDefinition.data), ...data };
  return {
    ...pageDefinition,
    disposed: false,
    audioContext: null,
    generatedFilePath: "",
    data: pageData,
    setData(patch: Record<string, unknown>) {
      Object.assign(pageData, patch);
    },
  } as PageContext;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      env: { USER_DATA_PATH: "/wx-user-data" },
      createInnerAudioContext: mocks.createInnerAudioContext,
      hideShareMenu: mocks.hideShareMenu,
      showShareMenu: mocks.showShareMenu,
      showModal: mocks.showModal,
      showToast: mocks.showToast,
      previewImage: mocks.previewImage,
      navigateBack: mocks.navigateBack,
      redirectTo: mocks.redirectTo,
      getFileSystemManager: () => ({ unlink: mocks.unlink }),
    },
    Page: (definition: PageDefinition) => {
      pageDefinition = definition;
    },
  });
  await import("../src/pages/preview/index");
});

beforeEach(() => {
  vi.clearAllMocks();
  audioContext = {
    src: "",
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    onEnded: vi.fn(),
    onError: vi.fn(),
  };
  mocks.createInnerAudioContext.mockReturnValue(audioContext);
  mocks.getLetter.mockResolvedValue(structuredClone(letter));
  mocks.listMaterials.mockResolvedValue([structuredClone(photo)]);
  mocks.getSpeechCatalog.mockResolvedValue(structuredClone(speechCatalog));
  mocks.generateNarration.mockResolvedValue({
    filePath: "/wx-user-data/warm-letter-narration-letter-1.wav",
    contentType: "audio/wav",
  });
  mocks.generateLetter.mockResolvedValue(structuredClone(letter));
  mocks.confirmLetter.mockResolvedValue({
    ...structuredClone(letter),
    status: "PUBLISHED",
    shareToken: "share-token",
  });
  mocks.reissueShare.mockResolvedValue({
    ...structuredClone(letter),
    status: "PUBLISHED",
    shareToken: "restored-share-token",
  });
  mocks.showModal.mockImplementation((options: { success(result: { confirm: boolean }): void }) => {
    options.success({ confirm: true });
  });
});

describe("letter preview and delivery page", () => {
  it("keeps pending safety checks visible without enabling sharing and allows a later retry", async () => {
    const message = "图片或录音仍在安全检查中，家书尚未寄出。草稿已保存，请稍后回来确认。";
    mocks.confirmLetter.mockRejectedValueOnce(new Error(message));
    const page = createContext({ letterId: "letter-1", letter: structuredClone(letter) });
    await page.confirmForShare();
    expect(page.data.confirming).toBe(false);
    expect(page.data.shareReady).toBe(false);
    expect(page.data.confirmError).toBe(message);
    expect(mocks.showShareMenu).not.toHaveBeenCalled();
    await page.confirmForShare();
    expect(page.data.confirmError).toBe("");
    expect(page.data.shareReady).toBe(true);
  });
  it("exposes preview, rewrite, narration, and native WeChat friend sharing controls", () => {
    const template = fileSystem.readFileSync(
      `${miniprogramDirectory}/src/pages/preview/index.wxml`,
      "utf8",
    );
    expect(template).toContain("先看看家人会收到什么");
    expect(template).toContain('bindtap="regenerate"');
    expect(template).toContain("换一版文字");
    expect(template).toContain('bindtap="generateNarration"');
    expect(template).toContain("生成并试听朗读");
    expect(template).toContain('open-type="share"');
    expect(template).toContain("选择微信好友寄出");
  });

  it("loads the saved draft, chosen recipient label, source photos, and Qwen voices", async () => {
    const context = createContext();
    context.setupAudio();
    await context.onLoad({ id: "letter-1" });

    expect(context.data.letter.intent.recipient).toBe("妈妈");
    expect(context.data.photos).toEqual([photo]);
    expect(context.data.speechCatalog).toEqual(speechCatalog);
    expect(mocks.hideShareMenu).toHaveBeenCalled();
  });

  it("restores native friend sharing when a published page is reopened without a token", async () => {
    mocks.getLetter.mockResolvedValue({
      ...structuredClone(letter),
      status: "PUBLISHED",
      shareToken: undefined,
    });
    const context = createContext();
    context.setupAudio();
    await context.onLoad({ id: "letter-1" });

    expect(mocks.reissueShare).toHaveBeenCalledWith("letter-1");
    expect(context.data.shareReady).toBe(true);
    expect(context.data.shareToken).toBe("restored-share-token");
    expect(mocks.showShareMenu).toHaveBeenCalledWith({ menus: ["shareAppMessage"] });
  });

  it("generates and immediately previews the selected AI narration", async () => {
    const context = createContext({
      letterId: "letter-1",
      letter: structuredClone(letter),
      speechCatalog: structuredClone(speechCatalog),
      selectedVoiceIndex: 0,
    });
    context.setupAudio();
    await context.generateNarration();

    expect(mocks.generateNarration).toHaveBeenCalledWith(
      "letter-1",
      letter.draft,
      "Cherry",
      "warm",
    );
    expect(context.data.speechPath).toContain("warm-letter-narration-letter-1.wav");
    expect(audioContext.play).toHaveBeenCalledTimes(1);
  });

  it("confirms content before enabling the native share panel", async () => {
    const context = createContext({
      letterId: "letter-1",
      letter: structuredClone(letter),
    });
    await context.confirmForShare();

    expect(mocks.confirmLetter).toHaveBeenCalledWith("letter-1", letter.draft);
    expect(context.data.shareReady).toBe(true);
    expect(context.data.shareToken).toBe("share-token");
    expect(mocks.showShareMenu).toHaveBeenCalledWith({ menus: ["shareAppMessage"] });
    expect(context.onShareAppMessage()).toEqual({
      title: "写给妈妈的一封信",
      path: "/pages/reader/index?id=letter-1&token=share-token",
    });
  });

  it("returns a regenerated audio draft to the editor when its sources need review", async () => {
    const generated = structuredClone(letter);
    generated.draft!.paragraphs[0]!.sourceAttribution = "needs-review";
    mocks.generateLetter.mockResolvedValue(generated);
    const context = createContext({ letterId: "letter-1", letter: structuredClone(letter) });
    context.setupAudio();
    await context.regenerate();
    expect(mocks.redirectTo).toHaveBeenCalledWith({ url: "/pages/editor/index?id=letter-1" });
    expect(mocks.confirmLetter).not.toHaveBeenCalled();
    expect(context.data.regenerating).toBe(false);
  });

  it("routes a direct preview of a pending transcript correction back to editing", async () => {
    mocks.getLetter.mockResolvedValue({ ...structuredClone(letter), audioTranscriptRevisionPending: true });
    const context = createContext();
    await context.onLoad({ id: "letter-1" });
    expect(mocks.redirectTo).toHaveBeenCalledWith({ url: "/pages/editor/index?id=letter-1" });
    expect(mocks.showShareMenu).not.toHaveBeenCalled();
  });

  it("keeps the latest preview load when an older response arrives afterward", async () => {
    const old = deferred<Letter>();
    mocks.getLetter.mockReturnValueOnce(old.promise);
    const context = createContext({ letterId: "letter-1" });
    const first = context.loadPreview();
    const latest = structuredClone(letter);
    latest.draft!.title = "最新草稿";
    mocks.getLetter.mockResolvedValueOnce(latest);
    await context.loadPreview();
    expect(context.data.letter.draft.title).toBe("最新草稿");
    old.resolve({ ...structuredClone(letter), status: "PUBLISHED", shareToken: undefined });
    await first;
    expect(context.data.letter.draft.title).toBe("最新草稿");
    expect(context.data.loading).toBe(false);
    expect(mocks.reissueShare).not.toHaveBeenCalled();
  });

  it("stops on hide and stores a hidden narration result without automatically playing it", async () => {
    const pending = deferred<{ filePath: string; contentType: string }>();
    mocks.generateNarration.mockReturnValueOnce(pending.promise);
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: structuredClone(speechCatalog),
    });
    context.setupAudio();
    const generation = context.generateNarration();
    context.onHide();
    expect(audioContext.stop).toHaveBeenCalled();
    pending.resolve({ filePath: "/wx-user-data/warm-letter-narration-hidden.wav", contentType: "audio/wav" });
    await generation;
    expect(context.data.speechLoading).toBe(false);
    expect(context.data.speechPlaying).toBe(false);
    expect(audioContext.play).not.toHaveBeenCalled();
    context.onShow();
    expect(audioContext.play).not.toHaveBeenCalled();
    context.toggleNarration();
    expect(audioContext.play).toHaveBeenCalledTimes(1);
  });

  it("deletes a narration file that arrives after the preview was unloaded", async () => {
    const pending = deferred<{ filePath: string; contentType: string }>();
    mocks.generateNarration.mockReturnValueOnce(pending.promise);
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: structuredClone(speechCatalog),
    });
    context.setupAudio();
    const generation = context.generateNarration();
    context.onUnload();
    const dataAtUnload = structuredClone(context.data);
    pending.resolve({ filePath: "/wx-user-data/warm-letter-narration-late.wav", contentType: "audio/wav" });
    await generation;
    expect(context.data).toEqual(dataAtUnload);
    expect(context.generatedFilePath).toBe("");
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/wx-user-data/warm-letter-narration-late.wav" }));
    expect(audioContext.play).not.toHaveBeenCalled();
    expect(audioContext.destroy).toHaveBeenCalled();
  });

  it("prevents rewriting, confirmation, voice changes and editing during narration generation", async () => {
    const pending = deferred<{ filePath: string; contentType: string }>();
    mocks.generateNarration.mockReturnValueOnce(pending.promise);
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: structuredClone(speechCatalog),
    });
    context.setupAudio();
    const generation = context.generateNarration();
    await context.regenerate();
    await context.confirmForShare();
    context.chooseVoice({ detail: { value: 1 } });
    context.editLetter();
    await context.generateNarration();
    expect(mocks.generateLetter).not.toHaveBeenCalled();
    expect(mocks.confirmLetter).not.toHaveBeenCalled();
    expect(mocks.showModal).not.toHaveBeenCalled();
    expect(mocks.navigateBack).not.toHaveBeenCalled();
    expect(context.data.selectedVoiceIndex).toBe(0);
    expect(mocks.generateNarration).toHaveBeenCalledTimes(1);
    pending.reject(new Error("朗读暂时不可用"));
    await generation;
    expect(context.data.speechLoading).toBe(false);
    await context.generateNarration();
    expect(mocks.generateNarration).toHaveBeenCalledTimes(2);
    expect(context.data.speechError).toBe("");
  });

  it("locks confirmation before its dialog settles and unlocks if the sender cancels", async () => {
    let decide!: (result: { confirm: boolean }) => void;
    mocks.showModal.mockImplementationOnce((options) => { decide = options.success; });
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: structuredClone(speechCatalog),
    });
    const confirmation = context.confirmForShare();
    await context.confirmForShare();
    await context.regenerate();
    await context.generateNarration();
    context.editLetter();
    expect(mocks.showModal).toHaveBeenCalledTimes(1);
    expect(mocks.generateLetter).not.toHaveBeenCalled();
    expect(mocks.generateNarration).not.toHaveBeenCalled();
    expect(mocks.navigateBack).not.toHaveBeenCalled();
    decide({ confirm: false });
    await confirmation;
    expect(context.data.confirming).toBe(false);
    expect(mocks.confirmLetter).not.toHaveBeenCalled();
    await context.confirmForShare();
    expect(mocks.confirmLetter).toHaveBeenCalledTimes(1);
  });

  it("keeps the actual generated voice visible and requires applying or restoring a voice change before sharing", async () => {
    const catalog = structuredClone(speechCatalog);
    catalog.voices.push({ id: "Serena", name: "另一声音", description: "清晰", gender: "female" });
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: catalog,
    });
    context.setupAudio();
    await context.generateNarration();
    context.chooseVoice({ detail: { value: 1 } });
    expect(context.data.selectedVoiceIndex).toBe(1);
    expect(context.data.speechPath).toContain("warm-letter-narration-letter-1.wav");
    expect(context.data.speechPlaying).toBe(false);
    expect(context.data.generatedVoiceName).toBe("芊悦");
    expect(context.data.voiceChangePending).toBe(true);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(audioContext.stop).toHaveBeenCalled();
    await context.confirmForShare();
    expect(mocks.confirmLetter).not.toHaveBeenCalled();
    context.chooseVoice({ detail: { value: 0 } });
    expect(context.data.voiceChangePending).toBe(false);
    await context.confirmForShare();
    expect(mocks.confirmLetter).toHaveBeenCalledTimes(1);
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("芊悦") }));
  });

  it("applies the newly selected voice only after successful generation, then allows sharing", async () => {
    const catalog = structuredClone(speechCatalog);
    catalog.voices.push({ id: "Serena", name: "另一声音", description: "清晰", gender: "female" });
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: catalog,
    });
    context.setupAudio();
    await context.generateNarration();
    context.chooseVoice({ detail: { value: 1 } });
    mocks.generateNarration.mockResolvedValueOnce({
      filePath: "/wx-user-data/warm-letter-narration-voice-b.wav", contentType: "audio/wav",
    });
    await context.generateNarration();
    expect(context.data.generatedVoiceName).toBe("另一声音");
    expect(context.data.persistedVoiceKnown).toBe(true);
    expect(context.data.voiceChangePending).toBe(false);
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/wx-user-data/warm-letter-narration-letter-1.wav" }));
    await context.confirmForShare();
    expect(mocks.confirmLetter).toHaveBeenCalledTimes(1);
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("另一声音") }));
  });

  it("does not assume a failed replacement left the old saved voice intact", async () => {
    const catalog = structuredClone(speechCatalog);
    catalog.voices.push({ id: "Serena", name: "另一声音", description: "清晰", gender: "female" });
    const context = createContext({
      letterId: "letter-1", letter: structuredClone(letter), speechCatalog: catalog,
    });
    context.setupAudio();
    await context.generateNarration();
    context.chooseVoice({ detail: { value: 1 } });
    mocks.generateNarration.mockRejectedValueOnce(new Error("网络请求超时，请重试"));
    await context.generateNarration();
    expect(context.data.persistedVoiceKnown).toBe(false);
    expect(context.data.voiceChangePending).toBe(true);
    expect(context.data.speechPath).toContain("warm-letter-narration-letter-1.wav");
    context.chooseVoice({ detail: { value: 0 } });
    await context.confirmForShare();
    expect(mocks.confirmLetter).not.toHaveBeenCalled();
    context.keepSavedNarration();
    await context.confirmForShare();
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("如果之前生成过朗读，会随信一起寄出") }));
    expect(mocks.confirmLetter).toHaveBeenCalledTimes(1);
  });

  it("does not identify the default picker voice as saved narration when reopening a letter", async () => {
    const catalog = structuredClone(speechCatalog);
    catalog.voices.push({ id: "Serena", name: "另一声音", description: "清晰", gender: "female" });
    mocks.getSpeechCatalog.mockResolvedValue(catalog);
    // Owner letter data intentionally omits private server narration. Reopening
    // cannot prove that the default picker voice is the previously saved one.
    const context = createContext();
    await context.onLoad({ id: "letter-1" });
    expect(context.data.persistedVoiceKnown).toBe(false);
    expect(context.data.generatedVoiceName).toBe("");
    context.chooseVoice({ detail: { value: 1 } });
    await context.confirmForShare();
    expect(mocks.confirmLetter).not.toHaveBeenCalled();
    context.keepSavedNarration();
    await context.confirmForShare();
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("如果之前生成过朗读，会随信一起寄出") }));
    expect(mocks.confirmLetter).toHaveBeenCalledTimes(1);
  });
});
