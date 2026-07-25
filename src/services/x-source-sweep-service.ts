import {
  AdaptivePollingScheduler,
  type PollingClock,
  type PollingRandom,
  type SourcePollingState,
} from '../adaptive-polling.js';
import type { AppConfig } from '../config-manager.js';
import type { SourceSweepResult } from '../pipeline/source-sweep.js';

export interface XSourceSweepAttempt {
  sourceId: string;
  success: boolean;
  foundPosts: number;
  newestPostId?: string;
  newestPostCreatedAt?: number;
  errorCategory?: string;
  errorMessage?: string;
}

export interface XSourceSweepQueueCounts {
  pending: number;
  processing: number;
  failed: number;
  perMapping: Array<{ oldest_enqueued_at: number | null }>;
}

export interface XSourceRuntimeState extends SourcePollingState {
  lastTweetSeenId?: string;
}

export interface XSourceSweepDependencies {
  clock: PollingClock;
  random: PollingRandom;
  requestBudget(config: AppConfig): number;
  jitterRatio(): number;
  queueAgeAlertMs(): number;
  listSourceStates(): XSourceRuntimeState[];
  saveSourceState(
    state: SourcePollingState & {
      consecutiveQuietChecks: number;
      lastTweetSeenId?: string;
      lastErrorCategory?: string;
      lastErrorMessage?: string;
      lastErrorAt?: number;
    },
  ): void;
  executeCanonical(
    config: AppConfig,
    eligibleSourceIds: ReadonlySet<string>,
    sweepId: string,
  ): Promise<{ sweep: SourceSweepResult; attempts: XSourceSweepAttempt[] }>;
  runHousekeeping(config: AppConfig): Promise<void>;
  getQueueCounts(): XSourceSweepQueueCounts;
  incrementMetric(name: 'sweeps' | 'discovered' | 'filtered' | 'enqueued', amount?: number): void;
  notifyQueueAge(ageMs: number, depth: number): void;
  log(message: string, isError: boolean, sweepId: string): void;
  formatDuration(durationMs: number): string;
  createSweepId(): string;
}

/**
 * Coordinates adaptive X-source eligibility, canonical route fan-out,
 * source runtime state, housekeeping, and queue-age alerts.
 */
export class XSourceSweepService {
  private lastQueueAgeAlertAt = 0;

  constructor(private readonly dependencies: XSourceSweepDependencies) {}

  async run(config: AppConfig): Promise<number> {
    const sweepId = this.dependencies.createSweepId();
    this.dependencies.incrementMetric('sweeps');
    const states = new Map(
      this.dependencies.listSourceStates().map((state) => [state.sourceId, state]),
    );
    const adaptive = new AdaptivePollingScheduler(
      this.dependencies.clock,
      this.dependencies.random,
    );
    const enabledDestinationIds = new Set(
      config.destinations.filter((destination) => destination.enabled).map((destination) => destination.id),
    );
    const routedSourceIds = new Set(
      config.routes
        .filter(
          (route) =>
            route.enabled &&
            !route.relationship.sourcePaused &&
            enabledDestinationIds.has(route.destinationId),
        )
        .map((route) => route.sourceId),
    );
    const eligibility = adaptive.plan(
      config.sources.filter((source) => source.type === 'x'),
      states,
      this.dependencies.requestBudget(config),
      { hasActiveRoute: (source) => routedSourceIds.has(source.id) },
    );
    if (eligibility.eligible.length === 0) {
      const unrouted = eligibility.ineligible.filter((entry) => entry.reason === 'unrouted').length;
      this.dependencies.log(
        unrouted > 0
          ? `ℹ️ No source accounts to check; ${unrouted} enabled source(s) have no active route to an enabled destination.`
          : 'ℹ️ No enabled source accounts to check.',
        false,
        sweepId,
      );
      return 0;
    }

    const startedAt = this.dependencies.clock.now();
    this.dependencies.log(
      `🔎 Checking ${eligibility.eligible.length} eligible canonical source account(s).`,
      false,
      sweepId,
    );
    const result = await this.dependencies.executeCanonical(
      config,
      new Set(eligibility.eligible.map((source) => source.id)),
      sweepId,
    );
    this.dependencies.incrementMetric('discovered', result.sweep.fetchedPosts);
    this.dependencies.incrementMetric('filtered', result.sweep.filteredPosts);
    this.dependencies.incrementMetric('enqueued', result.sweep.enqueuedPosts);

    const attempts = new Map(result.attempts.map((attempt) => [attempt.sourceId, attempt]));
    for (const source of eligibility.eligible) {
      const attempt = attempts.get(source.id);
      if (!attempt) continue;
      const pollingState = adaptive.recordResult(
        source,
        states.get(source.id),
        { success: attempt.success, foundPosts: attempt.foundPosts },
        config.scheduler.intervalMinutes,
        this.dependencies.jitterRatio(),
      );
      this.dependencies.saveSourceState({
        ...pollingState,
        consecutiveQuietChecks: pollingState.consecutiveQuietChecks ?? 0,
        lastTweetSeenId: attempt.newestPostId ?? states.get(source.id)?.lastTweetSeenId,
        lastTweetSeenAt: attempt.newestPostCreatedAt ?? states.get(source.id)?.lastTweetSeenAt,
        lastErrorCategory: attempt.errorCategory,
        lastErrorMessage: attempt.errorMessage,
        lastErrorAt: attempt.errorMessage ? pollingState.lastCheckAt : undefined,
      });
    }

    await this.dependencies.runHousekeeping(config);
    const counts = this.dependencies.getQueueCounts();
    const oldestQueuedAt = counts.perMapping.reduce<number | null>(
      (oldest, entry) =>
        entry.oldest_enqueued_at !== null &&
        (oldest === null || entry.oldest_enqueued_at < oldest)
          ? entry.oldest_enqueued_at
          : oldest,
      null,
    );
    const now = this.dependencies.clock.now();
    const alertMs = this.dependencies.queueAgeAlertMs();
    if (
      oldestQueuedAt !== null &&
      now - oldestQueuedAt >= alertMs &&
      now - this.lastQueueAgeAlertAt >= alertMs
    ) {
      this.lastQueueAgeAlertAt = now;
      this.dependencies.notifyQueueAge(
        now - oldestQueuedAt,
        counts.pending + counts.processing,
      );
    }
    this.dependencies.log(
      `✅ Swept ${result.sweep.fetchedSources} source(s) in ${this.dependencies.formatDuration(now - startedAt)}; ` +
        `queued ${result.sweep.enqueuedPosts} new tweet(s). Queue now: ${counts.pending} pending, ${counts.processing} posting, ${counts.failed} failed.`,
      false,
      sweepId,
    );
    return result.sweep.enqueuedPosts;
  }
}
