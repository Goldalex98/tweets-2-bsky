import { describe, expect, test } from 'bun:test';
import type { QueueBatch, QueueItem } from '../../src/db.js';
import {
  DestinationQueueWorkerService,
  type QueueWorkerDependencies,
} from '../../src/services/queue-worker-service.js';

interface TestConfig {
  destinations: Array<{
    id: string;
    enabled: boolean;
    metadata: { legacyMappingIds: string[] };
  }>;
}

interface TestMapping {
  id: string;
  bskyIdentifier: string;
}

function item(id: string, attempts = 0): QueueItem {
  return {
    queue_id: `queue-${id}`,
    twitter_id: id,
    bsky_identifier: 'destination.test',
    mapping_id: 'legacy',
    twitter_username: 'source',
    source_type: 'x',
    external_post_id: id,
    destination_id: 'destination',
    policy_version: 1,
    decision_version: 1,
    kind: 'scheduled',
    tweet_json: '{}',
    status: 'processing',
    attempts,
    not_before: 0,
    enqueued_at: 1,
    updated_at: 1,
  };
}

function batch(items: QueueItem[]): QueueBatch {
  return {
    mapping_id: 'legacy',
    bsky_identifier: 'destination.test',
    destination_id: 'destination',
    destination_key: 'destination',
    twitter_username: 'source',
    items,
  };
}

function dependencies(
  batches: QueueBatch[],
  options: {
    delivery?: () => Promise<void>;
    settlements?: Map<string, { status: string }>;
    leases?: QueueWorkerDependencies<TestConfig, TestMapping>['leases'];
  } = {},
): {
  value: QueueWorkerDependencies<TestConfig, TestMapping>;
  events: string[];
  metrics: Map<string, number>;
} {
  const events: string[] = [];
  const metrics = new Map<string, number>();
  const config: TestConfig = {
    destinations: [{ id: 'destination', enabled: true, metadata: { legacyMappingIds: ['legacy'] } }],
  };
  return {
    events,
    metrics,
    value: {
      clock: { now: () => 100 },
      sleep: async () => {},
      getConfig: () => config,
      findMapping: (_config, id) =>
        id === 'legacy' ? { id: 'destination', bskyIdentifier: 'destination.test' } : undefined,
      claimNextBatch: (active, allowed, resolveKey, acquireLease) => {
        expect(allowed.has('legacy')).toBe(true);
        expect(resolveKey('legacy')).toBe('destination');
        const next = batches[0];
        if (!next || active.has(next.destination_key)) return null;
        if (acquireLease && !acquireLease(next.destination_key)) return null;
        return batches.shift() ?? null;
      },
      ...(options.leases ? { leases: options.leases } : {}),
      deleteByMappingId: (id) => events.push(`delete:${id}`),
      deliver: options.delivery ?? (async () => {}),
      findSettlement: (queueItem) => options.settlements?.get(queueItem.twitter_id) ?? null,
      markDone: (queueItem) => events.push(`done:${queueItem.twitter_id}`),
      releaseForRetry: (queueItem, _error, maxAttempts) =>
        events.push(`retry:${queueItem.twitter_id}:${maxAttempts}`),
      describeError: (error) => (error instanceof Error ? error.message : String(error)),
      classifyError: () => 'delivery',
      metrics: {
        increment: (name, amount) => metrics.set(name, (metrics.get(name) ?? 0) + amount),
        observe: (name, amount) => metrics.set(name, amount),
      },
      recordDestinationFailure: (id, category) => events.push(`failure:${id}:${category}`),
      notifyParked: (id, count) => events.push(`parked:${id}:${count}`),
      updateJob: (id, patch) => events.push(`job:${id}:${patch ? 'start' : 'stop'}`),
    },
  };
}

