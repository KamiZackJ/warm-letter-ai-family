import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StoredObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

export interface StoredObject extends StoredObjectMetadata {
  bytes: Buffer;
}

export interface ObjectStorage {
  put(
    objectKey: string,
    input: { bytes: Buffer; contentType: string },
  ): Promise<StoredObjectMetadata>;
  head(objectKey: string): Promise<StoredObjectMetadata | undefined>;
  read(objectKey: string): Promise<StoredObject | undefined>;
  delete(objectKey: string): Promise<void>;
}

export class ObjectAlreadyExistsError extends Error {
  constructor() {
    super("Object already exists");
    this.name = "ObjectAlreadyExistsError";
  }
}

interface LegacyFileMetadata extends StoredObjectMetadata {
  version: 1;
}

interface CommittedFileMetadata extends StoredObjectMetadata {
  version: 2;
  objectKey: string;
}

interface StageOwner {
  pid: number;
  startedAt: number;
}

export type ObjectStorageFaultPoint =
  | "after-staged-content"
  | "after-staged-metadata"
  | "before-commit"
  | "after-commit";

export interface FileSystemObjectStorageOptions {
  /**
   * Test-only interruption hook. Production callers should leave this unset.
   * A process-level termination from this hook deliberately leaves a staging
   * directory behind for the next instance to recover.
   */
  faultInjector?: (point: ObjectStorageFaultPoint) => void | Promise<void>;
  /**
   * Ownerless staging directories younger than this threshold are retained to
   * avoid racing a process between mkdtemp() and its owner marker write.
   */
  stagingRecoveryMaxAgeMs?: number;
}

const objectDirectoryName = ".warm-letter-objects";
const stagingDirectoryName = ".warm-letter-staging";
const contentFileName = "content";
const metadataFileName = "metadata.json";
const ownerFileName = ".owner.json";
const defaultStagingRecoveryMaxAgeMs = 5 * 60 * 1000;

/**
 * Local development object storage with immutable, first-writer-wins objects.
 *
 * A committed object is a directory containing both its bytes and metadata.
 * The directory is assembled beneath a private staging root and atomically
 * renamed into the committed root. A reader therefore observes either the
 * entire object or no object at all, even if a writer crashes mid-upload.
 */
export class FileSystemObjectStorage implements ObjectStorage {
  private readonly rootDirectory: string;
  private readonly committedRoot: string;
  private readonly stagingRoot: string;
  private readonly faultInjector?: FileSystemObjectStorageOptions["faultInjector"];
  private readonly stagingRecoveryMaxAgeMs: number;
  private readonly recoveryPromise: Promise<void>;

  constructor(rootDirectory: string, options: FileSystemObjectStorageOptions = {}) {
    this.rootDirectory = resolve(rootDirectory);
    this.committedRoot = join(this.rootDirectory, objectDirectoryName);
    this.stagingRoot = join(this.rootDirectory, stagingDirectoryName);
    this.faultInjector = options.faultInjector;
    this.stagingRecoveryMaxAgeMs = options.stagingRecoveryMaxAgeMs ?? defaultStagingRecoveryMaxAgeMs;
    if (
      !Number.isSafeInteger(this.stagingRecoveryMaxAgeMs) ||
      this.stagingRecoveryMaxAgeMs < 0
    ) {
      throw new Error("stagingRecoveryMaxAgeMs must be a non-negative safe integer");
    }
    // Start recovery immediately. Each public method awaits it before using storage.
    this.recoveryPromise = this.recoverStagingDirectories();
  }

  async put(
    objectKey: string,
    input: { bytes: Buffer; contentType: string },
  ): Promise<StoredObjectMetadata> {
    this.assertValidObjectKey(objectKey);
    await this.recoveryPromise;

    const destination = this.committedObjectDirectory(objectKey);
    const legacyPath = this.legacyObjectPath(objectKey);
    const metadata: CommittedFileMetadata = {
      version: 2,
      objectKey,
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
    };
    let stageDirectory: string | undefined;

    try {
      if (
        (await this.pathExists(destination)) ||
        (await this.pathExists(legacyPath)) ||
        (await this.pathExists(this.legacyMetadataPath(legacyPath)))
      ) {
        throw new ObjectAlreadyExistsError();
      }
      await mkdir(dirname(destination), { recursive: true });
      await mkdir(this.stagingRoot, { recursive: true });
      stageDirectory = await mkdtemp(join(this.stagingRoot, "object-"));
      await this.writeStageOwner(stageDirectory);
      await this.writeSyncedFile(join(stageDirectory, contentFileName), input.bytes);
      await this.injectFault("after-staged-content");
      await this.writeSyncedFile(join(stageDirectory, metadataFileName), JSON.stringify(metadata));
      await this.injectFault("after-staged-metadata");
      await this.syncDirectory(stageDirectory);
      await this.injectFault("before-commit");

      try {
        await rename(stageDirectory, destination);
      } catch (error) {
        if (await this.pathExists(destination)) throw new ObjectAlreadyExistsError();
        throw error;
      }
      stageDirectory = undefined;
      await this.syncDirectory(dirname(destination));
      await this.injectFault("after-commit");
    } catch (error) {
      if (stageDirectory) {
        await rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof ObjectAlreadyExistsError) throw error;
      throw new Error("Object storage write failed");
    }

    return { contentType: metadata.contentType, sizeBytes: metadata.sizeBytes };
  }

