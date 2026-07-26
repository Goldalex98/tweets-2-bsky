import { describe, expect, test } from 'bun:test';
import {
  formatLocalDateTime,
  formatLocalTime,
  parseDisplayInstant,
} from '../../web/src/lib/dashboard-utils.ts';

describe('display instant helpers', () => {
  test('parses naive SQLite UTC stamps as UTC instants', () => {
    const date = parseDisplayInstant('2026-07-25 22:08:00');
    expect(date?.toISOString()).toBe('2026-07-25T22:08:00.000Z');
  });

  test('formats ISO and naive stamps with local locale APIs', () => {
    const iso = '2026-07-25T22:08:00.000Z';
    const naive = '2026-07-25 22:08:00';
    expect(formatLocalDateTime(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatLocalDateTime(naive)).toBe(new Date(iso).toLocaleString());
    expect(formatLocalTime(naive)).toBe(
      new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  test('handles epoch numbers and invalid values', () => {
    expect(parseDisplayInstant(1_721_944_080_000)?.getTime()).toBe(1_721_944_080_000);
    expect(parseDisplayInstant(0)).toBeNull();
    expect(formatLocalDateTime(undefined)).toBe('Unknown time');
    expect(formatLocalTime('')).toBe('--');
  });
});
