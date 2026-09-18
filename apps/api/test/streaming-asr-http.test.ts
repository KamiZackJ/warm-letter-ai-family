import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatProvider, type GenerateLetterInput } from "../src/ai.js";

const audioId = "33333333-3333-4333-8333-333333333333";
const partialTranscript = "仅供慢流测试的未完成文字";
const deadlineMs = 1_000;

type Scenario = "slow-drip" | "stop-without-close" | "no-headers" | "rate-limit";

function input(onTranscript: NonNullable<GenerateLetterInput["onTranscript"]>): GenerateLetterInput {
  return {
    recipient: "家里人",
    settings: { tone: "warm", length: "short" },
    version: 1,
    materials: [{
      id: audioId,
      userId: "local-test-owner",
      type: "audio",
      name: "synthetic.mp3",
      contentType: "audio/mpeg",
      objectKey: "local-test-owner/synthetic.mp3",
      status: "READY",
      createdAt: "2026-09-19T00:00:00.000Z",
    }],
    onTranscript,
  };
}

// Exercise the installed SDK's fetch, SSE parser and AbortError handling.
// All model responses and media bytes are synthetic, and HTTP stays on loopback.
async function withLocalProvider(
  scenario: Scenario,
  run: (context: {
    provider: OpenAICompatibleChatProvider;
    requests: Array<{ model?: string; stream?: boolean }>;
    streamFrames: () => number;
    closedResponses: () => number;
  }) => Promise<void>,
): Promise<void> {
  const requests: Array<{ model?: string; stream?: boolean }> = [];
  const sockets = new Set<Socket>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  let frames = 0;
  let closed = 0;
  const writeFrame = (response: ServerResponse, stop = false) => {
    if (response.destroyed) return;
    frames += 1;
    response.write(`data: ${JSON.stringify({
      choices: [{
        delta: { content: partialTranscript },
        finish_reason: stop ? "stop" : null,
      }],
    })}\n\n`);
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
        stream?: boolean;
      };
      requests.push({ model: body.model, stream: body.stream });
      response.once("close", () => { closed += 1; });
      // If a broken deadline implementation proceeds to writing, return a valid
      // draft so the assertion catches that behavior rather than another error.
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
            title: "近况",
            greeting: "家里人：",
            paragraphs: [{ text: partialTranscript, sourceRefs: [audioId] }],
            closing: "祝平安。",
          }) } }],
        }));
        return;
      }
      if (scenario === "rate-limit") {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "2",
        });
        response.end(JSON.stringify({ error: { message: "synthetic retry delay" } }));
        return;
      }
      if (scenario === "no-headers") return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      writeFrame(response, scenario === "stop-without-close");
      if (scenario === "slow-drip") {
        const interval = setInterval(() => writeFrame(response), 80);
        intervals.add(interval);
        response.once("close", () => {
          clearInterval(interval);
          intervals.delete(interval);
        });
      }
      // Deliberately omit both [DONE] and response.end(). Receiving a stop
      // choice does not mean that the SDK has finished consuming the HTTP body.
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    const client = new OpenAI({
      apiKey: "local-test-key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      // The provider must override this SDK retry budget for the ASR request.
      maxRetries: 5,
      timeout: 60_000,
      logLevel: "off",
    });
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "local-test-key",
      baseURL: "https://example.test/v1",
      model: "local-writer",
      audioMode: "streaming-chat-transcription",
      transcriptionModel: "local-asr",
      timeoutMs: deadlineMs,
      client,
      assetReader: {
        read: async () => ({ bytes: Uint8Array.from([1, 2, 3]), contentType: "audio/mpeg" }),
      },
    });
    await Promise.race([
      run({ provider, requests, streamFrames: () => frames, closedResponses: () => closed }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Local ASR deadline regression timed out")), 5_000);
      }),
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    for (const interval of intervals) clearInterval(interval);
    const stopped = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await stopped;
  }
}

describe("streaming ASR deadline with the real SDK over local HTTP", () => {
  it.each(["slow-drip", "stop-without-close", "no-headers"] as const)(
    "bounds %s, closes the connection and never forwards partial evidence",
    async (scenario) => {
      await withLocalProvider(scenario, async ({ provider, requests, streamFrames, closedResponses }) => {
        const onTranscript = vi.fn();
        const started = Date.now();
        const failure: unknown = await provider.generateLetter(input(onTranscript)).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: "AI_PROVIDER_TIMEOUT", retryable: true });
        expect((failure as Error).message).not.toContain(partialTranscript);
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(onTranscript).not.toHaveBeenCalled();
        expect(requests).toEqual([{ model: "local-asr", stream: true }]);
        if (scenario === "slow-drip") expect(streamFrames()).toBeGreaterThan(1);
        await vi.waitFor(() => expect(closedResponses()).toBe(1), { timeout: 1_000, interval: 10 });
      });
    },
    8_000,
  );

  it("does not enter the SDK Retry-After sleep or issue another ASR request", async () => {
    await withLocalProvider("rate-limit", async ({ provider, requests }) => {
      const onTranscript = vi.fn();
      const started = Date.now();
      await expect(provider.generateLetter(input(onTranscript))).rejects.toMatchObject({
        code: "AI_PROVIDER_RATE_LIMITED",
        retryable: true,
      });
      expect(Date.now() - started).toBeLessThan(deadlineMs);
      expect(requests).toEqual([{ model: "local-asr", stream: true }]);
      expect(onTranscript).not.toHaveBeenCalled();
    });
  }, 8_000);
});
