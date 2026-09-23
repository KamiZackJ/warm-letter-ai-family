// Consistent DB snapshot plus immutable objects referenced by that snapshot.
// Run as root or a dedicated backup account; keep the backup directory private.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, rmSync, readdirSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';

const { values } = parseArgs({ options: {
  database: { type: 'string' }, uploads: { type: 'string' }, destination: { type: 'string' },
  retention: { type: 'string', default: '7' },
}});
if (!values.database || !values.uploads || !values.destination) throw new Error('Required: --database DB --uploads UPLOAD_DIR --destination PRIVATE_BACKUP_DIR');
const databasePath = resolve(values.database);
const uploadRoot = resolve(values.uploads);
const backupRoot = resolve(values.destination);
const retention = Number(values.retention);
if (!Number.isInteger(retention) || retention < 1 || retention > 90) throw new Error('Retention must be 1–90 days');
if (!existsSync(databasePath) || !existsSync(uploadRoot)) throw new Error('Source database or uploads directory missing');
if (backupRoot === uploadRoot || !relative(uploadRoot, backupRoot).startsWith('..')) throw new Error('Backups must be outside uploads');
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const staging = mkdtempSync(join(backupRoot, '.backup-staging-'));
const outputDatabase = join(staging, 'database.sqlite');
const outputUploads = join(staging, 'uploads');
mkdirSync(outputUploads, { mode: 0o700 });
const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), sourceSchema: 0, counts: {}, objects: [] };
function verifyDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    if (database.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok')) throw new Error('Backup integrity failed');
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup references failed');
    return database;
  } catch (error) { database.close(); throw error; }
}
function safeLegacyPath(root, objectKey) {
  if (typeof objectKey !== 'string' || !objectKey || objectKey.includes('\\') || objectKey.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe object key');
  const path = resolve(root, ...objectKey.split('/'));
  if (path === root || relative(root, path).startsWith(`..${sep}`)) throw new Error('Object path escaped storage');
  return path;
}
function copyPrivateFile(source, target) {
  if (!lstatSync(source).isFile()) throw new Error('Expected a regular immutable object file');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  const descriptor = openSync(target, 'r+');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
try {
  const source = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try { source.prepare('VACUUM INTO ?').run(outputDatabase); } finally { source.close(); }
  const snapshot = verifyDatabase(outputDatabase);
  const referenced = new Set();
  try {
    manifest.sourceSchema = Number(snapshot.prepare('PRAGMA user_version').get().user_version);
    for (const table of ['users', 'materials', 'letters', 'jobs', 'replies', 'share_access', 'auth_sessions', 'media_safety_checks', 'object_deletions']) {
      manifest.counts[table] = Number(snapshot.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
    }
    for (const row of snapshot.prepare('SELECT data FROM materials').all()) {
      const material = JSON.parse(row.data);
      if (material.status === 'READY' && material.objectKey) referenced.add(material.objectKey);
    }
    for (const row of snapshot.prepare('SELECT data FROM letters').all()) {
      const letter = JSON.parse(row.data);
      if (letter.narration?.objectKey) referenced.add(letter.narration.objectKey);
    }
  } finally { snapshot.close(); }
  for (const objectKey of referenced) {
    const digest = createHash('sha256').update(objectKey).digest('hex');
    const committedRelative = join('.warm-letter-objects', digest.slice(0, 2), digest);
    const committed = join(uploadRoot, committedRelative);
    let content;
    let metadata;
    if (existsSync(committed)) {
      metadata = JSON.parse(readFileSync(join(committed, 'metadata.json'), 'utf8'));
      if (metadata.version !== 2 || metadata.objectKey !== objectKey) throw new Error('Object metadata identity mismatch');
      content = readFileSync(join(committed, 'content'));
      copyPrivateFile(join(committed, 'content'), join(outputUploads, committedRelative, 'content'));
      copyPrivateFile(join(committed, 'metadata.json'), join(outputUploads, committedRelative, 'metadata.json'));
    } else {
      const legacy = safeLegacyPath(uploadRoot, objectKey);
      metadata = JSON.parse(readFileSync(`${legacy}.warm-letter-metadata.json`, 'utf8'));
      content = readFileSync(legacy);
      const target = safeLegacyPath(outputUploads, objectKey);
      copyPrivateFile(legacy, target);
      copyPrivateFile(`${legacy}.warm-letter-metadata.json`, `${target}.warm-letter-metadata.json`);
    }
    if (metadata.sizeBytes !== content.length) throw new Error('Object size mismatch');
    manifest.objects.push({ objectKey, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  // Rehearse a restore into a separate DB file, never overwrite live data.
  const rehearsal = join(staging, 'restore-rehearsal.sqlite');
  copyFileSync(outputDatabase, rehearsal);
  verifyDatabase(rehearsal).close();
  rmSync(rehearsal);
  manifest.databaseSha256 = createHash('sha256').update(readFileSync(outputDatabase)).digest('hex');
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx', flush: true });
  const dateName = manifest.createdAt.replaceAll(':', '-').replaceAll('.', '-');
  const destination = join(backupRoot, `backup-${dateName}-${randomUUID().slice(0, 8)}`);
  renameSync(staging, destination);
  // Rotate only completed backup directories matching this script's own names.
  const threshold = Date.now() - retention * 86_400_000;
  let removed = 0;
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^backup-\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[a-f0-9]{8}$/.test(entry.name)) continue;
    const candidate = join(backupRoot, entry.name);
    if (candidate === destination) continue;
    const marker = join(candidate, 'manifest.json');
    if (!existsSync(marker)) continue;
    const metadata = JSON.parse(readFileSync(marker, 'utf8'));
    if (metadata.schemaVersion === 1 && Date.parse(metadata.createdAt) < threshold) {
      rmSync(candidate, { recursive: true });
      removed += 1;
    }
  }
  console.log(JSON.stringify({ status: 'backed-up-and-restored-in-rehearsal', backup: basename(destination), counts: manifest.counts, objectCount: manifest.objects.length, removed }));
} catch (error) {
  // A concurrent object deletion may make this attempt fail. This is safe: the
  // incomplete directory is discarded; previous completed backups stay intact.
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
