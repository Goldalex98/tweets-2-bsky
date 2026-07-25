import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rotateEncryptionKey } from '../../src/encryption-rotation.js';
import {
  decryptConfigDocument,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  parseEncryptionKey,
} from '../../src/secret-storage.js';
import { withSqliteFile } from '../../src/sqlite-file.js';

const KEY = '11'.repeat(32);
const NEXT_KEY = '22'.repeat(32);
const CREDENTIAL_ID = 'credential-1';
const HMAC_SECRET = 'ingestion-hmac-secret';

let directory = '';
let configPath = '';
let databasePath = '';

function readStoredIngestionSecret(rawKey: string): string {
  const key = parseEncryptionKey(rawKey);
  if (!key) throw new Error('test key is required');
  return withSqliteFile(databasePath, (handle) => {
    const row = handle
      .prepare('SELECT hmac_secret_encrypted FROM ingestion_credentials WHERE id = ?')
      .get(CREDENTIAL_ID) as { hmac_secret_encrypted?: string } | undefined;
    const stored = JSON.parse(String(row?.hmac_secret_encrypted)) as unknown;
    if (!isEncryptedValue(stored)) throw new Error('stored ingestion secret is not encrypted');
    return decryptValue(stored, `ingestion-credential:${CREDENTIAL_ID}`, key);
  });
}

function seedDatabase(rawKey: string): void {
  const key = parseEncryptionKey(rawKey);
  if (!key) throw new Error('test key is required');
  withSqliteFile(databasePath, (handle) => {
    handle.exec(
      'CREATE TABLE ingestion_credentials (id TEXT PRIMARY KEY, hmac_secret_encrypted TEXT, revoked_at TEXT)',
    );
    handle
      .prepare('INSERT INTO ingestion_credentials (id, hmac_secret_encrypted) VALUES (?, ?)')
      .run(
        CREDENTIAL_ID,
        JSON.stringify(encryptValue(HMAC_SECRET, `ingestion-credential:${CREDENTIAL_ID}`, key)),
      );
  });
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 't2b-rotation-'));
  configPath = path.join(directory, 'config.json');
  databasePath = path.join(directory, 'database.sqlite');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('encryption key rotation', () => {
  test('encrypts a plaintext config, backs it up, and verifies before replacement', () => {
    fs.writeFileSync(configPath, JSON.stringify({ twitter: { authToken: 'secret', ct0: 'csrf' } }));

    const result = rotateEncryptionKey({ newRawKey: KEY, configPath, databasePath });

    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(result.rotatedIngestionSecrets).toBe(0);
    const stored = fs.readFileSync(configPath, 'utf8');
    expect(stored).not.toContain('"secret"');
    expect(decryptConfigDocument(JSON.parse(stored), KEY)).toEqual({
      twitter: { authToken: 'secret', ct0: 'csrf' },
    });
    expect(fs.existsSync(`${configPath}.encryption.tmp`)).toBe(false);
  });

  test('rotation re-keys SQLite ingestion secrets alongside the config document', () => {
    fs.writeFileSync(configPath, JSON.stringify({ twitter: { authToken: 'secret', ct0: 'csrf' } }));
    rotateEncryptionKey({ newRawKey: KEY, configPath, databasePath });
    seedDatabase(KEY);

    const result = rotateEncryptionKey({
      newRawKey: NEXT_KEY,
      oldRawKey: KEY,
      configPath,
      databasePath,
    });

    expect(result.rotatedIngestionSecrets).toBe(1);
    expect(decryptConfigDocument(JSON.parse(fs.readFileSync(configPath, 'utf8')), NEXT_KEY)).toEqual({
      twitter: { authToken: 'secret', ct0: 'csrf' },
    });
    // Ingestion signing keeps working because the SQLite copy moved to the new
    // key in the same operation.
    expect(readStoredIngestionSecret(NEXT_KEY)).toBe(HMAC_SECRET);
    expect(() => readStoredIngestionSecret(KEY)).toThrow('Could not decrypt');
  });

  test('refuses to rotate encrypted ingestion secrets without the current key', () => {
    fs.writeFileSync(configPath, JSON.stringify({ scheduler: { enabled: true } }));
    seedDatabase(KEY);

    expect(() => rotateEncryptionKey({ newRawKey: NEXT_KEY, configPath, databasePath })).toThrow(
      'current key must be supplied',
    );
    expect(readStoredIngestionSecret(KEY)).toBe(HMAC_SECRET);
  });

  test('a config rewrite failure rolls the SQLite secrets back to the old key', () => {
    fs.writeFileSync(configPath, JSON.stringify({ twitter: { authToken: 'secret' } }));
    rotateEncryptionKey({ newRawKey: KEY, configPath, databasePath });
    seedDatabase(KEY);
    const configBefore = fs.readFileSync(configPath, 'utf8');
    // The atomic write cannot claim its temporary path, so the rewrite fails
    // after the SQLite rows were already updated inside the transaction.
    fs.mkdirSync(`${configPath}.encryption.tmp`);

    expect(() =>
      rotateEncryptionKey({ newRawKey: NEXT_KEY, oldRawKey: KEY, configPath, databasePath }),
    ).toThrow();

    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(readStoredIngestionSecret(KEY)).toBe(HMAC_SECRET);
    expect(() => readStoredIngestionSecret(NEXT_KEY)).toThrow('Could not decrypt');
  });
});
