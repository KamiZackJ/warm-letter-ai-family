import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LetterSummary } from "../src/types/domain";

const mocks = vi.hoisted(() => ({
  listLetters: vi.fn(),
  showToast: vi.fn(),
  navigateTo: vi.fn(),
  clearPendingGeneration: vi.fn(),
  beginCurrentMaterialSelection: vi.fn(),
  getCurrentMaterialSelection: vi.fn(),
  getPendingGeneration: vi.fn(),
  restoreCurrentMaterialSelection: vi.fn(),
  savePendingGeneration: vi.fn(),
}));

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

function cssRule(source: string, selector: string): string {
  const rule = source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!rule?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return rule[1];
}

function relativeLuminance(hexColor: string): number {
  const channels = hexColor
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hexColor}`);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

vi.mock("../src/services/api", () => ({
  api: { listLetters: mocks.listLetters },
}));
vi.mock("../src/config/env", () => ({
  environment: { demoEnabled: true },
  environmentView: {},
}));
vi.mock("../src/utils/storage", () => ({
  clearPendingGeneration: mocks.clearPendingGeneration,
  beginCurrentMaterialSelection: mocks.beginCurrentMaterialSelection,
  getCurrentMaterialSelection: mocks.getCurrentMaterialSelection,
  getPendingGeneration: mocks.getPendingGeneration,
  restoreCurrentMaterialSelection: mocks.restoreCurrentMaterialSelection,
  savePendingGeneration: mocks.savePendingGeneration,
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

function createLetter(id: string): LetterSummary {
  return {
    id,
    title: `写给家人的信 ${id}`,
    status: "EDITING",
    intent: {
      recipient: "妈妈",
      message: "报平安",
      tone: "warm",
      length: "medium",
      focus: "近况",
      exclusions: "",
    },
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: "2026-08-16T08:00:00.000Z",
  };
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

function createContext(data: Record<string, unknown> = {}): PageContext {
  const pageData = {
    ...pageDefinition.data,
    recentLetters: [],
    ...data,
  };
  return {
    ...pageDefinition,
    data: pageData,
    setData(patch: Record<string, unknown>) {
      Object.assign(pageData, patch);
    },
  } as PageContext;
}

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      showToast: mocks.showToast,
      navigateTo: mocks.navigateTo,
    },
    Page: (definition: PageDefinition) => {
      pageDefinition = definition;
    },
  });

  await import("../src/pages/home/index");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listLetters.mockResolvedValue([]);
  mocks.beginCurrentMaterialSelection.mockReturnValue("materials-new");
  mocks.getCurrentMaterialSelection.mockReturnValue({
    sessionId: "materials-previous",
    revision: 2,
    ids: ["previous-material"],
  });
  mocks.getPendingGeneration.mockReturnValue({
    letterId: "pending-letter",
    fingerprint: "pending-fingerprint",
  });
  mocks.restoreCurrentMaterialSelection.mockReturnValue(true);
});

describe("home page recent letters recovery", () => {
  it("keeps the local-draft note readable and recent-letter text multiline", () => {
    const styles = fileSystem.readFileSync(
      `${miniprogramDirectory}/src/pages/home/index.wxss`,
      "utf8",
    );
    const appStyles = fileSystem.readFileSync(`${miniprogramDirectory}/src/app.wxss`, "utf8");
    const noteRule = cssRule(styles, "\\.section-note");
    const recentTextRule = cssRule(styles, "\\.letter-title,\\s*\\.letter-meta");
    const noteColor = noteRule.match(/color:\s*(#[0-9a-f]{6})/i)?.[1];
    const pageBackground = cssRule(appStyles, "page").match(
      /background:\s*(#[0-9a-f]{6})/i,
    )?.[1];

    expect(noteRule).toContain("font-size: 28rpx");
    expect(noteColor).toBeDefined();
    expect(pageBackground).toBeDefined();
    expect(contrastRatio(noteColor!, pageBackground!)).toBeGreaterThanOrEqual(4.5);
    expect(recentTextRule).toContain("white-space: normal");
    expect(recentTextRule).toContain("overflow-wrap: anywhere");
    expect(recentTextRule).toContain("-webkit-line-clamp: 2");
    expect(recentTextRule).not.toContain("text-overflow: ellipsis");
  });

  it("keeps retained letters visible beside a persistent load error", () => {
    const template = fileSystem.readFileSync(
      `${miniprogramDirectory}/src/pages/home/index.wxml`,
      "utf8",
    );

    expect(template).toContain('wx:if="{{loadError}}"');
    expect(template).toContain('wx:elif="{{recentLetters.length > 0}}"');
    expect(template).toContain('disabled="{{startingFlow}}"');
    expect(template).toContain('loading="{{startingFlow}}"');
  });

  it("does not present a failed load as an empty history and retries only once", async () => {
    const retained = createLetter("retained");
    const loaded = createLetter("loaded");
    const retry = createDeferred<LetterSummary[]>();
    mocks.listLetters
      .mockRejectedValueOnce(new Error("最近家书读取失败"))
      .mockReturnValueOnce(retry.promise);
    const context = createContext({ recentLetters: [retained] });

    await context.loadLetters();

    expect(context.data.loading).toBe(false);
    expect(context.data.loadError).toBe("最近家书读取失败");
    expect(context.data.recentLetters).toEqual([retained]);

    const firstRetry = context.retryLetters();
    const duplicateRetry = context.retryLetters();
    expect(context.data.loading).toBe(true);
    expect(context.data.loadError).toBe("最近家书读取失败");
    expect(mocks.listLetters).toHaveBeenCalledTimes(2);

    retry.resolve([loaded]);
    await Promise.all([firstRetry, duplicateRetry]);

    expect(context.data.loading).toBe(false);
    expect(context.data.loadError).toBe("");
    expect(context.data.recentLetters).toEqual([
      expect.objectContaining({
        id: loaded.id,
        title: loaded.title,
        statusLabel: "待确认",
      }),
    ]);
  });

  it("keeps a persistent error when the retry also fails", async () => {
    mocks.listLetters
      .mockRejectedValueOnce(new Error("第一次读取失败"))
      .mockRejectedValueOnce(new Error("网络仍不可用"));
    const context = createContext();

    await context.loadLetters();
    await context.retryLetters();

    expect(context.data.loading).toBe(false);
    expect(context.data.loadError).toBe("网络仍不可用");
    expect(context.data.recentLetters).toEqual([]);
    expect(mocks.showToast).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest result when overlapping loads finish out of order", async () => {
    const older = createDeferred<LetterSummary[]>();
    const newer = createDeferred<LetterSummary[]>();
    mocks.listLetters
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const context = createContext();

    const olderLoad = context.loadLetters();
    const newerLoad = context.loadLetters();
    newer.resolve([createLetter("newer")]);
    await newerLoad;
    older.resolve([createLetter("older")]);
    await olderLoad;

    expect(context.data.loading).toBe(false);
    expect(context.data.loadError).toBe("");
    expect(context.data.recentLetters.map((letter: LetterSummary) => letter.id)).toEqual([
      "newer",
    ]);
  });

  it("binds navigation to one material session and ignores a duplicate start", () => {
    const context = createContext();

    context.startLetter();
    context.startLetter();

    expect(context.data.startingFlow).toBe(true);
    expect(mocks.clearPendingGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.beginCurrentMaterialSelection).toHaveBeenCalledTimes(1);
    expect(mocks.navigateTo).toHaveBeenCalledTimes(1);
    expect(mocks.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/pages/materials/index?session=materials-new",
        fail: expect.any(Function),
      }),
    );
  });

  it("restores the previous draft state and unlocks after navigation failure", () => {
    const context = createContext();

    context.startLetter();
    const navigation = mocks.navigateTo.mock.calls[0]?.[0] as { fail(): void };
    navigation.fail();

    expect(mocks.restoreCurrentMaterialSelection).toHaveBeenCalledWith(
      "materials-new",
      {
        sessionId: "materials-previous",
        revision: 2,
        ids: ["previous-material"],
      },
    );
    expect(mocks.savePendingGeneration).toHaveBeenCalledWith({
      letterId: "pending-letter",
      fingerprint: "pending-fingerprint",
    });
    expect(context.data.startingFlow).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "暂时无法打开素材页，请重试",
      icon: "none",
    });
  });

  it("unlocks the start action when local selection recovery cannot be read", () => {
    const context = createContext();
    mocks.getCurrentMaterialSelection.mockImplementationOnce(() => {
      throw new Error("storage read failed");
    });

    context.startLetter();

    expect(context.data.startingFlow).toBe(false);
    expect(mocks.clearPendingGeneration).not.toHaveBeenCalled();
    expect(mocks.beginCurrentMaterialSelection).not.toHaveBeenCalled();
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.savePendingGeneration).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "暂时无法开始新家书，请重试",
      icon: "none",
    });
  });

  it("includes the same session identity in the demo route", () => {
    const context = createContext();

    context.startDemo();

    expect(mocks.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/pages/materials/index?session=materials-new&demo=1",
      }),
    );
  });
});
