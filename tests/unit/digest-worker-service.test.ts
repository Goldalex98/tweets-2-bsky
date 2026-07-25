import { describe, expect, test } from 'bun:test';
import type { DigestPolicy } from '../../src/config/schemas.js';
import type { DigestEntry, DigestJob } from '../../src/db.js';
import { POLICY_SNAPSHOT_VERSION } from '../../src/policy-snapshot.js';
import {
  type DigestCheckpoint,
  DigestWorkerService,
  selectSnapshotCohort,
} from '../../src/services/digest-worker-service.js';

const policy: DigestPolicy = {
  enabled: true,
  cadence: 'daily',
  timezone: 'UTC',
  hour: 12,
  minute: 0,
  grouping: 'none',
  template: '{entries}',
  maxEntries: 10,
  maxGraphemes: 1_000,
  includeSourceAttribution: false,
};

/** A serialized snapshot carrying the digest policy an entry was routed under. */
const snapshotWith = (hash: string, digest: Partial<DigestPolicy>): string =>
  JSON.stringify({
    version: POLICY_SNAPSHOT_VERSION,
    hash,
    routeDelivery: { mode: 'digest', digest: { ...policy, ...digest } },
  });

const job: DigestJob = {
  id: 'digest:destination:route',
  destinationId: 'destination',
  routeId: 'route',
  status: 'processing',
  nextRunAt: 1_000,
  claimToken: 'claim',
  attempts: 0,
  notBefore: 0,
  checkpoint: 1,
  entryIds: [1],
};

const entry: DigestEntry = {
  id: 1,
  destinationId: 'destination',
  routeId: 'route',
  sourceId: 'source',
  sourceType: 'x',
  externalPostId: 'post',
  post: {
    sourceType: 'x',
    sourceId: 'source',
    externalId: 'post',
    text: 'entry',
    createdAt: new Date(1_000).toISOString(),
    urls: [],
    media: [],
  },
  status: 'claimed',
  jobId: job.id,
  createdAt: 1_000,
};

interface HarnessOptions {
  claimedEntries?: DigestEntry[];
  renderedEntryIds?: number[];
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const active = new Set<string>();
  const previewPolicies: DigestPolicy[] = [];
  let checkpoints: DigestCheckpoint[] = [
    {
      uri: 'at://first',
      cid: 'first',
      root: { uri: 'at://first', cid: 'first' },
      tail: { uri: 'at://first', cid: 'first' },
      completedAt: 1,
    },
    {},
  ];
  const pendingJobs: DigestJob[] = [];
  const service = new DigestWorkerService(
    {
      sleep: async () => {},
      getConfig: () => ({
        routes: [{ id: 'route', destinationId: 'destination', delivery: { mode: 'digest', digest: policy } }],
        destinations: [{ id: 'destination' }],
        mappings: [{ id: 'destination' }],
      }),
      jobs: {
        resetProcessing: () => {
          events.push('reset');
          return 1;
        },
        list: () => [],
        arm: (destinationId, routeId, nextRunAt) => {
          events.push(`arm:${destinationId}:${routeId}:${nextRunAt}`);
          return { ...job, nextRunAt };
        },
        claimNext: (excluded, resolveMaxEntries) => {
          const next = pendingJobs[0];
          if (!next || excluded.has(next.destinationId)) return null;
          events.push(`claim-limit:${resolveMaxEntries?.(next) ?? 'unbounded'}`);
          return pendingJobs.shift() ?? null;
        },
        checkpoint: (_id, _token, value) => {
          events.push(`checkpoint:${value}`);
          return true;
        },
        releaseEntries: (_id, _token, entryIds) => {
          events.push(`release:${[...entryIds].join(',')}`);
          return true;
        },
        complete: (_id, _token, _nextRunAt, deliveredEntryIds) => {
          events.push(`complete:${deliveredEntryIds ? [...deliveredEntryIds].join(',') : 'all'}`);
          return true;
        },
        fail: (_id, _token, error) => {
          events.push(`fail:${error instanceof Error ? error.message : String(error)}`);
          return true;
        },
      },
      entries: {
        list: () => options.claimedEntries ?? [entry],
      },
      checkpoints: {
        initialize: () => checkpoints,
        list: () => checkpoints,
        recordSuccess: (input) => {
          events.push(`saved:${input.chunkIndex}:${input.parent?.uri}`);
          checkpoints = [
            checkpoints[0] ?? {},
            {
              uri: input.uri,
              cid: input.cid,
              root: input.root,
              parent: input.parent,
              tail: input.tail,
              completedAt: 2,
            },
          ];
        },
      },
      delivery: {
        createSession: async () => ({
          publish: async (input) => {
            events.push(`publish:${input.chunk.index}:${input.reply?.parent.uri}`);
            return { uri: 'at://second', cid: 'second' };
          },
        }),
      },
      buildPreview: (_entries, previewPolicy) => {
        previewPolicies.push(previewPolicy);
        return {
          text: 'digest',
          entryIds: options.renderedEntryIds ?? [1],
          truncatedEntryIds: [],
          chunks: [
            { index: 0, count: 2, text: 'one', contentHash: 'one', idempotencyKey: 'one' },
            { index: 1, count: 2, text: 'two', contentHash: 'two', idempotencyKey: 'two' },
          ],
        };
      },
      nextRun: () => 5_000,
      metrics: {
        increment: (name) => events.push(`metric:${name}`),
      },
    },
    active,
  );
  return { service, events, active, pendingJobs, previewPolicies };
}

