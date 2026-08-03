import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SOURCE_FILTERS,
  defaultPostingPolicy,
  defaultProfileManagementPolicy,
} from '../../src/config/defaults.js';
import type { Destination, Route, Source } from '../../src/config/schemas.js';
import { CanonicalSourceSweepService } from '../../src/pipeline/source-sweep.js';

const source: Source = {
  id: 'source',
  type: 'x',
  username: 'source',
  enabled: true,
  filters: { ...DEFAULT_SOURCE_FILTERS, includeKeywords: [], excludeKeywords: [], languages: [] },
  schedule: { mode: 'inherit', minIntervalMinutes: 1, maxIntervalMinutes: 1440, fixedIntervalMinutes: 5 },
  state: { consecutiveFailures: 0 },
};

const destination = (id: string): Destination => ({
  id,
  enabled: true,
  bskyIdentifier: `${id}.example`,
  bskyPassword: 'redacted',
  bskyServiceUrl: 'https://bsky.social',
  storageKey: id,
  postingPolicy: defaultPostingPolicy(1),
  profileManagement: defaultProfileManagementPolicy(),
  metadata: { legacyMappingIds: [id] },
});

const route = (destinationId: string): Route => ({
  id: `route-${destinationId}`,
  sourceId: source.id,
  destinationId,
  enabled: true,
  filters: { ...DEFAULT_SOURCE_FILTERS, includeKeywords: [], excludeKeywords: [], languages: [] },
  relationship: { sourcePaused: false, profileSyncSource: false, pinSyncSource: false },
  metadata: { legacyMappingIds: [destinationId] },
});

describe('canonical source sweep', () => {
  test('fetches shared source once and keeps dedup destination-independent', async () => {
    let fetches = 0;
    const enqueued: Record<string, string[]> = {};
    const service = new CanonicalSourceSweepService<number, number>({
      fetch: async () => {
        fetches += 1;
        return [100, 101];
      },
      normalize: (value) => value,
      identify: String,
      applySourcePolicy: (value) => ({
        allowed: value === 100,
        reason: value === 100 ? 'allowed' : 'excluded-keyword',
        policyVersion: 2,
      }),
      isDestinationDuplicate: (value, target) => target.id === 'a' && value === 100,
      enqueue: (values, { destination: target }) => {
        enqueued[target.id] = values.map(String);
        return values.length;
      },
    });
    const result = await service.execute({
      sources: [source],
      destinations: [destination('a'), destination('b')],
      routes: [route('a'), route('b')],
    });

    expect(fetches).toBe(1);
    expect(result.fetchesBySource).toEqual({ source: 1 });
    expect(enqueued).toEqual({ a: [], b: ['100'] });
  });

  test('prepares candidates independently for each route before policy and enqueue', async () => {
    let fetches = 0;
    const policyCandidates: Record<string, number[]> = {};
    const enqueued: Record<string, number[]> = {};
    const service = new CanonicalSourceSweepService<number, number>({
      fetch: async () => {
        fetches += 1;
        return [100, 101, 102];
      },
      normalize: (value) => value,
      identify: String,
      prepareRouteCandidates: async (candidates, { destination: target }) =>
        target.id === 'a' ? [] : candidates.filter((candidate) => candidate !== 101),
      applySourcePolicy: (value, { destination: target }) => {
        policyCandidates[target.id] = [...(policyCandidates[target.id] ?? []), value];
        return { allowed: true, reason: 'allowed', policyVersion: 2 };
      },
      isDestinationDuplicate: () => false,
      enqueue: (values, { destination: target }) => {
        enqueued[target.id] = [...values];
        return values.length;
      },
    });

    const result = await service.execute({
      sources: [source],
      destinations: [destination('a'), destination('b')],
      routes: [route('a'), route('b')],
    });

    expect(fetches).toBe(1);
    expect(policyCandidates).toEqual({ b: [100, 102] });
    expect(enqueued).toEqual({ a: [], b: [100, 102] });
    expect(result).toMatchObject({ fetchedSources: 1, fetchedPosts: 3, filteredPosts: 0, enqueuedPosts: 2 });
  });

  test('paused routes and disabled sources are never fetched', async () => {
    let fetches = 0;
    const pausedRoute = { ...route('a'), relationship: { ...route('a').relationship, sourcePaused: true } };
    const service = new CanonicalSourceSweepService<number, number>({
      fetch: async () => {
        fetches += 1;
        return [];
      },
      normalize: (value) => value,
      identify: String,
      applySourcePolicy: () => ({ allowed: true, reason: 'allowed', policyVersion: 2 }),
      isDestinationDuplicate: () => false,
      enqueue: () => 0,
    });
    await service.execute({ sources: [source], destinations: [destination('a')], routes: [pausedRoute] });
    expect(fetches).toBe(0);
  });

  test('evaluates destination-specific route filters after one fetch', async () => {
    let fetches = 0;
    const enqueued: Record<string, number> = {};
    const routeA = route('a');
    routeA.filters.originalPosts = false;
    const routeB = route('b');
    const service = new CanonicalSourceSweepService<number, number>({
      fetch: async () => {
        fetches += 1;
        return [100];
      },
      normalize: (value) => value,
      identify: String,
      applySourcePolicy: (_value, { route: currentRoute }) => ({
        allowed: currentRoute.filters.originalPosts,
        reason: currentRoute.filters.originalPosts ? 'allowed' : 'original-post-disabled',
        policyVersion: 2,
      }),
      isDestinationDuplicate: () => false,
      enqueue: (values, { destination: target }) => {
        enqueued[target.id] = values.length;
        return values.length;
      },
    });
    await service.execute({
      sources: [source],
      destinations: [destination('a'), destination('b')],
      routes: [routeA, routeB],
    });
    expect(fetches).toBe(1);
    expect(enqueued).toEqual({ a: 0, b: 1 });
  });
});
