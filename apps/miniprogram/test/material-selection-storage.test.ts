import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createId: vi.fn(),
}));

vi.mock("../src/config/env", () => ({
  storageKey: (name: string) => `warm_letter:test:${name}`,
}));

vi.mock("../src/utils/id", () => ({
  createId: mocks.createId,
}));

type StorageModule = typeof import("../src/utils/storage");

const values = new Map<string, unknown>();
let storage: StorageModule;

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      getStorageSync: (key: string) => values.get(key),
      setStorageSync: (key: string, value: unknown) => values.set(key, value),
      removeStorageSync: (key: string) => values.delete(key),
    },
  });
  storage = await import("../src/utils/storage");
});

beforeEach(() => {
  values.clear();
  vi.resetAllMocks();
});

describe("current material-selection storage", () => {
  it("migrates legacy selected IDs into one session-bound snapshot", () => {
    mocks.createId.mockReturnValueOnce("materials-migrated");
    values.set("warm_letter:test:current_material_ids", [
      "legacy-photo",
      "legacy-photo",
      7,
    ]);

    expect(storage.getCurrentMaterialIds()).toEqual(["legacy-photo"]);
    expect(storage.getCurrentMaterialSessionId()).toBe("materials-migrated");
    expect(values.get("warm_letter:test:current_material_selection")).toEqual({
      sessionId: "materials-migrated",
      revision: 0,
      ids: ["legacy-photo"],
    });
    expect(values.has("warm_letter:test:current_material_ids")).toBe(false);
  });

  it("starts a new selection session and clears the old IDs in one snapshot", () => {
    values.set("warm_letter:test:current_material_selection", {
      sessionId: "materials-old",
      revision: 3,
      ids: ["old-private-material"],
    });
    mocks.createId.mockReturnValueOnce("materials-new");

    expect(storage.beginCurrentMaterialSelection()).toBe("materials-new");
    expect(storage.getCurrentMaterialSessionId()).toBe("materials-new");
    expect(storage.getCurrentMaterialIds()).toEqual([]);
  });

  it("rejects an old session write even when the selected IDs return to the same value", () => {
    values.set("warm_letter:test:current_material_selection", {
      sessionId: "materials-old",
      revision: 0,
      ids: [],
    });
    mocks.createId.mockReturnValueOnce("materials-new");
    storage.beginCurrentMaterialSelection();

    expect(
      storage.updateCurrentMaterialIdsForSession("materials-old", () => [
        "old-private-material",
      ]),
    ).toBeUndefined();
    expect(storage.getCurrentMaterialSessionId()).toBe("materials-new");
    expect(storage.getCurrentMaterialIds()).toEqual([]);
  });

  it("rejects a stale revision after selected IDs change from A to B and back to A", () => {
    values.set("warm_letter:test:current_material_selection", {
      sessionId: "materials-current",
      revision: 0,
      ids: [],
    });

    expect(
      storage.updateCurrentMaterialIdsForSession(
        "materials-current",
        () => ["temporary-material"],
        0,
      ),
    ).toEqual({
      sessionId: "materials-current",
      revision: 1,
      ids: ["temporary-material"],
    });
    expect(
      storage.updateCurrentMaterialIdsForSession(
        "materials-current",
        () => [],
        1,
      ),
    ).toEqual({ sessionId: "materials-current", revision: 2, ids: [] });
    expect(
      storage.updateCurrentMaterialIdsForSession(
        "materials-current",
        () => ["stale-material"],
        0,
      ),
    ).toBeUndefined();
    expect(storage.getCurrentMaterialSelection()).toEqual({
      sessionId: "materials-current",
      revision: 2,
      ids: [],
    });
  });

  it("restores previous IDs into a fresh session without reviving the old writer", () => {
    const previous = {
      sessionId: "materials-previous",
      revision: 4,
      ids: ["previous-material"],
    };
    values.set("warm_letter:test:current_material_selection", previous);
    mocks.createId
      .mockReturnValueOnce("materials-opening")
      .mockReturnValueOnce("materials-restored");
    storage.beginCurrentMaterialSelection();

    expect(storage.restoreCurrentMaterialSelection("materials-opening", previous)).toBe(true);
    expect(storage.getCurrentMaterialSelection()).toEqual({
      sessionId: "materials-restored",
      revision: 0,
      ids: ["previous-material"],
    });
    expect(
      storage.updateCurrentMaterialIdsForSession(
        "materials-previous",
        () => ["stale-old-page-material"],
      ),
    ).toBeUndefined();
    expect(storage.getCurrentMaterialIds()).toEqual(["previous-material"]);
    expect(storage.restoreCurrentMaterialSelection("materials-opening", previous)).toBe(false);
  });

  it("rejects generated rollback identities that collide with either superseded session", () => {
    const previous = {
      sessionId: "materials-previous",
      revision: 4,
      ids: ["previous-material"],
    };
    values.set("warm_letter:test:current_material_selection", previous);
    mocks.createId
      .mockReturnValueOnce("materials-opening")
      .mockReturnValueOnce("materials-opening")
      .mockReturnValueOnce("materials-previous")
      .mockReturnValueOnce("materials-restored");
    storage.beginCurrentMaterialSelection();

    expect(storage.restoreCurrentMaterialSelection("materials-opening", previous)).toBe(true);
    expect(storage.getCurrentMaterialSessionId()).toBe("materials-restored");
  });
});
