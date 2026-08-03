import type { ConfigVersion } from '../../api/types';

export type BulkAccountsAction =
  | 'sync_profiles'
  | 'pull_twitter_bio'
  | 'bridge_all'
  | 'apply_bot_label'
  | 'append_bot_name'
  | 'sync_pins';

export type AttributionMode = 'never' | 'multiple-sources' | 'always';
export type SyncMode = 'off' | 'manual' | 'scheduled';
export type AIOverrideMode = 'inherit' | 'enabled' | 'disabled';
export type DefaultInitialImportMode = 'new-only' | 'recent';
export type InitialImportMode = 'inherit' | DefaultInitialImportMode;

export interface SourceFilterPolicy {
  originalPosts: boolean;
  selfReplies: boolean;
  externalReplies: boolean;
  quotes: boolean;
  reposts: boolean;
  mediaOnly: boolean;
  includeKeywords: string[];
  excludeKeywords: string[];
  languages: string[];
  sensitiveContent: 'mirror' | 'skip';
}

export interface SourceSchedulePolicy {
  mode: 'adaptive' | 'fixed' | 'inherit';
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  fixedIntervalMinutes: number;
  timezone?: string;
}

export interface SourceRuntimeState {
  lastCheckAt?: number;
  lastFetchSuccessAt?: number;
  lastTweetSeenAt?: number;
  lastErrorAt?: number;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  nextEligibleCheckAt?: number;
  consecutiveFailures: number;
}

export interface DestinationAIOverrides {
  imageAltText: AIOverrideMode;
  textCapabilities: Record<'translation' | 'summarization' | 'cleanup' | 'hashtags', AIOverrideMode>;
}

export interface RoutingPolicy {
  includeKeywords: string[];
  excludeKeywords: string[];
  includeDomains: string[];
  excludeDomains: string[];
  contentTypes: Array<'original' | 'reply' | 'quote' | 'repost'>;
  mediaTypes: Array<'none' | 'image' | 'video' | 'gif'>;
  languages: string[];
  allowedHours: number[];
  timezone: string;
}

export interface ModerationPolicy {
  blockKeywords: string[];
  blockDomains: string[];
  blockSourceUsernames: string[];
  sensitiveContent: 'allow' | 'warn' | 'block';
  dryRun: boolean;
}

export interface DuplicateSuppressionPolicy {
  enabled: boolean;
  windowHours: number;
  perceptualImageHash: boolean;
}

export type RouteDeliveryMode = 'immediate' | 'digest';
export type DigestCadence = 'hourly' | 'daily' | 'weekly';
export type DigestGrouping = 'none' | 'source' | 'day';

export interface DigestPolicy {
  enabled: boolean;
  cadence: DigestCadence;
  timezone: string;
  hour: number;
  minute: number;
  dayOfWeek?: number;
  grouping: DigestGrouping;
  template: string;
  maxEntries: number;
  maxGraphemes: number;
  includeSourceAttribution: boolean;
}

export interface RouteDeliveryPolicy {
  mode: RouteDeliveryMode;
  digest: DigestPolicy;
}

export interface PostingPolicy {
  attribution: {
    mode: AttributionMode;
    template: string;
    rootPostsOnly: boolean;
    linkSource: boolean;
  };
  appendOriginalPostLink: boolean;
}

export interface ProfileManagementPolicy {
  allowProfileMutation: boolean;
  ensureBotLabel: boolean;
  ensureDisplayNameBotSuffix: boolean;
  profileSync: {
    mode: SyncMode;
    sourceUsername?: string;
    intervalHours: number;
    fields: {
      displayName: boolean;
      description: boolean;
      avatar: boolean;
      banner: boolean;
    };
  };
  pinSync: {
    mode: SyncMode;
    sourceUsername?: string;
    intervalHours: number;
  };
}

export interface QueueMappingCounts {
  mapping_id: string;
  bsky_identifier: string;
  pending: number;
  processing: number;
  failed: number;
  oldest_enqueued_at: number | null;
}

/** Canonical destination dashboard view (compatibility projection during AccountMapping retirement). */
export type DestinationView = AccountMapping;

/** Nested Bluesky account summary on destination API responses (never includes appPassword). */
export interface DestinationBlueskyAccount {
  id: string;
  label?: string;
  loginIdentifier: string;
  canonicalHandle?: string;
  did?: string;
  serviceUrl: string;
  credentialConfigured: boolean;
  health: {
    lastValidatedAt?: number;
    lastSuccessAt?: number;
    lastFailureAt?: number;
    lastErrorCategory?: string;
    consecutiveFailures: number;
  } | null;
}

