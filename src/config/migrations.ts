import {
  normalizeTwitterUsername,
  parseTwitterUsernames,
  resolveProfileSyncSourceUsername,
} from '../mapping-helpers.js';
import { blueskyAccountIdentity, createBlueskyAccount } from './bluesky-accounts.js';
import { DEFAULT_ATTRIBUTION_TEMPLATE, DEFAULT_SCHEDULER_CONFIG } from './defaults.js';
import {
  assertValidAppConfig,
  isConfigRecord,
  normalizeConfigV2,
  normalizeConfigV3,
  normalizeLegacyConfigV2,
} from './normalize.js';
import { projectAccountMappings, routeIdForPair, sourceIdForUsername, toCanonicalConfig } from './projection.js';
import {
  type AppConfig,
  type BlueskyAccount,
  CURRENT_CONFIG_SCHEMA_VERSION,
  type Destination,
  type KnownDisplayNameSuffix,
  type MappingMigrationReview,
  type Route,
  type Source,
} from './schemas.js';

export interface ConfigMigrationResult {
  config: AppConfig;
  fromVersion: number;
  toVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  migrated: boolean;
  report: ConfigMigrationReport;
}

export interface ConfigMigrationConflict {
  kind: 'destination' | 'route';
  identity: string;
  legacyMappingIds: string[];
  conflictingFields: string[];
}

export interface ConfigMigrationReport {
  fromVersion: number;
  toVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  dryRun: boolean;
  wouldMigrate: boolean;
  sourceCount: number;
  destinationCount: number;
  routeCount: number;
  deduplicatedSources: number;
  deduplicatedDestinations: number;
  deduplicatedRoutes: number;
  conflicts: ConfigMigrationConflict[];
  backupSuffix: '.pre-v3-backup' | '.pre-v4-backup' | '.pre-v5-backup' | '.pre-v6-backup' | '.pre-v7-backup';
  rollback: string[];
}

export class ConfigMigrationConflictError extends Error {
  constructor(public readonly report: ConfigMigrationReport) {
    super(
      `Config migration found ${report.conflicts.length} conflicting legacy destination or route definition(s).`,
    );
    this.name = 'ConfigMigrationConflictError';
  }
}

export function normalizeSchemaVersion(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('Config schemaVersion must be a non-negative whole number.');
  }
  return version;
}

export function migrateV0ToV1(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const mappings = Array.isArray(rawConfig.mappings)
    ? rawConfig.mappings.map((mapping) => {
        if (!isConfigRecord(mapping)) {
          return mapping;
        }
        if (mapping.twitterUsernames !== undefined) {
          return { ...mapping };
        }
        return {
          ...mapping,
          twitterUsernames:
            mapping.twitterUsername === undefined ? [] : parseTwitterUsernames(undefined, mapping.twitterUsername),
        };
      })
    : [];

  return {
    ...rawConfig,
    schemaVersion: 1,
    mappings,
  };
}

function detectKnownDisplayNameSuffix(mapping: Record<string, unknown>): KnownDisplayNameSuffix | undefined {
  if (mapping.hasDisplayNameBotSuffix === true) {
    return 'bot';
  }

  const displayName = typeof mapping.lastMirroredDisplayName === 'string' ? mapping.lastMirroredDisplayName.trim() : '';
  if (/\{bot\}$/i.test(displayName)) {
    return 'bot';
  }
  if (/\{unofficial\}$/i.test(displayName)) {
    return 'unofficial';
  }
  return undefined;
}

function createMigrationReview(
  mapping: Record<string, unknown>,
  fromVersion: number,
  sourceCount: number,
  priorProfileSyncSourceUsername?: string,
): MappingMigrationReview {
  const knownBotLabelApplied = mapping.hasBotLabel === true ? true : undefined;
  const knownDisplayNameSuffix = detectKnownDisplayNameSuffix(mapping);
  const notices = [
    'This destination was migrated from legacy configuration and requires administrator review.',
    sourceCount === 1
      ? 'Legacy scheduled profile and pin synchronization were preserved for this one-source destination.'
      : 'Automatic profile and pin synchronization were disabled because this destination has multiple sources.',
    'Bot-label and display-name suffix state was retained as metadata but will not be applied automatically.',
  ];

  return {
    needsAdminReview: true,
    migratedFromSchemaVersion: fromVersion,
    notices,
    ...(priorProfileSyncSourceUsername ? { priorProfileSyncSourceUsername } : {}),
    ...(knownBotLabelApplied !== undefined ? { knownBotLabelApplied } : {}),
    ...(knownDisplayNameSuffix ? { knownDisplayNameSuffix } : {}),
  };
}

