import { describe, expect, test } from 'bun:test';
import { getDefaultConfig, hasConfigVersionConflict } from '../../src/config-manager.js';
import { normalizeConfigV3 } from '../../src/config/normalize.js';

describe('configuration optimistic concurrency', () => {
  test('normalizes legacy documents with a stable initial version', () => {
    const config = normalizeConfigV3({ schemaVersion: 6, sources: [], destinations: [], routes: [] });
    expect(config.revision).toBe(0);
    expect(config.updatedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  test('detects stale revision and updatedAt values independently', () => {
    const config = getDefaultConfig();
    config.revision = 12;
    config.updatedAt = '2026-07-24T20:00:00.000Z';

    expect(hasConfigVersionConflict(config, { revision: 11, updatedAt: config.updatedAt })).toBe(true);
    expect(hasConfigVersionConflict(config, { revision: 12, updatedAt: '2026-07-24T19:00:00.000Z' })).toBe(true);
    expect(hasConfigVersionConflict(config, { revision: 12, updatedAt: config.updatedAt })).toBe(false);
  });

  test('keeps omitted tokens backward compatible for read-only and legacy callers', () => {
    expect(hasConfigVersionConflict(getDefaultConfig(), undefined)).toBe(false);
    expect(hasConfigVersionConflict(getDefaultConfig(), {})).toBe(false);
  });
});
