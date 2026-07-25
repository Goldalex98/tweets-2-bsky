import { describe, expect, test } from 'bun:test';
import { applyPolicyPreset, listPolicyPresets } from '../../src/config/policy-presets.js';

describe('policy presets', () => {
  test('lists the three server-owned presets', () => {
    const presets = listPolicyPresets();
    expect(presets.map((preset) => preset.id)).toEqual(['one-to-one', 'aggregate-feed', 'daily-digest']);
  });

  test('one-to-one disables attribution and digest', () => {
    const applied = applyPolicyPreset('one-to-one', { sourceCount: 1 });
    expect(applied.postingPolicy.attribution.mode).toBe('never');
    expect(applied.delivery.mode).toBe('immediate');
    expect(applied.duplicateSuppression.enabled).toBe(false);
  });

  test('aggregate-feed enables attribution and dedup', () => {
    const applied = applyPolicyPreset('aggregate-feed', { sourceCount: 3 });
    expect(applied.postingPolicy.attribution.mode).toBe('multiple-sources');
    expect(applied.duplicateSuppression.enabled).toBe(true);
    expect(applied.moderationPolicy.dryRun).toBe(true);
  });

  test('daily-digest requires confirmed timezone and hour', () => {
    const applied = applyPolicyPreset('daily-digest', {
      sourceCount: 2,
      timezone: 'America/New_York',
      hour: 8,
    });
    expect(applied.delivery.mode).toBe('digest');
    expect(applied.delivery.digest.enabled).toBe(true);
    expect(applied.delivery.digest.timezone).toBe('America/New_York');
    expect(applied.delivery.digest.hour).toBe(8);
  });
});
