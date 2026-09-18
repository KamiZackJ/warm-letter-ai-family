import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Letter, Material } from "../src/types/domain";

const mocks = vi.hoisted(() => ({
  getLetter: vi.fn(),
  listMaterials: vi.fn(),
  updateAudioTranscript: vi.fn(),
  generateLetter: vi.fn(),
  updateDraft: vi.fn(),
  showModal: vi.fn(),
  showToast: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  navigateTo: vi.fn(),
  clearPendingGeneration: vi.fn(),
}));

vi.mock("../src/services/api", () => ({ api: mocks }));
vi.mock("../src/config/env", () => ({ environmentView: {} }));
vi.mock("../src/utils/storage", () => ({ clearPendingGeneration: mocks.clearPendingGeneration }));

type PageDefinition = { data: Record<string, any>; [key: string]: any };
let pageDefinition: PageDefinition;

const material: Material = {
  id: "audio-1", type: "voice", name: "今天的语音.m4a", createdAt: "2026-09-18T12:00:00Z",
};

function letter(confirmed = false): Letter {
  return {
    id: "letter-1", status: "EDITING", materialIds: ["audio-1"],
    intent: { recipient: "家里人", message: "", tone: "warm", length: "short", focus: "", exclusions: "" },
    draft: {
      title: "今天的近况", salutation: "家里人：", signature: "小暖", closing: "下次聊。",
      paragraphs: [{
        id: "paragraph-1", text: confirmed ? "开了个会，有点累。" : "开了个长会，有点累。",
        sourceRefs: ["audio-1"], sourceAttribution: confirmed ? "ai" : "needs-review",
      }],
    },
    audioTranscripts: [{ materialId: "audio-1", text: confirmed ? "开了个会，有点累。" : "开了个长会，有点累。", confirmed }],
    audioTranscriptRevisionPending: false,
    replies: [], createdAt: "2026-09-18T12:00:00Z", updatedAt: "2026-09-18T12:00:00Z",
  };
}

function context(): PageDefinition {
  const pageData = structuredClone(pageDefinition.data);
  return {
    ...pageDefinition, data: pageData,
    setData(patch: Record<string, unknown>) { Object.assign(pageData, patch); },
  };
}

function edit(page: PageDefinition, text: string) {
  page.updateAudioTranscript({ currentTarget: { dataset: { materialId: "audio-1" } }, detail: { value: text } });
}

beforeAll(async () => {
  Object.assign(globalThis, { wx: mocks, Page: (definition: PageDefinition) => { pageDefinition = definition; } });
  await import("../src/pages/editor/index");
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getLetter.mockResolvedValue(letter());
  mocks.listMaterials.mockResolvedValue([material]);
  mocks.showModal.mockImplementation(({ success }) => success({ confirm: true }));
  mocks.updateAudioTranscript.mockImplementation(async (_id, _materialId, text) => ({
    ...letter(true), audioTranscripts: [{ materialId: "audio-1", text, confirmed: true }],
    audioTranscriptRevisionPending: true,
  }));
  mocks.generateLetter.mockResolvedValue(letter(true));
});

