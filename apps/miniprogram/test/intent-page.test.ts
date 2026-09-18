import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationJobFailedError, GenerationPollingTimeoutError } from "../src/services/generation-polling";

const mocks = vi.hoisted(() => ({
  createLetter: vi.fn(),
  generateLetter: vi.fn(),
  showToast: vi.fn(),
  redirectTo: vi.fn(),
  reLaunch: vi.fn(),
  getCurrentMaterialIds: vi.fn(),
  getPendingGeneration: vi.fn(),
  savePendingGeneration: vi.fn(),
  clearPendingGeneration: vi.fn(),
}));

vi.mock("../src/services/api", () => ({
  api: {
    createLetter: mocks.createLetter,
    generateLetter: mocks.generateLetter,
  },
}));
vi.mock("../src/config/env", () => ({
  environment: { demoEnabled: false },
  environmentView: {},
}));
vi.mock("../src/config/runtime-environment", () => ({
  resolveDemoRequest: () => false,
}));
vi.mock("../src/utils/storage", () => ({
  getCurrentMaterialIds: mocks.getCurrentMaterialIds,
  getPendingGeneration: mocks.getPendingGeneration,
  savePendingGeneration: mocks.savePendingGeneration,
  clearPendingGeneration: mocks.clearPendingGeneration,
}));

type PageDefinition = {
  data: Record<string, unknown>;
  [key: string]: unknown;
};

type PageContext = PageDefinition & {
  data: Record<string, any>;
  setData(patch: Record<string, unknown>): void;
  [key: string]: any;
};

let pageDefinition: PageDefinition;

function createContext(): PageContext {
  const pageData = {
    ...pageDefinition.data,
    recipient: "妈妈",
    message: "今天工作顺利，想和你报个平安。",
    tone: "warm",
    length: "short",
    focus: "",
    exclusions: "",
  };
  return {
    ...pageDefinition,
    data: pageData,
    disposed: false,
    generationTimer: undefined,
    setData(patch: Record<string, unknown>) {
      Object.assign(pageData, patch);
    },
  } as PageContext;
}

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      showToast: mocks.showToast,
      redirectTo: mocks.redirectTo,
      reLaunch: mocks.reLaunch,
    },
    Page: (definition: PageDefinition) => {
      pageDefinition = definition;
    },
  });
  await import("../src/pages/intent/index");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentMaterialIds.mockReturnValue(["material-1"]);
  mocks.getPendingGeneration.mockReturnValue(undefined);
  mocks.createLetter.mockResolvedValue({ id: "letter-1" });
  mocks.generateLetter.mockRejectedValue(new GenerationPollingTimeoutError());
});

describe("intent generation waiting experience", () => {
  it("keeps a failed provider timeout available for manual retry without treating it as a background task", async () => {
    const message = "AI 处理超时，本次已停止，请重试生成";
    mocks.generateLetter.mockRejectedValueOnce(
      new GenerationJobFailedError(message, "AI_PROVIDER_TIMEOUT", true),
    );
    const context = createContext();

    await context.generate();

    expect(context.data.generating).toBe(false);
    expect(context.data.generationTimedOut).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith({ title: message, icon: "none" });
    expect(mocks.redirectTo).not.toHaveBeenCalled();
    expect(mocks.clearPendingGeneration).not.toHaveBeenCalled();
    expect(mocks.generateLetter).toHaveBeenCalledTimes(1);

    expect(mocks.savePendingGeneration).toHaveBeenCalledTimes(1);
    const [pending] = mocks.savePendingGeneration.mock.calls[0]!;
    mocks.getPendingGeneration.mockReturnValue(pending);
    mocks.generateLetter.mockResolvedValueOnce({ id: "letter-1" });
    await context.generate();

    expect(mocks.createLetter).toHaveBeenCalledTimes(1);
    expect(mocks.generateLetter).toHaveBeenCalledTimes(2);
    expect(mocks.generateLetter).toHaveBeenLastCalledWith("letter-1");
    expect(mocks.redirectTo).toHaveBeenCalledWith({ url: "/pages/editor/index?id=letter-1" });
  });

  it("keeps a timed-out job in the background instead of reopening the editor", async () => {
    const context = createContext();

    await context.generate();

    expect(mocks.createLetter).toHaveBeenCalledTimes(1);
    expect(mocks.generateLetter).toHaveBeenCalledWith("letter-1");
    expect(mocks.redirectTo).not.toHaveBeenCalled();
    expect(context.data.generating).toBe(false);
    expect(context.data.generationTimedOut).toBe(true);
    expect(context.data.generationStageLabel).toBe("已转到后台整理");

    context.continueLater();
    expect(mocks.reLaunch).toHaveBeenCalledWith({ url: "/pages/home/index" });
  });

  it("maps elapsed time to honest, non-terminal progress stages", async () => {
    const { generationStageForElapsedSeconds } = await import("../src/pages/intent/index");

    expect(generationStageForElapsedSeconds(0).label).toBe("正在准备素材");
    expect(generationStageForElapsedSeconds(30).label).toBe("正在理解图片和语音");
    expect(generationStageForElapsedSeconds(100).label).toBe("正在整理家书");
    expect(generationStageForElapsedSeconds(180).progress).toBeLessThan(100);
  });
});
