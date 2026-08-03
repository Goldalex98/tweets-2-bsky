import type { DefaultInitialImportMode, InitialImportMode } from '../config/schemas.js';

export interface InitialImportCandidate {
  externalId: string;
  createdAt: string;
}

export interface RouteInitialImportState {
  appliedMode: DefaultInitialImportMode;
  baselinePostId?: string;
  baselinePostCreatedAt?: number;
}

export interface RouteInitialImportStore {
  get(routeId: string): RouteInitialImportState | null;
  initialize(input: {
    routeId: string;
    appliedMode: DefaultInitialImportMode;
    baselinePostId?: string;
    baselinePostCreatedAt?: number;
    initializedAt?: number;
  }): RouteInitialImportState;
}

function compareExternalIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId === rightId ? 0 : leftId > rightId ? 1 : -1;
  }
  return left.localeCompare(right);
}

function comparePostPosition(left: InitialImportCandidate, right: InitialImportCandidate): number {
  const leftAt = Date.parse(left.createdAt);
  const rightAt = Date.parse(right.createdAt);
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
  return compareExternalIds(left.externalId, right.externalId);
}

function isAfterBaseline(post: InitialImportCandidate, baseline: RouteInitialImportState): boolean {
  const createdAt = Date.parse(post.createdAt);
  if (baseline.baselinePostCreatedAt !== undefined && Number.isFinite(createdAt)) {
    if (createdAt !== baseline.baselinePostCreatedAt) return createdAt > baseline.baselinePostCreatedAt;
  }
  return baseline.baselinePostId
    ? compareExternalIds(post.externalId, baseline.baselinePostId) > 0
    : baseline.baselinePostCreatedAt === undefined;
}

function candidatesForState<T extends InitialImportCandidate>(
  posts: readonly T[],
  state: RouteInitialImportState,
): readonly T[] {
  return state.appliedMode === 'new-only' ? posts.filter((post) => isAfterBaseline(post, state)) : posts;
}

/**
 * Finalizes a route's first successful fetch before any candidate can reach
 * policy evaluation or enqueue. Backfills do not call this function.
 */
export function prepareRouteInitialImportCandidates<T extends InitialImportCandidate>(input: {
  routeId: string;
  configuredMode: InitialImportMode;
  globalDefault: DefaultInitialImportMode;
  posts: readonly T[];
  fetchSucceeded: boolean;
  store: RouteInitialImportStore;
  now?: number;
}): readonly T[] {
  if (!input.fetchSucceeded) return [];

  const existing = input.store.get(input.routeId);
  if (existing) return candidatesForState(input.posts, existing);

  const appliedMode = input.configuredMode === 'inherit' ? input.globalDefault : input.configuredMode;
  if (appliedMode === 'recent') {
    const persisted = input.store.initialize({ routeId: input.routeId, appliedMode });
    return candidatesForState(input.posts, persisted);
  }

  const newest = input.posts.reduce<T | undefined>(
    (current, post) => (!current || comparePostPosition(post, current) > 0 ? post : current),
    undefined,
  );
  const initializedAt = input.now ?? Date.now();
  const persisted = input.store.initialize({
    routeId: input.routeId,
    appliedMode,
    baselinePostId: newest?.externalId,
    baselinePostCreatedAt: newest ? Date.parse(newest.createdAt) : initializedAt,
    initializedAt,
  });
  return candidatesForState(input.posts, persisted);
}
