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
});
