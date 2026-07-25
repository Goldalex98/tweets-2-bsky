import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConfigExport,
  getConfig,
  migrateConfig,
  mergeImportedConfig,
  assertValidAppConfig,
  saveCanonicalConfig,
  toCanonicalConfig,
} from './config-manager.js';
import { CURRENT_CONFIG_SCHEMA_VERSION } from './config/schemas.js';
import {
  createConsistentDatabaseSnapshot,
  getDatabaseSchemaVersion,
  validateDatabaseSnapshot,
} from './db.js';
import { decryptConfigDocument, encryptConfigDocument, getEncryptionStatus } from './secret-storage.js';
import { sqliteTableExists, withSqliteFile } from './sqlite-file.js';
import {
  ACTIVE_CONFIG_FILE,
  BACKUP_DIR,
  DATA_DIR,
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  PENDING_DB_RESTORE_PATH,
  enforceOwnerOnlyFileMode,
} from './storage-paths.js';
import type { AppConfig } from './config/schemas.js';

export const BACKUP_FORMAT = 'tweets-2-bsky-backup/v1';
export const DEFAULT_MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const SQLITE_HEADER = 'SQLite format 3\0';

export type BackupMode = 'redacted' | 'full';

interface BundleFile {
  path: 'config.json' | 'database.sqlite' | 'metadata.json';
  encoding: 'base64';
  size: number;
  sha256: string;
  data: string;
}

export interface BackupMetadata {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  appVersion: string;
  configSchemaVersion: number;
  databaseSchemaVersion: number;
  mode: BackupMode;
  encryptionRequired: boolean;
  encryptionKeyFingerprint?: string;
}

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  files: BundleFile[];
}

