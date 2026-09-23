import { OperationDeadline } from "./deadline.js";

export type SafetyFailureReason = "timeout" | "network" | "http" | "invalid-response" | "provider";

/** Carries no URL, request body, token or provider message into logs/responses. */
export class ContentSafetyTransportError extends Error {
  constructor(readonly reason: SafetyFailureReason) {
    super("内容安全检查暂时不可用，请稍后重试");
    this.name = "ContentSafetyTransportError";
  }
}

export function validateSafetyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 500 || value > 60_000) {
    throw new Error("Content safety timeout must be an integer between 500 and 60000");
  }
  return value;
}

export function safetyEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new Error("Content safety endpoint must be an HTTPS URL without credentials, query or fragment");
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The same deadline covers headers and the complete bounded body, including ignored aborts. */
export async function safetyPostJson(
  fetchImpl: typeof fetch,
  url: URL | string,
  body: unknown,
  deadline: OperationDeadline,
): Promise<Record<string, unknown>> {
  try {
    const response = await deadline.wait(async () => {
      const result = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: deadline.signal,
        redirect: "error",
      });
      // A transport ignoring AbortSignal can resolve after its owner has timed out.
      if (deadline.signal.aborted) void result.body?.cancel().catch(() => undefined);
      return result;
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ContentSafetyTransportError("http");
    }
    if (!response.body) throw new ContentSafetyTransportError("invalid-response");
    const maxBytes = 128 * 1024;
    const advertisedBytes = response.headers.get("content-length");
    if (advertisedBytes && Number(advertisedBytes) > maxBytes) {
      void response.body.cancel().catch(() => undefined);
      throw new ContentSafetyTransportError("invalid-response");
    }
    const reader = response.body.getReader();
    const removeCleanup = deadline.addCleanup(() => reader.cancel());
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      while (true) {
        const next = await deadline.wait(() => reader.read());
        if (next.done) break;
        byteLength += next.value.byteLength;
        if (byteLength > maxBytes) throw new ContentSafetyTransportError("invalid-response");
        chunks.push(next.value);
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8"));
      if (!isObject(payload)) throw new ContentSafetyTransportError("invalid-response");
      return payload;
    } finally {
      removeCleanup();
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof ContentSafetyTransportError) throw error;
    if (deadline.signal.aborted) throw new ContentSafetyTransportError("timeout");
    // JSON parse, URL and fetch errors may include credentials; never retain cause.
    throw new ContentSafetyTransportError(error instanceof SyntaxError ? "invalid-response" : "network");
  }
}
