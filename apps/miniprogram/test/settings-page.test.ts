import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listLetters: vi.fn(), deleteLetter: vi.fn(), deleteAccount: vi.fn(), showModal: vi.fn() }));
vi.mock("../src/services/api", () => ({ api: { listLetters: mocks.listLetters, deleteLetter: mocks.deleteLetter, deleteAccount: mocks.deleteAccount } }));

let definition: any;
function context() {
  const data = { ...definition.data, letters: [{ id: "letter-1", title: "给妈妈" }] };
  return { ...definition, data, pendingLocalLetterIds: [], setData: (patch: Record<string, unknown>) => Object.assign(data, patch) };
}
const event = { currentTarget: { dataset: { id: "letter-1" } } };

beforeAll(async () => {
  Object.assign(globalThis, { Page: (value: unknown) => { definition = value; }, wx: { showModal: mocks.showModal } });
  await import("../src/pages/settings/index");
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listLetters.mockResolvedValue([]);
  mocks.deleteLetter.mockResolvedValue({ localCleanupComplete: true });
  mocks.deleteAccount.mockResolvedValue({ localCleanupComplete: true });
  mocks.showModal.mockImplementation((options: any) => options.success({ confirm: true }));
});

describe("data management confirmations", () => {
  it("requires explicit confirmation and keeps the letter when cancelled", async () => {
    mocks.showModal.mockImplementationOnce((options: any) => options.success({ confirm: false }));
    const page = context();
    await page.deleteLetter(event);
    expect(mocks.deleteLetter).not.toHaveBeenCalled();
    expect(page.data.letters).toHaveLength(1);
    expect(page.data.busy).toBe(false);
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("无法恢复") }));
  });

  it("prevents duplicate deletion while confirmation is open", async () => {
    let decide: any;
    mocks.showModal.mockImplementationOnce((options: any) => { decide = options.success; });
    const page = context();
    const pending = page.deleteLetter(event);
    await page.deleteLetter(event);
    await page.deleteAccount();
    expect(mocks.showModal).toHaveBeenCalledOnce();
    decide({ confirm: true });
    await pending;
    expect(mocks.deleteLetter).toHaveBeenCalledOnce();
    expect(page.data.letters).toEqual([]);
  });

  it("preserves visible data and avoids success notice when erasure fails", async () => {
    mocks.deleteAccount.mockRejectedValueOnce(new Error("网络暂时不可用"));
    const page = context();
    await page.deleteAccount();
    expect(page.data.accountDeleted).toBe(false);
    expect(page.data.letters).toHaveLength(1);
    expect(page.data.notice).toBe("");
    expect(page.data.error).toBe("网络暂时不可用");
    expect(page.data.busy).toBe(false);
  });

  it("separates completed cloud deletion from retryable local cleanup", async () => {
    mocks.deleteAccount.mockResolvedValueOnce({ localCleanupComplete: false });
    const page = context();
    await page.deleteAccount();
    expect(page.data.accountDeleted).toBe(true);
    expect(page.data.localCleanupNeeded).toBe(true);
    expect(page.data.notice).toContain("云端数据已删除");
    await page.onShow();
    expect(mocks.listLetters).not.toHaveBeenCalled();
  });
});
