import { describe, expect, test } from 'bun:test';
import {
  prepareRouteInitialImportCandidates,
  type RouteInitialImportState,
  type RouteInitialImportStore,
} from '../../src/pipeline/route-initial-import.js';

const post = (externalId: string, createdAt: string) => ({ externalId, createdAt });

function store(initial?: RouteInitialImportState): RouteInitialImportStore & { writes: RouteInitialImportState[] } {
  let state = initial ?? null;
  const writes: RouteInitialImportState[] = [];
  return {
    writes,
    get: () => state,
    initialize: (input) => {
      state ??= {
        appliedMode: input.appliedMode,
        baselinePostId: input.baselinePostId,
        baselinePostCreatedAt: input.baselinePostCreatedAt,
      };
      writes.push(state);
      return state;
    },
  };
}

describe('route initial import', () => {
  test('inherit uses the global new-only default and records the actual newest post without queueing', () => {
    const state = store();
    const posts = [
      post('101', '2026-01-01T00:00:01Z'),
      post('103', '2026-01-01T00:00:03Z'),
      post('102', '2026-01-01T00:00:02Z'),
    ];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'inherit',
        globalDefault: 'new-only',
        posts,
        fetchSucceeded: true,
        store: state,
        now: 10,
      }),
    ).toEqual([]);
    expect(state.writes).toEqual([
      { appliedMode: 'new-only', baselinePostId: '103', baselinePostCreatedAt: Date.parse('2026-01-01T00:00:03Z') },
    ]);
  });

  test('inherit uses the global recent default and returns the initial batch', () => {
    const state = store();
    const posts = [post('1', '2026-01-01T00:00:00Z')];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'inherit',
        globalDefault: 'recent',
        posts,
        fetchSucceeded: true,
        store: state,
      }),
    ).toEqual(posts);
    expect(state.writes[0]?.appliedMode).toBe('recent');
  });

  test('per-route overrides win over either global default', () => {
    const recentStore = store();
    const newOnlyStore = store();
    const posts = [post('1', '2026-01-01T00:00:00Z')];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'recent',
        configuredMode: 'recent',
        globalDefault: 'new-only',
        posts,
        fetchSucceeded: true,
        store: recentStore,
      }),
    ).toEqual(posts);
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'new',
        configuredMode: 'new-only',
        globalDefault: 'recent',
        posts,
        fetchSucceeded: true,
        store: newOnlyStore,
      }),
    ).toEqual([]);
  });

  test('a later sweep returns only posts newer than the persisted baseline', () => {
    const state = store({ appliedMode: 'new-only', baselinePostId: '200', baselinePostCreatedAt: 2000 });
    const posts = [
      post('201', new Date(2000).toISOString()),
      post('199', new Date(2000).toISOString()),
      post('300', new Date(3000).toISOString()),
    ];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'recent',
        globalDefault: 'recent',
        posts,
        fetchSucceeded: true,
        store: state,
      }),
    ).toEqual([posts[0], posts[2]]);
    expect(state.writes).toEqual([]);
  });

  test('restart and setting changes retain the originally applied mode', () => {
    const state = store({ appliedMode: 'new-only', baselinePostId: '10', baselinePostCreatedAt: 1000 });
    const posts = [post('9', new Date(900).toISOString())];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'recent',
        globalDefault: 'recent',
        posts,
        fetchSucceeded: true,
        store: state,
      }),
    ).toEqual([]);
  });

  test('failed initialization does not persist state and retries the next successful fetch', () => {
    const state = store();
    const posts = [post('1', '2026-01-01T00:00:00Z')];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'new-only',
        globalDefault: 'new-only',
        posts: [],
        fetchSucceeded: false,
        store: state,
      }),
    ).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'new-only',
        globalDefault: 'new-only',
        posts,
        fetchSucceeded: true,
        store: state,
      }),
    ).toEqual([]);
    expect(state.writes).toHaveLength(1);
  });

  test('a successful empty timeline persists an explicit timestamp baseline', () => {
    const state = store();
    prepareRouteInitialImportCandidates({
      routeId: 'route',
      configuredMode: 'new-only',
      globalDefault: 'new-only',
      posts: [],
      fetchSucceeded: true,
      store: state,
      now: 5000,
    });
    expect(state.writes).toEqual([{ appliedMode: 'new-only', baselinePostId: undefined, baselinePostCreatedAt: 5000 }]);
  });

  test('a concurrent initializer honors the durable mode and baseline that won', () => {
    const durableNewOnly = store({
      appliedMode: 'new-only',
      baselinePostId: '10',
      baselinePostCreatedAt: 1000,
    });
    // Simulate a stale pre-initialize read from another process. SQLite's
    // INSERT OR IGNORE returns the state that actually won the race.
    durableNewOnly.get = () => null;
    const posts = [post('9', new Date(900).toISOString()), post('11', new Date(1100).toISOString())];
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'recent',
        globalDefault: 'recent',
        posts,
        fetchSucceeded: true,
        store: durableNewOnly,
      }),
    ).toEqual([posts[1]]);

    const durableRecent = store({ appliedMode: 'recent' });
    durableRecent.get = () => null;
    expect(
      prepareRouteInitialImportCandidates({
        routeId: 'route',
        configuredMode: 'new-only',
        globalDefault: 'new-only',
        posts,
        fetchSucceeded: true,
        store: durableRecent,
      }),
    ).toEqual(posts);
  });
});
