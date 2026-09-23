import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { GenerationJob, Letter, Material, Reply, ShareAccess, User } from "./domain.js";
import {
  assertSynchronousResult,
  recoverInterruptedGeneration,
  type MaterialSaveResult,
  type AuthSession,
  type MediaSafetyCheck,
  type ReplySaveResult,
  type Repository,
} from "./repository.js";

const schema = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, open_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data))
  ) STRICT;
  CREATE TABLE materials (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(id, user_id)
  ) STRICT;
  CREATE INDEX materials_user ON materials(user_id);
  CREATE TABLE material_requests (
    user_id TEXT NOT NULL, request_key TEXT NOT NULL, material_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, PRIMARY KEY(user_id, request_key),
    FOREIGN KEY(material_id, user_id) REFERENCES materials(id, user_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE letters (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(id, user_id)
  ) STRICT;
  CREATE INDEX letters_user ON letters(user_id);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, letter_id TEXT NOT NULL,
    request_key TEXT, data TEXT NOT NULL CHECK(json_valid(data)),
    FOREIGN KEY(letter_id, user_id) REFERENCES letters(id, user_id) ON DELETE CASCADE,
    UNIQUE(user_id, letter_id, request_key)
  ) STRICT;
  CREATE INDEX jobs_letter ON jobs(letter_id);
  CREATE TABLE replies (
    id TEXT PRIMARY KEY, letter_id TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    author_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(id, letter_id)
  ) STRICT;
  CREATE INDEX replies_letter ON replies(letter_id);
  CREATE INDEX replies_author ON replies(author_user_id);
  CREATE TABLE reply_requests (
    letter_id TEXT NOT NULL, request_key TEXT NOT NULL, reply_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, PRIMARY KEY(letter_id, request_key),
    FOREIGN KEY(reply_id, letter_id) REFERENCES replies(id, letter_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE share_access (
    id TEXT PRIMARY KEY, letter_id TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data))
  ) STRICT;
  CREATE INDEX share_access_letter ON share_access(letter_id);
  CREATE TABLE object_deletions (
    object_key TEXT PRIMARY KEY, scheduled_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE media_safety_checks (
    trace_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, user_id TEXT NOT NULL,
    created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    FOREIGN KEY(material_id, user_id) REFERENCES materials(id, user_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX media_safety_material ON media_safety_checks(material_id, created_at DESC);
  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data))
  ) STRICT;
  CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
  CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
  PRAGMA user_version = 1;
`;

/** Durable single-server repository. Service-level multi-record changes use transaction(). */
export class SqliteRepository implements Repository {
  readonly kind = "sqlite" as const;
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private closed = false;

  constructor(options: { filename: string }) {
    if (!options.filename.trim()) throw new Error("SQLite filename is required");
    const filename = options.filename === ":memory:" ? ":memory:" : resolve(options.filename);
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5_000,
    });
    try {
      if (filename !== ":memory:") chmodSync(filename, 0o600);
      // FULL sync makes a committed response durable; WAL allows concurrent readers.
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
      const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 1) throw new Error("SQLite schema is newer than this server; refusing to open it");
      if (version === 0) this.transaction(() => this.database.exec(schema));
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `nested_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = assertSynchronousResult(operation());
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.database.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private get<T>(sql: string, ...parameters: SQLInputValue[]): T | undefined {
    const row = this.database.prepare(sql).get(...parameters);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }

  private all<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.database.prepare(sql).all(...parameters).map((row) => JSON.parse(String(row.data)) as T);
  }

  findUserByOpenId(openId: string): User | undefined {
    return this.get("SELECT data FROM users WHERE open_id = ?", openId);
  }

  getUser(id: string): User | undefined {
    return this.get("SELECT data FROM users WHERE id = ?", id);
  }

  saveUser(user: User): User {
    this.database.prepare(`INSERT INTO users (id, open_id, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET open_id = excluded.open_id, data = excluded.data`)
      .run(user.id, user.openId, JSON.stringify(user));
    return structuredClone(user);
  }

  getMaterial(id: string): Material | undefined {
    return this.get("SELECT data FROM materials WHERE id = ?", id);
  }

  listMaterials(userId: string): Material[] {
    return this.all("SELECT data FROM materials WHERE user_id = ? ORDER BY rowid", userId);
  }

  saveMaterial(material: Material): Material {
    return this.transaction(() => {
      this.database.prepare(`INSERT INTO materials (id, user_id, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, data = excluded.data`)
        .run(material.id, material.userId, JSON.stringify(material));
      if (material.status === "DELETED") {
        this.database.prepare("DELETE FROM media_safety_checks WHERE material_id = ?").run(material.id);
      }
      return structuredClone(material);
    });
  }

  saveMaterialIdempotently(material: Material, key: string | undefined, fingerprint: string): MaterialSaveResult {
    return this.transaction(() => {
      if (key) {
        const existing = this.database.prepare(`SELECT materials.data AS data, fingerprint
          FROM material_requests JOIN materials ON materials.id = material_id
          WHERE material_requests.user_id = ? AND request_key = ?`).get(material.userId, key);
        if (existing) return {
          material: JSON.parse(String(existing.data)) as Material,
          requestFingerprint: String(existing.fingerprint), replayed: true,
        };
      }
      const saved = this.saveMaterial(material);
      if (key) this.database.prepare("INSERT INTO material_requests VALUES (?, ?, ?, ?)")
        .run(material.userId, key, material.id, fingerprint);
      return { material: saved, requestFingerprint: fingerprint, replayed: false };
    });
  }

  getLetter(id: string): Letter | undefined {
    return this.get("SELECT data FROM letters WHERE id = ?", id);
  }

  listLetters(userId: string): Letter[] {
    return this.all("SELECT data FROM letters WHERE user_id = ? ORDER BY rowid", userId);
  }

  saveLetter(letter: Letter): Letter {
    this.database.prepare(`INSERT INTO letters (id, user_id, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, data = excluded.data`)
      .run(letter.id, letter.userId, JSON.stringify(letter));
    return structuredClone(letter);
  }

  deleteLetter(id: string): boolean {
    return this.database.prepare("DELETE FROM letters WHERE id = ?").run(id).changes > 0;
  }

  deleteUser(id: string): boolean {
    return this.database.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  getJob(id: string): GenerationJob | undefined {
    return this.get("SELECT data FROM jobs WHERE id = ?", id);
  }

  listJobs(userId?: string): GenerationJob[] {
    return userId === undefined
      ? this.all("SELECT data FROM jobs ORDER BY rowid")
      : this.all("SELECT data FROM jobs WHERE user_id = ? ORDER BY rowid", userId);
  }

  findGenerationJobByIdempotencyKey(userId: string, letterId: string, key: string): GenerationJob | undefined {
    return this.get("SELECT data FROM jobs WHERE user_id = ? AND letter_id = ? AND request_key = ?", userId, letterId, key);
  }

  saveJob(job: GenerationJob): GenerationJob {
    this.database.prepare(`INSERT INTO jobs (id, user_id, letter_id, request_key, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, letter_id = excluded.letter_id,
        request_key = excluded.request_key, data = excluded.data`)
      .run(job.id, job.userId, job.letterId, job.idempotencyKey ?? null, JSON.stringify(job));
    return structuredClone(job);
  }

  recoverInterruptedJobs(nowIso?: string): number {
    return this.transaction(() => recoverInterruptedGeneration(this, this.all("SELECT data FROM letters"), nowIso));
  }

  listReplies(letterId: string): Reply[] {
    return this.all("SELECT data FROM replies WHERE letter_id = ? ORDER BY rowid", letterId);
  }

  saveReply(reply: Reply): Reply {
    this.database.prepare(`INSERT INTO replies (id, letter_id, author_user_id, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET letter_id = excluded.letter_id,
        author_user_id = excluded.author_user_id, data = excluded.data`)
      .run(reply.id, reply.letterId, reply.authorUserId ?? null, JSON.stringify(reply));
    return structuredClone(reply);
  }

  saveReplyIfBelowLimit(reply: Reply, maximum: number): Reply | undefined {
    if (!Number.isSafeInteger(maximum) || maximum < 1) return undefined;
    return this.transaction(() => {
      const count = Number(this.database.prepare("SELECT count(*) AS count FROM replies WHERE letter_id = ?").get(reply.letterId)?.count);
      return count >= maximum ? undefined : this.saveReply(reply);
    });
  }

  findReplyByIdempotencyKey(letterId: string, key: string): Omit<ReplySaveResult, "replayed"> | undefined {
    const row = this.database.prepare(`SELECT replies.data AS data, fingerprint
      FROM reply_requests JOIN replies ON replies.id = reply_id
      WHERE reply_requests.letter_id = ? AND request_key = ?`).get(letterId, key);
    return row ? { reply: JSON.parse(String(row.data)) as Reply, requestFingerprint: String(row.fingerprint) } : undefined;
  }

  saveReplyIdempotentlyIfBelowLimit(reply: Reply, maximum: number, fingerprint: string, key?: string): ReplySaveResult | undefined {
    return this.transaction(() => {
      if (key) {
        const existing = this.findReplyByIdempotencyKey(reply.letterId, key);
        if (existing) return { ...existing, replayed: true };
      }
      const saved = this.saveReplyIfBelowLimit(reply, maximum);
      if (!saved) return undefined;
      if (key) this.database.prepare("INSERT INTO reply_requests VALUES (?, ?, ?, ?)")
        .run(reply.letterId, key, reply.id, fingerprint);
      return { reply: saved, replayed: false, requestFingerprint: fingerprint };
    });
  }

  saveShareAccess(access: ShareAccess): ShareAccess {
    this.database.prepare(`INSERT INTO share_access (id, letter_id, token_hash, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET letter_id = excluded.letter_id,
        token_hash = excluded.token_hash, data = excluded.data`)
      .run(access.id, access.letterId, access.tokenHash, JSON.stringify(access));
    return structuredClone(access);
  }

  getShareAccess(id: string): ShareAccess | undefined {
    return this.get("SELECT data FROM share_access WHERE id = ?", id);
  }

  findShareAccessByTokenHash(tokenHash: string): ShareAccess | undefined {
    return this.get("SELECT data FROM share_access WHERE token_hash = ?", tokenHash);
  }

  listShareAccess(letterId: string): ShareAccess[] {
    return this.all("SELECT data FROM share_access WHERE letter_id = ? ORDER BY rowid", letterId);
  }

  scheduleObjectDeletion(objectKey: string): void {
    this.database.prepare("INSERT INTO object_deletions VALUES (?, ?) ON CONFLICT(object_key) DO NOTHING")
      .run(objectKey, new Date().toISOString());
  }

  listObjectDeletions(limit = 100): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.database.prepare("SELECT object_key FROM object_deletions ORDER BY scheduled_at, rowid LIMIT ?")
      .all(limit).map((row) => String(row.object_key));
  }

  completeObjectDeletion(objectKey: string): void {
    this.database.prepare("DELETE FROM object_deletions WHERE object_key = ?").run(objectKey);
  }

  saveMediaSafetyCheck(check: MediaSafetyCheck): MediaSafetyCheck {
    return this.transaction(() => {
      const material = this.getMaterial(check.materialId);
      if (!material || material.userId !== check.userId || material.status === "DELETED") {
        throw new Error("Media safety check requires an active owned material");
      }
      const previous = this.getMediaSafetyCheck(check.traceId);
      if (previous && (previous.materialId !== check.materialId || previous.userId !== check.userId || previous.createdAt !== check.createdAt)) {
        throw new Error("Media safety trace identity must not change");
      }
      this.database.prepare(`INSERT INTO media_safety_checks (trace_id, material_id, user_id, created_at, data)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(trace_id) DO UPDATE SET data = excluded.data`)
        .run(check.traceId, check.materialId, check.userId, check.createdAt, JSON.stringify(check));
      return structuredClone(check);
    });
  }

  getMediaSafetyCheck(traceId: string): MediaSafetyCheck | undefined {
    return this.get("SELECT data FROM media_safety_checks WHERE trace_id = ?", traceId);
  }

  getLatestMediaSafetyCheck(materialId: string): MediaSafetyCheck | undefined {
    return this.get("SELECT data FROM media_safety_checks WHERE material_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", materialId);
  }

  invalidateMediaSafetyChecks(materialId: string): void {
    this.database.prepare("DELETE FROM media_safety_checks WHERE material_id = ?").run(materialId);
  }

  saveAuthSession(session: AuthSession): void {
    if (!Number.isSafeInteger(session.expiresAt) || !Number.isSafeInteger(session.createdAt)) {
      throw new Error("Session timestamps must be safe integers");
    }
    this.database.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at, data)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id,
        expires_at = excluded.expires_at, created_at = excluded.created_at, data = excluded.data`)
      .run(session.tokenHash, session.userId, session.expiresAt, session.createdAt, JSON.stringify(session));
  }

  getAuthSession(tokenHash: string): AuthSession | undefined {
    return this.get("SELECT data FROM auth_sessions WHERE token_hash = ?", tokenHash);
  }

  deleteAuthSession(tokenHash: string): void {
    this.database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  pruneAuthSessions(nowMs: number, maximum = 10_000): number {
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(maximum) || maximum < 0) {
      throw new Error("Invalid session pruning parameters");
    }
    return this.transaction(() => {
      const expired = this.database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(nowMs).changes;
      const excess = this.database.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
        SELECT token_hash FROM auth_sessions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`).run(maximum).changes;
      return Number(expired) + Number(excess);
    });
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
