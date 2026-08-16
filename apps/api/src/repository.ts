import type {
  GenerationJob,
  Letter,
  Material,
  Reply,
  ShareAccess,
  User,
} from "./domain.js";

export class MemoryRepository {
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

  findUserByOpenId(openId: string): User | undefined {
    const userId = this.usersByOpenId.get(openId);
    return userId ? this.users.get(userId) : undefined;
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  saveUser(user: User): User {
    this.users.set(user.id, user);
    this.usersByOpenId.set(user.openId, user.id);
    return user;
  }

  getMaterial(id: string): Material | undefined {
    return this.materials.get(id);
  }

  listMaterials(userId: string): Material[] {
    return [...this.materials.values()].filter((material) => material.userId === userId);
  }

  saveMaterial(material: Material): Material {
    this.materials.set(material.id, material);
    return material;
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
          material: existingMaterial,
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
    return this.letters.get(id);
  }

  saveLetter(letter: Letter): Letter {
    this.letters.set(letter.id, letter);
    return letter;
  }

  getJob(id: string): GenerationJob | undefined {
    return this.jobs.get(id);
  }

  findGenerationJobByIdempotencyKey(
    userId: string,
    letterId: string,
    idempotencyKey: string,
  ): GenerationJob | undefined {
    return [...this.jobs.values()].find(
      (job) =>
        job.userId === userId &&
        job.letterId === letterId &&
        job.idempotencyKey === idempotencyKey,
    );
  }

  saveJob(job: GenerationJob): GenerationJob {
    this.jobs.set(job.id, job);
    return job;
  }

  listReplies(letterId: string): Reply[] {
    return [...this.replies.values()].filter((reply) => reply.letterId === letterId);
  }

  saveReply(reply: Reply): Reply {
    this.replies.set(reply.id, reply);
    return reply;
  }

  saveReplyIfBelowLimit(reply: Reply, maximum: number): Reply | undefined {
    let existingCount = 0;
    for (const existing of this.replies.values()) {
      if (existing.letterId !== reply.letterId) continue;
      existingCount += 1;
      if (existingCount >= maximum) return undefined;
    }
    this.replies.set(reply.id, reply);
    return reply;
  }

  findReplyByIdempotencyKey(
    letterId: string,
    idempotencyKey: string,
  ): { reply: Reply; requestFingerprint: string } | undefined {
    const lookupKey = JSON.stringify([letterId, idempotencyKey]);
    const request = this.replyRequestsByIdempotencyKey.get(lookupKey);
    if (!request) return undefined;
    const reply = this.replies.get(request.replyId);
    return reply ? { reply, requestFingerprint: request.requestFingerprint } : undefined;
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
    this.shareAccess.set(access.id, access);
    this.shareAccessIdsByTokenHash.set(access.tokenHash, access.id);
    return access;
  }

  getShareAccess(id: string): ShareAccess | undefined {
    return this.shareAccess.get(id);
  }

  findShareAccessByTokenHash(tokenHash: string): ShareAccess | undefined {
    const id = this.shareAccessIdsByTokenHash.get(tokenHash);
    return id ? this.shareAccess.get(id) : undefined;
  }

  listShareAccess(letterId: string): ShareAccess[] {
    return [...this.shareAccess.values()].filter((access) => access.letterId === letterId);
  }

}
