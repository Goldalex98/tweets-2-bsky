import { describe, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config-manager.js';
import { XSourceSweepService } from '../../src/services/x-source-sweep-service.js';

const xSource = (id: string) => ({
  id,
  type: 'x',
  enabled: true,
  schedule: {
    mode: 'fixed',
    minIntervalMinutes: 1,
    maxIntervalMinutes: 60,
    fixedIntervalMinutes: 5,
  },
});

const activeRoute = (sourceId: string, destinationId: string) => ({
  id: `route-${sourceId}`,
  sourceId,
  destinationId,
  enabled: true,
  relationship: { sourcePaused: false },
});

const config = {
  scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
  sources: [xSource('source')],
  destinations: [{ id: 'destination', enabled: true }],
  routes: [activeRoute('source', 'destination')],
  mappings: [],
} as unknown as AppConfig;

const emptySweep = {
  fetchedSources: 0,
  fetchedPosts: 0,
  filteredPosts: 0,
  enqueuedPosts: 0,
  fetchesBySource: {},
};

describe('XSourceSweepService', () => {
  test('records adaptive source state and rate-limits queue age alerts', async () => {
    let now = 10_000;
    const events: string[] = [];
    const service = new XSourceSweepService({
      clock: { now: () => now },
      random: { next: () => 0.5 },
      requestBudget: () => 1,
      jitterRatio: () => 0,
      queueAgeAlertMs: () => 1_000,
      listSourceStates: () => [],
      saveSourceState: (state) => events.push(`state:${state.sourceId}:${state.lastTweetSeenId}`),
      executeCanonical: async (_config, eligible, sweepId) => {
        events.push(`execute:${[...eligible].join(',')}:${sweepId}`);
        return {
          sweep: {
            fetchedSources: 1,
            fetchedPosts: 2,
            filteredPosts: 1,
            enqueuedPosts: 1,
            fetchesBySource: { source: 1 },
          },
          attempts: [
            {
              sourceId: 'source',
              success: true,
              foundPosts: 2,
              newestPostId: 'post-2',
              newestPostCreatedAt: 9_000,
            },
          ],
        };
      },
      runHousekeeping: async () => {
        events.push('housekeeping');
      },
      getQueueCounts: () => ({
        pending: 1,
        processing: 1,
        failed: 0,
        perMapping: [{ oldest_enqueued_at: 1 }],
      }),
      incrementMetric: (name, amount = 1) => events.push(`metric:${name}:${amount}`),
      notifyQueueAge: (age, depth) => events.push(`alert:${age}:${depth}`),
      log: (message) => events.push(`log:${message.slice(0, 2)}`),
      formatDuration: (duration) => `${duration}ms`,
      createSweepId: () => 'sweep-test',
    });

    expect(await service.run(config)).toBe(1);
    expect(events).toContain('execute:source:sweep-test');
    expect(events).toContain('state:source:post-2');
    expect(events).toContain('housekeeping');
    expect(events).toContain('alert:9999:2');

    now = 10_500;
    await service.run(config);
    expect(events.filter((event) => event.startsWith('alert:'))).toHaveLength(1);
  });

  test('a one-source budget goes to the routed source, not an unrouted one', async () => {
    const events: string[] = [];
    const sweptConfig = {
      ...config,
      // `unrouted` sorts first by id, and both sources are equally due, so a
      // budget of one used to be spent entirely on the source that cannot
      // deliver anywhere — starving the routed source every sweep.
      sources: [xSource('unrouted'), xSource('routed')],
      destinations: [
        { id: 'destination', enabled: true },
        { id: 'disabled-destination', enabled: false },
      ],
      routes: [
        activeRoute('routed', 'destination'),
        activeRoute('unrouted', 'disabled-destination'),
        { ...activeRoute('unrouted', 'destination'), relationship: { sourcePaused: true } },
      ],
    } as unknown as AppConfig;

    const service = new XSourceSweepService({
      clock: { now: () => 10_000 },
      random: { next: () => 0.5 },
      requestBudget: () => 1,
      jitterRatio: () => 0,
      queueAgeAlertMs: () => 1_000_000,
      listSourceStates: () => [],
      saveSourceState: () => {},
      executeCanonical: async (_config, eligible) => {
        events.push(`execute:${[...eligible].sort().join(',')}`);
        return { sweep: emptySweep, attempts: [] };
      },
      runHousekeeping: async () => {},
      getQueueCounts: () => ({ pending: 0, processing: 0, failed: 0, perMapping: [] }),
      incrementMetric: () => {},
      notifyQueueAge: () => {},
      log: () => {},
      formatDuration: (duration) => `${duration}ms`,
      createSweepId: () => 'sweep-test',
    });

    await service.run(sweptConfig);
    expect(events).toEqual(['execute:routed']);
  });

  test('a sweep with no routed source does no work and explains why', async () => {
    const logs: string[] = [];
    const service = new XSourceSweepService({
      clock: { now: () => 10_000 },
      random: { next: () => 0.5 },
      requestBudget: () => 5,
      jitterRatio: () => 0,
      queueAgeAlertMs: () => 1_000_000,
      listSourceStates: () => [],
      saveSourceState: () => {},
      executeCanonical: async () => {
        throw new Error('unrouted sources must never be fetched');
      },
      runHousekeeping: async () => {
        throw new Error('housekeeping must not run for an empty sweep');
      },
      getQueueCounts: () => ({ pending: 0, processing: 0, failed: 0, perMapping: [] }),
      incrementMetric: () => {},
      notifyQueueAge: () => {},
      log: (message) => logs.push(message),
      formatDuration: (duration) => `${duration}ms`,
      createSweepId: () => 'sweep-test',
    });

    expect(await service.run({ ...config, routes: [] } as unknown as AppConfig)).toBe(0);
    expect(logs.join(' ')).toContain('no active route');
  });
});
