import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;

/**
 * Runs `script` in a fresh Bun process against an isolated data directory, so
 * every case exercises real SQLite behaviour (including transactions) without
 * touching the developer's database. `result` is whatever the script writes.
 */
async function runInIsolatedDatabase(
  script: (context: { dbModule: string; resultPath: string }) => string,
): Promise<unknown> {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        script({ dbModule: JSON.stringify(dbModuleUrl), resultPath: JSON.stringify(resultPath) }),
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally {
    temporary.cleanup();
  }
}

test('a digest run only marks the entries it rendered as delivered', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { digestEntryService, digestJobService } = await import(${dbModule});
    const post = (id) => ({
      sourceType: 'x',
      sourceId: 'source',
      externalId: id,
      text: 'entry ' + id,
      createdAt: new Date(1000).toISOString(),
      urls: [],
      sensitive: false,
      media: [],
    });
    for (const id of ['a', 'b', 'c', 'd']) {
      digestEntryService.enqueue({
        destinationId: 'destination',
        routeId: 'route',
        post: post(id),
        createdAt: 1000 + id.charCodeAt(0),
      });
    }
    digestJobService.arm('destination', 'route', 1);

    // A route configured for two entries per digest must not claim four.
    const claimed = digestJobService.claimNext(new Set(), 5000, 200, () => 2);
    const afterClaim = digestEntryService.list({ routeId: 'route' }).map((entry) => [entry.id, entry.status]);

    // Only the first claimed entry was actually rendered.
    const completed = digestJobService.complete(claimed.id, claimed.claimToken, 9000, 8000, [
      claimed.entryIds[0],
    ]);
    const afterComplete = digestEntryService.list({ routeId: 'route' }).map((entry) => [entry.id, entry.status]);

    // The unrendered entry must be claimable by the next run.
    digestJobService.arm('destination', 'route', 1);
    const second = digestJobService.claimNext(new Set(), 10000, 200, () => 2);

    await Bun.write(${resultPath}, JSON.stringify({
      claimedEntryIds: claimed.entryIds,
      afterClaim,
      completed,
      afterComplete,
      secondClaimEntryIds: second.entryIds,
    }));
  `);

  expect(result.claimedEntryIds).toEqual([1, 2]);
  expect(result.afterClaim).toEqual([
    [1, 'claimed'],
    [2, 'claimed'],
    [3, 'pending'],
    [4, 'pending'],
  ]);
  expect(result.completed).toBe(true);
  expect(result.afterComplete).toEqual([
    [1, 'delivered'],
    [2, 'pending'],
    [3, 'pending'],
    [4, 'pending'],
  ]);
  expect(result.secondClaimEntryIds).toEqual([2, 3]);
});

test('digest entries can be listed and released per job', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { digestEntryService, digestJobService } = await import(${dbModule});
    const post = (id) => ({
      sourceType: 'x', sourceId: 'source', externalId: id, text: 'entry ' + id,
      createdAt: new Date(1000).toISOString(), urls: [], sensitive: false, media: [],
    });
    digestEntryService.enqueue({ destinationId: 'destination', routeId: 'route', post: post('a'), createdAt: 1001 });
    digestEntryService.enqueue({ destinationId: 'destination', routeId: 'route', post: post('b'), createdAt: 1002 });
    digestJobService.arm('destination', 'route', 1);
    const claimed = digestJobService.claimNext(new Set(), 5000, 200, () => 2);
    const scopedToJob = digestEntryService
      .list({ routeId: 'route', status: 'claimed', jobId: claimed.id, limit: 10 })
      .map((entry) => entry.id);
    const scopedToOtherJob = digestEntryService
      .list({ routeId: 'route', status: 'claimed', jobId: 'digest:other:job', limit: 10 })
      .map((entry) => entry.id);
    const released = digestJobService.releaseEntries(claimed.id, claimed.claimToken, [2]);
    const statuses = digestEntryService.list({ routeId: 'route' }).map((entry) => [entry.id, entry.status]);
    const retainedEntryIds = digestJobService.get(claimed.id).entryIds;
    await Bun.write(${resultPath}, JSON.stringify({
      scopedToJob, scopedToOtherJob, released, statuses, retainedEntryIds,
    }));
  `);

  expect(result.scopedToJob).toEqual([1, 2]);
  expect(result.scopedToOtherJob).toEqual([]);
  expect(result.released).toBe(true);
  expect(result.statuses).toEqual([
    [1, 'claimed'],
    [2, 'pending'],
  ]);
  expect(result.retainedEntryIds).toEqual([1]);
});

