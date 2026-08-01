import { describe, expect, test } from 'bun:test';
import { getDefaultConfig } from '../../src/config/defaults.js';
import {
  buildSchedulerSettingsResponse,
  type SettingsRouterDependencies,
} from '../../src/routes/settings-router.js';

describe('scheduler settings response', () => {
  test('counts canonical X sources once and exposes effective safety defaults', () => {
    const config = getDefaultConfig();
    config.mappings = [
      {
        id: 'destination-one',
        enabled: true,
        twitterUsernames: ['sharedwire'],
        pausedTwitterUsernames: [],
      },
      {
        id: 'destination-two',
        enabled: true,
        twitterUsernames: ['sharedwire'],
        pausedTwitterUsernames: [],
      },
    ] as typeof config.mappings;

    const dependencies = {
      getConfigVersion: () => ({ revision: 7, updatedAt: '2026-08-01T12:00:00.000Z' }),
      getSchedulerIntervalMinutes: () => 5,
      getActiveTwitterUsernames: (mapping: (typeof config.mappings)[number]) => mapping.twitterUsernames,
      getSchedulerRuntime: () => ({ lastCheckTime: 1000, nextCheckTime: 2000 }),
    } as unknown as SettingsRouterDependencies;

    const response = buildSchedulerSettingsResponse(dependencies, config);

    expect(response.enabledSourceCount).toBe(1);
    expect(response.estimatedChecksPerHour).toBe(12);
    expect(response.diagnostics).toMatchObject({
      scraperMinGapMs: 800,
      scraperJitterMs: 400,
      scraperMaxRequestsPerWindow: 150,
      scraperWindowMs: 900_000,
      schedulerMaxSourcesPerSweep: 25,
      schedulerJitterPercent: 10,
      fetchConcurrency: 4,
    });
  });
});
