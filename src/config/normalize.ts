import { randomUUID } from 'node:crypto';
import {
  X_USERNAME_PATTERN,
  normalizeBlueskyServiceUrl,
  normalizeTwitterUsername,
  parseTwitterUsernames,
  resolveProfileSyncSourceUsername,
} from '../mapping-helpers.js';
import { validateAttributionTemplate } from '../post-transform.js';
import { normalizeCheckIntervalMinutes } from '../scheduler-timing.js';
import {
  ADMIN_USER_PERMISSIONS,
  DEFAULT_AI_CONFIG,
  DEFAULT_ATTRIBUTION_TEMPLATE,
  DEFAULT_DUPLICATE_SUPPRESSION,
  DEFAULT_MODERATION_POLICY,
  DEFAULT_NOTIFICATION_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
  DEFAULT_SOURCE_FILTERS,
  DEFAULT_ROUTING_POLICY,
  DEFAULT_ROUTE_DELIVERY,
  DEFAULT_SOURCE_SCHEDULE,
  DEFAULT_USER_PERMISSIONS,
  defaultPostingPolicy,
  defaultProfileManagementPolicy,
  getDefaultConfig,
} from './defaults.js';
import {
  applyMappingProjection,
  projectAccountMappings,
  sourceIdForUsername,
  toCanonicalConfig,
  withCompatibilityMappings,
} from './projection.js';
import {
  type AIConfig,
  type AIOverrideMode,
  type AITextCapability,
  type AccountGroup,
  type AccountMapping,
  type AppConfig,
  type AttributionMode,
  CURRENT_CONFIG_SCHEMA_VERSION,
  type ConfigMigrationMetadata,
  type Destination,
  type DestinationMetadata,
  type DestinationAIOverrides,
  type DuplicateSuppressionPolicy,
  type MappingMigrationReview,
  type ModerationPolicy,
  type NotificationConfig,
  type NotificationEvent,
  type PostingPolicy,
  type ProfileManagementPolicy,
  type Route,
  type RouteDeliveryPolicy,
  type RoutingContentType,
  type RoutingMediaType,
  type RoutingPolicy,
  type SchedulerConfig,
  type Source,
  type SourceFilterPolicy,
  type SourceScheduleMode,
  type SourceSchedulePolicy,
  type SyncMode,
  type UserPermissions,
  type UserRole,
  type WebUser,
} from './schemas.js';

export function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// Secrets are deliberately not trimmed or otherwise rewritten. App passwords,
// cookies, and API keys may contain significant whitespace.
const normalizeSecret = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const normalizeEmail = (value: unknown): string | undefined => {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : undefined;
};

const normalizeRole = (value: unknown): UserRole | undefined =>
  value === 'admin' || value === 'user' ? value : undefined;

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const normalizePositiveNumber = (value: unknown, fallback: number): number => {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
};

const normalizeNonNegativeInteger = (value: unknown, fallback = 0): number => {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : fallback;
};

const normalizeIsoDateString = (value: unknown): string | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

const normalizeStoredServiceUrl = (value: unknown): string => {
  try {
    return normalizeBlueskyServiceUrl(normalizeString(value));
  } catch {
    return 'https://bsky.social';
  }
};

const normalizeUserPermissions = (value: unknown, role: UserRole): UserPermissions => {
  if (role === 'admin') {
    return { ...ADMIN_USER_PERMISSIONS };
  }

  const defaults = { ...DEFAULT_USER_PERMISSIONS };
  if (!isConfigRecord(value)) {
    return defaults;
  }

  return {
    viewAllMappings: normalizeBoolean(value.viewAllMappings, defaults.viewAllMappings),
    manageOwnMappings: normalizeBoolean(value.manageOwnMappings, defaults.manageOwnMappings),
    manageAllMappings: normalizeBoolean(value.manageAllMappings, defaults.manageAllMappings),
    manageGroups: normalizeBoolean(value.manageGroups, defaults.manageGroups),
    queueBackfills: normalizeBoolean(value.queueBackfills, defaults.queueBackfills),
    runNow: normalizeBoolean(value.runNow, defaults.runNow),
    reevaluateQueuePolicies: normalizeBoolean(
      value.reevaluateQueuePolicies,
      defaults.reevaluateQueuePolicies,
    ),
  };
};

const normalizeUser = (rawUser: unknown, index: number, fallbackNowIso: string): WebUser | null => {
  if (!isConfigRecord(rawUser)) {
    return null;
  }

  const passwordHash = normalizeSecret(rawUser.passwordHash);
  if (!passwordHash) {
    return null;
  }

  const role = normalizeRole(rawUser.role) ?? (index === 0 ? 'admin' : 'user');
  const createdAt = normalizeString(rawUser.createdAt) ?? fallbackNowIso;
  const updatedAt = normalizeString(rawUser.updatedAt) ?? createdAt;

  return {
    id: normalizeString(rawUser.id) ?? randomUUID(),
    username: normalizeTwitterUsername(rawUser.username),
    email: normalizeEmail(rawUser.email),
    passwordHash,
    tokenVersion: normalizeNonNegativeInteger(rawUser.tokenVersion),
    role,
    permissions: normalizeUserPermissions(rawUser.permissions, role),
    createdAt,
    updatedAt,
  };
};

const normalizeUsers = (rawUsers: unknown): WebUser[] => {
  if (!Array.isArray(rawUsers)) {
    return [];
  }

  const fallbackNowIso = new Date().toISOString();
  const normalized = rawUsers
    .map((user, index) => normalizeUser(user, index, fallbackNowIso))
    .filter((user): user is WebUser => user !== null);

  const usedIds = new Set<string>();
  for (const user of normalized) {
    if (usedIds.has(user.id)) {
      user.id = randomUUID();
    }
    usedIds.add(user.id);
  }

  const firstUser = normalized[0];
  if (firstUser && !normalized.some((user) => user.role === 'admin')) {
    firstUser.role = 'admin';
    firstUser.permissions = { ...ADMIN_USER_PERMISSIONS };
    firstUser.updatedAt = new Date().toISOString();
  }

  for (const user of normalized) {
    if (user.role === 'admin') {
      user.permissions = { ...ADMIN_USER_PERMISSIONS };
    }
  }

  return normalized;
};

