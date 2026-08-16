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
});
