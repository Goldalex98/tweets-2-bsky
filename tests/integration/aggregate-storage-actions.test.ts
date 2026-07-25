import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;

test('source queue/history actions are explicit and destination scoped', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { dbService, postQueueService } = await import(${JSON.stringify(dbModuleUrl)});
          postQueueService.enqueue([
            {
              twitter_id: '1',
              bsky_identifier: 'destination.example',
              mapping_id: 'mapping-a',
              twitter_username: 'source',
              kind: 'scheduled',
              tweet_json: '{}'
            },
            {
              twitter_id: '2',
              bsky_identifier: 'destination.example',
              mapping_id: 'mapping-a',
              twitter_username: 'source',
              kind: 'backfill',
              tweet_json: '{}'
            }
          ]);
          dbService.saveTweet({
            twitter_id: 'history-a',
            twitter_username: 'source',
            bsky_identifier: 'destination.example',
            status: 'migrated'
          });
          dbService.saveTweet({
            twitter_id: 'history-b',
            twitter_username: 'source',
            bsky_identifier: 'other.example',
            status: 'migrated'
          });
          const before = {
            queue: postQueueService.getSourceCounts('mapping-a', 'source'),
            history: dbService.countTweetsBySourceForDestination('source', 'destination.example')
          };
          const rekeyed = dbService.rekeyDestinationIdentity('destination.example', 'did:plc:destination');
          const cancelled = postQueueService.cancelPendingByMappingAndSource('mapping-a', 'source');
          const deleted = dbService.deleteTweetsBySourceForDestination('source', 'did:plc:destination');
          const after = {
            queue: postQueueService.getSourceCounts('mapping-a', 'source'),
            history: dbService.countTweetsBySourceForDestination('source', 'did:plc:destination'),
            otherHistory: dbService.countTweetsBySourceForDestination('source', 'other.example')
          };
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ before, rekeyed, cancelled, deleted, after }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      before: { queue: { pending: 2, processing: 0, failed: 0 }, history: 1 },
      rekeyed: { processed: 1, queued: 2 },
      cancelled: 2,
      deleted: 1,
      after: { queue: { pending: 0, processing: 0, failed: 0 }, history: 0, otherHistory: 1 },
    });
  } finally {
    temporary.cleanup();
  }
});

test('queue claiming skips every mapping for an already locked canonical destination', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'lock-result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { postQueueService } = await import(${JSON.stringify(dbModuleUrl)});
          postQueueService.enqueue([
            { twitter_id: '10', bsky_identifier: 'old.example', mapping_id: 'legacy-a', twitter_username: 'a', kind: 'scheduled', tweet_json: '{}' },
            { twitter_id: '11', bsky_identifier: 'new.example', mapping_id: 'legacy-b', twitter_username: 'b', kind: 'scheduled', tweet_json: '{}' },
            { twitter_id: '12', bsky_identifier: 'other.example', mapping_id: 'other', twitter_username: 'c', kind: 'scheduled', tweet_json: '{}' }
          ]);
          const keys = new Map([
            ['legacy-a', 'did:plc:same'],
            ['legacy-b', 'did:plc:same'],
            ['other', 'did:plc:other']
          ]);
          const batch = postQueueService.claimNextBatch(
            new Set(['did:plc:same']),
            new Set(keys.keys()),
            (mappingId) => keys.get(mappingId) || mappingId
          );
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(batch));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const batch = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      mapping_id: string;
      destination_key: string;
    };
    expect(batch.mapping_id).toBe('other');
    expect(batch.destination_key).toBe('did:plc:other');
  } finally {
    temporary.cleanup();
  }
});
