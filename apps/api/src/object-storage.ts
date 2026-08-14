import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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

interface FileMetadata extends StoredObjectMetadata {
  version: 1;
}

export class FileSystemObjectStorage implements ObjectStorage {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async put(
    objectKey: string,
    input: { bytes: Buffer; contentType: string },
  ): Promise<StoredObjectMetadata> {
    const objectPath = this.resolveObjectPath(objectKey);
    const metadataPath = this.metadataPath(objectPath);
    const metadata: FileMetadata = {
      version: 1,
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
    };

    try {
      await mkdir(dirname(objectPath), { recursive: true });
      await writeFile(objectPath, input.bytes);
      await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
    } catch {
      await Promise.allSettled([
        rm(objectPath, { force: true }),
        rm(metadataPath, { force: true }),
      ]);
      throw new Error("Object storage write failed");
    }
    return metadata;
  }

  async head(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    const objectPath = this.resolveObjectPath(objectKey);
    try {
      const [fileStats, metadataJson] = await Promise.all([
        stat(objectPath),
        readFile(this.metadataPath(objectPath), "utf8"),
      ]);
      if (!fileStats.isFile()) return undefined;

      const metadata = this.parseMetadata(metadataJson);
      if (metadata.sizeBytes !== fileStats.size) {
        throw new Error("Stored object metadata does not match the binary object");
      }
      return {
        contentType: metadata.contentType,
        sizeBytes: metadata.sizeBytes,
      };
    } catch (error) {
      if (this.isMissingFile(error)) return undefined;
      throw new Error("Object storage metadata read failed");
    }
  }

  async read(objectKey: string): Promise<StoredObject | undefined> {
    const objectPath = this.resolveObjectPath(objectKey);
    try {
      const [bytes, metadata] = await Promise.all([
        readFile(objectPath),
        this.head(objectKey),
      ]);
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

  async delete(objectKey: string): Promise<void> {
    const objectPath = this.resolveObjectPath(objectKey);
    try {
      await Promise.all([
        rm(objectPath, { force: true }),
        rm(this.metadataPath(objectPath), { force: true }),
      ]);
    } catch {
      throw new Error("Object storage delete failed");
    }
  }

  private resolveObjectPath(objectKey: string): string {
    if (!objectKey || objectKey.includes("\\") || objectKey.split("/").includes("..")) {
      throw new Error("Invalid object key");
    }

    const objectPath = resolve(this.rootDirectory, ...objectKey.split("/"));
    const relativePath = relative(this.rootDirectory, objectPath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error("Invalid object key");
    }
    return objectPath;
  }

  private metadataPath(objectPath: string): string {
    return `${objectPath}.warm-letter-metadata.json`;
  }

  private parseMetadata(value: string): FileMetadata {
    const parsed = JSON.parse(value) as Partial<FileMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.contentType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      !Number.isSafeInteger(parsed.sizeBytes) ||
      parsed.sizeBytes < 1
    ) {
      throw new Error("Stored object metadata is invalid");
    }
    return parsed as FileMetadata;
  }

  private isMissingFile(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}
