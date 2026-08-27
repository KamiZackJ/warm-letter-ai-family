import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("../src/services/http-client", () => ({
  HttpRequestError: class HttpRequestError extends Error {},
  request: requestMock,
  uploadBinary: vi.fn(),
}));

import { realApi } from "../src/services/api";
import type { LetterDraft } from "../src/types/domain";

const accessTokenKey = "warm_letter:test:access_token";
const timestamp = "2026-08-28T00:00:00.000Z";
const draft: LetterDraft = {
  title: "写给妈妈的一封信",
  salutation: "妈妈：",
  paragraphs: [
    {
      id: "paragraph-1",
      text: "最近一切都好。",
      sourceRefs: ["material-1"],
      sourceAttribution: "ai",
    },
  ],
  closing: "愿你平安顺心。",
  signature: "阿宁",
};

function serverDraft(signature: string) {
  return {
    version: 1,
    title: draft.title,
    greeting: draft.salutation,
    paragraphs: draft.paragraphs,
    closing: draft.closing,
    signature,
  };
}

describe("real API signature synchronization", () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    storage = new Map([[accessTokenKey, "test-token"]]);
    requestMock.mockReset();
    Object.assign(globalThis, {
      wx: {
        getStorageSync(key: string) {
          return storage.get(key);
        },
        setStorageSync(key: string, value: unknown) {
          storage.set(key, value);
        },
        removeStorageSync(key: string) {
          storage.delete(key);
        },
      },
    });
  });

  it("sends the signature in the draft patch and maps the server value", async () => {
    requestMock.mockImplementation(async (_path: string, options: { data?: unknown }) => ({
      letter: {
        id: "letter-1",
        recipient: "妈妈",
        materialIds: ["material-1"],
        settings: { tone: "warm", length: "short" },
        state: "EDITING",
        draft: serverDraft("阿宁"),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      requestData: options.data,
    }));

    const result = await realApi.updateDraft("letter-1", draft);

    expect(requestMock).toHaveBeenCalledWith(
      "/letters/letter-1",
      expect.objectContaining({
        method: "PATCH",
        data: expect.objectContaining({
          draft: expect.objectContaining({ signature: "阿宁" }),
        }),
      }),
    );
    expect(result.draft?.signature).toBe("阿宁");
    expect([...storage.keys()].some((key) => key.includes("real_signatures"))).toBe(false);
  });

  it("reads the confirmed signature on a device with no sender-side draft storage", async () => {
    storage.clear();
    requestMock.mockResolvedValue({
      reader: {
        id: "letter-1",
        recipient: "妈妈",
        draft: serverDraft("永远想你的阿宁"),
        publishedAt: timestamp,
        sources: [],
        replies: [],
      },
    });

    const reader = await realApi.getReader("letter-1", "shared-reader-token");

    expect(reader.draft.signature).toBe("永远想你的阿宁");
    expect(requestMock).toHaveBeenCalledWith(
      "/letters/letter-1/reader?token=shared-reader-token",
    );
  });
});
