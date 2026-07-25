import { DEFAULT_CHECK_INTERVAL_MINUTES } from '../scheduler-timing.js';
import { withCompatibilityMappings } from './projection.js';
import {
  type AppConfig,
  type AIConfig,
  type DestinationAIOverrides,
  type DuplicateSuppressionPolicy,
  type ModerationPolicy,
  CURRENT_CONFIG_SCHEMA_VERSION,
  type NotificationConfig,
  type PostingPolicy,
  type ProfileManagementPolicy,
  type SchedulerConfig,
  type SourceFilterPolicy,
  type RoutingPolicy,
  type RouteDeliveryPolicy,
  type SourceSchedulePolicy,
  type TwitterConfig,
  type UserPermissions,
  type UserRole,
} from './schemas.js';

export const DEFAULT_ATTRIBUTION_TEMPLATE = 'Source: @{username} on X';

export const DEFAULT_TWITTER_CONFIG: TwitterConfig = {
  authToken: '',
  ct0: '',
};

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  enabled: true,
  intervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
  runOnStartup: false,
};

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: false,
  allowPrivate: false,
  events: {
    'twitter-auth-failure': true,
    'bsky-auth-failure': true,
    'queue-parked': true,
    'queue-age': false,
    'update-failure': true,
  },
  maxAttempts: 3,
  backoffMs: 1000,
  timeoutMs: 10_000,
};

/**
 * Matches the pre-policy pipeline: roots, self-threads and quotes were
 * mirrored; external replies and reposts were skipped.
 */
export const DEFAULT_SOURCE_FILTERS: SourceFilterPolicy = {
  originalPosts: true,
  selfReplies: true,
  externalReplies: false,
  quotes: true,
  reposts: false,
  mediaOnly: false,
  includeKeywords: [],
  excludeKeywords: [],
  languages: [],
  sensitiveContent: 'mirror',
};

export const DEFAULT_SOURCE_SCHEDULE: SourceSchedulePolicy = {
  mode: 'inherit',
  minIntervalMinutes: 1,
  maxIntervalMinutes: 1440,
  fixedIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
  timezone: 'UTC',
};

const AI_PRIVACY_COPY =
  'Image bytes and limited post context are sent to the configured provider only to create image alt text.';
const TEXT_PRIVACY_COPY =
  'Post text is sent to the configured provider only when this capability is explicitly enabled.';

export const DEFAULT_AI_CONFIG: AIConfig = {
  enabled: false,
  purpose: 'image-alt-text',
  provider: 'gemini',
  maxAltTextChars: 1000,
  privacyDescription: AI_PRIVACY_COPY,
  textCapabilities: {
    translation: { enabled: false, purpose: 'translation', privacyDescription: TEXT_PRIVACY_COPY },
    summarization: { enabled: false, purpose: 'summarization', privacyDescription: TEXT_PRIVACY_COPY },
    cleanup: { enabled: false, purpose: 'cleanup', privacyDescription: TEXT_PRIVACY_COPY },
    hashtags: { enabled: false, purpose: 'hashtags', privacyDescription: TEXT_PRIVACY_COPY },
  },
};

export const DEFAULT_AI_OVERRIDES: DestinationAIOverrides = {
  imageAltText: 'inherit',
  textCapabilities: {
    translation: 'inherit',
    summarization: 'inherit',
    cleanup: 'inherit',
    hashtags: 'inherit',
  },
};

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  includeKeywords: [],
  excludeKeywords: [],
  includeDomains: [],
  excludeDomains: [],
  contentTypes: [],
  mediaTypes: [],
  languages: [],
  timezone: 'UTC',
  allowedHours: [],
};

export const DEFAULT_MODERATION_POLICY: ModerationPolicy = {
  blockKeywords: [],
  blockDomains: [],
  blockSourceUsernames: [],
  sensitiveContent: 'allow',
  dryRun: false,
};

export const DEFAULT_DUPLICATE_SUPPRESSION: DuplicateSuppressionPolicy = {
  enabled: false,
  windowHours: 24,
  perceptualImageHash: false,
};

