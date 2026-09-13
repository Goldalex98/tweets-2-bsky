import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureConfigIdentity, captureDatabase, verifyDatabase } from './image-data-invariants.js';

// Only a cloned snapshot is writable. No server, scheduler, provider or inbound
// route module is imported. Host invokes all stages with --network none.
const safeLog = console.log.bind(console);
const safeError = console.error.bind(console);
console.log = console.warn = console.error = console.info = () => undefined;
const checksum = (filename: string) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

async function main(): Promise<void> {
  const stage = process.argv[2];
  if (!['copy', 'migrate', 'restart'].includes(stage ?? '')) throw new Error('Invalid stage');
  const dataDir = process.env.TWEETS2BSKY_DATA_DIR;
  if (!dataDir) throw new Error('Missing isolated data directory');
  const configPath = path.join(dataDir, 'config.json');
  const databasePath = path.join(dataDir, 'database.sqlite');
  const evidencePath = path.join(dataDir, '.maintenance-copy-evidence.json');
  if (stage === 'copy') {
    if (fs.existsSync(configPath)) throw new Error('Clone target must be empty');
    const source = '/snapshot-input';
    const entries = fs.readdirSync(source, { withFileTypes: true });
    // Copy only the database, its WAL companions, and config. Never follow links
    // or import unrelated keys/environment files from the protected snapshot.
    const names = ['config.json', 'database.sqlite', 'database.sqlite-wal', 'database.sqlite-shm'];
    if (entries.some((entry) => entry.name === 'database.restore-pending.sqlite'))
      throw new Error('Snapshot has a pending restore');
    const signatures: Record<string, string> = {};
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry && (name === 'config.json' || name === 'database.sqlite')) throw new Error('Snapshot is incomplete');
      if (!entry) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Snapshot entry must be a regular file');
      signatures[name] = checksum(path.join(source, name));
      fs.copyFileSync(path.join(source, name), path.join(dataDir, name));
      fs.chmodSync(path.join(dataDir, name), 0o600);
    }
    for (const [name, before] of Object.entries(signatures)) {
      if (before !== checksum(path.join(source, name)) || before !== checksum(path.join(dataDir, name)))
        throw new Error('Snapshot changed while copying');
    }
    for (const name of names) {
      if (fs.existsSync(path.join(source, name)) !== Object.hasOwn(signatures, name)) {
        throw new Error('Snapshot file set changed while copying');
      }
    }
    const { decryptConfigDocument } = await import('../dist/secret-storage.js');
    const rawConfig = decryptConfigDocument(JSON.parse(fs.readFileSync(configPath, 'utf8'))) as Record<string, unknown>;
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        identity: captureConfigIdentity(rawConfig),
        database: captureDatabase(databasePath),
      }),
      { mode: 0o600 },
    );
  } else {
    const expected = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const manager = await import('../dist/config-manager.js');
    const database = await import('../dist/db.js');
    const migrations = await import('../dist/db/migrations/index.js');
    const config = manager.getConfig();
    if (captureConfigIdentity(config, expected.identity.shape).digest !== expected.identity.digest)
      throw new Error('Config identity changed');
    verifyDatabase(databasePath, expected.database);
    if (database.getDatabaseSchemaVersion() !== migrations.DATABASE_MIGRATIONS.at(-1)?.version)
      throw new Error('Incomplete database migration');
    const beforeRead = checksum(configPath);
    manager.getConfig();
    if (checksum(configPath) !== beforeRead) throw new Error('Config migration is not idempotent');
    if (stage === 'migrate') {
      const backup = await import('../dist/backup-service.js');
      const bundle = backup.createBackupBundle('full');
      if (!backup.validateBackupBundle(bundle).report.valid) throw new Error('Backup validation failed');
      expected.migratedConfigHash = beforeRead;
      expected.migratedDatabase = captureDatabase(databasePath);
      fs.writeFileSync(evidencePath, JSON.stringify(expected), { mode: 0o600 });
    } else {
      if (beforeRead !== expected.migratedConfigHash) throw new Error('Restart changed config');
      verifyDatabase(databasePath, expected.migratedDatabase);
    }
  }
  safeLog(`Protected copied-volume ${stage} passed; identity and row values withheld.`);
}

await main().catch(() => {
  // Do not expose raw provider data, credentials, database rows or secret paths
  // through assertion diffs, imported-module logs, or exception causes.
  safeError(
    'Protected copied-volume verification failed; no snapshot data was logged. Inspect the isolated snapshot through a protected session.',
  );
  process.exitCode = 1;
});
