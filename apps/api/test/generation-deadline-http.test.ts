import { createServer } from "node:http";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatProvider, type GenerateLetterInput } from "../src/ai.js";

const materialId = "33333333-3333-4333-8333-333333333333";
const input: GenerateLetterInput = {
  recipient: "家人", settings: { tone: "warm", length: "short" }, version: 1,
  materials: [{ id: materialId, userId: "owner", type: "text", name: "近况", textContent: "今天开了个会。", status: "READY", createdAt: "2026-09-19T00:00:00.000Z" }],
};
const completeResponse = JSON.stringify({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    title: "近况", greeting: "家人：", paragraphs: [{ text: "今天开了个会。", sourceRefs: [materialId] }], closing: "祝平安。",
  }) } }],
});
type Scenario = "draft-body-stall" | "review-body-stall" | "long-retry-delay" | "short-retry";

async function withProvider(scenario: Scenario, run: (context: {
  provider: OpenAICompatibleChatProvider;
  requests: () => number;
  closed: () => number;
}) => Promise<void>) {
  let requests = 0;
  let closed = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      requests += 1;
      response.once("close", () => { closed += 1; });
      if ((scenario === "long-retry-delay" || scenario === "short-retry") && requests === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": scenario === "long-retry-delay" ? "2" : "0.05" });
        response.end(JSON.stringify({ error: { message: "synthetic rate limit" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (scenario === "draft-body-stall" || (scenario === "review-body-stall" && requests === 2)) {
        response.flushHeaders();
        response.write('{"choices":');
        return; // The real SDK has received headers but is still consuming JSON.
      }
      response.end(completeResponse);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new OpenAI({
      apiKey: "local-test", baseURL: `http://127.0.0.1:${address.port}/v1`,
      timeout: 60_000, maxRetries: 1, logLevel: "off",
    });
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "local-test", model: "test-model", baseURL: "https://example.test/v1",
      generationTimeoutMs: 1_000, timeoutMs: 60_000, maxRetries: 1, client,
    });
    await Promise.race([
      run({ provider, requests: () => requests, closed: () => closed }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("Local generation deadline test exceeded watchdog")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
  }
}

describe("whole generation deadline with the real SDK over loopback HTTP", () => {
  it.each(["draft-body-stall", "review-body-stall"] as const)("cancels %s including JSON body consumption", async (scenario) => {
    await withProvider(scenario, async ({ provider, requests, closed }) => {
      const started = Date.now();
      const result: unknown = await provider.generateLetter(input).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: "AI_PROVIDER_TIMEOUT", retryable: true });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(requests()).toBe(scenario === "draft-body-stall" ? 1 : 2);
      await vi.waitFor(() => expect(closed()).toBe(requests()), { interval: 10, timeout: 1_000 });
    });
  });

  it("ends before a long SDK retry delay and does not issue a late paid request", async () => {
    await withProvider("long-retry-delay", async ({ provider, requests }) => {
      const started = Date.now();
      const result: unknown = await provider.generateLetter(input).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: "AI_PROVIDER_TIMEOUT", retryable: true });
      expect(Date.now() - started).toBeLessThan(1_800);
      expect(requests()).toBe(1);
      // Let the installed SDK's 2-second Retry-After sleep finish. It must
      // observe the aborted signal before issuing another external request.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(requests()).toBe(1);
    });
  });

  it("preserves a configured bounded retry when it completes within the shared budget", async () => {
    await withProvider("short-retry", async ({ provider, requests }) => {
      const draft = await provider.generateLetter(input);
      expect(draft.paragraphs[0]?.sourceRefs).toEqual([materialId]);
      expect(requests()).toBe(3); // First draft is rate limited, then draft + factual review.
    });
  });
});
