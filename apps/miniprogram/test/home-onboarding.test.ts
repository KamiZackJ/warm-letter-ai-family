import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LetterSummary } from "../src/types/domain";

const mocks = vi.hoisted(() => ({
  listLetters: vi.fn(),
  navigateTo: vi.fn(),
  pageScrollTo: vi.fn(),
  showToast: vi.fn(),
  getStorageSync: vi.fn(),
  setStorageSync: vi.fn(),
  beginCurrentMaterialSelection: vi.fn(),
  clearPendingGeneration: vi.fn(),
  getCurrentMaterialSelection: vi.fn(),
  getPendingGeneration: vi.fn(),
  restoreCurrentMaterialSelection: vi.fn(),
  savePendingGeneration: vi.fn(),
}));

vi.mock("../src/services/api", () => ({ api: { listLetters: mocks.listLetters } }));
vi.mock("../src/config/env", () => ({
  environment: { demoEnabled: true },
  environmentView: {},
  storageKey: (name: string) => `test:${name}`,
}));
vi.mock("../src/utils/storage", () => ({
  beginCurrentMaterialSelection: mocks.beginCurrentMaterialSelection,
  clearPendingGeneration: mocks.clearPendingGeneration,
  getCurrentMaterialSelection: mocks.getCurrentMaterialSelection,
  getPendingGeneration: mocks.getPendingGeneration,
  restoreCurrentMaterialSelection: mocks.restoreCurrentMaterialSelection,
  savePendingGeneration: mocks.savePendingGeneration,
}));

type PageContext = {
  data: Record<string, any>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  [key: string]: any;
};

let definition: PageContext;
let stored: Map<string, unknown>;

function createPage(): PageContext {
  const data = { ...definition.data, recentLetters: [] };
  return {
    ...definition,
    data,
    setData(patch, callback) { Object.assign(data, patch); callback?.(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const existingLetter = {
  id: "existing-letter",
  title: "给家人的信",
  status: "EDITING",
  intent: { recipient: "家人" },
  updatedAt: "2026-09-19T00:00:00.000Z",
} as LetterSummary;

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      getStorageSync: mocks.getStorageSync,
      setStorageSync: mocks.setStorageSync,
      navigateTo: mocks.navigateTo,
      pageScrollTo: mocks.pageScrollTo,
      showToast: mocks.showToast,
    },
    Page: (page: PageContext) => { definition = page; },
  });
  await import("../src/pages/home/index");
});

beforeEach(() => {
  vi.resetAllMocks();
  stored = new Map();
  mocks.getStorageSync.mockImplementation((key: string) => stored.get(key));
  mocks.setStorageSync.mockImplementation((key: string, value: unknown) => stored.set(key, value));
  mocks.listLetters.mockResolvedValue([]);
  mocks.beginCurrentMaterialSelection.mockReturnValue("new-material-session");
  mocks.getCurrentMaterialSelection.mockReturnValue({ sessionId: "previous", revision: 0, ids: [] });
  mocks.restoreCurrentMaterialSelection.mockReturnValue(true);
});

