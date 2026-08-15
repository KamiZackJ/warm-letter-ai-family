import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIProviderError,
  FakeAIProvider,
  type AIProvider,
} from "../src/ai.js";
import { buildApp } from "../src/app.js";
import { auth, json, login, registerTextMaterial } from "./helpers.js";

interface HttpGenerationJob {
  id: string;
  letterId: string;
  status: string;
  type?: string;
  attempts?: number;
  maxAttempts?: number;
  finishedAt?: string;
  error?: Record<string, unknown>;
}

function failingProvider(error: AIProviderError): AIProvider {
  return {
    name: "failing-provider",
    generateLetter: vi.fn().mockRejectedValue(error),
  };
}

function providerThatFailsAfterOneSuccess(error: AIProviderError): AIProvider {
  const successfulProvider = new FakeAIProvider();
  let generationCount = 0;

  return {
    name: "success-then-failure-provider",
    generateLetter: vi.fn(async (input) => {
      generationCount += 1;
      if (generationCount === 1) return successfulProvider.generateLetter(input);
      throw error;
    }),
  };
}

async function createReadyLetter(app: FastifyInstance) {
  const token = await login(app, "generation-http-error-test");
  const materialId = await registerTextMaterial(app, token, "今天完成了项目演示。");
  const response = await app.inject({
    method: "POST",
    url: "/v1/letters",
    headers: auth(token),
    payload: { recipient: "妈妈", materialIds: [materialId] },
  });
  expect(response.statusCode).toBe(201);
  const letterId = json<{ letter: { id: string } }>(response).letter.id;
  return { token, letterId };
}

async function startGeneration(
  app: FastifyInstance,
  token: string,
  letterId: string,
  idempotencyKey?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/generate`,
    headers: {
      ...auth(token),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });
  expect(response.statusCode).toBe(202);
  return json<{ job: { id: string } }>(response).job.id;
}

async function waitForTerminalJob(
  app: FastifyInstance,
  token: string,
  jobId: string,
): Promise<{ job: HttpGenerationJob; rawBody: string }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const job = json<{ job: HttpGenerationJob }>(response).job;
    if (job.status === "succeeded" || job.status === "failed") {
      return { job, rawBody: response.body };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not finish`);
}

