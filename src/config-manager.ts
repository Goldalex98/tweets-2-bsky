import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createDefaultMappingPolicies, getDefaultConfig } from './config/defaults.js';
import { migrateConfig, migrateConfigWithMetadata } from './config/migrations.js';
import { assertValidAppConfig, isConfigRecord, normalizeConfigV3 } from './config/normalize.js';
import { applyMappingProjection, toCanonicalConfig } from './config/projection.js';
import type { AccountMapping, AppConfig, TwitterConfig } from './config/schemas.js';
import { decryptConfigDocument, encryptConfigDocument } from './secret-storage.js';
import {
  ACTIVE_CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  OWNER_ONLY_FILE_MODE,
  USING_EXTERNAL_DATA_DIR,
  enforceOwnerOnlyFileMode,
} from './storage-paths.js';

export * from './config/defaults.js';
export * from './config/migrations.js';
export * from './config/normalize.js';
export * from './config/projection.js';
export * from './config/schemas.js';
export * from './config/transfer.js';

export interface ConfigVersion {
  revision: number;
  updatedAt: string;
}

export function getConfigVersion(config: AppConfig): ConfigVersion {
  return { revision: config.revision, updatedAt: config.updatedAt };
}

export function hasConfigVersionConflict(
  config: AppConfig,
  candidate: { revision?: unknown; updatedAt?: unknown } | null | undefined,
): boolean {
  if (!candidate) return false;
  if (candidate.revision !== undefined && Number(candidate.revision) !== config.revision) return true;
  return candidate.updatedAt !== undefined && candidate.updatedAt !== config.updatedAt;
}

export const CONFIG_REVISION_CONFLICT_CODE = 'CONFIG_REVISION_CONFLICT';

/**
 * Raised when the persisted revision moved after the caller read the config.
 * The caller's write is rejected instead of silently overwriting the newer
 * document.
 */
export class ConfigRevisionConflictError extends Error {
  readonly code = CONFIG_REVISION_CONFLICT_CODE;

  constructor(
    readonly current: ConfigVersion,
    readonly expectedRevision: number,
  ) {
    super(`Configuration revision ${expectedRevision} is stale; the stored revision is ${current.revision}.`);
    this.name = 'ConfigRevisionConflictError';
  }
}

export function isConfigRevisionConflictError(error: unknown): error is ConfigRevisionConflictError {
  return error instanceof ConfigRevisionConflictError;
}

const CONFIG_FILE = ACTIVE_CONFIG_FILE;
const CONFIG_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.bak`;
const CONFIG_TMP_FILE = `${ACTIVE_CONFIG_FILE}.tmp`;
export const CONFIG_PRE_V2_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v2-backup`;
export const CONFIG_PRE_V3_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v3-backup`;
export const CONFIG_PRE_V4_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v4-backup`;
export const CONFIG_PRE_V5_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v5-backup`;
export const CONFIG_PRE_V6_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v6-backup`;
export const CONFIG_PRE_V7_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v7-backup`;
export const CONFIG_PRE_V8_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.pre-v8-backup`;

let configPathInitialized = false;
let configWriteBlockedReason: string | undefined;
let configPathUnavailable = false;

function removeTemporaryConfigFile(): void {
  try {
    if (fs.existsSync(CONFIG_TMP_FILE)) {
      fs.rmSync(CONFIG_TMP_FILE, { force: true });
    }
  } catch {
    // A later atomic write will report a useful error if the stale file
    // cannot be replaced.
  }
}

function ensureConfigPathReady(): void {
  if (configPathInitialized) {
    return;
  }
  configPathInitialized = true;

  if (!USING_EXTERNAL_DATA_DIR || fs.existsSync(CONFIG_FILE) || !fs.existsSync(LEGACY_CONFIG_FILE)) {
    return;
  }

  try {
    removeTemporaryConfigFile();
    fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_TMP_FILE);
    fs.renameSync(CONFIG_TMP_FILE, CONFIG_FILE);
    console.log(`📦 Migrated config from ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}.`);
  } catch (error) {
    removeTemporaryConfigFile();
    configPathUnavailable = true;
    configWriteBlockedReason =
      'The legacy config could not be copied to the configured data directory; writes are disabled.';
    console.warn(
      `⚠️ Failed to migrate legacy config from ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}: ${(error as Error).message}`,
    );
  }
}

function serializeConfig(config: AppConfig): string {
  return `${JSON.stringify(encryptConfigDocument(toCanonicalConfig(config)), null, 2)}\n`;
}