const normalizeGroup = (group: unknown): AccountGroup | null => {
  if (!isConfigRecord(group)) {
    return null;
  }
  const name = normalizeString(group.name);
  if (!name) {
    return null;
  }
  const emoji = normalizeString(group.emoji);
  return {
    name,
    ...(emoji ? { emoji } : {}),
  };
};

const findAdminUserId = (users: WebUser[]): string | undefined => users.find((user) => user.role === 'admin')?.id;

const matchOwnerToUserId = (owner: string | undefined, users: WebUser[]): string | undefined => {
  if (!owner) {
    return undefined;
  }

  const normalizedOwner = owner.trim().toLowerCase();
  if (!normalizedOwner) {
    return undefined;
  }

  return users.find((user) => {
    const username = user.username?.toLowerCase();
    const email = user.email?.toLowerCase();
    const emailLocalPart = email?.split('@')[0];
    return normalizedOwner === username || normalizedOwner === email || normalizedOwner === emailLocalPart;
  })?.id;
};

const normalizeAttributionMode = (value: unknown, fallback: AttributionMode): AttributionMode =>
  value === 'never' || value === 'multiple-sources' || value === 'always' ? value : fallback;

const normalizePostingPolicy = (value: unknown, sourceCount: number): PostingPolicy => {
  const defaults = defaultPostingPolicy(sourceCount);
  const record = isConfigRecord(value) ? value : {};
  const attribution = isConfigRecord(record.attribution) ? record.attribution : {};

  return {
    attribution: {
      mode: normalizeAttributionMode(attribution.mode, defaults.attribution.mode),
      template: normalizeString(attribution.template) ?? DEFAULT_ATTRIBUTION_TEMPLATE,
      rootPostsOnly: normalizeBoolean(attribution.rootPostsOnly, defaults.attribution.rootPostsOnly),
      linkSource: normalizeBoolean(attribution.linkSource, defaults.attribution.linkSource),
    },
    appendOriginalPostLink: normalizeBoolean(record.appendOriginalPostLink, defaults.appendOriginalPostLink),
  };
};

const normalizeSyncMode = (value: unknown, fallback: SyncMode): SyncMode =>
  value === 'off' || value === 'manual' || value === 'scheduled' ? value : fallback;

const normalizeProfileManagementPolicy = (
  value: unknown,
  twitterUsernames: string[],
  compatibilitySource: unknown,
): ProfileManagementPolicy => {
  const record = isConfigRecord(value) ? value : {};
  const rawProfileSync = record.profileSync;
  const rawPinSync = record.pinSync;
  const hasExplicitProfileSync = isConfigRecord(rawProfileSync);
  const hasExplicitPinSync = isConfigRecord(rawPinSync);
  const profileSync = isConfigRecord(rawProfileSync) ? rawProfileSync : {};
  const pinSync = isConfigRecord(rawPinSync) ? rawPinSync : {};
  const fields = isConfigRecord(profileSync.fields) ? profileSync.fields : {};
  const requestedProfileSource = profileSync.sourceUsername ?? compatibilitySource;
  const resolvedSource =
    requestedProfileSource === undefined && hasExplicitProfileSync
      ? undefined
      : resolveProfileSyncSourceUsername({
          twitterUsernames,
          requestedSource: requestedProfileSource,
        });
  const resolvedPinSource =
    pinSync.sourceUsername === undefined && hasExplicitPinSync
      ? undefined
      : resolveProfileSyncSourceUsername({
          twitterUsernames,
          requestedSource: pinSync.sourceUsername,
        });
  const defaults = defaultProfileManagementPolicy(resolvedSource);

  return {
    allowProfileMutation: normalizeBoolean(record.allowProfileMutation, defaults.allowProfileMutation),
    ensureBotLabel: normalizeBoolean(record.ensureBotLabel, defaults.ensureBotLabel),
    ensureDisplayNameBotSuffix: normalizeBoolean(
      record.ensureDisplayNameBotSuffix,
      defaults.ensureDisplayNameBotSuffix,
    ),
    profileSync: {
      mode: normalizeSyncMode(profileSync.mode, defaults.profileSync.mode),
      ...(resolvedSource ? { sourceUsername: resolvedSource } : {}),
      intervalHours: normalizePositiveNumber(profileSync.intervalHours, defaults.profileSync.intervalHours),
      fields: {
        displayName: normalizeBoolean(fields.displayName, defaults.profileSync.fields.displayName),
        description: normalizeBoolean(fields.description, defaults.profileSync.fields.description),
        avatar: normalizeBoolean(fields.avatar, defaults.profileSync.fields.avatar),
        banner: normalizeBoolean(fields.banner, defaults.profileSync.fields.banner),
      },
    },
    pinSync: {
      mode: normalizeSyncMode(pinSync.mode, defaults.pinSync.mode),
      ...(resolvedPinSource ? { sourceUsername: resolvedPinSource } : {}),
      intervalHours: normalizePositiveNumber(pinSync.intervalHours, defaults.pinSync.intervalHours),
    },
  };
};

const normalizeMigrationReview = (value: unknown): MappingMigrationReview | undefined => {
  if (!isConfigRecord(value)) {
    return undefined;
  }

  const notices = Array.isArray(value.notices)
    ? [...new Set(value.notices.map(normalizeString).filter((notice): notice is string => Boolean(notice)))]
    : [];
  const migratedFromSchemaVersion = Number(value.migratedFromSchemaVersion);
  const knownDisplayNameSuffix =
    value.knownDisplayNameSuffix === 'bot' || value.knownDisplayNameSuffix === 'unofficial'
      ? value.knownDisplayNameSuffix
      : undefined;

  return {
    needsAdminReview: normalizeBoolean(value.needsAdminReview, true),
    migratedFromSchemaVersion:
      Number.isInteger(migratedFromSchemaVersion) && migratedFromSchemaVersion >= 0 ? migratedFromSchemaVersion : 0,
    notices,
    priorProfileSyncSourceUsername: normalizeTwitterUsername(value.priorProfileSyncSourceUsername),
    knownBotLabelApplied: typeof value.knownBotLabelApplied === 'boolean' ? value.knownBotLabelApplied : undefined,
    knownDisplayNameSuffix,
    reviewedAt: normalizeIsoDateString(value.reviewedAt),
  };
};

