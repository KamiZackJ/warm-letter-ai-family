import type {
  GenerationJob,
  Letter,
  Material,
  Reply,
  ShareAccess,
  User,
} from "./domain.js";

export interface MaterialSaveResult {
  material: Material;
  replayed: boolean;
  requestFingerprint: string;
}

export interface ReplySaveResult {
  reply: Reply;
  replayed: boolean;
  requestFingerprint: string;
}

export interface MediaSafetyCheck {
  traceId: string;
  materialId: string;
  userId: string;
  status: "pending" | "pass" | "reject" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

export interface Repository {
  readonly kind: "memory" | "sqlite";
  transaction<T>(operation: () => T): T;
  findUserByOpenId(openId: string): User | undefined;
  getUser(id: string): User | undefined;
  saveUser(user: User): User;
  getMaterial(id: string): Material | undefined;
  listMaterials(userId: string): Material[];
  saveMaterial(material: Material): Material;
  saveMaterialIdempotently(material: Material, key: string | undefined, fingerprint: string): MaterialSaveResult;
  getLetter(id: string): Letter | undefined;
  listLetters(userId: string): Letter[];
  saveLetter(letter: Letter): Letter;
  deleteLetter(id: string): boolean;
  deleteUser(id: string): boolean;
  getJob(id: string): GenerationJob | undefined;
  listJobs(userId?: string): GenerationJob[];
  findGenerationJobByIdempotencyKey(userId: string, letterId: string, key: string): GenerationJob | undefined;
  saveJob(job: GenerationJob): GenerationJob;
  recoverInterruptedJobs(nowIso?: string): number;
  listReplies(letterId: string): Reply[];
  saveReply(reply: Reply): Reply;
  saveReplyIfBelowLimit(reply: Reply, maximum: number): Reply | undefined;
  findReplyByIdempotencyKey(letterId: string, key: string): Omit<ReplySaveResult, "replayed"> | undefined;
  saveReplyIdempotentlyIfBelowLimit(reply: Reply, maximum: number, fingerprint: string, key?: string): ReplySaveResult | undefined;
  saveShareAccess(access: ShareAccess): ShareAccess;
  getShareAccess(id: string): ShareAccess | undefined;
  findShareAccessByTokenHash(tokenHash: string): ShareAccess | undefined;
  listShareAccess(letterId: string): ShareAccess[];
  scheduleObjectDeletion(objectKey: string): void;
  listObjectDeletions(limit?: number): string[];
  completeObjectDeletion(objectKey: string): void;
  saveMediaSafetyCheck(check: MediaSafetyCheck): MediaSafetyCheck;
  getMediaSafetyCheck(traceId: string): MediaSafetyCheck | undefined;
  getLatestMediaSafetyCheck(materialId: string): MediaSafetyCheck | undefined;
  invalidateMediaSafetyChecks(materialId: string): void;
  saveAuthSession(session: AuthSession): void;
  getAuthSession(tokenHash: string): AuthSession | undefined;
  deleteAuthSession(tokenHash: string): void;
  pruneAuthSessions(nowMs: number, maximum?: number): number;
  close(): void;
}

/** Transactions must remain synchronous: no provider, filesystem or network awaits. */
export function assertSynchronousResult<T>(result: T): T {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    // Observe rejected promises, but never pretend an async continuation is atomic.
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("Repository transactions must be synchronous");
  }
  return result;
}

export function recoverInterruptedGeneration(
  repository: Repository,
  letters: Letter[],
  nowIso = new Date().toISOString(),
): number {
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("Recovery timestamp is invalid");
  return repository.transaction(() => {
    const interrupted = repository.listJobs().filter((job) => job.status === "queued" || job.status === "running");
    for (const job of interrupted) {
      repository.saveJob({
        ...job,
        status: "failed",
        updatedAt: nowIso,
        finishedAt: nowIso,
        error: {
          code: "GENERATION_INTERRUPTED",
          message: "服务恢复后，上次生成已停止，请重新生成",
          retryable: true,
        },
      });
    }
    // Also repair the narrow legacy crash window between saving a letter and its job.
    for (const letter of letters) {
      if (letter.state !== "GENERATING") continue;
      repository.saveLetter({
        ...letter,
        state: letter.draft ? "EDITING" : letter.materialIds.length ? "MATERIALS_READY" : "DRAFT",
        updatedAt: nowIso,
      });
    }
    return interrupted.length;
  });
}

