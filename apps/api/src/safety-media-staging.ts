import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { OperationDeadline } from "./deadline.js";
import type { Material } from "./domain.js";
import { ApiError } from "./errors.js";
import type { ObjectStorage } from "./object-storage.js";
import type { Repository } from "./repository.js";

export interface SafetyMediaRemoteStore {
  put(key: string, input: { bytes: Buffer; contentType: string }, signal: AbortSignal): Promise<void>;
  delete(key: string, signal: AbortSignal): Promise<void>;
  signedGetUrl(key: string, expiresAt: Date, signal?: AbortSignal): Promise<string>;
}

export interface SafetyMediaStagingOptions {
  directory: string;
  repository: Repository;
  objectStorage: ObjectStorage;
  remote: SafetyMediaRemoteStore;
  objectKeyPrefix?: string;
  /** Non-secret stable region/bucket/prefix identity; never reuse a journal across namespaces. */
  namespaceId?: string;
  operationTimeoutMs?: number;
  sweepTimeoutMs?: number;
  ttlMs?: number;
  maxPendingLeases?: number;
  now?: () => Date;
}

type Lease = {
  version: 1;
  id: string;
  objectKey: string;
  materialId: string;
  userId: string;
  sourceFingerprint: string;
  baselineTraceId?: string;
  createdAt: number;
  expiresAt: number;
  state: "uploading" | "ready" | "delete-pending";
  uploadSettled: boolean;
  uncertainUntil?: number;
  nextDeleteAt?: number;
};

const maximumTtlMs = 45 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const extensions: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/bmp": ".bmp",
  "audio/mpeg": ".mp3", "audio/wav": ".wav",
};

function unavailable(): ApiError {
  return new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "素材安全检查暂时不可用，请稍后重试");
}

function missing(): ApiError {
  return new ApiError(404, "MATERIAL_NOT_FOUND", "素材已删除或更新，请重新打开后重试");
}

function fingerprint(material: Material): string {
  return createHash("sha256").update(JSON.stringify([
    material.id, material.userId, material.type, material.objectKey, material.contentType,
  ])).digest("hex");
}

/**
 * Private review copies have their own durable deletion journal. The journal must
 * be backed up with UPLOAD_DIR and must never be served by an HTTP file server.
 * It deliberately survives deletion of repository users and their safety checks.
 */
export class SafetyMediaStaging {
  private readonly leases = new Map<string, Lease>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly activePreparations = new Set<string>();
  private readonly activeUploads = new Set<string>();
  private readonly settlingUploads = new Set<string>();
  private readonly operations = new Set<AbortController>();
  private readonly preparations = new Map<string, { fingerprint: string; controller: AbortController; promise: Promise<string> }>();
  private readonly ready: Promise<void>;
  private readonly prefix: string;
  private readonly namespaceId: string;
  private readonly ttlMs: number;
  private readonly operationTimeoutMs: number;
  private readonly sweepTimeoutMs: number;
  private readonly maxPendingLeases: number;
  private sweeping?: Promise<void>;
  private closed = false;

  constructor(private readonly options: SafetyMediaStagingOptions) {
    if (!isAbsolute(options.directory)) throw new Error("Safety staging requires an absolute private journal directory");
    this.prefix = options.objectKeyPrefix ?? "wechat-safety/";
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/u.test(this.prefix)) throw new Error("Invalid safety staging object prefix");
    this.namespaceId = options.namespaceId ?? "default";
    if (!/^[A-Za-z0-9._/-]{1,256}$/u.test(this.namespaceId)) throw new Error("Invalid safety staging namespace identity");
    this.ttlMs = options.ttlMs ?? maximumTtlMs;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    this.sweepTimeoutMs = options.sweepTimeoutMs ?? 10_000;
    this.maxPendingLeases = options.maxPendingLeases ?? 128;
    if (!Number.isSafeInteger(this.maxPendingLeases) || this.maxPendingLeases < 1 || this.maxPendingLeases > 10_000) {
      throw new Error("Invalid safety staging capacity");
    }
    for (const [value, maximum] of [[this.ttlMs, maximumTtlMs], [this.operationTimeoutMs, 60_000], [this.sweepTimeoutMs, 30_000]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid safety staging deadline");
    }
    this.ready = this.restore();
    // Initialization errors remain observable by prepare/sweep without an
    // unhandled rejection if the application has not submitted media yet.
    void this.ready.catch(() => undefined);
  }

