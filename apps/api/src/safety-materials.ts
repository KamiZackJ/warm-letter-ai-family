import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Material } from "./domain.js";
import { OperationDeadline } from "./deadline.js";
import { ApiError } from "./errors.js";
import type { ObjectStorage } from "./object-storage.js";
import type { Repository } from "./repository.js";
import { prepareMediaForSafety, type MediaSafetyTranscodeOptions, type ReviewMedia } from "./media-safety-transcode.js";

export interface SafetyMaterialOptions {
  /** Explicit private path; never fall back to the system's temporary directory. */
  temporaryDirectory: string;
  ffmpegPath?: string;
  timeoutMs?: number;
  /** Tests can inject conversion without starting a codec process. */
  prepareMedia?: (input: ReviewMedia, options: MediaSafetyTranscodeOptions) => Promise<ReviewMedia>;
}

const activeByRepository = new WeakMap<Repository, Map<string, { userId: string; promise: Promise<Material> }>>();

function missing(): ApiError {
  return new ApiError(404, "MATERIAL_NOT_FOUND", "素材已删除或不存在");
}

function requireCurrent(repository: Repository, requested: Material): Material {
  const material = repository.getMaterial(requested.id);
  if (!material || material.userId !== requested.userId || material.status === "DELETED" ||
    !repository.getUser(material.userId)) throw missing();
  if (material.status !== "READY" && material.status !== "UPLOADING") {
    throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材状态已改变，请重新打开后重试");
  }
  return material;
}

function sameVersion(current: Material, original: Material): boolean {
  return current.objectKey === original.objectKey && current.contentType === original.contentType &&
    current.status === original.status && current.type === original.type && current.name === original.name;
}

/**
 * Normalizes both new uploads and legacy READY media before submitting to WeChat.
 * The caller retains responsibility for setting UPLOADING -> READY and requesting review.
 */
export function normalizeSafetyMaterial(
  repository: Repository,
  storage: ObjectStorage,
  requested: Material,
  options: SafetyMaterialOptions,
): Promise<Material> {
  let active = activeByRepository.get(repository);
  if (!active) { active = new Map(); activeByRepository.set(repository, active); }
  const existing = active.get(requested.id);
  if (existing) {
    if (existing.userId !== requested.userId) return Promise.reject(missing());
    return existing.promise;
  }
  const operation = normalize(repository, storage, requested, options).finally(() => {
    if (active.get(requested.id)?.promise === operation) active.delete(requested.id);
  });
  active.set(requested.id, { userId: requested.userId, promise: operation });
  return operation;
}

async function normalize(repository: Repository, storage: ObjectStorage, requested: Material, options: SafetyMaterialOptions): Promise<Material> {
  const initial = requireCurrent(repository, requested);
  if (initial.type === "text") return initial;
  if (!isAbsolute(options.temporaryDirectory)) throw new Error("Safety media requires an absolute private temporaryDirectory");
  if (!initial.objectKey || !initial.contentType) throw new ApiError(409, "INVALID_MATERIAL_STATE", "素材缺少文件信息");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new Error("Invalid media normalization timeout");
  const deadline = new OperationDeadline(timeoutMs, () =>
    new ApiError(504, "MEDIA_REVIEW_PREPARATION_TIMEOUT", "素材处理超时，请稍后重试"));
  let newKey: string | undefined;
  let adopted = false;
  const discard = (key: string): void => { repository.scheduleObjectDeletion(key); };
  try {
    const stored = await deadline.wait(() => storage.read(initial.objectKey!));
    if (!stored) throw new ApiError(409, "UPLOAD_NOT_FOUND", "尚未收到素材文件，请重新上传");
    if (stored.contentType !== initial.contentType || stored.sizeBytes !== stored.bytes.length ||
      (initial.type === "audio" ? !stored.contentType.startsWith("audio/") : !stored.contentType.startsWith("image/"))) {
      throw new ApiError(409, "UPLOAD_METADATA_MISMATCH", "素材文件信息不一致，请重新上传");
    }
    const normalized = await deadline.wait(() => (options.prepareMedia ?? prepareMediaForSafety)(stored, {
      temporaryDirectory: options.temporaryDirectory, ffmpegPath: options.ffmpegPath,
      timeoutMs: Math.min(15_000, deadline.remainingMs()),
    }));
    deadline.check();
    const current = requireCurrent(repository, initial);
    if (!sameVersion(current, initial)) throw new ApiError(409, "MATERIAL_CHANGED", "素材已更新，请重试");
    const changed = normalized.contentType !== stored.contentType || !normalized.bytes.equals(stored.bytes);
    if (!changed) return current;
    // The current converter only replaces MP4/Ogg with a complete, bounded MP3 file.
    if (initial.type !== "audio" || normalized.contentType !== "audio/mpeg") throw new ApiError(415, "UNSUPPORTED_SAFETY_MEDIA", "素材格式暂不支持");
    newKey = `${initial.userId}/${randomUUID()}.mp3`;
    const writtenKey = newKey;
    await deadline.wait(async () => {
      try {
        await storage.put(writtenKey, normalized);
      } finally {
        // A storage implementation can finish after timeout; re-enqueue cleanup even
        // if an earlier outbox attempt ran before the late write completed.
        if (deadline.signal.aborted) discard(writtenKey);
      }
    });
    deadline.check();
    const saved = repository.transaction(() => {
      const latest = requireCurrent(repository, initial);
      if (!sameVersion(latest, initial)) throw new ApiError(409, "MATERIAL_CHANGED", "素材已更新，请重试");
      const result = repository.saveMaterial({
        ...latest, objectKey: writtenKey, contentType: normalized.contentType,
        name: `${latest.name.replace(/\.[^.]*$/u, "")}.mp3`,
      });
      repository.invalidateMediaSafetyChecks(latest.id);
      repository.scheduleObjectDeletion(initial.objectKey!);
      return result;
    });
    adopted = true;
    return saved;
  } finally {
    try { if (newKey && !adopted) discard(newKey); }
    finally { deadline.dispose(); }
  }
}