export function migrateV1ToV2(
  rawConfig: Record<string, unknown>,
  migratedFromSchemaVersion = 1,
): Record<string, unknown> {
  const mappings = Array.isArray(rawConfig.mappings)
    ? rawConfig.mappings.map((mapping) => {
        if (!isConfigRecord(mapping)) {
          return mapping;
        }

        const twitterUsernames = parseTwitterUsernames(mapping.twitterUsernames, mapping.twitterUsername);
        const priorProfileSyncSourceUsername = normalizeTwitterUsername(mapping.profileSyncSourceUsername);
        const compatibilitySource = resolveProfileSyncSourceUsername({
          twitterUsernames,
          requestedSource: mapping.profileSyncSourceUsername,
        });
        const preserveLegacyScheduling = twitterUsernames.length === 1;

        return {
          ...mapping,
          twitterUsernames,
          profileSyncSourceUsername: compatibilitySource,
          postingPolicy: {
            attribution: {
              // The Phase 0 runtime attributed every root post. Keeping
              // "always" here avoids changing migrated posting behavior.
              mode: 'always',
              template: DEFAULT_ATTRIBUTION_TEMPLATE,
              rootPostsOnly: true,
              linkSource: true,
            },
            appendOriginalPostLink: false,
          },
          profileManagement: {
            allowProfileMutation: preserveLegacyScheduling,
            ensureBotLabel: false,
            ensureDisplayNameBotSuffix: false,
            profileSync: {
              mode: preserveLegacyScheduling ? 'scheduled' : 'off',
              ...(preserveLegacyScheduling && compatibilitySource ? { sourceUsername: compatibilitySource } : {}),
              intervalHours: 24,
              fields: {
                displayName: preserveLegacyScheduling,
                // The legacy scheduled path intentionally passed
                // syncDescription: false; preserve that behavior on upgrade.
                description: false,
                avatar: preserveLegacyScheduling,
                banner: preserveLegacyScheduling,
              },
            },
            pinSync: {
              mode: preserveLegacyScheduling ? 'scheduled' : 'off',
              ...(preserveLegacyScheduling && compatibilitySource ? { sourceUsername: compatibilitySource } : {}),
              intervalHours: 24,
            },
          },
          migrationReview: createMigrationReview(
            mapping,
            migratedFromSchemaVersion,
            twitterUsernames.length,
            priorProfileSyncSourceUsername ?? compatibilitySource,
          ),
        };
      })
    : [];
  const rawScheduler = isConfigRecord(rawConfig.scheduler) ? rawConfig.scheduler : {};
  const scheduler = {
    enabled: typeof rawScheduler.enabled === 'boolean' ? rawScheduler.enabled : DEFAULT_SCHEDULER_CONFIG.enabled,
    intervalMinutes: rawScheduler.intervalMinutes ?? rawConfig.checkIntervalMinutes,
    runOnStartup:
      typeof rawScheduler.runOnStartup === 'boolean'
        ? rawScheduler.runOnStartup
        : DEFAULT_SCHEDULER_CONFIG.runOnStartup,
  };

  const { checkIntervalMinutes: _legacyCheckIntervalMinutes, ...withoutLegacyInterval } = rawConfig;
  return {
    ...withoutLegacyInterval,
    schemaVersion: 2,
    scheduler,
    mappings,
  };
}

// Every upgrade to the current schema writes the newest suffix, so reports name
// it rather than an older one an operator may not have on disk.
const ROLLBACK_BACKUP_SUFFIX = '.pre-v7-backup' as const;

