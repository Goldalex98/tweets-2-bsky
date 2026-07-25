import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { NotificationConfig, NotificationEvent } from './config/schemas.js';
import { sanitizeForDiagnostics } from './observability.js';

export interface WebhookEventPayload {
  event: NotificationEvent;
  occurredAt: string;
  message: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export interface WebhookDeliveryResult {
  id: string;
  event: NotificationEvent;
  status: 'filtered' | 'delivered' | 'failed';
  attempts: number;
  statusCode?: number;
  lastError?: string;
  deliveredAt?: number;
}

export interface WebhookDeliveryStore {
  save(result: WebhookDeliveryResult): void;
}

/**
 * An outbound request whose transport address is fixed to an already validated
 * IP. `target` still supplies the Host header and TLS server name so the
 * request is indistinguishable from an ordinary one to the legitimate origin.
 */
export interface PinnedRequest {
  target: URL;
  pinnedAddress?: string;
  family?: number;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
}

export interface PinnedResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export type PinnedRequestSender = (request: PinnedRequest) => Promise<PinnedResponse>;

export interface WebhookDependencies {
  send: PinnedRequestSender;
  lookup(hostname: string): Promise<Array<{ address: string; family: number }>>;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  store?: WebhookDeliveryStore;
}

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Issues the request against a pinned address. Node re-resolves DNS on every
 * connection, so validating a hostname and then handing the hostname to the
 * HTTP client leaves a rebinding window; connecting to the validated address
 * closes it. Redirects are never followed because a redirect target has not
 * been through the same validation.
 */
export function sendPinnedHttpsRequest(request: PinnedRequest): Promise<PinnedResponse> {
  if (request.target.protocol !== 'https:') {
    return Promise.reject(new Error('Pinned requests must use HTTPS.'));
  }
  const maxResponseBytes = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return new Promise<PinnedResponse>((resolve, reject) => {
    const clientRequest = https.request(
      {
        host: request.pinnedAddress ?? request.target.hostname,
        ...(request.family ? { family: request.family } : {}),
        port: Number(request.target.port) || 443,
        path: `${request.target.pathname}${request.target.search}`,
        method: request.method,
        servername: request.target.hostname,
        headers: { host: request.target.host, ...request.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            response.destroy();
            clientRequest.destroy();
            reject(new Error('Response exceeded the allowed size.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: response.headers as Record<string, string | undefined>,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      },
    );
    clientRequest.setTimeout(Math.max(1, request.timeoutMs), () => {
      clientRequest.destroy(new Error('Request timed out.'));
    });
    clientRequest.on('error', reject);
    if (request.body !== undefined) clientRequest.write(request.body);
    clientRequest.end();
  });
}

export const systemWebhookDependencies: WebhookDependencies = {
  send: sendPinnedHttpsRequest,
  lookup: async (hostname) => lookup(hostname, { all: true }),
  clock: {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
};

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

/** Bun may keep IPv6 brackets in `URL.hostname`; Node/WHATWG strip them. */
export function unwrapIpLiteralHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = unwrapIpLiteralHostname(address).toLowerCase().split('%')[0] ?? '';
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateNetworkAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split('.').map(Number);
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export interface ResolvedWebhookTarget {
  target: URL;
  /** Undefined only when private destinations are explicitly permitted. */
  pinnedAddress?: string;
  family?: number;
}

export async function resolveWebhookTarget(
  rawUrl: string,
  allowPrivate: boolean,
  resolver: WebhookDependencies['lookup'] = systemWebhookDependencies.lookup,
): Promise<ResolvedWebhookTarget> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('Webhook URL is invalid.');
  }
  if (target.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS.');
  if (target.username || target.password) throw new Error('Webhook URL must not contain credentials.');
  if (BLOCKED_HOSTNAMES.has(target.hostname.toLowerCase())) {
    if (!allowPrivate) throw new Error('Webhook URL resolves to a private network.');
    return { target };
  }
  if (allowPrivate) return { target };
  const hostLiteral = unwrapIpLiteralHostname(target.hostname);
  const literalFamily = isIP(hostLiteral);
  const addresses = literalFamily
    ? [{ address: hostLiteral, family: literalFamily }]
    : await resolver(target.hostname);
  if (addresses.length === 0 || addresses.some((entry) => isPrivateNetworkAddress(entry.address))) {
    throw new Error('Webhook URL resolves to a private network.');
  }
  const [pinned] = addresses;
  return {
    target,
    pinnedAddress: pinned?.address,
    ...(pinned?.family ? { family: pinned.family } : {}),
  };
}

export async function validateWebhookTarget(
  rawUrl: string,
  allowPrivate: boolean,
  resolver: WebhookDependencies['lookup'] = systemWebhookDependencies.lookup,
): Promise<URL> {
  return (await resolveWebhookTarget(rawUrl, allowPrivate, resolver)).target;
}

export class WebhookNotifier {
  constructor(
    private readonly getConfig: () => NotificationConfig,
    private readonly dependencies: WebhookDependencies = systemWebhookDependencies,
  ) {}

  async notify(payload: WebhookEventPayload): Promise<WebhookDeliveryResult> {
    const config = this.getConfig();
    const id = randomUUID();
    if (!config.enabled || !config.webhookUrl || !config.events[payload.event]) {
      const filtered: WebhookDeliveryResult = { id, event: payload.event, status: 'filtered', attempts: 0 };
      this.dependencies.store?.save(filtered);
      return filtered;
    }

    const safePayload = sanitizeForDiagnostics(payload);
    const body = JSON.stringify(safePayload);
    const maxAttempts = Math.max(1, Math.min(config.maxAttempts, 10));
    let lastError = 'Webhook delivery failed.';
    let lastStatusCode: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timestamp = String(Math.floor(this.dependencies.clock.now() / 1000));
      const signature = config.webhookSecret
        ? createHmac('sha256', config.webhookSecret).update(`${timestamp}.${body}`).digest('hex')
        : undefined;
      try {
        // Re-resolve per attempt so a rotated record is honoured, then pin the
        // address that passed validation for this attempt's connection.
        const resolved = await resolveWebhookTarget(
          config.webhookUrl,
          config.allowPrivate,
          this.dependencies.lookup,
        );
        const response = await this.dependencies.send({
          target: resolved.target,
          ...(resolved.pinnedAddress ? { pinnedAddress: resolved.pinnedAddress } : {}),
          ...(resolved.family ? { family: resolved.family } : {}),
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'tweets-2-bsky-webhook/1',
            'x-tweets2bsky-timestamp': timestamp,
            ...(signature ? { 'x-tweets2bsky-signature': `sha256=${signature}` } : {}),
          },
          body,
          timeoutMs: config.timeoutMs,
        });
        lastStatusCode = response.status;
        if (response.ok) {
          const delivered: WebhookDeliveryResult = {
            id,
            event: payload.event,
            status: 'delivered',
            attempts: attempt,
            statusCode: response.status,
            deliveredAt: this.dependencies.clock.now(),
          };
          this.dependencies.store?.save(delivered);
          return delivered;
        }
        lastError =
          response.status >= 300 && response.status < 400
            ? 'Webhook redirected; redirects are not followed.'
            : `Webhook returned HTTP ${response.status}.`;
      } catch (error) {
        lastError =
          error instanceof Error && error.message.includes('private network')
            ? 'Webhook target resolved to a private network.'
            : error instanceof Error
              ? `Webhook request failed (${error.name}).`
              : 'Webhook request failed.';
      }
      if (attempt < maxAttempts) {
        await this.dependencies.clock.sleep(config.backoffMs * 2 ** (attempt - 1));
      }
    }

    const failed: WebhookDeliveryResult = {
      id,
      event: payload.event,
      status: 'failed',
      attempts: maxAttempts,
      statusCode: lastStatusCode,
      lastError: String(sanitizeForDiagnostics(lastError)).slice(0, 500),
    };
    this.dependencies.store?.save(failed);
    return failed;
  }
}
