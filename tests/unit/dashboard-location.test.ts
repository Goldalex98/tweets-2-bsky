import { describe, expect, test } from 'bun:test';
import {
  buildDashboardUrl,
  parseDashboardLocation,
} from '../../web/src/lib/dashboard-utils.ts';

describe('dashboard location helpers', () => {
  test('parses settings bluesky deep link', () => {
    const location = parseDashboardLocation('/settings/bluesky', '');
    expect(location.tab).toBe('settings');
    expect(location.settingsSection).toBe('bluesky');
  });

  test('parses destination editor deep link', () => {
    const location = parseDashboardLocation('/accounts', '?destinationId=dest-1&section=delivery');
    expect(location.tab).toBe('accounts');
    expect(location.destinationId).toBe('dest-1');
    expect(location.editSection).toBe('delivery');
  });

  test('parses activity scope deep link', () => {
    const location = parseDashboardLocation('/activity', '?destinationId=dest-1&routeId=route-9');
    expect(location.tab).toBe('activity');
    expect(location.destinationId).toBe('dest-1');
    expect(location.routeId).toBe('route-9');
  });

  test('builds settings and accounts URLs', () => {
    expect(buildDashboardUrl({ tab: 'settings', settingsSection: 'bluesky' })).toBe('/settings/bluesky');
    expect(
      buildDashboardUrl({ tab: 'accounts', destinationId: 'abc', editSection: 'moderation' }),
    ).toBe('/accounts?destinationId=abc&section=moderation');
  });
});
