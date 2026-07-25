import { describe, expect, test } from 'bun:test';
import { parseRuntimeOptions } from '../../src/runtime-options.js';
import {
  createSchedulerCommandState,
  getSchedulerCommandsSince,
  issueSchedulerCommand,
  schedulerCommandRequestsSweep,
} from '../../src/scheduler-command.js';
import {
  DEFAULT_CHECK_INTERVAL_MINUTES,
  getNextCheckTimestamp,
  getSchedulerIntervalMinutes,
  isScheduledSweepDue,
  normalizeCheckIntervalMinutes,
  parseSchedulerIntervalMinutes,
} from '../../src/scheduler-timing.js';

describe('scheduler timing', () => {
  test('normalizes the current interval default and rounding behavior', () => {
    expect(normalizeCheckIntervalMinutes(undefined)).toBe(DEFAULT_CHECK_INTERVAL_MINUTES);
    expect(normalizeCheckIntervalMinutes(0)).toBe(DEFAULT_CHECK_INTERVAL_MINUTES);
    expect(normalizeCheckIntervalMinutes('7.6')).toBe(8);
  });

  test('calculates the next check from the normalized interval', () => {
    expect(getNextCheckTimestamp(1_000, 2)).toBe(121_000);
    expect(getNextCheckTimestamp(1_000, 'invalid')).toBe(301_000);
  });

  test('prefers scheduler config while accepting the legacy compatibility field', () => {
    expect(getSchedulerIntervalMinutes({ scheduler: { intervalMinutes: 12 } })).toBe(12);
    expect(getSchedulerIntervalMinutes({ checkIntervalMinutes: 7 })).toBe(7);
  });

  test('strictly validates API/CLI scheduler intervals', () => {
    expect(parseSchedulerIntervalMinutes(1)).toBe(1);
    expect(parseSchedulerIntervalMinutes(1440)).toBe(1440);
    for (const invalid of [0, 1441, 1.5, '5', Number.NaN]) {
      expect(() => parseSchedulerIntervalMinutes(invalid)).toThrow();
    }
  });

  test('disabled schedules are never due automatically', () => {
    expect(isScheduledSweepDue({ enabled: false, nowMs: 10_000, nextCheckTime: 1 })).toBe(false);
    expect(isScheduledSweepDue({ enabled: true, nowMs: 10_000, nextCheckTime: 9_999 })).toBe(true);
  });
});

describe('scheduler commands', () => {
  test('distinguishes reschedule from run-now and operational wakes', () => {
    const state = createSchedulerCommandState();
    const reschedule = issueSchedulerCommand(state, 'reschedule', { now: 1 });
    const backfill = issueSchedulerCommand(state, 'backfill', { mappingId: 'mapping', now: 2 });
    const pin = issueSchedulerCommand(state, 'pin-sync', { mappingId: 'mapping', now: 3 });
    const runNow = issueSchedulerCommand(state, 'run-now', { now: 4 });
    expect(getSchedulerCommandsSince(state, 0).map((command) => command.kind)).toEqual([
      'reschedule',
      'backfill',
      'pin-sync',
      'run-now',
    ]);
    expect(schedulerCommandRequestsSweep(reschedule)).toBe(false);
    expect(schedulerCommandRequestsSweep(backfill)).toBe(false);
    expect(schedulerCommandRequestsSweep(pin)).toBe(false);
    expect(schedulerCommandRequestsSweep(runNow)).toBe(true);
  });
});

describe('runtime commands', () => {
  test('keeps daemon and web defaults', () => {
    expect(parseRuntimeOptions([])).toMatchObject({
      dryRun: false,
      runOnce: false,
      web: true,
    });
  });

  test('parses one-shot, web, import, and backfill switches', () => {
    expect(
      parseRuntimeOptions([
        '--run-once',
        '--dry-run',
        '--bypass-filters',
        '--no-web',
        '--backfill-mapping',
        '@source',
        '--backfill-limit',
        '25',
        '--import-history',
        '--username',
        'source',
        '--limit',
        '10',
      ]),
    ).toMatchObject({
      runOnce: true,
      dryRun: true,
      bypassFilters: true,
      web: false,
      backfillMapping: '@source',
      backfillLimit: 25,
      importHistory: true,
      username: 'source',
      limit: 10,
    });
  });
});
