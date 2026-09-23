import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("../src/services/http-client", () => {
  class MockHttpRequestError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code?: string,
      readonly retryable?: boolean,
    ) {
      super(message);
      this.name = "HttpRequestError";
    }
  }

  return {
    HttpRequestError: MockHttpRequestError,
    request: requestMock,
    uploadBinary: vi.fn(),
  };
});

import { realApi } from "../src/services/api";
import { HttpRequestError } from "../src/services/http-client";

const accessTokenKey = "warm_letter:test:access_token";
const letterIdsKey = "warm_letter:test:real_letter_ids";
const timestamp = "2026-08-15T12:00:00.000Z";
const loginMock = vi.fn();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serverLetter(id: string, updatedAt = timestamp) {
  return {
    id,
    recipient: "Mom",
    materialIds: [],
    settings: { tone: "warm", length: "short" },
    state: "EDITING",
    draft: {
      version: 1,
      title: `Letter ${id}`,
      greeting: "Dear Mom,",
      paragraphs: [{ id: "paragraph-1", text: "Everything is well.", sourceRefs: [] }],
      closing: "With love",
      signature: "Your child",
    },
    createdAt: timestamp,
    updatedAt,
  };
}

describe("real letter listing", () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    storage = new Map<string, unknown>([[accessTokenKey, "test-token"]]);
    requestMock.mockReset();
    loginMock.mockReset();
    loginMock.mockImplementation(
      ({ success }: { success(result: { code: string }): void }) => {
        success({ code: "fresh-wechat-code" });
      },
    );
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
        login: loginMock,
      },
    });
  });

  it("restores letters from the server even when they were not created on this device", async () => {
    storage.set(letterIdsKey, ["letter-current", "letter-stale"]);
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/letters") {
        return { letters: [serverLetter("letter-current"), serverLetter("another-device")] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(realApi.listLetters()).resolves.toEqual([
      expect.objectContaining({ id: "letter-current" }),
      expect.objectContaining({ id: "another-device" }),
    ]);
    expect(storage.get(letterIdsKey)).toEqual(["letter-current", "another-device"]);
  });

  it("preserves a letter created while stale ID cleanup is still pending", async () => {
    const staleRequest = createDeferred<{ letters: ReturnType<typeof serverLetter>[] }>();
    storage.set(letterIdsKey, ["letter-current", "letter-stale"]);
    requestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/letters" && options?.method !== "POST") {
        return staleRequest.promise;
      }
      if (path === "/letters" && options?.method === "POST") {
        return { letter: serverLetter("letter-new", "2026-08-16T00:00:00.000Z") };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const listing = realApi.listLetters();
    await realApi.createLetter({
      materialIds: [],
      intent: {
        recipient: "Mom",
        message: "Everything is well.",
        tone: "warm",
        length: "short",
        focus: "",
        exclusions: "",
      },
    });
    expect(storage.get(letterIdsKey)).toEqual([
      "letter-new",
      "letter-current",
      "letter-stale",
    ]);

    staleRequest.resolve({ letters: [serverLetter("letter-current")] });
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ id: "letter-current" }),
    ]);

    expect(storage.get(letterIdsKey)).toEqual(["letter-new", "letter-current"]);
  });

  it.each([
    ["a bare 404", new HttpRequestError("not found", 404)],
    ["a different 404", new HttpRequestError("material missing", 404, "MATERIAL_NOT_FOUND")],
    ["rate limiting", new HttpRequestError("too many requests", 429, "RATE_LIMITED", true)],
    ["a server failure", new HttpRequestError("unavailable", 503, "SERVICE_UNAVAILABLE", true)],
    ["a network failure", new Error("request:fail timeout")],
  ])("propagates %s and preserves persisted IDs", async (_label, error) => {
    storage.set(letterIdsKey, ["letter-current"]);
    requestMock.mockRejectedValue(error);

    await expect(realApi.listLetters()).rejects.toBe(error);
    expect(storage.get(letterIdsKey)).toEqual(["letter-current"]);
  });

  it("propagates a failed re-login and preserves persisted IDs", async () => {
    const error = new HttpRequestError("unauthorized", 401, "UNAUTHORIZED");
    storage.set(letterIdsKey, ["letter-current"]);
    requestMock.mockRejectedValue(error);

    await expect(realApi.listLetters()).rejects.toBe(error);

    expect(loginMock).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(storage.has(accessTokenKey)).toBe(false);
    expect(storage.get(letterIdsKey)).toEqual(["letter-current"]);
  });

  it("does not erase local indices when the server list fails", async () => {
    storage.set(letterIdsKey, ["letter-stale", "letter-unavailable"]);
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/letters/letter-stale") {
        throw new HttpRequestError("letter not found", 404, "LETTER_NOT_FOUND");
      }
      throw new HttpRequestError("service unavailable", 503, "SERVICE_UNAVAILABLE", true);
    });

    await expect(realApi.listLetters()).rejects.toMatchObject({ statusCode: 503 });
    expect(storage.get(letterIdsKey)).toEqual(["letter-stale", "letter-unavailable"]);
  });
});