export interface AccountMapping extends ConfigVersion {
  id: string;
  twitterUsernames: string[];
  pausedTwitterUsernames?: string[];
  bskyAccountId?: string;
  bskyIdentifier: string;
  bskyPassword?: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
  storageKey?: string;
  enabled: boolean;
  destinationState?: 'enabled' | 'paused';
  sourceCount?: number;
  activeSourceCount?: number;
  credentialConfigured?: boolean;
  blueskyAccount?: DestinationBlueskyAccount;
  sources?: Array<{
    username: string;
    routeId?: string;
    state: 'enabled' | 'paused';
    filters?: SourceFilterPolicy;
    routingPolicy?: RoutingPolicy;
    moderationPolicy?: ModerationPolicy;
    duplicateSuppression?: DuplicateSuppressionPolicy;
    delivery?: RouteDeliveryPolicy;
    initialImportMode?: InitialImportMode;
    schedule?: SourceSchedulePolicy;
    runtime?: SourceRuntimeState | null;
  }>;
  runtime?: {
    lastBskyLoginAt?: number;
    lastBskyPostAt?: number;
    lastProfileSyncAt?: number;
    lastPinSyncAt?: number;
    lastErrorCategory?: string;
    lastErrorMessage?: string;
    lastErrorAt?: number;
    consecutiveFailures: number;
  } | null;
  queue?: QueueMappingCounts | null;
  owner?: string;
  groupName?: string;
  groupEmoji?: string;
  createdByUserId?: string;
  createdByLabel?: string;
  profileSyncSourceUsername?: string;
  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  hasBotLabel?: boolean;
  postingPolicy: PostingPolicy;
  aiOverrides: DestinationAIOverrides;
  moderationPolicy: ModerationPolicy;
  duplicateSuppression: DuplicateSuppressionPolicy;
  profileManagement: ProfileManagementPolicy;
  initialImportModesByUsername?: Record<string, InitialImportMode>;
  createdByUser?: {
    id: string;
    username?: string;
    email?: string;
    role: 'admin' | 'user';
  };
}

export interface ContentPolicyEditorState {
  username: string;
  routeId: string;
  routingPolicy: RoutingPolicy;
  routeModerationPolicy: ModerationPolicy;
  routeDuplicateSuppression: DuplicateSuppressionPolicy;
  destinationModerationPolicy: ModerationPolicy;
  destinationDuplicateSuppression: DuplicateSuppressionPolicy;
  aiOverrides: DestinationAIOverrides;
  previewText: string;
  previewLanguage: string;
  previewSensitive: boolean;
  previewResult?: { allowed: boolean; reason: string; trace: unknown[] };
}

export interface AccountGroup {
  name: string;
  emoji?: string;
}

export interface BskyProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  createdAt?: string;
}

export interface FediverseBridgeStatusView {
  bridged: boolean;
  checkedAt: string;
  error?: string;
}

export interface TwitterMirrorProfile {
  username: string;
  profileUrl: string;
  name?: string;
  biography?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  mirroredDisplayName: string;
  mirroredDescription: string;
}

export interface BlueskyCredentialValidation {
  did: string;
  handle: string;
  email?: string;
  emailConfirmed: boolean;
  serviceUrl: string;
  settingsUrl: string;
}

export interface MirrorProfileSyncResult {
  success: boolean;
  twitterProfile: TwitterMirrorProfile;
  bsky: BlueskyCredentialValidation;
  avatarSynced: boolean;
  bannerSynced: boolean;
  skipped?: boolean;
  changed?: {
    displayName: boolean;
    description: boolean;
    avatar: boolean;
    banner: boolean;
  };
  warnings: string[];
  sourceTwitterUsername?: string;
  mapping?: AccountMapping;
}

export interface BulkBotLabelAllResult {
  success: boolean;
  total: number;
  labeled: number;
  alreadyLabeled: number;
  failed: number;
  failedMappings?: Array<{ id: string; bskyIdentifier: string; error: string }>;
  mappings?: AccountMapping[];
}

export interface BulkAppendBotNameAllResult {
  success: boolean;
  total: number;
  appended: number;
  alreadyAppended: number;
  failed: number;
  failedMappings?: Array<{ id: string; bskyIdentifier: string; error: string }>;
  mappings?: AccountMapping[];
}

export interface SourceParseSummary {
  duplicates: Array<{ input: string; username: string; reason: 'input' | 'existing' }>;
  invalid: Array<{ input: string; normalized?: string; reason: string }>;
}

export interface MappingFormState {
  owner: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl: string;
  groupName: string;
  groupEmoji: string;
  postingPolicy: PostingPolicy;
  profileManagement: ProfileManagementPolicy;
  aiOverrides: DestinationAIOverrides;
}
