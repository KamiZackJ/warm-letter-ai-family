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

export type ParagraphSourceAttribution =
  | "ai"
  | "sources-confirmed"
  | "user-supplied"
  | "needs-review";

export type DraftParagraph = {
  id: string;
  text: string;
  sourceRefs: string[];
  sourceAttribution?: ParagraphSourceAttribution;
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
  authorName: string;
  authorVerified: boolean;
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

export type ReaderNarration = {
  id: string;
  name: string;
  voiceId: string;
  voiceName: string;
  contentType: "audio/mpeg" | "audio/wav";
  mediaUrl: string;
  mediaExpiresAt?: string;
  generatedAt: string;
};

export type SpeechVoice = {
  id: string;
  name: string;
  description: string;
  gender: "female" | "male";
};

export type SpeechCatalog = {
  available: boolean;
  provider?: string;
  voices: SpeechVoice[];
};

export type GeneratedNarration = {
  filePath: string;
  contentType: "audio/mpeg" | "audio/wav";
};

export type ReaderLetter = {
  id: string;
  recipient: string;
  draft: LetterDraft;
  sources: ReaderSource[];
  narration?: ReaderNarration;
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
  audioTranscripts?: Array<{ materialId: string; text: string; confirmed: boolean }>;
  audioTranscriptRevisionPending?: boolean;
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
