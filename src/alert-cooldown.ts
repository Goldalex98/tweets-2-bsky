import type { WebhookEventPayload } from './webhook.js';

/** Auth alerts repeat on every sweep or worker claim while credentials stay broken. */
export const AUTH_ALERT_COOLDOWN_MS = 30 * 60_000;
const COOLDOWN_EVENTS = new Set<WebhookEventPayload['event']>(['twitter-auth-failure', 'bsky-auth-failure']);

/** Sends the first alert per event and source/destination, then at most one per cooldown. */
export class AlertCooldown {
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly cooldownMs = AUTH_ALERT_COOLDOWN_MS) {}

  shouldSend(payload: WebhookEventPayload, nowMs: number): boolean {
    if (!COOLDOWN_EVENTS.has(payload.event)) return true;
    const scope = payload.details?.destinationId ?? payload.details?.sourceId ?? '';
    const key = `${payload.event}\0${String(scope)}`;
    const last = this.lastSentAt.get(key);
    if (last !== undefined && nowMs - last < this.cooldownMs) return false;
    this.lastSentAt.set(key, nowMs);
    return true;
  }
}