const ROLLBACK_INSTRUCTIONS = [
  'Stop the application.',
  `Copy the matching config.json${ROLLBACK_BACKUP_SUFFIX} (or an older version backup) over config.json.`,
  'Start the previous release and verify destinations and queue state.',
];

function destinationIdentity(destination: Destination): string {
  return destination.bskyDid
    ? `did:${destination.bskyDid.toLowerCase()}`
    : `account:${destination.bskyServiceUrl.toLowerCase()}|${destination.bskyIdentifier.toLowerCase()}`;
}

function destinationConflictFields(left: Destination, right: Destination): string[] {
  const comparable: Array<[string, unknown, unknown]> = [
    ['bskyIdentifier', left.bskyIdentifier, right.bskyIdentifier],
    ['bskyPassword', left.bskyPassword, right.bskyPassword],
    ['bskyServiceUrl', left.bskyServiceUrl, right.bskyServiceUrl],
    ['bskyDid', left.bskyDid, right.bskyDid],
    ['bskyCanonicalHandle', left.bskyCanonicalHandle, right.bskyCanonicalHandle],
    ['storageKey', left.storageKey, right.storageKey],
    ['owner', left.owner, right.owner],
    ['createdByUserId', left.createdByUserId, right.createdByUserId],
    ['groupName', left.groupName, right.groupName],
    ['groupEmoji', left.groupEmoji, right.groupEmoji],
    ['enabled', left.enabled, right.enabled],
    ['postingPolicy', left.postingPolicy, right.postingPolicy],
    ['aiOverrides', left.aiOverrides, right.aiOverrides],
    ['moderationPolicy', left.moderationPolicy, right.moderationPolicy],
    ['duplicateSuppression', left.duplicateSuppression, right.duplicateSuppression],
    ['profileManagement', left.profileManagement, right.profileManagement],
    ['migrationReview', left.migrationReview, right.migrationReview],
    ['metadata', { ...left.metadata, legacyMappingIds: [] }, { ...right.metadata, legacyMappingIds: [] }],
  ];
  return comparable.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b)).map(([field]) => field);
}

function routeConflictFields(left: Route, right: Route): string[] {
  const fields: string[] = [];
  if (left.enabled !== right.enabled) fields.push('enabled');
  if (JSON.stringify(left.filters) !== JSON.stringify(right.filters)) fields.push('filters');
  if (JSON.stringify(left.routingPolicy) !== JSON.stringify(right.routingPolicy)) fields.push('routingPolicy');
  if (JSON.stringify(left.moderationPolicy) !== JSON.stringify(right.moderationPolicy)) fields.push('moderationPolicy');
  if (JSON.stringify(left.duplicateSuppression) !== JSON.stringify(right.duplicateSuppression)) {
    fields.push('duplicateSuppression');
  }
  if (JSON.stringify(left.relationship) !== JSON.stringify(right.relationship)) {
    fields.push('relationship');
  }
  return fields;
}

export interface V2ToV3MigrationResult {
  config?: AppConfig;
  report: ConfigMigrationReport;
}

