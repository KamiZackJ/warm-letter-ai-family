export function hasUnsavedReplyDraft(draft: string): boolean {
  return draft.trim().length > 0;
}

export function installReplyDraftGuard(
  readDraft: () => string,
  target: EventTarget = window,
): () => void {
  const handleBeforeUnload: EventListener = (event) => {
    if (!hasUnsavedReplyDraft(readDraft())) return;

    event.preventDefault();
    event.returnValue = true;
  };

  target.addEventListener("beforeunload", handleBeforeUnload);
  return () => target.removeEventListener("beforeunload", handleBeforeUnload);
}
