import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ApiError } from "./errors.js";
import { OperationDeadline } from "./deadline.js";

export interface ReviewMedia { bytes: Buffer; contentType: string }
export interface MediaSafetyTranscodeOptions {
  /** Required for seekable MP4/M4A input: D:/tmp/... locally, private data directory on the server. */
  temporaryDirectory?: string;
  ffmpegPath?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

const maxReviewBytes = 10 * 1024 * 1024;
const maxInputBytes = 25 * 1024 * 1024;
const maxConcurrent = 2;
let running = 0;

function unavailable(): ApiError {
  return new ApiError(503, "MEDIA_REVIEW_PREPARATION_FAILED", "语音处理暂时不可用，请稍后重试");
}

function inputValid(input: ReviewMedia): boolean {
  const b = input.bytes;
  switch (input.contentType) {
    case "image/jpeg": return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
    case "image/png": return b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/bmp": return b.length >= 14 && b.toString("ascii", 0, 2) === "BM";
    case "audio/mpeg": return (b.length >= 3 && b.toString("ascii", 0, 3) === "ID3") || (b.length >= 2 && b[0] === 255 && (b[1]! & 224) === 224);
    case "audio/aac": return b.length >= 2 && b[0] === 255 && (b[1]! & 240) === 240;
    case "audio/wav": return b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE";
    case "audio/mp4": return b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp";
    case "audio/ogg": return b.length >= 4 && b.toString("ascii", 0, 4) === "OggS";
    default: return false;
  }
}

/** No truncated output can be approved. MP4/Ogg are converted completely or fail closed. */
export async function prepareMediaForSafety(input: ReviewMedia, options: MediaSafetyTranscodeOptions = {}): Promise<ReviewMedia> {
  if (!inputValid(input)) throw new ApiError(415, "UNSUPPORTED_SAFETY_MEDIA", "请使用 JPG、PNG、BMP 照片或受支持的语音文件");
  const convert = input.contentType === "audio/mp4" || input.contentType === "audio/ogg";
  if (!input.bytes.length || input.bytes.length > (convert ? maxInputBytes : maxReviewBytes)) {
    throw new ApiError(413, "SAFETY_MEDIA_TOO_LARGE", "素材过大，请压缩照片或缩短语音后重试");
  }
  if (!convert) return input;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new Error("Invalid media transcode timeout");
  if (running >= maxConcurrent) throw new ApiError(503, "MEDIA_REVIEW_BUSY", "语音正在处理中，请稍后重试");
  if (input.contentType === "audio/mp4" && (!options.temporaryDirectory || !isAbsolute(options.temporaryDirectory))) {
    throw new Error("A private absolute temporaryDirectory is required for MP4 audio review");
  }
  running += 1;
  const deadline = new OperationDeadline(timeoutMs, () =>
    new ApiError(504, "MEDIA_REVIEW_PREPARATION_TIMEOUT", "语音处理超时，请缩短语音后重试"));
  let temporaryPath: string | undefined;
  let removeCleanup: (() => void) | undefined;
  try {
    let source = "pipe:0";
    if (input.contentType === "audio/mp4") {
      // Non-faststart M4A stores its index at the end and cannot be decoded from a non-seekable pipe.
      await deadline.wait(() => mkdir(options.temporaryDirectory!, { recursive: true, mode: 0o700 }));
      temporaryPath = await deadline.wait(async () => {
        const path = await mkdtemp(join(options.temporaryDirectory!, "wechat-audio-"));
        // Also cleans up a late directory creation after the caller's deadline.
        removeCleanup = deadline.addCleanup(() => rm(path, { recursive: true, force: true }));
        return path;
      });
      source = join(temporaryPath, "input.m4a");
      await deadline.wait(() => writeFile(source, input.bytes, { flag: "wx", mode: 0o600, signal: deadline.signal }));
    }
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "67108864", "-threads", "1",
      "-protocol_whitelist", input.contentType === "audio/mp4" ? "file" : "pipe",
      "-f", input.contentType === "audio/mp4" ? "mov" : "ogg", "-i", source,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-threads", "1", "-f", "mp3", "pipe:1",
    ];
    const bytes = await deadline.wait(() => transcode(args, source === "pipe:0" ? input.bytes : undefined, deadline.remainingMs(), options));
    if (!inputValid({ bytes, contentType: "audio/mpeg" })) throw unavailable();
    if (temporaryPath) {
      await deadline.wait(() => rm(temporaryPath!, { recursive: true, force: true }));
      removeCleanup?.();
    }
    return { bytes, contentType: "audio/mpeg" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    running -= 1;
    // Delete only the fresh, uniquely created directory; never delete a caller-supplied parent.
    deadline.dispose();
  }
}

function transcode(args: string[], input: Buffer | undefined, timeoutMs: number, options: MediaSafetyTranscodeOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let process: ChildProcessWithoutNullStreams;
    try {
      process = (options.spawnImpl ?? spawn)(options.ffmpegPath ?? "ffmpeg", args, {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch { reject(unavailable()); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: ApiError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        // Never allow a stuck/oversized process to keep converting after the caller gives up.
        process.kill("SIGKILL");
        process.stdin.destroy();
        process.stdout.destroy();
        process.stderr.destroy();
        chunks.length = 0;
        reject(error);
      } else resolve(Buffer.concat(chunks, bytes));
    };
    const timer = setTimeout(() => finish(new ApiError(504, "MEDIA_REVIEW_PREPARATION_TIMEOUT", "语音处理超时，请缩短语音后重试")), timeoutMs);
    process.on("error", () => finish(unavailable()));
    process.stdin.on("error", () => finish(unavailable()));
    process.stdout.on("error", () => finish(unavailable()));
    process.stderr.on("error", () => finish(unavailable()));
    process.stderr.resume(); // Consume but never expose codec errors that may contain paths/metadata.
    process.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxReviewBytes) {
        finish(new ApiError(413, "SAFETY_MEDIA_TOO_LARGE", "语音过长，请缩短后重试"));
      } else chunks.push(chunk);
    });
    process.on("close", (code) => {
      if (code !== 0 || !bytes) finish(unavailable());
      else finish();
    });
    process.stdin.end(input);
  });
}
