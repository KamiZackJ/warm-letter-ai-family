type UpdateManager = {
  onUpdateReady(callback: () => void): void;
  onUpdateFailed(callback: () => void): void;
  applyUpdate(): void;
};

type CurrentPage = { route?: string; data?: Record<string, unknown> };
type UpdatePrompt = {
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
  confirmColor: string;
  success(result: { confirm: boolean }): void;
  fail(): void;
};

export function createPublishedUpdatePrompt(options: {
  getManager(): UpdateManager | undefined;
  getPages(): CurrentPage[];
  showModal(prompt: UpdatePrompt): void;
}) {
  let initialized = false;
  let manager: UpdateManager | undefined;
  let ready = false;
  let foreground = false;
  let prompted = false;

  function safeToRestart(): boolean {
    if (!foreground) return false;
    try {
      const pages = options.getPages();
      const page = pages[0];
      // Restrict restart to an idle root home page: no editor, recorder, preview,
      // or other page with unsaved state may remain anywhere in the stack.
      return pages.length === 1 && page?.route === "pages/home/index" &&
        page.data?.loading === false && page.data.startingFlow === false && !page.data.guideVisible;
    } catch { return false; }
  }

  function offerUpdate(): void {
    if (!manager || !ready || prompted || !safeToRestart()) return;
    prompted = true;
    let settled = false;
    try {
      options.showModal({
        title: "暖笺有更新",
        content: "新版本已准备好，现在重启就能使用。也可以稍后重新打开暖笺。",
        confirmText: "重启更新",
        cancelText: "稍后",
        confirmColor: "#245A4B",
        success(result) {
          if (settled) return;
          settled = true;
          // Navigation or backgrounding while the dialog is open must never
          // allow a late confirmation to discard work on another page.
          if (!result.confirm || !ready || !safeToRestart()) return;
          try { manager?.applyUpdate(); } catch { /* Updating must not block writing. */ }
        },
        fail() { settled = true; },
      });
    } catch { settled = true; }
    // A cancellation or native-dialog failure is not followed by repeated prompts.
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;
    try {
      const candidate = options.getManager();
      if (!candidate || typeof candidate.onUpdateReady !== "function" ||
        typeof candidate.onUpdateFailed !== "function" || typeof candidate.applyUpdate !== "function") return;
      manager = candidate;
      // WeChat supplies only its published update; no code is fetched by this app.
      manager.onUpdateReady(() => { ready = true; offerUpdate(); });
      manager.onUpdateFailed(() => { ready = false; });
    } catch { manager = undefined; }
  }

  return {
    initialize,
    onShow() { foreground = true; initialize(); offerUpdate(); },
    onHide() { foreground = false; },
  };
}
