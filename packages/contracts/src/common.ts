import { z } from "zod";

export const EntityIdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });

export const ApiErrorSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    requestId: z.string().min(1).max(100).optional(),
    details: z.record(z.unknown()).optional(),
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: ApiErrorSchema,
  })
  .strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
