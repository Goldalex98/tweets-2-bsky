import { describe, expect, test } from 'bun:test';
import { migrateConfigWithMetadata } from '../../src/config/migrations.js';

describe('schema v6 to v7 migration', () => {
  test('creates managed Bluesky accounts while preserving destination identity', () => {
    const result = migrateConfigWithMetadata({
      schemaVersion: 6,
      twitter: { authToken: '', ct0: '' },
      scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
      groups: [],
      users: [],
      blueskyAccounts: [],
      sources: [
        {
          id: 'source_alpha',
          type: 'x',
          username: 'alpha',
          enabled: true,
          filters: {
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
          },
          schedule: {
            mode: 'adaptive',
            minIntervalMinutes: 5,
            maxIntervalMinutes: 60,
            fixedIntervalMinutes: 15,
          },
          state: { consecutiveFailures: 0 },
        },
      ],
      destinations: [
        {
          id: 'destination-1',
          enabled: true,
          bskyIdentifier: 'mirror.bsky.social',
          bskyPassword: 'app-password-secret',
          bskyServiceUrl: 'https://bsky.social',
          bskyDid: 'did:plc:example',
          bskyCanonicalHandle: 'mirror.bsky.social',
          storageKey: 'did:plc:example',
          postingPolicy: {
            attribution: {
              mode: 'never',
              template: 'Source: @{username} on X',
              rootPostsOnly: true,
              linkSource: true,
            },
            appendOriginalPostLink: false,
          },
          aiOverrides: {
            imageAltText: 'inherit',
            textCapabilities: {
              translation: 'inherit',
              summarization: 'inherit',
              cleanup: 'inherit',
              hashtags: 'inherit',
            },
          },
          moderationPolicy: {
            blockKeywords: [],
            blockDomains: [],
            blockSourceUsernames: [],
            sensitiveContent: 'allow',
            dryRun: false,
          },
          duplicateSuppression: { enabled: false, windowHours: 24, perceptualImageHash: false },
          profileManagement: {
            allowProfileMutation: false,
            ensureBotLabel: false,
            ensureDisplayNameBotSuffix: false,
            profileSync: {
              mode: 'off',
              intervalHours: 24,
              fields: { displayName: false, description: false, avatar: false, banner: false },
            },
            pinSync: { mode: 'off', intervalHours: 24 },
          },
          metadata: { legacyMappingIds: ['destination-1'] },
        },
      ],
      routes: [
        {
          id: 'route_alpha_destination',
          sourceId: 'source_alpha',
          destinationId: 'destination-1',
          enabled: true,
          filters: {
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
          },
          routingPolicy: {
            includeKeywords: [],
            excludeKeywords: [],
            includeDomains: [],
            excludeDomains: [],
            contentTypes: [],
            mediaTypes: [],
            languages: [],
            allowedHours: [],
            timezone: 'UTC',
          },
          moderationPolicy: {
            blockKeywords: [],
            blockDomains: [],
            blockSourceUsernames: [],
            sensitiveContent: 'allow',
            dryRun: false,
          },
          duplicateSuppression: { enabled: false, windowHours: 24, perceptualImageHash: false },
          delivery: {
            mode: 'immediate',
            digest: {
              enabled: false,
              cadence: 'daily',
              timezone: 'UTC',
              hour: 9,
              minute: 0,
              grouping: 'flat',
              template: '',
              maxEntries: 20,
              maxGraphemes: 300,
              includeSourceAttribution: true,
            },
          },
          relationship: {
            sourcePaused: false,
            profileSyncSource: false,
            pinSyncSource: false,
          },
          metadata: { legacyMappingIds: ['destination-1'] },
        },
      ],
    });

    expect(result.toVersion).toBe(7);
    expect(result.config.blueskyAccounts.length).toBe(1);
    expect(result.config.destinations[0]?.id).toBe('destination-1');
    expect(result.config.destinations[0]?.storageKey).toBe('did:plc:example');
    expect(result.config.destinations[0]?.bskyAccountId).toBe(result.config.blueskyAccounts[0]?.id);
    expect(result.config.blueskyAccounts[0]?.loginIdentifier).toBe('mirror.bsky.social');
    expect(result.config.blueskyAccounts[0]?.did).toBe('did:plc:example');
    expect((result.config.destinations[0] as { bskyPassword?: string }).bskyPassword).toBeUndefined();
    expect(result.config.mappings[0]?.bskyIdentifier).toBe('mirror.bsky.social');
  });
});