  private now(): number { return this.options.now?.().getTime() ?? Date.now(); }

  private current(material: Material): Material {
    const current = this.options.repository.getMaterial(material.id);
    if (!current || current.status !== "READY" || current.type === "text" || !current.objectKey || !current.contentType ||
      current.userId !== material.userId || fingerprint(current) !== fingerprint(material) ||
      !this.options.repository.getUser(current.userId)) throw missing();
    return current;
  }

  private sourceExists(lease: Lease): boolean {
    const material = this.options.repository.getMaterial(lease.materialId);
    return Boolean(material && material.status === "READY" && material.userId === lease.userId &&
      fingerprint(material) === lease.sourceFingerprint && this.options.repository.getUser(lease.userId));
  }

  private terminalCheck(lease: Lease): boolean {
    const check = this.options.repository.getLatestMediaSafetyCheck(lease.materialId);
    return Boolean(check && check.traceId !== lease.baselineTraceId && check.status !== "pending");
  }

  async prepare(material: Material): Promise<string> {
    if (this.closed) throw unavailable();
    const source = this.current(material);
    const sourceFingerprint = fingerprint(source);
    const active = this.preparations.get(source.id);
    if (active?.fingerprint === sourceFingerprint) return active.promise;
    active?.controller.abort();
    const controller = new AbortController();
    const promise = this.prepareSource(source, controller).finally(() => {
      if (this.preparations.get(source.id)?.controller === controller) this.preparations.delete(source.id);
    });
    this.preparations.set(source.id, { fingerprint: sourceFingerprint, controller, promise });
    return promise;
  }

  private async prepareSource(material: Material, controller: AbortController): Promise<string> {
    const deadline = new OperationDeadline(this.operationTimeoutMs, unavailable, controller.signal);
    this.operations.add(controller);
    let lease: Lease | undefined;
    try {
      await deadline.wait(() => this.ready);
      if (this.closed) throw unavailable();
      this.current(material);
      const baselineTraceId = this.options.repository.getLatestMediaSafetyCheck(material.id)?.traceId;
      lease = [...this.leases.values()].find((entry) => entry.materialId === material.id && entry.userId === material.userId &&
        entry.sourceFingerprint === fingerprint(material) && entry.state === "ready" &&
        entry.baselineTraceId === baselineTraceId && entry.expiresAt - this.now() >= 60_000);
      if (!lease) {
        if (this.leases.size >= this.maxPendingLeases) throw unavailable();
        const extension = extensions[material.contentType!];
        if (!extension) throw unavailable();
        const now = this.now();
        const id = randomUUID();
        lease = { version: 1, id, objectKey: `${this.prefix}${id}${extension}`, materialId: material.id, userId: material.userId,
          sourceFingerprint: fingerprint(material), baselineTraceId, createdAt: now, expiresAt: now + this.ttlMs,
          state: "uploading", uploadSettled: false };
        this.leases.set(id, lease);
        this.activePreparations.add(id);
        // A process may die during or after PUT. Record the future object key
        // durably before issuing any remote upload, so recovery can still erase it.
        await deadline.wait(() => this.persist(lease!));
        const stored = await deadline.wait(() => this.options.objectStorage.read(material.objectKey!));
        if (!stored || stored.contentType !== material.contentType || stored.bytes.length > 10 * 1024 * 1024) throw unavailable();
        this.current(material);
        deadline.check();
        const uploadingLease = lease;
        this.activeUploads.add(lease.id);
        const upload = Promise.resolve().then(() => {
          deadline.check();
          return this.options.remote.put(uploadingLease.objectKey, stored, deadline.signal);
        });
        void upload.then(
          () => this.uploadSettled(uploadingLease, true),
          () => this.uploadSettled(uploadingLease, false),
        ).catch(() => undefined);
        await deadline.wait(() => upload);
        this.current(material);
        if (lease.state === "delete-pending") throw missing();
        lease.uploadSettled = true;
        lease.state = "ready";
        await deadline.wait(() => this.persist(lease!));
      } else {
        this.activePreparations.add(lease.id);
      }
      this.current(material);
      if (lease.state !== "ready" || lease.expiresAt <= this.now()) throw unavailable();
      const url = await deadline.wait(() => this.options.remote.signedGetUrl(lease!.objectKey, new Date(lease!.expiresAt), deadline.signal));
      this.current(material);
      if (this.closed || lease.state !== "ready" || lease.expiresAt <= this.now()) throw unavailable();
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw unavailable();
      return url;
    } catch (error) {
      if (lease) {
        lease.state = "delete-pending";
        if (!lease.uploadSettled) lease.uncertainUntil = lease.expiresAt;
        lease.nextDeleteAt = undefined;
        void this.persist(lease).catch(() => undefined);
      }
      throw error instanceof ApiError ? error : unavailable();
    } finally {
      deadline.dispose();
      this.operations.delete(controller);
      if (lease) this.activePreparations.delete(lease.id);
      if (!this.closed && lease?.state === "delete-pending") void this.sweep().catch(() => undefined);
    }
  }