const normalizeMapping = (rawMapping: unknown, users: WebUser[], adminUserId?: string): AccountMapping | null => {
  if (!isConfigRecord(rawMapping)) {
    return null;
  }

  const bskyIdentifier = normalizeString(rawMapping.bskyIdentifier);
  if (!bskyIdentifier) {
    return null;
  }

  const owner = normalizeString(rawMapping.owner);
  const twitterUsernames = parseTwitterUsernames(rawMapping.twitterUsernames, rawMapping.twitterUsername);
  const twitterUsernameSet = new Set(twitterUsernames);
  const pausedTwitterUsernames = parseTwitterUsernames(rawMapping.pausedTwitterUsernames).filter((username) =>
    twitterUsernameSet.has(username),
  );
  const profileManagement = normalizeProfileManagementPolicy(
    rawMapping.profileManagement,
    twitterUsernames,
    rawMapping.profileSyncSourceUsername,
  );
  const compatibilityProfileSource = resolveProfileSyncSourceUsername({
    twitterUsernames,
    requestedSource: rawMapping.profileSyncSourceUsername ?? profileManagement.profileSync.sourceUsername,
  });
  const explicitCreator = normalizeString(rawMapping.createdByUserId) ?? normalizeString(rawMapping.ownerUserId);
  const explicitCreatorExists = explicitCreator && users.some((user) => user.id === explicitCreator);

  return {
    id: normalizeString(rawMapping.id) ?? randomUUID(),
    twitterUsernames,
    ...(pausedTwitterUsernames.length > 0 ? { pausedTwitterUsernames } : {}),
    bskyIdentifier: bskyIdentifier.toLowerCase(),
    bskyPassword: normalizeSecret(rawMapping.bskyPassword) ?? '',
    bskyServiceUrl: normalizeStoredServiceUrl(rawMapping.bskyServiceUrl),
    bskyDid: normalizeString(rawMapping.bskyDid),
    bskyCanonicalHandle: normalizeTwitterUsername(rawMapping.bskyCanonicalHandle),
    enabled: normalizeBoolean(rawMapping.enabled, true),
    owner,
    groupName: normalizeString(rawMapping.groupName),
    groupEmoji: normalizeString(rawMapping.groupEmoji),
    createdByUserId:
      (explicitCreatorExists ? explicitCreator : undefined) ?? matchOwnerToUserId(owner, users) ?? adminUserId,
    postingPolicy: normalizePostingPolicy(rawMapping.postingPolicy, twitterUsernames.length),
    aiOverrides: normalizeAiOverrides(rawMapping.aiOverrides),
    moderationPolicy: normalizeModerationPolicy(rawMapping.moderationPolicy),
    duplicateSuppression: normalizeDuplicateSuppression(rawMapping.duplicateSuppression),
    profileManagement,
    migrationReview: normalizeMigrationReview(rawMapping.migrationReview),
    profileSyncSourceUsername: compatibilityProfileSource,
    lastProfileSyncAt: normalizeIsoDateString(rawMapping.lastProfileSyncAt),
    lastMirroredDisplayName: normalizeString(rawMapping.lastMirroredDisplayName),
    lastMirroredDescription: normalizeString(rawMapping.lastMirroredDescription),
    lastMirroredAvatarUrl: normalizeString(rawMapping.lastMirroredAvatarUrl),
    lastMirroredBannerUrl: normalizeString(rawMapping.lastMirroredBannerUrl),
    lastPinnedTweetId: normalizeString(rawMapping.lastPinnedTweetId),
    lastPinSyncAt: normalizeIsoDateString(rawMapping.lastPinSyncAt),
    hasBotLabel: normalizeBoolean(rawMapping.hasBotLabel, false),
  };
};

const AI_TEXT_CAPABILITIES: AITextCapability[] = ['translation', 'summarization', 'cleanup', 'hashtags'];

const normalizeAiOverrideMode = (value: unknown): AIOverrideMode =>
  value === 'enabled' || value === 'disabled' ? value : 'inherit';

export const normalizeAiOverrides = (value: unknown): DestinationAIOverrides => {
  const record = isConfigRecord(value) ? value : {};
  const text = isConfigRecord(record.textCapabilities) ? record.textCapabilities : {};
  return {
    imageAltText: normalizeAiOverrideMode(record.imageAltText),
    textCapabilities: Object.fromEntries(
      AI_TEXT_CAPABILITIES.map((capability) => [capability, normalizeAiOverrideMode(text[capability])]),
    ) as DestinationAIOverrides['textCapabilities'],
  };
};

const normalizeAiConfig = (rawAi: unknown, legacyGeminiApiKey?: string): AIConfig => {
  const record = isConfigRecord(rawAi) ? rawAi : {};
  const provider =
    record.provider === 'openai' ||
    record.provider === 'anthropic' ||
    record.provider === 'custom' ||
    record.provider === 'gemini'
      ? record.provider
      : DEFAULT_AI_CONFIG.provider;
  const apiKey = normalizeSecret(record.apiKey) ?? legacyGeminiApiKey;
  const text = isConfigRecord(record.textCapabilities) ? record.textCapabilities : {};
  const maxCandidate = Number(record.maxAltTextChars);
  const maxAltTextChars =
    Number.isInteger(maxCandidate) && maxCandidate >= 50 && maxCandidate <= 2000
      ? maxCandidate
      : DEFAULT_AI_CONFIG.maxAltTextChars;
  return {
    // Pre-v4 key-only configurations implicitly generated alt text. Preserve
    // that behavior once while making all new/default configurations opt-in.
    enabled: normalizeBoolean(record.enabled, Boolean(apiKey)),
    purpose: 'image-alt-text',
    provider,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(normalizeString(record.model) ? { model: normalizeString(record.model) } : {}),
    ...(normalizeString(record.baseUrl) ? { baseUrl: normalizeString(record.baseUrl) } : {}),
    maxAltTextChars,
    privacyDescription: normalizeString(record.privacyDescription) ?? DEFAULT_AI_CONFIG.privacyDescription,
    textCapabilities: Object.fromEntries(
      AI_TEXT_CAPABILITIES.map((capability) => {
        const value = isConfigRecord(text[capability]) ? text[capability] : {};
        return [
          capability,
          {
            enabled: normalizeBoolean(value.enabled, false),
            purpose: capability,
            privacyDescription:
              normalizeString(value.privacyDescription) ??
              DEFAULT_AI_CONFIG.textCapabilities[capability].privacyDescription,
          },
        ];
      }),
    ) as AIConfig['textCapabilities'],
  };
};

