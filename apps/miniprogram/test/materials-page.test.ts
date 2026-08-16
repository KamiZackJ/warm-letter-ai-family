import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "../src/types/domain";

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
const materialsTemplatePath = normalizedWorkingDirectory.endsWith("/apps/miniprogram")
  ? `${normalizedWorkingDirectory}/src/pages/materials/index.wxml`
  : `${normalizedWorkingDirectory}/apps/miniprogram/src/pages/materials/index.wxml`;
const materialsStylesPath = normalizedWorkingDirectory.endsWith("/apps/miniprogram")
  ? `${normalizedWorkingDirectory}/src/pages/materials/index.wxss`
  : `${normalizedWorkingDirectory}/apps/miniprogram/src/pages/materials/index.wxss`;

function cssRule(source: string, selector: string): string {
  const rules = [...source.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g"))];
  const rule = rules[rules.length - 1];
  if (!rule?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return rule[1];
}

const mocks = vi.hoisted(() => ({
  listMaterials: vi.fn(),
  saveMaterial: vi.fn(),
  deleteMaterial: vi.fn(),
  createDemoMaterials: vi.fn(),
  resolveDemoRequest: vi.fn(),
  getCurrentMaterialSelection: vi.fn(),
  updateCurrentMaterialIdsForSession: vi.fn(),
  chooseMedia: vi.fn(),
  showToast: vi.fn(),
  showModal: vi.fn(),
  reLaunch: vi.fn(),
  navigateTo: vi.fn(),
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  recorderOffStop: vi.fn(),
  recorderOffError: vi.fn(),
  recorderOnStop: vi.fn(),
  recorderOnError: vi.fn(),
}));

vi.mock("../src/services/api", () => ({
  api: {
    listMaterials: mocks.listMaterials,
    saveMaterial: mocks.saveMaterial,
    deleteMaterial: mocks.deleteMaterial,
  },
}));

vi.mock("../src/config/demo-materials", () => ({
  createDemoMaterials: mocks.createDemoMaterials,
}));
vi.mock("../src/config/env", () => ({
  environment: { demoEnabled: true },
  environmentView: {},
}));
vi.mock("../src/config/runtime-environment", () => ({
  resolveDemoRequest: mocks.resolveDemoRequest,
}));
vi.mock("../src/utils/storage", () => ({
  getCurrentMaterialSelection: mocks.getCurrentMaterialSelection,
  updateCurrentMaterialIdsForSession: mocks.updateCurrentMaterialIdsForSession,
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

type RetryAction = {
  id: string;
  kind: string;
  stage?: string;
  singlePurpose?: string;
  batchPurpose?: string;
  material?: Material;
  pendingMaterials?: Material[];
  pendingCommits?: Material[];
  completedCount?: number;
  totalCount?: number;
  deleteId?: string;
  message: string;
  hint: string;
  retryLabel: string;
};

let pageDefinition: PageDefinition;
let showModalResult = { confirm: false };
let recorderStopHandler: ((result: { tempFilePath: string; duration: number }) => void) | undefined;
let recorderErrorHandler: (() => void) | undefined;
let currentSelection = { sessionId: "session-current", revision: 0, ids: [] as string[] };

function createMaterial(id: string, type: Material["type"] = "text"): Material {
  return {
    id,
    type,
    name: `${type}-${id}`,
    text: type === "text" ? `text-${id}` : undefined,
    localPath: type === "text" ? undefined : `wxfile://${id}`,
    durationSeconds: type === "voice" ? 8 : undefined,
    createdAt: "2026-08-16T00:00:00.000Z",
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
    materials: [],
    actionErrors: [],
    loading: false,
    ...data,
  };
  return {
    ...pageDefinition,
    disposed: false,
    loadRequestId: 0,
    materialSessionId: "session-current",
    materialSelectionRevision: 0,
    data: pageData,
    setData(patch: Record<string, unknown>) {
      Object.assign(pageData, patch);
    },
  } as PageContext;
}

function actionErrors(context: PageContext): RetryAction[] {
  return context.data.actionErrors as RetryAction[];
}

function findAction(
  context: PageContext,
  predicate: (action: RetryAction) => boolean,
): RetryAction {
  const action = actionErrors(context).find(predicate);
  if (!action) throw new Error("Expected retry action");
  return action;
}

function retryEvent(id: string) {
  return { currentTarget: { dataset: { retryId: id } } };
}

function imageEvent(type: "photo" | "screenshot") {
  return { currentTarget: { dataset: { type } } };
}

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      getRecorderManager: () => ({
        start: mocks.recorderStart,
        stop: mocks.recorderStop,
        offStop: mocks.recorderOffStop,
        offError: mocks.recorderOffError,
        onStop: mocks.recorderOnStop,
        onError: mocks.recorderOnError,
      }),
      chooseMedia: mocks.chooseMedia,
      showToast: mocks.showToast,
      showModal: mocks.showModal,
      reLaunch: mocks.reLaunch,
      navigateTo: mocks.navigateTo,
    },
    Page: (definition: PageDefinition) => {
      pageDefinition = definition;
    },
  });

  await import("../src/pages/materials/index");
});

