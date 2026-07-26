import { describe, expect, test } from 'bun:test';
import {
  parseSqliteUtcTimestampMs,
  toIsoUtcTimestamp,
} from '../../src/sqlite-utc-timestamp.ts';

describe('SQLite UTC timestamp helpers', () => {
  test('treats naive CURRENT_TIMESTAMP strings as UTC', () => {
    expect(parseSqliteUtcTimestampMs('2026-07-25 22:08:00')).toBe(Date.parse('2026-07-25T22:08:00.000Z'));
    expect(toIsoUtcTimestamp('2026-07-25 22:08:00')).toBe('2026-07-25T22:08:00.000Z');
  });

  test('preserves already-timezone-aware ISO values', () => {
    expect(toIsoUtcTimestamp('2026-07-25T22:08:00.000Z')).toBe('2026-07-25T22:08:00.000Z');
    expect(parseSqliteUtcTimestampMs('2026-07-25T18:08:00-04:00')).toBe(Date.parse('2026-07-25T22:08:00.000Z'));
  });

  test('treats naive T-separated values without offset as UTC', () => {
    expect(toIsoUtcTimestamp('2026-07-25T22:08:00')).toBe('2026-07-25T22:08:00.000Z');
  });

  test('returns undefined for empty or invalid input', () => {
    expect(parseSqliteUtcTimestampMs(undefined)).toBeUndefined();
    expect(parseSqliteUtcTimestampMs('')).toBeUndefined();
    expect(parseSqliteUtcTimestampMs('not-a-date')).toBeUndefined();
    expect(toIsoUtcTimestamp(null)).toBeUndefined();
  });
});
