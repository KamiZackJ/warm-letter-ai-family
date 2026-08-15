import { describe, expect, it } from "vitest";
import { resolveReaderEntry } from "./reader-entry";

describe("resolveReaderEntry", () => {
  it("loads the built-in letter only for an explicit demo profile", () => {
    expect(
      resolveReaderEntry(
        { demoEnabled: true },
        { letterId: null, shareToken: null, cameFromQuery: false },
      ),
    ).toEqual({ kind: "demo" });
  });

  it("never treats missing parameters as demo outside the demo profile", () => {
    expect(
      resolveReaderEntry(
        { demoEnabled: false },
        { letterId: null, shareToken: null, cameFromQuery: false },
      ),
    ).toMatchObject({ kind: "error", title: "缺少读信链接" });
  });

  it("rejects a half-complete share link", () => {
    expect(
      resolveReaderEntry(
        { demoEnabled: true },
        { letterId: "letter-1", shareToken: null, cameFromQuery: false },
      ),
    ).toMatchObject({ kind: "error", title: "读信链接不完整" });
  });

  it("uses the remote reader when both parameters exist", () => {
    expect(
      resolveReaderEntry(
        { demoEnabled: false },
        { letterId: "letter-1", shareToken: "token-1", cameFromQuery: true },
      ),
    ).toEqual({ kind: "remote", letterId: "letter-1", shareToken: "token-1" });
  });
});
