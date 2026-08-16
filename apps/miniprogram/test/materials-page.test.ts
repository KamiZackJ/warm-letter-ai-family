import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteMaterial: vi.fn(),
  saveCurrentMaterialIds: vi.fn(),
}));

vi.mock("../src/services/api", () => ({
  api: {
    deleteMaterial: mocks.deleteMaterial,
  },
}));

vi.mock("../src/config/demo-materials", () => ({ createDemoMaterials: vi.fn() }));
vi.mock("../src/config/env", () => ({
  environment: { demoEnabled: true },
  environmentView: {},
}));
vi.mock("../src/config/runtime-environment", () => ({ resolveDemoRequest: vi.fn() }));
vi.mock("../src/utils/storage", () => ({
  getCurrentMaterialIds: vi.fn(() => []),
  saveCurrentMaterialIds: mocks.saveCurrentMaterialIds,
}));

type PageDefinition = {
  deleteMaterial(this: PageContext, event: { currentTarget: { dataset: { id: string } } }): Promise<void>;
};

type PageContext = {
  data: {
    materials: Array<{ id: string; name: string }>;
  };
  setData(patch: { materials: Array<{ id: string; name: string }> }): void;
};

let pageDefinition: PageDefinition;
let showModalResult = { confirm: false };

beforeAll(async () => {
  Object.assign(globalThis, {
    wx: {
      getRecorderManager: () => ({
        offStop: vi.fn(),
        offError: vi.fn(),
        onStop: vi.fn(),
        onError: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      showModal: (options: { success(result: { confirm: boolean }): void }) => {
        options.success(showModalResult);
      },
    },
    Page: (definition: PageDefinition) => {
      pageDefinition = definition;
    },
  });

  await import("../src/pages/materials/index");
});

beforeEach(() => {
  mocks.deleteMaterial.mockReset();
  mocks.saveCurrentMaterialIds.mockReset();
  showModalResult = { confirm: false };
});

function createContext(): PageContext {
  const context: PageContext = {
    data: {
      materials: [
        { id: "keep", name: "保留的照片" },
        { id: "remove", name: "准备删除的语音" },
      ],
    },
    setData(patch) {
      context.data.materials = patch.materials;
    },
  };
  return context;
}

describe("materials page deletion", () => {
  it("keeps the material when deletion is cancelled", async () => {
    const context = createContext();

    await pageDefinition.deleteMaterial.call(context, {
      currentTarget: { dataset: { id: "remove" } },
    });

    expect(mocks.deleteMaterial).not.toHaveBeenCalled();
    expect(context.data.materials).toHaveLength(2);
  });

  it("deletes the material only after explicit confirmation", async () => {
    const context = createContext();
    showModalResult = { confirm: true };

    await pageDefinition.deleteMaterial.call(context, {
      currentTarget: { dataset: { id: "remove" } },
    });

    expect(mocks.deleteMaterial).toHaveBeenCalledWith("remove");
    expect(mocks.saveCurrentMaterialIds).toHaveBeenCalledWith(["keep"]);
    expect(context.data.materials).toEqual([{ id: "keep", name: "保留的照片" }]);
  });
});
