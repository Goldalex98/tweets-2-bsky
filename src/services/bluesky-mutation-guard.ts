import { getConfig } from '../config-manager.js';
import { blueskyAccountRuntimeService } from '../db.js';
import { normalizeBlueskyServiceUrl } from '../mapping-helpers.js';
import { fetchWithDeliveryContext } from './delivery-context.js';

interface AccountIdentity {
  bskyAccountId?: string;
  bskyIdentifier: string;
  bskyServiceUrl?: string;
}

export function isBlueskyAccountBlocked(accountId?: string): boolean {
  return !!accountId && !!blueskyAccountRuntimeService.getBlock(accountId).blockedReason;
}

export function blockedBlueskyDestinationIds(
  destinations: readonly { id: string; bskyAccountId?: string }[],
): string[] {
  return destinations
    .filter((destination) => isBlueskyAccountBlocked(destination.bskyAccountId))
    .map((destination) => destination.id);
}

export function providerAccountBlock(data: unknown): 'AccountTakedown' | 'AccountDeactivated' | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const response = data as { error?: unknown; active?: unknown; status?: unknown };
  if (response.error === 'AccountTakedown' || response.error === 'AccountDeactivated') return response.error;
  if (response.active === false && response.status === 'takendown') return 'AccountTakedown';
  if (response.active === false && response.status === 'deactivated') return 'AccountDeactivated';
  return undefined;
}

const AUTH_METHODS = new Set([
  'com.atproto.server.createSession',
  'com.atproto.server.refreshSession',
  'com.atproto.server.getSession',
]);

/** Gate every managed client mutation, including manual profile/pin/follow paths. */
export function managedBlueskyFetch(identity: AccountIdentity, timeoutMs = 180_000): typeof globalThis.fetch {
  return async (input, init) => {
    const identifier = identity.bskyIdentifier.toLowerCase();
    const accountId =
      identity.bskyAccountId ??
      getConfig().blueskyAccounts.find(
        (account) =>
          normalizeBlueskyServiceUrl(account.serviceUrl) === normalizeBlueskyServiceUrl(identity.bskyServiceUrl) &&
          [account.loginIdentifier, account.canonicalHandle, account.did].some(
            (value) => value?.toLowerCase() === identifier,
          ),
      )?.id;
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const lexicon = new URL(url).pathname.split('/').pop() ?? '';
    if (
      accountId &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      !AUTH_METHODS.has(lexicon) &&
      isBlueskyAccountBlocked(accountId)
    ) {
      throw new Error('Bluesky account is blocked; explicit validated resume is required.');
    }
    const response = await fetchWithDeliveryContext(input, init, timeoutMs);
    if (accountId && (!response.ok || AUTH_METHODS.has(lexicon))) {
      let data: unknown;
      try {
        data = await response.clone().json();
      } catch {
        /* Non-JSON errors are not evidence of takedown. */
      }
      const reason = providerAccountBlock(data);
      if (reason) blueskyAccountRuntimeService.block(accountId, reason);
    }
    return response;
  };
}
