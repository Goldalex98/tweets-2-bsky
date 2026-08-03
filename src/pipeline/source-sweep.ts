import type { Destination, Route, Source } from '../config/schemas.js';
import type { SourceFilterDecision } from '../source-filter.js';

export interface SweepPolicyDecision {
  allowed: boolean;
  reason: string;
  detail?: string;
  policyVersion?: number;
  decisionVersion?: number;
  trace?: unknown[];
}

export interface CanonicalSweepConfig {
  sources: readonly Source[];
  destinations: readonly Destination[];
  routes: readonly Route[];
}

export interface SourceSweepDependencies<Raw, Normalized> {
  fetch(source: Source): Promise<Raw[]>;
  normalize(raw: Raw, source: Source): Normalized;
  identify(candidate: Normalized): string;
  prepareRouteCandidates?(
    candidates: readonly Normalized[],
    context: { source: Source; destination: Destination; route: Route },
  ): readonly Normalized[] | Promise<readonly Normalized[]>;
  applySourcePolicy(
    candidate: Normalized,
    context: { source: Source; destination: Destination; route: Route },
  ): SourceFilterDecision;
  applyRoutePolicy?(
    candidate: Normalized,
    context: { source: Source; destination: Destination; route: Route },
  ): SweepPolicyDecision;
  isDestinationDuplicate(candidate: Normalized, destination: Destination, route: Route): boolean | Promise<boolean>;
  enqueue(
    candidates: readonly Normalized[],
    context: { source: Source; destination: Destination; route: Route },
  ): number | Promise<number>;
  persistSkip?(
    candidate: Normalized,
    decision: SweepPolicyDecision,
    context: { source: Source; destination: Destination; route: Route },
  ): void | Promise<void>;
}

export interface SourceSweepResult {
  fetchedSources: number;
  fetchedPosts: number;
  filteredPosts: number;
  enqueuedPosts: number;
  fetchesBySource: Record<string, number>;
}

/**
 * Discovery and normalization are source-scoped. Each destination route then
 * evaluates its source policy exactly once before destination-scoped dedup, so
 * one destination's policy or history cannot suppress another.
 */
export class CanonicalSourceSweepService<Raw, Normalized> {
  constructor(private readonly dependencies: SourceSweepDependencies<Raw, Normalized>) {}

  async execute(config: CanonicalSweepConfig, eligibleSourceIds?: ReadonlySet<string>): Promise<SourceSweepResult> {
    const destinationById = new Map(config.destinations.map((destination) => [destination.id, destination]));
    const routesBySource = new Map<string, Route[]>();
    for (const route of config.routes) {
      const destination = destinationById.get(route.destinationId);
      if (!route.enabled || route.relationship.sourcePaused || !destination?.enabled) continue;
      const routes = routesBySource.get(route.sourceId) ?? [];
      routes.push(route);
      routesBySource.set(route.sourceId, routes);
    }

    const result: SourceSweepResult = {
      fetchedSources: 0,
      fetchedPosts: 0,
      filteredPosts: 0,
      enqueuedPosts: 0,
      fetchesBySource: {},
    };
    for (const source of config.sources) {
      if (!source.enabled || (eligibleSourceIds && !eligibleSourceIds.has(source.id))) continue;
      const routes = routesBySource.get(source.id) ?? [];
      if (routes.length === 0) continue;

      const raw = await this.dependencies.fetch(source);
      result.fetchedSources += 1;
      result.fetchedPosts += raw.length;
      result.fetchesBySource[source.id] = (result.fetchesBySource[source.id] ?? 0) + 1;
      const normalized = raw.map((item) => this.dependencies.normalize(item, source));

      for (const route of routes) {
        const destination = destinationById.get(route.destinationId);
        if (!destination) continue;
        const context = { source, destination, route };
        const routeCandidates = this.dependencies.prepareRouteCandidates
          ? await this.dependencies.prepareRouteCandidates(normalized, context)
          : normalized;
        const destinationCandidates: Normalized[] = [];
        const seenInBatch = new Set<string>();
        for (const candidate of routeCandidates) {
          const policy = this.dependencies.applySourcePolicy(candidate, context);
          if (!policy.allowed) {
            result.filteredPosts += 1;
            await this.dependencies.persistSkip?.(candidate, policy, context);
            continue;
          }
          const routePolicy = this.dependencies.applyRoutePolicy?.(candidate, context);
          if (routePolicy && !routePolicy.allowed) {
            result.filteredPosts += 1;
            await this.dependencies.persistSkip?.(candidate, routePolicy, context);
            continue;
          }
          const id = this.dependencies.identify(candidate);
          if (!id || seenInBatch.has(id)) continue;
          seenInBatch.add(id);
          if (await this.dependencies.isDestinationDuplicate(candidate, destination, route)) {
            result.filteredPosts += 1;
            await this.dependencies.persistSkip?.(
              candidate,
              { allowed: false, reason: 'duplicate-suppressed', decisionVersion: 1 },
              context,
            );
            continue;
          }
          destinationCandidates.push(candidate);
        }
        result.enqueuedPosts += await this.dependencies.enqueue(destinationCandidates, context);
      }
    }
    return result;
  }
}