export const normalizeRoutingPolicy = (value: unknown): RoutingPolicy => {
  const record = isConfigRecord(value) ? value : {};
  const contentTypes = normalizeLowercaseStringArray(record.contentTypes).filter(
    (entry): entry is RoutingContentType => ['original', 'reply', 'quote', 'repost'].includes(entry),
  );
  const mediaTypes = normalizeLowercaseStringArray(record.mediaTypes).filter(
    (entry): entry is RoutingMediaType => ['none', 'image', 'video', 'gif'].includes(entry),
  );
  const allowedHours = Array.isArray(record.allowedHours)
    ? [...new Set(record.allowedHours.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))]
    : [];
  return {
    includeKeywords: normalizeLowercaseStringArray(record.includeKeywords),
    excludeKeywords: normalizeLowercaseStringArray(record.excludeKeywords),
    includeDomains: normalizeLowercaseStringArray(record.includeDomains),
    excludeDomains: normalizeLowercaseStringArray(record.excludeDomains),
    contentTypes,
    mediaTypes,
    languages: normalizeLowercaseStringArray(record.languages),
    timezone: normalizeString(record.timezone) ?? DEFAULT_ROUTING_POLICY.timezone,
    allowedHours,
  };
};

export const normalizeModerationPolicy = (value: unknown): ModerationPolicy => {
  const record = isConfigRecord(value) ? value : {};
  return {
    blockKeywords: normalizeLowercaseStringArray(record.blockKeywords),
    blockDomains: normalizeLowercaseStringArray(record.blockDomains),
    blockSourceUsernames: normalizeLowercaseStringArray(record.blockSourceUsernames).map((entry) =>
      entry.replace(/^@/, ''),
    ),
    sensitiveContent:
      record.sensitiveContent === 'block' || record.sensitiveContent === 'warn'
        ? record.sensitiveContent
        : DEFAULT_MODERATION_POLICY.sensitiveContent,
    dryRun: normalizeBoolean(record.dryRun, DEFAULT_MODERATION_POLICY.dryRun),
  };
};

export const normalizeDuplicateSuppression = (value: unknown): DuplicateSuppressionPolicy => {
  const record = isConfigRecord(value) ? value : {};
  const windowHours = Number(record.windowHours);
  return {
    enabled: normalizeBoolean(record.enabled, DEFAULT_DUPLICATE_SUPPRESSION.enabled),
    windowHours:
      Number.isFinite(windowHours) && windowHours > 0 && windowHours <= 24 * 365
        ? windowHours
        : DEFAULT_DUPLICATE_SUPPRESSION.windowHours,
    perceptualImageHash: normalizeBoolean(
      record.perceptualImageHash,
      DEFAULT_DUPLICATE_SUPPRESSION.perceptualImageHash,
    ),
  };
};

const normalizeSchedulerConfig = (rawScheduler: unknown, legacyInterval?: unknown): SchedulerConfig => {
  const record = isConfigRecord(rawScheduler) ? rawScheduler : {};
  return {
    enabled: normalizeBoolean(record.enabled, DEFAULT_SCHEDULER_CONFIG.enabled),
    intervalMinutes: normalizeCheckIntervalMinutes(record.intervalMinutes ?? legacyInterval),
    runOnStartup: normalizeBoolean(record.runOnStartup, DEFAULT_SCHEDULER_CONFIG.runOnStartup),
  };
};

const NOTIFICATION_EVENTS: NotificationEvent[] = [
  'twitter-auth-failure',
  'bsky-auth-failure',
  'queue-parked',
  'queue-age',
  'update-failure',
];

