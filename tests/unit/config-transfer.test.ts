import { describe, expect, test } from 'bun:test';
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  createConfigExport,
  mergeImportedConfig,
  normalizeConfigV2,
} from '../../src/config-manager.js';
import type { AppConfig } from '../../src/config-manager.js';

function createConfig(): AppConfig {
  return normalizeConfigV2({
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    twitter: {
      authToken: 'x-auth-secret',
      ct0: 'x-ct0-secret',
      backupAuthToken: 'x-backup-auth-secret',
      backupCt0: 'x-backup-ct0-secret',
    },
    scheduler: { enabled: false, intervalMinutes: 17, runOnStartup: true },
    mappings: [
      {
        id: 'mapping-1',
        twitterUsernames: ['source_one', 'source_two'],
        bskyIdentifier: 'destination.example',
        bskyPassword: 'bsky-app-password-secret',
        enabled: true,
        postingPolicy: {
          attribution: {
            mode: 'multiple-sources',
            template: 'Via @{username}: {postUrl}',
            rootPostsOnly: true,
            linkSource: false,
          },
          appendOriginalPostLink: true,
        },
        profileManagement: {
          allowProfileMutation: false,
          ensureBotLabel: false,
          ensureDisplayNameBotSuffix: false,
          profileSync: {
            mode: 'off',
            intervalHours: 12,
            fields: {
              displayName: false,
              description: false,
              avatar: false,
              banner: false,
            },
          },
          pinSync: { mode: 'off', intervalHours: 8 },
        },
      },
    ],
    groups: [{ name: 'Research' }],
    users: [
      {
        id: 'admin-1',
        username: 'admin',
        passwordHash: 'password-hash-secret',
        role: 'admin',
        permissions: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ai: {
      provider: 'openai',
      apiKey: 'ai-api-key-secret',
      model: 'test-model',
      baseUrl: 'https://ai.example/v1',
    },
  });
}

describe('config import and export', () => {
  test('redacts all credential classes by default', () => {
    const current = createConfig();
    const configWithExtraSecrets = {
      ...current,
      jwtSecret: 'jwt-style-secret',
      notifications: { webhookUrl: 'https://hooks.example/secret' },
    } as AppConfig;
    const exported = createConfigExport(configWithExtraSecrets);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain('x-auth-secret');
    expect(serialized).not.toContain('x-ct0-secret');
    expect(serialized).not.toContain('bsky-app-password-secret');
    expect(serialized).not.toContain('ai-api-key-secret');
    expect(serialized).not.toContain('jwt-style-secret');
    expect(serialized).not.toContain('hooks.example');
    expect(serialized).not.toContain('password-hash-secret');
    expect(serialized).toContain('multiple-sources');
    expect(serialized).toContain('Via @{username}: {postUrl}');
    expect(serialized).toContain('"destinations"');
    expect(serialized).toContain('"sources"');
    expect(serialized).toContain('"routes"');
    expect(serialized).toContain('"storageKey":"destination.example"');
    expect(serialized).not.toContain('"mappings"');
  });

  test('requires an explicit full mode to include service credentials', () => {
    const exported = createConfigExport(createConfig(), 'full') as Record<string, unknown>;
    const serialized = JSON.stringify(exported);

    expect(serialized).toContain('x-auth-secret');
    expect(serialized).toContain('bsky-app-password-secret');
    expect(serialized).toContain('ai-api-key-secret');
    expect(exported.users).toBeUndefined();
  });

  test('preserves storage identity when importing over an existing install', () => {
    const current = createConfig();
    const exported = JSON.parse(JSON.stringify(createConfigExport(current, 'full'))) as {
      sources: Array<Record<string, unknown>>;
      destinations: Array<Record<string, unknown>>;
      routes: Array<Record<string, unknown>>;
    };
    const existingDestination = current.destinations[0];
    const existingSource = current.sources.find((source) => source.username === 'source_one');
    const existingRoute = current.routes.find((route) => route.sourceId === existingSource?.id);
    if (!existingDestination || !existingSource || !existingRoute) throw new Error('fixture is incomplete');

    // The same accounts as they would be identified on a different install.
    const usernameByImportedSourceId = new Map<string, string>();
    exported.sources = exported.sources.map((source) => {
      const foreignId = `foreign-source-${String(source.username)}`;
      usernameByImportedSourceId.set(String(source.id), String(source.username));
      return { ...source, id: foreignId };
    });
    exported.destinations = exported.destinations.map((destination) => ({
      ...destination,
      id: 'foreign-destination',
      storageKey: 'foreign-storage-key',
      metadata: { ...(destination.metadata as Record<string, unknown>), legacyMappingIds: ['foreign-mapping'] },
    }));
    exported.routes = exported.routes.map((route) => ({
      ...route,
      id: `foreign-route-${String(route.sourceId)}`,
      sourceId: `foreign-source-${usernameByImportedSourceId.get(String(route.sourceId))}`,
      destinationId: 'foreign-destination',
    }));

    const imported = mergeImportedConfig(current, exported);
    const destination = imported.destinations[0];
    const source = imported.sources.find((entry) => entry.username === 'source_one');
    const route = imported.routes.find((entry) => entry.sourceId === existingSource.id);

    // Queue and history rows are keyed by these values, so an import must not
    // move them.
    expect(destination?.id).toBe(existingDestination.id);
    expect(destination?.storageKey).toBe(existingDestination.storageKey);
    expect(destination?.metadata.legacyMappingIds).toContain('foreign-destination');
    expect(source?.id).toBe(existingSource.id);
    expect(route?.id).toBe(existingRoute.id);
    expect(route?.destinationId).toBe(existingDestination.id);
    expect(route?.metadata.legacyMappingIds).toContain(`foreign-route-${existingSource.id}`);
    expect(imported.routes.every((entry) => entry.destinationId === existingDestination.id)).toBe(true);
    // Import never rewinds or skips this installation's revision counter.
    expect(imported.revision).toBe(current.revision);
  });

  test('round-trips policies while preserving secrets omitted by a redacted export', () => {
    const current = createConfig();
    const redacted = createConfigExport(current, 'redacted');
    const imported = mergeImportedConfig(current, redacted);

    expect(imported.twitter).toEqual(current.twitter);
    expect(imported.mappings[0]?.bskyPassword).toBe(current.mappings[0]?.bskyPassword);
    expect(imported.ai?.apiKey).toBe(current.ai?.apiKey);
    expect(imported.scheduler).toEqual(current.scheduler);
    expect(imported.mappings[0]?.postingPolicy).toEqual(current.mappings[0]?.postingPolicy);
    expect(imported.mappings[0]?.profileManagement).toEqual(current.mappings[0]?.profileManagement);
    expect(imported.users).toEqual(current.users);
  });
});
