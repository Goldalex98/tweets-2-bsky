import { createHash } from 'node:crypto';
import type { AIConfig, Destination, Route } from './config/schemas.js';

export const POLICY_SNAPSHOT_VERSION = 1;

export interface PolicySnapshotDocument {
  version: number;
  hash: string;
  capturedAt: string;
  delivery: {
    destinationId: string;
    storageKey: string;
    serviceUrl: string;
  };
  posting: Destination['postingPolicy'];
  ai: Omit<AIConfig, 'apiKey'> & { overrides: Destination['aiOverrides'] };
  routing: Route['routingPolicy'];
  /**
   * The route's source filters as accepted. Delivery consults these instead of
   * re-applying hardcoded repost/external-reply skips, which used to drop posts
   * the route had already agreed to mirror. Absent on snapshots captured before
   * this field existed; callers fall back to the route's current filters.
   */
  filters?: Route['filters'];
  moderation: {
    destination: Destination['moderationPolicy'];
    route: Route['moderationPolicy'];
  };
  duplicateSuppression: {
    destination: Destination['duplicateSuppression'];
    route: Route['duplicateSuppression'];
  };
  routeDelivery: Route['delivery'];
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}

export function stablePolicyJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

export function createPolicySnapshot(input: {
  destination: Destination;
  route: Route;
  ai: AIConfig;
  capturedAt?: Date;
}): PolicySnapshotDocument {
  const { apiKey: _secret, ...safeAi } = input.ai;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const body = {
    version: POLICY_SNAPSHOT_VERSION,
    delivery: {
      destinationId: input.destination.id,
      storageKey: input.destination.storageKey,
      serviceUrl: input.destination.bskyServiceUrl,
    },
    posting: copy(input.destination.postingPolicy),
    ai: copy({ ...safeAi, overrides: input.destination.aiOverrides }),
    routing: copy(input.route.routingPolicy),
    filters: copy(input.route.filters),
    moderation: {
      destination: copy(input.destination.moderationPolicy),
      route: copy(input.route.moderationPolicy),
    },
    duplicateSuppression: {
      destination: copy(input.destination.duplicateSuppression),
      route: copy(input.route.duplicateSuppression),
    },
    routeDelivery: copy(input.route.delivery),
  };
  const hash = createHash('sha256').update(stablePolicyJson(body)).digest('hex');
  return {
    ...body,
    hash,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
  };
}

export function serializePolicySnapshot(snapshot: PolicySnapshotDocument): string {
  return stablePolicyJson(snapshot);
}

export function parsePolicySnapshot(value?: string): PolicySnapshotDocument | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as PolicySnapshotDocument;
    return parsed?.version === POLICY_SNAPSHOT_VERSION && typeof parsed.hash === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function diffPolicySnapshots(
  saved: PolicySnapshotDocument | undefined,
  current: PolicySnapshotDocument,
): { changed: boolean; savedHash?: string; currentHash: string; fields: string[] } {
  if (!saved) return { changed: true, currentHash: current.hash, fields: ['snapshot'] };
  const fields = [
    'delivery',
    'routeDelivery',
    'posting',
    'ai',
    'routing',
    'filters',
    'moderation',
    'duplicateSuppression',
  ].filter(
    (field) =>
      stablePolicyJson(saved[field as keyof PolicySnapshotDocument]) !==
      stablePolicyJson(current[field as keyof PolicySnapshotDocument]),
  );
  return { changed: fields.length > 0, savedHash: saved.hash, currentHash: current.hash, fields };
}
