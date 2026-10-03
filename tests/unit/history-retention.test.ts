import { expect, test } from 'bun:test';
import { historyRetentionDays } from '../../src/history-retention.js';

test('HISTORY_RETENTION_DAYS defaults to 90, clamps to 0..3650, and 0 disables pruning', () => {
  expect(historyRetentionDays(undefined)).toBe(90);
  expect(historyRetentionDays('abc')).toBe(90);
  expect(historyRetentionDays('30')).toBe(30);
  expect(historyRetentionDays('30.4')).toBe(30);
  expect(historyRetentionDays('0')).toBe(0);
  expect(historyRetentionDays('-5')).toBe(0);
  expect(historyRetentionDays('99999')).toBe(3650);
});