export const DEFAULT_ROUTE_DELIVERY: RouteDeliveryPolicy = {
  mode: 'immediate',
  digest: {
    enabled: false,
    cadence: 'daily',
    timezone: 'UTC',
    hour: 9,
    minute: 0,
    grouping: 'none',
    template: '{entries}',
    maxEntries: 25,
    maxGraphemes: 2_400,
    includeSourceAttribution: true,
  },
};

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: false,
  manageOwnMappings: true,
  manageAllMappings: false,
  manageGroups: false,
  queueBackfills: true,
  runNow: true,
  reevaluateQueuePolicies: false,
};

export const ADMIN_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: true,
  manageOwnMappings: true,
  manageAllMappings: true,
  manageGroups: true,
  queueBackfills: true,
  runNow: true,
  reevaluateQueuePolicies: true,
};

export function getDefaultUserPermissions(role: UserRole): UserPermissions {
  return role === 'admin' ? { ...ADMIN_USER_PERMISSIONS } : { ...DEFAULT_USER_PERMISSIONS };
}

export function defaultPostingPolicy(sourceCount: number): PostingPolicy {
  return {
    attribution: {
      mode: sourceCount > 1 ? 'multiple-sources' : 'never',
      template: DEFAULT_ATTRIBUTION_TEMPLATE,
      rootPostsOnly: true,
      linkSource: true,
    },
    appendOriginalPostLink: false,
  };
}

export function defaultProfileManagementPolicy(sourceUsername?: string): ProfileManagementPolicy {
  return {
    allowProfileMutation: false,
    ensureBotLabel: false,
    ensureDisplayNameBotSuffix: false,
    profileSync: {
      mode: 'off',
      ...(sourceUsername ? { sourceUsername } : {}),
      intervalHours: 24,
      fields: {
        displayName: false,
        description: false,
        avatar: false,
        banner: false,
      },
    },
    pinSync: {
      mode: 'off',
      ...(sourceUsername ? { sourceUsername } : {}),
      intervalHours: 24,
    },
  };
}

export function createDefaultMappingPolicies(
  sourceCount: number,
  sourceUsername?: string,
): Pick<
  AppConfig['mappings'][number],
  'postingPolicy' | 'profileManagement' | 'aiOverrides' | 'moderationPolicy' | 'duplicateSuppression'
> {
  return {
    postingPolicy: defaultPostingPolicy(sourceCount),
    aiOverrides: {
      ...DEFAULT_AI_OVERRIDES,
      textCapabilities: { ...DEFAULT_AI_OVERRIDES.textCapabilities },
    },
    moderationPolicy: {
      ...DEFAULT_MODERATION_POLICY,
      blockKeywords: [],
      blockDomains: [],
      blockSourceUsernames: [],
    },
    duplicateSuppression: { ...DEFAULT_DUPLICATE_SUPPRESSION },
    profileManagement: defaultProfileManagementPolicy(sourceUsername),
  };
}

export function getDefaultConfig(): AppConfig {
  return withCompatibilityMappings({
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    twitter: { ...DEFAULT_TWITTER_CONFIG },
    sources: [],
    destinations: [],
    routes: [],
    groups: [],
    users: [],
    scheduler: { ...DEFAULT_SCHEDULER_CONFIG },
    notifications: {
      ...DEFAULT_NOTIFICATION_CONFIG,
      events: { ...DEFAULT_NOTIFICATION_CONFIG.events },
    },
    ai: {
      ...DEFAULT_AI_CONFIG,
      textCapabilities: {
        translation: { ...DEFAULT_AI_CONFIG.textCapabilities.translation },
        summarization: { ...DEFAULT_AI_CONFIG.textCapabilities.summarization },
        cleanup: { ...DEFAULT_AI_CONFIG.textCapabilities.cleanup },
        hashtags: { ...DEFAULT_AI_CONFIG.textCapabilities.hashtags },
      },
    },
  });
}
