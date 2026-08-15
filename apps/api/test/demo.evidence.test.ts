import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { auth, json, login, waitForJob } from "./helpers.js";

let app: FastifyInstance;

beforeAll(() => {
  app = buildApp({ deploymentMode: "demo" });
});

afterAll(async () => {
  await app.close();
});

it("DEMO EVIDENCE: user-selected source -> traceable AI draft -> confirmation -> family reply", async () => {
  const token = await login(app, "competition-evidence");
  const materialResponse = await app.inject({
    method: "POST",
    url: "/v1/materials",
    headers: auth(token),
    payload: {
      type: "text",
      name: "user-selected-note",
      textContent: "Today I finished my project and ate dinner on time.",
    },
  });
  const materialId = json<{ material: { id: string } }>(materialResponse).material.id;
  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/letters",
    headers: auth(token),
    payload: { recipient: "Mom and Dad", materialIds: [materialId] },
  });
  const letterId = json<{ letter: { id: string } }>(createResponse).letter.id;
  const generationResponse = await app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/generate`,
    headers: auth(token),
  });
  const jobId = json<{ job: { id: string } }>(generationResponse).job.id;
  const job = await waitForJob(app, token, jobId);

  const generatedResponse = await app.inject({
    method: "GET",
    url: `/v1/letters/${letterId}`,
    headers: auth(token),
  });
  const generated = json<{
    letter: { state: string; draft: { paragraphs: Array<{ sourceRefs: string[] }> } };
  }>(generatedResponse).letter;
  expect(generated.draft.paragraphs[0]?.sourceRefs).toEqual([materialId]);

  const confirmResponse = await app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/confirm`,
    headers: auth(token),
  });
  const confirmation = json<{
    letter: { state: string; confirmedAt: string };
    shareToken: string;
    readerUrl: string;
  }>(confirmResponse);
  const replyResponse = await app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/replies?token=${encodeURIComponent(confirmation.shareToken)}`,
    payload: { text: "We received your letter.", authorName: "Family" },
  });

  const evidence = {
    selectedMaterialId: materialId,
    generationJobStatus: job.status,
    sourceTraceVerified: generated.draft.paragraphs[0]?.sourceRefs[0] === materialId,
    userConfirmationRecorded: Boolean(confirmation.letter.confirmedAt),
    finalLetterState: confirmation.letter.state,
    readerLinkIssued: confirmation.readerUrl.includes("token="),
    familyReplyAccepted: replyResponse.statusCode === 201,
  };
  console.info(`DEMO_EVIDENCE ${JSON.stringify(evidence)}`);
  expect(evidence).toEqual({
    selectedMaterialId: materialId,
    generationJobStatus: "succeeded",
    sourceTraceVerified: true,
    userConfirmationRecorded: true,
    finalLetterState: "PUBLISHED",
    readerLinkIssued: true,
    familyReplyAccepted: true,
  });
});
