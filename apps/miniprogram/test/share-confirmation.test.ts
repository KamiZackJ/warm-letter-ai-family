import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LetterDraft } from "../src/types/domain";

type NativeRequest = {
  url: string;
  method: string;
  timeout: number;
  success(response: { statusCode: number; data: unknown }): void;
  fail(error: unknown): void;
};

const draft: LetterDraft = {
  title: "写给妈妈", salutation: "妈妈：",
  paragraphs: [{ id: "paragraph-1", text: "最近一切都好。", sourceRefs: [], sourceAttribution: "user-supplied" }],
  closing: "祝安", signature: "小暖",
};
const serverLetter = {
  id: "letter-1", state: "EDITING", recipient: "妈妈", materialIds: [],
  settings: { tone: "warm", length: "short" },
  draft: { ...draft, version: 1, greeting: draft.salutation },
  createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
};
const publishedResponse = {
  letter: { ...serverLetter, state: "PUBLISHED" }, shareToken: "test-share-token",
};
const shareStorageKey = "warm_letter:test:real_share_tokens";

describe("share confirmation request deadlines", () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    storage = new Map([["warm_letter:test:access_token", "test-access-token"]]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(onShareRequest: (request: NativeRequest) => unknown) {
    const requests: NativeRequest[] = [];
    vi.stubGlobal("wx", {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      request: (request: NativeRequest) => {
        requests.push(request);
        if (request.url.endsWith("/health")) {
          request.success({ statusCode: 200, data: { deploymentMode: "test" } });
        } else if (request.url.endsWith("/confirm") || request.url.endsWith("/share/reissue")) {
          return onShareRequest(request);
        } else if (request.url.endsWith("/replies")) {
          request.success({ statusCode: 200, data: { replies: [] } });
        } else {
          request.success({ statusCode: 200, data: { letter: serverLetter } });
        }
      },
    });
    return requests;
  }

  it.each(["confirm", "reissue"] as const)("allows %s to complete at the server deadline without the old 12-second cutoff", async (kind) => {
    let active!: NativeRequest;
    const abort = vi.fn();
    setup((request) => { active = request; return { abort }; });
    const { realApi } = await import("../src/services/api");
    const onSuccess = vi.fn();
    const pending = (kind === "confirm" ? realApi.confirmLetter("letter-1", draft) : realApi.reissueShare("letter-1"))
      .then(onSuccess);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    active.success({ statusCode: 200, data: publishedResponse });
    await pending;
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED", shareToken: "test-share-token" }));
    expect(storage.get(shareStorageKey)).toEqual({ "letter-1": "test-share-token" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["confirm", "reissue"] as const)("aborts stalled %s once and does not store credentials from a late response", async (kind) => {
    let active!: NativeRequest;
    const abort = vi.fn(() => active.fail({ errMsg: "request:fail abort" }));
    const requests = setup((request) => { active = request; return { abort }; });
    const { realApi } = await import("../src/services/api");
    const onSuccess = vi.fn();
    const pending = (kind === "confirm" ? realApi.confirmLetter("letter-1", draft) : realApi.reissueShare("letter-1"))
      .then(onSuccess, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true });
    expect(abort).toHaveBeenCalledTimes(1);
    active.success({ statusCode: 200, data: publishedResponse });
    await Promise.resolve();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(storage.has(shareStorageKey)).toBe(false);
    expect(requests.filter((request) => request.url.endsWith("/confirm") || request.url.endsWith("/share/reissue"))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["CONTENT_SAFETY_PENDING", "CONTENT_SAFETY_DOWNLOAD_FAILED", "CONTENT_SAFETY_TIMEOUT"])("preserves %s without trying to recover a share token", async (code) => {
    const requests = setup((request) => {
      request.success({ statusCode: 503, data: { error: { code, message: "private upstream details" } } });
    });
    const { realApi } = await import("../src/services/api");
    await expect(realApi.confirmLetter("letter-1", draft)).rejects.toMatchObject({ code });
    expect(storage.has(shareStorageKey)).toBe(false);
    expect(requests.filter((request) => request.method === "GET" && !request.url.endsWith("/health"))).toHaveLength(0);
    expect(requests.some((request) => request.url.endsWith("/share/reissue"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