test('digest entries retain wrapper fallback provenance and expose its diagnostic', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { digestEntryService } = await import(${dbModule});
    digestEntryService.enqueue({
      destinationId: 'destination',
      routeId: 'route',
      post: {
        sourceType: 'x',
        sourceId: 'source',
        externalId: 'wrapper-fallback',
        text: 'RT @author: Wrapper body…',
        createdAt: new Date(1000).toISOString(),
        urls: ['https://x.com/source/status/wrapper-fallback'],
        sensitive: false,
        repostOf: { sourceType: 'x', sourceId: 'source', externalId: 'original' },
        repostContentSource: 'wrapper',
        media: [],
      },
      createdAt: 1001,
    });
    const [entry] = digestEntryService.list({ routeId: 'route' });
    await Bun.write(${resultPath}, JSON.stringify({
      provenance: entry.post.repostContentSource,
      diagnostics: entry.deliveryDiagnostics,
    }));
  `);

  expect(result.provenance).toBe('wrapper');
  expect(result.diagnostics).toEqual([{
    kind: 'repost-wrapper-fallback',
    reason: 'The scraper did not provide nested repost content; wrapper text and the X status link were retained.',
  }]);
});

test('backfill requests survive a process restart and a transient failure', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { backfillJobService } = await import(${dbModule});
    backfillJobService.upsert({
      id: 'request-1',
      destinationId: 'destination',
      sourceUsernames: ['alice'],
      limit: 25,
      queuedAt: 1000,
    });
    backfillJobService.upsert({ id: 'request-2', destinationId: 'other', limit: 15, queuedAt: 2000 });

    // A worker takes the job and then hits a transient Bluesky auth failure.
    const claimed = backfillJobService.claim('request-1', 3000);
    const rescheduled = backfillJobService.reschedule({
      id: 'request-1',
      claimToken: claimed.claimToken,
      error: new Error('Bluesky login failed'),
      category: 'bsky-auth',
      retryable: true,
      now: 4000,
    });
    // Not yet due, so it must not be handed out again immediately...
    const dueTooEarly = backfillJobService.listDue(4500).map((job) => job.id);
    // ...but it is still queued, in submission order, once the backoff elapses.
    const dueLater = backfillJobService.listDue(4000 + 10 * 60 * 1000).map((job) => job.id);

    // Simulate a crash mid-backfill, then restart recovery.
    const secondClaim = backfillJobService.claim('request-2', 5000);
    const reset = backfillJobService.resetProcessing(6000);
    const afterRestart = backfillJobService.list().map((job) => [job.id, job.status, job.attempts]);

    // A terminal failure stops retrying but stays visible for an operator.
    const terminalClaim = backfillJobService.claim('request-2', 7000);
    const terminal = backfillJobService.reschedule({
      id: 'request-2',
      claimToken: terminalClaim.claimToken,
      error: new Error('Destination was deleted'),
      category: 'config',
      retryable: false,
      now: 7000,
    });
    const retried = backfillJobService.retry('request-2', 8000);

    await Bun.write(${resultPath}, JSON.stringify({
      claimedAttempts: claimed.attempts,
      claimedUsernames: claimed.sourceUsernames,
      claimedLimit: claimed.limit,
      rescheduledStatus: rescheduled.status,
      rescheduledCategory: rescheduled.lastErrorCategory,
      rescheduledNotBefore: rescheduled.notBefore > 4000,
      dueTooEarly,
      dueLater,
      secondClaimStatus: secondClaim.status,
      reset,
      afterRestart,
      terminalStatus: terminal.status,
      retried,
      retriedStatus: backfillJobService.get('request-2').status,
    }));
  `);

  expect(result.claimedAttempts).toBe(1);
  expect(result.claimedUsernames).toEqual(['alice']);
  expect(result.claimedLimit).toBe(25);
  // A transient failure reschedules instead of dropping the request.
  expect(result.rescheduledStatus).toBe('pending');
  expect(result.rescheduledCategory).toBe('bsky-auth');
  expect(result.rescheduledNotBefore).toBe(true);
  expect(result.dueTooEarly).toEqual(['request-2']);
  expect(result.dueLater).toEqual(['request-1', 'request-2']);
  expect(result.secondClaimStatus).toBe('processing');
  expect(result.reset).toBe(1);
  expect(result.afterRestart).toEqual([
    ['request-1', 'pending', 1],
    ['request-2', 'pending', 1],
  ]);
  expect(result.terminalStatus).toBe('failed');
  expect(result.retried).toBe(true);
  expect(result.retriedStatus).toBe('pending');
});

