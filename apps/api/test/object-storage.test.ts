import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileSystemObjectStorage,
  ObjectAlreadyExistsError,
  type ObjectStorageFaultPoint,
} from "../src/object-storage.js";

const content = Buffer.from("first-bytes");
const replacement = Buffer.from("replacement-bytes");
const apiDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

async function listStagingDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".warm-letter-staging"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function runCrashWriter(root: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      [
        'const { FileSystemObjectStorage } = await import(process.env.OBJECT_STORAGE_MODULE);',
        'const storage = new FileSystemObjectStorage(process.env.OBJECT_STORAGE_ROOT, {',
        '  faultInjector(point) { if (point === "after-staged-content") process.exit(93); },',
        "});",
        'await storage.put("owner/crash-child.jpg", { bytes: Buffer.from("child"), contentType: "image/jpeg" });',
      ].join("\n"),
    ],
    {
      cwd: apiDirectory,
      env: {
        ...process.env,
        OBJECT_STORAGE_MODULE: new URL("../src/object-storage.ts", import.meta.url).href,
        OBJECT_STORAGE_ROOT: root,
      },
      stdio: "ignore",
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("FileSystemObjectStorage crash consistency", () => {
  it("publishes a complete object and preserves the first writer across instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
    try {
      const first = new FileSystemObjectStorage(root);
      const second = new FileSystemObjectStorage(root);

      const attempts = await Promise.allSettled([
        first.put("owner/photo.jpg", { bytes: content, contentType: "image/jpeg" }),
        second.put("owner/photo.jpg", { bytes: replacement, contentType: "image/jpeg" }),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      expect(
        (attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult)
          .reason,
      ).toBeInstanceOf(ObjectAlreadyExistsError);

      const acceptedBytes = attempts[0]?.status === "fulfilled" ? content : replacement;
      const stored = await first.read("owner/photo.jpg");
      expect(stored?.bytes).toEqual(acceptedBytes);
      expect(stored?.contentType).toBe("image/jpeg");
      expect(stored?.sizeBytes).toBe(acceptedBytes.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "after-staged-content",
    "after-staged-metadata",
    "before-commit",
  ] as ObjectStorageFaultPoint[])(
    "does not expose or retain a partially written object at %s",
    async (faultPoint) => {
      const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
      try {
        const storage = new FileSystemObjectStorage(root, {
          faultInjector: (point) => {
            if (point === faultPoint) throw new Error("injected interruption");
          },
        });

        await expect(
          storage.put("owner/interrupted.jpg", {
            bytes: content,
            contentType: "image/jpeg",
          }),
        ).rejects.toThrow("Object storage write failed");
        expect(await storage.read("owner/interrupted.jpg")).toBeUndefined();
        expect(await listStagingDirectories(root)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps a committed object if termination happens immediately after the atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
    try {
      const storage = new FileSystemObjectStorage(root, {
        faultInjector: (point) => {
          if (point === "after-commit") throw new Error("response interrupted after commit");
        },
      });

      await expect(
        storage.put("owner/committed.jpg", { bytes: content, contentType: "image/jpeg" }),
      ).rejects.toThrow("Object storage write failed");
      expect(await storage.read("owner/committed.jpg")).toEqual({
        bytes: content,
        contentType: "image/jpeg",
        sizeBytes: content.length,
      });
      await expect(
        storage.put("owner/committed.jpg", { bytes: replacement, contentType: "image/jpeg" }),
      ).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a dead writer's metadata-incomplete stage and allows a retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
    try {
      const stageDirectory = join(root, ".warm-letter-staging", "object-crashed");
      await mkdir(stageDirectory, { recursive: true });
      await writeFile(join(stageDirectory, "content"), content);
      await writeFile(
        join(stageDirectory, ".owner.json"),
        JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() }),
      );

      const storage = new FileSystemObjectStorage(root);
      expect(await storage.read("owner/recovered.jpg")).toBeUndefined();
      expect(await listStagingDirectories(root)).toEqual([]);

      await storage.put("owner/recovered.jpg", {
        bytes: replacement,
        contentType: "image/jpeg",
      });
      expect(await storage.read("owner/recovered.jpg")).toEqual({
        bytes: replacement,
        contentType: "image/jpeg",
        sizeBytes: replacement.length,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a stage left by a process terminated after binary creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
    try {
      const result = await runCrashWriter(root);
      expect(result).toEqual({ code: 93, signal: null });

      const storage = new FileSystemObjectStorage(root);
      expect(await storage.read("owner/crash-child.jpg")).toBeUndefined();
      expect(await listStagingDirectories(root)).toEqual([]);
      await storage.put("owner/crash-child.jpg", {
        bytes: replacement,
        contentType: "image/jpeg",
      });
      expect(await storage.read("owner/crash-child.jpg")).toEqual({
        bytes: replacement,
        contentType: "image/jpeg",
        sizeBytes: replacement.length,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues to read and delete legacy binary plus metadata sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
    try {
      const objectPath = join(root, "owner", "legacy.jpg");
      await mkdir(join(root, "owner"), { recursive: true });
      await writeFile(objectPath, content);
      await writeFile(
        `${objectPath}.warm-letter-metadata.json`,
        JSON.stringify({ version: 1, contentType: "image/jpeg", sizeBytes: content.length }),
      );

      const storage = new FileSystemObjectStorage(root);
      expect(await storage.read("owner/legacy.jpg")).toEqual({
        bytes: content,
        contentType: "image/jpeg",
        sizeBytes: content.length,
      });
      await expect(
        storage.put("owner/legacy.jpg", {
          bytes: replacement,
          contentType: "image/jpeg",
        }),
      ).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
      expect(await storage.read("owner/legacy.jpg")).toEqual({
        bytes: content,
        contentType: "image/jpeg",
        sizeBytes: content.length,
      });
      await storage.delete("owner/legacy.jpg");
      expect(await storage.read("owner/legacy.jpg")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a live or ownerless young stage while avoiding partial publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "warm-letter-object-storage-"));
    try {
      const stageDirectory = join(root, ".warm-letter-staging", "object-live");
      await mkdir(stageDirectory, { recursive: true });
      await writeFile(join(stageDirectory, "content"), content);
      const now = new Date();
      await utimes(stageDirectory, now, now);

      const storage = new FileSystemObjectStorage(root, {
        stagingRecoveryMaxAgeMs: 60 * 60 * 1000,
      });
      expect(await storage.read("owner/young-stage.jpg")).toBeUndefined();
      expect(await listStagingDirectories(root)).toEqual(["object-live"]);
      expect(await readFile(join(stageDirectory, "content"))).toEqual(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
