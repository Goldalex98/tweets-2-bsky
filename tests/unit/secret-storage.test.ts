import { describe, expect, test } from 'bun:test';
import {
  decryptConfigDocument,
  encryptConfigDocument,
  isEncryptedValue,
  parseEncryptionKey,
} from '../../src/secret-storage.js';

const KEY = '11'.repeat(32);
const OTHER_KEY = '22'.repeat(32);

describe('configuration secret encryption', () => {
  test('round-trips every protected field with unique nonces and leaves ordinary values readable', () => {
    const plaintext = {
      twitter: { authToken: 'x-secret', ct0: 'csrf-secret' },
      destinations: [{ bskyIdentifier: 'safe.example', bskyPassword: 'bsky-secret' }],
      ai: { provider: 'gemini', apiKey: 'ai-secret' },
      notifications: { webhookUrl: 'https://example.test/hook', webhookSecret: 'hook-secret' },
      scheduler: { enabled: true },
    };
    const encrypted = encryptConfigDocument(plaintext, KEY) as any;
    expect(isEncryptedValue(encrypted.twitter.authToken)).toBe(true);
    expect(isEncryptedValue(encrypted.destinations[0].bskyPassword)).toBe(true);
    expect(encrypted.destinations[0].bskyIdentifier).toBe('safe.example');
    const nonces = [
      encrypted.twitter.authToken.nonce,
      encrypted.twitter.ct0.nonce,
      encrypted.destinations[0].bskyPassword.nonce,
      encrypted.ai.apiKey.nonce,
      encrypted.notifications.webhookUrl.nonce,
      encrypted.notifications.webhookSecret.nonce,
    ];
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(decryptConfigDocument(encrypted, KEY)).toEqual(plaintext);
  });

  test('fails closed for missing, wrong, and tampered keys or ciphertext', () => {
    const encrypted = encryptConfigDocument({ twitter: { authToken: 'secret' } }, KEY) as any;
    expect(() => decryptConfigDocument(encrypted, '')).toThrow('requires CONFIG_ENCRYPTION_KEY');
    expect(() => decryptConfigDocument(encrypted, OTHER_KEY)).toThrow('Could not decrypt');
    encrypted.twitter.authToken.ciphertext = `${encrypted.twitter.authToken.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptConfigDocument(encrypted, KEY)).toThrow('Could not decrypt');
  });

  test('accepts only strict 32-byte hex or standard base64 keys', () => {
    expect(parseEncryptionKey(KEY)).toHaveLength(32);
    expect(parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(() => parseEncryptionKey('short')).toThrow('exactly 32 bytes');
    expect(() => parseEncryptionKey(Buffer.alloc(31).toString('base64'))).toThrow('exactly 32 bytes');
  });
});
