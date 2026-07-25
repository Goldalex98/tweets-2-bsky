import { normalizeTwitterUsername } from '../mapping-helpers.js';
import { migrateConfig } from './migrations.js';
import { assertValidAppConfig, isConfigRecord, normalizeConfigV3 } from './normalize.js';
import { findDestinationByLegacyId, routeIdForPair, toCanonicalConfig } from './projection.js';
import type { AppConfig, Destination, Route, Source } from './schemas.js';

export type ConfigExportMode = 'redacted' | 'full';

const REDACTED_SECRET_MARKERS = new Set(['__REDACTED__', '<redacted>', '[redacted]']);

function isSecretKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    compact.includes('password') ||
    compact.includes('apikey') ||
    compact.includes('privatekey') ||
    compact.includes('signingkey') ||
    compact.includes('encryptionkey') ||
    compact === 'ct0' ||
    compact === 'backupct0' ||
    compact.endsWith('token') ||
    compact.includes('cookie') ||
    compact.includes('authorization') ||
    compact.includes('jwt') ||
    compact.includes('secret') ||
    compact.includes('webhook')
  );
}

export const REMOVE_CONFIG_SECRET = Symbol('remove-config-secret');

export type ConfigSecretTransformer = (path: readonly string[], value: string) => unknown | typeof REMOVE_CONFIG_SECRET;

export function transformConfigSecrets(
  value: unknown,
  transform: ConfigSecretTransformer,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((child, index) => transformConfigSecrets(child, transform, [...path, String(index)]));
  }
  if (!isConfigRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) && typeof child === 'string') {
      const transformed = transform([...path, key], child);
      if (transformed !== REMOVE_CONFIG_SECRET) {
        redacted[key] = transformed;
      }
      continue;
    }
    redacted[key] = transformConfigSecrets(child, transform, [...path, key]);
  }
  return redacted;
}

export function createConfigExport(config: AppConfig, mode: ConfigExportMode = 'redacted'): unknown {
  const cloned = JSON.parse(JSON.stringify(toCanonicalConfig(config))) as Record<string, unknown>;
  const { users: _users, ...withoutUsers } = cloned;
  return mode === 'full' ? withoutUsers : transformConfigSecrets(withoutUsers, () => REMOVE_CONFIG_SECRET);
}

function isProvidedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !REDACTED_SECRET_MARKERS.has(value);
}

function findExistingDestination(currentConfig: AppConfig, importedDestination: Destination): Destination | undefined {
  return (
    findDestinationByLegacyId(currentConfig, importedDestination.id) ??
    currentConfig.destinations.find(
      (destination) =>
        (destination.bskyDid &&
          importedDestination.bskyDid &&
          destination.bskyDid.toLowerCase() === importedDestination.bskyDid.toLowerCase()) ||
        (destination.bskyServiceUrl === importedDestination.bskyServiceUrl &&
          normalizeTwitterUsername(destination.bskyIdentifier) ===
            normalizeTwitterUsername(importedDestination.bskyIdentifier)),
    )
  );
}

function findRawImportedDestination(
  rawDestinations: Record<string, unknown>[],
  importedDestination: Destination,
): Record<string, unknown> | undefined {
  return (
    rawDestinations.find((destination) => destination.id === importedDestination.id) ??
    rawDestinations.find(
      (destination) =>
        typeof destination.bskyIdentifier === 'string' &&
        destination.bskyIdentifier.trim().toLowerCase() === importedDestination.bskyIdentifier,
    )
  );
}

function selectImportedSecret(
  rawValue: unknown,
  importedValue: string | undefined,
  currentValue: string | undefined,
): string | undefined {
  return isProvidedSecret(rawValue) ? importedValue : currentValue;
}