  async head(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    this.assertValidObjectKey(objectKey);
    await this.recoveryPromise;
    const committed = await this.headCommitted(objectKey);
    if (committed !== undefined) return committed;
    return this.headLegacy(objectKey);
  }

  async read(objectKey: string): Promise<StoredObject | undefined> {
    this.assertValidObjectKey(objectKey);
    await this.recoveryPromise;

    const committed = await this.readCommitted(objectKey);
    if (committed !== undefined) return committed;
    return this.readLegacy(objectKey);
  }

  async delete(objectKey: string): Promise<void> {
    this.assertValidObjectKey(objectKey);
    await this.recoveryPromise;

    const legacyPath = this.legacyObjectPath(objectKey);
    try {
      await Promise.all([
        rm(this.committedObjectDirectory(objectKey), { recursive: true, force: true }),
        rm(legacyPath, { force: true }),
        rm(this.legacyMetadataPath(legacyPath), { force: true }),
      ]);
    } catch {
      throw new Error("Object storage delete failed");
    }
  }

  private async headCommitted(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    const directory = this.committedObjectDirectory(objectKey);
    let directoryStats: Awaited<ReturnType<typeof stat>>;
    try {
      directoryStats = await stat(directory);
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage metadata read failed");
    }
    if (!directoryStats.isDirectory()) {
      throw new Error("Object storage metadata read failed");
    }
    try {
      const [contentStats, metadataJson] = await Promise.all([
        stat(join(directory, contentFileName)),
        readFile(join(directory, metadataFileName), "utf8"),
      ]);
      if (!contentStats.isFile()) return undefined;
      const metadata = this.parseCommittedMetadata(metadataJson, objectKey);
      if (metadata.sizeBytes !== contentStats.size) {
        throw new Error("Stored object metadata does not match the binary object");
      }
      return { contentType: metadata.contentType, sizeBytes: metadata.sizeBytes };
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage metadata read failed");
    }
  }