export function migrateV2ToV3(
  rawConfig: Record<string, unknown>,
  options: {
    dryRun?: boolean;
    migratedFromVersion?: number;
    now?: Date;
  } = {},
): V2ToV3MigrationResult {
  const legacy = normalizeLegacyConfigV2(rawConfig);
  if (Array.isArray(rawConfig.mappings) && legacy.mappings.length !== rawConfig.mappings.length) {
    throw new Error('Configuration migration would discard one or more invalid mappings.');
  }
  const initial = normalizeConfigV2(legacy);
  const rawSourceReferences = legacy.mappings.reduce((total, mapping) => total + mapping.twitterUsernames.length, 0);
  const conflicts: ConfigMigrationConflict[] = [];
  const destinationByIdentity = new Map<string, { destination: Destination; legacyMappingIds: string[] }>();
  const destinationIdRemap = new Map<string, string>();
  let deduplicatedDestinations = 0;

  for (const candidate of initial.destinations) {
    const identity = destinationIdentity(candidate);
    const existing = destinationByIdentity.get(identity);
    if (!existing) {
      destinationByIdentity.set(identity, {
        destination: {
          ...candidate,
          metadata: {
            ...candidate.metadata,
            legacyMappingIds: [...candidate.metadata.legacyMappingIds],
          },
        },
        legacyMappingIds: [...candidate.metadata.legacyMappingIds],
      });
      destinationIdRemap.set(candidate.id, candidate.id);
      continue;
    }

    const conflictingFields = destinationConflictFields(existing.destination, candidate);
    const legacyMappingIds = [...new Set([...existing.legacyMappingIds, ...candidate.metadata.legacyMappingIds])];
    if (conflictingFields.length > 0) {
      conflicts.push({
        kind: 'destination',
        identity,
        legacyMappingIds,
        conflictingFields,
      });
      continue;
    }
    existing.legacyMappingIds = legacyMappingIds;
    existing.destination.metadata.legacyMappingIds = legacyMappingIds;
    destinationIdRemap.set(candidate.id, existing.destination.id);
    deduplicatedDestinations += 1;
  }

  const destinationIds = new Set([...destinationByIdentity.values()].map(({ destination }) => destination.id));
  const routeByPair = new Map<string, Route>();
  let deduplicatedRoutes = 0;
  for (const candidate of initial.routes) {
    const destinationId = destinationIdRemap.get(candidate.destinationId) ?? candidate.destinationId;
    if (!destinationIds.has(destinationId)) {
      continue;
    }
    const pair = `${candidate.sourceId}\0${destinationId}`;
    const migratedRoute: Route = {
      ...candidate,
      id: routeIdForPair(candidate.sourceId, destinationId),
      destinationId,
      metadata: {
        legacyMappingIds: [...candidate.metadata.legacyMappingIds],
      },
    };
    const existing = routeByPair.get(pair);
    if (!existing) {
      routeByPair.set(pair, migratedRoute);
      continue;
    }
    const conflictingFields = routeConflictFields(existing, migratedRoute);
    const legacyMappingIds = [
      ...new Set([...existing.metadata.legacyMappingIds, ...migratedRoute.metadata.legacyMappingIds]),
    ];
    if (conflictingFields.length > 0) {
      conflicts.push({
        kind: 'route',
        identity: pair,
        legacyMappingIds,
        conflictingFields,
      });
      continue;
    }
    existing.metadata.legacyMappingIds = legacyMappingIds;
    deduplicatedRoutes += 1;
  }

  const destinations = [...destinationByIdentity.values()].map(({ destination }) => destination);
  const routes = [...routeByPair.values()];
  const report: ConfigMigrationReport = {
    fromVersion: options.migratedFromVersion ?? 2,
    toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    dryRun: options.dryRun ?? false,
    wouldMigrate: true,
    sourceCount: initial.sources.length,
    destinationCount: destinations.length,
    routeCount: routes.length,
    deduplicatedSources: rawSourceReferences - initial.sources.length,
    deduplicatedDestinations,
    deduplicatedRoutes,
    conflicts,
    backupSuffix: ROLLBACK_BACKUP_SUFFIX,
    rollback: [...ROLLBACK_INSTRUCTIONS],
  };
  if (conflicts.length > 0) {
    return { report };
  }

  const canonical = {
    ...toCanonicalConfig(initial),
    sources: initial.sources.map(
      (source): Source => ({
        ...source,
        id: source.id || sourceIdForUsername(source.username),
      }),
    ),
    destinations,
    routes,
    migration: {
      migratedFromVersion: options.migratedFromVersion ?? 2,
      migratedAt: (options.now ?? new Date()).toISOString(),
      rollback: {
        backupSuffix: ROLLBACK_BACKUP_SUFFIX,
        instructions: [...ROLLBACK_INSTRUCTIONS],
      },
    },
  };
  const config = normalizeConfigV3(canonical);
  config.mappings = projectAccountMappings(config);
  assertValidAppConfig(config);
  return { config, report };
}

