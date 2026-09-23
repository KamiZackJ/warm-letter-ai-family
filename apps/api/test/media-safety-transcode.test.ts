import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMediaForSafety } from "../src/media-safety-transcode.js";

const mp4 = Buffer.from("0000000c667479706d346120", "hex");
const mp3 = Buffer.from("49443301000000000000", "hex");
const input = { bytes: mp4, contentType: "audio/mp4" };
const directory = join(tmpdir(), "warm-letter-media-safety-tests");
const observe = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
afterEach(() => vi.useRealTimers());

function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
}

describe("media normalization for WeChat review", () => {
  it("uses a private seekable MP4 source and removes only that temporary child directory", async () => {
    const process = child();
    let source = "";
    const spawnImpl = vi.fn((_file: string, args: string[], options: Record<string, unknown>) => {
      source = args[args.indexOf("-i") + 1]!;
      expect(options).toMatchObject({ shell: false, windowsHide: true });
      expect(args).toContain("-protocol_whitelist");
      expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
      expect(args).not.toContain("-t"); // Do not silently approve only an audio prefix.
      void readFile(source).then((bytes) => {
        expect(bytes).toEqual(mp4);
        process.stdout.write(mp3);
        process.emit("close", 0);
      });
      return process;
    }) as unknown as typeof spawn;
    await expect(prepareMediaForSafety(input, { temporaryDirectory: directory, spawnImpl })).resolves.toEqual({ bytes: mp3, contentType: "audio/mpeg" });
    await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("passes complete supported images/audio through and refuses unreviewable media", async () => {
    const spawnImpl = vi.fn();
    for (const media of [
      { bytes: Buffer.from("ffd8ff00", "hex"), contentType: "image/jpeg" },
      { bytes: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png" },
      { bytes: mp3, contentType: "audio/mpeg" },
    ]) await expect(prepareMediaForSafety(media, { spawnImpl })).resolves.toBe(media);
    for (const contentType of ["image/webp", "image/gif", "image/heic", "text/plain"]) {
      await expect(prepareMediaForSafety({ bytes: mp4, contentType }, { spawnImpl })).rejects.toMatchObject({ code: "UNSUPPORTED_SAFETY_MEDIA" });
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("kills timed-out conversion and discards partial output", async () => {
    vi.useFakeTimers();
    const process = child();
    const result = observe(prepareMediaForSafety({ contentType: "audio/ogg", bytes: Buffer.from("OggSdata") }, {
      timeoutMs: 500, spawnImpl: (() => process) as unknown as typeof spawn,
    }));
    process.stdout.write(mp3);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ error: { code: "MEDIA_REVIEW_PREPARATION_TIMEOUT" } });
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    process.emit("close", 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds output bytes, suppresses stderr metadata and rejects failed codecs", async () => {
    const process = child();
    const result = observe(prepareMediaForSafety({ contentType: "audio/ogg", bytes: Buffer.from("OggSdata") }, {
      spawnImpl: (() => process) as unknown as typeof spawn,
    }));
    await Promise.resolve();
    process.stderr.write("private-path-and-secret");
    process.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(await result).toMatchObject({ error: { code: "SAFETY_MEDIA_TOO_LARGE" } });
    expect(JSON.stringify(await result)).not.toContain("private-path");
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    const failed = child();
    const failedResult = observe(prepareMediaForSafety({ contentType: "audio/ogg", bytes: Buffer.from("OggSdata") }, {
      spawnImpl: (() => failed) as unknown as typeof spawn,
    }));
    await Promise.resolve();
    failed.stdout.write(mp3);
    failed.emit("close", 1);
    expect(await failedResult).toMatchObject({ error: { code: "MEDIA_REVIEW_PREPARATION_FAILED" } });
  });

  it("limits concurrent transcoders and releases capacity after timeout", async () => {
    vi.useFakeTimers();
    const children = [child(), child()];
    let index = 0;
    const options = { timeoutMs: 500, spawnImpl: (() => children[index++]!) as unknown as typeof spawn };
    const media = { contentType: "audio/ogg", bytes: Buffer.from("OggSdata") };
    const first = observe(prepareMediaForSafety(media, options));
    const second = observe(prepareMediaForSafety(media, options));
    await expect(prepareMediaForSafety(media, options)).rejects.toMatchObject({ code: "MEDIA_REVIEW_BUSY" });
    await vi.advanceTimersByTimeAsync(500);
    await first;
    await second;
    const final = child();
    const restored = observe(prepareMediaForSafety(media, { spawnImpl: (() => final) as unknown as typeof spawn }));
    await Promise.resolve();
    final.stdout.write(mp3);
    final.emit("close", 0);
    expect(await restored).toMatchObject({ value: { contentType: "audio/mpeg" } });
  });

  it("requires an explicit absolute location for MP4 temporary material", async () => {
    await expect(prepareMediaForSafety(input)).rejects.toThrow("temporaryDirectory");
    await expect(prepareMediaForSafety(input, { temporaryDirectory: "relative" })).rejects.toThrow("temporaryDirectory");
  });
});