  private async readCommitted(objectKey: string): Promise<StoredObject | undefined> {
    const directory = this.committedObjectDirectory(objectKey);
    let directoryStats: Awaited<ReturnType<typeof stat>>;
    try {
      directoryStats = await stat(directory);
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage read failed");
    }
    if (!directoryStats.isDirectory()) {
      throw new Error("Object storage read failed");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, contentFileName));
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage read failed");
    }
    const metadata = await this.headCommitted(objectKey);
    if (!metadata) return undefined;
    if (bytes.length !== metadata.sizeBytes) {
      throw new Error("Stored object changed while it was being read");
    }
    return { bytes, ...metadata };
  }

  private async headLegacy(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    const objectPath = this.legacyObjectPath(objectKey);
    try {
      const [fileStats, metadataJson] = await Promise.all([
        stat(objectPath),
        readFile(this.legacyMetadataPath(objectPath), "utf8"),
      ]);
      if (!fileStats.isFile()) return undefined;
      const metadata = this.parseLegacyMetadata(metadataJson);
      if (metadata.sizeBytes !== fileStats.size) {
        throw new Error("Stored object metadata does not match the binary object");
      }
      return { contentType: metadata.contentType, sizeBytes: metadata.sizeBytes };
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage metadata read failed");
    }
  }

  private async readLegacy(objectKey: string): Promise<StoredObject | undefined> {
    const objectPath = this.legacyObjectPath(objectKey);
    try {
      const [bytes, metadata] = await Promise.all([readFile(objectPath), this.headLegacy(objectKey)]);
      if (!metadata) return undefined;
      if (bytes.length !== metadata.sizeBytes) {
        throw new Error("Stored object changed while it was being read");
      }
      return { bytes, ...metadata };
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage read failed");
    }
  }

  private committedObjectDirectory(objectKey: string): string {
    const digest = createHash("sha256").update(objectKey, "utf8").digest("hex");
    return join(this.committedRoot, digest.slice(0, 2), digest);
  }

  private legacyObjectPath(objectKey: string): string {
    const objectPath = resolve(this.rootDirectory, ...objectKey.split("/"));
    const relativePath = relative(this.rootDirectory, objectPath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error("Invalid object key");
    }
    return objectPath;
  }

  private legacyMetadataPath(objectPath: string): string {
    return `${objectPath}.warm-letter-metadata.json`;
  }

  private assertValidObjectKey(objectKey: string): void {
    const parts = objectKey.split("/");
    if (
      !objectKey ||
      objectKey.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..") ||
      parts[0] === objectDirectoryName ||
      parts[0] === stagingDirectoryName
    ) {
      throw new Error("Invalid object key");
    }
    this.legacyObjectPath(objectKey);
  }

  private async writeStageOwner(stageDirectory: string): Promise<void> {
    const owner: StageOwner = { pid: process.pid, startedAt: Date.now() };
    await this.writeSyncedFile(join(stageDirectory, ownerFileName), JSON.stringify(owner));
  }

  private async writeSyncedFile(path: string, value: string | Buffer): Promise<void> {
    let file: FileHandle | undefined;
    try {
      file = await open(path, "wx");
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file?.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    let directory: FileHandle | undefined;
    try {
      directory = await open(path, "r");
      await directory.sync();
    } catch (error) {
      // Windows cannot sync a directory handle. The rename is still atomic there.
      if (!this.isUnsupportedDirectorySync(error)) throw error;
    } finally {
      await directory?.close();
    }
  }

  private async injectFault(point: ObjectStorageFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }

  private async recoverStagingDirectories(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.stagingRoot, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if (this.isMissingFile(error)) return;
      throw new Error("Object storage recovery failed");
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const stageDirectory = join(this.stagingRoot, entry.name);
          if (await this.shouldRecoverStage(stageDirectory)) {
            await rm(stageDirectory, { recursive: true, force: true });
          }
        }),
    );
  }

  private async shouldRecoverStage(stageDirectory: string): Promise<boolean> {
    const owner = await this.readStageOwner(stageDirectory);
    if (owner && this.isProcessAlive(owner.pid)) return false;
    if (owner) return true;

    try {
      const details = await stat(stageDirectory);
      return Date.now() - details.mtimeMs >= this.stagingRecoveryMaxAgeMs;
    } catch (error) {
      if (this.isMissingFile(error)) return false;
      throw error;
    }
  }

  private async readStageOwner(stageDirectory: string): Promise<StageOwner | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(stageDirectory, ownerFileName), "utf8")) as Partial<StageOwner>;
      if (
        typeof parsed.pid !== "number" ||
        !Number.isSafeInteger(parsed.pid) ||
        parsed.pid < 1 ||
        typeof parsed.startedAt !== "number" ||
        !Number.isFinite(parsed.startedAt)
      ) {
        return undefined;
      }
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    } catch (error) {
      if (this.isMissingFile(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = this.errorCode(error);
      return code === "EPERM";
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (this.isMissingFile(error)) return false;
      throw error;
    }
  }

  private parseCommittedMetadata(value: string, objectKey: string): CommittedFileMetadata {
    const parsed = JSON.parse(value) as Partial<CommittedFileMetadata>;
    if (
      parsed.version !== 2 ||
      parsed.objectKey !== objectKey ||
      typeof parsed.contentType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      !Number.isSafeInteger(parsed.sizeBytes) ||
      parsed.sizeBytes < 1
    ) {
      throw new Error("Stored object metadata is invalid");
    }
    return parsed as CommittedFileMetadata;
  }

  private parseLegacyMetadata(value: string): LegacyFileMetadata {
    const parsed = JSON.parse(value) as Partial<LegacyFileMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.contentType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      !Number.isSafeInteger(parsed.sizeBytes) ||
      parsed.sizeBytes < 1
    ) {
      throw new Error("Stored object metadata is invalid");
    }
    return parsed as LegacyFileMetadata;
  }

  private isMissingFile(error: unknown): boolean {
    const code = this.errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
  }

  private isUnsupportedDirectorySync(error: unknown): boolean {
    const code = this.errorCode(error);
    return code === "EACCES" || code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP" || code === "EPERM";
  }

  private errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  }
}