/**
 * Explicit v3 -> v4 migration. Normalization supplies safe defaults for all
 * new policies. A legacy AI key opts image alt text in to preserve behavior;
 * text capabilities and duplicate suppression always remain off.
 */
export function migrateV3ToV4(rawConfig: Record<string, unknown>): AppConfig {
  return normalizeConfigV3({ ...rawConfig, schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION });
}

/** Explicit, idempotent v4 -> v5 migration adding moderation dry-run defaults. */
export function migrateV4ToV5(rawConfig: Record<string, unknown>): AppConfig {
  return normalizeConfigV3({ ...rawConfig, schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION });
}

/** Explicit, idempotent v5 -> v6 migration for provider-neutral sources and digest delivery. */
export function migrateV5ToV6(rawConfig: Record<string, unknown>): AppConfig {
  return normalizeConfigV3({ ...rawConfig, schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION });
}

/**
 * Explicit, idempotent v6 -> v7 migration: extract inline destination Bluesky
 * credentials into shared `blueskyAccounts` entries and link via `bskyAccountId`.
 */
export function migrateV6ToV7(rawConfig: Record<string, unknown>): AppConfig {
  const config = normalizeConfigV3({ ...rawConfig, schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION });
  const accountsByIdentity = new Map<string, BlueskyAccount>();
  for (const account of config.blueskyAccounts) {
    accountsByIdentity.set(blueskyAccountIdentity(account), account);
  }
  for (const destination of config.destinations) {
    if (destination.bskyAccountId) continue;
    if (!destination.bskyPassword) continue;
    const identity = blueskyAccountIdentity({
      did: destination.bskyDid,
      serviceUrl: destination.bskyServiceUrl,
      loginIdentifier: destination.bskyIdentifier,
    });
    let account = accountsByIdentity.get(identity);
    if (!account) {
      account = createBlueskyAccount({
        loginIdentifier: destination.bskyIdentifier,
        appPassword: destination.bskyPassword,
        serviceUrl: destination.bskyServiceUrl,
        did: destination.bskyDid,
        canonicalHandle: destination.bskyCanonicalHandle,
        legacyDestinationIds: [destination.id],
      });
      config.blueskyAccounts.push(account);
      accountsByIdentity.set(identity, account);
    } else if (!account.metadata?.legacyDestinationIds?.includes(destination.id)) {
      account.metadata = {
        ...account.metadata,
        legacyDestinationIds: [...(account.metadata?.legacyDestinationIds ?? []), destination.id],
      };
    }
    destination.bskyAccountId = account.id;
    (destination as { bskyPassword?: string }).bskyPassword = undefined;
  }
  // Re-normalize so destination property order matches a fresh load (idempotency).
  const normalized = normalizeConfigV3(toCanonicalConfig(config));
  normalized.mappings = projectAccountMappings(normalized);
  assertValidAppConfig(normalized);
  return normalized;
}

