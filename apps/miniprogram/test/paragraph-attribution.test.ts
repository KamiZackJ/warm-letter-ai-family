import { describe, expect, it } from "vitest";

import {
  draftNeedsSourceReview,
  markParagraphTextEdited,
  markParagraphUserSupplied,
  paragraphAttributionLabel,
  setParagraphSources,
} from "../src/utils/paragraph-attribution";

const aiParagraph = {
  id: "paragraph-1",
  text: "AI 根据照片整理的一段话。",
  sourceRefs: ["photo-1"],
  sourceAttribution: "ai" as const,
};

describe("paragraph attribution", () => {
  it("clears inherited AI sources when a writer edits a paragraph", () => {
    expect(markParagraphTextEdited(aiParagraph, "写信人改写后的内容。")).toEqual({
      ...aiParagraph,
      text: "写信人改写后的内容。",
      sourceRefs: [],
      sourceAttribution: "needs-review",
    });
  });

  it("makes a writer explicitly choose confirmed sources or personal input", () => {
    const edited = markParagraphTextEdited(aiParagraph, "写信人改写后的内容。");
    expect(setParagraphSources(edited, ["photo-1", "photo-1", "note-1"])).toMatchObject({
      sourceRefs: ["photo-1", "note-1"],
      sourceAttribution: "sources-confirmed",
    });
    const personal = markParagraphUserSupplied(edited);
    expect(personal).toMatchObject({ sourceRefs: [], sourceAttribution: "user-supplied" });
    expect(paragraphAttributionLabel(personal)).toBe("写信人补充，无素材依据");
  });

  it("keeps confirmation blocked only while a paragraph needs review", () => {
    const edited = markParagraphTextEdited(aiParagraph, "写信人改写后的内容。");
    expect(draftNeedsSourceReview([aiParagraph, edited])).toBe(true);
    expect(draftNeedsSourceReview([aiParagraph, markParagraphUserSupplied(edited)])).toBe(false);
  });
});
