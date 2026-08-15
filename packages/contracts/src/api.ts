import { z } from "zod";

import { EntityIdSchema, TimestampSchema } from "./common.js";
import {
  JobStatusSchema,
  JobTypeSchema,
  LetterDraftSchema,
  LetterSchema,
  LetterSettingsSchema,
  MaterialSchema,
  MaterialTypeSchema,
  ReplySchema,
  ShareLinkSchema,
} from "./models.js";

export const HealthResponseSchema = z
  .object({ status: z.literal("ok"), service: z.literal("warm-letter-api") })
  .strict();

export const UserSchema = z
  .object({
    id: EntityIdSchema,
    openId: z.string().min(1),
    displayName: z.string().trim().min(1).max(80),
    createdAt: TimestampSchema,
  })
  .strict();

export const WxLoginRequestSchema = z
  .object({
    code: z.string().max(256).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const WxLoginResponseSchema = z
  .object({
    user: UserSchema,
    token: z.string().min(1),
  })
  .strict();

export const ListMaterialsResponseSchema = z.object({ materials: z.array(MaterialSchema) }).strict();

export const RegisterMaterialRequestSchema = z
  .object({
    type: z.literal("text"),
    name: z.string().trim().min(1).max(120),
    textContent: z.string().trim().min(1).max(5000),
  })
  .strict();

export const RegisterMaterialResponseSchema = z.object({ material: MaterialSchema }).strict();

export const CreateMaterialUploadRequestSchema = z
  .object({
    type: z.enum(["photo", "screenshot", "audio"]),
    filename: z.string().trim().min(1).max(120),
    contentType: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const CreateMaterialUploadResponseSchema = z
  .object({
    materialId: EntityIdSchema,
    objectKey: z.string().min(1),
    uploadUrl: z.string().min(1),
    headers: z.record(z.string()),
  })
  .strict();

export const CompleteMaterialUploadRequestSchema = z
  .object({
    materialId: EntityIdSchema,
    textContent: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();

export const CompleteMaterialUploadResponseSchema = RegisterMaterialResponseSchema;
export const DeleteMaterialResponseSchema = z.undefined();

export const CreateLetterRequestSchema = z
  .object({
    recipient: z.string().trim().min(1).max(40),
    materialIds: z.array(EntityIdSchema).max(30).optional(),
    settings: LetterSettingsSchema.partial().optional(),
  })
  .strict();

export const CreateLetterResponseSchema = z.object({ letter: LetterSchema }).strict();
export const GetLetterResponseSchema = CreateLetterResponseSchema;

export const DraftPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    greeting: z.string().trim().min(1).max(500).optional(),
    paragraphs: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(4000),
            sourceRefs: z.array(EntityIdSchema).max(30).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30)
      .optional(),
    closing: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const UpdateLetterRequestSchema = z
  .object({
    recipient: z.string().trim().min(1).max(40).optional(),
    materialIds: z.array(EntityIdSchema).max(30).optional(),
    settings: LetterSettingsSchema.partial().optional(),
    draft: DraftPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" });

export const UpdateLetterResponseSchema = GetLetterResponseSchema;
export const GenerateLetterRequestSchema = z.object({}).strict();
export const ClientJobErrorSchema = z
  .object({
    code: z.string().min(1).max(80),
    retryable: z.boolean(),
  })
  .strict();
export const ClientJobSchema = z
  .object({
    id: EntityIdSchema,
    letterId: EntityIdSchema,
    status: JobStatusSchema,
    type: JobTypeSchema.optional(),
    attempts: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().positive().optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    finishedAt: TimestampSchema.optional(),
    error: ClientJobErrorSchema.optional(),
  })
  .strict();
export const GenerateLetterResponseSchema = z.object({ job: ClientJobSchema }).strict();
export const GetJobResponseSchema = GenerateLetterResponseSchema;
export const ConfirmLetterRequestSchema = z.object({}).strict();

export const ConfirmLetterResponseSchema = z
  .object({
    letter: LetterSchema,
    shareToken: z.string().min(32),
    shareExpiresAt: TimestampSchema,
    readerUrl: z.string().min(1),
  })
  .strict();

export const PublicMaterialSourceSchema = z
  .object({
    id: EntityIdSchema,
    type: MaterialTypeSchema,
    name: z.string().trim().min(1).max(120),
    contentType: z.string().trim().min(1).max(100).optional(),
    mediaUrl: z.string().url().optional(),
    mediaExpiresAt: TimestampSchema.optional(),
    durationSeconds: z.number().nonnegative().max(24 * 60 * 60).optional(),
  })
  .strict();

export const PublicLetterSchema = z
  .object({
    id: EntityIdSchema,
    recipient: z.string().trim().min(1).max(40),
    draft: LetterDraftSchema,
    publishedAt: TimestampSchema,
    sources: z.array(PublicMaterialSourceSchema).max(30),
    replies: z.array(ReplySchema).max(100),
  })
  .strict();

export const GetLetterReaderResponseSchema = z.object({ reader: PublicLetterSchema }).strict();

export const CreateReplyRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(240),
    authorName: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const CreateReplyResponseSchema = z.object({ reply: ReplySchema }).strict();
export const ListRepliesResponseSchema = z.object({ replies: z.array(ReplySchema) }).strict();

export const IssueShareLinkRequestSchema = z
  .object({
    expiresInSeconds: z.number().int().min(300).max(30 * 24 * 60 * 60).default(30 * 24 * 60 * 60),
  })
  .strict();

export const IssueShareLinkResponseSchema = z
  .object({
    share: ShareLinkSchema,
    shareToken: z.string().min(32),
    readerUrl: z.string().min(1),
  })
  .strict();

export const RevokeShareLinkResponseSchema = z.object({ share: ShareLinkSchema }).strict();
export const ReissueShareLinkResponseSchema = ConfirmLetterResponseSchema;
export const RevokeCurrentShareResponseSchema = z.undefined();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type User = z.infer<typeof UserSchema>;
export type WxLoginRequest = z.infer<typeof WxLoginRequestSchema>;
export type WxLoginResponse = z.infer<typeof WxLoginResponseSchema>;
export type ListMaterialsResponse = z.infer<typeof ListMaterialsResponseSchema>;
export type RegisterMaterialRequest = z.infer<typeof RegisterMaterialRequestSchema>;
export type RegisterMaterialResponse = z.infer<typeof RegisterMaterialResponseSchema>;
export type CreateMaterialUploadRequest = z.infer<typeof CreateMaterialUploadRequestSchema>;
export type CreateMaterialUploadResponse = z.infer<typeof CreateMaterialUploadResponseSchema>;
export type CompleteMaterialUploadRequest = z.infer<typeof CompleteMaterialUploadRequestSchema>;
export type CompleteMaterialUploadResponse = z.infer<typeof CompleteMaterialUploadResponseSchema>;
export type DeleteMaterialResponse = z.infer<typeof DeleteMaterialResponseSchema>;
export type CreateLetterRequest = z.infer<typeof CreateLetterRequestSchema>;
export type CreateLetterResponse = z.infer<typeof CreateLetterResponseSchema>;
export type GetLetterResponse = z.infer<typeof GetLetterResponseSchema>;
export type DraftPatch = z.infer<typeof DraftPatchSchema>;
export type UpdateLetterRequest = z.infer<typeof UpdateLetterRequestSchema>;
export type UpdateLetterResponse = z.infer<typeof UpdateLetterResponseSchema>;
export type GenerateLetterRequest = z.infer<typeof GenerateLetterRequestSchema>;
export type ClientJobError = z.infer<typeof ClientJobErrorSchema>;
export type ClientJob = z.infer<typeof ClientJobSchema>;
export type GenerateLetterResponse = z.infer<typeof GenerateLetterResponseSchema>;
export type GetJobResponse = z.infer<typeof GetJobResponseSchema>;
export type ConfirmLetterRequest = z.infer<typeof ConfirmLetterRequestSchema>;
export type ConfirmLetterResponse = z.infer<typeof ConfirmLetterResponseSchema>;
export type PublicMaterialSource = z.infer<typeof PublicMaterialSourceSchema>;
export type PublicLetter = z.infer<typeof PublicLetterSchema>;
export type GetLetterReaderResponse = z.infer<typeof GetLetterReaderResponseSchema>;
export type CreateReplyRequest = z.infer<typeof CreateReplyRequestSchema>;
export type CreateReplyResponse = z.infer<typeof CreateReplyResponseSchema>;
export type ListRepliesResponse = z.infer<typeof ListRepliesResponseSchema>;
export type IssueShareLinkRequest = z.infer<typeof IssueShareLinkRequestSchema>;
export type IssueShareLinkResponse = z.infer<typeof IssueShareLinkResponseSchema>;
export type RevokeShareLinkResponse = z.infer<typeof RevokeShareLinkResponseSchema>;
export type ReissueShareLinkResponse = z.infer<typeof ReissueShareLinkResponseSchema>;
export type RevokeCurrentShareResponse = z.infer<typeof RevokeCurrentShareResponseSchema>;
