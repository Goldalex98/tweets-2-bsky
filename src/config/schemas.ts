export const CURRENT_CONFIG_SCHEMA_VERSION = 8;

export type DefaultInitialImportMode = 'new-only' | 'recent';
export type InitialImportMode = 'inherit' | DefaultInitialImportMode;

export interface TwitterConfig {
  authToken: string;
  ct0: string;
  backupAuthToken?: string;
  backupCt0?: string;
}

export interface UserPermissions {
  viewAllMappings: boolean;
  manageOwnMappings: boolean;
  manageAllMappings: boolean;
  manageGroups: boolean;
  queueBackfills: boolean;
  runNow: boolean;
  reevaluateQueuePolicies: boolean;
}

export type UserRole = 'admin' | 'user';

export interface WebUser {
  id: string;
  username?: string;
  email?: string;
  passwordHash: string;
  /** Incrementing this value immediately invalidates every previously issued JWT. */
  tokenVersion: number;
  role: UserRole;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
}

export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'custom';
export type AIOverrideMode = 'inherit' | 'enabled' | 'disabled';
export type AITextCapability = 'translation' | 'summarization' | 'cleanup' | 'hashtags';

export interface AITextCapabilityConfig {
  enabled: boolean;
  purpose: AITextCapability;
  privacyDescription: string;
}

export interface AIConfig {
  enabled: boolean;
  purpose: 'image-alt-text';
  provider: AIProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxAltTextChars: number;
  privacyDescription: string;
  textCapabilities: Record<AITextCapability, AITextCapabilityConfig>;
}

export interface DestinationAIOverrides {
  imageAltText: AIOverrideMode;
  textCapabilities: Record<AITextCapability, AIOverrideMode>;
}

export interface SchedulerConfig {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
}

export type NotificationEvent =
  | 'twitter-auth-failure'
  | 'bsky-auth-failure'
  | 'queue-parked'
  | 'queue-age'
  | 'update-failure';

export interface NotificationConfig {
  enabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  allowPrivate: boolean;
  events: Record<NotificationEvent, boolean>;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
}

export type AttributionMode = 'never' | 'multiple-sources' | 'always';

export interface AttributionPolicy {
  mode: AttributionMode;
  template: string;
  rootPostsOnly: boolean;
  linkSource: boolean;
}

export interface PostingPolicy {
  attribution: AttributionPolicy;
  appendOriginalPostLink: boolean;
}

export type SyncMode = 'off' | 'manual' | 'scheduled';

export interface ProfileFieldPolicy {
  displayName: boolean;
  description: boolean;
  avatar: boolean;
  banner: boolean;
}

export interface ProfileSyncPolicy {
  mode: SyncMode;
  sourceUsername?: string;
  intervalHours: number;
  fields: ProfileFieldPolicy;
}

export interface PinSyncPolicy {
  mode: SyncMode;
  sourceUsername?: string;
  intervalHours: number;
}

export interface ProfileManagementPolicy {
  allowProfileMutation: boolean;
  ensureBotLabel: boolean;
  ensureDisplayNameBotSuffix: boolean;
  profileSync: ProfileSyncPolicy;
  pinSync: PinSyncPolicy;
}

export type KnownDisplayNameSuffix = 'bot' | 'unofficial';

export interface MappingMigrationReview {
  needsAdminReview: boolean;
  migratedFromSchemaVersion: number;
  notices: string[];
  priorProfileSyncSourceUsername?: string;
  knownBotLabelApplied?: boolean;
  knownDisplayNameSuffix?: KnownDisplayNameSuffix;
  reviewedAt?: string;
}

export interface AccountMapping {
  id: string;
  twitterUsernames: string[];
  pausedTwitterUsernames?: string[];
  /** Linked managed Bluesky account projected from the destination. */
  bskyAccountId?: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
  /**
   * Immutable queue/history identity projected from the destination.
   * Prefer `resolveDestinationStorageKey` over recomputing from DID/handle.
   */
  storageKey?: string;
  enabled: boolean;
  owner?: string;
  groupName?: string;
  groupEmoji?: string;
  createdByUserId?: string;
  postingPolicy: PostingPolicy;
  aiOverrides: DestinationAIOverrides;
  moderationPolicy: ModerationPolicy;
  duplicateSuppression: DuplicateSuppressionPolicy;
  profileManagement: ProfileManagementPolicy;
  migrationReview?: MappingMigrationReview;

  // Transitional compatibility fields remain serialized until Phase 2 moves
  // all runtime mutation decisions to the nested policy model.
  profileSyncSourceUsername?: string;
  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  lastPinnedTweetId?: string;
  lastPinSyncAt?: string;
  hasBotLabel?: boolean;

  /**
   * Runtime-only compatibility data. This is projected from canonical routes
   * and is deliberately omitted from persisted configuration.
   */
  routeIdsByUsername?: Record<string, string>;

  /**
   * Runtime-only compatibility data. `pausedTwitterUsernames` folds a globally
   * disabled source into the paused view, so the route-scoped pause state is
   * projected separately to keep the two distinct across round-trips.
   */
  routePausedUsernames?: string[];

  /**
   * Runtime-only compatibility data used to seed newly projected routes.
   * Existing canonical routes always retain their persisted mode.
   */
  initialImportModesByUsername?: Record<string, InitialImportMode>;
}

export interface AccountGroup {
  name: string;
  emoji?: string;
}

export interface SourceRuntimeState {
  lastCheckAt?: string;
  lastFetchedAt?: string;
  lastSuccessfulFetchAt?: string;
  lastTweetSeenId?: string;
  lastTweetSeenAt?: string;
  lastErrorAt?: string;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  consecutiveFailures: number;
  nextEligibleCheckAt?: string;
}

