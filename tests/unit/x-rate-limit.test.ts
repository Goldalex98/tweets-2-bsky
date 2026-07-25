import { describe, expect, test } from 'bun:test';
import {
  XRateGovernor,
  type XRateGovernorOptions,
  isAuthError,
  isRateLimitError,
  parseRateLimitResetMs,
} from '../../src/x-rate-limit.js';

/** Virtual clock so pacing assertions are exact and the suite stays instant. */
function createClock(startMs = 1_000_000) {
  let current = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function governor(overrides: Partial<XRateGovernorOptions> = {}) {
  const clock = createClock();
  const instance = new XRateGovernor({
    minGapMs: 1000,
    jitterMs: 0,
    maxRequestsPerWindow: 3,
    windowMs: 10_000,
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 900_000,
    clock,
    random: () => 0,
    ...overrides,
  });
  return { instance, clock };
}

describe('X rate governor', () => {
  test('spaces consecutive requests by the configured gap', async () => {
    const { instance, clock } = governor({ maxRequestsPerWindow: 100 });
    const startedAt = clock.now();
    await instance.acquire();
    await instance.acquire();
    await instance.acquire();
    expect(clock.now() - startedAt).toBe(2000);
  });

  test('adds jitter so request timing is not metronomic', async () => {
    const { instance, clock } = governor({
      maxRequestsPerWindow: 100,
      jitterMs: 400,
      random: () => 1,
    });
    const startedAt = clock.now();
    await instance.acquire();
    await instance.acquire();
    expect(clock.now() - startedAt).toBe(1401);
  });

  test('holds requests at the rolling window ceiling instead of bursting', async () => {
    const { instance, clock } = governor({ minGapMs: 0, maxRequestsPerWindow: 3, windowMs: 10_000 });
    const startedAt = clock.now();
    for (let index = 0; index < 3; index += 1) await instance.acquire();
    expect(clock.now() - startedAt).toBe(0);
    expect(instance.snapshot().requestsInWindow).toBe(3);

    // The fourth request may only start once the oldest leaves the window.
    await instance.acquire();
    expect(clock.now() - startedAt).toBe(10_000);
    expect(instance.snapshot().throttledWaits).toBe(1);
  });

  test('honours the reset advertised by X rather than guessing', async () => {
    const { instance, clock } = governor();
    const resetAt = clock.now() + 120_000;
    expect(instance.noteRateLimited(resetAt)).toBe(resetAt);

    const startedAt = clock.now();
    await instance.acquire();
    expect(clock.now() - startedAt).toBe(120_000);
  });

  test('backs off exponentially when X reports no reset time', () => {
    const { instance, clock } = governor();
    const first = instance.noteRateLimited();
    expect(first - clock.now()).toBe(30_000);

    const second = instance.noteRateLimited();
    expect(second - clock.now()).toBe(60_000);

    const third = instance.noteRateLimited();
    expect(third - clock.now()).toBe(120_000);
  });

  test('caps the cooldown and resets escalation after a clean request', () => {
    const { instance } = governor({ cooldownBaseMs: 30_000, cooldownMaxMs: 60_000 });
    instance.noteRateLimited();
    instance.noteRateLimited();
    instance.noteRateLimited();
    expect(instance.snapshot().consecutiveLimitHits).toBe(3);

    instance.noteSuccess();
    expect(instance.snapshot().consecutiveLimitHits).toBe(0);
  });

  test('never trusts a reset further out than the configured maximum', () => {
    const { instance, clock } = governor({ cooldownMaxMs: 60_000 });
    const absurdReset = clock.now() + 86_400_000;
    expect(instance.noteRateLimited(absurdReset)).toBe(clock.now() + 60_000);
  });

  test('a limit hit pauses every concurrent caller, not just the one that saw it', async () => {
    const { instance, clock } = governor({ minGapMs: 0, maxRequestsPerWindow: 100 });
    instance.noteRateLimited(clock.now() + 45_000);

    const startedAt = clock.now();
    await Promise.all([instance.acquire(), instance.acquire(), instance.acquire()]);
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(45_000);
  });

  test('reports a cooldown so operators can see throttling', () => {
    const events: Array<{ untilMs: number; fromHeader: boolean }> = [];
    const { instance, clock } = governor({
      onCooldown: (details) => events.push({ untilMs: details.untilMs, fromHeader: details.fromHeader }),
    });
    instance.noteRateLimited(clock.now() + 5_000);
    instance.noteRateLimited();
    expect(events).toHaveLength(2);
    expect(events[0]?.fromHeader).toBe(true);
    expect(events[1]?.fromHeader).toBe(false);
  });
});

describe('X error classification', () => {
  test('detects rate limiting from status, message, or nested response', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isRateLimitError(new Error('Request failed with status code 429'))).toBe(true);
    expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('ServiceUnavailable'))).toBe(false);
  });

  test('separates authentication failures from rate limiting', () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(true);
    expect(isAuthError(new Error('Could not authenticate you'))).toBe(true);
    expect(isAuthError({ status: 429 })).toBe(false);
    expect(isRateLimitError({ status: 401 })).toBe(false);
  });

  test('reads the reset from X, atproto, and Retry-After headers', () => {
    const now = 1_700_000_000_000;
    expect(
      parseRateLimitResetMs({ response: { headers: { 'x-rate-limit-reset': '1700000600' } } }, now),
    ).toBe(1_700_000_600_000);
    expect(parseRateLimitResetMs({ headers: { 'ratelimit-reset': 1700000900 } }, now)).toBe(
      1_700_000_900_000,
    );
    expect(parseRateLimitResetMs({ headers: { 'retry-after': '90' } }, now)).toBe(now + 90_000);
  });

  test('reads headers from a fetch Headers instance', () => {
    const now = 1_700_000_000_000;
    const headers = new Headers({ 'x-rate-limit-reset': '1700000300' });
    expect(parseRateLimitResetMs({ headers }, now)).toBe(1_700_000_300_000);
  });

  test('returns undefined when no reset is advertised', () => {
    expect(parseRateLimitResetMs(new Error('429'), Date.now())).toBeUndefined();
    expect(parseRateLimitResetMs({ headers: { 'x-rate-limit-reset': 'nope' } }, Date.now())).toBeUndefined();
  });
});