export class MemoryRepository implements Repository {
  readonly kind = "memory" as const;
  private readonly users = new Map<string, User>();
  private readonly usersByOpenId = new Map<string, string>();
  private readonly materials = new Map<string, Material>();
  private readonly materialRequestsByIdempotencyKey = new Map<
    string,
    { materialId: string; requestFingerprint: string }
  >();
  private readonly letters = new Map<string, Letter>();
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly replies = new Map<string, Reply>();
  private readonly replyRequestsByIdempotencyKey = new Map<
    string,
    { replyId: string; requestFingerprint: string }
  >();
  private readonly shareAccess = new Map<string, ShareAccess>();
  private readonly shareAccessIdsByTokenHash = new Map<string, string>();
  private readonly objectDeletions = new Map<string, true>();
  private readonly mediaSafetyChecks = new Map<string, MediaSafetyCheck>();
  private readonly authSessions = new Map<string, AuthSession>();

  transaction<T>(operation: () => T): T {
    const maps: Map<unknown, unknown>[] = [this.users, this.usersByOpenId, this.materials,
      this.materialRequestsByIdempotencyKey, this.letters, this.jobs, this.replies,
      this.replyRequestsByIdempotencyKey, this.shareAccess, this.shareAccessIdsByTokenHash,
      this.objectDeletions, this.mediaSafetyChecks, this.authSessions];
    const snapshots = maps.map((map) => structuredClone(map));
    try {
      return assertSynchronousResult(operation());
    } catch (error) {
      maps.forEach((map, index) => {
        map.clear();
        for (const [key, value] of snapshots[index]!) map.set(key, value);
      });
      throw error;
    }
  }

  findUserByOpenId(openId: string): User | undefined {
    const userId = this.usersByOpenId.get(openId);
    return userId ? this.getUser(userId) : undefined;
  }

  getUser(id: string): User | undefined {
    return structuredClone(this.users.get(id));
  }

  saveUser(user: User): User {
    const owner = this.usersByOpenId.get(user.openId);
    if (owner && owner !== user.id) throw new Error("User openId must be unique");
    const previous = this.users.get(user.id);
    if (previous) this.usersByOpenId.delete(previous.openId);
    this.users.set(user.id, structuredClone(user));
    this.usersByOpenId.set(user.openId, user.id);
    return structuredClone(user);
  }

  getMaterial(id: string): Material | undefined {
    return structuredClone(this.materials.get(id));
  }

  listMaterials(userId: string): Material[] {
    return structuredClone([...this.materials.values()].filter((material) => material.userId === userId));
  }

  saveMaterial(material: Material): Material {
    this.materials.set(material.id, structuredClone(material));
    if (material.status === "DELETED") {
      for (const check of this.mediaSafetyChecks.values()) {
        if (check.materialId === material.id) this.mediaSafetyChecks.delete(check.traceId);
      }
    }
    return structuredClone(material);
  }

  saveMaterialIdempotently(
    material: Material,
    idempotencyKey: string | undefined,
    requestFingerprint: string,
  ): { material: Material; replayed: boolean; requestFingerprint: string } {
    if (!idempotencyKey) {
      return {
        material: this.saveMaterial(material),
        replayed: false,
        requestFingerprint,
      };
    }

    const lookupKey = JSON.stringify([material.userId, idempotencyKey]);
    const existingRequest = this.materialRequestsByIdempotencyKey.get(lookupKey);
    if (existingRequest) {
      const existingMaterial = this.materials.get(existingRequest.materialId);
      if (existingMaterial) {
        return {
          material: structuredClone(existingMaterial),
          replayed: true,
          requestFingerprint: existingRequest.requestFingerprint,
        };
      }
    }

    const saved = this.saveMaterial(material);
    this.materialRequestsByIdempotencyKey.set(lookupKey, {
      materialId: saved.id,
      requestFingerprint,
    });
    return { material: saved, replayed: false, requestFingerprint };
  }

  getLetter(id: string): Letter | undefined {
    return structuredClone(this.letters.get(id));
  }

  listLetters(userId: string): Letter[] {
    return structuredClone([...this.letters.values()].filter((letter) => letter.userId === userId));
  }

  saveLetter(letter: Letter): Letter {
    this.letters.set(letter.id, structuredClone(letter));
    return structuredClone(letter);
  }

  getJob(id: string): GenerationJob | undefined {
    return structuredClone(this.jobs.get(id));
  }

