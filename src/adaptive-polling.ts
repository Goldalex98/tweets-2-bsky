import type { Source, SourceSchedulePolicy } from './config/schemas.js';

const MINUTE_MS = 60_000;

export interface PollingClock {
  now(): number;
}

export interface PollingRandom {
  next(): number;
}

export interface SourcePollingState {
  sourceId: string;
  lastCheckAt?: number;
  lastFetchSuccessAt?: number;
  lastTweetSeenAt?: number;
  consecutiveFailures: number;
  consecutiveQuietChecks?: number;
  nextEligibleCheckAt?: number;
}

export interface PollingResult {
  success: boolean;
  foundPosts: number;
}

export interface EligibilityPlan {
  eligible: Source[];
  ineligible: Array<{ source: Source; reason: 'disabled' | 'unrouted' | 'not-due' | 'budget' }>;
}

export interface PlanOptions {
  /**
   * Sources with no active route to an enabled destination are excluded before
   * the budget is applied. A sweep never fetches them, so they never report an
   * attempt, so their next-eligible time is never advanced — leaving them
   * permanently due and permanently at the front of the queue. With the sweep
   * budget capped they would starve genuinely routed sources indefinitely.
   */
  hasActiveRoute?(source: Source): boolean;
}

function clampInterval(minutes: number, schedule: SourceSchedulePolicy): number {
  return Math.max(schedule.minIntervalMinutes, Math.min(schedule.maxIntervalMinutes, minutes));
}

export function resolvePollingIntervalMinutes(args: {
  schedule: SourceSchedulePolicy;
  globalIntervalMinutes: number;
  state: SourcePollingState;
  result: PollingResult;
}): number {
  const { schedule, state, result } = args;
  if (schedule.mode === 'fixed') return clampInterval(schedule.fixedIntervalMinutes, schedule);
  if (schedule.mode === 'inherit') return clampInterval(args.globalIntervalMinutes, schedule);

  if (!result.success) {
    const failures = Math.max(1, state.consecutiveFailures);
    return clampInterval(schedule.minIntervalMinutes * 2 ** Math.min(failures, 10), schedule);
  }
  if (result.foundPosts > 0) return schedule.minIntervalMinutes;

  const quietChecks = Math.max(1, (state.consecutiveQuietChecks ?? 0) + 1);
  return clampInterval(
    Math.max(args.globalIntervalMinutes, schedule.minIntervalMinutes * 2 ** Math.min(quietChecks, 10)),
    schedule,
  );
}

export function calculateNextEligibleCheckAt(args: {
  nowMs: number;
  intervalMinutes: number;
  schedule: SourceSchedulePolicy;
  jitterRatio: number;
  random: number;
}): number {
  const boundedRandom = Math.max(0, Math.min(1, args.random));
  const boundedJitter = Math.max(0, Math.min(0.5, args.jitterRatio));
  const jitterMultiplier = 1 + (boundedRandom * 2 - 1) * boundedJitter;
  const jittered = args.intervalMinutes * jitterMultiplier;
  const boundedMinutes = clampInterval(jittered, args.schedule);
  return args.nowMs + Math.round(boundedMinutes * MINUTE_MS);
}

/**
 * A sweep uses a single global timer. Due sources are ordered by how long
 * overdue they are, then by oldest check and stable id. With state recorded
 * after every attempt, a finite request budget cannot starve a due source.
 */
export class AdaptivePollingScheduler {
  constructor(
    private readonly clock: PollingClock = { now: () => Date.now() },
    private readonly random: PollingRandom = { next: () => Math.random() },
  ) {}

  plan(
    sources: readonly Source[],
    states: ReadonlyMap<string, SourcePollingState>,
    requestBudget: number,
    options: PlanOptions = {},
  ): EligibilityPlan {
    const now = this.clock.now();
    const due: Source[] = [];
    const ineligible: EligibilityPlan['ineligible'] = [];
    for (const source of sources) {
      if (!source.enabled) {
        ineligible.push({ source, reason: 'disabled' });
        continue;
      }
      if (options.hasActiveRoute && !options.hasActiveRoute(source)) {
        ineligible.push({ source, reason: 'unrouted' });
        continue;
      }
      const state = states.get(source.id);
      if ((state?.nextEligibleCheckAt ?? 0) > now) {
        ineligible.push({ source, reason: 'not-due' });
        continue;
      }
      due.push(source);
    }
    due.sort((a, b) => {
      const aState = states.get(a.id);
      const bState = states.get(b.id);
      return (
        (aState?.nextEligibleCheckAt ?? 0) - (bState?.nextEligibleCheckAt ?? 0) ||
        (aState?.lastCheckAt ?? 0) - (bState?.lastCheckAt ?? 0) ||
        a.id.localeCompare(b.id)
      );
    });
    const budget = Math.max(0, Math.floor(requestBudget));
    for (const source of due.slice(budget)) ineligible.push({ source, reason: 'budget' });
    return { eligible: due.slice(0, budget), ineligible };
  }

  recordResult(
    source: Source,
    previous: SourcePollingState | undefined,
    result: PollingResult,
    globalIntervalMinutes: number,
    jitterRatio = 0.1,
  ): SourcePollingState {
    const now = this.clock.now();
    const state: SourcePollingState = {
      sourceId: source.id,
      lastCheckAt: now,
      lastFetchSuccessAt: result.success ? now : previous?.lastFetchSuccessAt,
      lastTweetSeenAt: result.foundPosts > 0 ? now : previous?.lastTweetSeenAt,
      consecutiveFailures: result.success ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
      consecutiveQuietChecks: result.success
        ? result.foundPosts > 0
          ? 0
          : (previous?.consecutiveQuietChecks ?? 0) + 1
        : (previous?.consecutiveQuietChecks ?? 0),
    };
    const intervalMinutes = resolvePollingIntervalMinutes({
      schedule: source.schedule,
      globalIntervalMinutes,
      state,
      result,
    });
    state.nextEligibleCheckAt = calculateNextEligibleCheckAt({
      nowMs: now,
      intervalMinutes,
      schedule: source.schedule,
      jitterRatio,
      random: this.random.next(),
    });
    return state;
  }
}
