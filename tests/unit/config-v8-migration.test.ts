import { describe, expect, test } from 'bun:test';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { migrateConfigWithMetadata, migrateV7ToV8 } from '../../src/config/migrations.js';
import { toCanonicalConfig } from '../../src/config/projection.js';

function legacyV7Config() {
  const canonical = structuredClone(toCanonicalConfig(getDefaultConfig())) as unknown as Record<string, unknown>;
  canonical.schemaVersion = 7;
  canonical.defaultInitialImportMode = undefined;
  canonical.sources = [
    {
      id: 'source_alpha',
      type: 'x',
      username: 'alpha',
      enabled: true,
      filters: {},
      schedule: {},
      state: {
        consecutiveFailures: 0,
        lastTweetSeenId: '1900000000000000000',
        lastTweetSeenAt: '2026-07-24T19:00:00.000Z',
      },
    },
  ];
  canonical.destinations = [
    {
      id: 'destination-alpha',
      enabled: true,
      bskyAccountId: 'account-alpha',
      bskyIdentifier: 'alpha.bsky.social',
      bskyServiceUrl: 'https://bsky.social',
      storageKey: 'destination:alpha',
      metadata: { legacyMappingIds: ['destination-alpha'] },
    },
  ];
  canonical.blueskyAccounts = [
    {
      id: 'account-alpha',
      serviceUrl: 'https://bsky.social',
      loginIdentifier: 'alpha.bsky.social',
      appPassword: '<redacted-app-password>',
      createdAt: '2026-07-24T18:00:00.000Z',
      updatedAt: '2026-07-24T18:00:00.000Z',
    },
  ];
  canonical.routes = [
    {
      id: 'route-alpha',
      sourceId: 'source_alpha',
      destinationId: 'destination-alpha',
      enabled: true,
      filters: {},
      routingPolicy: {},
      moderationPolicy: {},
      duplicateSuppression: {},
      delivery: {},
      relationship: {},
      metadata: { legacyMappingIds: ['destination-alpha'] },
    },
  ];
  return canonical;
}

describe('schema v7 to v8 migration', () => {
  test('preserves existing routes with explicit recent import behavior', () => {
    const result = migrateConfigWithMetadata(legacyV7Config());

    expect(result).toMatchObject({ fromVersion: 7, toVersion: 8, migrated: true });
    expect(result.config.defaultInitialImportMode).toBe('new-only');
    expect(result.config.routes[0]?.initialImportMode).toBe('recent');
    expect(result.config.sources[0]?.state).toMatchObject({
      lastTweetSeenId: '1900000000000000000',
      lastTweetSeenAt: '2026-07-24T19:00:00.000Z',
    });
  });

  test('is deterministic and idempotent', () => {
    const first = migrateV7ToV8(legacyV7Config());
    const second = migrateV7ToV8(toCanonicalConfig(first) as unknown as Record<string, unknown>);

    expect(toCanonicalConfig(second)).toEqual(toCanonicalConfig(first));
  });
});
