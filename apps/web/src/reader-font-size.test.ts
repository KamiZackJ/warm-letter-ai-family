import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READER_FONT_SIZE,
  parseReaderFontSize,
  readReaderFontSize,
  READER_FONT_SIZE_STORAGE_KEY,
  writeReaderFontSize,
} from "./reader-font-size";

describe("reader font size preference", () => {
  it.each(["standard", "large", "extra"] as const)("accepts the %s option", (value) => {
    expect(parseReaderFontSize(value)).toBe(value);
  });

  it.each([undefined, null, "", "huge", "letter-123", { size: "large" }])(
    "falls back to the standard option for an invalid stored value",
    (value) => {
      expect(parseReaderFontSize(value)).toBe(DEFAULT_READER_FONT_SIZE);
    },
  );

  it("reads only the fixed preference key", () => {
    const getItem = vi.fn(() => "large");

    expect(readReaderFontSize({ getItem })).toBe("large");
    expect(getItem).toHaveBeenCalledOnce();
    expect(getItem).toHaveBeenCalledWith(READER_FONT_SIZE_STORAGE_KEY);
  });

  it("returns the standard option when storage is unavailable", () => {
    const getItem = vi.fn(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(readReaderFontSize({ getItem })).toBe("standard");
  });

  it("persists only the bounded preference value", () => {
    const setItem = vi.fn();

    expect(writeReaderFontSize("extra", { setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(READER_FONT_SIZE_STORAGE_KEY, "extra");
  });

  it("keeps the page usable when storage rejects writes", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    expect(writeReaderFontSize("large", { setItem })).toBe(false);
  });
});