beforeEach(() => {
  vi.resetAllMocks();
  showModalResult = { confirm: false };
  recorderStopHandler = undefined;
  recorderErrorHandler = undefined;
  currentSelection = { sessionId: "session-current", revision: 0, ids: [] };
  mocks.resolveDemoRequest.mockReturnValue(true);
  mocks.getCurrentMaterialSelection.mockImplementation(() => ({
    ...currentSelection,
    ids: [...currentSelection.ids],
  }));
  mocks.updateCurrentMaterialIdsForSession.mockImplementation(
    (
      sessionId: string,
      update: (ids: string[]) => string[],
      expectedRevision?: number,
    ) => {
      if (sessionId !== currentSelection.sessionId) return undefined;
      if (
        expectedRevision !== undefined &&
        expectedRevision !== currentSelection.revision
      ) {
        return undefined;
      }
      currentSelection = {
        sessionId,
        revision: currentSelection.revision + 1,
        ids: Array.from(new Set(update([...currentSelection.ids]))),
      };
      return { ...currentSelection, ids: [...currentSelection.ids] };
    },
  );
  mocks.listMaterials.mockResolvedValue([]);
  mocks.chooseMedia.mockImplementation(
    (options: { success(result: { tempFiles: Array<{ tempFilePath: string }> }): void }) => {
      options.success({ tempFiles: [] });
    },
  );
  mocks.showModal.mockImplementation(
    (options: { success(result: { confirm: boolean }): void }) => {
      options.success(showModalResult);
    },
  );
  mocks.recorderOnError.mockImplementation((callback: () => void) => {
    recorderErrorHandler = callback;
  });
  mocks.recorderOnStop.mockImplementation(
    (callback: (result: { tempFilePath: string; duration: number }) => void) => {
      recorderStopHandler = callback;
    },
  );
});