describe("editor audio transcript correction", () => {
  it("loads actual private transcripts and keeps original audio attribution pending until explicit confirmation", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    expect(page.data.audioTranscripts[0]).toMatchObject({ name: material.name, text: "开了个长会，有点累。", confirmed: false });
    expect(page.validateDraft(true)).toBe(false);
    page.confirmParagraphSources({ currentTarget: { dataset: { index: 0 } } });
    expect(page.data.draft.paragraphs[0].sourceAttribution).toBe("sources-confirmed");
    expect(page.validateDraft(true)).toBe(true);
  });

  it("saves the corrected text before regeneration and displays the returned replacement draft", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    edit(page, "  开了个会，有点累。  ");
    await page.saveTranscriptsAndRegenerate();
    expect(mocks.updateAudioTranscript).toHaveBeenCalledWith("letter-1", "audio-1", "开了个会，有点累。");
    expect(mocks.updateAudioTranscript.mock.invocationCallOrder[0]).toBeLessThan(mocks.generateLetter.mock.invocationCallOrder[0]!);
    expect(page.data.draft.paragraphs[0].text).toBe("开了个会，有点累。");
    expect(page.data.audioTranscriptRevisionPending).toBe(false);
    expect(page.data.audioTranscriptUnsaved).toBe(false);
    expect(mocks.getLetter).toHaveBeenCalledTimes(1);
  });

  it("retains saved corrections after generation failure and retries without another transcript patch", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    edit(page, "开了个会，有点累。");
    mocks.generateLetter.mockRejectedValueOnce(new Error("供应商暂时繁忙"));
    await page.saveTranscriptsAndRegenerate();
    expect(page.data.audioTranscriptRevisionPending).toBe(true);
    expect(page.data.audioTranscripts[0]).toMatchObject({ text: "开了个会，有点累。", confirmed: true });
    expect(page.data.transcriptError).toContain("已保存的语音文字会保留");
    expect(page.data.errorMessage).toBe("");
    await page.previewLetter();
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.updateDraft).not.toHaveBeenCalled();
    await page.regenerate();
    expect(mocks.updateAudioTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.generateLetter).toHaveBeenCalledTimes(2);
    expect(page.data.audioTranscriptRevisionPending).toBe(false);
    expect(page.data.transcriptError).toBe("");
  });

  it("does not regenerate or discard the input when saving fails", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    edit(page, "开了个会，有点累。");
    mocks.updateAudioTranscript.mockRejectedValueOnce(new Error("网络不可用"));
    await page.saveTranscriptsAndRegenerate();
    expect(mocks.generateLetter).not.toHaveBeenCalled();
    expect(page.data.audioTranscripts[0].text).toBe("开了个会，有点累。");
    expect(page.data.audioTranscriptUnsaved).toBe(true);
    expect(page.data.transcriptError).toContain("尚未保存");
  });

  it("keeps a partial multi-recording save and retries only unfinished corrections", async () => {
    const original = letter();
    original.materialIds.push("audio-2");
    original.audioTranscripts!.push({ materialId: "audio-2", text: "明天回家。", confirmed: false });
    mocks.getLetter.mockResolvedValue(original);
    mocks.listMaterials.mockResolvedValue([material, { ...material, id: "audio-2", name: "另一段语音.m4a" }]);
    const page = context();
    await page.onLoad({ id: "letter-1" });
    edit(page, "开了个会，有点累。");
    page.updateAudioTranscript({ currentTarget: { dataset: { materialId: "audio-2" } }, detail: { value: "后天回家。" } });
    mocks.updateAudioTranscript
      .mockResolvedValueOnce({ ...letter(true), audioTranscriptRevisionPending: true })
      .mockRejectedValueOnce(new Error("第二段保存失败"));
    await page.saveTranscriptsAndRegenerate();
    expect(page.data.audioTranscripts[0].confirmed).toBe(true);
    expect(page.data.audioTranscripts[1].text).toBe("后天回家。");
    expect(page.data.audioTranscriptUnsaved).toBe(true);
    expect(mocks.generateLetter).not.toHaveBeenCalled();
    await page.saveTranscriptsAndRegenerate();
    expect(mocks.updateAudioTranscript.mock.calls.map((call) => call[1])).toEqual(["audio-1", "audio-2", "audio-2"]);
    expect(mocks.generateLetter).toHaveBeenCalledTimes(1);
  });

  it("rejects empty input and does not silently regenerate with unsaved edits", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    edit(page, "  ");
    await page.saveTranscriptsAndRegenerate();
    expect(mocks.updateAudioTranscript).not.toHaveBeenCalled();
    expect(page.data.transcriptError).toContain("请填写");
    edit(page, "开了个会，有点累。");
    await page.regenerate();
    expect(mocks.generateLetter).not.toHaveBeenCalled();
    expect(page.data.transcriptError).toContain("未保存");
  });

  it("prevents duplicate saves and concurrent regeneration while the confirmation dialog is open", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    let confirm: ((result: { confirm: boolean }) => void) | undefined;
    mocks.showModal.mockImplementation(({ success }) => { confirm = success; });
    const operation = page.saveTranscriptsAndRegenerate();
    await page.saveTranscriptsAndRegenerate();
    await page.regenerate();
    expect(mocks.showModal).toHaveBeenCalledTimes(1);
    expect(mocks.updateAudioTranscript).not.toHaveBeenCalled();
    confirm!({ confirm: true });
    await operation;
    expect(mocks.updateAudioTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.generateLetter).toHaveBeenCalledTimes(1);
  });

  it("leaves all server state unchanged after cancellation", async () => {
    const page = context();
    await page.onLoad({ id: "letter-1" });
    mocks.showModal.mockImplementation(({ success }) => success({ confirm: false }));
    await page.saveTranscriptsAndRegenerate();
    expect(mocks.updateAudioTranscript).not.toHaveBeenCalled();
    expect(mocks.generateLetter).not.toHaveBeenCalled();
    expect(page.data.transcriptSaving).toBe(false);
  });

  it("resumes an in-flight replacement even when an older draft exists", async () => {
    mocks.getLetter.mockResolvedValue({ ...letter(), status: "GENERATING", audioTranscriptRevisionPending: true });
    const page = context();
    await page.onLoad({ id: "letter-1" });
    expect(mocks.generateLetter).toHaveBeenCalledWith("letter-1");
    expect(page.data.draft.paragraphs[0].text).toBe("开了个会，有点累。");
    expect(mocks.clearPendingGeneration.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.generateLetter.mock.invocationCallOrder[0]!);
  });

  it("keeps recovery state when the resumed replacement is still pending", async () => {
    mocks.getLetter.mockResolvedValue({ ...letter(), status: "GENERATING", audioTranscriptRevisionPending: true });
    mocks.generateLetter.mockRejectedValue(new Error("后台仍在整理"));
    const page = context();
    await page.onLoad({ id: "letter-1" });
    expect(mocks.clearPendingGeneration).not.toHaveBeenCalled();
    expect(page.data.errorMessage).toBe("后台仍在整理");
  });
});
