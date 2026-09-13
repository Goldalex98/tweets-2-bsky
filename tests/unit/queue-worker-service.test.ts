import { describe, expect, spyOn, test } from 'bun:test';
import type { QueueBatch, QueueItem } from '../../src/db.js';
import { assertDeliveryActive, deliverySignal, withDeliveryDeadline } from '../../src/services/delivery-context.js';
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
    settlements?: Map<string, { status: string; recordedAt?: number }>;
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
      deliver: async (_mapping, batch, context) => {
        for (const item of batch.items) context.markAttempted(item.queue_id);
        await options.delivery?.();
      },
      findSettlement: (queueItem) => options.settlements?.get(queueItem.twitter_id) ?? null,
      markDone: (queueItem) => events.push(`done:${queueItem.twitter_id}`),
      releaseForRetry: (queueItem, _error, maxAttempts) => events.push(`retry:${queueItem.twitter_id}:${maxAttempts}`),
      deferUnattempted: (queueItem, _error, notBefore) => events.push(`defer:${queueItem.twitter_id}:${notBefore}`),
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
  test('direct drain renews beyond the original lease expiry without starting workers or shutdown', async () => {
    let now = 0;
    const ttl = 5 * 60_000;
    let expiresAt = 0;
    let finish: (() => void) | undefined;
    let tick = () => {};
    const timer = {} as ReturnType<typeof setInterval>;
    const interval = spyOn(globalThis, 'setInterval').mockImplementation((callback, delay) => {
      expect(delay).toBe(1000);
      tick = () => callback();
      return timer;
    });
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const harness = dependencies([batch([item('first')])], {
      leases: {
        heldByOthers: () => [],
        acquire: () => {
          expiresAt = now + ttl;
          return true;
        },
        renew: () => {
          if (now >= expiresAt) return false;
          expiresAt = now + ttl;
          return true;
        },
        release: () => {
          expiresAt = 0;
        },
      },
      settlements: new Map([['first', { status: 'migrated' }]]),
      delivery: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);
    const draining = service.drain();
    try {
      expect(service.isStarted).toBe(false);
      for (now = 1000; now <= ttl + 60_000; now += 1000) {
        tick();
        // A competing owner cannot claim the still-running destination.
        expect(expiresAt).toBeGreaterThan(now);
      }
      expect(service.activeDestinations.has('destination')).toBe(true);
      finish?.();
      await draining;
      expect(harness.events).toContain('done:first');
      expect(expiresAt).toBe(0);
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      finish?.();
      await draining;
      interval.mockRestore();
      clear.mockRestore();
    }
  });

  test('an earlier timeout cannot hide subsequent lease loss from settlement', async () => {
    let ownsLease = true;
    let finish: (() => void) | undefined;
    const harness = dependencies([batch([item('first')])], {
      leases: { heldByOthers: () => [], acquire: () => true, renew: () => ownsLease, release: () => {} },
    });
    harness.value.deliver = async (_mapping, batch, context) => {
      context.markAttempted(batch.items[0]?.queue_id ?? '');
      await withDeliveryDeadline(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        5,
        'deadline',
      );
    };
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);
    service.scheduleAvailable();
    await Bun.sleep(20);
    ownsLease = false;
    service.renewLeases();
    finish?.();
    await service.waitForIdle();
    expect(
      harness.events.some(
        (event) => event.startsWith('defer:') || event.startsWith('retry:') || event.startsWith('done:'),
      ),
    ).toBe(false);
  });

  test('shutdown renews leases and waits for direct drain batches', async () => {
    let renewals = 0;
    let finish: (() => void) | undefined;
    const harness = dependencies([batch([item('first')])], {
      leases: {
        heldByOthers: () => [],
        acquire: () => true,
        renew: () => {
          renewals++;
          return true;
        },
        release: () => {},
      },
    });
    harness.value.deliver = async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);
    const draining = service.drain();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(1100);
    expect(renewals).toBeGreaterThan(0);
    expect(stopped).toBe(false);
    finish?.();
    await Promise.all([stopping, draining]);
    expect(stopped).toBe(true);
  });

  test('lease loss aborts delivery and stop prevents further claims until work settles', async () => {
    let ownsLease = true;
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const harness = dependencies([batch([item('first')]), batch([item('second')])], {
      leases: { heldByOthers: () => [], acquire: () => true, renew: () => ownsLease, release: () => {} },
    });
    harness.value.deliver = async () => {
      signal = deliverySignal();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      assertDeliveryActive();
    };
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);
    expect(service.scheduleAvailable()).toBe(1);
    ownsLease = false;
    service.renewLeases();
    expect(signal?.aborted).toBe(true);
    expect(service.activeDestinations.has('destination')).toBe(true);
    const stopped = service.stop();
    expect(service.scheduleAvailable()).toBe(0);
    finish?.();
    await stopped;
    expect(service.activeDestinations.size).toBe(0);
    expect(harness.events.some((event) => event.startsWith('defer:') || event.startsWith('retry:'))).toBe(false);
  });

  test('login failure defers untouched rows without spending retry attempts', async () => {
    const harness = dependencies([]);
    harness.value.deliver = async () => {
      throw new Error('Bluesky login failed');
    };
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);
    const result = await service.runBatch(
      { id: 'destination', bskyIdentifier: 'destination.test' },
      batch([item('one', 2), item('two')]),
    );
    expect(result).toMatchObject({ deferred: 2, retrying: 0, parked: 0 });
    expect(harness.events).toContain('defer:one:300100');
    expect(harness.events).toContain('defer:two:300100');
    expect(harness.metrics.get('failed')).toBe(0);
  });

  test('partial batch failures charge attempted rows and defer untouched tail', async () => {
    const harness = dependencies([], { settlements: new Map([['posted', { status: 'migrated' }]]) });
    harness.value.deliver = async (_mapping, _batch, context) => {
      context.markAttempted('queue-posted');
      context.markAttempted('queue-corrupt');
      throw new Error('Invalid payload');
    };
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);
    const result = await service.runBatch(
      { id: 'destination', bskyIdentifier: 'destination.test' },
      batch([item('posted'), item('corrupt', 2), item('tail', 2)]),
    );
    expect(result).toMatchObject({ posted: 1, parked: 1, deferred: 1, retrying: 0 });
    expect(harness.events).toContain('retry:corrupt:3');
    expect(harness.events).toContain('defer:tail:300100');
  });

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

    const result = await service.runBatch({ id: 'destination', bskyIdentifier: 'destination.test' }, batch(rows));

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

  test('a migrated record always settles, even if it predates the item', async () => {
    const rows = [item('migrated', 0)];
    const harness = dependencies([], {
      delivery: async () => {},
      settlements: new Map([['migrated', { status: 'migrated', recordedAt: 0 }]]),
    });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);

    const result = await service.runBatch({ id: 'destination', bskyIdentifier: 'destination.test' }, batch(rows));

    expect(result).toMatchObject({ posted: 1, skipped: 0, retrying: 0, parked: 0 });
    expect(harness.events).toContain('done:migrated');
  });

  test('a stale skip record predating the item is not settled, so delivery keeps retrying', async () => {
    // Mirrors an override-requeue: the item is enqueued to replace a
    // previously skipped attempt, but the old skip history row for the same
    // key is still present when the worker checks settlement. Treating that
    // leftover row as this delivery's outcome would delete the queue item
    // without ever actually posting the override.
    const staleItem = item('stale-skip', 0);
    const harness = dependencies([], {
      delivery: async () => {},
      settlements: new Map([['stale-skip', { status: 'skipped', recordedAt: staleItem.enqueued_at - 1 }]]),
    });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);

    const result = await service.runBatch(
      { id: 'destination', bskyIdentifier: 'destination.test' },
      batch([staleItem]),
    );

    expect(result).toMatchObject({ posted: 0, skipped: 0, retrying: 1, parked: 0 });
    expect(harness.events).not.toContain('done:stale-skip');
    expect(harness.events).toContain('retry:stale-skip:3');
  });

  test('a skip record written after the item was enqueued settles as done', async () => {
    const freshItem = item('fresh-skip', 0);
    const harness = dependencies([], {
      delivery: async () => {},
      settlements: new Map([['fresh-skip', { status: 'skipped', recordedAt: freshItem.enqueued_at + 1 }]]),
    });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);

    const result = await service.runBatch(
      { id: 'destination', bskyIdentifier: 'destination.test' },
      batch([freshItem]),
    );

    expect(result).toMatchObject({ posted: 0, skipped: 1, retrying: 0, parked: 0 });
    expect(harness.events).toContain('done:fresh-skip');
  });

  test('a skip record with unknown timing is trusted as settled (legacy findSettlement callers)', async () => {
    const rows = [item('unknown-timing', 0)];
    const harness = dependencies([], {
      delivery: async () => {},
      settlements: new Map([['unknown-timing', { status: 'skipped' }]]),
    });
    const service = new DestinationQueueWorkerService(harness.value, 1, 3);

    const result = await service.runBatch({ id: 'destination', bskyIdentifier: 'destination.test' }, batch(rows));

    expect(result).toMatchObject({ posted: 0, skipped: 1, retrying: 0, parked: 0 });
    expect(harness.events).toContain('done:unknown-timing');
  });
});

/** A shared SQLite-backed lease table, as seen by one replica. */
function leaseTable() {
  const holders = new Map<string, string>();
  const events: string[] = [];
  const forReplica = (replica: string) => ({
    heldByOthers: () => [...holders.entries()].filter(([, owner]) => owner !== replica).map(([key]) => key),
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