describe("materials page recovery", () => {
  it("keeps source actions usable at 320px and material text multiline", () => {
    const styles = fileSystem.readFileSync(materialsStylesPath, "utf8");
    const sourceGridRule = cssRule(styles, "\\.source-grid");
    const sourceButtonRule = cssRule(styles, "\\.source-button");
    const sourceTextRule = cssRule(styles, "\\.source-name,\\s*\\.source-note");
    const sourceNameRule = cssRule(styles, "\\.source-name");
    const sourceNoteRule = cssRule(styles, "\\.source-note");
    const materialTextRule = cssRule(styles, "\\.material-name,\\s*\\.material-detail");

    expect(sourceGridRule).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(sourceGridRule).toContain("grid-auto-rows: minmax(220rpx, auto)");
    expect(sourceButtonRule).toContain("min-height: 220rpx");
    expect(sourceNameRule).toContain("font-size: 30rpx");
    expect(sourceNoteRule).toContain("font-size: 28rpx");
    expect(sourceTextRule).toContain("white-space: normal");
    expect(sourceTextRule).toContain("overflow-wrap: anywhere");
    expect(sourceTextRule).not.toContain("text-overflow: ellipsis");
    expect(materialTextRule).toContain("white-space: normal");
    expect(materialTextRule).toContain("overflow-wrap: anywhere");
    expect(materialTextRule).toContain("-webkit-line-clamp: 2");
    expect(materialTextRule).not.toContain("text-overflow: ellipsis");
  });

  it("renders retained materials independently from the persistent load error", () => {
    const template = fileSystem.readFileSync(materialsTemplatePath, "utf8");

    expect(template).toContain('wx:if="{{loadError}}" class="load-error"');
    expect(template).toContain('wx:if="{{materials.length > 0}}" class="material-list"');
    expect(template).toContain("!loading && !loadError && materials.length === 0");
    expect(template).toContain("loading || busyAction !== '' || recording");
    expect(template).toMatch(
      /class="secondary-button load-retry"[\s\S]{0,160}disabled="{{loading \|\| busyAction !== '' \|\| recording}}"/,
    );
    expect(template).toMatch(
      /class="primary-button"[\s\S]{0,180}disabled="{{loading \|\| loadError \|\| materials\.length === 0 \|\| busyAction !== '' \|\| recording}}"[\s\S]{0,80}bindtap="goIntent"/,
    );
    expect(template).toContain('loading="{{stoppingRecord}}"');
    expect(template).toContain("loading || busyAction !== '' || stoppingRecord");
    expect(template).toContain("stoppingRecord ? '正在结束…' : '正在录音…'");
  });

  it("rejects a material page whose route is not bound to the current session", () => {
    const context = createContext();

    context.onLoad({ demo: "1", session: "session-stale" });

    expect(context.disposed).toBe(true);
    expect(mocks.reLaunch).toHaveBeenCalledWith({ url: "/pages/home/index" });
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "本次素材流程已失效，请重新开始",
      icon: "none",
    });
    expect(mocks.recorderOnStop).not.toHaveBeenCalled();
  });

  it("returns home instead of entering intent after the material session is replaced", () => {
    const selected = createMaterial("selected");
    const context = createContext({ materials: [selected] });
    currentSelection = { sessionId: "session-new", revision: 0, ids: [selected.id] };

    context.goIntent();

    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "本次素材流程已失效，请重新开始",
      icon: "none",
    });
    expect(mocks.reLaunch).toHaveBeenCalledWith({ url: "/pages/home/index" });
  });

  it("does not enter intent while the material list has a persistent load error", () => {
    const selected = createMaterial("selected");
    currentSelection.ids = [selected.id];
    const context = createContext({
      materials: [selected],
      loadError: "素材列表读取失败",
    });

    context.goIntent();

    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.listMaterials).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "revision changed",
      selection: { sessionId: "session-current", revision: 1, ids: ["selected"] },
      visibleIds: ["selected"],
    },
    {
      name: "visible IDs changed",
      selection: { sessionId: "session-current", revision: 0, ids: ["selected", "new"] },
      visibleIds: ["selected"],
    },
  ])("reloads instead of entering intent when $name", async ({ selection, visibleIds }) => {
    const pending = createDeferred<Material[]>();
    const visibleMaterials = visibleIds.map((id) => createMaterial(id));
    currentSelection = { ...selection, ids: [...selection.ids] };
    mocks.listMaterials.mockReturnValue(pending.promise);
    const context = createContext({ materials: visibleMaterials });

    context.goIntent();

    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(context.data.loadError).toBe("素材列表已有更新，请重新读取后继续");
    expect(mocks.listMaterials).toHaveBeenCalledTimes(1);

    pending.resolve(selection.ids.map((id) => createMaterial(id)));
    await vi.waitFor(() => expect(context.data.loading).toBe(false));

    expect(context.data.loadError).toBe("");
    expect(context.materialSelectionRevision).toBe(selection.revision);
    expect(context.data.materials.map((material: Material) => material.id)).toEqual(
      selection.ids,
    );

    context.goIntent();

    expect(mocks.navigateTo).toHaveBeenCalledTimes(1);
    expect(mocks.navigateTo).toHaveBeenCalledWith({ url: "/pages/intent/index" });
  });

  it("returns home when the material session changes while a reload is pending", async () => {
    const selected = createMaterial("selected");
    const pending = createDeferred<Material[]>();
    currentSelection.ids = [selected.id];
    mocks.listMaterials.mockReturnValue(pending.promise);
    const context = createContext({
      materials: [selected],
      loadError: "素材列表已有更新，请重新读取后继续",
    });

    const load = context.loadMaterials();
    currentSelection = { sessionId: "session-new", revision: 0, ids: [] };
    pending.resolve([selected]);
    await load;

    expect(context.disposed).toBe(true);
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "本次素材流程已失效，请重新开始",
      icon: "none",
    });
    expect(mocks.reLaunch).toHaveBeenCalledWith({ url: "/pages/home/index" });
  });

  it("enters intent only when the visible materials match the current snapshot", () => {
    const selected = createMaterial("selected");
    currentSelection = { sessionId: "session-current", revision: 3, ids: [selected.id] };
    const context = createContext({ materials: [selected], demoMode: true });
    context.materialSelectionRevision = 3;

    context.goIntent();

    expect(mocks.listMaterials).not.toHaveBeenCalled();
    expect(mocks.navigateTo).toHaveBeenCalledWith({ url: "/pages/intent/index?demo=1" });
  });

  it("keeps the newest load result when overlapping requests finish out of order", async () => {
    const older = createDeferred<Material[]>();
    const newer = createDeferred<Material[]>();
    const olderMaterial = createMaterial("older");
    const newerMaterial = createMaterial("newer");
    currentSelection.ids = [olderMaterial.id, newerMaterial.id];
    mocks.listMaterials
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const context = createContext();

    const olderLoad = context.loadMaterials();
    const newerLoad = context.loadMaterials();
    newer.resolve([newerMaterial]);
    await newerLoad;
    older.resolve([olderMaterial]);
    await olderLoad;

    expect(context.data.loading).toBe(false);
    expect(context.data.materials).toEqual([
      expect.objectContaining({ id: newerMaterial.id }),
    ]);
    expect(currentSelection.ids).toEqual([newerMaterial.id]);
  });

  it("refetches after same-session IDs change from A to B and back to A", async () => {
    const pending = createDeferred<Material[]>();
    const stale = { ...createMaterial("stable"), name: "旧响应" };
    const fresh = { ...createMaterial("stable"), name: "最新响应" };
    currentSelection.ids = [stale.id];
    mocks.listMaterials
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([fresh]);
    const context = createContext();

    const load = context.loadMaterials();
    mocks.updateCurrentMaterialIdsForSession(
      "session-current",
      () => ["temporary-material"],
    );
    mocks.updateCurrentMaterialIdsForSession(
      "session-current",
      () => [stale.id],
    );
    pending.resolve([stale]);
    await load;

    expect(mocks.listMaterials).toHaveBeenCalledTimes(2);
    expect(context.data.materials).toEqual([
      expect.objectContaining({ id: fresh.id, name: "最新响应" }),
    ]);
  });

  it("stops automatic refetching after three continuously changing snapshots", async () => {
    const retained = createMaterial("retained");
    currentSelection.ids = [retained.id];
    mocks.listMaterials.mockImplementation(async () => {
      currentSelection = {
        ...currentSelection,
        revision: currentSelection.revision + 1,
        ids:
          currentSelection.ids[0] === retained.id
            ? ["temporary-material"]
            : [retained.id],
      };
      return [];
    });
    const context = createContext({ materials: [retained] });

    await context.loadMaterials();

    expect(mocks.listMaterials).toHaveBeenCalledTimes(3);
    expect(context.data.loading).toBe(false);
    expect(context.data.loadError).toBe("素材列表刚刚发生变化，请点重试读取最新内容");
    expect(context.data.materials).toEqual([retained]);
  });

  it("removes selected IDs that the material service confirms are no longer available", async () => {
    const retained = createMaterial("retained");
    currentSelection.ids = [retained.id, "missing-material"];
    mocks.listMaterials.mockResolvedValue([retained]);
    const context = createContext();

    await context.loadMaterials();

    expect(currentSelection.ids).toEqual([retained.id]);
    expect(context.data.materials).toEqual([
      expect.objectContaining({ id: retained.id }),
    ]);
  });

  it("keeps a completed save when an older material read returns later", async () => {
    const existing = createMaterial("existing");
    const saved = createMaterial("saved-during-load");
    const pendingSave = createDeferred<Material>();
    const pendingLoad = createDeferred<Material[]>();
    currentSelection.ids = [existing.id];
    mocks.saveMaterial.mockReturnValue(pendingSave.promise);
    mocks.listMaterials
      .mockReturnValueOnce(pendingLoad.promise)
      .mockResolvedValueOnce([existing, saved]);
    const context = createContext({
      materials: [existing],
      textDraft: "保存期间发起了旧读取",
    });

    const save = context.addText();
    const load = context.loadMaterials();
    pendingSave.resolve(saved);
    await save;

    expect(currentSelection.ids).toEqual([saved.id, existing.id]);
    expect(context.data.materials.map((item: Material) => item.id)).toEqual([
      saved.id,
      existing.id,
    ]);

    pendingLoad.resolve([existing]);
    await load;

    expect(currentSelection.ids).toEqual([saved.id, existing.id]);
    expect(mocks.listMaterials).toHaveBeenCalledTimes(2);
    expect(mocks.updateCurrentMaterialIdsForSession).toHaveBeenCalledTimes(1);
    expect(context.data.materials.map((item: Material) => item.id)).toEqual([
      saved.id,
      existing.id,
    ]);
  });

  it("does not start a load retry while another material action is busy", async () => {
    const context = createContext({ loadError: "读取失败", busyAction: "text" });

    await context.retryLoadMaterials();

    expect(mocks.listMaterials).not.toHaveBeenCalled();
    expect(context.data.loadError).toBe("读取失败");
  });

  it("stops recording and ignores an in-flight load after the page unloads", async () => {
    const pending = createDeferred<Material[]>();
    mocks.listMaterials.mockReturnValue(pending.promise);
    const context = createContext({ recording: true });
    const setData = vi.fn(context.setData.bind(context));
    context.setData = setData;
    context.onLoad({ demo: "1", session: "session-current" });

    const load = context.loadMaterials();
    context.onUnload();
    const callsAtUnload = setData.mock.calls.length;
    pending.resolve([createMaterial("late")]);
    await load;

    expect(mocks.recorderStop).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledTimes(callsAtUnload);
    expect(context.data.materials).toEqual([]);
  });

  it("records a completed save without writing page state after unload", async () => {
    const pending = createDeferred<Material>();
    const saved = createMaterial("saved-after-unload");
    mocks.saveMaterial.mockReturnValue(pending.promise);
    const context = createContext({ textDraft: "离开页面前提交" });
    const postUnloadWrites: Record<string, unknown>[] = [];
    const applyData = context.setData.bind(context);
    context.setData = (patch: Record<string, unknown>) => {
      if (context.disposed) postUnloadWrites.push(patch);
      applyData(patch);
    };

    const save = context.addText();
    context.onUnload();
    pending.resolve(saved);
    await save;

    expect(currentSelection.ids).toEqual([saved.id]);
    expect(postUnloadWrites).toEqual([]);
    expect(context.data.materials).toEqual([]);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("does not attach an old-page save to a replacement selection session", async () => {
    const pending = createDeferred<Material>();
    const saved = createMaterial("saved-for-old-session");
    currentSelection = { sessionId: "session-old", revision: 0, ids: [] };
    mocks.saveMaterial.mockReturnValue(pending.promise);
    const context = createContext({ textDraft: "旧家书里的私密内容" });
    context.onLoad({ demo: "1", session: "session-old" });

    const save = context.addText();
    context.onUnload();
    currentSelection = { sessionId: "session-new", revision: 0, ids: [] };
    pending.resolve(saved);
    await save;

    expect(mocks.updateCurrentMaterialIdsForSession).toHaveBeenCalledWith(
      "session-old",
      expect.any(Function),
    );
    expect(currentSelection.ids).toEqual([]);
    expect(context.data.materials).toEqual([]);
  });

  it("does not clear an active draft when its selection session is replaced", async () => {
    const pending = createDeferred<Material>();
    const saved = createMaterial("saved-for-replaced-session");
    currentSelection = { sessionId: "session-old", revision: 0, ids: [] };
    mocks.saveMaterial.mockReturnValue(pending.promise);
    const context = createContext({ textDraft: "仍要保留的草稿" });
    context.onLoad({ demo: "1", session: "session-old" });

    const save = context.addText();
    currentSelection = { sessionId: "session-new", revision: 0, ids: [] };
    pending.resolve(saved);
    await save;

    expect(context.data.textDraft).toBe("仍要保留的草稿");
    expect(context.data.materials).toEqual([]);
    expect(context.data.busyAction).toBe("");
    expect(mocks.showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ icon: "success" }),
    );
  });

  it("does not report batch success after its selection session is replaced", async () => {
    const pending = createDeferred<Material>();
    const saved = createMaterial("saved-image-for-replaced-session", "photo");
    currentSelection = { sessionId: "session-old", revision: 0, ids: [] };
    mocks.chooseMedia.mockImplementation(
      (options: { success(result: { tempFiles: Array<{ tempFilePath: string }> }): void }) => {
        options.success({ tempFiles: [{ tempFilePath: "wxfile://old-session-photo" }] });
      },
    );
    mocks.saveMaterial.mockReturnValue(pending.promise);
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-old" });

    const save = context.chooseImage(imageEvent("photo"));
    await Promise.resolve();
    currentSelection = { sessionId: "session-new", revision: 0, ids: [] };
    pending.resolve(saved);
    await save;

    expect(context.data.materials).toEqual([]);
    expect(context.data.busyAction).toBe("");
    expect(mocks.showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ icon: "success" }),
    );
  });

  it("does not let an old-page deletion overwrite a replacement selection session", async () => {
    const pending = createDeferred<void>();
    const oldMaterial = createMaterial("old-session-material", "photo");
    currentSelection = {
      sessionId: "session-old",
      revision: 0,
      ids: [oldMaterial.id],
    };
    mocks.deleteMaterial.mockReturnValue(pending.promise);
    showModalResult = { confirm: true };
    const context = createContext({ materials: [oldMaterial] });
    context.onLoad({ demo: "1", session: "session-old" });

    const deletion = context.deleteMaterial({
      currentTarget: { dataset: { id: oldMaterial.id } },
    });
    await Promise.resolve();
    expect(mocks.deleteMaterial).toHaveBeenCalledWith(oldMaterial.id);
    context.onUnload();
    currentSelection = {
      sessionId: "session-new",
      revision: 0,
      ids: ["new-session-material"],
    };
    pending.resolve();
    await deletion;

    expect(mocks.updateCurrentMaterialIdsForSession).toHaveBeenCalledWith(
      "session-old",
      expect.any(Function),
    );
    expect(currentSelection.ids).toEqual(["new-session-material"]);
  });

  it("shows a persistent load error and clears it only after a successful retry", async () => {
    const retained = createMaterial("retained");
    const selected = createMaterial("selected");
    const retry = createDeferred<Material[]>();
    currentSelection.ids = [selected.id];
    mocks.listMaterials
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockReturnValueOnce(retry.promise);
    const context = createContext({ materials: [retained] });

    await context.loadMaterials();

    expect(context.data.loadError).toBe("网络暂时不可用");
    expect(context.data.materials).toEqual([retained]);

    const retryPromise = context.retryLoadMaterials();
    expect(context.data.loading).toBe(true);
    expect(context.data.loadError).toBe("网络暂时不可用");

    retry.resolve([selected]);
    await retryPromise;

    expect(context.data.loading).toBe(false);
    expect(context.data.loadError).toBe("");
    expect(context.data.materials).toEqual([
      expect.objectContaining({ id: selected.id, detail: selected.text }),
    ]);
  });

  it("keeps a failed text draft and prevents duplicate retry submissions", async () => {
    const retry = createDeferred<Material>();
    mocks.saveMaterial
      .mockRejectedValueOnce(new Error("文字保存超时"))
      .mockReturnValueOnce(retry.promise);
    const context = createContext({ textDraft: "  最近开始学做饭  " });

    await context.addText();

    const textAction = findAction(
      context,
      (action) => action.kind === "single" && action.singlePurpose === "text",
    );
    expect(context.data.textDraft).toBe("  最近开始学做饭  ");
    expect(textAction.stage).toBe("remote");
    expect(textAction.message).toBe("文字保存超时");
    expect(textAction.material?.text).toBe("最近开始学做饭");
    expect(textAction.retryLabel).toBe("重试原内容");
    expect(textAction.hint).toContain("重试会原样保存");

    const firstRetry = context.retryFailedAction(retryEvent(textAction.id));
    const duplicateRetry = context.retryFailedAction(retryEvent(textAction.id));
    expect(context.data.retryingId).toBe(textAction.id);
    expect(context.data.busyAction).toBe("text");
    expect(mocks.saveMaterial).toHaveBeenCalledTimes(2);

    retry.resolve({ ...textAction.material!, id: "saved-text" });
    await Promise.all([firstRetry, duplicateRetry]);

    expect(context.data.textDraft).toBe("");
    expect(actionErrors(context)).toEqual([]);
    expect(context.data.materials[0].id).toBe("saved-text");
  });

  it("retries the immutable failed text snapshot while preserving an edited draft", async () => {
    mocks.saveMaterial
      .mockRejectedValueOnce(new Error("文字保存超时"))
      .mockImplementationOnce(async (material: Material) => ({
        ...material,
        id: "saved-original-text",
      }));
    const context = createContext({ textDraft: "原来的近况" });

    await context.addText();

    const action = findAction(context, (item) => item.singlePurpose === "text");
    const originalRequest = { ...action.material! };
    context.updateTextDraft({ detail: { value: "修改后的新近况" } });

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.saveMaterial.mock.calls[0]?.[0]).toEqual(originalRequest);
    expect(mocks.saveMaterial.mock.calls[1]?.[0]).toEqual(originalRequest);
    expect(context.data.textDraft).toBe("修改后的新近况");
    expect(context.data.materials[0].id).toBe("saved-original-text");
    expect(actionErrors(context)).toEqual([]);
  });

  it("uses the existing failed snapshot when the add button text is unchanged", async () => {
    mocks.saveMaterial
      .mockRejectedValueOnce(new Error("文字保存超时"))
      .mockImplementationOnce(async (material: Material) => ({
        ...material,
        id: "saved-unchanged-text",
      }));
    const context = createContext({ textDraft: "没有修改的近况" });

    await context.addText();

    const action = findAction(context, (item) => item.singlePurpose === "text");
    const originalRequest = { ...action.material! };
    await context.addText();

    expect(mocks.saveMaterial.mock.calls[0]?.[0]).toEqual(originalRequest);
    expect(mocks.saveMaterial.mock.calls[1]?.[0]).toEqual(originalRequest);
    expect(context.data.textDraft).toBe("");
    expect(context.data.materials[0].id).toBe("saved-unchanged-text");
    expect(actionErrors(context)).toEqual([]);
  });

  it("saves an edited draft under a new material id without replacing the failed snapshot", async () => {
    mocks.saveMaterial
      .mockRejectedValueOnce(new Error("文字保存超时"))
      .mockImplementationOnce(async (material: Material) => ({
        ...material,
        id: "saved-edited-text",
      }));
    const context = createContext({ textDraft: "原来的近况" });

    await context.addText();

    const originalAction = findAction(context, (item) => item.singlePurpose === "text");
    const originalRequest = { ...originalAction.material! };
    context.updateTextDraft({ detail: { value: "修改后的新近况" } });

    await context.addText();

    const editedRequest = mocks.saveMaterial.mock.calls[1]?.[0] as Material;
    expect(editedRequest).toEqual(
      expect.objectContaining({ type: "text", text: "修改后的新近况" }),
    );
    expect(editedRequest.id).not.toBe(originalRequest.id);
    expect(originalAction.material).toEqual(originalRequest);
    expect(actionErrors(context)).toEqual([originalAction]);
    expect(context.data.textDraft).toBe("");
    expect(context.data.materials[0].id).toBe("saved-edited-text");
  });

  it("keeps independent retry actions when different operations fail in sequence", async () => {
    const remove = createMaterial("remove", "photo");
    currentSelection.ids = [remove.id];
    showModalResult = { confirm: true };
    mocks.saveMaterial.mockRejectedValueOnce(new Error("文字保存失败"));
    mocks.deleteMaterial.mockRejectedValueOnce(new Error("删除请求失败"));
    const context = createContext({
      textDraft: "两项失败都要保留",
      materials: [remove],
    });

    await context.addText();
    await context.deleteMaterial({ currentTarget: { dataset: { id: remove.id } } });

    const textAction = findAction(context, (action) => action.singlePurpose === "text");
    const deleteAction = findAction(context, (action) => action.deleteId === remove.id);
    expect(actionErrors(context)).toHaveLength(2);
    expect(context.data.materials).toEqual([remove]);

    mocks.saveMaterial.mockResolvedValueOnce(createMaterial("saved-text"));
    await context.retryFailedAction(retryEvent(textAction.id));

    expect(actionErrors(context).map((action) => action.id)).toEqual([deleteAction.id]);
    expect(context.data.materials).toContain(remove);
  });

  it("does not recreate a text material when only local page state failed", async () => {
    const saved = createMaterial("server-text");
    mocks.saveMaterial.mockResolvedValueOnce(saved);
    mocks.updateCurrentMaterialIdsForSession.mockImplementationOnce(() => {
      throw new Error("本地记录失败");
    });
    const context = createContext({ textDraft: "服务端只应创建一次" });

    await context.addText();

    const action = findAction(context, (item) => item.singlePurpose === "text");
    expect(action.stage).toBe("local");
    expect(action.material?.id).toBe(saved.id);
    expect(action.hint).toContain("不会再次上传");
    expect(context.data.materials).toEqual([]);
    expect(mocks.saveMaterial).toHaveBeenCalledTimes(1);

    context.updateTextDraft({ detail: { value: "这是恢复期间继续写的新内容" } });
    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.saveMaterial).toHaveBeenCalledTimes(1);
    expect(context.data.materials[0].id).toBe(saved.id);
    expect(context.data.textDraft).toBe("这是恢复期间继续写的新内容");
    expect(actionErrors(context)).toEqual([]);
  });

  it("sends only one recorder stop request while the stop callback is pending", () => {
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();

    context.stopRecord();
    context.stopRecord();

    expect(mocks.recorderStop).toHaveBeenCalledTimes(1);
    expect(context.data.recording).toBe(true);
    expect(context.data.stoppingRecord).toBe(true);
  });

  it("invalidates recorder callbacks when stopping throws synchronously", async () => {
    mocks.recorderStop.mockImplementationOnce(() => {
      throw new Error("recorder stop failed");
    });
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();
    const staleStop = recorderStopHandler;
    const staleError = recorderErrorHandler;

    context.stopRecord();
    staleStop?.({ tempFilePath: "wxfile://stale-after-stop-failure", duration: 8_400 });
    staleError?.();
    await Promise.resolve();

    expect(mocks.saveMaterial).not.toHaveBeenCalled();
    expect(context.data.recording).toBe(false);
    expect(context.data.stoppingRecord).toBe(false);
    expect(findAction(context, (action) => action.id === "record")).toEqual(
      expect.objectContaining({ kind: "record" }),
    );
  });

  it("accepts the first recorder callback and ignores a later error", async () => {
    const savedVoice = createMaterial("saved-after-stop", "voice");
    mocks.saveMaterial.mockResolvedValueOnce(savedVoice);
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();
    context.stopRecord();

    recorderStopHandler?.({ tempFilePath: "wxfile://voice-stop", duration: 8_400 });
    recorderErrorHandler?.();

    await vi.waitFor(() => expect(mocks.saveMaterial).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(context.data.busyAction).toBe(""));
    expect(context.data.recording).toBe(false);
    expect(context.data.stoppingRecord).toBe(false);
    expect(context.data.materials[0]?.id).toBe(savedVoice.id);
    expect(actionErrors(context).some((action) => action.id === "record")).toBe(false);
  });

  it("ignores a late stop callback after the recorder reports an error", async () => {
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();
    context.stopRecord();

    recorderErrorHandler?.();
    recorderStopHandler?.({ tempFilePath: "wxfile://late-stop", duration: 8_400 });
    await Promise.resolve();

    expect(mocks.saveMaterial).not.toHaveBeenCalled();
    expect(context.data.recording).toBe(false);
    expect(context.data.stoppingRecord).toBe(false);
    expect(findAction(context, (action) => action.id === "record")).toEqual(
      expect.objectContaining({ kind: "record" }),
    );
  });

  it("ignores an old stop callback after an error and a new recording start", async () => {
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();
    context.stopRecord();
    const oldStop = recorderStopHandler;

    recorderErrorHandler?.();
    context.startRecord();
    oldStop?.({ tempFilePath: "wxfile://old-recording", duration: 8_400 });
    await Promise.resolve();

    expect(mocks.recorderStart).toHaveBeenCalledTimes(2);
    expect(mocks.saveMaterial).not.toHaveBeenCalled();
    expect(context.data.recording).toBe(true);
    expect(context.data.stoppingRecord).toBe(false);
    expect(actionErrors(context).some((action) => action.id === "record")).toBe(false);
  });

  it("ignores an old error callback after a completed stop and a new recording start", async () => {
    const savedVoice = createMaterial("saved-before-new-recording", "voice");
    mocks.saveMaterial.mockResolvedValueOnce(savedVoice);
    const context = createContext();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();
    context.stopRecord();
    const oldError = recorderErrorHandler;

    recorderStopHandler?.({ tempFilePath: "wxfile://first-recording", duration: 8_400 });
    await vi.waitFor(() => expect(context.data.busyAction).toBe(""));
    context.startRecord();
    oldError?.();

    expect(mocks.recorderStart).toHaveBeenCalledTimes(2);
    expect(context.data.recording).toBe(true);
    expect(context.data.stoppingRecord).toBe(false);
    expect(actionErrors(context).some((action) => action.id === "record")).toBe(false);
  });

  it("retains a recorded file after upload failure and resets recording state", async () => {
    const savedVoice = createMaterial("saved-voice", "voice");
    mocks.saveMaterial
      .mockRejectedValueOnce(new Error("语音上传中断"))
      .mockResolvedValueOnce(savedVoice);
    const context = createContext({ recording: true });

    await context.handleRecordedVoice({ tempFilePath: "wxfile://voice-temp", duration: 12_400 });

    const action = findAction(context, (item) => item.singlePurpose === "voice");
    expect(context.data.recording).toBe(false);
    expect(action.material).toEqual(
      expect.objectContaining({ localPath: "wxfile://voice-temp", durationSeconds: 12 }),
    );

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.saveMaterial.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ localPath: "wxfile://voice-temp", durationSeconds: 12 }),
    );
    expect(context.data.materials[0].id).toBe(savedVoice.id);
  });

  it("adds recorder failures without overwriting an existing retry action", async () => {
    mocks.saveMaterial.mockRejectedValueOnce(new Error("文字保存失败"));
    const context = createContext({ textDraft: "保留文字错误" });
    await context.addText();
    context.onLoad({ demo: "1", session: "session-current" });
    context.startRecord();

    recorderErrorHandler?.();

    expect(context.data.recording).toBe(false);
    expect(actionErrors(context)).toHaveLength(2);
    const recordAction = findAction(context, (action) => action.kind === "record");

    await Promise.all([
      context.retryFailedAction(retryEvent(recordAction.id)),
      context.retryFailedAction(retryEvent(recordAction.id)),
    ]);

    expect(mocks.recorderStart).toHaveBeenCalledTimes(2);
    expect(context.data.recording).toBe(true);
    expect(actionErrors(context).some((action) => action.singlePurpose === "text")).toBe(true);
  });

  it("shows image batch progress and retries only unsaved files", async () => {
    mocks.chooseMedia.mockImplementation(
      (options: { success(result: { tempFiles: Array<{ tempFilePath: string }> }): void }) => {
        options.success({
          tempFiles: [
            { tempFilePath: "wxfile://photo-a" },
            { tempFilePath: "wxfile://photo-b" },
            { tempFilePath: "wxfile://photo-c" },
          ],
        });
      },
    );
    mocks.saveMaterial
      .mockResolvedValueOnce(createMaterial("remote-a", "photo"))
      .mockRejectedValueOnce(new Error("第二张上传失败"))
      .mockResolvedValueOnce(createMaterial("remote-b", "photo"))
      .mockResolvedValueOnce(createMaterial("remote-c", "photo"));
    const context = createContext();

    await context.chooseImage(imageEvent("photo"));

    const action = findAction(context, (item) => item.batchPurpose === "image");
    expect(action.completedCount).toBe(1);
    expect(action.pendingMaterials).toHaveLength(2);
    expect(action.hint).toContain("已加入 1/3 项");
    expect(context.data.materials.map((item: Material) => item.id)).toEqual(["remote-a"]);

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.saveMaterial.mock.calls.map(([item]) => item.localPath)).toEqual([
      "wxfile://photo-a",
      "wxfile://photo-b",
      "wxfile://photo-b",
      "wxfile://photo-c",
    ]);
    expect(context.data.materials.map((item: Material) => item.id)).toEqual([
      "remote-c",
      "remote-b",
      "remote-a",
    ]);
    expect(actionErrors(context)).toEqual([]);
  });

  it("commits an uploaded image locally without uploading it again", async () => {
    mocks.chooseMedia.mockImplementation(
      (options: { success(result: { tempFiles: Array<{ tempFilePath: string }> }): void }) => {
        options.success({ tempFiles: [{ tempFilePath: "wxfile://photo-a" }] });
      },
    );
    mocks.saveMaterial.mockResolvedValueOnce(createMaterial("remote-a", "photo"));
    mocks.updateCurrentMaterialIdsForSession.mockImplementationOnce(() => {
      throw new Error("本地列表写入失败");
    });
    const context = createContext();

    await context.chooseImage(imageEvent("photo"));

    const action = findAction(context, (item) => item.batchPurpose === "image");
    expect(action.stage).toBe("local");
    expect(action.pendingCommits?.map((item) => item.id)).toEqual(["remote-a"]);
    expect(action.pendingMaterials).toEqual([]);
    expect(action.hint).toContain("已保存到服务");

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.saveMaterial).toHaveBeenCalledTimes(1);
    expect(context.data.materials[0].id).toBe("remote-a");
    expect(actionErrors(context)).toEqual([]);
  });

  it("reports demo progress and retries only the unfinished demo items", async () => {
    const first = createMaterial("demo-first");
    const second = createMaterial("demo-second", "photo");
    const third = createMaterial("demo-third", "voice");
    mocks.createDemoMaterials.mockReturnValue([first, second, third]);
    mocks.saveMaterial
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("第二项上传失败"))
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const context = createContext({ demoMode: true });

    await context.loadDemoMaterials();

    const action = findAction(context, (item) => item.batchPurpose === "demo");
    expect(action.completedCount).toBe(1);
    expect(action.pendingMaterials?.map((item) => item.id)).toEqual([second.id, third.id]);
    expect(action.hint).toContain("已加入 1/3 项");

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.saveMaterial.mock.calls.map(([item]) => item.id)).toEqual([
      first.id,
      second.id,
      second.id,
      third.id,
    ]);
    expect(actionErrors(context)).toEqual([]);
  });

  it("keeps a material after service deletion failure and retries the service once", async () => {
    const keep = createMaterial("keep", "photo");
    const remove = createMaterial("remove", "voice");
    currentSelection.ids = [keep.id, remove.id];
    showModalResult = { confirm: true };
    mocks.deleteMaterial
      .mockRejectedValueOnce(new Error("删除请求超时"))
      .mockResolvedValueOnce(undefined);
    const context = createContext({ materials: [keep, remove] });

    await context.deleteMaterial({ currentTarget: { dataset: { id: remove.id } } });

    const action = findAction(context, (item) => item.deleteId === remove.id);
    expect(action.stage).toBe("remote");
    expect(context.data.materials).toEqual([keep, remove]);

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.showModal).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMaterial).toHaveBeenCalledTimes(2);
    expect(context.data.materials).toEqual([keep]);
  });

  it("does not repeat service deletion when only local state update failed", async () => {
    const keep = createMaterial("keep", "photo");
    const remove = createMaterial("remove", "voice");
    currentSelection.ids = [keep.id, remove.id];
    showModalResult = { confirm: true };
    mocks.deleteMaterial.mockResolvedValueOnce(undefined);
    mocks.updateCurrentMaterialIdsForSession.mockImplementationOnce(() => {
      throw new Error("本地删除记录失败");
    });
    const context = createContext({ materials: [keep, remove] });

    await context.deleteMaterial({ currentTarget: { dataset: { id: remove.id } } });

    const action = findAction(context, (item) => item.deleteId === remove.id);
    expect(action.stage).toBe("local");
    expect(action.hint).toContain("不会再次发送删除请求");
    expect(context.data.materials).toEqual([keep, remove]);

    await context.retryFailedAction(retryEvent(action.id));

    expect(mocks.deleteMaterial).toHaveBeenCalledTimes(1);
    expect(context.data.materials).toEqual([keep]);
    expect(actionErrors(context)).toEqual([]);
  });

  it("does not delete a material when confirmation is cancelled", async () => {
    const material = createMaterial("keep", "photo");
    const context = createContext({ materials: [material] });

    await context.deleteMaterial({ currentTarget: { dataset: { id: material.id } } });

    expect(mocks.deleteMaterial).not.toHaveBeenCalled();
    expect(context.data.materials).toEqual([material]);
  });
});