function mergeIdentifiers(...groups: ReadonlyArray<readonly string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

/**
 * Destination ids and storage keys are the join keys for `post_queue` and
 * `processed_tweets`. An import that reuses an existing destination must keep
 * the stored identity, otherwise every queued and historical row is orphaned.
 */
function alignImportedSourceIds(currentConfig: AppConfig, importedSources: readonly Source[]): Map<string, string> {
  const existingIdByIdentity = new Map(
    currentConfig.sources.map((source) => [`${source.type}:${source.username}`, source.id]),
  );
  const remapped = new Map<string, string>();
  for (const source of importedSources) {
    const existingId = existingIdByIdentity.get(`${source.type}:${source.username}`);
    if (existingId && existingId !== source.id) {
      remapped.set(source.id, existingId);
    }
  }
  return remapped;
}

function realignImportedRoutes(
  currentConfig: AppConfig,
  importedRoutes: readonly Route[],
  sourceIdByImportedId: ReadonlyMap<string, string>,
  destinationIdByImportedId: ReadonlyMap<string, string>,
): Route[] {
  const existingRouteByPair = new Map(
    currentConfig.routes.map((route) => [`${route.sourceId}\0${route.destinationId}`, route]),
  );
  return importedRoutes.map((route) => {
    const sourceId = sourceIdByImportedId.get(route.sourceId) ?? route.sourceId;
    const destinationId = destinationIdByImportedId.get(route.destinationId) ?? route.destinationId;
    if (sourceId === route.sourceId && destinationId === route.destinationId) {
      return route;
    }
    const existingRoute = existingRouteByPair.get(`${sourceId}\0${destinationId}`);
    return {
      ...route,
      id: existingRoute?.id ?? routeIdForPair(sourceId, destinationId),
      sourceId,
      destinationId,
      metadata: {
        legacyMappingIds: mergeIdentifiers(
          existingRoute?.metadata.legacyMappingIds,
          route.metadata.legacyMappingIds,
          [route.id],
        ),
      },
    };
  });
}

export function mergeImportedConfig(currentConfig: AppConfig, importData: unknown): AppConfig {
  if (
    !isConfigRecord(importData) ||
    (!Array.isArray(importData.mappings) &&
      (!Array.isArray(importData.sources) ||
        !Array.isArray(importData.destinations) ||
        !Array.isArray(importData.routes)))
  ) {
    throw new Error(
      'Invalid config format: expected canonical sources/destinations/routes or a legacy mappings array.',
    );
  }

  // Redacted exports omit credentials. Seed matching current secrets so migration
  // and validation can run, then re-apply current secrets after the merge.
  const importPrepared = JSON.parse(JSON.stringify(importData)) as Record<string, unknown>;
  if (Array.isArray(importPrepared.destinations)) {
    importPrepared.destinations = importPrepared.destinations.map((entry) => {
      if (!isConfigRecord(entry)) return entry;
      const hasInlinePassword = typeof entry.bskyPassword === 'string' && entry.bskyPassword.length > 0;
      const hasAccountLink = typeof entry.bskyAccountId === 'string' && entry.bskyAccountId.length > 0;
      if (hasInlinePassword || hasAccountLink) return entry;
      const probe = {
        id: typeof entry.id === 'string' ? entry.id : '',
        bskyIdentifier: typeof entry.bskyIdentifier === 'string' ? entry.bskyIdentifier.toLowerCase() : '',
        bskyServiceUrl: typeof entry.bskyServiceUrl === 'string' ? entry.bskyServiceUrl : 'https://bsky.social',
        bskyDid: typeof entry.bskyDid === 'string' ? entry.bskyDid : undefined,
      } as Destination;
      const existing = findExistingDestination(currentConfig, probe);
      if (!existing) return entry;
      return {
        ...entry,
        ...(existing.bskyAccountId ? { bskyAccountId: existing.bskyAccountId } : {}),
        ...(existing.bskyPassword ? { bskyPassword: existing.bskyPassword } : {}),
      };
    });
  }
  if (!Array.isArray(importPrepared.blueskyAccounts) || importPrepared.blueskyAccounts.length === 0) {
    importPrepared.blueskyAccounts = currentConfig.blueskyAccounts;
  }

  const importedConfig = migrateConfig(importPrepared);
  const rawDestinationValues = Array.isArray(importData.destinations)
    ? importData.destinations
    : Array.isArray(importData.mappings)
      ? importData.mappings
      : [];
  const rawDestinations = rawDestinationValues.filter(isConfigRecord);
  const destinationIdByImportedId = new Map<string, string>();
  const claimedDestinationIds = new Set<string>();
  const destinations = importedConfig.destinations.map((destination) => {
    const existing = findExistingDestination(currentConfig, destination);
    const rawDestination = findRawImportedDestination(rawDestinations, destination);
    const bskyPassword = selectImportedSecret(
      rawDestination?.bskyPassword,
      destination.bskyPassword,
      existing?.bskyPassword,
    );
    const bskyAccountId = destination.bskyAccountId ?? existing?.bskyAccountId;
    if (!bskyAccountId && bskyPassword === undefined) {
      throw new Error(
        `Imported destination ${destination.bskyIdentifier} has no Bluesky password and does not match an existing destination.`,
      );
    }
    if (!existing) {
      return {
        ...destination,
        ...(bskyAccountId ? { bskyAccountId } : {}),
        ...(!bskyAccountId && bskyPassword ? { bskyPassword } : {}),
      };
    }
    if (claimedDestinationIds.has(existing.id)) {
      throw new Error(
        `Imported configuration maps two destinations onto the existing destination ${existing.bskyIdentifier}.`,
      );
    }
    claimedDestinationIds.add(existing.id);
    if (existing.id !== destination.id) {
      destinationIdByImportedId.set(destination.id, existing.id);
    }
    return {
      ...destination,
      id: existing.id,
      storageKey: existing.storageKey,
      ...(bskyAccountId ? { bskyAccountId } : {}),
      ...(!bskyAccountId && bskyPassword ? { bskyPassword } : {}),
      metadata: {
        ...destination.metadata,
        legacyMappingIds: mergeIdentifiers(
          existing.metadata.legacyMappingIds,
          destination.metadata.legacyMappingIds,
          [destination.id],
        ),
      },
    };
  });

  const currentAccountById = new Map(currentConfig.blueskyAccounts.map((account) => [account.id, account]));
  const blueskyAccounts = importedConfig.blueskyAccounts.map((account) => {
    const currentAccount = currentAccountById.get(account.id);
    if (!account.appPassword && currentAccount?.appPassword) {
      return { ...account, appPassword: currentAccount.appPassword };
    }
    return account;
  });
  // Keep any current accounts that destinations still reference but the import omitted.
  for (const destination of destinations) {
    if (!destination.bskyAccountId) continue;
    if (blueskyAccounts.some((account) => account.id === destination.bskyAccountId)) continue;
    const currentAccount = currentAccountById.get(destination.bskyAccountId);
    if (currentAccount) blueskyAccounts.push(currentAccount);
  }

  const sourceIdByImportedId = alignImportedSourceIds(currentConfig, importedConfig.sources);
  const sources = importedConfig.sources.map((source) => {
    const alignedId = sourceIdByImportedId.get(source.id);
    return alignedId ? { ...source, id: alignedId } : source;
  });
  const routes = realignImportedRoutes(
    currentConfig,
    importedConfig.routes,
    sourceIdByImportedId,
    destinationIdByImportedId,
  );

  const rawTwitter = isConfigRecord(importData.twitter) ? importData.twitter : {};
  const twitter = {
    authToken:
      selectImportedSecret(rawTwitter.authToken, importedConfig.twitter.authToken, currentConfig.twitter.authToken) ??
      '',
    ct0: selectImportedSecret(rawTwitter.ct0, importedConfig.twitter.ct0, currentConfig.twitter.ct0) ?? '',
    backupAuthToken: selectImportedSecret(
      rawTwitter.backupAuthToken,
      importedConfig.twitter.backupAuthToken,
      currentConfig.twitter.backupAuthToken,
    ),
    backupCt0: selectImportedSecret(
      rawTwitter.backupCt0,
      importedConfig.twitter.backupCt0,
      currentConfig.twitter.backupCt0,
    ),
  };

  const rawAi = isConfigRecord(importData.ai) ? importData.ai : undefined;
  const ai = rawAi
    ? {
        ...(importedConfig.ai ?? { provider: 'gemini' as const }),
        apiKey: selectImportedSecret(rawAi.apiKey, importedConfig.ai?.apiKey, currentConfig.ai?.apiKey),
      }
    : currentConfig.ai;
  const geminiApiKey = selectImportedSecret(
    importData.geminiApiKey,
    importedConfig.geminiApiKey,
    currentConfig.geminiApiKey,
  );
  const hasImportedScheduler = isConfigRecord(importData.scheduler) || importData.checkIntervalMinutes !== undefined;
  const rawNotifications = isConfigRecord(importData.notifications) ? importData.notifications : undefined;
  const notifications = rawNotifications
    ? {
        ...importedConfig.notifications,
        webhookUrl: selectImportedSecret(
          rawNotifications.webhookUrl,
          importedConfig.notifications.webhookUrl,
          currentConfig.notifications.webhookUrl,
        ),
        webhookSecret: selectImportedSecret(
          rawNotifications.webhookSecret,
          importedConfig.notifications.webhookSecret,
          currentConfig.notifications.webhookSecret,
        ),
      }
    : currentConfig.notifications;

  const merged = normalizeConfigV3({
    ...toCanonicalConfig(importedConfig),
    // Concurrency metadata belongs to this installation, never to the imported
    // document, so an import can neither rewind nor skip revisions.
    revision: currentConfig.revision,
    updatedAt: currentConfig.updatedAt,
    sources,
    destinations,
    routes,
    blueskyAccounts,
    groups: Array.isArray(importData.groups) ? importedConfig.groups : currentConfig.groups,
    users: currentConfig.users,
    twitter,
    scheduler: hasImportedScheduler ? importedConfig.scheduler : currentConfig.scheduler,
    notifications,
    ai,
    geminiApiKey,
  });
  assertValidAppConfig(merged);
  return merged;
}
