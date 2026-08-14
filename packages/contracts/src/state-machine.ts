import type { LetterState } from "./models.js";

export const LETTER_STATE_TRANSITIONS = {
  DRAFT: ["MATERIALS_READY"],
  MATERIALS_READY: ["DRAFT", "GENERATING"],
  GENERATING: ["DRAFT", "MATERIALS_READY", "EDITING"],
  EDITING: ["DRAFT", "MATERIALS_READY", "GENERATING", "CONFIRMED"],
  CONFIRMED: ["PUBLISHED"],
  PUBLISHED: [],
} as const satisfies Record<LetterState, readonly LetterState[]>;

export function canTransitionLetterState(from: LetterState, to: LetterState): boolean {
  return (LETTER_STATE_TRANSITIONS[from] as readonly LetterState[]).includes(to);
}

export function assertLetterStateTransition(from: LetterState, to: LetterState): void {
  if (!canTransitionLetterState(from, to)) {
    throw new Error(`Invalid letter state transition: ${from} -> ${to}`);
  }
}
