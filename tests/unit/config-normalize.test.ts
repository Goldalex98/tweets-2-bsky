import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { CURRENT_CONFIG_SCHEMA_VERSION, normalizeConfig, normalizeRouteDelivery } from '../../src/config-manager.js';
import { DEFAULT_ROUTE_DELIVERY } from '../../src/config/defaults.js';

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

describe('legacy config normalization', () => {
  test('fills defaults for an empty config', () => {
    const config = normalizeConfig(undefined);
    expect(config).toMatchObject({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      twitter: { authToken: '', ct0: '' },
      defaultInitialImportMode: 'new-only',
      sources: [],
      destinations: [],
      routes: [],
      groups: [],
      users: [],
      scheduler: {
        enabled: true,
        intervalMinutes: 5,
        runOnStartup: false,
      },
      notifications: {
        enabled: false,
        allowPrivate: false,
        events: {
          'twitter-auth-failure': true,
          'bsky-auth-failure': true,
          'queue-parked': true,
          'queue-age': false,
          'update-failure': true,
        },
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 10000,
      },
      ai: {
        enabled: false,
        purpose: 'image-alt-text',
        provider: 'gemini',
        maxAltTextChars: 1000,
        textCapabilities: {
          translation: { enabled: false, purpose: 'translation' },
          summarization: { enabled: false, purpose: 'summarization' },
          cleanup: { enabled: false, purpose: 'cleanup' },
          hashtags: { enabled: false, purpose: 'hashtags' },
        },
      },
    });
    expect(config.mappings).toEqual([]);
  });

  test('normalizes the legacy single-source shape', () => {
    const config = normalizeConfig(readFixture('config-v0-single-source.json'));
    const mapping = config.mappings[0];

    expect(config.twitter).toEqual({ authToken: '<redacted>', ct0: '<redacted>' });
    expect(mapping?.twitterUsernames).toEqual(['legacy_source']);
    expect(mapping?.bskyIdentifier).toBe('legacy.example');
    expect(mapping?.bskyServiceUrl).toBe('https://bsky.social');
    expect(mapping?.profileSyncSourceUsername).toBe('legacy_source');
    expect(mapping?.profileManagement.profileSync.mode).toBe('scheduled');
    expect(mapping?.profileManagement.pinSync.mode).toBe('scheduled');
    expect(mapping?.migrationReview?.needsAdminReview).toBe(true);
    expect(config.groups).toEqual([]);
    expect(config.users).toEqual([]);
  });

  test('deduplicates multi-source config without inferring a profile source', () => {
    const config = normalizeConfig(readFixture('config-v1-multi-source.json'));
    const mapping = config.mappings[0];

    expect(mapping?.twitterUsernames).toEqual(['primary_source', 'secondary_src']);
    expect(mapping?.profileSyncSourceUsername).toBeUndefined();
    expect(mapping?.profileManagement.allowProfileMutation).toBe(false);
    expect(mapping?.profileManagement.profileSync.mode).toBe('off');
    expect(mapping?.profileManagement.pinSync.mode).toBe('off');
    expect(mapping?.migrationReview?.priorProfileSyncSourceUsername).toBe('missing-source');
    expect(mapping?.bskyIdentifier).toBe('aggregate.example');
    expect(config.groups).toEqual([{ name: 'Research' }]);
    expect(config.scheduler.intervalMinutes).toBe(8);
  });

  test('persists administrator migration-review dismissal', () => {
    const config = normalizeConfig(readFixture('config-v0-single-source.json'));
    const mapping = config.mappings[0];
    if (!mapping?.migrationReview) throw new Error('Expected migration review metadata.');
    mapping.migrationReview.needsAdminReview = false;
    mapping.migrationReview.reviewedAt = '2026-07-24T12:00:00.000Z';
    const normalized = normalizeConfig(config);
    expect(normalized.mappings[0]?.migrationReview).toMatchObject({
      needsAdminReview: false,
      reviewedAt: '2026-07-24T12:00:00.000Z',
    });
  });

  test('persists canonical destination identity and only known paused sources', () => {
    const config = normalizeConfig({
      schemaVersion: 2,
      twitter: { authToken: '', ct0: '' },
      scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
      groups: [],
      users: [],
      mappings: [
        {
          id: 'canonical',
          twitterUsernames: ['One', 'TWO'],
          pausedTwitterUsernames: ['@TWO', 'missing'],
          bskyIdentifier: 'Destination.Example',
          bskyPassword: '<redacted>',
          bskyServiceUrl: 'BSKY.SOCIAL/',
          bskyDid: 'did:plc:destination',
          bskyCanonicalHandle: '@Canonical.Example',
          enabled: true,
        },
      ],
    });
    expect(config.mappings[0]).toMatchObject({
      twitterUsernames: ['one', 'two'],
      pausedTwitterUsernames: ['two'],
      bskyDid: 'did:plc:destination',
      bskyCanonicalHandle: 'canonical.example',
      bskyServiceUrl: 'https://bsky.social',
    });
  });
});

describe('normalizeRouteDelivery', () => {
  test('preserves every schema cadence and grouping value', () => {
    for (const cadence of ['hourly', 'daily', 'weekly'] as const) {
      expect(normalizeRouteDelivery({ digest: { cadence } }).digest.cadence).toBe(cadence);
    }
    for (const grouping of ['none', 'source', 'day'] as const) {
      expect(normalizeRouteDelivery({ digest: { grouping } }).digest.grouping).toBe(grouping);
    }
  });

  test('falls back to defaults for unknown cadence and grouping', () => {
    const delivery = normalizeRouteDelivery({
      digest: { cadence: 'monthly', grouping: 'author' },
    });
    expect(delivery.digest.cadence).toBe(DEFAULT_ROUTE_DELIVERY.digest.cadence);
    expect(delivery.digest.grouping).toBe(DEFAULT_ROUTE_DELIVERY.digest.grouping);
  });
});
