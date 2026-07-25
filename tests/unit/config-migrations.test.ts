import fs from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { CURRENT_CONFIG_SCHEMA_VERSION, migrateConfig, normalizeConfigV2 } from '../../src/config-manager.js';

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('config schema migrations', () => {
  test('migrates an actual unversioned one-source config with balanced legacy behavior', () => {
    const legacy = readFixture('config-v0-single-source.json');
    const twitter = legacy.twitter as Record<string, unknown>;
    const mapping = (legacy.mappings as Record<string, unknown>[])[0];
    if (!mapping) throw new Error('Fixture mapping missing.');
    twitter.authToken = '  exact x auth token  ';
    mapping.bskyPassword = '  exact bsky app password  ';
    mapping.hasBotLabel = true;
    mapping.lastMirroredDisplayName = 'Legacy Source {bot}';

    const migrated = migrateConfig(legacy);
    const migratedMapping = migrated.mappings[0];

    expect(migrated.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(migrated.scheduler).toEqual({
      enabled: true,
      intervalMinutes: 5,
      runOnStartup: false,
    });
    expect(migrated.twitter.authToken).toBe('  exact x auth token  ');
    expect(migratedMapping?.bskyPassword).toBe('  exact bsky app password  ');
    expect(migratedMapping?.postingPolicy.attribution.mode).toBe('always');
    expect(migratedMapping?.profileManagement).toMatchObject({
      allowProfileMutation: true,
      ensureBotLabel: false,
      ensureDisplayNameBotSuffix: false,
      profileSync: {
        mode: 'scheduled',
        sourceUsername: 'legacy_source',
        fields: { displayName: true, description: false, avatar: true, banner: true },
      },
      pinSync: { mode: 'scheduled', sourceUsername: 'legacy_source' },
    });
    expect(migratedMapping?.hasBotLabel).toBe(true);
    expect(migratedMapping?.migrationReview).toMatchObject({
      needsAdminReview: true,
      migratedFromSchemaVersion: 0,
      knownBotLabelApplied: true,
      knownDisplayNameSuffix: 'bot',
    });
  });

  test('disables automatic profile and pin policy for migrated aggregate mappings', () => {
    const migrated = migrateConfig(readFixture('config-v1-multi-source.json'));
    const mapping = migrated.mappings[0];

    expect(mapping?.twitterUsernames).toEqual(['primary_source', 'secondary_src']);
    expect(mapping?.profileManagement.allowProfileMutation).toBe(false);
    expect(mapping?.profileManagement.profileSync.mode).toBe('off');
    expect(mapping?.profileManagement.pinSync.mode).toBe('off');
    expect(mapping?.profileManagement.ensureBotLabel).toBe(false);
    expect(mapping?.profileManagement.ensureDisplayNameBotSuffix).toBe(false);
    expect(mapping?.migrationReview?.priorProfileSyncSourceUsername).toBe('missing-source');
    expect(mapping?.migrationReview?.notices.length).toBeGreaterThan(0);
  });

  test('gives new v2 mappings source-count-aware safe defaults', () => {
    const config = normalizeConfigV2({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      twitter: { authToken: '', ct0: '' },
      scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
      mappings: [
        {
          id: 'single',
          twitterUsernames: ['one'],
          bskyIdentifier: 'single.example',
          bskyPassword: 'secret',
          enabled: true,
        },
        {
          id: 'aggregate',
          twitterUsernames: ['one', 'two'],
          bskyIdentifier: 'aggregate.example',
          bskyPassword: 'secret',
          enabled: true,
        },
      ],
    });

    expect(config.mappings[0]?.postingPolicy.attribution.mode).toBe('never');
    expect(config.mappings[1]?.postingPolicy.attribution.mode).toBe('multiple-sources');
    for (const mapping of config.mappings) {
      expect(mapping.profileManagement).toMatchObject({
        allowProfileMutation: false,
        ensureBotLabel: false,
        ensureDisplayNameBotSuffix: false,
        profileSync: { mode: 'off' },
        pinSync: { mode: 'off' },
      });
      expect(mapping.migrationReview).toBeUndefined();
    }
  });

  test('is idempotent after the first migration', () => {
    const first = migrateConfig(readFixture('config-v1-multi-source.json'));
    const second = migrateConfig(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('v3 key-only AI config migrates to explicit Image Alt Text without enabling text tools', () => {
    const base = migrateConfig(readFixture('config-v1-multi-source.json'));
    const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    raw.schemaVersion = 3;
    raw.ai = { provider: 'gemini', apiKey: 'legacy-key' };
    const migrated = migrateConfig(raw);
    expect(migrated.ai).toMatchObject({
      enabled: true,
      purpose: 'image-alt-text',
      provider: 'gemini',
      maxAltTextChars: 1000,
    });
    for (const capability of Object.values(migrated.ai.textCapabilities)) {
      expect(capability.enabled).toBe(false);
    }
    expect(migrateConfig(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
  });
});