test('destination leases are exclusive across processes, renewable, and expiring', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { destinationLeaseService } = await import(${dbModule});
    const first = destinationLeaseService.acquire({
      destinationKey: 'destination', ownerId: 'replica-a', ttlMs: 30000, now: 1000,
    });
    // A second replica must not be able to take a live lease.
    const contended = destinationLeaseService.acquire({
      destinationKey: 'destination', ownerId: 'replica-b', ttlMs: 30000, now: 2000,
    });
    const blockedForB = destinationLeaseService.listHeldByOthers('replica-b', 2000);
    const blockedForA = destinationLeaseService.listHeldByOthers('replica-a', 2000);
    const renewed = destinationLeaseService.renew('destination', 'replica-a', 30000, 3000);
    const renewedByStranger = destinationLeaseService.renew('destination', 'replica-b', 30000, 3000);
    // A crashed owner must not deadlock the destination forever.
    const afterExpiry = destinationLeaseService.acquire({
      destinationKey: 'destination', ownerId: 'replica-b', ttlMs: 30000, now: 100000,
    });
    const releasedByStranger = destinationLeaseService.release('destination', 'replica-a');
    const released = destinationLeaseService.release('destination', 'replica-b');
    const afterRelease = destinationLeaseService.get('destination');

    destinationLeaseService.acquire({
      destinationKey: 'other', ownerId: 'replica-a', ttlMs: 30000, now: 1000,
    });
    const releasedOwner = destinationLeaseService.releaseOwner('replica-a');

    await Bun.write(${resultPath}, JSON.stringify({
      firstOwner: first && first.ownerId,
      contended,
      blockedForB,
      blockedForA,
      renewed,
      renewedByStranger,
      afterExpiryOwner: afterExpiry && afterExpiry.ownerId,
      releasedByStranger,
      released,
      afterRelease,
      releasedOwner,
    }));
  `);

  expect(result.firstOwner).toBe('replica-a');
  expect(result.contended).toBeNull();
  expect(result.blockedForB).toEqual(['destination']);
  expect(result.blockedForA).toEqual([]);
  expect(result.renewed).toBe(true);
  expect(result.renewedByStranger).toBe(false);
  expect(result.afterExpiryOwner).toBe('replica-b');
  expect(result.releasedByStranger).toBe(false);
  expect(result.released).toBe(true);
  expect(result.afterRelease).toBeNull();
  expect(result.releasedOwner).toBe(1);
});

test('a content fingerprint reservation records the candidate it allowed', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { duplicateFingerprintService } = await import(${dbModule});
    const base = {
      destinationId: 'destination',
      routeId: 'route',
      textUrlHash: 'text-hash',
      since: 0,
      createdAt: 1000,
    };
    // The first candidate is allowed and recorded in the same transaction.
    const first = duplicateFingerprintService.reserve({ ...base, externalPostId: 'post-1' });
    // Identical content therefore cannot be reprocessed forever.
    const second = duplicateFingerprintService.reserve({ ...base, externalPostId: 'post-2', createdAt: 2000 });
    // Perceptual image matches are caught the same way.
    const imageFirst = duplicateFingerprintService.reserve({
      ...base, externalPostId: 'post-3', textUrlHash: 'other-text', imageHash: 'image-hash', createdAt: 3000,
    });
    const imageSecond = duplicateFingerprintService.reserve({
      ...base, externalPostId: 'post-4', textUrlHash: 'different-text', imageHash: 'image-hash', createdAt: 4000,
    });
    // A reservation for a post that never shipped is released again.
    const releasedReservation = duplicateFingerprintService.reserve({
      ...base, externalPostId: 'post-5', textUrlHash: 'abandoned', createdAt: 5000,
    });
    const released = duplicateFingerprintService.release(releasedReservation.fingerprintId);
    const reusableAfterRelease = duplicateFingerprintService.reserve({
      ...base, externalPostId: 'post-6', textUrlHash: 'abandoned', createdAt: 6000,
    });

    await Bun.write(${resultPath}, JSON.stringify({
      firstAllowed: first.duplicate === null,
      firstRecorded: typeof first.fingerprintId === 'number',
      secondDuplicateOf: second.duplicate && second.duplicate.externalPostId,
      secondRecorded: second.fingerprintId === undefined,
      imageFirstAllowed: imageFirst.duplicate === null,
      imageSecondDuplicateOf: imageSecond.duplicate && imageSecond.duplicate.externalPostId,
      released,
      reusableAfterRelease: reusableAfterRelease.duplicate === null,
    }));
  `);

  expect(result.firstAllowed).toBe(true);
  expect(result.firstRecorded).toBe(true);
  expect(result.secondDuplicateOf).toBe('post-1');
  expect(result.secondRecorded).toBe(true);
  expect(result.imageFirstAllowed).toBe(true);
  expect(result.imageSecondDuplicateOf).toBe('post-3');
  expect(result.released).toBe(true);
  expect(result.reusableAfterRelease).toBe(true);
});

