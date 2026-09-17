import type { LetterDraft } from "../types/domain";

export function letterDraftSpeechText(draft: LetterDraft): string {
  return [
    draft.salutation,
    ...draft.paragraphs.map((paragraph) => paragraph.text),
    draft.closing,
    draft.signature,
  ]
    .map((part) => part.normalize("NFC").trim())
    .filter(Boolean)
    .join("\n\n");
}
