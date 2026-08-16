import { ApiRequestError, apiErrorFrom } from "./api-request";

export type ReplyRecord = {
  id: string;
  text: string;
  authorName: string;
  authorVerified: boolean;
  createdAt: string;
};

export type ReplyAttempt = {
  requestKey: string;
  text: string;
};

type CryptoSource = Pick<Crypto, "getRandomValues"> &
  Partial<Pick<Crypto, "randomUUID">>;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type PostReplyOptions = {
  apiBaseUrl: string;
  letterId: string;
  shareToken: string;
  text: string;
  authorName: string;
  requestKey: string;
  signal?: AbortSignal;
  fetcher?: Fetcher;
};

function uuidFromRandomBytes(source: Pick<Crypto, "getRandomValues">): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createReplyRequestKey(source: CryptoSource = globalThis.crypto): string {
  const uuid = source.randomUUID?.() ?? uuidFromRandomBytes(source);
  return `reply:${uuid}`;
}

export function acquireReplyAttempt(
  current: ReplyAttempt | null,
  draft: string,
  createKey: () => string = createReplyRequestKey,
): ReplyAttempt {
  const text = draft.trim();
  if (current?.text === text) return current;
  return { requestKey: createKey(), text };
}

export function retainReplyAttemptForDraft(
  current: ReplyAttempt | null,
  draft: string,
): ReplyAttempt | null {
  if (!current || current.text === draft.trim()) return current;
  return null;
}

function isReplyRecord(value: unknown): value is ReplyRecord {
  if (!value || typeof value !== "object") return false;
  const reply = value as Partial<ReplyRecord>;
  return (
    typeof reply.id === "string" &&
    typeof reply.text === "string" &&
    typeof reply.authorName === "string" &&
    typeof reply.authorVerified === "boolean" &&
    typeof reply.createdAt === "string"
  );
}

export async function postReply({
  apiBaseUrl,
  letterId,
  shareToken,
  text,
  authorName,
  requestKey,
  signal,
  fetcher = fetch,
}: PostReplyOptions): Promise<ReplyRecord> {
  const response = await fetcher(
    `${apiBaseUrl}/letters/${encodeURIComponent(letterId)}/replies?token=${encodeURIComponent(shareToken)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": requestKey,
      },
      body: JSON.stringify({ text, authorName }),
      referrerPolicy: "no-referrer",
      signal,
    },
  );
  if (!response.ok) {
    throw await apiErrorFrom(response, "回复发送失败，请稍后重试");
  }

  let payload: { reply?: unknown };
  try {
    payload = (await response.json()) as { reply?: unknown };
  } catch {
    throw new ApiRequestError(
      "回复可能已送达，但服务返回结果异常。请重试，系统会避免重复保存。",
      502,
      "INVALID_REPLY_RESPONSE",
    );
  }
  if (!isReplyRecord(payload.reply)) {
    throw new ApiRequestError(
      "回复可能已送达，但服务返回结果异常。请重试，系统会避免重复保存。",
      502,
      "INVALID_REPLY_RESPONSE",
    );
  }
  return payload.reply;
}

export function appendReply(replies: ReplyRecord[], reply: ReplyRecord): ReplyRecord[] {
  const existingIndex = replies.findIndex((item) => item.id === reply.id);
  if (existingIndex < 0) return [...replies, reply];
  return replies.map((item, index) => (index === existingIndex ? reply : item));
}

export function mergeReplies(
  refreshedReplies: ReplyRecord[],
  currentReplies: ReplyRecord[],
): ReplyRecord[] {
  const merged = [...refreshedReplies];
  const knownIds = new Set(refreshedReplies.map((reply) => reply.id));
  for (const reply of currentReplies) {
    if (knownIds.has(reply.id)) continue;
    merged.push(reply);
    knownIds.add(reply.id);
  }
  return merged;
}

export function mergeReaderPreservingReplies<T extends { id: string; replies: ReplyRecord[] }>(
  refreshedReader: T,
  currentReader: T,
): T {
  if (refreshedReader.id !== currentReader.id) return refreshedReader;
  return {
    ...refreshedReader,
    replies: mergeReplies(refreshedReader.replies, currentReader.replies),
  };
}
