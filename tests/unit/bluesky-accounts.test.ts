import { describe, expect, test } from 'bun:test';
import { blueskyAccountIdentity } from '../../src/config/bluesky-accounts.js';

describe('blueskyAccountIdentity', () => {
  test('uses the DID URI as-is without re-prefixing the scheme', () => {
    expect(
      blueskyAccountIdentity({
        did: 'did:plc:Example',
        serviceUrl: 'https://bsky.social',
        loginIdentifier: 'example.bsky.social',
      }),
    ).toBe('did:plc:example');
  });

  test('falls back to service plus login identifier when DID is absent', () => {
    expect(
      blueskyAccountIdentity({
        serviceUrl: 'https://bsky.social/',
        loginIdentifier: '@Example.Bsky.Social',
      }),
    ).toBe('account:https://bsky.social|example.bsky.social');
  });
});