const normalizeNotificationConfig = (value: unknown): NotificationConfig => {
  const record = isConfigRecord(value) ? value : {};
  const events = isConfigRecord(record.events) ? record.events : {};
  const integer = (candidate: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(candidate);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  return {
    enabled: normalizeBoolean(record.enabled, DEFAULT_NOTIFICATION_CONFIG.enabled),
    ...(normalizeSecret(record.webhookUrl) !== undefined
      ? { webhookUrl: normalizeSecret(record.webhookUrl) }
      : {}),
    ...(normalizeSecret(record.webhookSecret) !== undefined
      ? { webhookSecret: normalizeSecret(record.webhookSecret) }
      : {}),
    allowPrivate: normalizeBoolean(record.allowPrivate, DEFAULT_NOTIFICATION_CONFIG.allowPrivate),
    events: Object.fromEntries(
      NOTIFICATION_EVENTS.map((event) => [
        event,
        normalizeBoolean(events[event], DEFAULT_NOTIFICATION_CONFIG.events[event]),
      ]),
    ) as Record<NotificationEvent, boolean>,
    maxAttempts: integer(record.maxAttempts, DEFAULT_NOTIFICATION_CONFIG.maxAttempts, 1, 10),
    backoffMs: integer(record.backoffMs, DEFAULT_NOTIFICATION_CONFIG.backoffMs, 100, 60_000),
    timeoutMs: integer(record.timeoutMs, DEFAULT_NOTIFICATION_CONFIG.timeoutMs, 1000, 120_000),
  };
};

export interface NormalizedLegacyConfigV2 {
  schemaVersion: 2;
  twitter: AppConfig['twitter'];
  mappings: AccountMapping[];
  groups: AccountGroup[];
  users: WebUser[];
  scheduler: SchedulerConfig;
  geminiApiKey?: string;
  ai: AIConfig;
}

export function normalizeLegacyConfigV2(rawConfig: unknown): NormalizedLegacyConfigV2 {
  if (!isConfigRecord(rawConfig)) {
    const defaults = getDefaultConfig();
    return {
      schemaVersion: 2,
      twitter: defaults.twitter,
      mappings: [],
      groups: defaults.groups,
      users: defaults.users,
      scheduler: defaults.scheduler,
      ai: defaults.ai,
    };
  }

  const rawTwitter = isConfigRecord(rawConfig.twitter) ? rawConfig.twitter : {};
  const users = normalizeUsers(rawConfig.users);
  const adminUserId = findAdminUserId(users);
  const mappings = Array.isArray(rawConfig.mappings)
    ? rawConfig.mappings
        .map((mapping) => normalizeMapping(mapping, users, adminUserId))
        .filter((mapping): mapping is AccountMapping => mapping !== null)
    : [];
  const groups = Array.isArray(rawConfig.groups)
    ? rawConfig.groups.map(normalizeGroup).filter((group): group is AccountGroup => group !== null)
    : [];

  const seenGroups = new Set<string>();
  const dedupedGroups = groups.filter((group) => {
    const key = group.name.toLowerCase();
    if (seenGroups.has(key)) {
      return false;
    }
    seenGroups.add(key);
    return true;
  });

  const geminiApiKey = normalizeSecret(rawConfig.geminiApiKey);
  const ai = normalizeAiConfig(rawConfig.ai, geminiApiKey);

  return {
    schemaVersion: 2,
    twitter: {
      authToken: normalizeSecret(rawTwitter.authToken) ?? '',
      ct0: normalizeSecret(rawTwitter.ct0) ?? '',
      ...(normalizeSecret(rawTwitter.backupAuthToken) !== undefined
        ? { backupAuthToken: normalizeSecret(rawTwitter.backupAuthToken) }
        : {}),
      ...(normalizeSecret(rawTwitter.backupCt0) !== undefined
        ? { backupCt0: normalizeSecret(rawTwitter.backupCt0) }
        : {}),
    },
    mappings,
    groups: dedupedGroups,
    users,
    scheduler: normalizeSchedulerConfig(rawConfig.scheduler, rawConfig.checkIntervalMinutes),
    ...(geminiApiKey !== undefined ? { geminiApiKey } : {}),
    ai,
  };
}

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map(normalizeString).filter((entry): entry is string => Boolean(entry)))]
    : [];

const normalizeLowercaseStringArray = (value: unknown): string[] =>
  normalizeStringArray(value).map((entry) => entry.toLowerCase());

export const normalizeSourceFilters = (value: unknown): SourceFilterPolicy => {
  const record = isConfigRecord(value) ? value : {};
  return {
    originalPosts: normalizeBoolean(record.originalPosts, DEFAULT_SOURCE_FILTERS.originalPosts),
    selfReplies: normalizeBoolean(record.selfReplies, DEFAULT_SOURCE_FILTERS.selfReplies),
    externalReplies: normalizeBoolean(record.externalReplies, DEFAULT_SOURCE_FILTERS.externalReplies),
    quotes: normalizeBoolean(record.quotes, DEFAULT_SOURCE_FILTERS.quotes),
    reposts: normalizeBoolean(record.reposts, DEFAULT_SOURCE_FILTERS.reposts),
    mediaOnly: normalizeBoolean(record.mediaOnly, DEFAULT_SOURCE_FILTERS.mediaOnly),
    includeKeywords: normalizeLowercaseStringArray(record.includeKeywords),
    excludeKeywords: normalizeLowercaseStringArray(record.excludeKeywords),
    languages: normalizeLowercaseStringArray(record.languages),
    sensitiveContent: record.sensitiveContent === 'skip' ? 'skip' : 'mirror',
  };
};

const normalizeSourceScheduleMode = (value: unknown): SourceScheduleMode =>
  value === 'adaptive' || value === 'fixed' || value === 'inherit' ? value : DEFAULT_SOURCE_SCHEDULE.mode;

export const normalizeSourceSchedule = (value: unknown): SourceSchedulePolicy => {
  const record = isConfigRecord(value) ? value : {};
  const minIntervalMinutes = normalizeCheckIntervalMinutes(
    record.minIntervalMinutes ?? DEFAULT_SOURCE_SCHEDULE.minIntervalMinutes,
  );
  const maxIntervalMinutes = Math.max(
    minIntervalMinutes,
    normalizeCheckIntervalMinutes(record.maxIntervalMinutes ?? DEFAULT_SOURCE_SCHEDULE.maxIntervalMinutes),
  );
  const fixedIntervalMinutes = Math.min(
    maxIntervalMinutes,
    Math.max(
      minIntervalMinutes,
      normalizeCheckIntervalMinutes(record.fixedIntervalMinutes ?? DEFAULT_SOURCE_SCHEDULE.fixedIntervalMinutes),
    ),
  );
  return {
    mode: normalizeSourceScheduleMode(record.mode),
    minIntervalMinutes,
    maxIntervalMinutes,
    fixedIntervalMinutes,
    timezone: normalizeString(record.timezone) ?? DEFAULT_SOURCE_SCHEDULE.timezone,
  };
};

const normalizeDestinationMetadata = (value: unknown, destinationId: string): DestinationMetadata => {
  const record = isConfigRecord(value) ? value : {};
  const legacyMappingIds = normalizeStringArray(record.legacyMappingIds);
  return {
    legacyMappingIds: legacyMappingIds.length > 0 ? legacyMappingIds : [destinationId],
    lastProfileSyncAt: normalizeIsoDateString(record.lastProfileSyncAt),
    lastMirroredDisplayName: normalizeString(record.lastMirroredDisplayName),
    lastMirroredDescription: normalizeString(record.lastMirroredDescription),
    lastMirroredAvatarUrl: normalizeString(record.lastMirroredAvatarUrl),
    lastMirroredBannerUrl: normalizeString(record.lastMirroredBannerUrl),
    lastPinnedTweetId: normalizeString(record.lastPinnedTweetId),
    lastPinSyncAt: normalizeIsoDateString(record.lastPinSyncAt),
    hasBotLabel: typeof record.hasBotLabel === 'boolean' ? record.hasBotLabel : undefined,
  };
};