  private async uploadSettled(lease: Lease, succeeded: boolean): Promise<void> {
    this.settlingUploads.add(lease.id);
    this.activeUploads.delete(lease.id);
    try {
      lease.uploadSettled = succeeded;
      // A failed/aborted PUT may have reached the remote server. Preserve the
      // tombstone until expiry even when an immediate DELETE returns not-found.
      lease.uncertainUntil = succeeded ? undefined : lease.expiresAt;
      if (lease.state === "delete-pending") lease.nextDeleteAt = undefined;
      await this.persist(lease);
    } finally {
      this.settlingUploads.delete(lease.id);
      if (!this.closed && lease.state === "delete-pending") void this.sweep().catch(() => undefined);
    }
  }

  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.sweeping) this.sweeping = this.performSweep().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async performSweep(): Promise<void> {
    const controller = new AbortController();
    const deadline = new OperationDeadline(this.sweepTimeoutMs, unavailable, controller.signal);
    this.operations.add(controller);
    try {
      await deadline.wait(() => this.ready);
      for (const lease of [...this.leases.values()]) {
        deadline.check();
        if (!this.sourceExists(lease) || this.terminalCheck(lease) || lease.expiresAt <= this.now()) {
          lease.state = "delete-pending";
          if (this.activePreparations.has(lease.id)) this.preparations.get(lease.materialId)?.controller.abort();
          if (!lease.uploadSettled) lease.uncertainUntil = lease.expiresAt;
          await deadline.wait(() => this.persist(lease));
        }
        if (lease.state !== "delete-pending" || (lease.nextDeleteAt ?? 0) > this.now()) continue;
        // A slow first DELETE must not consume every sweep's whole budget and
        // starve later objects when the sweep interval matches the retry delay.
        this.leases.delete(lease.id);
        this.leases.set(lease.id, lease);
        try {
          await deadline.wait(() => this.options.remote.delete(lease.objectKey, deadline.signal));
          if (this.activePreparations.has(lease.id) || this.activeUploads.has(lease.id) || this.settlingUploads.has(lease.id) ||
            (lease.uncertainUntil ?? 0) > this.now()) {
            lease.nextDeleteAt = Math.max(this.now() + 30_000, lease.uncertainUntil ?? 0);
            await deadline.wait(() => this.persist(lease));
          } else {
            await deadline.wait(() => this.remove(lease));
          }
        } catch {
          // Keep both the tombstone and its key through network or disk failures.
          lease.nextDeleteAt = this.now() + 30_000;
          void this.persist(lease).catch(() => undefined);
          if (deadline.signal.aborted) return;
        }
      }
    } finally {
      deadline.dispose();
      this.operations.delete(controller);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.operations) controller.abort();
  }

  private async restore(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.options.directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw unavailable();
    for (let parent = dirname(this.options.directory); ; parent = dirname(parent)) {
      if ((await lstat(parent)).isSymbolicLink()) throw unavailable();
      if (dirname(parent) === parent) break;
    }
    if (this.closed) return;
    const files = await readdir(this.options.directory);
    await this.bindNamespace(files);
    for (const filename of files) {
      const fileInfo = await lstat(join(this.options.directory, filename)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && filename.endsWith(".tmp")) return undefined;
        throw error;
      });
      if (!fileInfo) continue;
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw unavailable();
      if (filename === "context.json") continue;
      if (!filename.endsWith(".json")) continue;
      const id = filename.slice(0, -5);
      if (!uuidPattern.test(id) || fileInfo.size > 16_384) throw unavailable();
      const lease = JSON.parse(await readFile(join(this.options.directory, filename), "utf8")) as Lease;
      if (lease.version !== 1 || lease.id !== id || !["uploading", "ready", "delete-pending"].includes(lease.state) ||
        ![".jpg", ".png", ".bmp", ".mp3", ".wav"].some((extension) => lease.objectKey === `${this.prefix}${id}${extension}`) ||
        typeof lease.materialId !== "string" || !lease.materialId || typeof lease.userId !== "string" || !lease.userId ||
        !/^[a-f0-9]{64}$/u.test(lease.sourceFingerprint) || typeof lease.uploadSettled !== "boolean" ||
        !Number.isSafeInteger(lease.createdAt) || !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= lease.createdAt || lease.expiresAt - lease.createdAt > maximumTtlMs ||
        (lease.baselineTraceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(lease.baselineTraceId))) throw unavailable();
      if (lease.state === "uploading") {
        lease.state = "delete-pending";
        lease.uncertainUntil = lease.expiresAt;
        lease.nextDeleteAt = undefined;
      }
      if (lease.uncertainUntil !== undefined && (!Number.isSafeInteger(lease.uncertainUntil) || lease.uncertainUntil > lease.expiresAt)) throw unavailable();
      if (lease.nextDeleteAt !== undefined && !Number.isSafeInteger(lease.nextDeleteAt)) throw unavailable();
      this.leases.set(id, lease);
      if (lease.state === "delete-pending") await this.persist(lease);
    }
  }

  private async bindNamespace(existingFiles: string[]): Promise<void> {
    const contextPath = join(this.options.directory, "context.json");
    const context = { version: 1, namespaceId: this.namespaceId, objectKeyPrefix: this.prefix };
    if (!existingFiles.includes("context.json")) {
      // Never silently adopt existing leases whose original remote bucket is unknown.
      if (existingFiles.some((filename) => filename.endsWith(".json"))) throw unavailable();
      const temporary = join(this.options.directory, `context.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(`${JSON.stringify(context)}\n`, "utf8"); await file.sync(); }
        finally { await file.close(); }
        // A hard link publishes an already-complete file without overwriting an
        // existing context, including concurrent constructors with different buckets.
        try { await link(temporary, contextPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await this.syncDirectory();
      } finally { await unlink(temporary).catch(() => undefined); }
    }
    const info = await lstat(contextPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) throw unavailable();
    const saved = JSON.parse(await readFile(contextPath, "utf8")) as Record<string, unknown>;
    if (saved.version !== context.version || saved.namespaceId !== context.namespaceId || saved.objectKeyPrefix !== context.objectKeyPrefix) {
      throw unavailable();
    }
  }

  private persist(lease: Lease): Promise<void> {
    const data = JSON.stringify(lease);
    return this.serialize(lease, async () => {
      const temporary = join(this.options.directory, `${lease.id}.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(`${data}\n`, "utf8"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(this.options.directory, `${lease.id}.json`));
        await this.syncDirectory();
      } finally { await unlink(temporary).catch(() => undefined); }
    });
  }

  private serialize(lease: Lease, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(lease.id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      // A timed-out cleanup may have finished erasing this lease while a
      // caller queued persistence. Never recreate that retired journal entry.
      if (this.leases.get(lease.id) !== lease) return;
      await operation();
    });
    this.writes.set(lease.id, write);
    void write.finally(() => { if (this.writes.get(lease.id) === write) this.writes.delete(lease.id); }).catch(() => undefined);
    return write;
  }

  private remove(lease: Lease): Promise<void> {
    return this.serialize(lease, async () => {
      // A late upload completion can have started while DELETE was in flight.
      if (this.activePreparations.has(lease.id) || this.activeUploads.has(lease.id) || this.settlingUploads.has(lease.id)) return;
      await unlink(join(this.options.directory, `${lease.id}.json`));
      await this.syncDirectory();
      this.leases.delete(lease.id);
    });
  }

  private async syncDirectory(): Promise<void> {
    // Windows does not expose directory fsync through fs.open. Production uses
    // Linux, where both the file and its containing directory are synchronized.
    if (process.platform === "win32") return;
    const directory = await open(this.options.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
