import { describe, expect, test } from 'bun:test';
import { AdaptivePollingScheduler, calculateNextEligibleCheckAt } from '../../src/adaptive-polling.js';
import { DEFAULT_SOURCE_FILTERS } from '../../src/config/defaults.js';
import type { Source } from '../../src/config/schemas.js';

const source = (id: string): Source => ({
  id,
  type: 'x',
  username: id,
  enabled: true,
  filters: { ...DEFAULT_SOURCE_FILTERS, includeKeywords: [], excludeKeywords: [], languages: [] },
  schedule: { mode: 'adaptive', minIntervalMinutes: 2, maxIntervalMinutes: 30, fixedIntervalMinutes: 5 },
  state: { consecutiveFailures: 0 },
});

describe('adaptive source polling', () => {
  test('jitter never escapes configured bounds', () => {
    expect(
      calculateNextEligibleCheckAt({
        nowMs: 0,
        intervalMinutes: 2,
        schedule: source('one').schedule,
        jitterRatio: 0.5,
        random: 0,
      }),
    ).toBe(2 * 60_000);
    expect(
      calculateNextEligibleCheckAt({
        nowMs: 0,
        intervalMinutes: 30,
        schedule: source('one').schedule,
        jitterRatio: 0.5,
        random: 1,
      }),
    ).toBe(30 * 60_000);
  });

  test('activity accelerates and failures back off then reset', () => {
    const scheduler = new AdaptivePollingScheduler({ now: () => 1_000 }, { next: () => 0.5 });
    const active = scheduler.recordResult(source('one'), undefined, { success: true, foundPosts: 1 }, 5, 0);
    expect(active.nextEligibleCheckAt).toBe(1_000 + 2 * 60_000);
    const failed = scheduler.recordResult(source('one'), active, { success: false, foundPosts: 0 }, 5, 0);
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.nextEligibleCheckAt).toBe(1_000 + 4 * 60_000);
    const recovered = scheduler.recordResult(source('one'), failed, { success: true, foundPosts: 1 }, 5, 0);
    expect(recovered.consecutiveFailures).toBe(0);
  });

  test('budgeted sweeps are fair and do not starve due sources', () => {
    const scheduler = new AdaptivePollingScheduler({ now: () => 10_000 }, { next: () => 0.5 });
    const sources = [source('a'), source('b'), source('c')];
    const states = new Map();
    const selected: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const plan = scheduler.plan(sources, states, 1);
      const current = plan.eligible[0];
      if (!current) throw new Error('Expected an eligible source.');
      selected.push(current.id);
      states.set(
        current.id,
        scheduler.recordResult(current, states.get(current.id), { success: true, foundPosts: 0 }, 5, 0),
      );
    }
    expect(selected).toEqual(['a', 'b', 'c']);
  });

  test('unrouted sources are excluded before the budget is spent', () => {
    const scheduler = new AdaptivePollingScheduler({ now: () => 10_000 }, { next: () => 0.5 });
    const disabled = { ...source('disabled'), enabled: false };
    const plan = scheduler.plan([source('a'), disabled, source('z')], new Map(), 1, {
      hasActiveRoute: (candidate) => candidate.id === 'z',
    });

    // 'a' sorts first and is equally due, so an unfiltered plan would spend the
    // whole budget on a source that has nowhere to deliver.
    expect(plan.eligible.map((candidate) => candidate.id)).toEqual(['z']);
    expect(plan.ineligible.map((entry) => [entry.source.id, entry.reason])).toEqual([
      ['a', 'unrouted'],
      ['disabled', 'disabled'],
    ]);
  });

  test('routed sources still take turns under a budget of one', () => {
    const scheduler = new AdaptivePollingScheduler({ now: () => 10_000 }, { next: () => 0.5 });
    // 'unrouted' sorts before both routed sources and, never being fetched, is
    // never given a next-eligible time, so it would stay permanently first.
    const sources = [source('unrouted'), source('a'), source('b')];
    const hasActiveRoute = (candidate: Source) => candidate.id !== 'unrouted';
    const states = new Map();
    const selected: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const plan = scheduler.plan(sources, states, 1, { hasActiveRoute });
      const current = plan.eligible[0];
      if (!current) throw new Error('Expected an eligible source.');
      selected.push(current.id);
      states.set(
        current.id,
        scheduler.recordResult(current, states.get(current.id), { success: true, foundPosts: 0 }, 5, 0),
      );
    }

    expect(selected).toEqual(['a', 'b']);
    // Once both have been swept the sweep idles instead of burning the budget.
    expect(
      scheduler
        .plan(sources, states, 1, { hasActiveRoute })
        .ineligible.map((entry) => [entry.source.id, entry.reason]),
    ).toEqual([
      ['unrouted', 'unrouted'],
      ['a', 'not-due'],
      ['b', 'not-due'],
    ]);
  });

  test('without the predicate every enabled source is still planned', () => {
    const scheduler = new AdaptivePollingScheduler({ now: () => 10_000 }, { next: () => 0.5 });
    const plan = scheduler.plan([source('a'), source('b')], new Map(), 5);

    expect(plan.eligible.map((candidate) => candidate.id)).toEqual(['a', 'b']);
    expect(plan.ineligible).toEqual([]);
  });

  test('fixed mode overrides global interval', () => {
    const fixed = source('fixed');
    fixed.schedule = { ...fixed.schedule, mode: 'fixed', fixedIntervalMinutes: 7 };
    const scheduler = new AdaptivePollingScheduler({ now: () => 0 }, { next: () => 0.5 });
    expect(scheduler.recordResult(fixed, undefined, { success: true, foundPosts: 0 }, 20, 0).nextEligibleCheckAt).toBe(
      7 * 60_000,
    );
  });
});
