import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("../src/services/http-client", () => ({
  HttpRequestError: class MockHttpRequestError extends Error {},
  request: requestMock,
  uploadBinary: vi.fn(),
}));

import { realApi } from "../src/services/api";

describe("real reply API", () => {
  beforeEach(() => {
    requestMock.mockReset();
    Object.assign(globalThis, { wx: { getStorageSync: () => "session-token" } });
  });

  it("returns the POST result directly and sends the retry key", async () => {
    const reply = {
      id: "reply-1",
      text: "收到信了",
      authorName: "家人",
      authorVerified: false,
      createdAt: "2026-08-16T10:00:00.000Z",
    };
    requestMock.mockResolvedValue({ reply });

    await expect(
      realApi.addReply(
        "letter-1",
        reply.text,
        "share-token",
        "reply_20260816_retry_after_lost_response",
      ),
    ).resolves.toEqual(reply);

    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledWith(
      "/letters/letter-1/replies?token=share-token",
      {
        method: "POST",
        headers: {
          "idempotency-key": "reply_20260816_retry_after_lost_response",
        },
        data: { text: reply.text, authorName: "家人" },
      },
    );
  });

  it("logs in through WeChat before accepting a reply from a shared reader", async () => {
    const storage = new Map<string, unknown>();
    const login = vi.fn((options: any) => options.success({ code: "reader-code" }));
    Object.assign(globalThis, { wx: {
      login,
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
    } });
    requestMock.mockImplementation(async (path: string) => path === "/auth/wx-login"
      ? { token: "reader-session" }
      : { reply: { id: "reply-2", text: "收到", authorName: "家人", authorVerified: true, createdAt: "2026-09-23T00:00:00.000Z" } });
    await expect(realApi.addReply("letter-1", "收到", "share-token", "retry-key")).resolves.toMatchObject({ authorVerified: true });
    expect(login).toHaveBeenCalledOnce();
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual(["/auth/wx-login", "/letters/letter-1/replies?token=share-token"]);
    expect(storage.get("warm_letter:test:access_token")).toBe("reader-session");
  });
});
