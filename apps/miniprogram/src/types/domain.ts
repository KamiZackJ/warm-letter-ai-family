export type MaterialType = "photo" | "screenshot" | "voice" | "text";

export type Material = {
  id: string;
  type: MaterialType;
  name: string;
  localPath?: string;
  text?: string;
  durationSeconds?: number;
  createdAt: string;
};

export type Tone = "warm" | "concise" | "lively";
export type LetterLength = "short" | "medium" | "long";
export type LetterStatus =
  | "DRAFT"
  | "MATERIALS_READY"
  | "GENERATING"
  | "EDITING"
  | "CONFIRMED"
  | "PUBLISHED";

export type LetterIntent = {
  recipient: string;
  message: string;
  tone: Tone;
  length: LetterLength;
  focus: string;
  exclusions: string;
};

export type DraftParagraph = {
  id: string;
  text: string;
  sourceRefs: string[];
};

export type LetterDraft = {
  title: string;
  salutation: string;
  paragraphs: DraftParagraph[];
  closing: string;
  signature: string;
};

export type Reply = {
  id: string;
  text: string;
  createdAt: string;
};

export type ReaderSource = {
  id: string;
  type: MaterialType;
  name: string;
  contentType?: string;
  mediaUrl?: string;
  mediaExpiresAt?: string;
  durationSeconds?: number;
};

export type ReaderLetter = {
  id: string;
  recipient: string;
  draft: LetterDraft;
  sources: ReaderSource[];
  replies: Reply[];
  publishedAt: string;
  shareToken: string;
};

export type Letter = {
  id: string;
  status: LetterStatus;
  materialIds: string[];
  intent: LetterIntent;
  draft?: LetterDraft;
  replies: Reply[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  shareToken?: string;
};

export type CreateLetterInput = {
  materialIds: string[];
  intent: LetterIntent;
};

export type LetterSummary = Pick<
  Letter,
  "id" | "status" | "intent" | "createdAt" | "updatedAt"
> & {
  title: string;
};