test('a queue claim takes a destination lease and every row keeps a stable queue id', async () => {
  const result = await runInIsolatedDatabase(({ dbModule, resultPath }) => `
    const { postQueueService, destinationLeaseService } = await import(${dbModule});
    const base = {
      source_type: 'x',
      twitter_username: 'source',
      kind: 'scheduled',
      tweet_json: '{}',
      policy_version: 1,
    };
    postQueueService.enqueue([
      { ...base, twitter_id: '1', external_post_id: '1', bsky_identifier: 'dest.example',
        mapping_id: 'mapping', destination_id: 'destination', route_id: 'route', source_id: 'source-x' },
      { ...base, twitter_id: '2', external_post_id: '2', bsky_identifier: 'dest.example',
        mapping_id: 'mapping', destination_id: 'destination', route_id: 'route', source_id: 'source-x' },
    ]);
    // A generic post that reuses external id '1' is a distinct canonical identity.
    const generic = postQueueService.enqueue([
      { ...base, source_type: 'api', twitter_id: 'api:source-api:1', external_post_id: '1',
        bsky_identifier: 'dest.example', mapping_id: 'mapping', destination_id: 'destination',
        route_id: 'route', source_id: 'source-api' },
    ]);
    // The same canonical identity re-offered under a renamed storage key is a
    // duplicate: the legacy key alone would have queued the post twice.
    const rekeyedDuplicate = postQueueService.enqueue([
      { ...base, twitter_id: '1', external_post_id: '1', bsky_identifier: 'renamed.example',
        mapping_id: 'mapping', destination_id: 'destination', route_id: 'route', source_id: 'source-x' },
    ]);

    const queueIds = postQueueService.getQueueIds({ destinationId: 'destination' });
    const allowed = new Set(['mapping']);
    const leaseAttempts = [];
    const batch = postQueueService.claimNextBatch(new Set(), allowed, () => 'destination', 50, (key) => {
      const lease = destinationLeaseService.acquire({
        destinationKey: key, ownerId: 'replica-a', ttlMs: 30000, now: 1000,
      });
      leaseAttempts.push(key);
      return lease !== null;
    });
    const leaseOwner = destinationLeaseService.get('destination');

    // A replica that cannot take the lease claims nothing at all.
    const blocked = postQueueService.claimNextBatch(new Set(), allowed, () => 'destination', 50, (key) =>
      destinationLeaseService.acquire({
        destinationKey: key, ownerId: 'replica-b', ttlMs: 30000, now: 2000,
      }) !== null
    );

    const item = postQueueService.getItem({ queueId: queueIds[0] });
    postQueueService.markDoneById(queueIds[0]);
    const remaining = postQueueService.getQueueIds({ destinationId: 'destination' });

    await Bun.write(${resultPath}, JSON.stringify({
      generic,
      rekeyedDuplicate,
      queueIdCount: queueIds.length,
      uniqueQueueIds: new Set(queueIds).size,
      batchSize: batch ? batch.items.length : 0,
      batchQueueIds: batch ? batch.items.map((entry) => entry.queue_id) : [],
      leaseAttempts,
      leaseOwner: leaseOwner && leaseOwner.ownerId,
      blocked,
      itemFoundByQueueId: item ? item.twitter_id : null,
      remainingCount: remaining.length,
    }));
  `);

  expect(result.generic).toBe(1);
  expect(result.rekeyedDuplicate).toBe(0);
  expect(result.queueIdCount).toBe(3);
  expect(result.uniqueQueueIds).toBe(3);
  expect(result.batchSize).toBeGreaterThan(0);
  expect(result.batchQueueIds.every((id: unknown) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(result.leaseAttempts).toEqual(['destination']);
  expect(result.leaseOwner).toBe('replica-a');
  expect(result.blocked).toBeNull();
  expect(result.itemFoundByQueueId).toBe('1');
  expect(result.remainingCount).toBe(2);
});
