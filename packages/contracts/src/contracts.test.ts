import { describe, expect, it } from "vitest";

import {
  ConfirmLetterResponseSchema,
  CreateMaterialUploadRequestSchema,
  CreateMaterialUploadResponseSchema,
  CreateReplyRequestSchema,
  ErrorResponseSchema,
  GetJobResponseSchema,
  GetLetterReaderResponseSchema,
  IssueShareLinkRequestSchema,
  LetterDraftSchema,
  RegisterMaterialRequestSchema,
  UpdateLetterRequestSchema,
  canTransitionLetterState,
} from "./index.js";

const id = "9e227fb7-3137-4f43-a631-b4a53d1280c1";
const otherId = "bfaa751e-d1a1-4d42-8c05-fdc9f89d03e0";
const timestamp = "2026-08-14T10:00:00+08:00";

const draft = {
  version: 1,
  title: "今天的暖笺",
  greeting: "妈妈：",
  paragraphs: [{ id, text: "今天路过了我们常去的公园。", sourceRefs: [otherId] }],
  closing: "祝好",
  provider: "fake-ai",
  generatedAt: timestamp,
};

describe("material contracts", () => {
  it("matches the current presign request and screenshot alias", () => {
    expect(
      CreateMaterialUploadRequestSchema.parse({
        type: "screenshot",
        filename: "chat.png",
        contentType: "image/png",
      }),
    ).toMatchObject({ type: "screenshot" });
  });

  it("requires text content and forces media through the binary upload flow", () => {
    expect(RegisterMaterialRequestSchema.safeParse({ type: "text", name: "today.txt" }).success)
      .toBe(false);
    expect(RegisterMaterialRequestSchema.safeParse({ type: "photo", name: "photo.jpg" }).success)
      .toBe(false);
    expect(
      RegisterMaterialRequestSchema.safeParse({
        type: "text",
        name: "today.txt",
        textContent: "今天一切顺利。",
      }).success,
    ).toBe(true);
  });

  it("models pending and completed upload retries as distinct response states", () => {
    expect(
      CreateMaterialUploadResponseSchema.parse({
        materialId: id,
        objectKey: `${otherId}/${id}.png`,
        completed: false,
        uploadUrl: `https://uploads.example.test/v1/materials/${id}/content`,
        headers: { "content-type": "image/png" },
      }),
    ).toMatchObject({ completed: false });

    expect(
      CreateMaterialUploadResponseSchema.parse({
        materialId: id,
        objectKey: `${otherId}/${id}.png`,
        completed: true,
        material: {
          id,
          userId: otherId,
          type: "photo",
          name: "family.png",
          contentType: "image/png",
          objectKey: `${otherId}/${id}.png`,
          status: "READY",
          createdAt: timestamp,
        },
      }),
    ).toMatchObject({ completed: true, material: { status: "READY" } });

    expect(
      CreateMaterialUploadResponseSchema.safeParse({
        materialId: id,
        objectKey: `${otherId}/${id}.png`,
        completed: true,
        uploadUrl: `https://uploads.example.test/v1/materials/${id}/content`,
        headers: {},
      }).success,
    ).toBe(false);

    expect(
      CreateMaterialUploadResponseSchema.safeParse({
        materialId: id,
        objectKey: `${otherId}/${id}.png`,
        completed: true,
        uploadUrl: `https://uploads.example.test/v1/materials/${id}/content`,
        headers: {},
        material: {
          id,
          userId: otherId,
          type: "photo",
          name: "family.png",
          contentType: "image/png",
          objectKey: `${otherId}/${id}.png`,
          status: "READY",
          createdAt: timestamp,
        },
      }).success,
    ).toBe(false);

    expect(
      CreateMaterialUploadResponseSchema.safeParse({
        materialId: id,
        objectKey: `${otherId}/${id}.png`,
        completed: true,
        material: {
          id,
          userId: otherId,
          type: "photo",
          name: "family.png",
          contentType: "image/png",
          objectKey: `${otherId}/${id}.png`,
          status: "UPLOADING",
          createdAt: timestamp,
        },
      }).success,
    ).toBe(false);
  });
});

