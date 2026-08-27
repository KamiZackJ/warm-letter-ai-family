import { describe, expect, it } from "vitest";

import {
  CASE_001_EXPECTED_DRAFT,
  CASE_001_FACTS,
  CASE_001_MATERIAL_IDS,
  CASE_001_SAFETY_ASSERTIONS,
  LetterDraftSchema,
} from "./index.js";

describe("CASE-001 safe fixture", () => {
  it("stays compatible with the shared letter contract and traces every approved fact", () => {
    const parsed = LetterDraftSchema.parse(CASE_001_EXPECTED_DRAFT);
    const referencedSources = new Set(parsed.paragraphs.flatMap((paragraph) => paragraph.sourceRefs));

    expect(referencedSources).toEqual(new Set(Object.values(CASE_001_MATERIAL_IDS)));
    for (const fact of CASE_001_FACTS) {
      expect(referencedSources).toContain(CASE_001_MATERIAL_IDS[fact.source]);
    }
    expect(parsed.paragraphs.every((paragraph) => paragraph.sourceAttribution === "ai")).toBe(true);
  });

  it("locks the audited neutral-language and privacy boundaries", () => {
    const renderedDraft = JSON.stringify(CASE_001_EXPECTED_DRAFT);
    const forbiddenClaims = [
      "爸爸",
      "妈妈",
      "长会",
      "厂会",
      "购买",
      "买了",
      "吃了",
      "食用",
      "功效",
      "路人",
      "男子",
      "女子",
    ];

    expect(CASE_001_SAFETY_ASSERTIONS).toMatchObject({
      recipient: "家里人",
      status: "PASS",
      uncertainTermsAreNotAsserted: true,
      thirdPartyIsNotDescribed: true,
      productPurchaseOrHealthClaimsAreAbsent: true,
    });
    expect(CASE_001_EXPECTED_DRAFT.greeting).toContain(CASE_001_SAFETY_ASSERTIONS.recipient);
    expect(renderedDraft).toContain("饮品");
    expect(renderedDraft).toContain("9.9 元");
    for (const forbiddenClaim of forbiddenClaims) {
      expect(renderedDraft).not.toContain(forbiddenClaim);
    }
  });

  it("contains no raw-media payloads, source filenames, paths, or request credentials", () => {
    const serialized = JSON.stringify({
      facts: CASE_001_FACTS,
      draft: CASE_001_EXPECTED_DRAFT,
      safety: CASE_001_SAFETY_ASSERTIONS,
    });
    const forbiddenDataMarkers = [
      "生活照片_商店货架.jpg",
      "语音_暖笺_1.m4a",
      "raw_asr",
      "objectKey",
      "mediaUrl",
      "shareToken",
      "data:image",
      "data:audio",
      "C:\\\\Users\\\\",
      "D:\\\\tmp\\\\",
      "sk-",
    ];

    for (const marker of forbiddenDataMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });
});
