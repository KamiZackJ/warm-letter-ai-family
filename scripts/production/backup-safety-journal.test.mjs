import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, rmdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const tempBase = process.platform === 'win32' ? 'D:/tmp/warm-letter-ai-family' : tmpdir();
mkdirSync(tempBase, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, withJournal = true) {
  const root = mkdtempSync(join(tempBase, 'backup-journal-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uploads = join(root, 'uploads'), backups = join(root, 'backups'), database = join(root, 'live.sqlite');
  mkdirSync(uploads); mkdirSync(backups);
  const db = new DatabaseSync(database);
  for (const table of ['users', 'materials', 'letters', 'jobs', 'replies', 'share_access', 'auth_sessions', 'media_safety_checks', 'object_deletions']) db.exec(`CREATE TABLE ${table} (data TEXT)`);
  db.exec('PRAGMA user_version=1');
  const content = Buffer.from('immutable synthetic object');
  const objectKey = 'synthetic/referenced.bin';
  const digest = hash(Buffer.from(objectKey));
  const objectDirectory = join(uploads, '.warm-letter-objects', digest.slice(0, 2), digest);
  mkdirSync(objectDirectory, { recursive: true });
  writeFileSync(join(objectDirectory, 'content'), content);
  writeFileSync(join(objectDirectory, 'metadata.json'), JSON.stringify({ version: 2, objectKey, sizeBytes: content.length }));
  db.prepare('INSERT INTO materials VALUES (?)').run(JSON.stringify({ status: 'READY', objectKey }));
  db.close();
  writeFileSync(join(uploads, 'unrelated-private-file'), 'must not enter backup');
  const id = randomUUID(), journal = join(uploads, '.wechat-safety-staging');
  const lease = { version: 1, id, objectKey: `wechat-safety/${id}.png`, materialId: 'deleted-material', userId: 'deleted-user',
    sourceFingerprint: 'a'.repeat(64), createdAt: Date.now(), expiresAt: Date.now() + 2700000, state: 'delete-pending', uploadSettled: false };
  lease.expiresAt = lease.createdAt + 2700000;
  const leaseBytes = JSON.stringify(lease);
  const contextBytes = JSON.stringify({ version: 1, namespaceId: 'oss-cn-beijing/synthetic-bucket/wechat-safety/', objectKeyPrefix: 'wechat-safety/' });
  if (withJournal) {
    mkdirSync(journal);
    writeFileSync(join(journal, 'context.json'), contextBytes);
    writeFileSync(join(journal, `context.${randomUUID()}.tmp`), 'partial context write');
    writeFileSync(join(journal, `${id}.json`), leaseBytes);
    // Pending atomic write is not a durable lease; the durable JSON is authoritative.
    writeFileSync(join(journal, `${id}.${randomUUID()}.tmp`), 'partial in-flight write');
  }
  return { root, uploads, backups, database, journal, id, lease, leaseBytes, contextBytes, objectDirectory };
}
function invoke(name, args) {
  return spawnSync(process.execPath, [join(scriptDirectory, name), ...args], { encoding: 'utf8', timeout: 15000 });
}
function backup(f) {
  const result = invoke('backup-sqlite.mjs', ['--database', f.database, '--uploads', f.uploads, '--destination', f.backups]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  return { output, directory: join(f.backups, output.backup) };
}

test('backup and isolated restore retain orphan cleanup leases without unrelated uploads', t => {
  const f = fixture(t);
  const { directory, output } = backup(f);
  assert.equal(output.safetyLeaseCount, 1);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  assert.deepEqual(manifest.safetyStaging.files, [
    { name: `${f.id}.json`, sizeBytes: Buffer.byteLength(f.leaseBytes), sha256: hash(Buffer.from(f.leaseBytes)) },
    { name: 'context.json', sizeBytes: Buffer.byteLength(f.contextBytes), sha256: hash(Buffer.from(f.contextBytes)) },
  ].sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(readFileSync(join(directory, 'uploads', '.wechat-safety-staging', `${f.id}.json`), 'utf8'), f.leaseBytes);
  assert.equal(existsSync(join(directory, 'uploads', 'unrelated-private-file')), false);
  assert.deepEqual(readdirSync(join(directory, 'uploads', '.wechat-safety-staging')).sort(), [`${f.id}.json`, 'context.json'].sort());
  const restored = join(f.root, 'isolated-restored');
  const result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(restored, 'uploads', '.wechat-safety-staging', `${f.id}.json`), 'utf8'), f.leaseBytes);
  assert.equal(readFileSync(join(restored, 'uploads', '.wechat-safety-staging', 'context.json'), 'utf8'), f.contextBytes);
  assert.equal(existsSync(join(restored, 'uploads', 'unrelated-private-file')), false);
  assert.equal(JSON.parse(result.stdout.trim()).safetyLeaseCount, 1);
});

test('backups without a journal still restore without inventing leases', t => {
  const f = fixture(t, false);
  const { directory, output } = backup(f);
  assert.equal(output.safetyLeaseCount, 0);
  const restored = join(f.root, 'isolated-restored');
  const result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(restored, 'uploads', '.wechat-safety-staging')), false);
});

