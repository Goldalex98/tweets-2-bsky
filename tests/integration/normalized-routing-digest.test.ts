import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('mixed normalized fanout keeps immediate and digest queues distinct and destination scoped', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'routing-result.json');
  const ingestionUrl = new URL('../../src/ingestion.ts', import.meta.url).href;
  const configUrl = new URL('../../src/config/normalize.ts', import.meta.url).href;
  const defaultsUrl = new URL('../../src/config/defaults.ts', import.meta.url).href;
  const dbUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { routeNormalizedPost } = await import(${JSON.stringify(ingestionUrl)});
          const { normalizeConfigV3 } = await import(${JSON.stringify(configUrl)});
          const defaults = await import(${JSON.stringify(defaultsUrl)});
          const { postQueueService, digestEntryService } = await import(${JSON.stringify(dbUrl)});
          const source = (id) => ({
            id,
            type: 'webhook',
            username: id,
            enabled: true,
            filters: defaults.DEFAULT_SOURCE_FILTERS,
            schedule: defaults.DEFAULT_SOURCE_SCHEDULE,
            state: { consecutiveFailures: 0 },
          });
          const destination = (id) => ({
            id,
            enabled: true,
            bskyIdentifier: id + '.bsky.social',
            bskyPassword: '<redacted>',
            bskyServiceUrl: 'https://bsky.social',
            storageKey: id,
            metadata: { legacyMappingIds: [id] },
          });
          const route = (id, sourceId, destinationId, mode) => ({
            id,
            sourceId,
            destinationId,
            enabled: true,
            filters: defaults.DEFAULT_SOURCE_FILTERS,
            routingPolicy: defaults.DEFAULT_ROUTING_POLICY,
            moderationPolicy: defaults.DEFAULT_MODERATION_POLICY,
            duplicateSuppression: defaults.DEFAULT_DUPLICATE_SUPPRESSION,
            delivery: {
              ...defaults.DEFAULT_ROUTE_DELIVERY,
              mode,
              digest: { ...defaults.DEFAULT_ROUTE_DELIVERY.digest, enabled: mode === 'digest' },
            },
            relationship: { sourcePaused: false, profileSyncSource: false, pinSyncSource: false },
            metadata: { legacyMappingIds: [] },
          });
          const config = normalizeConfigV3({
            schemaVersion: 6,
            twitter: { authToken: '', ct0: '' },
            sources: [source('feed-a'), source('feed-b')],
            destinations: [destination('dest-a'), destination('dest-b')],
            routes: [
              route('a-immediate', 'feed-a', 'dest-a', 'immediate'),
              route('a-digest', 'feed-a', 'dest-b', 'digest'),
              route('b-immediate', 'feed-b', 'dest-a', 'immediate'),
            ],
            groups: [],
            users: [],
            scheduler: defaults.DEFAULT_SCHEDULER_CONFIG,
            notifications: defaults.DEFAULT_NOTIFICATION_CONFIG,
            ai: defaults.DEFAULT_AI_CONFIG,
          });
          const post = (sourceId, externalId) => ({
            sourceType: 'webhook',
            sourceId,
            externalId,
            text: 'shared release ' + externalId,
            createdAt: '2026-07-24T12:00:00.000Z',
            urls: ['https://example.com/' + externalId],
            sensitive: false,
            media: [],
          });
          const first = routeNormalizedPost(config, post('feed-a', 'shared-id'));
          const second = routeNormalizedPost(config, post('feed-b', 'shared-id'));
          const duplicate = routeNormalizedPost(config, post('feed-a', 'shared-id'));
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            first,
            second,
            duplicate,
            queue: postQueueService.getCounts(),
            digest: digestEntryService.list(),
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, any>;
    expect(result.first.accepted).toBe(2);
    expect(result.second.accepted).toBe(1);
    expect(result.queue.pending).toBe(2);
    expect(result.digest).toHaveLength(1);
    expect(result.duplicate.duplicates).toBe(2);
  } finally {
    temporary.cleanup();
  }
});

test('accepted content is fingerprinted so identical content is not reprocessed', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'dedup-result.json');
  const ingestionUrl = new URL('../../src/ingestion.ts', import.meta.url).href;
  const configUrl = new URL('../../src/config/normalize.ts', import.meta.url).href;
  const defaultsUrl = new URL('../../src/config/defaults.ts', import.meta.url).href;
  const dbUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { routeNormalizedPost } = await import(${JSON.stringify(ingestionUrl)});
          const { normalizeConfigV3 } = await import(${JSON.stringify(configUrl)});
          const defaults = await import(${JSON.stringify(defaultsUrl)});
          const { postQueueService } = await import(${JSON.stringify(dbUrl)});
          const config = normalizeConfigV3({
            schemaVersion: 6,
            twitter: { authToken: '', ct0: '' },
            sources: [{
              id: 'feed', type: 'webhook', username: 'feed', enabled: true,
              filters: defaults.DEFAULT_SOURCE_FILTERS,
              schedule: defaults.DEFAULT_SOURCE_SCHEDULE,
              state: { consecutiveFailures: 0 },
            }],
            destinations: [{
              id: 'dest', enabled: true, bskyIdentifier: 'dest.bsky.social',
              bskyPassword: '<redacted>', bskyServiceUrl: 'https://bsky.social',
              storageKey: 'dest', metadata: { legacyMappingIds: ['dest'] },
            }],
            routes: [{
              id: 'route', sourceId: 'feed', destinationId: 'dest', enabled: true,
              filters: defaults.DEFAULT_SOURCE_FILTERS,
              routingPolicy: defaults.DEFAULT_ROUTING_POLICY,
              moderationPolicy: defaults.DEFAULT_MODERATION_POLICY,
              // Content-level suppression on, unlike the shipped default.
              duplicateSuppression: { enabled: true, windowHours: 24, perceptualImageHash: false },
              delivery: defaults.DEFAULT_ROUTE_DELIVERY,
              relationship: { sourcePaused: false, profileSyncSource: false, pinSyncSource: false },
              metadata: { legacyMappingIds: [] },
            }],
            groups: [],
            users: [],
            scheduler: defaults.DEFAULT_SCHEDULER_CONFIG,
            notifications: defaults.DEFAULT_NOTIFICATION_CONFIG,
            ai: defaults.DEFAULT_AI_CONFIG,
          });
          // Distinct external ids, identical content: only a recorded
          // fingerprint can catch the second one.
          const post = (externalId) => ({
            sourceType: 'webhook',
            sourceId: 'feed',
            externalId,
            text: 'the same announcement',
            createdAt: '2026-07-24T12:00:00.000Z',
            urls: ['https://example.com/announcement'],
            sensitive: false,
            media: [],
          });
          const first = routeNormalizedPost(config, post('id-1'));
          const second = routeNormalizedPost(config, post('id-2'));
          const different = routeNormalizedPost(config, {
            ...post('id-3'),
            text: 'a different announcement',
            urls: ['https://example.com/other'],
          });
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            first, second, different, queue: postQueueService.getCounts(),
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, any>;
    expect(result.first.accepted).toBe(1);
    expect(result.second).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(result.second.routes[0].reason).toBe('content-duplicate');
    expect(result.different.accepted).toBe(1);
    expect(result.queue.pending).toBe(2);
  } finally {
    temporary.cleanup();
  }
});
