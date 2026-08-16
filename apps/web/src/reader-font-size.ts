export const READER_FONT_SIZES = ["standard", "large", "extra"] as const;

export type ReaderFontSize = (typeof READER_FONT_SIZES)[number];

export const DEFAULT_READER_FONT_SIZE: ReaderFontSize = "standard";
export const READER_FONT_SIZE_STORAGE_KEY = "warm-letter.reader-font-size.v1";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function parseReaderFontSize(value: unknown): ReaderFontSize {
  return READER_FONT_SIZES.includes(value as ReaderFontSize)
    ? (value as ReaderFontSize)
    : DEFAULT_READER_FONT_SIZE;
}

export function readReaderFontSize(
  storage: ReadableStorage | undefined = browserLocalStorage(),
): ReaderFontSize {
  if (!storage) return DEFAULT_READER_FONT_SIZE;
  try {
    return parseReaderFontSize(storage.getItem(READER_FONT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_READER_FONT_SIZE;
  }
}

export function writeReaderFontSize(
  value: ReaderFontSize,
  storage: WritableStorage | undefined = browserLocalStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(READER_FONT_SIZE_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