async function expectLetterState(
  app: FastifyInstance,
  token: string,
  letterId: string,
  expectedState: string,
) {
  const response = await app.inject({
    method: "GET",
    url: `/v1/letters/${letterId}`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  expect(json<{ letter: { state: string } }>(response).letter.state).toBe(expectedState);
}

describe("generation job failure HTTP responses", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("exposes a retryable timeout without leaking the provider message and restores materials ready", async () => {
    const internalMessage =
      "provider-internal-timeout request_id=req_secret_timeout api_key=sk-test-do-not-leak";
    app = buildApp({
      deploymentMode: "test",
      aiProvider: failingProvider(
        new AIProviderError("AI_PROVIDER_TIMEOUT", internalMessage, true),
      ),
    });
    const { token, letterId } = await createReadyLetter(app);

    const idempotencyKey = "generation_timeout_http_replay";
    const jobId = await startGeneration(app, token, letterId, idempotencyKey);
    const { job, rawBody } = await waitForTerminalJob(app, token, jobId);

    expect(job).toMatchObject({
      id: jobId,
      letterId,
      status: "failed",
      type: "generate_letter",
      attempts: 1,
      maxAttempts: 1,
      finishedAt: expect.any(String),
    });
    expect(job.error).toEqual({ code: "AI_PROVIDER_TIMEOUT", retryable: true });
    expect(rawBody).not.toContain(internalMessage);
    expect(rawBody).not.toContain("sk-test-do-not-leak");
    await expectLetterState(app, token, letterId, "MATERIALS_READY");

    const replayResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: { ...auth(token), "idempotency-key": idempotencyKey },
    });
    expect(replayResponse.statusCode).toBe(202);
    expect(json<{ job: HttpGenerationJob }>(replayResponse).job).toMatchObject({
      id: jobId,
      status: "failed",
      error: { code: "AI_PROVIDER_TIMEOUT", retryable: true },
    });
    expect(replayResponse.body).not.toContain(internalMessage);
  });

  it("exposes invalid output as non-retryable without leaking details and restores editing", async () => {
    const internalMessage =
      "provider-internal-validation zod_path=paragraphs.0.sourceRefs database_row=secret";
    app = buildApp({
      deploymentMode: "test",
      aiProvider: providerThatFailsAfterOneSuccess(
        new AIProviderError("AI_OUTPUT_INVALID", internalMessage, false),
      ),
    });
    const { token, letterId } = await createReadyLetter(app);

    const successfulJobId = await startGeneration(app, token, letterId);
    expect((await waitForTerminalJob(app, token, successfulJobId)).job.status).toBe("succeeded");
    await expectLetterState(app, token, letterId, "EDITING");

    const failedJobId = await startGeneration(app, token, letterId);
    const { job, rawBody } = await waitForTerminalJob(app, token, failedJobId);

    expect(job).toMatchObject({
      id: failedJobId,
      letterId,
      status: "failed",
      type: "generate_letter",
      attempts: 1,
      maxAttempts: 1,
      finishedAt: expect.any(String),
    });
    expect(job.error).toEqual({ code: "AI_OUTPUT_INVALID", retryable: false });
    expect(rawBody).not.toContain(internalMessage);
    expect(rawBody).not.toContain("database_row=secret");
    await expectLetterState(app, token, letterId, "EDITING");
  });

  it("returns the same completed job when an accepted generation request is retried", async () => {
    const fakeProvider = new FakeAIProvider();
    const generateLetter = vi.spyOn(fakeProvider, "generateLetter");
    app = buildApp({ deploymentMode: "test", aiProvider: fakeProvider });
    const { token, letterId } = await createReadyLetter(app);
    const idempotencyKey = "generation_retry_after_lost_202_response";

    const firstResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: { ...auth(token), "idempotency-key": idempotencyKey },
    });
    expect(firstResponse.statusCode).toBe(202);
    const firstJob = json<{ job: HttpGenerationJob }>(firstResponse).job;
    expect(await waitForTerminalJob(app, token, firstJob.id)).toMatchObject({
      job: { status: "succeeded" },
    });

    const retryResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: { ...auth(token), "idempotency-key": idempotencyKey },
    });
    expect(retryResponse.statusCode).toBe(202);
    expect(json<{ job: HttpGenerationJob }>(retryResponse).job.id).toBe(firstJob.id);
    expect(retryResponse.body).not.toContain("idempotencyKey");
    expect(retryResponse.body).not.toContain("userId");
    expect(generateLetter).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed generation idempotency keys", async () => {
    app = buildApp({ deploymentMode: "test" });
    const { token, letterId } = await createReadyLetter(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: { ...auth(token), "idempotency-key": "too short" },
    });

    expect(response.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(response).error.code).toBe(
      "INVALID_IDEMPOTENCY_KEY",
    );
  });

  it("returns the same not-found envelope for missing and another user's jobs", async () => {
    app = buildApp({ deploymentMode: "test" });
    const owner = await createReadyLetter(app);
    const otherToken = await login(app, "generation-http-other-user");
    const jobId = await startGeneration(app, owner.token, owner.letterId);

    const missingResponse = await app.inject({
      method: "GET",
      url: "/v1/jobs/00000000-0000-4000-8000-000000000000",
      headers: auth(owner.token),
    });
    const unauthorizedResponse = await app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: auth(otherToken),
    });

    expect(missingResponse.statusCode).toBe(404);
    expect(unauthorizedResponse.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(missingResponse).error.code).toBe("JOB_NOT_FOUND");
    expect(json<{ error: { code: string } }>(unauthorizedResponse).error.code).toBe(
      "JOB_NOT_FOUND",
    );
  });
});
