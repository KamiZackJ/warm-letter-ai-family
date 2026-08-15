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
import { GenerationJobFailedError } from "../src/services/generation-polling";
import { HttpRequestError } from "../src/services/http-client";

const accessTokenKey = "warm_letter_access_token";
const jobsKey = "warm_letter_real_generation_jobs";
const requestKeysKey = "warm_letter_real_generation_request_keys";
const letterId = "letter-recovery-test";
const timestamp = "2026-08-15T12:00:00.000Z";

const serverLetter = {
  id: letterId,
  recipient: "妈妈",
  materialIds: [],
  settings: { tone: "warm", length: "short" },
  state: "EDITING",
  draft: {
    version: 1,
    title: "今天的暖笺",
    greeting: "妈妈：",
    paragraphs: [{ id: "paragraph-1", text: "今天一切顺利。", sourceRefs: [] }],
    closing: "祝好",
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};

function installWxStorage() {
  const storage = new Map<string, unknown>([[accessTokenKey, "test-token"]]);
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
  return storage;
}

describe("real generation recovery", () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    storage = installWxStorage();
    requestMock.mockReset();
  });

  it("reuses the persisted idempotency key after an accepted POST response is lost", async () => {
    const generationHeaders: Array<Record<string, string> | undefined> = [];
    let generationRequestCount = 0;
    requestMock.mockImplementation(async (path: string, options?: { headers?: Record<string, string> }) => {
      if (path === `/letters/${letterId}/generate`) {
        generationHeaders.push(options?.headers);
        generationRequestCount += 1;
        if (generationRequestCount === 1) throw new Error("request:fail timeout");
        return { job: { id: "job-recovered" } };
      }
      if (path === "/jobs/job-recovered") return { job: { status: "succeeded" } };
      if (path === `/letters/${letterId}`) return { letter: serverLetter };
      if (path === `/letters/${letterId}/replies`) return { replies: [] };
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(realApi.generateLetter(letterId)).rejects.toThrow("request:fail timeout");
    const persistedRequestKey = (storage.get(requestKeysKey) as Record<string, string>)[letterId];
    expect(persistedRequestKey).toMatch(/^generation_/);
    expect(storage.get(jobsKey) ?? {}).toEqual({});

    await expect(realApi.generateLetter(letterId)).resolves.toMatchObject({
      id: letterId,
      status: "EDITING",
    });
    expect(generationHeaders).toHaveLength(2);
    expect(generationHeaders[0]?.["idempotency-key"]).toBe(persistedRequestKey);
    expect(generationHeaders[1]?.["idempotency-key"]).toBe(persistedRequestKey);
    expect(storage.get(requestKeysKey)).toEqual({});
    expect(storage.get(jobsKey)).toEqual({});
  });

  it("restarts a stale stored job at most once in one call", async () => {
    storage.set(jobsKey, { [letterId]: "stale-job" });
    storage.set(requestKeysKey, { [letterId]: "generation_stale_recovery_key" });
    const missing = () => new HttpRequestError("missing", 404, "JOB_NOT_FOUND");
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/jobs/stale-job") throw missing();
      if (path === `/letters/${letterId}/generate`) return { job: { id: "replacement-job" } };
      if (path === "/jobs/replacement-job") throw missing();
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(realApi.generateLetter(letterId)).rejects.toMatchObject({
      code: "JOB_NOT_FOUND",
    });
    expect(
      requestMock.mock.calls.filter(([path]) => path === `/letters/${letterId}/generate`),
    ).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("preserves safe failure code and retryability", async () => {
    storage.set(jobsKey, { [letterId]: "failed-job" });
    requestMock.mockResolvedValue({
      job: {
        status: "failed",
        error: { code: "AI_PROVIDER_TIMEOUT", retryable: true },
      },
    });

    const result = realApi.generateLetter(letterId);
    await expect(result).rejects.toBeInstanceOf(GenerationJobFailedError);
    await expect(result).rejects.toMatchObject({
      message: "家书生成失败",
      code: "AI_PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(storage.get(jobsKey)).toEqual({});
  });
});
