import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublishedUpdatePrompt } from "../src/utils/published-update";

const idleHome = () => ({ route: "pages/home/index", data: { loading: false, startingFlow: false, guideVisible: false } });

function setup() {
  let ready = () => undefined as void;
  let failed = () => undefined as void;
  let pages: Array<{ route: string; data?: Record<string, unknown> }> = [idleHome()];
  const manager = {
    onUpdateReady: vi.fn((callback: () => void) => { ready = callback; }),
    onUpdateFailed: vi.fn((callback: () => void) => { failed = callback; }),
    applyUpdate: vi.fn(),
  };
  const getManager = vi.fn(() => manager);
  const showModal = vi.fn();
  const prompt = createPublishedUpdatePrompt({ getManager, getPages: () => pages, showModal });
  return { prompt, manager, getManager, showModal, ready: () => ready(), failed: () => failed(),
    setPages: (value: typeof pages) => { pages = value; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("published WeChat updates", () => {
  it("waits for explicit restart confirmation and applies once despite repeated callbacks", () => {
    const test = setup();
    test.prompt.initialize();
    test.prompt.onShow();
    test.prompt.initialize();
    test.ready();
    test.ready();
    test.prompt.onShow();
    expect(test.getManager).toHaveBeenCalledOnce();
    expect(test.manager.onUpdateReady).toHaveBeenCalledOnce();
    expect(test.manager.onUpdateFailed).toHaveBeenCalledOnce();
    expect(test.showModal).toHaveBeenCalledOnce();
    expect(test.manager.applyUpdate).not.toHaveBeenCalled();
    const modal = test.showModal.mock.calls[0]![0];
    expect(modal).toMatchObject({ confirmText: "重启更新", cancelText: "稍后" });
    modal.success({ confirm: true });
    modal.success({ confirm: true });
    expect(test.manager.applyUpdate).toHaveBeenCalledOnce();
  });

  it("keeps the app usable after cancel and does not repeatedly prompt this session", () => {
    const test = setup();
    test.prompt.onShow(); test.ready();
    const modal = test.showModal.mock.calls[0]![0];
    modal.success({ confirm: false });
    test.ready(); test.prompt.onHide(); test.prompt.onShow();
    modal.success({ confirm: true });
    expect(test.showModal).toHaveBeenCalledOnce();
    expect(test.manager.applyUpdate).not.toHaveBeenCalled();
  });

  it.each(["pages/editor/index", "pages/materials/index", "pages/intent/index", "pages/preview/index", "pages/reader/index"])(
    "defers an update while %s may contain work, until a safe home foreground visit", (route) => {
      const test = setup();
      test.setPages([idleHome(), { route }]);
      test.prompt.onShow(); test.ready();
      expect(test.showModal).not.toHaveBeenCalled();
      expect(test.manager.applyUpdate).not.toHaveBeenCalled();
      test.setPages([idleHome()]);
      test.prompt.onHide(); test.prompt.onShow();
      expect(test.showModal).toHaveBeenCalledOnce();
    },
  );

  it("does not restart when navigation changes after the prompt opened", () => {
    const test = setup();
    test.prompt.onShow(); test.ready();
    test.setPages([idleHome(), { route: "pages/editor/index" }]);
    test.showModal.mock.calls[0]![0].success({ confirm: true });
    expect(test.manager.applyUpdate).not.toHaveBeenCalled();
  });

  it("defers downloads completed in the background and rejects a later hidden confirmation", () => {
    const test = setup();
    test.prompt.onShow(); test.prompt.onHide(); test.ready();
    expect(test.showModal).not.toHaveBeenCalled();
    test.prompt.onShow(); test.prompt.onHide();
    test.showModal.mock.calls[0]![0].success({ confirm: true });
    expect(test.manager.applyUpdate).not.toHaveBeenCalled();
  });

  it.each([{ loading: true }, { startingFlow: true }, { guideVisible: true }])(
    "does not interrupt a busy home or first-use guide: %j", (busy) => {
      const test = setup();
      test.setPages([{ route: "pages/home/index", data: { ...idleHome().data, ...busy } }]);
      test.prompt.onShow(); test.ready();
      expect(test.showModal).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the page stack is not yet available", () => {
    const test = setup();
    test.setPages([]);
    test.prompt.onShow(); test.ready();
    expect(test.showModal).not.toHaveBeenCalled();
  });

  it.each([() => undefined, () => { throw new Error("Unavailable"); }])(
    "tolerates absent or unavailable native update support", (getManager) => {
      const showModal = vi.fn();
      const prompt = createPublishedUpdatePrompt({ getManager, getPages: () => [idleHome()], showModal });
      expect(() => { prompt.initialize(); prompt.onShow(); prompt.onHide(); }).not.toThrow();
      expect(showModal).not.toHaveBeenCalled();
    },
  );

  it("keeps download failures silent and never applies an invalidated ready result", () => {
    const test = setup();
    test.prompt.onShow(); test.failed();
    expect(test.showModal).not.toHaveBeenCalled();
    test.ready(); test.failed();
    test.showModal.mock.calls[0]![0].success({ confirm: true });
    expect(test.manager.applyUpdate).not.toHaveBeenCalled();
  });

  it("does not restart after the native prompt reports failure", () => {
    const test = setup();
    test.prompt.onShow(); test.ready();
    const modal = test.showModal.mock.calls[0]![0];
    modal.fail(); modal.success({ confirm: true });
    test.prompt.onShow(); test.ready();
    expect(test.showModal).toHaveBeenCalledOnce();
    expect(test.manager.applyUpdate).not.toHaveBeenCalled();
  });

  it("contains native dialog and restart exceptions", () => {
    const dialog = setup();
    dialog.showModal.mockImplementation(() => { throw new Error("Modal unavailable"); });
    dialog.prompt.onShow();
    expect(() => dialog.ready()).not.toThrow();
    expect(dialog.manager.applyUpdate).not.toHaveBeenCalled();
    const restart = setup();
    restart.manager.applyUpdate.mockImplementation(() => { throw new Error("Update unavailable"); });
    restart.prompt.onShow(); restart.ready();
    expect(() => restart.showModal.mock.calls[0]![0].success({ confirm: true })).not.toThrow();
  });

  it("connects app foreground/background lifecycle without registering another listener set", async () => {
    vi.resetModules();
    let app: { onLaunch(): void; onShow(): void; onHide(): void } | undefined;
    const test = setup();
    vi.stubGlobal("App", (value: typeof app) => { app = value; });
    vi.stubGlobal("getCurrentPages", () => [idleHome()]);
    vi.stubGlobal("wx", { getUpdateManager: test.getManager, showModal: test.showModal });
    await import("../src/app");
    app!.onLaunch(); app!.onShow(); app!.onHide(); test.ready();
    expect(test.showModal).not.toHaveBeenCalled();
    app!.onShow();
    expect(test.showModal).toHaveBeenCalledOnce();
    expect(test.manager.onUpdateReady).toHaveBeenCalledOnce();
  });
});