export interface RestoreReport {
  valid: true;
  mode: BackupMode;
  appVersion: string;
  configSchemaVersion: number;
  databaseSchemaVersion: number;
  encryptionRequired: boolean;
  databaseBytes: number;
  configBytes: number;
  preservesCurrentUsersAndSecrets: boolean;
  databaseWillApplyOnRestart: boolean;
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeFile(filePath: BundleFile['path'], value: Buffer): BundleFile {
  return {
    path: filePath,
    encoding: 'base64',
    size: value.length,
    sha256: hash(value),
    data: value.toString('base64'),
  };
}

function readAppVersion(): string {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureBackupDirectory(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
}

export function createBackupBundle(mode: BackupMode): Buffer {
  ensureBackupDirectory();
  const temporaryDatabase = path.join(BACKUP_DIR, `.snapshot-${randomUUID()}.sqlite`);
  try {
    createConsistentDatabaseSnapshot(temporaryDatabase);
    enforceOwnerOnlyFileMode(temporaryDatabase);
    const config = getConfig();
    const status = getEncryptionStatus();
    const configDocument =
      mode === 'redacted'
        ? createConfigExport(config, 'redacted')
        : encryptConfigDocument(toCanonicalConfig(config));
    const configBytes = Buffer.from(`${JSON.stringify(configDocument, null, 2)}\n`);
    const databaseBytes = fs.readFileSync(temporaryDatabase);
    const metadata: BackupMetadata = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      appVersion: readAppVersion(),
      configSchemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      databaseSchemaVersion: getDatabaseSchemaVersion(),
      mode,
      encryptionRequired: mode === 'full' && status.enabled,
      ...(mode === 'full' && status.keyFingerprint
        ? { encryptionKeyFingerprint: status.keyFingerprint }
        : {}),
    };
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
    const bundle: BackupBundle = {
      format: BACKUP_FORMAT,
      files: [
        makeFile('config.json', configBytes),
        makeFile('database.sqlite', databaseBytes),
        makeFile('metadata.json', metadataBytes),
      ],
    };
    return Buffer.from(JSON.stringify(bundle));
  } finally {
    fs.rmSync(temporaryDatabase, { force: true });
  }
}

function safeBundlePath(value: unknown): value is BundleFile['path'] {
  if (typeof value !== 'string' || value.includes('..') || value.includes('\\') || value.startsWith('/')) {
    return false;
  }
  return value === 'config.json' || value === 'database.sqlite' || value === 'metadata.json';
}

function assertBundleMetadataIsApplicable(metadata: BackupMetadata): void {
  if (metadata.format !== BACKUP_FORMAT) {
    throw new Error('Backup metadata does not identify a supported bundle format.');
  }
  if (metadata.mode !== 'redacted' && metadata.mode !== 'full') {
    throw new Error('Backup metadata declares an unknown mode.');
  }
  if (typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) {
    throw new Error('Backup metadata is missing a valid creation timestamp.');
  }
  if (metadata.configSchemaVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error('Backup config schema is newer than this installation supports.');
  }
  if (metadata.databaseSchemaVersion > getDatabaseSchemaVersion()) {
    throw new Error('Backup database schema is newer than this installation supports.');
  }
  const status = getEncryptionStatus();
  if (metadata.encryptionRequired && !status.enabled) {
    throw new Error('This backup contains encrypted secrets; set CONFIG_ENCRYPTION_KEY before restoring.');
  }
  if (
    metadata.encryptionKeyFingerprint &&
    status.keyFingerprint &&
    metadata.encryptionKeyFingerprint !== status.keyFingerprint
  ) {
    throw new Error('This backup was encrypted with a different key than the configured one.');
  }
}

export function validateBackupBundle(
  input: Buffer | string,
  maxBytes = DEFAULT_MAX_BACKUP_BYTES,
): {
  report: RestoreReport;
  config: unknown;
  appliedConfig: AppConfig;
  database: Buffer;
  metadata: BackupMetadata;
} {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('Backup is empty or exceeds the configured size limit.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Backup bundle is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid backup structure.');
  const bundle = parsed as Partial<BackupBundle>;
  if (bundle.format !== BACKUP_FORMAT || !Array.isArray(bundle.files) || bundle.files.length !== 3) {
    throw new Error('Unsupported or incomplete backup bundle.');
  }
  const decoded = new Map<BundleFile['path'], Buffer>();
  for (const candidate of bundle.files) {
    if (
      !candidate ||
      !safeBundlePath(candidate.path) ||
      candidate.encoding !== 'base64' ||
      typeof candidate.data !== 'string' ||
      typeof candidate.sha256 !== 'string' ||
      typeof candidate.size !== 'number' ||
      decoded.has(candidate.path)
    ) {
      throw new Error('Backup contains an invalid, duplicate, or unsafe file entry.');
    }
    const value = Buffer.from(candidate.data, 'base64');
    if (value.length !== candidate.size || value.length > maxBytes || hash(value) !== candidate.sha256) {
      throw new Error(`Backup checksum or size validation failed for ${candidate.path}.`);
    }
    decoded.set(candidate.path, value);
  }
  const configBytes = decoded.get('config.json');
  const database = decoded.get('database.sqlite');
  const metadataBytes = decoded.get('metadata.json');
  if (!configBytes || !database || !metadataBytes) throw new Error('Backup is missing required files.');
  if (database.subarray(0, SQLITE_HEADER.length).toString('binary') !== SQLITE_HEADER) {
    throw new Error('Backup database is not a valid SQLite file.');
  }
  const metadata = JSON.parse(metadataBytes.toString('utf8')) as BackupMetadata;
  if (
    metadata.format !== BACKUP_FORMAT ||
    (metadata.mode !== 'redacted' && metadata.mode !== 'full') ||
    !Number.isInteger(metadata.configSchemaVersion) ||
    metadata.configSchemaVersion > CURRENT_CONFIG_SCHEMA_VERSION ||
    !Number.isInteger(metadata.databaseSchemaVersion) ||
    metadata.databaseSchemaVersion > getDatabaseSchemaVersion()
  ) {
    throw new Error('Backup schema version is unsupported.');
  }
  assertBundleMetadataIsApplicable(metadata);
  ensureBackupDirectory();
  const validationDatabasePath = path.join(BACKUP_DIR, `.validate-${randomUUID()}.sqlite`);
  let actualDatabaseSchemaVersion: number;
  try {
    fs.writeFileSync(validationDatabasePath, database, { flag: 'wx', mode: 0o600 });
    actualDatabaseSchemaVersion = validateDatabaseSnapshot(validationDatabasePath);
  } finally {
    fs.rmSync(validationDatabasePath, { force: true });
  }
  if (actualDatabaseSchemaVersion !== metadata.databaseSchemaVersion) {
    throw new Error('Backup database schema does not match its authenticated metadata.');
  }
  const configStored = JSON.parse(configBytes.toString('utf8')) as unknown;
  const config = decryptConfigDocument(configStored);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Backup config is invalid.');
  const validatedConfig =
    metadata.mode === 'redacted' ? mergeImportedConfig(getConfig(), config) : migrateConfig(config);
  assertValidAppConfig(validatedConfig);
  return {
    report: {
      valid: true,
      mode: metadata.mode,
      appVersion: metadata.appVersion,
      configSchemaVersion: metadata.configSchemaVersion,
      databaseSchemaVersion: metadata.databaseSchemaVersion,
      encryptionRequired: metadata.encryptionRequired,
      databaseBytes: database.length,
      configBytes: configBytes.length,
      preservesCurrentUsersAndSecrets: metadata.mode === 'redacted',
      databaseWillApplyOnRestart: true,
    },
    config,
    appliedConfig: validatedConfig,
    database,
    metadata,
  };
}

/**
 * A restored bundle carries whatever ingestion credentials existed when it was
 * created, including ones revoked afterwards. Every credential in the staged
 * database is revoked so a restore can never resurrect a retired token; new
 * credentials must be minted after the restart.
 */
export function revokeStagedIngestionCredentials(databasePath: string, now = Date.now()): number {
  const revoked = withSqliteFile(databasePath, (handle) => {
    // Keep every change inside the main database file so the staged snapshot
    // stays self-contained when it is renamed into place.
    handle.exec('PRAGMA journal_mode = DELETE;');
    if (!sqliteTableExists(handle, 'ingestion_credentials')) return 0;
    const pending = handle
      .prepare('SELECT COUNT(*) AS count FROM ingestion_credentials WHERE revoked_at IS NULL')
      .get() as { count?: number } | undefined;
    const count = Number(pending?.count) || 0;
    if (count > 0) {
      handle.prepare('UPDATE ingestion_credentials SET revoked_at = ? WHERE revoked_at IS NULL').run(now);
    }
    if (sqliteTableExists(handle, 'ingestion_nonces')) {
      handle.exec('DELETE FROM ingestion_nonces');
    }
    return count;
  });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
  return revoked;
}

function revokeIssuedSessions(config: AppConfig): AppConfig {
  const now = new Date().toISOString();
  return {
    ...config,
    users: config.users.map((user) => ({
      ...user,
      tokenVersion: user.tokenVersion + 1,
      updatedAt: now,
    })),
  };
}

export function applyRestoreBundle(
  input: Buffer | string,
  options: { confirmation: string; maxBytes?: number },
): RestoreReport & {
  preRestoreBackup: string;
  pendingDatabase: string;
  revokedIngestionCredentials: number;
  sessionsRevoked: boolean;
} {
  if (options.confirmation !== 'RESTORE') throw new Error('Typed confirmation RESTORE is required.');
  const validated = validateBackupBundle(input, options.maxBytes);
  assertBundleMetadataIsApplicable(validated.metadata);
  const current = getConfig();
  // Always apply the validated and migrated document. The raw decrypted bundle
  // has not been through schema validation or migration.
  const nextConfig = revokeIssuedSessions({
    ...validated.appliedConfig,
    revision: current.revision,
    updatedAt: current.updatedAt,
  });
  ensureBackupDirectory();
  const preRestoreBackup = path.join(BACKUP_DIR, `pre-restore-${Date.now()}.t2b-backup`);
  fs.writeFileSync(preRestoreBackup, createBackupBundle('full'), { mode: OWNER_ONLY_FILE_MODE });
  enforceOwnerOnlyFileMode(preRestoreBackup);
  const pendingTemporary = `${PENDING_DB_RESTORE_PATH}.tmp`;
  let revokedIngestionCredentials = 0;
  try {
    fs.writeFileSync(pendingTemporary, validated.database, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
    enforceOwnerOnlyFileMode(pendingTemporary);
    revokedIngestionCredentials = revokeStagedIngestionCredentials(pendingTemporary);
    fs.renameSync(pendingTemporary, PENDING_DB_RESTORE_PATH);
    saveCanonicalConfig(nextConfig);
  } catch (error) {
    // Cleanup must never mask the failure that triggered it; a locked handle on
    // Windows can leave the staged file behind and that is recoverable.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(`${pendingTemporary}${suffix}`, { force: true });
        fs.rmSync(`${PENDING_DB_RESTORE_PATH}${suffix}`, { force: true });
      } catch {
        // Ignored: the staged restore is abandoned either way.
      }
    }
    throw error;
  }
  return {
    ...validated.report,
    preRestoreBackup,
    pendingDatabase: PENDING_DB_RESTORE_PATH,
    revokedIngestionCredentials,
    sessionsRevoked: true,
  };
}

export function getBackupStorageStatus() {
  return {
    dataDirectory: DATA_DIR,
    configFile: ACTIVE_CONFIG_FILE,
    backupDirectory: BACKUP_DIR,
    pendingDatabaseRestore: fs.existsSync(PENDING_DB_RESTORE_PATH),
    encryption: getEncryptionStatus(),
  };
}
