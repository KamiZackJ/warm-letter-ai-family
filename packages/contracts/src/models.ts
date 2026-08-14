import { z } from "zod";

import { EntityIdSchema, TimestampSchema } from "./common.js";

// "screenshot" covers both chat and schedule screenshots in the MVP API.
export const MaterialTypeSchema = z.enum(["photo", "screenshot", "audio", "text"]);
export const MaterialStatusSchema = z.enum(["UPLOADING", "READY", "DELETED"]);

export const MaterialSchema = z
  .object({
    id: EntityIdSchema,
    userId: EntityIdSchema,
    type: MaterialTypeSchema,
    name: z.string().trim().min(1).max(120),
    contentType: z.string().trim().min(1).max(100).optional(),
    objectKey: z.string().trim().min(1).max(1024).optional(),
    textContent: z.string().trim().min(1).max(5000).optional(),
    status: MaterialStatusSchema,
    createdAt: TimestampSchema,
    deletedAt: TimestampSchema.optional(),
  })
  .strict();

export const LetterToneSchema = z.enum(["warm", "plain", "lively"]);
export const LetterLengthSchema = z.enum(["short", "medium", "long"]);

export const LetterSettingsSchema = z
  .object({
    tone: LetterToneSchema,
    length: LetterLengthSchema,
    focus: z.string().trim().min(1).max(500).optional(),
    excludedTopics: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  })
  .strict();

export const DraftParagraphSchema = z
  .object({
    id: EntityIdSchema,
    text: z.string().trim().min(1).max(4000),
    sourceRefs: z.array(EntityIdSchema).max(30),
  })
  .strict();

export const AiDisclosureSchema = z
  .object({
    isAiGenerated: z.literal(true),
    label: z.string().trim().min(1).max(80),
  })
  .strict();

export const LetterDraftSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(100),
    greeting: z.string().trim().min(1).max(500),
    paragraphs: z.array(DraftParagraphSchema).min(1).max(30),
    closing: z.string().trim().min(1).max(500),
    provider: z.string().trim().min(1).max(100),
    generatedAt: TimestampSchema,
    aiDisclosure: AiDisclosureSchema.optional(),
  })
  .strict();

export const LetterStateSchema = z.enum([
  "DRAFT",
  "MATERIALS_READY",
  "GENERATING",
  "EDITING",
  "CONFIRMED",
  "PUBLISHED",
]);

export const LetterSchema = z
  .object({
    id: EntityIdSchema,
    userId: EntityIdSchema,
    recipient: z.string().trim().min(1).max(40),
    materialIds: z.array(EntityIdSchema).max(30),
    settings: LetterSettingsSchema,
    state: LetterStateSchema,
    draft: LetterDraftSchema.optional(),
    confirmedDraft: LetterDraftSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    confirmedAt: TimestampSchema.optional(),
    publishedAt: TimestampSchema.optional(),
  })
  .strict();

export const JobTypeSchema = z.enum([
  "generate_letter",
  "render_long_image",
  "render_video",
  "publish_letter",
]);
export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);

export const JobErrorSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    retryable: z.boolean().optional(),
  })
  .strict();

export const JobSchema = z
  .object({
    id: EntityIdSchema,
    userId: EntityIdSchema,
    letterId: EntityIdSchema,
    status: JobStatusSchema,
    type: JobTypeSchema.optional(),
    progress: z.number().int().min(0).max(100).optional(),
    attempts: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().positive().optional(),
    result: z.record(z.unknown()).optional(),
    error: JobErrorSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    finishedAt: TimestampSchema.optional(),
  })
  .strict();

export const ReplySchema = z
  .object({
    id: EntityIdSchema,
    letterId: EntityIdSchema,
    text: z.string().trim().min(1).max(240),
    authorName: z.string().trim().min(1).max(40),
    authorVerified: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();

export const ShareLinkStatusSchema = z.enum(["active", "expired", "revoked"]);

export const ShareLinkSchema = z
  .object({
    letterId: EntityIdSchema,
    status: ShareLinkStatusSchema,
    expiresAt: TimestampSchema,
    revokedAt: TimestampSchema.optional(),
  })
  .strict();

export type MaterialType = z.infer<typeof MaterialTypeSchema>;
export type MaterialStatus = z.infer<typeof MaterialStatusSchema>;
export type Material = z.infer<typeof MaterialSchema>;
export type LetterTone = z.infer<typeof LetterToneSchema>;
export type LetterLength = z.infer<typeof LetterLengthSchema>;
export type LetterSettings = z.infer<typeof LetterSettingsSchema>;
export type DraftParagraph = z.infer<typeof DraftParagraphSchema>;
export type AiDisclosure = z.infer<typeof AiDisclosureSchema>;
export type LetterDraft = z.infer<typeof LetterDraftSchema>;
export type LetterState = z.infer<typeof LetterStateSchema>;
export type Letter = z.infer<typeof LetterSchema>;
export type JobType = z.infer<typeof JobTypeSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobError = z.infer<typeof JobErrorSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Reply = z.infer<typeof ReplySchema>;
export type ShareLinkStatus = z.infer<typeof ShareLinkStatusSchema>;
export type ShareLink = z.infer<typeof ShareLinkSchema>;
