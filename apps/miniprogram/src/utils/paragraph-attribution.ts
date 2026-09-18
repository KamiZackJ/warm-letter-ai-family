import type { DraftParagraph, ParagraphSourceAttribution } from "../types/domain";

export function getParagraphSourceAttribution(
  paragraph: Pick<DraftParagraph, "sourceAttribution">,
): ParagraphSourceAttribution {
  return paragraph.sourceAttribution ?? "ai";
}

export function paragraphAttributionLabel(paragraph: DraftParagraph): string {
  switch (getParagraphSourceAttribution(paragraph)) {
    case "sources-confirmed":
      return "写信人已核对依据";
    case "user-supplied":
      return "写信人补充，无素材依据";
    case "needs-review":
      return "待核对内容依据";
    case "ai":
      return "AI 根据素材整理";
  }
}

export function paragraphAttributionHint(paragraph: DraftParagraph): string {
  switch (getParagraphSourceAttribution(paragraph)) {
    case "sources-confirmed":
      return "已按写信人确认的素材显示。";
    case "user-supplied":
      return "这段内容由写信人补充，不对应已选素材。";
    case "needs-review":
      return "请逐一核对文字是否符合所选素材。有误请先修改，确认相符后点击“内容无误”。";
    case "ai":
      return "编辑文字后，需要重新核对这段内容的依据。";
  }
}

export function markParagraphTextEdited(paragraph: DraftParagraph, text: string): DraftParagraph {
  if (paragraph.text === text) return paragraph;
  return {
    ...paragraph,
    text,
    sourceRefs: [],
    sourceAttribution: "needs-review",
  };
}

export function setParagraphSources(paragraph: DraftParagraph, sourceRefs: string[]): DraftParagraph {
  const uniqueSourceRefs = [...new Set(sourceRefs)];
  return {
    ...paragraph,
    sourceRefs: uniqueSourceRefs,
    sourceAttribution: uniqueSourceRefs.length > 0 ? "sources-confirmed" : "needs-review",
  };
}

export function markParagraphUserSupplied(paragraph: DraftParagraph): DraftParagraph {
  return {
    ...paragraph,
    sourceRefs: [],
    sourceAttribution: "user-supplied",
  };
}

export function draftNeedsSourceReview(paragraphs: DraftParagraph[]): boolean {
  return paragraphs.some(
    (paragraph) => getParagraphSourceAttribution(paragraph) === "needs-review",
  );
}
