import { parseArgs } from 'node:util';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, database: { type: 'string' }, 'repository-module': { type: 'string' },
}});
if (!values.input || !values.database || !values['repository-module']) throw new Error('Required: --input SNAPSHOT --database NEW_DATABASE --repository-module SQLITE_REPOSITORY_JS');
const database = resolve(values.database);
if (existsSync(database)) throw new Error('Refusing to overwrite an existing database');
const snapshot = JSON.parse(readFileSync(values.input, 'utf8'));
if (snapshot.schemaVersion !== 1) throw new Error('Unexpected export schema');
for (const key of ['users', 'materials', 'letters', 'jobs', 'replies', 'shareAccess', 'materialRequests', 'replyRequests', 'authSessions']) {
  if (!Array.isArray(snapshot[key])) throw new Error(`Missing snapshot collection: ${key}`);
}
const { SqliteRepository } = await import(pathToFileURL(resolve(values['repository-module'])).href);
const repository = new SqliteRepository({ filename: database });
try {
  repository.transaction(() => {
    for (const user of snapshot.users) repository.saveUser(user);
    for (const material of snapshot.materials) repository.saveMaterial(material);
    for (const letter of snapshot.letters) repository.saveLetter(letter);
    for (const job of snapshot.jobs) repository.saveJob(job);
    for (const reply of snapshot.replies) repository.saveReply(reply);
    // Preserve the audit trail but require the owner to reissue through the new
    // content checks. Previously shared, unaudited links must not stay public.
    for (const share of snapshot.shareAccess) repository.saveShareAccess({
      ...share, revokedAt: share.revokedAt ?? snapshot.exportedAt,
    });
    for (const [lookupKey, request] of snapshot.materialRequests) {
      const [userId, key] = JSON.parse(lookupKey);
      const material = repository.getMaterial(request.materialId);
      if (!material || material.userId !== userId) throw new Error('Orphan material idempotency request');
      repository.saveMaterialIdempotently(material, key, request.requestFingerprint);
    }
    for (const [lookupKey, request] of snapshot.replyRequests) {
      const [letterId, key] = JSON.parse(lookupKey);
      const reply = repository.listReplies(letterId).find(entry => entry.id === request.replyId);
      if (!reply) throw new Error('Orphan reply idempotency request');
      repository.saveReplyIdempotentlyIfBelowLimit(reply, Number.MAX_SAFE_INTEGER, request.requestFingerprint, key);
    }
    for (const session of snapshot.authSessions) repository.saveAuthSession(session);
  });
} catch (error) {
  repository.close();
  // A failed import never becomes the active database. Remove only this newly
  // created exact file, not a recursive or calculated production directory.
  for (const file of [database, `${database}-wal`, `${database}-shm`]) if (existsSync(file)) unlinkSync(file);
  throw error;
}
repository.close();
const verified = new DatabaseSync(database, { readOnly: true });
try {
  if (verified.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok')) throw new Error('Imported database integrity check failed');
  if (verified.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Imported database foreign keys failed');
  const mapping = { users: 'users', materials: 'materials', letters: 'letters', jobs: 'jobs', replies: 'replies', shareAccess: 'share_access', materialRequests: 'material_requests', replyRequests: 'reply_requests', authSessions: 'auth_sessions' };
  const counts = {};
  for (const [collection, table] of Object.entries(mapping)) {
    const count = Number(verified.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
    if (count !== snapshot[collection].length) throw new Error(`Count mismatch: ${collection}`);
    counts[collection] = count;
  }
  const activeShares = Number(verified.prepare("SELECT count(*) AS count FROM share_access WHERE json_extract(data, '$.revokedAt') IS NULL").get().count);
  if (activeShares !== 0) throw new Error('Legacy unaudited share remained active');
  console.log(JSON.stringify({ status: 'imported-and-verified', counts, activeLegacyShares: activeShares }));
} finally { verified.close(); }