const normalizeSource = (value: unknown): Source | null => {
  if (!isConfigRecord(value)) {
    return null;
  }
  const type = value.type === 'webhook' || value.type === 'api' ? value.type : 'x';
  const username =
    type === 'x'
      ? normalizeTwitterUsername(value.username)
      : normalizeString(value.name ?? value.username)?.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!username) {
    return null;
  }
  const state = isConfigRecord(value.state) ? value.state : {};
  return {
    id: normalizeString(value.id) ?? (type === 'x' ? sourceIdForUsername(username) : `source_${randomUUID()}`),
    type,
    username,
    name: normalizeString(value.name) ?? username,
    enabled: normalizeBoolean(value.enabled, true),
    filters: normalizeSourceFilters(value.filters),
    schedule: normalizeSourceSchedule(value.schedule),
    state: {
      lastCheckAt: normalizeIsoDateString(state.lastCheckAt),
      lastFetchedAt: normalizeIsoDateString(state.lastFetchedAt),
      lastSuccessfulFetchAt: normalizeIsoDateString(state.lastSuccessfulFetchAt),
      lastTweetSeenId: normalizeString(state.lastTweetSeenId),
      lastTweetSeenAt: normalizeIsoDateString(state.lastTweetSeenAt),
      lastErrorAt: normalizeIsoDateString(state.lastErrorAt),
      lastErrorCategory: normalizeString(state.lastErrorCategory),
      lastErrorMessage: normalizeString(state.lastErrorMessage),
      consecutiveFailures: normalizeNonNegativeInteger(state.consecutiveFailures),
      nextEligibleCheckAt: normalizeIsoDateString(state.nextEligibleCheckAt),
    },
    createdAt: normalizeIsoDateString(value.createdAt),
    updatedAt: normalizeIsoDateString(value.updatedAt),
  };
};

