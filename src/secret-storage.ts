import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export const ENCRYPTED_VALUE_MARKER = 'tweets-2-bsky/aes-256-gcm';
const KEY_ENV_NAME = 'CONFIG_ENCRYPTION_KEY';

export interface EncryptedValue {
  __encrypted: typeof ENCRYPTED_VALUE_MARKER;
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface EncryptionStatus {
  enabled: boolean;
  keySource: typeof KEY_ENV_NAME | 'none';
  keyFingerprint?: string;
  plaintextCompatibility: boolean;
}

let plaintextWarningShown = false;

export function parseEncryptionKey(raw = process.env.CONFIG_ENCRYPTION_KEY): Buffer | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  }
  throw new Error(
    'CONFIG_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters or standard base64.',
  );
}

export function getEncryptionStatus(raw = process.env.CONFIG_ENCRYPTION_KEY): EncryptionStatus {
  const key = parseEncryptionKey(raw);
  return key
    ? {
        enabled: true,
        keySource: KEY_ENV_NAME,
        keyFingerprint: configSecretFingerprint(key),
        plaintextCompatibility: false,
      }
    : { enabled: false, keySource: 'none', plaintextCompatibility: true };
}

export function warnIfPlaintextSecrets(): void {
  if (plaintextWarningShown || process.env.NODE_ENV === 'test' || parseEncryptionKey()) return;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY is required when NODE_ENV=production. Set a 32-byte key and migrate before starting.',
    );
  }
  plaintextWarningShown = true;
  console.warn(
    '⚠️ CONFIG_ENCRYPTION_KEY is not set. Configuration secrets remain plaintext for compatibility; set a 32-byte key and run config-encryption-migrate.',
  );
}

/** Fail closed in production when encryption is not configured. */
export function assertProductionEncryptionConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!parseEncryptionKey()) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY is required when NODE_ENV=production. Refusing to start with plaintext secrets.',
    );
  }
}

export function isEncryptedValue(value: unknown): value is EncryptedValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.__encrypted === ENCRYPTED_VALUE_MARKER &&
    record.version === 1 &&
    typeof record.nonce === 'string' &&
    typeof record.ciphertext === 'string' &&
    typeof record.tag === 'string'
  );
}

export function encryptValue(value: string, context: string, key: Buffer): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    __encrypted: ENCRYPTED_VALUE_MARKER,
    version: 1,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptValue(value: EncryptedValue, context: string, key: Buffer): string {
  try {
    const nonce = Buffer.from(value.nonce, 'base64');
    const tag = Buffer.from(value.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid encrypted value encoding');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(`Could not decrypt protected configuration field '${context}'. The key is missing or incorrect, or data was modified.`);
  }
}

function isSecretProperty(path: readonly string[]): boolean {
  const property = path[path.length - 1] ?? '';
  const parent = path[path.length - 2] ?? '';
  if (
    ['authToken', 'ct0', 'backupAuthToken', 'backupCt0', 'bskyPassword', 'appPassword', 'geminiApiKey'].includes(property)
  ) {
    return true;
  }
  if (parent === 'ai' && property === 'apiKey') return true;
  if (parent === 'notifications' && (property === 'webhookUrl' || property === 'webhookSecret')) return true;
  return /(?:apiToken|accessToken|refreshToken|clientSecret)$/i.test(property);
}

function transformSecrets(
  value: unknown,
  key: Buffer | undefined,
  mode: 'encrypt' | 'decrypt',
  path: string[] = [],
): unknown {
  if (isEncryptedValue(value)) {
    if (mode === 'encrypt') return value;
    if (!key) {
      throw new Error(
        `Encrypted configuration field '${path.join('.')}' requires CONFIG_ENCRYPTION_KEY. Refusing to load or rewrite configuration.`,
      );
    }
    return decryptValue(value, path.join('.'), key);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => transformSecrets(entry, key, mode, [...path, String(index)]));
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [property, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, property];
    if (mode === 'encrypt' && key && isSecretProperty(childPath) && typeof child === 'string' && child.length > 0) {
      output[property] = encryptValue(child, childPath.join('.'), key);
    } else {
      output[property] = transformSecrets(child, key, mode, childPath);
    }
  }
  return output;
}

export function decryptConfigDocument(value: unknown, rawKey = process.env.CONFIG_ENCRYPTION_KEY): unknown {
  return transformSecrets(value, parseEncryptionKey(rawKey), 'decrypt');
}

export function encryptConfigDocument(value: unknown, rawKey = process.env.CONFIG_ENCRYPTION_KEY): unknown {
  const key = parseEncryptionKey(rawKey);
  if (!key) {
    warnIfPlaintextSecrets();
    return value;
  }
  return transformSecrets(value, key, 'encrypt');
}

export function configSecretFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}
