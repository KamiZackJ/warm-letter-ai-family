import {
  CASE_001_EXPECTED_DRAFT,
  CASE_001_ID,
  CASE_001_MATERIAL_IDS,
  CASE_001_SAFETY_ASSERTIONS,
  GetLetterReaderResponseSchema,
  LetterDraftSchema,
} from "@warm-letter/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AIProvider } from "../src/ai.js";
import { buildApp } from "../src/app.js";
import { MemoryRepository } from "../src/repository.js";
import { auth, json, waitForJob } from "./helpers.js";

const ownerId = "a0010000-0000-4000-8000-000000000010";
const createdAt = "2026-08-25T00:00:00.000Z";

const case001Provider: AIProvider = {
  name: CASE_001_EXPECTED_DRAFT.provider,
  async generateLetter(input) {
    expect(input.recipient).toBe(CASE_001_SAFETY_ASSERTIONS.recipient);
    expect(new Set(input.materials.map((material) => material.id))).toEqual(
      new Set(Object.values(CASE_001_MATERIAL_IDS)),
    );
    return LetterDraftSchema.parse({
      ...CASE_001_EXPECTED_DRAFT,
      version: input.version,
    });
  },
};

describe("CASE-001 de-identified API regression", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    const repository = new MemoryRepository();
    repository.saveMaterial({
      id: CASE_001_MATERIAL_IDS.audio,
      userId: ownerId,
      type: "audio",
      name: "脱敏语音依据",
      contentType: "audio/mp4",
      objectKey: `${ownerId}/controlled-audio-placeholder.m4a`,
      status: "READY",
      createdAt,
    });
    repository.saveMaterial({
      id: CASE_001_MATERIAL_IDS.photo,
      userId: ownerId,
      type: "photo",
      name: "脱敏货架画面依据",
      contentType: "image/jpeg",
      objectKey: `${ownerId}/controlled-photo-placeholder.jpg`,
      status: "READY",
      createdAt,
    });
    repository.saveUser({
      id: ownerId,
      openId: "dev-case-001-fixture",
      displayName: "CASE-001 回归用户",
      createdAt,
    });
    app = buildApp({
      deploymentMode: "test",
      repository,
      aiProvider: case001Provider,
      publicBaseUrl: "https://reader.example.test",
      now: () => new Date("2026-08-25T01:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("publishes the audited draft and preserves its source map in the public DTO", async () => {
    const token = `dev.${ownerId}`;

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/letters",
      headers: auth(token),
      payload: {
        recipient: CASE_001_SAFETY_ASSERTIONS.recipient,
        materialIds: Object.values(CASE_001_MATERIAL_IDS),
        settings: { tone: "warm", length: "short" },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const letterId = json<{ letter: { id: string } }>(createResponse).letter.id;

    const generationResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/generate`,
      headers: { ...auth(token), "idempotency-key": "case_001_generate_20260825" },
    });
    expect(generationResponse.statusCode).toBe(202);
    const jobId = json<{ job: { id: string } }>(generationResponse).job.id;
    expect(await waitForJob(app, token, jobId)).toMatchObject({ status: "succeeded" });

    const confirmResponse = await app.inject({
      method: "POST",
      url: `/v1/letters/${letterId}/confirm`,
      headers: auth(token),
    });
    expect(confirmResponse.statusCode).toBe(200);
    const confirmed = json<{
      letter: { confirmedDraft: unknown; state: string };
      readerUrl: string;
    }>(confirmResponse);
    expect(confirmed.letter.state).toBe("PUBLISHED");
    expect(confirmed.letter.confirmedDraft).toEqual(CASE_001_EXPECTED_DRAFT);

    const readerResponse = await app.inject({ method: "GET", url: confirmed.readerUrl });
    expect(readerResponse.statusCode).toBe(200);
    const { reader } = GetLetterReaderResponseSchema.parse(json<unknown>(readerResponse));
    expect(reader.recipient).toBe(CASE_001_SAFETY_ASSERTIONS.recipient);
    expect(reader.draft).toEqual(CASE_001_EXPECTED_DRAFT);
    expect(new Set(reader.sources.map((source) => source.id))).toEqual(
      new Set(Object.values(CASE_001_MATERIAL_IDS)),
    );
    expect(reader.draft.paragraphs.map((paragraph) => paragraph.sourceRefs)).toEqual(
      CASE_001_EXPECTED_DRAFT.paragraphs.map((paragraph) => paragraph.sourceRefs),
    );

    const publicPayload = readerResponse.body;
    expect(publicPayload).not.toContain(CASE_001_ID);
    expect(publicPayload).not.toContain("raw_asr");
    expect(publicPayload).not.toContain("objectKey");
    expect(publicPayload).not.toContain("shareToken");
    expect(publicPayload).not.toContain(ownerId);
    expect(publicPayload).not.toContain("生活照片_商店货架.jpg");
    expect(publicPayload).not.toContain("语音_暖笺_1.m4a");
  });
});
