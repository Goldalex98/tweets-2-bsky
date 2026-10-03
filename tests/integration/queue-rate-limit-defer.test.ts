import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('a Bluesky rate limit defers a row to the reset without spending its last attempt', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'rate-limit-defer.json');
  const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { postQueueService } = await import(${moduleUrl('db.ts')});
          const { XRPCError } = await import('@atproto/api');
          const enqueue = (id) => postQueueService.enqueue([{
            twitter_id: id, bsky_identifier: 'storage-key', mapping_id: 'destination-1', twitter_username: 'source',
            source_type: 'x', external_post_id: id, destination_id: 'destination-1', route_id: 'route-a',
            source_id: 'source-a', policy_version: 1, policy_snapshot: '{}', kind: 'scheduled',
            tweet_json: '{}', tweet_text: 'queued ' + id,
          }]);
          enqueue('100');
          enqueue('101');
          const resetSeconds = Math.floor(Date.now() / 1000) + 1800;
          const limited = new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded', { 'ratelimit-reset': String(resetSeconds) });
          const first = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          postQueueService.releaseForRetry(first.items[0], limited, 1);
          const deferred = postQueueService.inspect({ twitterId: '100', bskyIdentifier: 'storage-key' })[0];
          const second = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          postQueueService.releaseForRetry(second.items[0], new Error('Upstream failure'), 1);
          const parked = postQueueService.inspect({ twitterId: '101', bskyIdentifier: 'storage-key' })[0];
          enqueue('102');
          const third = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          const expiredOutcome = postQueueService.releaseForRetry(
            { ...third.items[0], error_category: 'bsky-rate-limit', first_failure_at: Date.now() - 25 * 60 * 60 * 1000 }, limited, 1);
          const expired = postQueueService.inspect({ twitterId: '102', bskyIdentifier: 'storage-key' })[0];
          // An old failure of another kind does not count toward the rate-limit cap.
          enqueue('103');
          const fourth = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          const mixedOutcome = postQueueService.releaseForRetry(
            { ...fourth.items[0], error_category: 'timeout', first_failure_at: Date.now() - 25 * 60 * 60 * 1000 }, limited, 1);
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            expired: { status: expired.status, attempts: expired.attempts, outcome: expiredOutcome },
            mixedOutcome,
            deferred: { status: deferred.status, attempts: deferred.attempts, category: deferred.error_category,
              notBeforeIsReset: Math.abs(deferred.not_before - resetSeconds * 1000) < 1000 },
            parked: { status: parked.status, attempts: parked.attempts },
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      // After a day of rate limits the row spends attempts and can park again.
      expired: { status: 'failed', attempts: 1, outcome: 'parked' },
      mixedOutcome: 'retrying',
      deferred: { status: 'pending', attempts: 0, category: 'bsky-rate-limit', notBeforeIsReset: true },
      parked: { status: 'failed', attempts: 1 },
    });
  } finally {
    temporary.cleanup();
  }
}, 30000);
