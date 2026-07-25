import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const INGESTION_TIMESTAMP_WINDOW_MS = 5 * 60_000;
export const INGESTION_TOKEN_BYTES = 32;
export type IngestionScope = 'posts:write' | 'posts:preview';

export interface CreatedIngestionSecrets {
  token: string;
  tokenHash: string;
  hmacSecret?: string;
}

export interface HmacVerificationInput {
  secret: string;
  timestamp: string;
  nonce: string;
  rawBody: Buffer;
  signature: string;
  now?: number;
  windowMs?: number;
}

export function hashIngestionToken(token: string): string {
  return createHash('sha256').update('tweets-2-bsky/ingestion-token/v1\0').update(token).digest('hex');
}

export function createIngestionSecrets(includeHmac = false): CreatedIngestionSecrets {
  const token = `t2b_${randomBytes(INGESTION_TOKEN_BYTES).toString('base64url')}`;
  return {
    token,
    tokenHash: hashIngestionToken(token),
    ...(includeHmac ? { hmacSecret: `t2b_hmac_${randomBytes(32).toString('base64url')}` } : {}),
  };
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hmacSigningPayload(timestamp: string, nonce: string, rawBody: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(timestamp, 'utf8'),
    Buffer.from('.', 'utf8'),
    Buffer.from(nonce, 'utf8'),
    Buffer.from('.', 'utf8'),
    rawBody,
  ]);
}

export function createIngestionSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer,
): string {
  return createHmac('sha256', secret).update(hmacSigningPayload(timestamp, nonce, rawBody)).digest('hex');
}

export function verifyIngestionHmac(input: HmacVerificationInput): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)) throw new Error('Invalid ingestion nonce.');
  const suppliedTimestamp = Number(input.timestamp);
  const timestampMs = suppliedTimestamp < 10_000_000_000 ? suppliedTimestamp * 1000 : suppliedTimestamp;
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs((input.now ?? Date.now()) - timestampMs) > (input.windowMs ?? INGESTION_TIMESTAMP_WINDOW_MS)
  ) {
    throw new Error('Ingestion timestamp is outside the accepted window.');
  }
  const supplied = input.signature.replace(/^sha256=/i, '').toLowerCase();
  const expected = createIngestionSignature(
    input.secret,
    input.timestamp,
    input.nonce,
    input.rawBody,
  );
  if (!constantTimeHexEqual(supplied, expected)) throw new Error('Invalid ingestion signature.');
}

export function hashAuditValue(value: string): string {
  return createHash('sha256').update('tweets-2-bsky/audit/v1\0').update(value).digest('hex').slice(0, 24);
}

export function parseIngestionScopes(value: unknown): IngestionScope[] {
  if (!Array.isArray(value)) return ['posts:write'];
  const scopes = [...new Set(value.filter((scope): scope is IngestionScope =>
    scope === 'posts:write' || scope === 'posts:preview',
  ))];
  if (scopes.length === 0) throw new Error('At least one valid ingestion scope is required.');
  return scopes;
}
