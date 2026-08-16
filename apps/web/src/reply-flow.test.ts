import { describe, expect, it, vi } from "vitest";
import {
  acquireReplyAttempt,
  appendReply,
  createReplyRequestKey,
  mergeReaderPreservingReplies,
  postReply,
  retainReplyAttemptForDraft,
  type ReplyRecord,
} from "./reply-flow";

const createdReply: ReplyRecord = {
  id: "reply-1",
  text: "收到信了",
  authorName: "家人",
  authorVerified: false,
  createdAt: "2026-08-16T08:00:00.000Z",
};

describe("reply request identity", () => {
  it("reuses the same key for a failed retry of the same normalized draft", () => {
    const createKey = vi.fn().mockReturnValueOnce("reply:key-1").mockReturnValueOnce("reply:key-2");
    const first = acquireReplyAttempt(null, " 收到信了 ", createKey);
    const retry = acquireReplyAttempt(first, "收到信了", createKey);

    expect(retry).toBe(first);
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("drops the prior key only after the reply content changes", () => {
    const createKey = vi.fn().mockReturnValueOnce("reply:key-1").mockReturnValueOnce("reply:key-2");
    const first = acquireReplyAttempt(null, "收到信了", createKey);

    expect(retainReplyAttemptForDraft(first, "  收到信了  ")).toBe(first);
    const changed = retainReplyAttemptForDraft(first, "周末联系");
    expect(changed).toBeNull();
    expect(acquireReplyAttempt(changed, "周末联系", createKey)).toEqual({
      requestKey: "reply:key-2",
      text: "周末联系",
    });
  });

  it("creates an API-compatible key when randomUUID is unavailable", () => {
    const source = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        const bytes = array as Uint8Array;
        bytes.forEach((_, index) => {
          bytes[index] = index;
        });
        return array;
      },
    };

    expect(createReplyRequestKey(source)).toMatch(
      /^reply:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("postReply", () => {
  it("sends the stable key and consumes the POST reply without a follow-up GET", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ reply: createdReply }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const controller = new AbortController();

    await expect(
      postReply({
        apiBaseUrl: "https://api.example.test/v1",
        letterId: "letter / 1",
        shareToken: "token / 1",
        text: createdReply.text,
        authorName: createdReply.authorName,
        requestKey: "reply:stable-request-key",
        signal: controller.signal,
        fetcher,
      }),
    ).resolves.toEqual(createdReply);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v1/letters/letter%20%2F%201/replies?token=token%20%2F%201",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "reply:stable-request-key",
        },
        body: JSON.stringify({ text: "收到信了", authorName: "家人" }),
        signal: controller.signal,
      }),
    );
  });

  it("keeps an ambiguous successful response retryable with the same request identity", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 201 }));

    await expect(
      postReply({
        apiBaseUrl: "https://api.example.test/v1",
        letterId: "letter-1",
        shareToken: "token-1",
        text: createdReply.text,
        authorName: createdReply.authorName,
        requestKey: "reply:stable-request-key",
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REPLY_RESPONSE" });
  });

  it("uses the same header when a failed submission is retried unchanged", async () => {
    const requestKeys: string[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") || "");
        return new Response(
          JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "暂时不可用" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") || "");
        return new Response(JSON.stringify({ reply: createdReply }), { status: 201 });
      });
    const createKey = vi.fn(() => "reply:stable-request-key");
    const firstAttempt = acquireReplyAttempt(null, createdReply.text, createKey);
    const submit = (requestKey: string) =>
      postReply({
        apiBaseUrl: "https://api.example.test/v1",
        letterId: "letter-1",
        shareToken: "token-1",
        text: createdReply.text,
        authorName: createdReply.authorName,
        requestKey,
        fetcher,
      });

    await expect(submit(firstAttempt.requestKey)).rejects.toMatchObject({ status: 503 });
    const retryAttempt = acquireReplyAttempt(firstAttempt, createdReply.text, createKey);
    await expect(submit(retryAttempt.requestKey)).resolves.toEqual(createdReply);

    expect(requestKeys).toEqual(["reply:stable-request-key", "reply:stable-request-key"]);
    expect(createKey).toHaveBeenCalledOnce();
  });
});

describe("reply merge", () => {
  it("deduplicates an idempotent replay", () => {
    expect(appendReply([createdReply], createdReply)).toEqual([createdReply]);
  });

  it("preserves a POSTed reply when an older media refresh resolves later", async () => {
    let currentReader = {
      id: "letter-1",
      sources: [{ id: "fresh-local" }],
      replies: [] as ReplyRecord[],
    };
    const staleRefresh = {
      id: "letter-1",
      sources: [{ id: "refreshed-media" }],
      replies: [] as ReplyRecord[],
    };
    let resolveRefresh!: (reader: typeof staleRefresh) => void;
    const pendingRefresh = new Promise<typeof staleRefresh>((resolve) => {
      resolveRefresh = resolve;
    }).then((reader) => {
      currentReader = mergeReaderPreservingReplies(reader, currentReader);
    });

    currentReader = {
      ...currentReader,
      replies: appendReply(currentReader.replies, createdReply),
    };
    resolveRefresh(staleRefresh);
    await pendingRefresh;

    expect(currentReader).toEqual({
      ...staleRefresh,
      replies: [createdReply],
    });
  });
});
