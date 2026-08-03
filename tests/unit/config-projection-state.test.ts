import { describe, expect, test } from 'bun:test';
import { normalizeConfig } from '../../src/config-manager.js';
import { applyMappingProjection, projectAccountMappings } from '../../src/config/projection.js';
import type { AccountMapping, AppConfig } from '../../src/config/schemas.js';

function createConfig(): AppConfig {
  return normalizeConfig({
    schemaVersion: 2,
    twitter: { authToken: '', ct0: '' },
    scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
    groups: [],
    users: [],
    mappings: [
      {
        id: 'destination-1',
        twitterUsernames: ['alpha', 'beta'],
        bskyIdentifier: 'destination.example',
        bskyPassword: 'destination-password',
        enabled: true,
      },
    ],
  });
}

function setSourceEnabled(config: AppConfig, username: string, enabled: boolean): void {
  const source = config.sources.find((entry) => entry.username === username);
  if (!source) throw new Error(`missing source ${username}`);
  source.enabled = enabled;
}

function routeFor(config: AppConfig, username: string) {
  const source = config.sources.find((entry) => entry.username === username);
  const route = config.routes.find((entry) => entry.sourceId === source?.id);
  if (!route) throw new Error(`missing route for ${username}`);
  return route;
}

describe('legacy mapping projection state', () => {
  test('a globally disabled source is not persisted as a route pause', () => {
    const config = createConfig();
    setSourceEnabled(config, 'alpha', false);

    const mappings = projectAccountMappings(config);
    const mapping = mappings[0];
    // The compatibility view still shows the source as paused, because that is
    // what the legacy dashboard renders, but it is not a route-scoped pause.
    expect(mapping?.pausedTwitterUsernames).toEqual(['alpha']);
    expect(mapping?.routePausedUsernames).toEqual([]);

    const saved = applyMappingProjection(config, mappings);
    expect(routeFor(saved, 'alpha').relationship.sourcePaused).toBe(false);
    expect(routeFor(saved, 'alpha').enabled).toBe(true);

    // Re-enabling the source is enough to resume delivery; no route repair step
    // is required.
    setSourceEnabled(saved, 'alpha', true);
    expect(projectAccountMappings(saved)[0]?.pausedTwitterUsernames).toBeUndefined();
  });

  test('an explicit route pause survives repeated compatibility saves', () => {
    const config = createConfig();
    const mappings = projectAccountMappings(config);
    const mapping = mappings[0] as AccountMapping;
    mapping.pausedTwitterUsernames = ['beta'];

    const paused = applyMappingProjection(config, mappings);
    expect(routeFor(paused, 'beta').relationship.sourcePaused).toBe(true);
    expect(routeFor(paused, 'beta').enabled).toBe(false);
    expect(routeFor(paused, 'alpha').relationship.sourcePaused).toBe(false);

    const reprojected = projectAccountMappings(paused);
    expect(reprojected[0]?.routePausedUsernames).toEqual(['beta']);
    const resaved = applyMappingProjection(paused, reprojected);
    expect(routeFor(resaved, 'beta').relationship.sourcePaused).toBe(true);
  });

  test('the two states stay independent when they overlap', () => {
    const config = createConfig();
    const initial = projectAccountMappings(config);
    (initial[0] as AccountMapping).pausedTwitterUsernames = ['beta'];
    const paused = applyMappingProjection(config, initial);

    // The source is now disabled globally as well as paused on this route.
    setSourceEnabled(paused, 'beta', false);
    const combined = applyMappingProjection(paused, projectAccountMappings(paused));
    expect(routeFor(combined, 'beta').relationship.sourcePaused).toBe(true);

    setSourceEnabled(combined, 'beta', true);
    const afterReEnable = applyMappingProjection(combined, projectAccountMappings(combined));
    expect(routeFor(afterReEnable, 'beta').relationship.sourcePaused).toBe(true);
    expect(routeFor(afterReEnable, 'alpha').relationship.sourcePaused).toBe(false);
  });

  test('callers that predate the route-scoped set keep the legacy pause behaviour', () => {
    const config = createConfig();
    const legacyMapping = JSON.parse(JSON.stringify(projectAccountMappings(config)[0])) as AccountMapping;
    legacyMapping.pausedTwitterUsernames = ['alpha'];
    expect(legacyMapping.routePausedUsernames).toBeUndefined();

    const saved = applyMappingProjection(config, [legacyMapping]);
    expect(routeFor(saved, 'alpha').relationship.sourcePaused).toBe(true);
  });

  test('a compatibility mode map seeds only newly projected routes', () => {
    const config = createConfig();
    const mapping = projectAccountMappings(config)[0] as AccountMapping;
    mapping.twitterUsernames = [...mapping.twitterUsernames, 'delta', 'gamma'];
    mapping.initialImportModesByUsername = {
      ...mapping.initialImportModesByUsername,
      alpha: 'new-only',
      gamma: 'new-only',
    };

    const saved = applyMappingProjection(config, [mapping]);
    expect(routeFor(saved, 'alpha').initialImportMode).toBe('recent');
    expect(routeFor(saved, 'delta').initialImportMode).toBe('inherit');
    expect(routeFor(saved, 'gamma').initialImportMode).toBe('new-only');

    const projected = projectAccountMappings(saved)[0];
    expect(projected?.initialImportModesByUsername).toMatchObject({
      alpha: 'recent',
      delta: 'inherit',
      gamma: 'new-only',
    });
  });
});
