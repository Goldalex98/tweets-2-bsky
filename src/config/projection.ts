import { createHash } from 'node:crypto';
import { getDestinationStorageKey, normalizeTwitterUsername, parseTwitterUsernames } from '../mapping-helpers.js';
import {
  DEFAULT_AI_OVERRIDES,
  DEFAULT_DUPLICATE_SUPPRESSION,
  DEFAULT_MODERATION_POLICY,
  DEFAULT_ROUTE_DELIVERY,
  DEFAULT_ROUTING_POLICY,
  DEFAULT_SOURCE_FILTERS,
  DEFAULT_SOURCE_SCHEDULE,
} from './defaults.js';
import type { AccountMapping, AppConfig, CanonicalAppConfig, Destination, Route, Source } from './schemas.js';

export function createCanonicalId(prefix: 'source' | 'route', identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}

export function sourceIdForUsername(username: string): string {
  const normalized = normalizeTwitterUsername(username);
  if (!normalized) {
    throw new Error('Cannot create a source id for an empty X username.');
  }
  return createCanonicalId('source', `x:${normalized}`);
}

export function routeIdForPair(sourceId: string, destinationId: string): string {
  return createCanonicalId('route', `${sourceId}\0${destinationId}`);
}

export function projectAccountMappings(
  config: Pick<AppConfig, 'sources' | 'destinations' | 'routes' | 'blueskyAccounts'>,
): AccountMapping[] {
  const sourceById = new Map(config.sources.map((source) => [source.id, source]));
  const accountById = new Map(config.blueskyAccounts.map((account) => [account.id, account]));
  const routesByDestination = new Map<string, Route[]>();
  for (const route of config.routes) {
    const routes = routesByDestination.get(route.destinationId) ?? [];
    routes.push(route);
    routesByDestination.set(route.destinationId, routes);
  }

  return config.destinations.map((destination) => {
    const routeSources = (routesByDestination.get(destination.id) ?? [])
      .map((route) => ({ route, source: sourceById.get(route.sourceId) }))
      .filter((entry): entry is { route: Route; source: Source } => Boolean(entry.source) && entry.source?.type === 'x')
      .sort((a, b) => a.source.username.localeCompare(b.source.username));
    const twitterUsernames = routeSources.map(({ source }) => source.username);
    const isRoutePaused = ({ route }: { route: Route }): boolean =>
      route.relationship.sourcePaused || (destination.enabled && !route.enabled);
    const pausedTwitterUsernames = routeSources
      .filter((entry) => isRoutePaused(entry) || !entry.source.enabled)
      .map(({ source }) => source.username);
    const routePausedUsernames = routeSources.filter(isRoutePaused).map(({ source }) => source.username);
    const routeIdsByUsername = Object.fromEntries(routeSources.map(({ route, source }) => [source.username, route.id]));
    const initialImportModesByUsername = Object.fromEntries(
      routeSources.map(({ route, source }) => [source.username, route.initialImportMode]),
    );
    const metadata = destination.metadata;
    const account = destination.bskyAccountId ? accountById.get(destination.bskyAccountId) : undefined;

    const mapping: AccountMapping = {
      id: destination.id,
      twitterUsernames,
      ...(pausedTwitterUsernames.length > 0 ? { pausedTwitterUsernames } : {}),
      ...(destination.bskyAccountId ? { bskyAccountId: destination.bskyAccountId } : {}),
      bskyIdentifier: account?.loginIdentifier ?? destination.bskyIdentifier,
      bskyPassword: account?.appPassword ?? destination.bskyPassword ?? '',
      bskyServiceUrl: account?.serviceUrl ?? destination.bskyServiceUrl,
      bskyDid: account?.did ?? destination.bskyDid,
      bskyCanonicalHandle: account?.canonicalHandle ?? destination.bskyCanonicalHandle,
      storageKey: destination.storageKey,
      enabled: destination.enabled,
      owner: destination.owner,
      groupName: destination.groupName,
      groupEmoji: destination.groupEmoji,
      createdByUserId: destination.createdByUserId,
      postingPolicy: destination.postingPolicy,
      aiOverrides: destination.aiOverrides,
      moderationPolicy: destination.moderationPolicy,
      duplicateSuppression: destination.duplicateSuppression,
      profileManagement: destination.profileManagement,
      migrationReview: destination.migrationReview,
      profileSyncSourceUsername: destination.profileManagement.profileSync.sourceUsername,
      lastProfileSyncAt: metadata.lastProfileSyncAt,
      lastMirroredDisplayName: metadata.lastMirroredDisplayName,
      lastMirroredDescription: metadata.lastMirroredDescription,
      lastMirroredAvatarUrl: metadata.lastMirroredAvatarUrl,
      lastMirroredBannerUrl: metadata.lastMirroredBannerUrl,
      lastPinnedTweetId: metadata.lastPinnedTweetId,
      lastPinSyncAt: metadata.lastPinSyncAt,
      hasBotLabel: metadata.hasBotLabel,
    };
    Object.defineProperty(mapping, 'routeIdsByUsername', {
      value: routeIdsByUsername,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(mapping, 'routePausedUsernames', {
      value: routePausedUsernames,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(mapping, 'initialImportModesByUsername', {
      value: initialImportModesByUsername,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return mapping;
  });
}

function mappingToDestination(mapping: AccountMapping, existing?: Destination): Destination {
  const bskyAccountId = mapping.bskyAccountId ?? existing?.bskyAccountId;
  return {
    id: existing?.id ?? mapping.id,
    enabled: mapping.enabled,
    ...(bskyAccountId ? { bskyAccountId } : {}),
    bskyIdentifier: mapping.bskyIdentifier.toLowerCase(),
    // Inline password is legacy-only; linked destinations store credentials on the account.
    ...(!bskyAccountId && (mapping.bskyPassword || existing?.bskyPassword)
      ? { bskyPassword: mapping.bskyPassword || existing?.bskyPassword }
      : {}),
    bskyServiceUrl: mapping.bskyServiceUrl ?? 'https://bsky.social',
    bskyDid: mapping.bskyDid,
    bskyCanonicalHandle: mapping.bskyCanonicalHandle,
    storageKey: existing?.storageKey ?? mapping.storageKey ?? getDestinationStorageKey(mapping),
    owner: mapping.owner,
    groupName: mapping.groupName,
    groupEmoji: mapping.groupEmoji,
    createdByUserId: mapping.createdByUserId,
    postingPolicy: mapping.postingPolicy,
    aiOverrides: mapping.aiOverrides ?? DEFAULT_AI_OVERRIDES,
    moderationPolicy: mapping.moderationPolicy ?? DEFAULT_MODERATION_POLICY,
    duplicateSuppression: mapping.duplicateSuppression ?? DEFAULT_DUPLICATE_SUPPRESSION,
    profileManagement: mapping.profileManagement,
    migrationReview: mapping.migrationReview,
    metadata: {
      legacyMappingIds: existing?.metadata.legacyMappingIds ?? [mapping.id],
      lastProfileSyncAt: mapping.lastProfileSyncAt,
      lastMirroredDisplayName: mapping.lastMirroredDisplayName,
      lastMirroredDescription: mapping.lastMirroredDescription,
      lastMirroredAvatarUrl: mapping.lastMirroredAvatarUrl,
      lastMirroredBannerUrl: mapping.lastMirroredBannerUrl,
      lastPinnedTweetId: mapping.lastPinnedTweetId,
      lastPinSyncAt: mapping.lastPinSyncAt,
      hasBotLabel: mapping.hasBotLabel,
    },
  };
}

/**
 * Compatibility mutation adapter. Existing mapping mutations are translated
 * into canonical entity writes before persistence; mappings are never the
 * persisted source of truth.
 */
export function applyMappingProjection(config: AppConfig, mappings: readonly AccountMapping[]): AppConfig {
  const existingSourceByUsername = new Map(
    config.sources.filter((source) => source.type === 'x').map((source) => [source.username, source]),
  );
  const existingDestinationById = new Map(config.destinations.map((destination) => [destination.id, destination]));
  const existingRouteByPair = new Map(
    config.routes.map((route) => [`${route.sourceId}\0${route.destinationId}`, route]),
  );
  const nonXSourceIds = new Set(config.sources.filter((source) => source.type !== 'x').map((source) => source.id));
  const sources = new Map<string, Source>(
    config.sources.filter((source) => source.type !== 'x').map((source) => [source.id, source]),
  );
  const destinations: Destination[] = [];
  const routes: Route[] = config.routes.filter((route) => nonXSourceIds.has(route.sourceId));

  for (const mapping of mappings) {
    const existingDestination = existingDestinationById.get(mapping.id);
    const destination = mappingToDestination(mapping, existingDestination);
    destinations.push(destination);
    const usernames = parseTwitterUsernames(mapping.twitterUsernames);
    const paused = new Set(parseTwitterUsernames(mapping.pausedTwitterUsernames));
    const projectedRoutePaused = Array.isArray(mapping.routePausedUsernames)
      ? new Set(parseTwitterUsernames(mapping.routePausedUsernames))
      : undefined;
    const profileSource = normalizeTwitterUsername(mapping.profileManagement.profileSync.sourceUsername);
    const pinSource = normalizeTwitterUsername(mapping.profileManagement.pinSync.sourceUsername);

    for (const username of usernames) {
      const source =
        existingSourceByUsername.get(username) ??
        ({
          id: sourceIdForUsername(username),
          type: 'x',
          username,
          enabled: true,
          filters: {
            ...DEFAULT_SOURCE_FILTERS,
            includeKeywords: [],
            excludeKeywords: [],
            languages: [],
          },
          schedule: { ...DEFAULT_SOURCE_SCHEDULE },
          state: { consecutiveFailures: 0 },
        } satisfies Source);
      sources.set(source.id, source);
      const pairKey = `${source.id}\0${destination.id}`;
      const existingRoute = existingRouteByPair.get(pairKey);
      // A globally disabled source shows up as paused in the compatibility
      // view. Persisting that as a route pause would survive re-enabling the
      // source, so the projected route-scoped set wins when it disagrees.
      const routePaused =
        paused.has(username) &&
        (projectedRoutePaused === undefined || projectedRoutePaused.has(username) || source.enabled);
      routes.push({
        id: mapping.routeIdsByUsername?.[username] ?? existingRoute?.id ?? routeIdForPair(source.id, destination.id),
        sourceId: source.id,
        destinationId: destination.id,
        enabled: mapping.enabled && !routePaused,
        initialImportMode:
          existingRoute?.initialImportMode ?? mapping.initialImportModesByUsername?.[username] ?? 'inherit',
        filters: existingRoute?.filters ?? {
          ...source.filters,
          includeKeywords: [...source.filters.includeKeywords],
          excludeKeywords: [...source.filters.excludeKeywords],
          languages: [...source.filters.languages],
        },
        routingPolicy: existingRoute?.routingPolicy ?? {
          ...DEFAULT_ROUTING_POLICY,
          includeKeywords: [],
          excludeKeywords: [],
          includeDomains: [],
          excludeDomains: [],
          contentTypes: [],
          mediaTypes: [],
          languages: [],
          allowedHours: [],
        },
        moderationPolicy: existingRoute?.moderationPolicy ?? {
          ...DEFAULT_MODERATION_POLICY,
          blockKeywords: [],
          blockDomains: [],
          blockSourceUsernames: [],
        },
        duplicateSuppression: existingRoute?.duplicateSuppression ?? { ...DEFAULT_DUPLICATE_SUPPRESSION },
        delivery: existingRoute?.delivery ?? {
          ...DEFAULT_ROUTE_DELIVERY,
          digest: { ...DEFAULT_ROUTE_DELIVERY.digest },
        },
        relationship: {
          sourcePaused: routePaused,
          profileSyncSource: profileSource === username,
          pinSyncSource: pinSource === username,
        },
        metadata: {
          legacyMappingIds: existingRoute?.metadata.legacyMappingIds ?? [mapping.id],
        },
      });
    }
  }

  const canonical: CanonicalAppConfig = {
    ...config,
    sources: [...sources.values()].sort((a, b) => a.username.localeCompare(b.username)),
    destinations,
    routes,
  };
  return withCompatibilityMappings(canonical);
}

export function withCompatibilityMappings(config: CanonicalAppConfig): AppConfig {
  const canonical = config as AppConfig;
  Object.defineProperty(canonical, 'mappings', {
    value: projectAccountMappings(canonical),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return canonical;
}

export function toCanonicalConfig(config: AppConfig): CanonicalAppConfig {
  const { mappings: _compatibilityMappings, ...canonical } = config;
  return canonical;
}

export function findDestinationByLegacyId(
  config: Pick<AppConfig, 'destinations'>,
  id: string,
): Destination | undefined {
  return config.destinations.find(
    (destination) => destination.id === id || destination.metadata.legacyMappingIds.includes(id),
  );
}

export function findRouteForMappingSource(
  config: Pick<AppConfig, 'sources' | 'routes'>,
  destinationId: string,
  username: string,
): Route | undefined {
  const normalized = normalizeTwitterUsername(username);
  const source = config.sources.find((candidate) => candidate.username === normalized);
  return source
    ? config.routes.find((route) => route.destinationId === destinationId && route.sourceId === source.id)
    : undefined;
}