test('an invalid cleanup key fails backup and preserves completed backups', t => {
  const f = fixture(t);
  const prior = backup(f).directory;
  writeFileSync(join(f.journal, `${f.id}.json`), JSON.stringify({ ...f.lease, objectKey: 'another-project/private.png' }));
  const result = invoke('backup-sqlite.mjs', ['--database', f.database, '--uploads', f.uploads, '--destination', f.backups]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(prior), true);
  assert.equal(readdirSync(f.backups).length, 1);
});

test('a linked journal directory is rejected without copying outside files', t => {
  const f = fixture(t, false), outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, `${f.id}.json`), f.leaseBytes);
  symlinkSync(outside, f.journal, process.platform === 'win32' ? 'junction' : 'dir');
  const result = invoke('backup-sqlite.mjs', ['--database', f.database, '--uploads', f.uploads, '--destination', f.backups]);
  assert.notEqual(result.status, 0);
  assert.equal(readdirSync(f.backups).length, 0);
});

test('tampered backed-up lease prevents publishing a restored directory', t => {
  const f = fixture(t), { directory } = backup(f);
  const restored = join(f.root, 'isolated-restored');
  writeFileSync(join(directory, 'uploads', '.wechat-safety-staging', `${f.id}.json`), JSON.stringify({ ...f.lease, state: 'ready' }));
  const result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(restored), false);
});

test('unmanifested cleanup entries and existing restore destinations are rejected', t => {
  const f = fixture(t), { directory } = backup(f);
  const restored = join(f.root, 'isolated-restored');
  mkdirSync(restored);
  let result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(restored), []);
  rmdirSync(restored);
  const extraId = randomUUID();
  writeFileSync(join(directory, 'uploads', '.wechat-safety-staging', `${extraId}.json`), JSON.stringify({ ...f.lease, id: extraId, objectKey: `wechat-safety/${extraId}.png` }));
  result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(restored), false);
});

test('missing namespace marker fails backup even when leases are valid', t => {
  const f = fixture(t);
  rmSync(join(f.journal, 'context.json'));
  const result = invoke('backup-sqlite.mjs', ['--database', f.database, '--uploads', f.uploads, '--destination', f.backups]);
  assert.notEqual(result.status, 0);
  assert.equal(readdirSync(f.backups).length, 0);
});

test('restore refuses an omitted database-referenced object', t => {
  const f = fixture(t), { directory } = backup(f);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.objects = [];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const restored = join(f.root, 'isolated-restored');
  const result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(restored), false);
});

test('tampered namespace marker prevents publishing a restored directory', t => {
  const f = fixture(t), { directory } = backup(f);
  writeFileSync(join(directory, 'uploads', '.wechat-safety-staging', 'context.json'), JSON.stringify({
    version: 1, namespaceId: 'oss-cn-beijing/unrelated-bucket/wechat-safety/', objectKeyPrefix: 'wechat-safety/',
  }));
  const restored = join(f.root, 'isolated-restored');
  const result = invoke('restore-sqlite.mjs', ['--backup', directory, '--destination', restored]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(restored), false);
});