describe('DestinationQueueWorkerService', () => {
  test('serializes claims by canonical destination and always releases the lock', async () => {
    let finishDelivery!: () => void;
    const first = batch([item('one')]);
    const second = batch([item('two')]);
    const harness = dependencies([first, second], {
      delivery: () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    });
    const service = new DestinationQueueWorkerService(harness.value, 2, 3);

    expect(service.scheduleAvailable()).toBe(1);
    expect(service.activeDestinations.has('destination')).toBe(true);
    expect(service.scheduleAvailable()).toBe(0);

    finishDelivery();
    await service.waitForIdle();
    expect(service.activeDestinations.has('destination')).toBe(false);
    expect(service.scheduleAvailable()).toBe(1);
  });

  test('settles completed, skipped, retried, and parked rows deterministically', async () => {
    const rows = [item('posted'), item('skipped'), item('retry', 0), item('parked', 2)];
    const harness = dependencies([], {
      delivery: async () => {
        throw new Error('network failed');
      },
      settlements: new Map([
        ['posted', { status: 'migrated' }],
        ['skipped', { status: 'skipped' }],
      ]),
    });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);

    const result = await service.runBatch(
      { id: 'destination', bskyIdentifier: 'destination.test' },
      batch(rows),
    );

    expect(result).toMatchObject({ posted: 1, skipped: 1, retrying: 1, parked: 1 });
    expect(harness.events).toContain('done:posted');
    expect(harness.events).toContain('done:skipped');
    expect(harness.events).toContain('retry:retry:3');
    expect(harness.events).toContain('retry:parked:3');
    expect(harness.events).toContain('failure:destination:delivery');
    expect(harness.events).toContain('parked:destination:1');
    expect(harness.metrics.get('posted')).toBe(1);
    expect(harness.metrics.get('failed')).toBe(1);
  });
});

/** A shared SQLite-backed lease table, as seen by one replica. */
function leaseTable() {
  const holders = new Map<string, string>();
  const events: string[] = [];
  const forReplica = (replica: string) => ({
    heldByOthers: () =>
      [...holders.entries()].filter(([, owner]) => owner !== replica).map(([key]) => key),
    acquire: (key: string) => {
      const owner = holders.get(key);
      if (owner && owner !== replica) return false;
      holders.set(key, replica);
      events.push(`acquire:${replica}:${key}`);
      return true;
    },
    renew: (key: string) => {
      if (holders.get(key) !== replica) return false;
      events.push(`renew:${replica}:${key}`);
      return true;
    },
    release: (key: string) => {
      if (holders.get(key) !== replica) return;
      holders.delete(key);
      events.push(`release:${replica}:${key}`);
    },
  });
  return { holders, events, forReplica };
}

describe('cross-process destination leases', () => {
  test('a second replica cannot claim a destination another replica holds', async () => {
    const table = leaseTable();
    let finishDelivery!: () => void;
    const replicaA = dependencies([batch([item('one')])], {
      leases: table.forReplica('replica-a'),
      delivery: () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    });
    const replicaB = dependencies([batch([item('two')])], {
      leases: table.forReplica('replica-b'),
    });
    // Separate processes, so the in-memory active set cannot help.
    const workerA = new DestinationQueueWorkerService(replicaA.value, 2, 3, new Set());
    const workerB = new DestinationQueueWorkerService(replicaB.value, 2, 3, new Set());

    expect(workerA.scheduleAvailable()).toBe(1);
    expect(table.holders.get('destination')).toBe('replica-a');
    expect(workerB.scheduleAvailable()).toBe(0);

    // A slow batch keeps its lease alive rather than letting it lapse.
    workerA.renewLeases();
    expect(table.events).toContain('renew:replica-a:destination');

    finishDelivery();
    await workerA.waitForIdle();
    expect(table.holders.has('destination')).toBe(false);
    expect(workerB.scheduleAvailable()).toBe(1);
  });

  test('a lease taken for an empty claim is released immediately', () => {
    const table = leaseTable();
    const harness = dependencies([], { leases: table.forReplica('replica-a') });
    // No batches, but the claim path still resolves and locks the destination.
    harness.value.claimNextBatch = (_active, _allowed, _resolveKey, acquireLease) => {
      acquireLease?.('destination');
      return null;
    };
    const worker = new DestinationQueueWorkerService(harness.value, 1, 3, new Set());

    expect(worker.scheduleAvailable()).toBe(0);
    // Without this the destination would be unusable until the lease expired.
    expect(table.holders.has('destination')).toBe(false);
    expect(table.events).toEqual(['acquire:replica-a:destination', 'release:replica-a:destination']);
  });

  test('a batch for an unknown mapping releases its lease before being discarded', () => {
    const table = leaseTable();
    const orphan: QueueBatch = { ...batch([item('one')]), mapping_id: 'vanished' };
    const harness = dependencies([orphan], { leases: table.forReplica('replica-a') });
    const worker = new DestinationQueueWorkerService(harness.value, 1, 3, new Set());

    expect(worker.scheduleAvailable()).toBe(0);
    expect(harness.events).toContain('delete:vanished');
    expect(table.holders.has('destination')).toBe(false);
  });

  test('leases are ignored entirely when no lease store is wired', () => {
    const harness = dependencies([batch([item('one')])]);
    const worker = new DestinationQueueWorkerService(harness.value, 1, 3, new Set());

    expect(worker.scheduleAvailable()).toBe(1);
    worker.renewLeases();
  });
});
