import { afterAll, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../../src/config/schemas.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-account-rekey-'));
process.env.TWEETS2BSKY_DATA_DIR = tempDir;

// Mutated per-test before invoking the service function under test; the
// mocked module reads it lazily so each test can supply its own resolution.
let currentValidation: { did: string; handle: string; serviceUrl: string; emailConfirmed: boolean; settingsUrl: string };

mock.module('../../src/profile-mirror.js', () => ({
  validateBlueskyCredentials: mock(async () => currentValidation),
}));

const { dbService } = await import('../../src/db.js');
const { getDestinationStorageKey } = await import('../../src/mapping-helpers.js');
const { validateExistingBlueskyAccount, rotateBlueskyAccountCredentials } = await import(
  '../../src/services/bluesky-account-service.js'
);

function buildConfig(overrides: { did?: string } = {}): AppConfig {
  return {
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    blueskyAccounts: [
      {
        id: 'acct-1',
        serviceUrl: 'https://bsky.social',
        loginIdentifier: 'mirror.bsky.social',
        appPassword: 'app-password-secret',
        ...(overrides.did ? { did: overrides.did } : {}),
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
    destinations: [
      {
        id: 'dest-1',
        enabled: true,
        bskyAccountId: 'acct-1',
        bskyIdentifier: 'mirror.bsky.social',
        bskyServiceUrl: 'https://bsky.social',
        storageKey: 'mirror.bsky.social',
        metadata: { legacyMappingIds: ['dest-1'] },
      },
    ],
  } as unknown as AppConfig;
}

afterAll(() => {
  // better-sqlite3 keeps the database file handle open for the process
  // lifetime, which can make Windows refuse to unlink the temp directory.
  // Best-effort cleanup only; the OS reclaims stray temp dirs eventually.
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('managed Bluesky account credential changes rekey linked destination history', () => {
  test('validating an account keeps sticky destination storageKey history addressable', async () => {
    const config = buildConfig();
    const stickyKey = 'mirror.bsky.social';
    dbService.saveTweet({
      twitter_id: 'tweet-1',
      twitter_username: 'source',
      bsky_identifier: stickyKey,
      status: 'migrated',
      bsky_uri: 'at://did:plc:example/app.bsky.feed.post/abc',
      bsky_cid: 'cid-abc',
    });
    expect(Object.keys(dbService.getTweetsByBskyIdentifier(stickyKey))).toContain('tweet-1');

    currentValidation = {
      did: 'did:plc:example',
      handle: 'mirror.bsky.social',
      serviceUrl: 'https://bsky.social',
      emailConfirmed: true,
      settingsUrl: 'https://bsky.social/settings',
    };
    await validateExistingBlueskyAccount(config, 'acct-1', () => {});

    const recomputedDidKey = getDestinationStorageKey({
      bskyDid: 'did:plc:example',
      bskyIdentifier: 'mirror.bsky.social',
    });
    expect(recomputedDidKey).not.toBe(stickyKey);
    // Sticky destination identity wins; discovering a DID must not split history.
    expect(Object.keys(dbService.getTweetsByBskyIdentifier(stickyKey))).toContain('tweet-1');
    expect(Object.keys(dbService.getTweetsByBskyIdentifier(recomputedDidKey))).not.toContain('tweet-1');
  });

  test('rotating credentials that resolve a same-DID handle change keeps history on sticky key', async () => {
    const config = buildConfig({ did: 'did:plc:example' });
    const stickyKey = 'mirror.bsky.social';
    const didKey = getDestinationStorageKey({ bskyDid: 'did:plc:example', bskyIdentifier: 'mirror.bsky.social' });
    dbService.saveTweet({
      twitter_id: 'tweet-2',
      twitter_username: 'source',
      bsky_identifier: didKey,
      status: 'migrated',
    });

    currentValidation = {
      did: 'did:plc:example',
      handle: 'renamed.bsky.social',
      serviceUrl: 'https://bsky.social',
      emailConfirmed: true,
      settingsUrl: 'https://bsky.social/settings',
    };
    await rotateBlueskyAccountCredentials(config, { accountId: 'acct-1', appPassword: 'new-app-password' }, () => {});

    // Alias rows under the recomputed DID are folded onto the sticky destination key.
    expect(Object.keys(dbService.getTweetsByBskyIdentifier(stickyKey))).toContain('tweet-2');
  });
});
