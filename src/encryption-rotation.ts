import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import {
  configSecretFingerprint,
  decryptConfigDocument,
  decryptValue,
  encryptConfigDocument,
  encryptValue,
  isEncryptedValue,
  parseEncryptionKey,
} from './secret-storage.js';
import { openSqliteFile, sqliteTableExists, withSqliteFile } from './sqlite-file.js';
import {
  ACTIVE_CONFIG_FILE,
  DB_PATH,
  OWNER_ONLY_FILE_MODE,
  enforceOwnerOnlyFileMode,
} from './storage-paths.js';

export interface EncryptionRotationResult {
  backupPath: string;
  keyFingerprint: string;
  rotatedIngestionSecrets: number;
}

interface RotatedIngestionSecret {
  id: string;
  plaintext: string;
  reEncrypted: string;
}

const INGESTION_TABLE = 'ingestion_credentials';

function ingestionSecretContext(credentialId: string): string {
  return `ingestion-credential:${credentialId}`;
}

function equalsExactly(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function readIngestionSecrets(
  databasePath: string,
  oldKey: Buffer | undefined,
  newKey: Buffer,
): RotatedIngestionSecret[] {
  if (!fs.existsSync(databasePath)) return [];
  return withSqliteFile(databasePath, (handle) => {
    if (!sqliteTableExists(handle, INGESTION_TABLE)) return [];
    const rows = handle
      .prepare(
        `SELECT id, hmac_secret_encrypted FROM ${INGESTION_TABLE} WHERE hmac_secret_encrypted IS NOT NULL`,
      )
      .all() as Array<{ id?: unknown; hmac_secret_encrypted?: unknown }>;
    return rows.map((row) => {
      const id = String(row.id);
      const stored = JSON.parse(String(row.hmac_secret_encrypted)) as unknown;
      if (!isEncryptedValue(stored)) {
        throw new Error(`Stored ingestion secret for credential ${id} is not in the expected encrypted form.`);
      }
      if (!oldKey) {
        throw new Error(
          'Stored ingestion secrets are encrypted, so the current key must be supplied before rotating.',
        );
      }
      const plaintext = decryptValue(stored, ingestionSecretContext(id), oldKey);
      return {
        id,
        plaintext,
        reEncrypted: JSON.stringify(encryptValue(plaintext, ingestionSecretContext(id), newKey)),
      };
    });
  });
}

/**
 * Re-keys every secret this installation holds. Configuration secrets live in
 * the JSON document while ingestion HMAC secrets live in SQLite, and rotating
 * only the former silently breaks signed ingestion. The SQLite transaction
 * stays open until the replacement config has been written and verified, so a
 * failure on either side leaves both stores on the previous key.
 */
export function rotateEncryptionKey(options: {
  newRawKey: string;
  oldRawKey?: string;
  configPath?: string;
  databasePath?: string;
}): EncryptionRotationResult {
  const configPath = options.configPath ?? ACTIVE_CONFIG_FILE;
  const databasePath = options.databasePath ?? DB_PATH;
  const newKey = parseEncryptionKey(options.newRawKey);
  if (!newKey) throw new Error('A new encryption key is required.');
  const oldKey = parseEncryptionKey(options.oldRawKey);

  const raw = fs.readFileSync(configPath, 'utf8');
  const plaintextConfig = decryptConfigDocument(JSON.parse(raw) as unknown, options.oldRawKey);
  const serialized = `${JSON.stringify(encryptConfigDocument(plaintextConfig, options.newRawKey), null, 2)}\n`;
  const ingestionSecrets = readIngestionSecrets(databasePath, oldKey, newKey);

  const backupPath = `${configPath}.encryption-${Date.now()}.bak`;
  fs.copyFileSync(configPath, backupPath);
  enforceOwnerOnlyFileMode(backupPath);

  const temporaryPath = `${configPath}.encryption.tmp`;
  const handle = ingestionSecrets.length > 0 ? openSqliteFile(databasePath) : undefined;
  let committed = false;
  try {
    if (handle) {
      handle.exec('BEGIN IMMEDIATE');
      const update = handle.prepare(`UPDATE ${INGESTION_TABLE} SET hmac_secret_encrypted = ? WHERE id = ?`);
      for (const secret of ingestionSecrets) {
        update.run(secret.reEncrypted, secret.id);
      }
      const verify = handle.prepare(`SELECT hmac_secret_encrypted FROM ${INGESTION_TABLE} WHERE id = ?`);
      for (const secret of ingestionSecrets) {
        const row = verify.get(secret.id) as { hmac_secret_encrypted?: unknown } | undefined;
        const stored = JSON.parse(String(row?.hmac_secret_encrypted)) as unknown;
        if (!isEncryptedValue(stored)) {
          throw new Error(`Rotated ingestion secret for credential ${secret.id} could not be read back.`);
        }
        const roundTrip = decryptValue(stored, ingestionSecretContext(secret.id), newKey);
        if (!equalsExactly(secret.plaintext, roundTrip)) {
          throw new Error(`Rotated ingestion secret for credential ${secret.id} failed verification.`);
        }
      }
    }

    fs.rmSync(temporaryPath, { force: true });
    fs.writeFileSync(temporaryPath, serialized, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
    enforceOwnerOnlyFileMode(temporaryPath);
    const verification = JSON.parse(fs.readFileSync(temporaryPath, 'utf8')) as unknown;
    const roundTrip = decryptConfigDocument(verification, options.newRawKey);
    if (!equalsExactly(JSON.stringify(plaintextConfig), JSON.stringify(roundTrip))) {
      throw new Error('Encryption verification failed.');
    }
    fs.renameSync(temporaryPath, configPath);
    enforceOwnerOnlyFileMode(configPath);

    if (handle) {
      try {
        handle.exec('COMMIT');
      } catch (error) {
        // The replacement config is already in place, so restore the previous
        // document to keep both stores on the same key.
        fs.copyFileSync(backupPath, configPath);
        enforceOwnerOnlyFileMode(configPath);
        throw error;
      }
    }
    committed = true;
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true, recursive: true });
    } catch {
      // Cleanup must never replace the failure the caller needs to see.
    }
    if (handle && !committed) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        // A failed BEGIN leaves nothing to roll back.
      }
    }
    throw error;
  } finally {
    handle?.close();
  }

  return {
    backupPath,
    keyFingerprint: configSecretFingerprint(newKey),
    rotatedIngestionSecrets: ingestionSecrets.length,
  };
}
