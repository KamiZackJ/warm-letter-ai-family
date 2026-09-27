// Only durable review-copy leases, never arbitrary files under UPLOAD_DIR.
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const safetyJournalDirectory = '.wechat-safety-staging';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const leaseName = new RegExp(`^${uuid}\\.json$`);
const temporaryName = new RegExp(`^(?:${uuid}|context)\\.${uuid}\\.tmp$`);
const durableName = name => name === 'context.json' || leaseName.test(name);
const maxLeaseBytes = 16 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function ensureDirectory(path) {
  if (!lstatSync(path).isDirectory()) throw new Error('Safety journal must be a real directory');
}
function namesAt(path) {
  ensureDirectory(path);
  const names = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('Safety journal contains a non-regular entry');
    if (durableName(entry.name)) names.push(entry.name);
    else if (!temporaryName.test(entry.name)) throw new Error('Safety journal contains an unknown entry');
  }
  if (names.some(name => leaseName.test(name)) && !names.includes('context.json')) throw new Error('Safety journal namespace marker missing');
  return names.sort();
}
function readLease(path, name) {
  if (!durableName(name) || !lstatSync(path).isFile()) throw new Error('Invalid safety lease file');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > (name === 'context.json' ? 4096 : maxLeaseBytes)) throw new Error('Invalid safety lease size');
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error('Safety lease changed during read');
  } finally { closeSync(descriptor); }
  const lease = JSON.parse(bytes.toString('utf8'));
  if (name === 'context.json') {
    if (lease.version !== 1 || !/^[A-Za-z0-9._/-]{1,256}$/.test(lease.namespaceId || '') || lease.objectKeyPrefix !== 'wechat-safety/') {
      throw new Error('Invalid safety journal namespace marker');
    }
    return bytes;
  }
  const id = name.slice(0, -5);
  if (lease.version !== 1 || lease.id !== id || !['uploading', 'ready', 'delete-pending'].includes(lease.state) ||
      !['jpg', 'png', 'bmp', 'mp3', 'wav'].some(extension => lease.objectKey === `wechat-safety/${id}.${extension}`) ||
      typeof lease.materialId !== 'string' || !lease.materialId || typeof lease.userId !== 'string' || !lease.userId ||
      !/^[a-f0-9]{64}$/.test(lease.sourceFingerprint || '') || typeof lease.uploadSettled !== 'boolean' ||
      !Number.isSafeInteger(lease.createdAt) || !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= lease.createdAt || lease.expiresAt - lease.createdAt > 45 * 60_000 ||
      (lease.baselineTraceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(lease.baselineTraceId)) ||
      (lease.uncertainUntil !== undefined && (!Number.isSafeInteger(lease.uncertainUntil) || lease.uncertainUntil > lease.expiresAt)) ||
      (lease.nextDeleteAt !== undefined && !Number.isSafeInteger(lease.nextDeleteAt))) {
    throw new Error('Invalid safety lease content');
  }
  return bytes;
}

export function copySafetyJournalSnapshot(uploadRoot, outputUploads) {
  const source = join(uploadRoot, safetyJournalDirectory);
  if (!existsSync(source)) return { directory: safetyJournalDirectory, present: false, files: [] };
  const names = namesAt(source);
  const destination = join(outputUploads, safetyJournalDirectory);
  mkdirSync(destination, { mode: 0o700 });
  const files = [];
  for (const name of names) {
    const bytes = readLease(join(source, name), name);
    writeFileSync(join(destination, name), bytes, { flag: 'wx', mode: 0o600, flush: true });
    files.push({ name, sizeBytes: bytes.length, sha256: hash(bytes) });
  }
  // Atomic journal replacement is safe to read, but do not certify a backup
  // assembled across an observed deletion/update/new lease. Retry the whole backup.
  if (JSON.stringify(namesAt(source)) !== JSON.stringify(names)) throw new Error('Safety journal changed during backup');
  for (const file of files) {
    if (hash(readLease(join(source, file.name), file.name)) !== file.sha256) throw new Error('Safety lease changed during backup');
  }
  return { directory: safetyJournalDirectory, present: true, files };
}

export function verifySafetyJournalSnapshot(uploadRoot, manifest) {
  // Pre-staging backups have no such field; they cannot restore later leases.
  if (manifest === undefined) {
    if (existsSync(join(uploadRoot, safetyJournalDirectory))) throw new Error('Unmanifested safety journal');
    return { present: false, files: [] };
  }
  if (!manifest || manifest.directory !== safetyJournalDirectory || typeof manifest.present !== 'boolean' || !Array.isArray(manifest.files) ||
      (!manifest.present && manifest.files.length)) throw new Error('Invalid safety journal manifest');
  const directory = join(uploadRoot, safetyJournalDirectory);
  if (!manifest.present) {
    if (existsSync(directory)) throw new Error('Unmanifested safety journal');
    return manifest;
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || !durableName(file.name || '') || seen.has(file.name) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 ||
        file.sizeBytes > maxLeaseBytes || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error('Invalid safety journal file manifest');
    seen.add(file.name);
    const bytes = readLease(join(directory, file.name), file.name);
    if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) throw new Error('Safety journal checksum mismatch');
  }
  if (JSON.stringify(namesAt(directory)) !== JSON.stringify([...seen].sort()) || readdirSync(directory).length !== seen.size) {
    throw new Error('Unmanifested safety journal files');
  }
  return manifest;
}

export function restoreSafetyJournalSnapshot(sourceUploads, targetUploads, manifest) {
  const verified = verifySafetyJournalSnapshot(sourceUploads, manifest);
  if (!verified.present) return;
  const directory = join(targetUploads, safetyJournalDirectory);
  mkdirSync(directory, { mode: 0o700 });
  for (const file of verified.files) {
    const bytes = readLease(join(sourceUploads, safetyJournalDirectory, file.name), file.name);
    if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) throw new Error('Safety journal changed during restore');
    writeFileSync(join(directory, file.name), bytes, { flag: 'wx', mode: 0o600, flush: true });
  }
  verifySafetyJournalSnapshot(targetUploads, manifest);
}