function applyMigrationsFromV3(working: Record<string, unknown>, fromVersion: number): AppConfig {
  let current = working;
  let config: AppConfig;
  if (fromVersion <= 3) {
    config = migrateV3ToV4(current);
    current = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  if (fromVersion <= 4) {
    config = migrateV4ToV5(current);
    current = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  if (fromVersion <= 5) {
    config = migrateV5ToV6(current);
    current = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  return migrateV6ToV7(current);
}

export function planConfigMigration(rawConfig: unknown): ConfigMigrationReport {
  if (!isConfigRecord(rawConfig)) {
    throw new Error('Configuration root must be a JSON object.');
  }
  const fromVersion = normalizeSchemaVersion(rawConfig.schemaVersion);
  if (fromVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Config schema version ${fromVersion} is newer than supported version ${CURRENT_CONFIG_SCHEMA_VERSION}.`,
    );
  }
  if (fromVersion === CURRENT_CONFIG_SCHEMA_VERSION) {
    const config = normalizeConfigV3(rawConfig);
    if (
      !Array.isArray(rawConfig.sources) ||
      !Array.isArray(rawConfig.destinations) ||
      !Array.isArray(rawConfig.routes) ||
      config.sources.length !== rawConfig.sources.length ||
      config.destinations.length !== rawConfig.destinations.length ||
      config.routes.length !== rawConfig.routes.length
    ) {
      throw new Error('Configuration normalization would discard one or more canonical entities.');
    }
    assertValidAppConfig(config);
    return {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: true,
      wouldMigrate: false,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
  }

  let version = fromVersion;
  let working = { ...rawConfig };
  if (version < 1) {
    working = migrateV0ToV1(working);
    version = 1;
  }
  if (version < 2) {
    working = migrateV1ToV2(working, fromVersion);
  }
  if (version >= 3) {
    const config = applyMigrationsFromV3(working, version);
    assertValidAppConfig(config);
    return {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: true,
      wouldMigrate: true,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
  }
  return migrateV2ToV3(working, {
    dryRun: true,
    migratedFromVersion: fromVersion,
    now: new Date(0),
  }).report;
}

export function migrateConfigWithMetadata(rawConfig: unknown): ConfigMigrationResult {
  if (!isConfigRecord(rawConfig)) {
    throw new Error('Configuration root must be a JSON object.');
  }

  const fromVersion = normalizeSchemaVersion(rawConfig.schemaVersion);
  if (fromVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Config schema version ${fromVersion} is newer than supported version ${CURRENT_CONFIG_SCHEMA_VERSION}.`,
    );
  }

  let version = fromVersion;
  let working = { ...rawConfig };
  if (version < 1) {
    working = migrateV0ToV1(working);
    version = 1;
  }
  if (version < 2) {
    working = migrateV1ToV2(working, fromVersion);
    version = 2;
  }

  let config: AppConfig;
  let report: ConfigMigrationReport | undefined;
  if (version < 3) {
    const migration = migrateV2ToV3(working, {
      migratedFromVersion: fromVersion,
    });
    if (!migration.config) {
      throw new ConfigMigrationConflictError(migration.report);
    }
    config = migration.config;
    report = migration.report;
    version = 3;
    working = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  if (version < 4) {
    config = migrateV3ToV4(working);
    report ??= {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: false,
      wouldMigrate: true,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
    version = 4;
    working = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  if (version < 5) {
    config = migrateV4ToV5(working);
    report ??= {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: false,
      wouldMigrate: true,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
    version = 5;
    working = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  if (version < 6) {
    config = migrateV5ToV6(working);
    report ??= {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: false,
      wouldMigrate: true,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
    version = 6;
    working = toCanonicalConfig(config) as unknown as Record<string, unknown>;
  }
  if (version < 7) {
    config = migrateV6ToV7(working);
    report ??= {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: false,
      wouldMigrate: true,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
    version = 7;
  } else {
    config = normalizeConfigV3(working);
    report = {
      fromVersion,
      toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      dryRun: false,
      wouldMigrate: false,
      sourceCount: config.sources.length,
      destinationCount: config.destinations.length,
      routeCount: config.routes.length,
      deduplicatedSources: 0,
      deduplicatedDestinations: 0,
      deduplicatedRoutes: 0,
      conflicts: [],
      backupSuffix: ROLLBACK_BACKUP_SUFFIX,
      rollback: [...ROLLBACK_INSTRUCTIONS],
    };
  }
  if (Array.isArray(working.users) && config.users.length !== working.users.length) {
    throw new Error('Configuration migration would discard one or more invalid users.');
  }
  if (
    (Array.isArray(working.sources) && config.sources.length !== working.sources.length) ||
    (Array.isArray(working.destinations) && config.destinations.length !== working.destinations.length) ||
    (Array.isArray(working.routes) && config.routes.length !== working.routes.length)
  ) {
    throw new Error('Configuration normalization would discard one or more canonical entities.');
  }
  assertValidAppConfig(config);
  if (!report) throw new Error('Configuration migration report was not created.');
  return {
    config,
    fromVersion,
    toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    migrated: fromVersion < CURRENT_CONFIG_SCHEMA_VERSION,
    report,
  };
}

export function migrateConfig(rawConfig: unknown): AppConfig {
  return migrateConfigWithMetadata(rawConfig).config;
}
