import { describe, expect, test } from 'bun:test';
import {
  ConfigMigrationConflictError,
  CURRENT_CONFIG_SCHEMA_VERSION,
  applyMappingProjection,
  migrateConfig,
  migrateConfigWithMetadata,
  toCanonicalConfig,
} from '../../src/config-manager.js';

const legacyMapping = {
  id: 'legacy-destination',
  twitterUsernames: ['Source_One', '@source_two'],
  pausedTwitterUsernames: ['source_two'],
  bskyIdentifier: 'destination.example',
  bskyPassword: 'secret-one',
  bskyServiceUrl: 'https://bsky.social',
  enabled: true,
};

function v2Config(mappings: unknown[] = [legacyMapping]) {
  return {
    schemaVersion: 2,
    twitter: { authToken: 'x-secret', ct0: 'ct0-secret' },
    scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
    mappings,
    groups: [{ name: 'Research' }],
    users: [],
  };
}

describe('canonical config v3 migration', () => {
  test('v4 moderation policies migrate idempotently to explicit dry-run defaults', () => {
    const current = structuredClone(migrateConfig(v2Config()));
    current.schemaVersion = 4;
    current.destinations = current.destinations.map((destination) => {
      const { dryRun: _dryRun, ...moderationPolicy } = destination.moderationPolicy;
      return { ...destination, moderationPolicy } as typeof destination;
    });
    current.routes = current.routes.map((route) => {
      const { dryRun: _dryRun, ...moderationPolicy } = route.moderationPolicy;
      return { ...route, moderationPolicy } as typeof route;
    });
    const first = migrateConfig(current);
    const second = migrateConfig(structuredClone(first));
    expect(first.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(first.destinations[0]?.moderationPolicy.dryRun).toBe(false);
    expect(first.routes[0]?.moderationPolicy.dryRun).toBe(false);
    expect(second).toEqual(first);
  });

  test('creates canonical entities, preserves paused routes, and is idempotent', () => {
    const first = migrateConfig(v2Config());
    const canonical = toCanonicalConfig(first);

    expect(first.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(first.sources.map((source) => source.username)).toEqual(['source_one', 'source_two']);
    expect(first.sources[0]?.filters).toEqual({
      originalPosts: true,
      selfReplies: true,
      externalReplies: false,
      quotes: true,
      reposts: false,
      mediaOnly: false,
      includeKeywords: [],
      excludeKeywords: [],
      languages: [],
      sensitiveContent: 'mirror',
    });
    expect(first.sources[0]?.schedule.mode).toBe('inherit');
    expect(first.destinations[0]?.id).toBe('legacy-destination');
    expect(first.destinations[0]?.storageKey).toBe('destination.example');
    expect(first.routes).toHaveLength(2);
    expect(first.routes[0]?.filters.externalReplies).toBe(false);
    expect(first.routes.filter((route) => route.enabled)).toHaveLength(1);
    expect(first.mappings[0]?.pausedTwitterUsernames).toEqual(['source_two']);
    expect(JSON.stringify(canonical)).not.toContain('"mappings"');

    const second = migrateConfig(JSON.parse(JSON.stringify(canonical)));
    expect(toCanonicalConfig(second)).toEqual(canonical);
  });

  test('deduplicates identical sources, destinations, and routes safely', () => {
    const duplicate = {
      ...legacyMapping,
      id: 'legacy-destination-alias',
      twitterUsernames: ['source_one', 'source_two'],
    };
    const result = migrateConfigWithMetadata(v2Config([legacyMapping, duplicate]));

    expect(result.config.sources).toHaveLength(2);
    expect(result.config.destinations).toHaveLength(1);
    expect(result.config.routes).toHaveLength(2);
    expect(result.report.deduplicatedDestinations).toBe(1);
    expect(result.report.deduplicatedRoutes).toBe(2);
    expect(result.config.destinations[0]?.metadata.legacyMappingIds).toEqual([
      'legacy-destination',
      'legacy-destination-alias',
    ]);
  });

  test('reports conflicting duplicate destinations without exposing values', () => {
    const conflicting = {
      ...legacyMapping,
      id: 'conflicting-destination',
      bskyPassword: 'different-super-secret',
      owner: 'different-owner',
    };
    const raw = v2Config([legacyMapping, conflicting]);
    let conflict: ConfigMigrationConflictError | undefined;
    try {
      migrateConfig(raw);
    } catch (error) {
      if (error instanceof ConfigMigrationConflictError) conflict = error;
    }
    expect(conflict).toBeDefined();
    const serialized = JSON.stringify(conflict?.report);
    expect(conflict?.report.conflicts).toHaveLength(1);
    expect(conflict?.report.conflicts[0]?.conflictingFields).toContain('bskyPassword');
    expect(conflict?.report.conflicts[0]?.conflictingFields).toContain('owner');
    expect(serialized).not.toContain('secret-one');
    expect(serialized).not.toContain('different-super-secret');
  });

  test('translates compatibility projection mutations into canonical entities', () => {
    const config = migrateConfig(v2Config());
    const mapping = config.mappings[0];
    if (!mapping) throw new Error('Expected migrated mapping projection.');
    const updatedMapping = {
      ...mapping,
      twitterUsernames: [...mapping.twitterUsernames, 'source_three'],
    };
    const updated = applyMappingProjection(config, [updatedMapping]);

    expect(updated.sources.some((source) => source.username === 'source_three')).toBe(true);
    expect(
      updated.routes.some(
        (route) => updated.sources.find((source) => source.id === route.sourceId)?.username === 'source_three',
      ),
    ).toBe(true);
    expect(JSON.stringify(toCanonicalConfig(updated))).not.toContain('"mappings"');
  });
});
