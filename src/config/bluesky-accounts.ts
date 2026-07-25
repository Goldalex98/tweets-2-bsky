import { randomUUID } from 'node:crypto';
import { normalizeBlueskyServiceUrl, normalizeTwitterUsername } from '../mapping-helpers.js';
import type { AppConfig, BlueskyAccount, Destination } from './schemas.js';

export interface ResolvedBlueskyCredentials {
  accountId: string;
  destinationId?: string;
  storageKey?: string;
  serviceUrl: string;
  loginIdentifier: string;
  appPassword: string;
  did?: string;
  canonicalHandle: string;
  displayIdentifier: string;
}

export function blueskyAccountIdentity(account: Pick<BlueskyAccount, 'did' | 'serviceUrl' | 'loginIdentifier'>): string {
  const did = typeof account.did === 'string' ? account.did.trim().toLowerCase() : '';
  if (did) {
    // DIDs are already full URIs (e.g. did:plc:…); do not re-prefix the scheme.
    return did;
  }
  const identifier =
    normalizeTwitterUsername(account.loginIdentifier) ?? account.loginIdentifier.trim().toLowerCase();
  return `account:${normalizeBlueskyServiceUrl(account.serviceUrl)}|${identifier}`;
}

export function findBlueskyAccount(
  config: Pick<AppConfig, 'blueskyAccounts'>,
  accountId: string,
): BlueskyAccount | undefined {
  return config.blueskyAccounts.find((account) => account.id === accountId);
}

export function findBlueskyAccountByIdentity(
  config: Pick<AppConfig, 'blueskyAccounts'>,
  identity: Pick<BlueskyAccount, 'did' | 'serviceUrl' | 'loginIdentifier'>,
  excludeId?: string,
): BlueskyAccount | undefined {
  const target = blueskyAccountIdentity(identity);
  return config.blueskyAccounts.find(
    (account) => account.id !== excludeId && blueskyAccountIdentity(account) === target,
  );
}

export function findDestinationForAccount(
  config: Pick<AppConfig, 'destinations'>,
  accountId: string,
): Destination | undefined {
  return config.destinations.find((destination) => destination.bskyAccountId === accountId);
}

export function resolveBlueskyAccount(
  config: Pick<AppConfig, 'blueskyAccounts'>,
  accountId: string,
): BlueskyAccount {
  const account = findBlueskyAccount(config, accountId);
  if (!account) {
    throw new Error(`Bluesky account ${accountId} was not found.`);
  }
  return account;
}

export function resolveDestinationCredentials(
  config: Pick<AppConfig, 'blueskyAccounts' | 'destinations'>,
  destinationId: string,
): ResolvedBlueskyCredentials {
  const destination = config.destinations.find((entry) => entry.id === destinationId);
  if (!destination) {
    throw new Error(`Destination ${destinationId} was not found.`);
  }
  if (!destination.bskyAccountId) {
    throw new Error(`Destination ${destinationId} is not linked to a Bluesky account.`);
  }
  const account = resolveBlueskyAccount(config, destination.bskyAccountId);
  const canonicalHandle =
    normalizeTwitterUsername(account.canonicalHandle ?? account.loginIdentifier) ??
    account.loginIdentifier.trim().toLowerCase();
  return {
    accountId: account.id,
    destinationId: destination.id,
    storageKey: destination.storageKey,
    serviceUrl: account.serviceUrl,
    loginIdentifier: account.loginIdentifier,
    appPassword: account.appPassword,
    did: account.did,
    canonicalHandle,
    displayIdentifier: canonicalHandle,
  };
}

export function createBlueskyAccount(input: {
  loginIdentifier: string;
  appPassword: string;
  serviceUrl?: string;
  label?: string;
  did?: string;
  canonicalHandle?: string;
  createdByUserId?: string;
  legacyDestinationIds?: string[];
  now?: Date;
}): BlueskyAccount {
  const now = (input.now ?? new Date()).toISOString();
  const loginIdentifier = input.loginIdentifier.trim().toLowerCase();
  if (!loginIdentifier) {
    throw new Error('Bluesky login identifier is required.');
  }
  if (!input.appPassword.trim()) {
    throw new Error('Bluesky app password is required.');
  }
  return {
    id: randomUUID(),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    serviceUrl: normalizeBlueskyServiceUrl(input.serviceUrl),
    loginIdentifier,
    appPassword: input.appPassword,
    ...(input.did?.trim() ? { did: input.did.trim() } : {}),
    ...(input.canonicalHandle
      ? { canonicalHandle: normalizeTwitterUsername(input.canonicalHandle) ?? input.canonicalHandle }
      : {}),
    ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
    createdAt: now,
    updatedAt: now,
    ...(input.legacyDestinationIds?.length
      ? { metadata: { legacyDestinationIds: [...input.legacyDestinationIds] } }
      : {}),
  };
}

export function applyValidatedAccountIdentity(
  account: BlueskyAccount,
  validation: { did: string; handle: string; serviceUrl: string },
  now = new Date(),
): BlueskyAccount {
  return {
    ...account,
    did: validation.did.trim(),
    canonicalHandle: normalizeTwitterUsername(validation.handle) ?? validation.handle.trim().toLowerCase(),
    serviceUrl: normalizeBlueskyServiceUrl(validation.serviceUrl || account.serviceUrl),
    updatedAt: now.toISOString(),
  };
}

export function sanitizeBlueskyAccount(
  account: BlueskyAccount,
  extras: {
    linkedDestinationId?: string | null;
    credentialConfigured?: boolean;
    health?: Record<string, unknown> | null;
  } = {},
): Omit<BlueskyAccount, 'appPassword'> & {
  credentialConfigured: boolean;
  linkedDestinationId: string | null;
  health: Record<string, unknown> | null;
} {
  const { appPassword: _password, ...rest } = account;
  return {
    ...rest,
    credentialConfigured: extras.credentialConfigured ?? account.appPassword.length > 0,
    linkedDestinationId: extras.linkedDestinationId ?? null,
    health: extras.health ?? null,
  };
}

/**
 * Non-admins may mutate an account when they manage its linked destination,
 * or when they created the account and it is still unlinked. Orphan accounts
 * without createdByUserId require manageAllMappings.
 */
export function canMutateBlueskyAccount(
  config: Pick<AppConfig, 'blueskyAccounts' | 'destinations'>,
  requester: { id: string },
  accountId: string,
  options: {
    canManageAllMappings: boolean;
    canManageDestination(destinationId: string): boolean;
  },
): boolean {
  if (options.canManageAllMappings) {
    return true;
  }
  const account = findBlueskyAccount(config, accountId);
  if (!account) {
    return true;
  }
  const linked = findDestinationForAccount(config, accountId);
  if (linked) {
    return options.canManageDestination(linked.id);
  }
  return account.createdByUserId === requester.id;
}
