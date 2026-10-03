import { describe, expect, test } from 'bun:test';
import { AUTH_ALERT_COOLDOWN_MS, AlertCooldown } from '../../src/alert-cooldown.js';

const alert = (event: 'twitter-auth-failure' | 'bsky-auth-failure' | 'queue-parked', scope: Record<string, string>) => ({
  event,
  occurredAt: new Date(0).toISOString(),
  message: 'Redacted',
  details: scope,
});

describe('operations alert cooldown', () => {
  test('repeated auth alerts for the same source send once per cooldown', () => {
    const cooldown = new AlertCooldown();
    expect(cooldown.shouldSend(alert('twitter-auth-failure', { sourceId: 's1' }), 0)).toBe(true);
    expect(cooldown.shouldSend(alert('twitter-auth-failure', { sourceId: 's1' }), 60_000)).toBe(false);
    expect(cooldown.shouldSend(alert('twitter-auth-failure', { sourceId: 's2' }), 60_000)).toBe(true);
    expect(cooldown.shouldSend(alert('bsky-auth-failure', { destinationId: 's1' }), 60_000)).toBe(true);
    expect(cooldown.shouldSend(alert('twitter-auth-failure', { sourceId: 's1' }), AUTH_ALERT_COOLDOWN_MS)).toBe(true);
  });

  test('other events are never suppressed', () => {
    const cooldown = new AlertCooldown();
    expect(cooldown.shouldSend(alert('queue-parked', { destinationId: 'd1' }), 0)).toBe(true);
    expect(cooldown.shouldSend(alert('queue-parked', { destinationId: 'd1' }), 1)).toBe(true);
  });
});
