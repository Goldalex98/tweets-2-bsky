import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('queue scopes preserve active safety and delivery checkpoints resume after a crash', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'operations-result.json');
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const {
            dbService,
            deliveryCheckpointService,
            postQueueService,
          } = await import(${JSON.stringify(dbModuleUrl)});
          const enqueue = (id, route, source, request) => postQueueService.enqueue([{
            twitter_id: id,
            bsky_identifier: 'storage-key',
            mapping_id: 'destination-1',
            twitter_username: 'source',
            source_type: 'x',
            external_post_id: id,
            destination_id: 'destination-1',
            route_id: route,
            source_id: source,
            request_id: request,
            policy_version: 4,
            policy_snapshot: JSON.stringify({ reposts: false }),
            kind: 'scheduled',
            tweet_json: '{}',
            tweet_text: 'queued ' + id,
          }]);
          enqueue('100', 'route-a', 'source-a', 'request-a');
          enqueue('101', 'route-b', 'source-b', 'request-b');
          const first = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          postQueueService.releaseForRetry(first.items[0], new Error('Bearer secret-token request timed out'), 1);
          const failedDiagnostic = postQueueService.inspect({ routeId: 'route-a' })[0];
          const attemptsAtTerminalFailure = failedDiagnostic.attempts;
          const retried = postQueueService.retryFailed({ requestId: 'request-a' });
          // Terminal failure already spent the attempt budget; a retry must
          // reset it so the item gets a full set of attempts again instead
          // of being one delivery failure away from being parked right away.
          const attemptsAfterRetry = postQueueService.inspect({ requestId: 'request-a' })[0].attempts;
          const active = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          const cancelled = postQueueService.cancelPending({ destinationId: 'destination-1' });
          const activeAfterCancel = postQueueService.inspect({
            twitterId: active.items[0].twitter_id,
            bskyIdentifier: active.items[0].bsky_identifier,
          })[0];

          enqueue('300', 'route-d', 'source-d', 'request-d');
          const forSnapshotRewrite = postQueueService.claimNextBatch(new Set(), new Set(['destination-1']), undefined, 1);
          postQueueService.releaseForRetry(forSnapshotRewrite.items[0], new Error('simulated failure'), 1);
          const attemptsBeforeSnapshotRewrite = postQueueService.inspect({ routeId: 'route-d' })[0].attempts;
          // A failed row's policy snapshot can be rewritten (e.g. after a
          // policy edit) without going through retry-failed; that requeue
          // path must reset attempts too, or the row is one delivery away
          // from being parked again despite never having retried under the
          // new policy.
          postQueueService.rewritePolicySnapshots(
            { routeId: 'route-d' },
            'admin-actor',
            'integration test snapshot rewrite',
            (item) => ({
              policyVersion: item.policy_version + 1,
              policySnapshot: JSON.stringify({ reposts: true }),
              decisionVersion: 1,
              decisionTrace: '[]',
            }),
          );
          const afterSnapshotRewrite = postQueueService.inspect({ routeId: 'route-d' })[0];

          enqueue('200', 'route-c', 'source-c', 'request-c');
          const chunks = ['one (1/3)', 'two (2/3)', 'three (3/3)'];
          deliveryCheckpointService.initialize(
            'destination-1',
            '200',
            chunks.map((text, index) => ({
              contentHash: String(index) + ':' + text,
              createdAt: new Date(1000 + index * 1000).toISOString(),
            })),
          );
          const calls = [];
          const agent = {
            failOnce: true,
            async post(index) {
              calls.push(index);
              if (index === 1 && this.failOnce) {
                this.failOnce = false;
                throw new Error('simulated crash');
              }
              return { uri: 'at://did/post/' + index, cid: 'cid-' + index };
            },
          };
          const deliver = async () => {
            const start = deliveryCheckpointService.firstMissing('destination-1', '200');
            const saved = deliveryCheckpointService.list('destination-1', '200');
            for (let index = start; index < chunks.length; index++) {
              const response = await agent.post(index);
              const previous = index > 0 ? deliveryCheckpointService.list('destination-1', '200')[index - 1] : undefined;
              const root = previous?.root || (previous?.uri && previous?.cid
                ? { uri: previous.uri, cid: previous.cid }
                : { uri: response.uri, cid: response.cid });
              const parent = previous?.uri && previous?.cid ? { uri: previous.uri, cid: previous.cid } : undefined;
              deliveryCheckpointService.recordSuccess({
                destinationId: 'destination-1',
                externalPostId: '200',
                chunkIndex: index,
                uri: response.uri,
                cid: response.cid,
                root,
                parent,
                tail: { uri: response.uri, cid: response.cid },
              });
            }
          };
          try { await deliver(); } catch {}
          const firstMissingAfterCrash = deliveryCheckpointService.firstMissing('destination-1', '200');
          await deliver();
          const checkpoints = deliveryCheckpointService.list('destination-1', '200');
          deliveryCheckpointService.finalize({
            twitter_id: '200',
            twitter_username: 'source',
            bsky_identifier: 'storage-key',
            source_type: 'x',
            external_post_id: '200',
            destination_id: 'destination-1',
            route_id: 'route-c',
            source_id: 'source-c',
            policy_version: 4,
            policy_snapshot: JSON.stringify({ reposts: false }),
            bsky_uri: checkpoints[0].uri,
            bsky_cid: checkpoints[0].cid,
            bsky_root_uri: checkpoints[0].root.uri,
            bsky_root_cid: checkpoints[0].root.cid,
            bsky_tail_uri: checkpoints[2].uri,
            bsky_tail_cid: checkpoints[2].cid,
            status: 'migrated',
          });
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            diagnosticRedacted: !failedDiagnostic.redacted_diagnostic.includes('secret-token'),
            category: failedDiagnostic.error_category,
            firstFailureAt: failedDiagnostic.first_failure_at,
            lastFailureAt: failedDiagnostic.last_failure_at,
            policyBehavior: failedDiagnostic.policy_behavior,
            attemptsAtTerminalFailure,
            attemptsAfterRetry,
            attemptsBeforeSnapshotRewrite,
            statusAfterSnapshotRewrite: afterSnapshotRewrite.status,
            attemptsAfterSnapshotRewrite: afterSnapshotRewrite.attempts,
            retried,
            cancelled,
            activeStatus: activeAfterCancel.status,
            firstMissingAfterCrash,
            calls,
            checkpointCount: checkpoints.length,
            refsPreserved: checkpoints[2].parent.uri === checkpoints[1].uri &&
              checkpoints[2].root.uri === checkpoints[0].uri,
            completed: Boolean(dbService.getPost('200', 'destination-1')),
            queueRemoved: postQueueService.inspect({ twitterId: '200' }).length === 0,
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toMatchObject({
      diagnosticRedacted: true,
      category: 'timeout',
      policyBehavior: 'snapshotted',
      attemptsAtTerminalFailure: 1,
      attemptsAfterRetry: 0,
      attemptsBeforeSnapshotRewrite: 1,
      statusAfterSnapshotRewrite: 'pending',
      attemptsAfterSnapshotRewrite: 0,
      retried: 1,
      cancelled: 1,
      activeStatus: 'processing',
      firstMissingAfterCrash: 1,
      calls: [0, 1, 1, 2],
      checkpointCount: 3,
      refsPreserved: true,
      completed: true,
      queueRemoved: true,
    });
  } finally {
    temporary.cleanup();
  }
});
