import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(APP_ROOT_DIR, 'data');

function resolveConfiguredDataDir(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  return path.isAbsolute(value) ? value : path.resolve(APP_ROOT_DIR, value);
}

const configuredDataDir = resolveConfiguredDataDir(process.env.TWEETS2BSKY_DATA_DIR || process.env.APP_DATA_DIR);

export const DATA_DIR = configuredDataDir ?? DEFAULT_DATA_DIR;
export const USING_EXTERNAL_DATA_DIR = Boolean(configuredDataDir);

export const LEGACY_CONFIG_FILE = path.join(APP_ROOT_DIR, 'config.json');
export const DATA_CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const ACTIVE_CONFIG_FILE = USING_EXTERNAL_DATA_DIR ? DATA_CONFIG_FILE : LEGACY_CONFIG_FILE;

export const DB_PATH = path.join(DATA_DIR, 'database.sqlite');
export const PENDING_DB_RESTORE_PATH = path.join(DATA_DIR, 'database.restore-pending.sqlite');
export const JWT_SECRET_FILE_PATH = path.join(DATA_DIR, '.jwt-secret');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const UPDATE_LOG_DIR = DATA_DIR;

export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * Restricts a secret-bearing file to its owner. POSIX ACLs have no meaningful
 * Windows equivalent, so the call is skipped there and any other failure is
 * reported without aborting the write that produced the file.
 */
export function enforceOwnerOnlyFileMode(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(filePath, OWNER_ONLY_FILE_MODE);
  } catch (error) {
    console.warn(`⚠️ Could not restrict permissions on ${filePath}: ${(error as Error).message}`);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