  listJobs(userId?: string): GenerationJob[] {
    return structuredClone([...this.jobs.values()].filter((job) => userId === undefined || job.userId === userId));
  }

  findGenerationJobByIdempotencyKey(
    userId: string,
    letterId: string,
    idempotencyKey: string,
  ): GenerationJob | undefined {
    return structuredClone([...this.jobs.values()].find(
      (job) =>
        job.userId === userId &&
        job.letterId === letterId &&
        job.idempotencyKey === idempotencyKey,
    ));
  }

  saveJob(job: GenerationJob): GenerationJob {
    if (job.idempotencyKey) {
      const previous = this.findGenerationJobByIdempotencyKey(job.userId, job.letterId, job.idempotencyKey);
      if (previous && previous.id !== job.id) throw new Error("Generation idempotency key must be unique");
    }
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  recoverInterruptedJobs(nowIso?: string): number {
    return recoverInterruptedGeneration(this, structuredClone([...this.letters.values()]), nowIso);
  }

  listReplies(letterId: string): Reply[] {
    return structuredClone([...this.replies.values()].filter((reply) => reply.letterId === letterId));
  }

  saveReply(reply: Reply): Reply {
    this.replies.set(reply.id, structuredClone(reply));
    return structuredClone(reply);
  }

  saveReplyIfBelowLimit(reply: Reply, maximum: number): Reply | undefined {
    if (!Number.isSafeInteger(maximum) || maximum < 1) return undefined;
    let existingCount = 0;
    for (const existing of this.replies.values()) {
      if (existing.letterId !== reply.letterId) continue;
      existingCount += 1;
      if (existingCount >= maximum) return undefined;
    }
    return this.saveReply(reply);
  }

  findReplyByIdempotencyKey(
    letterId: string,
    idempotencyKey: string,
  ): { reply: Reply; requestFingerprint: string } | undefined {
    const lookupKey = JSON.stringify([letterId, idempotencyKey]);
    const request = this.replyRequestsByIdempotencyKey.get(lookupKey);
    if (!request) return undefined;
    const reply = this.replies.get(request.replyId);
    return reply ? { reply: structuredClone(reply), requestFingerprint: request.requestFingerprint } : undefined;
  }

  saveReplyIdempotentlyIfBelowLimit(
    reply: Reply,
    maximum: number,
    requestFingerprint: string,
    idempotencyKey?: string,
  ): { reply: Reply; replayed: boolean; requestFingerprint: string } | undefined {
    if (idempotencyKey) {
      const existing = this.findReplyByIdempotencyKey(reply.letterId, idempotencyKey);
      if (existing) return { ...existing, replayed: true };
    }

    const saved = this.saveReplyIfBelowLimit(reply, maximum);
    if (!saved) return undefined;
    if (idempotencyKey) {
      const lookupKey = JSON.stringify([reply.letterId, idempotencyKey]);
      this.replyRequestsByIdempotencyKey.set(lookupKey, {
        replyId: saved.id,
        requestFingerprint,
      });
    }
    return { reply: saved, replayed: false, requestFingerprint };
  }

  saveShareAccess(access: ShareAccess): ShareAccess {
    const owner = this.shareAccessIdsByTokenHash.get(access.tokenHash);
    if (owner && owner !== access.id) throw new Error("Share token hash must be unique");
    const previous = this.shareAccess.get(access.id);
    if (previous) this.shareAccessIdsByTokenHash.delete(previous.tokenHash);
    this.shareAccess.set(access.id, structuredClone(access));
    this.shareAccessIdsByTokenHash.set(access.tokenHash, access.id);
    return structuredClone(access);
  }

  getShareAccess(id: string): ShareAccess | undefined {
    return structuredClone(this.shareAccess.get(id));
  }

  findShareAccessByTokenHash(tokenHash: string): ShareAccess | undefined {
    const id = this.shareAccessIdsByTokenHash.get(tokenHash);
    return id ? this.getShareAccess(id) : undefined;
  }

  listShareAccess(letterId: string): ShareAccess[] {
    return structuredClone([...this.shareAccess.values()].filter((access) => access.letterId === letterId));
  }

  deleteLetter(id: string): boolean {
    const deleted = this.letters.delete(id);
    for (const job of this.jobs.values()) if (job.letterId === id) this.jobs.delete(job.id);
    for (const reply of this.replies.values()) if (reply.letterId === id) this.deleteReply(reply.id);
    for (const access of this.shareAccess.values()) {
      if (access.letterId !== id) continue;
      this.shareAccess.delete(access.id);
      this.shareAccessIdsByTokenHash.delete(access.tokenHash);
    }
    return deleted;
  }

  deleteUser(id: string): boolean {
    const user = this.users.get(id);
    if (!user) return false;
    for (const letter of this.letters.values()) if (letter.userId === id) this.deleteLetter(letter.id);
    for (const material of this.materials.values()) {
      if (material.userId !== id) continue;
      this.materials.delete(material.id);
      for (const [key, request] of this.materialRequestsByIdempotencyKey) {
        if (request.materialId === material.id) this.materialRequestsByIdempotencyKey.delete(key);
      }
    }
    for (const job of this.jobs.values()) if (job.userId === id) this.jobs.delete(job.id);
    for (const check of this.mediaSafetyChecks.values()) {
      if (check.userId === id) this.mediaSafetyChecks.delete(check.traceId);
    }
    for (const session of this.authSessions.values()) {
      if (session.userId === id) this.authSessions.delete(session.tokenHash);
    }
    for (const reply of this.replies.values()) if (reply.authorUserId === id) this.deleteReply(reply.id);
    this.usersByOpenId.delete(user.openId);
    return this.users.delete(id);
  }

  private deleteReply(id: string): void {
    this.replies.delete(id);
    for (const [key, request] of this.replyRequestsByIdempotencyKey) {
      if (request.replyId === id) this.replyRequestsByIdempotencyKey.delete(key);
    }
  }

  scheduleObjectDeletion(objectKey: string): void {
    this.objectDeletions.set(objectKey, true);
  }

  listObjectDeletions(limit = 100): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return [...this.objectDeletions.keys()].slice(0, limit);
  }