describe('DigestWorkerService', () => {
  test('re-arms configured jobs after resetting interrupted work', () => {
    const harness = createHarness();

    harness.service.initialize();

    expect(harness.events).toEqual(['reset', 'arm:destination:route:5000']);
  });

  test('resumes from delivery checkpoints and preserves thread replies', async () => {
    const harness = createHarness();

    await harness.service.execute(job);

    expect(harness.events).not.toContain('publish:0:undefined');
    expect(harness.events).toContain('publish:1:at://first');
    expect(harness.events).toContain('saved:1:at://first');
    expect(harness.events).toContain('checkpoint:2');
    expect(harness.events).toContain('complete:1');
    expect(harness.events).toContain('metric:digestRuns');
  });

  test('completes only the entries it rendered and releases the remainder', async () => {
    const claimed = [entry, { ...entry, id: 2, createdAt: 2_000 }, { ...entry, id: 3, createdAt: 3_000 }];
    const harness = createHarness({ claimedEntries: claimed, renderedEntryIds: [1, 2] });

    await harness.service.execute({ ...job, entryIds: [1, 2, 3] });

    // Entry 3 did not fit this digest; completing the whole claim used to mark
    // it delivered anyway, so it was never posted at all.
    expect(harness.events).toContain('release:3');
    expect(harness.events).toContain('complete:1,2');
  });

  test('a claim is capped at the route digest maximum', () => {
    const harness = createHarness();
    harness.pendingJobs.push({ ...job });

    expect(harness.service.scheduleNext()).toBe(true);
    expect(harness.events).toContain(`claim-limit:${policy.maxEntries}`);
  });

  test('an empty claim completes without marking anything delivered', async () => {
    const harness = createHarness({ claimedEntries: [] });

    await harness.service.execute(job);

    expect(harness.events).toContain('complete:');
    expect(harness.events).not.toContain('metric:digestFailures');
  });

  test('renders the snapshot cohort of the oldest entry and defers the others', async () => {
    const snapshotA = snapshotWith('hash-a', { maxEntries: 3, template: 'A {entries}' });
    const snapshotB = snapshotWith('hash-b', { maxEntries: 7, template: 'B {entries}' });
    const claimed = [
      { ...entry, id: 1, createdAt: 1_000, policySnapshot: snapshotA },
      { ...entry, id: 2, createdAt: 2_000, policySnapshot: snapshotB },
      { ...entry, id: 3, createdAt: 3_000, policySnapshot: snapshotA },
    ];
    const harness = createHarness({ claimedEntries: claimed, renderedEntryIds: [1, 3] });

    await harness.service.execute({ ...job, entryIds: [1, 2, 3] });

    // The stored policy renders the digest, not the route's current policy.
    expect(harness.previewPolicies[0]).toMatchObject({ maxEntries: 3, template: 'A {entries}' });
    expect(harness.events).toContain('release:2');
    expect(harness.events).toContain('complete:1,3');
  });

  test('shares destination locks with immediate workers', async () => {
    const harness = createHarness();
    harness.pendingJobs.push({ ...job });
    harness.active.add('destination');

    expect(harness.service.scheduleNext()).toBe(false);

    harness.active.delete('destination');
    expect(harness.service.scheduleNext()).toBe(true);
    expect(harness.active.has('destination')).toBe(true);
    await harness.service.waitForIdle();
    expect(harness.active.has('destination')).toBe(false);
  });
});

describe('selectSnapshotCohort', () => {
  test('splits entries by snapshot hash and keeps the oldest cohort', () => {
    const snapshotA = snapshotWith('hash-a', { maxEntries: 3 });
    const snapshotB = snapshotWith('hash-b', { maxEntries: 7 });
    const cohort = selectSnapshotCohort(
      [
        { ...entry, id: 2, createdAt: 2_000, policySnapshot: snapshotB },
        { ...entry, id: 1, createdAt: 1_000, policySnapshot: snapshotA },
        { ...entry, id: 4, createdAt: 4_000, policySnapshot: snapshotA },
      ],
      policy,
    );

    expect(cohort.policy.maxEntries).toBe(3);
    expect(cohort.entries.map((candidate) => candidate.id)).toEqual([1, 4]);
    expect(cohort.deferredEntryIds).toEqual([2]);
  });

  test('entries without a usable snapshot fall back to the current route policy', () => {
    const cohort = selectSnapshotCohort([{ ...entry, policySnapshot: undefined }], policy);

    expect(cohort.policy).toBe(policy);
    expect(cohort.snapshotHash).toBeUndefined();
    expect(cohort.deferredEntryIds).toEqual([]);
  });
});
