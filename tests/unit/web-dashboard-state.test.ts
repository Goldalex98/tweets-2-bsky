import { describe, expect, test } from 'bun:test';
import { mergeConfigVersion } from '../../web/src/features/settings/use-settings-security';
import {
  defaultAttributionMode,
  estimateChecksPerHour,
  nextAttributionModeForSourceChange,
  parseCheckIntervalMinutes,
  validateAttributionTemplate,
} from '../../web/src/lib/dashboard-utils';
import { createLatestRequestTracker } from '../../web/src/lib/latest-request';

describe('attribution defaults', () => {
  test('one-to-one mappings default to no attribution, aggregates default to on', () => {
    expect(defaultAttributionMode(1)).toBe('never');
    expect(defaultAttributionMode(4)).toBe('multiple-sources');
  });

  test('adding a second source flips an untouched default on', () => {
    expect(nextAttributionModeForSourceChange('never', 1, 2)).toBe('multiple-sources');
  });

  test('dropping back to one source restores the one-to-one default', () => {
    expect(nextAttributionModeForSourceChange('multiple-sources', 3, 1)).toBe('never');
  });

  test('an explicit choice survives source changes', () => {
    expect(nextAttributionModeForSourceChange('always', 1, 2)).toBe('always');
    expect(nextAttributionModeForSourceChange('never', 3, 1)).toBe('never');
    expect(nextAttributionModeForSourceChange('multiple-sources', 2, 5)).toBe('multiple-sources');
  });
});

describe('attribution template validation', () => {
  test('accepts the supported variables', () => {
    expect(validateAttributionTemplate('Source: @{username} on X')).toBeNull();
    expect(validateAttributionTemplate('{username} {url} {postUrl} {destination}')).toBeNull();
  });

  test('rejects unknown variables, stray braces, and empty templates', () => {
    expect(validateAttributionTemplate('From {handle}')).toContain('unsupported variable');
    expect(validateAttributionTemplate('Broken {')).toContain('invalid variable expression');
    expect(validateAttributionTemplate('')).toContain('between 1 and 160 characters');
    expect(validateAttributionTemplate('x'.repeat(161))).toContain('between 1 and 160 characters');
  });
});

describe('scheduler interval parsing', () => {
  test('accepts whole minutes inside the server range', () => {
    expect(parseCheckIntervalMinutes('5')).toEqual({ minutes: 5, error: null });
    expect(parseCheckIntervalMinutes(' 1440 ')).toEqual({ minutes: 1440, error: null });
  });

  test('never yields NaN for a cleared or malformed field', () => {
    expect(parseCheckIntervalMinutes('').minutes).toBeNull();
    expect(parseCheckIntervalMinutes('').error).toContain('Enter a check interval');
    expect(parseCheckIntervalMinutes('abc').minutes).toBeNull();
    expect(parseCheckIntervalMinutes('2.5').error).toContain('whole number');
  });

  test('mirrors the server bounds', () => {
    expect(parseCheckIntervalMinutes('0').error).toContain('between 1 and 1440');
    expect(parseCheckIntervalMinutes('1441').error).toContain('between 1 and 1440');
  });

  test('estimates the resulting X check load', () => {
    expect(estimateChecksPerHour(24, 5)).toBe(288);
    expect(estimateChecksPerHour(24, 0)).toBe(0);
  });
});

describe('settings save acknowledgements', () => {
  test('a bare ack keeps locally known settings and advances the revision', () => {
    const current = {
      revision: 4,
      updatedAt: '2026-07-24T20:00:00.000Z',
      enabled: true,
      events: { 'queue-parked': true, 'queue-age': false },
    };

    const merged = mergeConfigVersion(current, {
      success: true,
      revision: 5,
      updatedAt: '2026-07-24T20:05:00.000Z',
    });

    expect(merged.events).toEqual({ 'queue-parked': true, 'queue-age': false });
    expect(merged.enabled).toBe(true);
    expect(merged.revision).toBe(5);
    expect(merged.updatedAt).toBe('2026-07-24T20:05:00.000Z');
  });

  test('an ack without a revision leaves the known version intact', () => {
    const merged = mergeConfigVersion(
      { revision: 4, updatedAt: '2026-07-24T20:00:00.000Z', provider: 'gemini' },
      { success: true } as never,
    );

    expect(merged).toEqual({ revision: 4, updatedAt: '2026-07-24T20:00:00.000Z', provider: 'gemini' });
  });
});

describe('overlapping request guard', () => {
  test('only the newest request may write state', () => {
    const tracker = createLatestRequestTracker();
    const stale = tracker.begin();
    const fresh = tracker.begin();

    expect(tracker.isCurrent(stale)).toBe(false);
    expect(tracker.isCurrent(fresh)).toBe(true);
  });

  test('invalidation discards an in-flight response', () => {
    const tracker = createLatestRequestTracker();
    const inFlight = tracker.begin();
    tracker.invalidate();

    expect(tracker.isCurrent(inFlight)).toBe(false);
  });
});