describe("letter and public response contracts", () => {
  it("preserves provider disclosure and paragraph source references", () => {
    const parsed = LetterDraftSchema.parse({
      ...draft,
      aiDisclosure: { isAiGenerated: true, label: "AI 辅助生成" },
    });

    expect(parsed.provider).toBe("fake-ai");
    expect(parsed.aiDisclosure?.isAiGenerated).toBe(true);
    expect(parsed.paragraphs[0]?.sourceRefs).toEqual([otherId]);
  });

  it("matches the current confirm and reader response shapes", () => {
    const letter = {
      id,
      userId: otherId,
      recipient: "妈妈",
      materialIds: [otherId],
      settings: { tone: "warm", length: "short" },
      state: "PUBLISHED",
      draft,
      confirmedDraft: draft,
      createdAt: timestamp,
      updatedAt: timestamp,
      confirmedAt: timestamp,
      publishedAt: timestamp,
    };

    expect(
      ConfirmLetterResponseSchema.safeParse({
        letter,
        shareToken: "a".repeat(43),
        shareExpiresAt: timestamp,
        readerUrl: `/v1/letters/${id}/reader?token=${"a".repeat(43)}`,
      }).success,
    ).toBe(true);
    expect(
      GetLetterReaderResponseSchema.safeParse({
        reader: {
          id,
          recipient: "妈妈",
          draft,
          publishedAt: timestamp,
          sources: [
            {
              id: otherId,
              type: "photo",
              name: "晚霞照片",
              contentType: "image/jpeg",
              mediaUrl: `https://media.example.com/${otherId}?signature=short-lived`,
              mediaExpiresAt: timestamp,
            },
          ],
          replies: [],
        },
      }).success,
    ).toBe(true);
  });

  it("only exposes safe source metadata in the public reader", () => {
    expect(
      GetLetterReaderResponseSchema.safeParse({
        reader: {
          id,
          recipient: "妈妈",
          draft,
          publishedAt: timestamp,
          sources: [
            {
              id: otherId,
              type: "photo",
              name: "晚霞照片",
              userId: id,
              objectKey: "private/photo.jpg",
            },
          ],
          replies: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects empty patches and accepts the current paragraph patch", () => {
    expect(UpdateLetterRequestSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateLetterRequestSchema.safeParse({
        draft: { paragraphs: [{ text: "用户修改后的段落", sourceRefs: [otherId] }] },
      }).success,
    ).toBe(true);
  });
});

describe("state, errors, and future sharing contracts", () => {
  it("matches the API fallback and publication transitions", () => {
    expect(canTransitionLetterState("MATERIALS_READY", "DRAFT")).toBe(true);
    expect(canTransitionLetterState("GENERATING", "EDITING")).toBe(true);
    expect(canTransitionLetterState("EDITING", "MATERIALS_READY")).toBe(true);
    expect(canTransitionLetterState("CONFIRMED", "PUBLISHED")).toBe(true);
    expect(canTransitionLetterState("PUBLISHED", "EDITING")).toBe(false);
  });

  it("accepts the API error envelope", () => {
    expect(
      ErrorResponseSchema.parse({ error: { code: "UNAUTHORIZED", message: "请先完成微信登录" } }),
    ).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("keeps generation job responses free of owner and provider details", () => {
    const safeJob = {
      id,
      letterId: otherId,
      status: "failed",
      type: "generate_letter",
      attempts: 1,
      maxAttempts: 1,
      error: { code: "AI_PROVIDER_TIMEOUT", retryable: true },
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: timestamp,
    };

    expect(GetJobResponseSchema.safeParse({ job: safeJob }).success).toBe(true);
    expect(GetJobResponseSchema.safeParse({ job: { ...safeJob, userId: id } }).success).toBe(false);
    expect(
      GetJobResponseSchema.safeParse({
        job: { ...safeJob, error: { ...safeJob.error, message: "provider secret" } },
      }).success,
    ).toBe(false);
  });

  it("defaults future share links to thirty days and rejects unsafe durations", () => {
    expect(IssueShareLinkRequestSchema.parse({}).expiresInSeconds).toBe(30 * 24 * 60 * 60);
    expect(IssueShareLinkRequestSchema.safeParse({ expiresInSeconds: 60 }).success).toBe(false);
  });

  it("keeps reply input aligned with the 240-character reader UI", () => {
    expect(CreateReplyRequestSchema.safeParse({ text: "好".repeat(240) }).success).toBe(true);
    expect(CreateReplyRequestSchema.safeParse({ text: "好".repeat(241) }).success).toBe(false);
    expect(CreateReplyRequestSchema.safeParse({ text: "收到", authorName: "家".repeat(41) }).success)
      .toBe(false);
  });
});
