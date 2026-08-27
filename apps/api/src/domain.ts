export const MATERIAL_TYPES = ["photo", "screenshot", "audio", "text"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];
export type MaterialStatus = "UPLOADING" | "READY" | "DELETED";

export const LETTER_STATES = [
  "DRAFT",
  "MATERIALS_READY",
  "GENERATING",
  "EDITING",
  "CONFIRMED",
  "PUBLISHED",
] as const;
export type LetterState = (typeof LETTER_STATES)[number];

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface User {
  id: string;
  openId: string;
  displayName: string;
  createdAt: string;
}

export interface Material {
  id: string;
  userId: string;
  type: MaterialType;
  name: string;
  contentType?: string;
  objectKey?: string;
  textContent?: string;
  status: MaterialStatus;
  createdAt: string;
  deletedAt?: string;
}

export interface LetterSettings {
  tone: "warm" | "plain" | "lively";
  length: "short" | "medium" | "long";
  focus?: string;
  excludedTopics?: string[];
}

export const PARAGRAPH_SOURCE_ATTRIBUTIONS = [
  "ai",
  "sources-confirmed",
  "user-supplied",
  "needs-review",
] as const;
export type ParagraphSourceAttribution = (typeof PARAGRAPH_SOURCE_ATTRIBUTIONS)[number];

export interface DraftParagraph {
  id: string;
  text: string;
  sourceRefs: string[];
  sourceAttribution?: ParagraphSourceAttribution;
}

export interface LetterDraft {
  version: number;
  title: string;
  greeting: string;
  paragraphs: DraftParagraph[];
  closing: string;
  signature: string;
  provider: string;
  generatedAt: string;
}

export interface Letter {
  id: string;
  userId: string;
  recipient: string;
  materialIds: string[];
  settings: LetterSettings;
  state: LetterState;
  draft?: LetterDraft;
  confirmedDraft?: LetterDraft;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  publishedAt?: string;
}

export interface ShareAccess {
  id: string;
  letterId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface GenerationJob {
  id: string;
  userId: string;
  letterId: string;
  idempotencyKey?: string;
  status: JobStatus;
  type?: "generate_letter";
  attempts?: number;
  maxAttempts?: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: { code: string; message: string; retryable?: boolean };
}

export interface Reply {
  id: string;
  letterId: string;
  text: string;
  authorName: string;
  authorVerified: boolean;
  createdAt: string;
}

const allowedTransitions: Record<LetterState, readonly LetterState[]> = {
  DRAFT: ["MATERIALS_READY"],
  MATERIALS_READY: ["DRAFT", "GENERATING"],
  GENERATING: ["DRAFT", "MATERIALS_READY", "EDITING"],
  EDITING: ["DRAFT", "MATERIALS_READY", "GENERATING", "CONFIRMED"],
  CONFIRMED: ["PUBLISHED"],
  PUBLISHED: [],
};

export function canTransition(from: LetterState, to: LetterState): boolean {
  return allowedTransitions[from].includes(to);
}