export const normalizeRouteDelivery = (value: unknown): RouteDeliveryPolicy => {
  const record = isConfigRecord(value) ? value : {};
  const digest = isConfigRecord(record.digest) ? record.digest : {};
  const integer = (candidate: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(candidate);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  return {
    mode: record.mode === 'digest' ? 'digest' : 'immediate',
    digest: {
      enabled: normalizeBoolean(digest.enabled, record.mode === 'digest'),
      cadence:
        digest.cadence === 'hourly' || digest.cadence === 'daily' || digest.cadence === 'weekly'
          ? digest.cadence
          : DEFAULT_ROUTE_DELIVERY.digest.cadence,
      timezone: normalizeString(digest.timezone) ?? DEFAULT_ROUTE_DELIVERY.digest.timezone,
      hour: integer(digest.hour, DEFAULT_ROUTE_DELIVERY.digest.hour, 0, 23),
      minute: integer(digest.minute, DEFAULT_ROUTE_DELIVERY.digest.minute, 0, 59),
      ...(digest.dayOfWeek === undefined
        ? {}
        : { dayOfWeek: integer(digest.dayOfWeek, 1, 0, 6) }),
      grouping:
        digest.grouping === 'none' || digest.grouping === 'source' || digest.grouping === 'day'
          ? digest.grouping
          : DEFAULT_ROUTE_DELIVERY.digest.grouping,
      template: normalizeString(digest.template) ?? DEFAULT_ROUTE_DELIVERY.digest.template,
      maxEntries: integer(digest.maxEntries, DEFAULT_ROUTE_DELIVERY.digest.maxEntries, 1, 200),
      maxGraphemes: integer(
        digest.maxGraphemes,
        DEFAULT_ROUTE_DELIVERY.digest.maxGraphemes,
        100,
        20_000,
      ),
      includeSourceAttribution: normalizeBoolean(
        digest.includeSourceAttribution,
        DEFAULT_ROUTE_DELIVERY.digest.includeSourceAttribution,
      ),
    },
  };
};

const normalizeDestination = (
  value: unknown,
  sourceCountByDestination: ReadonlyMap<string, number>,
): Destination | null => {
  if (!isConfigRecord(value)) {
    return null;
  }
  const id = normalizeString(value.id);
  const bskyIdentifier = normalizeString(value.bskyIdentifier);
  if (!id || !bskyIdentifier) {
    return null;
  }
  const sourceCount = sourceCountByDestination.get(id) ?? 0;
  const profileManagement = normalizeProfileManagementPolicy(value.profileManagement, [], undefined);
  return {
    id,
    enabled: normalizeBoolean(value.enabled, true),
    bskyIdentifier: bskyIdentifier.toLowerCase(),
    bskyPassword: normalizeSecret(value.bskyPassword) ?? '',
    bskyServiceUrl: normalizeStoredServiceUrl(value.bskyServiceUrl),
    bskyDid: normalizeString(value.bskyDid),
    bskyCanonicalHandle: normalizeTwitterUsername(value.bskyCanonicalHandle),
    storageKey:
      normalizeString(value.storageKey)?.toLowerCase() ??
      normalizeString(value.bskyDid)?.toLowerCase() ??
      bskyIdentifier.toLowerCase(),
    owner: normalizeString(value.owner),
    groupName: normalizeString(value.groupName),
    groupEmoji: normalizeString(value.groupEmoji),
    createdByUserId: normalizeString(value.createdByUserId),
    postingPolicy: normalizePostingPolicy(value.postingPolicy, sourceCount),
    aiOverrides: normalizeAiOverrides(value.aiOverrides),
    moderationPolicy: normalizeModerationPolicy(value.moderationPolicy),
    duplicateSuppression: normalizeDuplicateSuppression(value.duplicateSuppression),
    profileManagement,
    migrationReview: normalizeMigrationReview(value.migrationReview),
    metadata: normalizeDestinationMetadata(value.metadata, id),
  };
};

const normalizeRoute = (value: unknown): Route | null => {
  if (!isConfigRecord(value)) {
    return null;
  }
  const id = normalizeString(value.id);
  const sourceId = normalizeString(value.sourceId);
  const destinationId = normalizeString(value.destinationId);
  if (!id || !sourceId || !destinationId) {
    return null;
  }
  const relationship = isConfigRecord(value.relationship) ? value.relationship : {};
  const metadata = isConfigRecord(value.metadata) ? value.metadata : {};
  return {
    id,
    sourceId,
    destinationId,
    enabled: normalizeBoolean(value.enabled, true),
    filters: normalizeSourceFilters(value.filters),
    routingPolicy: normalizeRoutingPolicy(value.routingPolicy),
    moderationPolicy: normalizeModerationPolicy(value.moderationPolicy),
    duplicateSuppression: normalizeDuplicateSuppression(value.duplicateSuppression),
    delivery: normalizeRouteDelivery(value.delivery),
    relationship: {
      sourcePaused: normalizeBoolean(relationship.sourcePaused, false),
      profileSyncSource: normalizeBoolean(relationship.profileSyncSource, false),
      pinSyncSource: normalizeBoolean(relationship.pinSyncSource, false),
    },
    metadata: {
      legacyMappingIds: normalizeStringArray(metadata.legacyMappingIds),
    },
  };
};

const normalizeMigrationMetadata = (value: unknown): ConfigMigrationMetadata | undefined => {
  if (!isConfigRecord(value)) {
    return undefined;
  }
  const migratedFromVersion = Number(value.migratedFromVersion);
  const rollback = isConfigRecord(value.rollback) ? value.rollback : {};
  const instructions = normalizeStringArray(rollback.instructions);
  return {
    migratedFromVersion: Number.isInteger(migratedFromVersion) && migratedFromVersion >= 0 ? migratedFromVersion : 2,
    migratedAt: normalizeIsoDateString(value.migratedAt) ?? new Date(0).toISOString(),
    rollback: {
      backupSuffix:
        rollback.backupSuffix === '.pre-v6-backup'
          ? '.pre-v6-backup'
          : rollback.backupSuffix === '.pre-v5-backup'
          ? '.pre-v5-backup'
          : rollback.backupSuffix === '.pre-v4-backup'
            ? '.pre-v4-backup'
            : '.pre-v3-backup',
      instructions:
        instructions.length > 0
          ? instructions
          : [
              'Stop the application.',
              'Restore config.json.pre-v3-backup as config.json.',
              'Start the previous release.',
            ],
    },
  };
};

export function normalizeConfigV3(rawConfig: unknown): AppConfig {
  if (!isConfigRecord(rawConfig)) {
    return getDefaultConfig();
  }
  const rawTwitter = isConfigRecord(rawConfig.twitter) ? rawConfig.twitter : {};
  const users = normalizeUsers(rawConfig.users);
  const groups = Array.isArray(rawConfig.groups)
    ? rawConfig.groups.map(normalizeGroup).filter((group): group is AccountGroup => group !== null)
    : [];
  const groupNames = new Set<string>();
  const dedupedGroups = groups.filter((group) => {
    const key = group.name.toLowerCase();
    if (groupNames.has(key)) return false;
    groupNames.add(key);
    return true;
  });
  const sources = Array.isArray(rawConfig.sources)
    ? rawConfig.sources.map(normalizeSource).filter((source): source is Source => source !== null)
    : [];
  const routes = Array.isArray(rawConfig.routes)
    ? rawConfig.routes.map(normalizeRoute).filter((route): route is Route => route !== null)
    : [];
  const sourceCountByDestination = new Map<string, number>();
  for (const route of routes) {
    sourceCountByDestination.set(route.destinationId, (sourceCountByDestination.get(route.destinationId) ?? 0) + 1);
  }
  const destinations = Array.isArray(rawConfig.destinations)
    ? rawConfig.destinations
        .map((destination) => normalizeDestination(destination, sourceCountByDestination))
        .filter((destination): destination is Destination => destination !== null)
    : [];
  const geminiApiKey = normalizeSecret(rawConfig.geminiApiKey);
  const ai = normalizeAiConfig(rawConfig.ai, geminiApiKey);
  const canonical = {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    revision:
      Number.isSafeInteger(rawConfig.revision) && Number(rawConfig.revision) >= 0
        ? Number(rawConfig.revision)
        : 0,
    updatedAt:
      typeof rawConfig.updatedAt === 'string' && Number.isFinite(Date.parse(rawConfig.updatedAt))
        ? rawConfig.updatedAt
        : new Date(0).toISOString(),
    twitter: {
      authToken: normalizeSecret(rawTwitter.authToken) ?? '',
      ct0: normalizeSecret(rawTwitter.ct0) ?? '',
      ...(normalizeSecret(rawTwitter.backupAuthToken) !== undefined
        ? { backupAuthToken: normalizeSecret(rawTwitter.backupAuthToken) }
        : {}),
      ...(normalizeSecret(rawTwitter.backupCt0) !== undefined
        ? { backupCt0: normalizeSecret(rawTwitter.backupCt0) }
        : {}),
    },
    sources,
    destinations,
    routes,
    groups: dedupedGroups,
    users,
    scheduler: normalizeSchedulerConfig(rawConfig.scheduler, rawConfig.checkIntervalMinutes),
    notifications: normalizeNotificationConfig(rawConfig.notifications),
    ...(geminiApiKey !== undefined ? { geminiApiKey } : {}),
    ai,
    ...(normalizeMigrationMetadata(rawConfig.migration)
      ? { migration: normalizeMigrationMetadata(rawConfig.migration) }
      : {}),
  } satisfies Omit<AppConfig, 'mappings'>;
  const config = withCompatibilityMappings(canonical);

  // Relationship flags are canonical. Project their source identities back
  // into the one-release destination policy compatibility shape.
  const sourceById = new Map(config.sources.map((source) => [source.id, source]));
  for (const destination of config.destinations) {
    const destinationRoutes = config.routes.filter((route) => route.destinationId === destination.id);
    const profileRoute = destinationRoutes.find((route) => route.relationship.profileSyncSource);
    const pinRoute = destinationRoutes.find((route) => route.relationship.pinSyncSource);
    const profileUsername = profileRoute ? sourceById.get(profileRoute.sourceId)?.username : undefined;
    const pinUsername = pinRoute ? sourceById.get(pinRoute.sourceId)?.username : undefined;
    destination.profileManagement.profileSync.sourceUsername = profileUsername;
    destination.profileManagement.pinSync.sourceUsername = pinUsername;
  }
  config.mappings = projectAccountMappings(config);
  return config;
}

/**
 * Compatibility constructor retained for callers and tests that still submit
 * the v2 mapping shape. Its output is canonical v3 plus a runtime projection.
 */
export function normalizeConfigV2(rawConfig: unknown): AppConfig {
  if (
    isConfigRecord(rawConfig) &&
    Array.isArray(rawConfig.sources) &&
    Array.isArray(rawConfig.destinations) &&
    Array.isArray(rawConfig.routes)
  ) {
    return normalizeConfigV3(rawConfig);
  }
  const legacy = normalizeLegacyConfigV2(rawConfig);
  const defaults = getDefaultConfig();
  const base = withCompatibilityMappings({
    ...toCanonicalConfig(defaults),
    twitter: legacy.twitter,
    groups: legacy.groups,
    users: legacy.users,
    scheduler: legacy.scheduler,
    ...(legacy.geminiApiKey !== undefined ? { geminiApiKey: legacy.geminiApiKey } : {}),
    ai: legacy.ai,
  });
  return applyMappingProjection(base, legacy.mappings);
}

export function assertValidAppConfig(config: AppConfig): void {
  if (config.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unsupported config schema version: ${config.schemaVersion}.`);
  }
  if (!Number.isSafeInteger(config.revision) || config.revision < 0 || !Number.isFinite(Date.parse(config.updatedAt))) {
    throw new Error('Config concurrency metadata is invalid.');
  }
  if (
    !Array.isArray(config.sources) ||
    !Array.isArray(config.destinations) ||
    !Array.isArray(config.routes) ||
    !Array.isArray(config.mappings) ||
    !Array.isArray(config.groups) ||
    !Array.isArray(config.users)
  ) {
    throw new Error('Config arrays are invalid.');
  }
  if (
    !Number.isInteger(config.scheduler.intervalMinutes) ||
    config.scheduler.intervalMinutes < 1 ||
    config.scheduler.intervalMinutes > 1440
  ) {
    throw new Error('Scheduler interval must be a whole number between 1 and 1440.');
  }

  const sourceIds = new Set<string>();
  const sourceIdentities = new Set<string>();
  for (const source of config.sources) {
    if (
      !source.id ||
      !['x', 'webhook', 'api'].includes(source.type) ||
      (source.type === 'x'
        ? !X_USERNAME_PATTERN.test(source.username)
        : !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(source.username))
    ) {
      throw new Error('A source is missing a valid canonical identity.');
    }
    const identity = `${source.type}:${source.username}`;
    if (sourceIds.has(source.id) || sourceIdentities.has(identity)) {
      throw new Error(`Duplicate source identity: ${source.username}.`);
    }
    sourceIds.add(source.id);
    sourceIdentities.add(identity);
    if (
      !['adaptive', 'fixed', 'inherit'].includes(source.schedule.mode) ||
      source.schedule.minIntervalMinutes > source.schedule.maxIntervalMinutes ||
      source.schedule.fixedIntervalMinutes < source.schedule.minIntervalMinutes ||
      source.schedule.fixedIntervalMinutes > source.schedule.maxIntervalMinutes
    ) {
      throw new Error(`Source ${source.id} contains an invalid schedule.`);
    }
  }

  const destinationIds = new Set<string>();
  const destinationIdentities = new Set<string>();
  for (const destination of config.destinations) {
    if (!destination.id || !destination.bskyIdentifier || typeof destination.bskyPassword !== 'string') {
      throw new Error('A destination is missing required identity or credential fields.');
    }
    if (destinationIds.has(destination.id)) {
      throw new Error(`Duplicate destination id: ${destination.id}.`);
    }
    destinationIds.add(destination.id);
    const destinationIdentity = destination.bskyDid
      ? `did:${destination.bskyDid.toLowerCase()}`
      : `${destination.bskyServiceUrl.toLowerCase()}|${destination.bskyIdentifier.toLowerCase()}`;
    if (destinationIdentities.has(destinationIdentity)) {
      throw new Error(`Duplicate canonical destination identity: ${destinationIdentity}.`);
    }
    destinationIdentities.add(destinationIdentity);
    validateAttributionTemplate(destination.postingPolicy.attribution.template);
    if (
      !['never', 'multiple-sources', 'always'].includes(destination.postingPolicy.attribution.mode) ||
      !['off', 'manual', 'scheduled'].includes(destination.profileManagement.profileSync.mode) ||
      !['off', 'manual', 'scheduled'].includes(destination.profileManagement.pinSync.mode)
    ) {
      throw new Error(`Destination ${destination.id} contains an invalid policy mode.`);
    }
    if (destination.migrationReview && destination.migrationReview.notices.length === 0) {
      throw new Error(`Destination ${destination.id} has incomplete migration review metadata.`);
    }
  }

  const routeIds = new Set<string>();
  const routePairs = new Set<string>();
  for (const route of config.routes) {
    const pair = `${route.sourceId}\0${route.destinationId}`;
    if (routeIds.has(route.id) || routePairs.has(pair)) {
      throw new Error(`Duplicate route identity: ${route.id}.`);
    }
    if (!sourceIds.has(route.sourceId) || !destinationIds.has(route.destinationId)) {
      throw new Error(`Route ${route.id} refers to an unknown source or destination.`);
    }
    routeIds.add(route.id);
    routePairs.add(pair);
    if (route.delivery?.mode === 'digest') {
      const digest = route.delivery.digest;
      if (
        !digest.enabled ||
        !digest.template.includes('{entries}') ||
        digest.maxEntries < 1 ||
        digest.maxGraphemes < 100
      ) {
        throw new Error(`Route ${route.id} contains an invalid digest policy.`);
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: digest.timezone }).format();
      } catch {
        throw new Error(`Route ${route.id} contains an invalid digest timezone.`);
      }
    }
  }
}
