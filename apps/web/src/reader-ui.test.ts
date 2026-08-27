import { describe, expect, it } from "vitest";

type FileSystemModule = {
  readFileSync(path: string, encoding: "utf8"): string;
};

const runtimeProcess = (globalThis as unknown as {
  process: {
    cwd(): string;
    getBuiltinModule(name: string): unknown;
  };
}).process;
const fileSystem = runtimeProcess.getBuiltinModule("node:fs") as FileSystemModule;
const normalizedWorkingDirectory = runtimeProcess.cwd().replace(/\\/g, "/");
const webSourceDirectory = normalizedWorkingDirectory.endsWith("/apps/web")
  ? `${normalizedWorkingDirectory}/src`
  : `${normalizedWorkingDirectory}/apps/web/src`;
const mainSource = fileSystem.readFileSync(`${webSourceDirectory}/main.tsx`, "utf8");
const stylesSource = fileSystem.readFileSync(`${webSourceDirectory}/styles.css`, "utf8");

function cssRule(source: string, selector: string): string {
  const rule = source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!rule?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return rule[1];
}

describe("reader interface design gates", () => {
  it("preserves complete chat screenshots while keeping photo crops intentional", () => {
    expect(mainSource).toContain("memory-photo-${source.type}");
    expect(mainSource).toContain("memory-photo-layout-${imageLayout}");
    expect(mainSource).toContain("memory-photo-image-${imageDisplay}");
    expect(mainSource).toContain('className="memory-photo-frame"');
    expect(cssRule(stylesSource, "\\.memory-photo-screenshot \\.memory-photo-frame")).toContain(
      "aspect-ratio: 3 / 4",
    );
    expect(cssRule(stylesSource, "\\.memory-photo-screenshot img")).toContain(
      "object-fit: contain",
    );
    expect(cssRule(stylesSource, "\\.memory-photo-photo img")).toContain("object-fit: cover");
  });

  it("keeps the reply composer mounted after a successful send", () => {
    const replySection = mainSource.slice(
      mainSource.indexOf('<section className="reply-section"'),
      mainSource.indexOf("<footer>"),
    );
    const composerPosition = replySection.indexOf('className="reply-composer"');
    const successPosition = replySection.indexOf('data-testid="reply-success"');

    expect(composerPosition).toBeGreaterThanOrEqual(0);
    expect(successPosition).toBeGreaterThan(composerPosition);
    expect(replySection).toContain("setSent(false)");
    expect(replySection).not.toMatch(/\)\s*:\s*\(\s*<div className="reply-composer"/);
  });

  it("folds long reply histories with native list and button semantics", () => {
    expect(mainSource).toContain("reader.replies.slice(-REPLY_PREVIEW_COUNT)");
    expect(mainSource).toContain('aria-labelledby="reply-history-title"');
    expect(mainSource).toContain('aria-controls="reply-list"');
    expect(mainSource).toContain("aria-expanded={replyHistoryExpanded}");
    expect(mainSource).toContain('<ol className="reply-list" id="reply-list">');
    expect(mainSource).toContain('<li className="reply-item" key={item.id}>');
    expect(cssRule(stylesSource, "\\.reply-history-toggle")).toContain("min-height: 44px");
  });

  it("keeps the share credential fragment when the skip link is activated", () => {
    expect(mainSource).toContain("event.preventDefault()");
    expect(mainSource).toContain('document.getElementById("letter-content")');
    expect(mainSource).toContain("content.focus({ preventScroll: true })");
    expect(mainSource).toContain('content.scrollIntoView({ block: "start" })');
    expect(mainSource).toContain("onClick={skipToLetterContent}");
  });

  it("uses the warm-letter brand tokens across the reader surfaces", () => {
    const rootRule = cssRule(stylesSource, ":root");

    expect(rootRule).toContain("--warm-ink: #2d302d");
    expect(rootRule).toContain("--warm-paper: #fbfaf7");
    expect(rootRule).toContain("--warm-sage: #435d57");
    expect(rootRule).toContain("--warm-wine: #783f42");
    expect(cssRule(stylesSource, "\\.reader-shell")).toContain(
      "background: var(--warm-paper)",
    );
    expect(cssRule(stylesSource, "\\.reply-section")).toContain(
      "background: var(--warm-reply-surface)",
    );
    expect(cssRule(stylesSource, "\\.send-button")).toContain(
      "background: var(--warm-wine)",
    );
  });

  it("discloses whether each paragraph is AI-derived, rechecked, or a personal addition", () => {
    expect(mainSource).toContain('sourceAttribution?: ParagraphSourceAttribution');
    expect(mainSource).toContain("写信人修改，已重新核对依据");
    expect(mainSource).toContain("写信人补充，无素材依据");
    expect(mainSource).toContain("aria-label={`段落归因：${paragraphAttributionLabel(section)}`}");
    expect(cssRule(stylesSource, "\\.letter-section > \\.paragraph-attribution")).toContain(
      "font-family: var(--warm-font-ui)",
    );
  });

  it("surfaces the controlled teammate-material provenance in the reader", () => {
    expect(mainSource).toContain("isControlledCase001Demo");
    expect(mainSource).toContain("__WARM_LETTER_CONTROLLED_CASE_001__");
    expect(mainSource).not.toContain("今天上午开了个会，结束时有点累。中午点的外卖");
    expect(mainSource).toContain("已接入队友提供材料");
    expect(mainSource).toContain("队友提供示例语音（原始 m4a）");
    expect(mainSource).toContain("队友生活照片的隐私裁切图");
    expect(mainSource).toContain("recommendedDraftParagraphs[index]");
    expect(mainSource).toContain("受控 CASE-001 推荐审核稿缺少段落依据");
  });

  it("renders the confirmed closing and signature as separate fields", () => {
    expect(mainSource).toContain('<p className="closing">{reader.draft.closing}</p>');
    expect(mainSource).toContain('<p className="signature">{reader.draft.signature}</p>');
    expect(mainSource).toContain("reader.draft.signature,");
    expect(cssRule(stylesSource, "\\.signature")).toContain("text-align: right");
  });

  it("keeps the three font controls in one stable row", () => {
    const controlRule = cssRule(stylesSource, "\\.reader-font-size-control");

    expect(controlRule).toContain("flex: 0 0 auto");
    expect(controlRule).toContain("flex-wrap: nowrap");
    expect(cssRule(stylesSource, "\\.reader-font-size-button")).toContain(
      "min-height: 44px",
    );
  });
});
