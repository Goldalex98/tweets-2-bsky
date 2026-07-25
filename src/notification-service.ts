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

export function notifyOperationsEvent(payload: WebhookEventPayload): void {
  void notifier.notify(payload).catch(() => {
    // Delivery status is persisted by the notifier. Never log target URLs or secrets.
  });
}