function writeConfigFile(config: AppConfig, options: { refreshBackup?: boolean } = {}): void {
  assertValidAppConfig(config);
  const serialized = serializeConfig(config);
  removeTemporaryConfigFile();
  fs.writeFileSync(CONFIG_TMP_FILE, serialized, { mode: OWNER_ONLY_FILE_MODE });
  enforceOwnerOnlyFileMode(CONFIG_TMP_FILE);

  try {
    if (options.refreshBackup !== false && fs.existsSync(CONFIG_FILE)) {
      try {
        fs.copyFileSync(CONFIG_FILE, CONFIG_BACKUP_FILE);
        enforceOwnerOnlyFileMode(CONFIG_BACKUP_FILE);
      } catch (error) {
        console.warn(`⚠️ Failed to refresh config backup: ${(error as Error).message}`);
      }
    }
    fs.renameSync(CONFIG_TMP_FILE, CONFIG_FILE);
    enforceOwnerOnlyFileMode(CONFIG_FILE);
  } catch (error) {
    removeTemporaryConfigFile();
    throw error;
  }
}

function writeMigrationBackup(filePath: string, rawText: string, label: string): void {
  if (fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, rawText, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
    enforceOwnerOnlyFileMode(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Could not create ${label} config backup: ${(error as Error).message}`);
    }
  }
}

function ensurePreV2Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V2_BACKUP_FILE, rawText, 'pre-v2');
}

function ensurePreV3Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V3_BACKUP_FILE, rawText, 'pre-v3');
}

function ensurePreV4Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V4_BACKUP_FILE, rawText, 'pre-v4');
}

function ensurePreV5Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V5_BACKUP_FILE, rawText, 'pre-v5');
}

function ensurePreV6Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V6_BACKUP_FILE, rawText, 'pre-v6');
}

function ensurePreV7Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V7_BACKUP_FILE, rawText, 'pre-v7');
}

function ensurePreV8Backup(rawText: string): void {
  writeMigrationBackup(CONFIG_PRE_V8_BACKUP_FILE, rawText, 'pre-v8');
}

function loadConfigText(rawText: string): ReturnType<typeof migrateConfigWithMetadata> {
  const parsed = decryptConfigDocument(JSON.parse(rawText));
  return migrateConfigWithMetadata(parsed);
}

function recoverConfigFromBackup(): AppConfig | undefined {
  if (!fs.existsSync(CONFIG_BACKUP_FILE)) {
    return undefined;
  }

  try {
    const backupText = fs.readFileSync(CONFIG_BACKUP_FILE, 'utf8');
    const result = loadConfigText(backupText);
    if (result.migrated) {
      if (result.fromVersion < 8) ensurePreV8Backup(backupText);
      if (result.fromVersion < 7) ensurePreV7Backup(backupText);
      if (result.fromVersion < 6) ensurePreV6Backup(backupText);
      if (result.fromVersion < 5) ensurePreV5Backup(backupText);
      if (result.fromVersion < 4) ensurePreV4Backup(backupText);
      ensurePreV3Backup(backupText);
      if (result.fromVersion < 2) {
        ensurePreV2Backup(backupText);
      }
    }
    // Never refresh .bak while restoring from it: the main file may be
    // corrupt and must not replace the known-good backup.
    writeConfigFile(result.config, { refreshBackup: false });
    configWriteBlockedReason = undefined;
    console.warn(`♻️ Recovered config from backup: ${CONFIG_BACKUP_FILE}`);
    return result.config;
  } catch (error) {
    console.error(`Error reading config backup: ${(error as Error).message}`);
    return undefined;
  }
}

function blockConfigWrites(message: string): AppConfig {
  configWriteBlockedReason = message;
  console.error(`🛑 ${message} Refusing to overwrite ${CONFIG_FILE}; repair or remove the invalid file before saving.`);
  return getDefaultConfig();
}

// Public compatibility entry point retained for callers that normalized
// legacy values through config-manager before schema versioning.
export function normalizeConfig(rawConfig: unknown): AppConfig {
  return isConfigRecord(rawConfig) ? migrateConfig(rawConfig) : getDefaultConfig();
}

export function getConfig(): AppConfig {
  ensureConfigPathReady();

  if (!fs.existsSync(CONFIG_FILE)) {
    if (!configPathUnavailable) {
      configWriteBlockedReason = undefined;
    }
    return getDefaultConfig();
  }

  let rawText: string;
  try {
    rawText = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    console.error(`Error reading config: ${(error as Error).message}`);
    return (
      recoverConfigFromBackup() ?? blockConfigWrites('config.json is unreadable and no valid backup could be restored.')
    );
  }

  let parsed: unknown;
  try {
    parsed = decryptConfigDocument(JSON.parse(rawText));
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Encrypted configuration field') ||
        error.message.includes('Could not decrypt protected configuration field'))
    ) {
      configWriteBlockedReason = error.message;
      throw error;
    }
    console.error(`Error parsing config: ${(error as Error).message}`);
    return (
      recoverConfigFromBackup() ?? blockConfigWrites('config.json is unreadable and no valid backup could be restored.')
    );
  }

  let result: ReturnType<typeof migrateConfigWithMetadata>;
  try {
    result = migrateConfigWithMetadata(parsed);
  } catch (error) {
    return blockConfigWrites(`Configuration validation or migration failed: ${(error as Error).message}`);
  }

  if (JSON.stringify(parsed) !== JSON.stringify(toCanonicalConfig(result.config))) {
    try {
      if (result.migrated) {
        if (result.fromVersion < 8) ensurePreV8Backup(rawText);
        if (result.fromVersion < 7) ensurePreV7Backup(rawText);
        if (result.fromVersion < 6) ensurePreV6Backup(rawText);
        if (result.fromVersion < 5) ensurePreV5Backup(rawText);
        if (result.fromVersion < 4) ensurePreV4Backup(rawText);
        ensurePreV3Backup(rawText);
        if (result.fromVersion < 2) {
          ensurePreV2Backup(rawText);
        }
      }
      writeConfigFile(result.config);
      if (result.migrated) {
        console.log(`📦 Upgraded config schema from v${result.fromVersion} to v${result.toVersion}.`);
      }
    } catch (error) {
      configWriteBlockedReason = `Configuration migration could not be written: ${(error as Error).message}`;
      console.error(`🛑 ${configWriteBlockedReason}`);
      // The validated in-memory value is safe to run, while the original file
      // remains untouched and future writes stay blocked.
      return result.config;
    }
  }

  configWriteBlockedReason = undefined;
  return result.config;
}

/**
 * Reads only the concurrency metadata from the stored document. Secrets stay
 * encrypted because revision and updatedAt are never protected fields.
 */
export function readPersistedConfigVersion(): ConfigVersion | undefined {
  if (!fs.existsSync(CONFIG_FILE)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as unknown;
    if (!isConfigRecord(parsed)) return undefined;
    const revision =
      Number.isSafeInteger(parsed.revision) && Number(parsed.revision) >= 0 ? Number(parsed.revision) : 0;
    const updatedAt =
      typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : new Date(0).toISOString();
    return { revision, updatedAt };
  } catch {
    return undefined;
  }
}

/**
 * Compare-and-swap guard for the persisted document. The read, comparison, and
 * atomic rename all happen synchronously, so no other mutation in this process
 * can interleave between them; a caller holding a stale snapshot is rejected
 * rather than silently discarding the newer revision.
 */
function persistWithRevisionSwap(config: AppConfig, canonical: ReturnType<typeof toCanonicalConfig>): void {
  const persisted = readPersistedConfigVersion();
  if (persisted && persisted.revision !== config.revision) {
    throw new ConfigRevisionConflictError(persisted, config.revision);
  }
  const normalizedConfig = normalizeConfigV3({
    ...canonical,
    revision: Math.max(persisted?.revision ?? 0, config.revision) + 1,
    updatedAt: new Date().toISOString(),
  });
  assertValidAppConfig(normalizedConfig);
  writeConfigFile(normalizedConfig);
  config.revision = normalizedConfig.revision;
  config.updatedAt = normalizedConfig.updatedAt;
  configWriteBlockedReason = undefined;
}

export function saveConfig(config: AppConfig): void {
  ensureConfigPathReady();

  if (configWriteBlockedReason && (configPathUnavailable || fs.existsSync(CONFIG_FILE))) {
    throw new Error(`Refusing to save config: ${configWriteBlockedReason}`);
  }

  const projected = applyMappingProjection(config, config.mappings);
  persistWithRevisionSwap(config, toCanonicalConfig(projected));
}

export function saveCanonicalConfig(config: AppConfig): void {
  ensureConfigPathReady();
  if (configWriteBlockedReason && (configPathUnavailable || fs.existsSync(CONFIG_FILE))) {
    throw new Error(`Refusing to save config: ${configWriteBlockedReason}`);
  }
  persistWithRevisionSwap(config, toCanonicalConfig(config));
}

type MappingPolicyFields =
  | 'postingPolicy'
  | 'profileManagement'
  | 'aiOverrides'
  | 'moderationPolicy'
  | 'duplicateSuppression';
export type NewAccountMapping = Omit<AccountMapping, 'id' | 'enabled' | MappingPolicyFields> &
  Partial<Pick<AccountMapping, MappingPolicyFields>>;

export function addMapping(mapping: NewAccountMapping): void {
  const config = getConfig();
  const defaultPolicies = createDefaultMappingPolicies(
    mapping.twitterUsernames.length,
    mapping.profileSyncSourceUsername,
  );
  const newMapping: AccountMapping = {
    ...mapping,
    id: randomUUID(),
    enabled: true,
    postingPolicy: mapping.postingPolicy ?? defaultPolicies.postingPolicy,
    aiOverrides: mapping.aiOverrides ?? defaultPolicies.aiOverrides,
    moderationPolicy: mapping.moderationPolicy ?? defaultPolicies.moderationPolicy,
    duplicateSuppression: mapping.duplicateSuppression ?? defaultPolicies.duplicateSuppression,
    profileManagement: mapping.profileManagement ?? defaultPolicies.profileManagement,
  };
  config.mappings.push(newMapping);
  saveConfig(config);
}

export function removeMapping(id: string): void {
  const config = getConfig();
  config.mappings = config.mappings.filter((mapping) => mapping.id !== id);
  saveConfig(config);
}

export function updateTwitterConfig(twitter: TwitterConfig): void {
  const config = getConfig();
  config.twitter = twitter;
  saveConfig(config);
}
