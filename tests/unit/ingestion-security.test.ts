import { describe, expect, test } from 'bun:test';
import {
  createIngestionSecrets,
  createIngestionSignature,
  hashIngestionToken,
  parseIngestionScopes,
  verifyIngestionHmac,
} from '../../src/ingestion-security.js';

describe('secure inbound ingestion credentials', () => {
  test('creates high-entropy one-time secrets and stores a deterministic hash', () => {
    const created = createIngestionSecrets(true);
    expect(created.token).toStartWith('t2b_');
    expect(created.token).not.toContain(created.tokenHash);
    expect(created.tokenHash).toBe(hashIngestionToken(created.token));
    expect(created.hmacSecret).toStartWith('t2b_hmac_');
  });

  test('verifies an exact timestamp, nonce, and raw-body HMAC', () => {
    const now = Date.parse('2026-07-24T12:00:00Z');
    const timestamp = String(now / 1000);
    const nonce = 'nonce_1234567890';
    const rawBody = Buffer.from('{"text":"exact bytes"}');
    const signature = createIngestionSignature('secret', timestamp, nonce, rawBody);
    expect(() =>
      verifyIngestionHmac({ secret: 'secret', timestamp, nonce, rawBody, signature, now }),
    ).not.toThrow();
    expect(() =>
      verifyIngestionHmac({
        secret: 'secret',
        timestamp,
        nonce,
        rawBody: Buffer.from('{"text":"changed"}'),
        signature,
        now,
      }),
    ).toThrow('signature');
  });

  test('rejects stale timestamps and malformed nonces', () => {
    const now = Date.parse('2026-07-24T12:00:00Z');
    const rawBody = Buffer.from('{}');
    const stale = String((now - 10 * 60_000) / 1000);
    expect(() =>
      verifyIngestionHmac({
        secret: 'secret',
        timestamp: stale,
        nonce: 'nonce_1234567890',
        rawBody,
        signature: createIngestionSignature('secret', stale, 'nonce_1234567890', rawBody),
        now,
      }),
    ).toThrow('timestamp');
    expect(() =>
      verifyIngestionHmac({
        secret: 'secret',
        timestamp: String(now),
        nonce: 'short',
        rawBody,
        signature: '00',
        now,
      }),
    ).toThrow('nonce');
  });

  test('normalizes only supported scopes', () => {
    expect(parseIngestionScopes(['posts:write', 'posts:write', 'posts:preview', 'admin'])).toEqual([
      'posts:write',
      'posts:preview',
    ]);
    expect(() => parseIngestionScopes(['admin'])).toThrow('scope');
  });
});
