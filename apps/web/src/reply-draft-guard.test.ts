import { describe, expect, it } from "vitest";
import { hasUnsavedReplyDraft, installReplyDraftGuard } from "./reply-draft-guard";

function dispatchBeforeUnload(target: EventTarget): Event {
  const event = new Event("beforeunload", { cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("reply draft navigation guard", () => {
  it("treats only non-whitespace text as an unsaved reply", () => {
    expect(hasUnsavedReplyDraft("")).toBe(false);
    expect(hasUnsavedReplyDraft("  \n\t ")).toBe(false);
    expect(hasUnsavedReplyDraft("  收到信了  ")).toBe(true);
  });

  it("warns for a draft and stops warning after the successful draft is cleared", () => {
    const target = new EventTarget();
    let draft = "收到信了";
    const cleanup = installReplyDraftGuard(() => draft, target);

    expect(dispatchBeforeUnload(target).defaultPrevented).toBe(true);

    draft = "";
    expect(dispatchBeforeUnload(target).defaultPrevented).toBe(false);
    cleanup();
  });

  it("removes the listener during React effect cleanup", () => {
    const target = new EventTarget();
    const cleanup = installReplyDraftGuard(() => "还有未发送的回复", target);

    cleanup();

    expect(dispatchBeforeUnload(target).defaultPrevented).toBe(false);
  });
});
