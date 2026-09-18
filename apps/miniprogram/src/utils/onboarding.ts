import { storageKey } from "../config/env";

export const ONBOARDING_STEPS = [
  {
    anchorId: "guide-write",
    body: "从这里选照片、录音或文字，写一封家书。",
  },
  {
    anchorId: "guide-recent",
    body: "写过的家书在这里，点开就能继续。",
  },
  {
    anchorId: "guide-replay",
    body: "想再看操作提示，随时点这里。",
  },
] as const;

export type OnboardingState = "new" | "returning" | "dismissed" | "unavailable";

function hasId(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Read existing local evidence without migrating, clearing or creating user data. */
export function readOnboardingState(): OnboardingState {
  try {
    if (wx.getStorageSync(storageKey("onboarding_v1")) === true) return "dismissed";
    const knownIds: unknown = wx.getStorageSync(storageKey("real_letter_ids"));
    if (Array.isArray(knownIds) && knownIds.some(hasId)) return "returning";
    const letters: unknown = wx.getStorageSync(storageKey("letters"));
    if (Array.isArray(letters) && letters.some((letter) => letter && hasId(letter.id))) {
      return "returning";
    }
    const pending: unknown = wx.getStorageSync(storageKey("pending_generation"));
    if (pending && typeof pending === "object" && "letterId" in pending && hasId(pending.letterId)) {
      return "returning";
    }
    const jobs: unknown = wx.getStorageSync(storageKey("real_generation_jobs"));
    if (jobs && typeof jobs === "object" && !Array.isArray(jobs) && Object.keys(jobs).length) {
      return "returning";
    }
    return "new";
  } catch {
    // Storage uncertainty must not make a returning user repeat the guide.
    // The explicit guide entry remains available without storage access.
    return "unavailable";
  }
}

export function rememberOnboardingDismissed(): void {
  try {
    wx.setStorageSync(storageKey("onboarding_v1"), true);
  } catch {
    // A guide preference is optional; navigation must remain usable if it cannot be saved.
  }
}
