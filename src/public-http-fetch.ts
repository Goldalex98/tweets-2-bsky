import {
  resolveWebhookTarget,
  sendPinnedHttpsRequest,
  type PinnedResponse,
  type WebhookDependencies,
  systemWebhookDependencies,
} from './webhook.js';

export interface PublicHttpsFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  lookup?: WebhookDependencies['lookup'];
  send?: WebhookDependencies['send'];
}

export interface PublicHttpsFetchResult {
  url: string;
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

function redirectLocation(response: PinnedResponse, current: URL): string | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.location;
  if (!location) return undefined;
  try {
    return new URL(location, current).toString();
  } catch {
    return undefined;
  }
}

/**
 * Fetch a public HTTPS URL with DNS pinning and per-hop private-network checks.
 * Redirects are followed only after each Location target is re-validated.
 */
export async function fetchPublicHttps(
  rawUrl: string,
  options: PublicHttpsFetchOptions = {},
): Promise<PublicHttpsFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const method = options.method ?? 'GET';
  const lookup = options.lookup ?? systemWebhookDependencies.lookup;
  const send = options.send ?? sendPinnedHttpsRequest;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resolved = await resolveWebhookTarget(current, false, lookup);
    const response = await send({
      target: resolved.target,
      ...(resolved.pinnedAddress ? { pinnedAddress: resolved.pinnedAddress } : {}),
      ...(resolved.family ? { family: resolved.family } : {}),
      method,
      headers: options.headers ?? {},
      timeoutMs,
      ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    });
    const next = redirectLocation(response, resolved.target);
    if (!next) {
      return {
        url: resolved.target.toString(),
        status: response.status,
        headers: response.headers,
        body: response.body,
      };
    }
    if (hop === maxRedirects) {
      throw new Error('Too many redirects while fetching public HTTPS URL.');
    }
    current = next;
  }

  throw new Error('Too many redirects while fetching public HTTPS URL.');
}
