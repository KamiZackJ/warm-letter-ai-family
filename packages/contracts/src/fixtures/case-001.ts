import type { LetterDraft } from "../models.js";

/**
 * A deterministic, media-free representation of the second-part content case.
 *
 * This fixture intentionally contains only the facts that were approved for
 * regression and the logical material ids used to trace them. It must not grow
 * to include the controlled photo, audio bytes, raw ASR, or absolute paths.
 */
export const CASE_001_ID = "NUANJIAN-CASE-001" as const;

export const CASE_001_MATERIAL_IDS = {
  audio: "a0010000-0000-4000-8000-000000000001",
  photo: "a0010000-0000-4000-8000-000000000002",
} as const;

export type Case001MaterialKind = keyof typeof CASE_001_MATERIAL_IDS;

export type Case001Fact = {
  readonly id: "audio-meeting-fatigue" | "audio-drink-happy" | "photo-shelf-price";
  readonly text: string;
  readonly source: Case001MaterialKind;
};

export const CASE_001_FACTS: readonly Case001Fact[] = [
  {
    id: "audio-meeting-fatigue",
    text: "上午开会后有点累",
    source: "audio",
  },
  {
    id: "audio-drink-happy",
    text: "外卖附送一小瓶饮品，感觉挺开心",
    source: "audio",
  },
  {
    id: "photo-shelf-price",
    text: "商店货架上可见商品和 9.9 元价签",
    source: "photo",
  },
] as const;

export const CASE_001_EXPECTED_DRAFT = {
  version: 1,
  title: "写给家里人的今天",
  greeting: "亲爱的家里人：",
  paragraphs: [
    {
      id: "a0010000-0000-4000-8000-000000000101",
      text: "今天上午开了个会，结束时有点累。",
      sourceRefs: [CASE_001_MATERIAL_IDS.audio],
      sourceAttribution: "ai",
    },
    {
      id: "a0010000-0000-4000-8000-000000000102",
      text: "中午点的外卖意外送了一小瓶饮品，感觉还挺开心的。",
      sourceRefs: [CASE_001_MATERIAL_IDS.audio],
      sourceAttribution: "ai",
    },
    {
      id: "a0010000-0000-4000-8000-000000000103",
      text: "我还拍下了商店货架上的商品和 9.9 元价签。",
      sourceRefs: [CASE_001_MATERIAL_IDS.photo],
      sourceAttribution: "ai",
    },
  ],
  closing: "愿你们今天也平安、舒心。",
  signature: "想念你们的我",
  provider: "case-001-fixture",
  generatedAt: "2026-08-25T00:00:00.000Z",
} satisfies LetterDraft;

export const CASE_001_SAFETY_ASSERTIONS = {
  recipient: "家里人",
  status: "PASS",
  uncertainTermsAreNotAsserted: true,
  thirdPartyIsNotDescribed: true,
  productPurchaseOrHealthClaimsAreAbsent: true,
} as const;

export const CASE_001_SAFE_TERMS = ["家里人", "饮品", "9.9 元"] as const;
