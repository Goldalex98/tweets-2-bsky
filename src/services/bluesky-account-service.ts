import {
  applyValidatedAccountIdentity,
  createBlueskyAccount,
  findBlueskyAccount,
  findBlueskyAccountByIdentity,
  findDestinationForAccount,
  sanitizeBlueskyAccount,
} from '../config/bluesky-accounts.js';
import type { AppConfig, BlueskyAccount } from '../config/schemas.js';
import { getConfigVersion } from '../config-manager.js';
import { blueskyAccountRuntimeService, dbService } from '../db.js';
import { clearCachedAgent } from '../bsky.js';
import { getDestinationStorageKey, historyIdentityKeys, resolveDestinationStorageKey } from '../mapping-helpers.js';
import { validateBlueskyCredentials } from '../profile-mirror.js';
import type { BlueskyAccountView } from '../routes/bluesky-accounts-router.js';

/**
 * A linked destination's queue/history identity is derived from the
 * account's DID/handle (the account overrides the destination's own
 * identity fields once linked; see `projectAccountMappings`). Validating or
 * rotating credentials can resolve or change the DID/handle, so the
 * effective storage key must be rekeyed in lockstep or duplicate detection
 * silently breaks for that destination.
 */
function accountStorageIdentity(account: Pick<BlueskyAccount, 'did' | 'canonicalHandle' | 'loginIdentifier'>) {
  return {
    bskyDid: account.did,
    bskyCanonicalHandle: account.canonicalHandle,
    bskyIdentifier: account.loginIdentifier,
  };
}

function rekeyLinkedDestinationIdentity(
  config: Pick<AppConfig, 'destinations'>,
  accountId: string,
  previousAccount: Pick<BlueskyAccount, 'did' | 'canonicalHandle' | 'loginIdentifier'>,
  nextAccount: Pick<BlueskyAccount, 'did' | 'canonicalHandle' | 'loginIdentifier'>,
): void {
  const linked = findDestinationForAccount(config, accountId);
  if (!linked) return;
  const stickyKey = resolveDestinationStorageKey({
    ...accountStorageIdentity(nextAccount),
    storageKey: linked.storageKey,
  });
  const previousKeys = historyIdentityKeys({
    ...accountStorageIdentity(previousAccount),
    storageKey: linked.storageKey,
  });
  const nextComputed = getDestinationStorageKey(accountStorageIdentity(nextAccount));
  for (const previousStorageKey of [...previousKeys, nextComputed]) {
    if (previousStorageKey !== stickyKey) {
      dbService.rekeyDestinationIdentity(previousStorageKey, stickyKey);
    }
  }
}

function toAccountView(config: AppConfig, account: BlueskyAccount): BlueskyAccountView {
  const linked = findDestinationForAccount(config, account.id);
  const health = blueskyAccountRuntimeService.get(account.id);
  const version = getConfigVersion(config);
  const sanitized = sanitizeBlueskyAccount(account, {
    linkedDestinationId: linked?.id ?? null,
    health: health
      ? {
          lastValidatedAt: health.lastValidatedAt,
          lastSuccessAt: health.lastSuccessAt,
          lastFailureAt: health.lastFailureAt,
          lastErrorCategory: health.lastErrorCategory,
          consecutiveFailures: health.consecutiveFailures,
        }
      : null,
  });
  return {
    id: sanitized.id,
    label: sanitized.label,
    serviceUrl: sanitized.serviceUrl,
    loginIdentifier: sanitized.loginIdentifier,
    did: sanitized.did,
    canonicalHandle: sanitized.canonicalHandle,
    createdAt: sanitized.createdAt,
    updatedAt: sanitized.updatedAt,
    credentialConfigured: sanitized.credentialConfigured,
    linkedDestinationId: sanitized.linkedDestinationId,
    health: sanitized.health as BlueskyAccountView['health'],
    revision: version.revision,
    updatedAtConfig: version.updatedAt,
  };
}

export function listBlueskyAccountViews(config: AppConfig): BlueskyAccountView[] {
  return config.blueskyAccounts
    .slice()
    .sort((left, right) => left.loginIdentifier.localeCompare(right.loginIdentifier))
    .map((account) => toAccountView(config, account));
}

export function getBlueskyAccountView(config: AppConfig, accountId: string): BlueskyAccountView | undefined {
  const account = config.blueskyAccounts.find((candidate) => candidate.id === accountId);
  return account ? toAccountView(config, account) : undefined;
}

export async function createValidatedBlueskyAccount(
  config: AppConfig,
  input: {
    loginIdentifier: string;
    appPassword: string;
    serviceUrl?: string;
    label?: string;
    requesterId?: string;
  },
  save: (next: AppConfig) => void,
): Promise<BlueskyAccountView> {
  const validation = await validateBlueskyCredentials({
    bskyIdentifier: input.loginIdentifier,
    bskyPassword: input.appPassword,
    bskyServiceUrl: input.serviceUrl,
  });
  const duplicate = findBlueskyAccountByIdentity(config, {
    did: validation.did,
    serviceUrl: validation.serviceUrl,
    loginIdentifier: validation.handle,
  });
  if (duplicate) {
    throw new Error(`Bluesky account already exists as ${duplicate.canonicalHandle ?? duplicate.loginIdentifier}.`);
  }
  let account = createBlueskyAccount({
    loginIdentifier: input.loginIdentifier,
    appPassword: input.appPassword,
    serviceUrl: input.serviceUrl,
    label: input.label,
    createdByUserId: input.requesterId,
  });
  account = applyValidatedAccountIdentity(account, validation);
  config.blueskyAccounts.push(account);
  save(config);
  blueskyAccountRuntimeService.recordSuccess(account.id, 'validate');
  return toAccountView(config, account);
}