describe("first-use guide", () => {
  it("appears immediately while history is pending and does not create a material session", async () => {
    const history = deferred<LetterSummary[]>();
    mocks.listLetters.mockReturnValue(history.promise);
    const page = createPage();

    const showing = page.onShow();

    expect(page.data.guideVisible).toBe(true);
    expect(page.data.guideStep).toBe(0);
    expect(page.data.loading).toBe(true);
    expect(mocks.beginCurrentMaterialSelection).not.toHaveBeenCalled();
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.setStorageSync).not.toHaveBeenCalled();
    history.resolve([]);
    await showing;
  });

  it.each([
    ["real_letter_ids", ["old-letter"]],
    ["letters", [{ id: "mock-letter" }]],
    ["pending_generation", { letterId: "pending-letter", fingerprint: "input" }],
    ["real_generation_jobs", { "old-letter": "job" }],
    ["onboarding_v1", true],
  ])("does not interrupt users with local %s even when history cannot load", async (key, value) => {
    stored.set(`test:${key}`, value);
    mocks.listLetters.mockRejectedValue(new Error("网络暂不可用"));
    const page = createPage();

    await page.onShow();

    expect(page.data.guideVisible).toBe(false);
    page.openGuide();
    expect(page.data.guideVisible).toBe(true);
    expect(page.data.guideStep).toBe(0);
  });

  it("hides an untouched automatic guide when remote history arrives", async () => {
    mocks.listLetters.mockResolvedValue([existingLetter]);
    const page = createPage();

    await page.onShow();

    expect(page.data.guideVisible).toBe(false);
    expect(page.data.recentLetters[0].id).toBe(existingLetter.id);
    expect(stored.get("test:onboarding_v1")).toBe(true);
  });

  it.each(["nextGuideStep", "openGuide"])("keeps the guide in place after %s when history arrives late", async (action) => {
    const history = deferred<LetterSummary[]>();
    mocks.listLetters.mockReturnValue(history.promise);
    const page = createPage();
    const showing = page.onShow();
    page[action]();
    const currentStep = page.data.guideStep;

    history.resolve([existingLetter]);
    await showing;

    expect(page.data.guideVisible).toBe(true);
    expect(page.data.guideStep).toBe(currentStep);
  });

  it("allows skipping after a network error and remembers the choice on a new page", async () => {
    mocks.listLetters.mockRejectedValue(new Error("网络暂不可用"));
    const page = createPage();
    await page.onShow();
    expect(page.data.guideVisible).toBe(true);

    page.dismissGuide();

    expect(page.data.guideVisible).toBe(false);
    expect(stored.get("test:onboarding_v1")).toBe(true);
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.beginCurrentMaterialSelection).not.toHaveBeenCalled();
    expect(mocks.clearPendingGeneration).not.toHaveBeenCalled();
    const nextVisit = createPage();
    await nextVisit.onShow();
    expect(nextVisit.data.guideVisible).toBe(false);
  });

  it("moves tips to real anchors, finishes without navigation, and supports explicit replay", async () => {
    const page = createPage();
    await page.onShow();
    page.nextGuideStep();
    expect(page.data.guideStep).toBe(1);
    expect(mocks.pageScrollTo).toHaveBeenLastCalledWith(expect.objectContaining({
      selector: "#guide-recent", duration: 0,
    }));
    page.nextGuideStep();
    page.nextGuideStep();
    expect(page.data.guideStep).toBe(2);
    expect(mocks.pageScrollTo).toHaveBeenLastCalledWith(expect.objectContaining({
      selector: "#guide-replay", duration: 0,
    }));
    page.dismissGuide();
    expect(stored.get("test:onboarding_v1")).toBe(true);
    expect(mocks.navigateTo).not.toHaveBeenCalled();

    const nextVisit = createPage();
    await nextVisit.onShow();
    expect(nextVisit.data.guideVisible).toBe(false);
    nextVisit.openGuide();
    expect(nextVisit.data.guideVisible).toBe(true);
    expect(nextVisit.data.guideStep).toBe(0);
    expect(mocks.pageScrollTo).toHaveBeenLastCalledWith(expect.objectContaining({
      selector: "#guide-write", duration: 0,
    }));
  });

  it("does not reopen a skipped guide when the original history request completes", async () => {
    const history = deferred<LetterSummary[]>();
    mocks.listLetters.mockReturnValue(history.promise);
    const page = createPage();
    const showing = page.onShow();
    page.dismissGuide();
    history.resolve([]);
    await showing;

    expect(page.data.guideVisible).toBe(false);
    expect(mocks.navigateTo).not.toHaveBeenCalled();
  });

  it("allows writing directly while the first tip is still visible", async () => {
    const page = createPage();
    await page.onShow();
    expect(page.data.guideVisible).toBe(true);

    page.startLetter();

    expect(page.data.guideVisible).toBe(false);
    expect(stored.get("test:onboarding_v1")).toBe(true);
    expect(mocks.navigateTo).toHaveBeenCalledWith(expect.objectContaining({
      url: "/pages/materials/index?session=new-material-session",
    }));
  });

  it("allows skipping every tip without creating a letter or changing pending selections", async () => {
    const page = createPage();
    await page.onShow();
    for (let target = 0; target < 3; target += 1) {
      page.openGuide();
      for (let step = 0; step < target; step += 1) page.nextGuideStep();
      page.dismissGuide();
      expect(page.data.guideVisible).toBe(false);
    }
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.beginCurrentMaterialSelection).not.toHaveBeenCalled();
    expect(mocks.clearPendingGeneration).not.toHaveBeenCalled();
  });

  it("keeps the inline tip usable if anchor scrolling fails", async () => {
    mocks.pageScrollTo.mockImplementation(() => { throw new Error("scroll unavailable"); });
    const page = createPage();
    await page.onShow();

    page.nextGuideStep();

    expect(page.data.guideVisible).toBe(true);
    expect(page.data.guideStep).toBe(1);
    page.dismissGuide();
    expect(page.data.guideVisible).toBe(false);
  });

  it("keeps navigation usable if the optional preference cannot be saved", async () => {
    mocks.setStorageSync.mockImplementation(() => { throw new Error("storage full"); });
    const page = createPage();
    await page.onShow();

    page.startLetter();
    page.startLetter();

    expect(page.data.guideVisible).toBe(false);
    expect(mocks.navigateTo).toHaveBeenCalledTimes(1);
    expect(page.data.startingFlow).toBe(true);
  });

  it("does not misclassify an unreadable history as new and keeps manual guide usable", async () => {
    mocks.getStorageSync.mockImplementation(() => { throw new Error("storage unavailable"); });
    const page = createPage();
    await page.onShow();
    expect(page.data.guideVisible).toBe(false);

    page.openGuide();
    page.nextGuideStep();
    page.startLetter();

    expect(page.data.guideVisible).toBe(false);
    expect(mocks.navigateTo).toHaveBeenCalledTimes(1);
  });

  it("keeps the dismissed choice and re-enables writing after navigation failure", async () => {
    const page = createPage();
    await page.onShow();
    page.startLetter();
    const navigation = mocks.navigateTo.mock.calls[0]?.[0] as { fail(): void };
    navigation.fail();

    expect(page.data.guideVisible).toBe(false);
    expect(page.data.startingFlow).toBe(false);
    expect(stored.get("test:onboarding_v1")).toBe(true);
    page.startLetter();
    expect(mocks.navigateTo).toHaveBeenCalledTimes(2);
    expect(mocks.restoreCurrentMaterialSelection).toHaveBeenCalledTimes(1);
  });
});