export type SensitiveContentPolicy = 'mirror' | 'skip';

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
  sensitiveContent: SensitiveContentPolicy;
}

export type SourceScheduleMode = 'adaptive' | 'fixed' | 'inherit';

export interface SourceSchedulePolicy {
  mode: SourceScheduleMode;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  fixedIntervalMinutes: number;
  timezone: string;
}

export type RoutingContentType = 'original' | 'reply' | 'quote' | 'repost';
export type RoutingMediaType = 'none' | 'image' | 'video' | 'gif';

export interface RoutingPolicy {
  includeKeywords: string[];
  excludeKeywords: string[];
  includeDomains: string[];
  excludeDomains: string[];
  contentTypes: RoutingContentType[];
  mediaTypes: RoutingMediaType[];
  languages: string[];
  timezone: string;
  allowedHours: number[];
}

export interface ModerationPolicy {
  blockKeywords: string[];
  blockDomains: string[];
  blockSourceUsernames: string[];
  sensitiveContent: 'allow' | 'block' | 'warn';
  dryRun: boolean;
}

export interface DuplicateSuppressionPolicy {
  enabled: boolean;
  windowHours: number;
  perceptualImageHash: boolean;
}

export interface Source {
  id: string;
  type: 'x' | 'webhook' | 'api';
  /** Human-readable source handle. For X this is the canonical username. */
  username: string;
  name?: string;
  enabled: boolean;
  filters: SourceFilterPolicy;
  schedule: SourceSchedulePolicy;
  state: SourceRuntimeState;
  createdAt?: string;
  updatedAt?: string;
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

export interface DestinationMetadata {
  legacyMappingIds: string[];
  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  lastPinnedTweetId?: string;
  lastPinSyncAt?: string;
  hasBotLabel?: boolean;
}

export interface BlueskyAccountMetadata {
  legacyDestinationIds?: string[];
}

/**
 * Managed Bluesky posting identity. Linked from destinations via `bskyAccountId`
 * (at most one destination per account).
 */
export interface BlueskyAccount {
  id: string;
  label?: string;
  serviceUrl: string;
  loginIdentifier: string;
  appPassword: string;
  did?: string;
  canonicalHandle?: string;
  /** Dashboard user who created the account (ownership for non-admin mutators). */
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: BlueskyAccountMetadata;
}

export interface Destination {
  id: string;
  enabled: boolean;
  /**
   * Linked managed Bluesky account. Source of truth for posting credentials
   * after schema v7. Optional only for pre-migration legacy configs.
   */
  bskyAccountId?: string;
  bskyIdentifier: string;
  /**
   * Pre-v7 legacy inline credential. Removed by migrateV6ToV7 once the
   * destination is linked to a Bluesky account.
   */
  bskyPassword?: string;
  bskyServiceUrl: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
  /**
   * Immutable queue/history identity retained across handle or DID changes.
   */
  storageKey: string;
  owner?: string;
  groupName?: string;
  groupEmoji?: string;
  createdByUserId?: string;
  postingPolicy: PostingPolicy;
  aiOverrides: DestinationAIOverrides;
  moderationPolicy: ModerationPolicy;
  duplicateSuppression: DuplicateSuppressionPolicy;
  profileManagement: ProfileManagementPolicy;
  migrationReview?: MappingMigrationReview;
  metadata: DestinationMetadata;
}

export interface RouteRelationshipSettings {
  sourcePaused: boolean;
  profileSyncSource: boolean;
  pinSyncSource: boolean;
}

export interface RouteMetadata {
  legacyMappingIds: string[];
}

export interface Route {
  id: string;
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  initialImportMode: InitialImportMode;
  filters: SourceFilterPolicy;
  routingPolicy: RoutingPolicy;
  moderationPolicy: ModerationPolicy;
  duplicateSuppression: DuplicateSuppressionPolicy;
  /** Defaults to immediate for pre-v6 in-memory callers. Persisted config is normalized. */
  delivery?: RouteDeliveryPolicy;
  relationship: RouteRelationshipSettings;
  metadata: RouteMetadata;
}

export interface ConfigRollbackMetadata {
  backupSuffix:
    | '.pre-v3-backup'
    | '.pre-v4-backup'
    | '.pre-v5-backup'
    | '.pre-v6-backup'
    | '.pre-v7-backup'
    | '.pre-v8-backup';
  instructions: string[];
}

export interface ConfigMigrationMetadata {
  migratedFromVersion: number;
  migratedAt: string;
  rollback: ConfigRollbackMetadata;
}

export interface AppConfig {
  schemaVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  /**
   * Monotonically increasing optimistic-concurrency token. Clients must send
   * the value they last read when changing configuration-backed resources.
   */
  revision: number;
  /** ISO timestamp of the most recent successful configuration write. */
  updatedAt: string;
  twitter: TwitterConfig;
  defaultInitialImportMode: DefaultInitialImportMode;
  sources: Source[];
  destinations: Destination[];
  routes: Route[];
  /** Managed Bluesky accounts linked by destination `bskyAccountId`. */
  blueskyAccounts: BlueskyAccount[];
  /**
   * One-release compatibility projection for the existing API/CLI/UI. Config
   * persistence and exports remove this field and write only canonical
   * sources, destinations, and routes.
   */
  mappings: AccountMapping[];
  groups: AccountGroup[];
  users: WebUser[];
  scheduler: SchedulerConfig;
  notifications: NotificationConfig;
  geminiApiKey?: string;
  ai: AIConfig;
  migration?: ConfigMigrationMetadata;
}

export type CanonicalAppConfig = Omit<AppConfig, 'mappings'>;
