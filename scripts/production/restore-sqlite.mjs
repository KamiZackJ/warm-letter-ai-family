// Restore a completed backup to a new, isolated directory. Never replace live data.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { restoreSafetyJournalSnapshot, verifySafetyJournalSnapshot } from './safety-journal-backup.mjs';

const { values } = parseArgs({ options: { backup: { type: 'string' }, destination: { type: 'string' } } });
if (!values.backup || !values.destination) throw new Error('Required: --backup COMPLETED_BACKUP --destination NEW_PRIVATE_DIRECTORY');
const sourceRoot = resolve(values.backup), destination = resolve(values.destination);
const within = relative(sourceRoot, destination);
if (existsSync(destination) || !within || (!isAbsolute(within) && !within.startsWith(`..${sep}`) && within !== '..')) throw new Error('Restore destination must be new and outside the backup');
if (!lstatSync(sourceRoot).isDirectory() || !lstatSync(dirname(destination)).isDirectory()) throw new Error('Expected real source and destination parent directories');
const sourceUploads = join(sourceRoot, 'uploads');
const manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.databaseSha256 || '') || !Array.isArray(manifest.objects)) throw new Error('Invalid completed backup manifest');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function safePath(root, objectKey) {
  if (typeof objectKey !== 'string' || !objectKey || isAbsolute(objectKey) || /[\\\0:]/.test(objectKey) || objectKey.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe backup object key');
  const path = resolve(root, ...objectKey.split('/'));
  const part = relative(root, path);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Object path escaped backup');
  return path;
}
function readRegular(root, file) {
  let directory = dirname(file);
  while (true) {
    if (!lstatSync(directory).isDirectory()) throw new Error('Backup path contains a non-regular directory');
    if (directory === root) break;
    const next = dirname(directory);
    if (next === directory) throw new Error('Backup path escaped root');
    directory = next;
  }
  if (!lstatSync(file).isFile()) throw new Error('Expected a regular backup file');
  return readFileSync(file);
}
function verifyDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    if (database.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok') ||
        database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Restore database validation failed');
    if (Number(database.prepare('PRAGMA user_version').get().user_version) !== manifest.sourceSchema) throw new Error('Restore schema differs from manifest');
    for (const table of ['users', 'materials', 'letters', 'jobs', 'replies', 'share_access', 'auth_sessions', 'media_safety_checks', 'object_deletions']) {
      if (Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count) !== manifest.counts[table]) throw new Error('Restore row count differs from manifest');
    }
    const referenced = new Set();
    for (const row of database.prepare('SELECT data FROM materials').all()) {
      const material = JSON.parse(row.data);
      if (material.status === 'READY' && material.objectKey) referenced.add(material.objectKey);
    }
    for (const row of database.prepare('SELECT data FROM letters').all()) {
      const letter = JSON.parse(row.data);
      if (letter.narration?.objectKey) referenced.add(letter.narration.objectKey);
    }
    if (manifest.objects.length !== referenced.size || manifest.objects.some(object => !referenced.has(object?.objectKey))) {
      throw new Error('Backup objects differ from database references');
    }
  } finally { database.close(); }
}

let staging;
try {
  if (hash(readRegular(sourceRoot, join(sourceRoot, 'database.sqlite'))) !== manifest.databaseSha256) throw new Error('Backup database checksum mismatch');
  verifyDatabase(join(sourceRoot, 'database.sqlite'));
  verifySafetyJournalSnapshot(sourceUploads, manifest.safetyStaging);
  staging = mkdtempSync(join(dirname(destination), '.restore-staging-'));
  const targetUploads = join(staging, 'uploads'); mkdirSync(targetUploads, { mode: 0o700 });
  copyFileSync(join(sourceRoot, 'database.sqlite'), join(staging, 'database.sqlite'));
  chmodSync(join(staging, 'database.sqlite'), 0o600);
  if (hash(readFileSync(join(staging, 'database.sqlite'))) !== manifest.databaseSha256) throw new Error('Database changed during restore');
  const seen = new Set();
  for (const object of manifest.objects) {
    safePath(sourceUploads, object.objectKey);
    if (seen.has(object.objectKey) || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(object.sha256 || '')) throw new Error('Invalid object manifest');
    seen.add(object.objectKey);
    const digest = hash(Buffer.from(object.objectKey));
    const committedRelative = join('.warm-letter-objects', digest.slice(0, 2), digest);
    const committed = join(sourceUploads, committedRelative);
    const contentSource = existsSync(committed) ? join(committed, 'content') : safePath(sourceUploads, object.objectKey);
    const metadataSource = existsSync(committed) ? join(committed, 'metadata.json') : `${contentSource}.warm-letter-metadata.json`;
    const bytes = readRegular(sourceUploads, contentSource), metadataBytes = readRegular(sourceUploads, metadataSource);
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    if (bytes.length !== object.sizeBytes || metadata.sizeBytes !== bytes.length || hash(bytes) !== object.sha256 ||
        (existsSync(committed) && (metadata.version !== 2 || metadata.objectKey !== object.objectKey))) throw new Error('Backup object checksum or identity mismatch');
    for (const source of [contentSource, metadataSource]) {
      const target = join(targetUploads, relative(sourceUploads, source));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target); chmodSync(target, 0o600);
    }
    if (hash(readFileSync(join(targetUploads, relative(sourceUploads, contentSource)))) !== object.sha256) throw new Error('Object changed during restore');
  }
  restoreSafetyJournalSnapshot(sourceUploads, targetUploads, manifest.safetyStaging);
  verifyDatabase(join(staging, 'database.sqlite'));
  renameSync(staging, destination); staging = undefined;
  console.log(JSON.stringify({ status: 'restored-to-isolated-directory', destination: basename(destination), objectCount: manifest.objects.length,
    safetyLeaseCount: manifest.safetyStaging?.files.filter(file => file.name !== 'context.json').length || 0,
    liveConfigurationChanged: false, requiresDeletionReviewBeforeServing: true }));
} finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