export async function validateExistingBlueskyAccount(
  config: AppConfig,
  accountId: string,
  save: (next: AppConfig) => void,
): Promise<BlueskyAccountView> {
  const account = findBlueskyAccount(config, accountId);
  if (!account) throw new Error('Bluesky account not found.');
  let failureCategory = 'bsky-auth';
  try {
    const validation = await validateBlueskyCredentials({
      bskyIdentifier: account.loginIdentifier,
      bskyPassword: account.appPassword,
      bskyServiceUrl: account.serviceUrl,
    });
    const linked = findDestinationForAccount(config, account.id);
    if (account.did && validation.did.trim() !== account.did && linked) {
      // Auth succeeded; the identity conflict is not a credential failure.
      failureCategory = 'did-mismatch';
      throw new Error('Validated DID differs from the linked destination account DID.');
    }
    const index = config.blueskyAccounts.findIndex((entry) => entry.id === accountId);
    const updated = applyValidatedAccountIdentity(account, validation);
    config.blueskyAccounts[index] = updated;
    save(config);
    rekeyLinkedDestinationIdentity(config, account.id, account, updated);
    clearCachedAgent({
      bskyAccountId: updated.id,
      bskyIdentifier: updated.canonicalHandle ?? updated.loginIdentifier,
      bskyPassword: updated.appPassword,
      bskyServiceUrl: updated.serviceUrl,
      bskyDid: updated.did,
      bskyCanonicalHandle: updated.canonicalHandle,
    });
    blueskyAccountRuntimeService.recordSuccess(account.id, 'validate');
    return toAccountView(config, updated);
  } catch (error) {
    blueskyAccountRuntimeService.recordFailure(
      accountId,
      failureCategory,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function rotateBlueskyAccountCredentials(
  config: AppConfig,
  input: {
    accountId: string;
    appPassword: string;
    loginIdentifier?: string;
    serviceUrl?: string;
  },
  save: (next: AppConfig) => void,
): Promise<BlueskyAccountView> {
  const account = findBlueskyAccount(config, input.accountId);
  if (!account) throw new Error('Bluesky account not found.');
  const loginIdentifier = input.loginIdentifier?.trim() || account.loginIdentifier;
  const serviceUrl = input.serviceUrl || account.serviceUrl;
  const validation = await validateBlueskyCredentials({
    bskyIdentifier: loginIdentifier,
    bskyPassword: input.appPassword,
    bskyServiceUrl: serviceUrl,
  });
  const linked = findDestinationForAccount(config, account.id);
  if (account.did && validation.did.trim() !== account.did && linked) {
    throw new Error('Rotated credentials resolved to a different DID than the linked destination account.');
  }
  const duplicate = findBlueskyAccountByIdentity(
    config,
    { did: validation.did, serviceUrl: validation.serviceUrl, loginIdentifier: validation.handle },
    account.id,
  );
  if (duplicate) {
    throw new Error(`Credential identity conflicts with account ${duplicate.canonicalHandle ?? duplicate.loginIdentifier}.`);
  }
  const index = config.blueskyAccounts.findIndex((entry) => entry.id === account.id);
  let updated: BlueskyAccount = {
    ...account,
    loginIdentifier: loginIdentifier.toLowerCase(),
    appPassword: input.appPassword,
    serviceUrl,
  };
  updated = applyValidatedAccountIdentity(updated, validation);
  config.blueskyAccounts[index] = updated;
  save(config);
  rekeyLinkedDestinationIdentity(config, account.id, account, updated);
  clearCachedAgent({
    bskyAccountId: updated.id,
    bskyIdentifier: updated.canonicalHandle ?? updated.loginIdentifier,
    bskyPassword: updated.appPassword,
    bskyServiceUrl: updated.serviceUrl,
    bskyDid: updated.did,
    bskyCanonicalHandle: updated.canonicalHandle,
  });
  blueskyAccountRuntimeService.recordSuccess(updated.id, 'validate');
  return toAccountView(config, updated);
}

export function deleteBlueskyAccount(config: AppConfig, accountId: string, save: (next: AppConfig) => void): void {
  const account = findBlueskyAccount(config, accountId);
  if (!account) throw new Error('Bluesky account not found.');
  const linked = findDestinationForAccount(config, accountId);
  if (linked) {
    throw new Error(`Bluesky account is linked to destination ${linked.id}; unlink or delete the destination first.`);
  }
  config.blueskyAccounts = config.blueskyAccounts.filter((entry) => entry.id !== accountId);
  save(config);
  clearCachedAgent({
    bskyAccountId: account.id,
    bskyIdentifier: account.canonicalHandle ?? account.loginIdentifier,
    bskyPassword: account.appPassword,
    bskyServiceUrl: account.serviceUrl,
    bskyDid: account.did,
    bskyCanonicalHandle: account.canonicalHandle,
  });
}