  completeObjectDeletion(objectKey: string): void {
    this.objectDeletions.delete(objectKey);
  }

  saveMediaSafetyCheck(check: MediaSafetyCheck): MediaSafetyCheck {
    const material = this.getMaterial(check.materialId);
    if (!material || material.userId !== check.userId || material.status === "DELETED") {
      throw new Error("Media safety check requires an active owned material");
    }
    const previous = this.mediaSafetyChecks.get(check.traceId);
    if (previous && (previous.materialId !== check.materialId || previous.userId !== check.userId || previous.createdAt !== check.createdAt)) {
      throw new Error("Media safety trace identity must not change");
    }
    this.mediaSafetyChecks.set(check.traceId, structuredClone(check));
    return structuredClone(check);
  }

  getMediaSafetyCheck(traceId: string): MediaSafetyCheck | undefined {
    return structuredClone(this.mediaSafetyChecks.get(traceId));
  }

  getLatestMediaSafetyCheck(materialId: string): MediaSafetyCheck | undefined {
    return structuredClone([...this.mediaSafetyChecks.values()].reverse()
      .filter((check) => check.materialId === materialId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]);
  }

  invalidateMediaSafetyChecks(materialId: string): void {
    for (const check of this.mediaSafetyChecks.values()) {
      if (check.materialId === materialId) this.mediaSafetyChecks.delete(check.traceId);
    }
  }

  saveAuthSession(session: AuthSession): void {
    if (!Number.isSafeInteger(session.expiresAt) || !Number.isSafeInteger(session.createdAt)) {
      throw new Error("Session timestamps must be safe integers");
    }
    this.authSessions.set(session.tokenHash, structuredClone(session));
  }

  getAuthSession(tokenHash: string): AuthSession | undefined {
    return structuredClone(this.authSessions.get(tokenHash));
  }

  deleteAuthSession(tokenHash: string): void {
    this.authSessions.delete(tokenHash);
  }

  pruneAuthSessions(nowMs: number, maximum = 10_000): number {
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(maximum) || maximum < 0) {
      throw new Error("Invalid session pruning parameters");
    }
    const previousCount = this.authSessions.size;
    for (const session of this.authSessions.values()) {
      if (session.expiresAt <= nowMs) this.authSessions.delete(session.tokenHash);
    }
    const oldestFirst = [...this.authSessions.values()].sort((left, right) => left.createdAt - right.createdAt);
    for (const session of oldestFirst.slice(0, Math.max(0, this.authSessions.size - maximum))) {
      this.authSessions.delete(session.tokenHash);
    }
    return previousCount - this.authSessions.size;
  }

  close(): void {}
}
