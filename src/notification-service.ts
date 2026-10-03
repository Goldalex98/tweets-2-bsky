import { AlertCooldown } from './alert-cooldown.js';
import { getConfig } from './config-manager.js';
import { webhookDeliveryService } from './db.js';
import {
  WebhookNotifier,
  systemWebhookDependencies,
  type WebhookEventPayload,
} from './webhook.js';

const notifier = new WebhookNotifier(() => getConfig().notifications, {
  ...systemWebhookDependencies,
  store: webhookDeliveryService,
});

const cooldown = new AlertCooldown();

export function notifyOperationsEvent(payload: WebhookEventPayload): void {
  if (!cooldown.shouldSend(payload, Date.now())) return;
  void notifier.notify(payload).catch(() => {
    // Delivery status is persisted by the notifier. Never log target URLs or secrets.
  });
}
