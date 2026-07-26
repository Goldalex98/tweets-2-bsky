import { execSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import {
  addDestinationSources,
  applyBlueskyAccountLink,
  applyValidatedDestinationIdentity,
  findDuplicateActiveDestination,
  getSourceDependencies,
  removeDestinationSource,
  setDestinationSourcePaused,
} from './aggregate-destination.js';
import {
  applyRestoreBundle,
  createBackupBundle,
  getBackupStorageStatus,
  isRestoreRestartRequired,
  validateBackupBundle,
} from './backup-service.js';
import { assertProductionEncryptionConfigured } from './secret-storage.js';
import { clearCachedAgent, deleteAllPosts } from './bsky.js';
import { previewTextCapability, testAIProvider } from './ai-manager.js';
import { contentSha256 } from './content-dedup.js';
import { contentPolicyMetadataForPost, evaluateContentPolicy } from './content-policy.js';
import {
  createValidatedBlueskyAccount,
  deleteBlueskyAccount,
  getBlueskyAccountView,
  listBlueskyAccountViews,
  rotateBlueskyAccountCredentials,
  validateExistingBlueskyAccount,
} from './services/bluesky-account-service.js';
import {
  applyValidatedAccountIdentity,
  canMutateBlueskyAccount,
  createBlueskyAccount,
  findBlueskyAccount,
  findBlueskyAccountByIdentity,
  findDestinationForAccount,
} from './config/bluesky-accounts.js';
import { createBlueskyAccountsRouter } from './routes/bluesky-accounts-router.js';
import { createBulkDestinationsRouter } from './routes/bulk-destinations-router.js';
import {
  ADMIN_USER_PERMISSIONS,
  type AccountMapping,
  type AITextCapability,
  type AppConfig,
  type BlueskyAccount,
  type DuplicateSuppressionPolicy,
  type ModerationPolicy,
  type PostingPolicy,
  type ProfileFieldPolicy,
  type ProfileManagementPolicy,
  type RouteDeliveryPolicy,
  type RoutingPolicy,
  type SourceFilterPolicy,
  type SourceSchedulePolicy,
  type UserPermissions,
  type UserRole,
  type WebUser,
  createConfigExport,
  createDefaultMappingPolicies,
  findDestinationByLegacyId,
  getConfig,
  getConfigMigrationReport,
  getConfigVersion,
  getDefaultUserPermissions,
  mergeImportedConfig,
  saveConfig,
  saveCanonicalConfig,
  normalizeSourceFilters,
  normalizeSourceSchedule,
  normalizeDuplicateSuppression,
  normalizeAiOverrides,
  normalizeModerationPolicy,
  normalizeRoutingPolicy,
  normalizeRouteDelivery,
} from './config-manager.js';
import {
  rejectMissingOrStaleConfigRevision,
  rejectStaleConfigMutation,
  sendConfigConflictIfStale,
} from './http-concurrency.js';
import {
  authRuntimeStateService,
  blueskyAccountRuntimeService,
  databaseHealthService,
  dbService,
  duplicateFingerprintService,
  digestEntryService,
  digestJobService,
  ingestionAuditService,
  ingestionCredentialService,
  ingestionReplayService,
  policyOverrideAuditService,
  postQueueService,
  runtimeStateService,
  webhookDeliveryService,
} from './db.js';
import type { ProcessedTweet } from './db.js';
import {
  applyProfileMirrorSyncState,
  bridgeBlueskyAccountToFediverse,
  ensureBlueskyBotSelfLabel,
  ensureBlueskyDisplayNameBotSuffix,
  fetchTwitterMirrorProfile,
  syncBlueskyProfileFromTwitter,
  validateBlueskyCredentials,
} from './profile-mirror.js';
import {
  getActiveTwitterUsernames,
  historyIdentityKeys,
  normalizeTwitterUsername,
  parseTwitterUsernameInput,
  resolveDestinationStorageKey,
  resolveProfileSyncSourceUsername,
} from './mapping-helpers.js';
import { applyPostingPolicy, validateAttributionTemplate } from './post-transform.js';
import { assertProfileMutationAllowed, evaluateProfileMutation } from './profile-policy.js';
import { evaluateSourceFilter } from './source-filter.js';
import {
  createSchedulerCommandState,
  getSchedulerCommandsSince as readSchedulerCommandsSince,
  issueSchedulerCommand,
} from './scheduler-command.js';
import {
  getNextCheckTimestamp,
  getSchedulerIntervalMinutes,
  parseSchedulerIntervalMinutes,
} from './scheduler-timing.js';
import { JWT_SECRET_FILE_PATH, UPDATE_LOG_DIR } from './storage-paths.js';
import { metricsService } from './metrics.js';
import { combinePerceptualHashes, computePerceptualHashes } from './media-dedup.js';
import { sanitizeForDiagnostics } from './observability.js';
import { notifyOperationsEvent } from './notification-service.js';
import {
  applySecurityHeaders,
  createRateLimiter,
  noStore,
  requireJsonObject,
  safeEqual,
  sanitizeErrorMessage,
  sendSafeError,
} from './http-security.js';
import { validateWebhookTarget } from './webhook.js';
import {
  createPolicySnapshot,
  diffPolicySnapshots,
  parsePolicySnapshot,
  POLICY_SNAPSHOT_VERSION,
  serializePolicySnapshot,
} from './policy-snapshot.js';
import { parseRetainedCandidate } from './retained-candidate.js';
import {
  hashAuditValue,
  INGESTION_TIMESTAMP_WINDOW_MS,
  verifyIngestionHmac,
} from './ingestion-security.js';
import { routeNormalizedPost } from './ingestion.js';
import { queuedPostForPolicyEvaluation, validateNormalizedPost } from './normalized-post.js';
import {
  DEFAULT_DUPLICATE_SUPPRESSION,
  DEFAULT_MODERATION_POLICY,
  DEFAULT_ROUTE_DELIVERY,
  DEFAULT_ROUTING_POLICY,
  DEFAULT_SOURCE_FILTERS,
  DEFAULT_SOURCE_SCHEDULE,
} from './config/defaults.js';
import { nextDigestRun, buildDigestPreview } from './digest.js';
import { buildSchedulerSettingsResponse, createSettingsRouter } from './routes/settings-router.js';
import { createBackupRouter } from './routes/backup-router.js';
import { createDigestRouter } from './routes/digest-router.js';
import { createIngestionAdminRouter } from './routes/ingestion-admin-router.js';
import { createQueueControlRouter } from './routes/queue-control-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = (process.env.HOST || process.env.BIND_HOST || '0.0.0.0').trim() || '0.0.0.0';
const APP_ROOT_DIR = path.join(__dirname, '..');
const jwtSecretFromEnv = process.env.JWT_SECRET?.trim();
const JWT_EXPIRES_IN = ((process.env.JWT_EXPIRES_IN || '7d').trim() || '7d') as SignOptions['expiresIn'];
const WEB_DIST_DIR = path.join(APP_ROOT_DIR, 'web', 'dist');
const LEGACY_PUBLIC_DIR = path.join(APP_ROOT_DIR, 'public');
const PACKAGE_JSON_PATH = path.join(APP_ROOT_DIR, 'package.json');
const UPDATE_SCRIPT_PATH = path.join(APP_ROOT_DIR, 'update.sh');
const staticAssetsDir = fs.existsSync(path.join(WEB_DIST_DIR, 'index.html')) ? WEB_DIST_DIR : LEGACY_PUBLIC_DIR;
const BSKY_APPVIEW_URL = process.env.BSKY_APPVIEW_URL || 'https://public.api.bsky.app';
const POST_VIEW_CACHE_TTL_MS = 60_000;
const PROFILE_CACHE_TTL_MS = 5 * 60_000;
const RESERVED_UNGROUPED_KEY = 'ungrouped';
const SERVER_STARTED_AT = Date.now();
const PASSWORD_MIN_LENGTH = 12;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
// In-process only: each replica has its own counter. Tighten at the reverse proxy for multi-instance deploys.
const AUTH_RATE_MAX_ATTEMPTS = 10;
const AUTH_COOKIE_NAME = 't2b_session';
const CSRF_COOKIE_NAME = 't2b_csrf';
const DEFAULT_BODY_LIMIT = '128kb';
const IMPORT_BODY_LIMIT = '2mb';
const RESTORE_BODY_LIMIT = '110mb';
const APPVIEW_POST_CHUNK_SIZE = 10;
const APPVIEW_PROFILE_CHUNK_SIZE = 25;
const APPVIEW_MAX_ATTEMPTS = 2;
const APPVIEW_RETRY_DELAY_MS = 700;
const FEDIVERSE_BRIDGE_STATUS_CHUNK_SIZE = 2;
const FEDIVERSE_BRIDGE_STATUS_CACHE_TTL_MS = 10 * 60_000;
const FEDIVERSE_BRIDGE_HANDLES = ['ap.brid.gy', 'bsky.brid.gy'];

const MINIMUM_JWT_SECRET_LENGTH = 32;

function loadPersistedJwtSecret(): string | undefined {
  if (!fs.existsSync(JWT_SECRET_FILE_PATH)) {
    return undefined;
  }

  try {
    const secret = fs.readFileSync(JWT_SECRET_FILE_PATH, 'utf8').trim();
    if (secret.length >= MINIMUM_JWT_SECRET_LENGTH) {
      return secret;
    }
    console.warn(`⚠️ Ignoring weak JWT secret in ${JWT_SECRET_FILE_PATH}. Regenerating.`);
    return undefined;
  } catch (error) {
    console.warn(
      `⚠️ Failed reading JWT secret file at ${JWT_SECRET_FILE_PATH}: ${(error as Error).message}. Regenerating.`,
    );
    return undefined;
  }
}

function persistJwtSecret(secret: string): void {
  fs.mkdirSync(path.dirname(JWT_SECRET_FILE_PATH), { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE_PATH, `${secret}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(JWT_SECRET_FILE_PATH, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function resolveJwtSecret(): string {
  if (jwtSecretFromEnv) {
    if (jwtSecretFromEnv.length < MINIMUM_JWT_SECRET_LENGTH) {
      // A guessable signing key lets an attacker mint sessions for any account,
      // so production refuses to start rather than degrading to a log warning.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          `JWT_SECRET must be at least ${MINIMUM_JWT_SECRET_LENGTH} characters. Generate one with "openssl rand -hex 32", or unset JWT_SECRET to use the generated secret at ${JWT_SECRET_FILE_PATH}.`,
        );
      }
      console.warn(
        `⚠️ JWT_SECRET is shorter than ${MINIMUM_JWT_SECRET_LENGTH} characters. This is rejected when NODE_ENV=production.`,
      );
    }
    return jwtSecretFromEnv;
  }

  const persisted = loadPersistedJwtSecret();
  if (persisted) {
    return persisted;
  }

  const generated = randomBytes(48).toString('hex');
  persistJwtSecret(generated);
  console.warn(
    `⚠️ JWT_SECRET not set. Generated persistent signing secret at ${JWT_SECRET_FILE_PATH}. Keep this file private.`,
  );
  return generated;
}

const JWT_SECRET = resolveJwtSecret();
assertProductionEncryptionConfigured();

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface BskyProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  banner?: string;
  description?: string;
  createdAt?: string;
}

interface FediverseBridgeStatusView {
  bridged: boolean;
  checkedAt: string;
  error?: string;
}

interface EnrichedPostMedia {
  type: 'image' | 'video' | 'external';
  url?: string;
  thumb?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
}

interface EnrichedPost {
  bskyUri: string;
  bskyCid?: string;
  bskyIdentifier: string;
  twitterId: string;
  twitterUsername: string;
  twitterUrl?: string;
  postUrl?: string;
  createdAt?: string;
  text: string;
  facets: unknown[];
  author: {
    did?: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  stats: {
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    engagement: number;
  };
  media: EnrichedPostMedia[];
}

interface AppViewEmbedImage {
  fullsize?: string;
  thumb?: string;
  alt?: string;
  aspectRatio?: { width?: number; height?: number };
}

interface AppViewEmbed {
  $type?: string;
  images?: AppViewEmbedImage[];
  playlist?: string;
  thumbnail?: string;
  alt?: string;
  aspectRatio?: { width?: number; height?: number };
  external?: {
    uri?: string;
    thumb?: string;
    title?: string;
    description?: string;
  };
  media?: AppViewEmbed;
}

interface AppViewPost {
  uri?: string;
  cid?: string;
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  record?: {
    createdAt?: string;
    text?: string;
    facets?: unknown[];
  };
  author?: BskyProfileView;
  embed?: AppViewEmbed;
}

interface AppViewGetPostsResponse {
  posts?: AppViewPost[];
}

interface AppViewGetProfilesResponse {
  profiles?: Array<Record<string, unknown>>;
}

interface AppViewGetFollowsResponse {
  follows?: Array<{ handle?: string; did?: string }>;
  cursor?: string;
}

interface LocalPostSearchResult {
  twitterId: string;
  twitterUsername: string;
  bskyIdentifier: string;
  tweetText?: string;
  bskyUri?: string;
  bskyCid?: string;
  createdAt?: string;
  postUrl?: string;
  twitterUrl?: string;
  score: number;
}

interface RuntimeVersionInfo {
  version: string;
  commit?: string;
  branch?: string;
  startedAt: number;
}

interface UpdateJobState {
  running: boolean;
  pid?: number;
  startedAt?: number;
  startedBy?: string;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logFile?: string;
}

interface UpdateStatusPayload {
  running: boolean;
  pid?: number;
  startedAt?: number;
  startedBy?: string;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logFile?: string;
  logTail: string[];
}

const postViewCache = new Map<string, CacheEntry<AppViewPost>>();
const profileCache = new Map<string, CacheEntry<BskyProfileView>>();
const fediverseBridgeStatusCache = new Map<string, CacheEntry<FediverseBridgeStatusView>>();
let fediverseBridgeActorIdsCache: CacheEntry<Set<string>> | null = null;

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function nowMs() {
  return Date.now();
}

const parseAllowedOrigins = (): Set<string> => {
  const raw = process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || '';
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(origins);
};

const allowedOrigins = parseAllowedOrigins();

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const authRateBuckets = new Map<string, RateLimitBucket>();

// Only honor X-Forwarded-For when explicitly running behind a trusted reverse
// proxy; otherwise clients could spoof the header to bypass auth rate limiting.
const TRUST_PROXY = ['1', 'true', 'yes'].includes((process.env.TRUST_PROXY || '').trim().toLowerCase());

const getRequestIp = (req: Request): string => {
  if (TRUST_PROXY) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
      const [first] = forwarded.split(',');
      if (first && first.trim().length > 0) {
        return first.trim();
      }
    }
  }
  if (typeof req.ip === 'string' && req.ip.length > 0) {
    return req.ip;
  }
  if (typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress.length > 0) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
};

const authRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const now = nowMs();
  if (authRateBuckets.size > 5000) {
    for (const [bucketKey, bucketValue] of authRateBuckets.entries()) {
      if (bucketValue.resetAt <= now) {
        authRateBuckets.delete(bucketKey);
      }
    }
  }

  const ip = getRequestIp(req);
  const key = `auth:${ip}`;
  const bucket = authRateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    authRateBuckets.set(key, {
      count: 1,
      resetAt: now + AUTH_RATE_WINDOW_MS,
    });
    next();
    return;
  }

  if (bucket.count >= AUTH_RATE_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: `Too many authentication attempts. Try again in about ${retryAfterSeconds} seconds.`,
    });
    return;
  }

  bucket.count += 1;
  authRateBuckets.set(key, bucket);
  next();
};

const credentialRateLimiter = createRateLimiter({
  scope: 'credential',
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: (request) => getRequestIp(request),
});

const importRestoreRateLimiter = createRateLimiter({
  scope: 'import-restore',
  windowMs: 60 * 60 * 1000,
  max: 10,
  key: (request) => getRequestIp(request),
});

const webhookRateLimiter = createRateLimiter({
  scope: 'webhook',
  windowMs: 5 * 60 * 1000,
  max: 15,
  key: (request) => getRequestIp(request),
});

const ingestionRateLimiter = createRateLimiter({
  scope: 'normalized-ingestion',
  windowMs: 60_000,
  max: Number(process.env.INGESTION_RATE_LIMIT_PER_MINUTE) || 120,
  key: (request) => getRequestIp(request),
});

function buildPostUrl(identifier: string, uri?: string): string | undefined {
  if (!uri) return undefined;
  const rkey = uri.split('/').filter(Boolean).pop();
  if (!rkey) return undefined;
  return `https://bsky.app/profile/${identifier}/post/${rkey}`;
}

function buildTwitterPostUrl(username: string, twitterId: string): string | undefined {
  if (!username || !twitterId) return undefined;
  return `https://x.com/${normalizeActor(username)}/status/${twitterId}`;
}

function normalizeActor(actor: string): string {
  return actor.trim().replace(/^@/, '').toLowerCase();
}

function normalizeGroupName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGroupEmoji(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getNormalizedGroupKey(value: unknown): string {
  return normalizeGroupName(value).toLowerCase();
}

function ensureGroupExists(config: AppConfig, name?: string, emoji?: string) {
  const normalizedName = normalizeGroupName(name);
  if (!normalizedName || getNormalizedGroupKey(normalizedName) === RESERVED_UNGROUPED_KEY) return;

  if (!Array.isArray(config.groups)) {
    config.groups = [];
  }

  const existingIndex = config.groups.findIndex(
    (group) => getNormalizedGroupKey(group.name) === getNormalizedGroupKey(normalizedName),
  );
  const normalizedEmoji = normalizeGroupEmoji(emoji);

  if (existingIndex === -1) {
    config.groups.push({
      name: normalizedName,
      ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}),
    });
    return;
  }

  if (normalizedEmoji) {
    const existingGroupName = normalizeGroupName(config.groups[existingIndex]?.name) || normalizedName;
    config.groups[existingIndex] = {
      name: existingGroupName,
      emoji: normalizedEmoji,
    };
  }
}

function safeExec(command: string, cwd = APP_ROOT_DIR): string | undefined {
  try {
    return execSync(command, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

function getRuntimeVersionInfo(): RuntimeVersionInfo {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim().length > 0) {
      version = pkg.version.trim();
    }
  } catch {
    // Ignore parse/read failures and keep fallback.
  }

  return {
    version,
    commit: safeExec('git rev-parse --short HEAD'),
    branch: safeExec('git rev-parse --abbrev-ref HEAD'),
    startedAt: SERVER_STARTED_AT,
  };
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogTail(logFile?: string, maxLines = 30): string[] {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function extractMediaFromEmbed(embed: unknown): EnrichedPostMedia[] {
  if (!embed || typeof embed !== 'object') {
    return [];
  }

  const typedEmbed = embed as AppViewEmbed;
  const type = typedEmbed.$type;
  if (type === 'app.bsky.embed.images#view') {
    const images = Array.isArray(typedEmbed.images) ? typedEmbed.images : [];
    return images.map((image) => ({
      type: 'image' as const,
      url: typeof image.fullsize === 'string' ? image.fullsize : undefined,
      thumb: typeof image.thumb === 'string' ? image.thumb : undefined,
      alt: typeof image.alt === 'string' ? image.alt : undefined,
      width: typeof image.aspectRatio?.width === 'number' ? image.aspectRatio.width : undefined,
      height: typeof image.aspectRatio?.height === 'number' ? image.aspectRatio.height : undefined,
    }));
  }

  if (type === 'app.bsky.embed.video#view') {
    return [
      {
        type: 'video',
        url: typeof typedEmbed.playlist === 'string' ? typedEmbed.playlist : undefined,
        thumb: typeof typedEmbed.thumbnail === 'string' ? typedEmbed.thumbnail : undefined,
        alt: typeof typedEmbed.alt === 'string' ? typedEmbed.alt : undefined,
        width: typeof typedEmbed.aspectRatio?.width === 'number' ? typedEmbed.aspectRatio.width : undefined,
        height: typeof typedEmbed.aspectRatio?.height === 'number' ? typedEmbed.aspectRatio.height : undefined,
      },
    ];
  }

  if (type === 'app.bsky.embed.external#view') {
    const external = typedEmbed.external ?? {};
    return [
      {
        type: 'external',
        url: typeof external.uri === 'string' ? external.uri : undefined,
        thumb: typeof external.thumb === 'string' ? external.thumb : undefined,
        title: typeof external.title === 'string' ? external.title : undefined,
        description: typeof external.description === 'string' ? external.description : undefined,
      },
    ];
  }

  if (type === 'app.bsky.embed.recordWithMedia#view') {
    return extractMediaFromEmbed(typedEmbed.media);
  }

  return [];
}

const RETRYABLE_APPVIEW_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);

function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const details = [error.message];
    const status = error.response?.status;
    const code = error.code;
    const causeCode =
      typeof (error as { cause?: { code?: unknown } }).cause?.code === 'string'
        ? (error as { cause?: { code?: string } }).cause?.code
        : undefined;

    if (typeof status === 'number') {
      details.push(`status=${status}`);
    }
    if (typeof code === 'string') {
      details.push(`code=${code}`);
    }
    if (typeof causeCode === 'string' && causeCode !== code) {
      details.push(`cause=${causeCode}`);
    }
    return details.join(', ');
  }

  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRetryableAppviewError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) {
    return true;
  }

  const code = error.code;
  if (typeof code === 'string' && RETRYABLE_APPVIEW_CODES.has(code)) {
    return true;
  }

  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  if (typeof causeCode === 'string' && RETRYABLE_APPVIEW_CODES.has(causeCode)) {
    return true;
  }

  return false;
}

const sleep = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function fetchAppview<T>(pathname: string, params: URLSearchParams, context: string): Promise<T | null> {
  const url = `${BSKY_APPVIEW_URL}${pathname}?${params.toString()}`;
  for (let attempt = 1; attempt <= APPVIEW_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get<T>(url, { timeout: 12_000 });
      return response.data;
    } catch (error) {
      const retryable = isRetryableAppviewError(error);
      const canRetry = retryable && attempt < APPVIEW_MAX_ATTEMPTS;
      console.warn(
        `[AppView] ${context} failed (attempt ${attempt}/${APPVIEW_MAX_ATTEMPTS}): ${describeAxiosError(error)}${canRetry ? '. Retrying...' : ''}`,
      );
      if (!canRetry) {
        return null;
      }
      await sleep(APPVIEW_RETRY_DELAY_MS * attempt);
    }
  }
  return null;
}

async function fetchPostViewsByUri(uris: string[]): Promise<Map<string, AppViewPost>> {
  const result = new Map<string, AppViewPost>();
  const uniqueUris = [...new Set(uris.filter((uri) => typeof uri === 'string' && uri.length > 0))];
  const pendingUris: string[] = [];

  for (const uri of uniqueUris) {
    const cached = postViewCache.get(uri);
    if (cached && cached.expiresAt > nowMs()) {
      result.set(uri, cached.value);
      continue;
    }
    pendingUris.push(uri);
  }

  for (const chunk of chunkArray(pendingUris, APPVIEW_POST_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const params = new URLSearchParams();
    for (const uri of chunk) params.append('uris', uri);

    const responseData = await fetchAppview<AppViewGetPostsResponse>(
      '/xrpc/app.bsky.feed.getPosts',
      params,
      `getPosts chunk=${chunk.length}`,
    );
    if (!responseData) {
      continue;
    }

    const posts = Array.isArray(responseData.posts) ? responseData.posts : [];
    for (const post of posts) {
      const uri = typeof post?.uri === 'string' ? post.uri : undefined;
      if (!uri) continue;
      postViewCache.set(uri, {
        value: post,
        expiresAt: nowMs() + POST_VIEW_CACHE_TTL_MS,
      });
      result.set(uri, post);
    }
  }

  return result;
}

async function fetchProfilesByActor(actors: string[]): Promise<Record<string, BskyProfileView>> {
  const uniqueActors = [...new Set(actors.map(normalizeActor).filter((actor) => actor.length > 0))];
  const result: Record<string, BskyProfileView> = {};
  const pendingActors: string[] = [];

  for (const actor of uniqueActors) {
    const cached = profileCache.get(actor);
    if (cached && cached.expiresAt > nowMs()) {
      result[actor] = cached.value;
      continue;
    }
    pendingActors.push(actor);
  }

  for (const chunk of chunkArray(pendingActors, APPVIEW_PROFILE_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const params = new URLSearchParams();
    for (const actor of chunk) params.append('actors', actor);

    const responseData = await fetchAppview<AppViewGetProfilesResponse>(
      '/xrpc/app.bsky.actor.getProfiles',
      params,
      `getProfiles chunk=${chunk.length}`,
    );
    if (!responseData) {
      continue;
    }

    const profiles = Array.isArray(responseData.profiles) ? responseData.profiles : [];
    for (const profile of profiles) {
      const view: BskyProfileView = {
        did: typeof profile?.did === 'string' ? profile.did : undefined,
        handle: typeof profile?.handle === 'string' ? profile.handle : undefined,
        displayName: typeof profile?.displayName === 'string' ? profile.displayName : undefined,
        avatar: typeof profile?.avatar === 'string' ? profile.avatar : undefined,
        banner: typeof profile?.banner === 'string' ? profile.banner : undefined,
        description: typeof profile?.description === 'string' ? profile.description : undefined,
        createdAt: typeof profile?.createdAt === 'string' ? profile.createdAt : undefined,
      };

      const keys = [
        typeof view.handle === 'string' ? normalizeActor(view.handle) : '',
        typeof view.did === 'string' ? normalizeActor(view.did) : '',
      ].filter((key) => key.length > 0);

      for (const key of keys) {
        profileCache.set(key, { value: view, expiresAt: nowMs() + PROFILE_CACHE_TTL_MS });
        result[key] = view;
      }
    }
  }

  for (const actor of uniqueActors) {
    const cached = profileCache.get(actor);
    if (cached && cached.expiresAt > nowMs()) {
      result[actor] = cached.value;
    }
  }

  return result;
}

async function getFediverseBridgeActorIds(): Promise<Set<string>> {
  const cached = fediverseBridgeActorIdsCache;
  if (cached && cached.expiresAt > nowMs()) {
    return new Set(cached.value);
  }

  const ids = new Set<string>(FEDIVERSE_BRIDGE_HANDLES.map((handle) => normalizeActor(handle)));
  const profiles = await fetchProfilesByActor(FEDIVERSE_BRIDGE_HANDLES);
  for (const profile of Object.values(profiles)) {
    if (typeof profile?.handle === 'string' && profile.handle.length > 0) {
      ids.add(normalizeActor(profile.handle));
    }
    if (typeof profile?.did === 'string' && profile.did.length > 0) {
      ids.add(normalizeActor(profile.did));
    }
  }

  fediverseBridgeActorIdsCache = {
    value: ids,
    expiresAt: nowMs() + PROFILE_CACHE_TTL_MS,
  };

  return new Set(ids);
}

async function isActorFollowingFediverseBridge(actor: string): Promise<FediverseBridgeStatusView> {
  const normalizedActor = normalizeActor(actor);
  const checkedAt = new Date().toISOString();
  if (!normalizedActor) {
    return {
      bridged: false,
      checkedAt,
      error: 'Missing actor identifier.',
    };
  }

  const bridgeActorIds = await getFediverseBridgeActorIds();
  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < 200) {
    pageCount += 1;
    const params = new URLSearchParams();
    params.set('actor', normalizedActor);
    params.set('limit', '100');
    if (cursor) {
      params.set('cursor', cursor);
    }

    const responseData = await fetchAppview<AppViewGetFollowsResponse>(
      '/xrpc/app.bsky.graph.getFollows',
      params,
      `getFollows actor=${normalizedActor}`,
    );
    if (!responseData) {
      return {
        bridged: false,
        checkedAt,
        error: 'Failed to read follows from Bluesky AppView.',
      };
    }

    const follows = Array.isArray(responseData.follows) ? responseData.follows : [];
    for (const follow of follows) {
      const followedHandle = typeof follow?.handle === 'string' ? normalizeActor(follow.handle) : '';
      const followedDid = typeof follow?.did === 'string' ? normalizeActor(follow.did) : '';
      if ((followedHandle && bridgeActorIds.has(followedHandle)) || (followedDid && bridgeActorIds.has(followedDid))) {
        return {
          bridged: true,
          checkedAt,
        };
      }
    }

    cursor =
      typeof responseData.cursor === 'string' && responseData.cursor.length > 0 ? responseData.cursor : undefined;
    if (!cursor) {
      break;
    }
  }

  return {
    bridged: false,
    checkedAt,
  };
}

async function fetchFediverseBridgeStatusesByActor(
  actors: string[],
): Promise<Record<string, FediverseBridgeStatusView>> {
  const uniqueActors = [...new Set(actors.map(normalizeActor).filter((actor) => actor.length > 0))];
  const result: Record<string, FediverseBridgeStatusView> = {};
  const pendingActors: string[] = [];

  for (const actor of uniqueActors) {
    const cached = fediverseBridgeStatusCache.get(actor);
    if (cached && cached.expiresAt > nowMs()) {
      result[actor] = cached.value;
      continue;
    }
    pendingActors.push(actor);
  }

  for (const chunk of chunkArray(pendingActors, FEDIVERSE_BRIDGE_STATUS_CHUNK_SIZE)) {
    if (chunk.length === 0) {
      continue;
    }

    const chunkResults = await Promise.all(
      chunk.map(async (actor) => {
        try {
          const status = await isActorFollowingFediverseBridge(actor);
          return { actor, status };
        } catch (error) {
          return {
            actor,
            status: {
              bridged: false,
              checkedAt: new Date().toISOString(),
              error: getErrorMessage(error, 'Failed to check fediverse bridge status.'),
            } satisfies FediverseBridgeStatusView,
          };
        }
      }),
    );

    for (const item of chunkResults) {
      fediverseBridgeStatusCache.set(item.actor, {
        value: item.status,
        expiresAt: nowMs() + FEDIVERSE_BRIDGE_STATUS_CACHE_TTL_MS,
      });
      result[item.actor] = item.status;
    }
  }

  return result;
}

function buildEnrichedPost(activity: ProcessedTweet, postView: AppViewPost | undefined): EnrichedPost {
  const record = postView?.record || {};
  const author = postView?.author || {};
  const likes = Number(postView?.likeCount) || 0;
  const reposts = Number(postView?.repostCount) || 0;
  const replies = Number(postView?.replyCount) || 0;
  const quotes = Number(postView?.quoteCount) || 0;

  const identifier =
    (typeof activity.bsky_identifier === 'string' && activity.bsky_identifier.length > 0
      ? activity.bsky_identifier
      : typeof author.handle === 'string'
        ? author.handle
        : 'unknown') || 'unknown';

  return {
    bskyUri: activity.bsky_uri || '',
    bskyCid: typeof postView?.cid === 'string' ? postView.cid : activity.bsky_cid,
    bskyIdentifier: identifier,
    twitterId: activity.twitter_id,
    twitterUsername: activity.twitter_username,
    twitterUrl: buildTwitterPostUrl(activity.twitter_username, activity.twitter_id),
    postUrl: buildPostUrl(identifier, activity.bsky_uri),
    createdAt:
      (typeof record.createdAt === 'string' ? record.createdAt : undefined) ||
      activity.created_at ||
      (typeof postView?.indexedAt === 'string' ? postView.indexedAt : undefined),
    text:
      (typeof record.text === 'string' ? record.text : undefined) ||
      activity.tweet_text ||
      `Tweet ID: ${activity.twitter_id}`,
    facets: Array.isArray(record.facets) ? record.facets : [],
    author: {
      did: typeof author.did === 'string' ? author.did : undefined,
      handle: typeof author.handle === 'string' && author.handle.length > 0 ? author.handle : activity.bsky_identifier,
      displayName: typeof author.displayName === 'string' ? author.displayName : undefined,
      avatar: typeof author.avatar === 'string' ? author.avatar : undefined,
    },
    stats: {
      likes,
      reposts,
      replies,
      quotes,
      engagement: likes + reposts + replies + quotes,
    },
    media: extractMediaFromEmbed(postView?.embed),
  };
}

// In-memory state for triggers and scheduling
let lastCheckTime = (() => {
  const maxSourceCheck = runtimeStateService
    .listSources()
    .reduce((max, state) => Math.max(max, state.lastCheckAt ?? 0), 0);
  return maxSourceCheck > 0 ? maxSourceCheck : 0;
})();
let nextCheckTime = getNextCheckTimestamp(
  lastCheckTime || Date.now(),
  getSchedulerIntervalMinutes(getConfig()),
);
export interface PendingBackfill {
  id: string;
  sourceUsernames?: string[];
  limit?: number;
  queuedAt: number;
  sequence: number;
  requestId: string;
}
let pendingBackfills: PendingBackfill[] = [];
let backfillSequence = 0;
const schedulerCommandState = createSchedulerCommandState();

// Multiple subbranches work in parallel, so a single global status message
// gets clobbered constantly. Each unit of work registers its own job here and
// the dashboard renders the full list.
export type ActiveJobKind = 'checking' | 'mirroring' | 'backfilling' | 'profile-sync' | 'pin-sync';

export interface ActiveJob {
  id: string;
  kind: ActiveJobKind;
  account?: string;
  target?: string;
  mappingId?: string;
  message?: string;
  processedCount?: number;
  totalCount?: number;
  startedAt: number;
  updatedAt: number;
}

const activeJobs = new Map<string, ActiveJob>();
const JOB_STALE_MS = 30 * 60 * 1000;

export function updateJob(id: string, patch: Partial<Omit<ActiveJob, 'id' | 'startedAt' | 'updatedAt'>> | null): void {
  if (patch === null) {
    activeJobs.delete(id);
    return;
  }
  const existing = activeJobs.get(id);
  activeJobs.set(id, {
    kind: 'checking',
    ...existing,
    ...patch,
    id,
    startedAt: existing?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

function getActiveJobsSnapshot(): ActiveJob[] {
  const now = Date.now();
  for (const [id, job] of activeJobs) {
    // A crashed/abandoned task should not leave a ghost job on the dashboard.
    if (now - job.updatedAt > JOB_STALE_MS) activeJobs.delete(id);
  }
  return [...activeJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export interface PendingPinSync {
  id: string;
  queuedAt: number;
  requestId: string;
  sourceUsername?: string;
}
let pendingPinSyncs: PendingPinSync[] = [];

export const getPendingPinSyncs = (): PendingPinSync[] => [...pendingPinSyncs];

export const clearPinSync = (id: string): void => {
  pendingPinSyncs = pendingPinSyncs.filter((entry) => entry.id !== id);
};

interface AppStatus {
  state: 'idle' | 'checking' | 'backfilling' | 'pacing' | 'processing';
  currentAccount?: string;
  processedCount?: number;
  totalCount?: number;
  message?: string;
  backfillMappingId?: string;
  backfillRequestId?: string;
  lastUpdate: number;
}

let currentAppStatus: AppStatus = {
  state: 'idle',
  lastUpdate: Date.now(),
};

let updateJobState: UpdateJobState = {
  running: false,
};

function signalSchedulerWake(
  kind: 'run-now' | 'reschedule' | 'backfill' | 'pin-sync' = 'reschedule',
  mappingId?: string,
): void {
  issueSchedulerCommand(schedulerCommandState, kind, { mappingId });
}

function requestImmediateSchedulerPass(): void {
  signalSchedulerWake('run-now');
}

app.set('trust proxy', TRUST_PROXY ? 1 : false);
app.disable('x-powered-by');
app.use(applySecurityHeaders);
app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      // Requests without Origin include same-origin server calls, health probes,
      // CLI clients, and test automation. Cross-origin browser access is
      // denied unless explicitly configured.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
  }),
);
app.use('/api/config/import', express.json({ limit: IMPORT_BODY_LIMIT }));
app.use('/api/backup/restore', express.json({ limit: RESTORE_BODY_LIMIT }));
app.use(
  '/api/ingest',
  express.json({
    limit: process.env.INGESTION_BODY_LIMIT || '128kb',
    verify: (request: IngestionRequest, _response: Response, buffer: Buffer) => {
      request.rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
app.use(
  [
    '/api/config',
    '/api/backup',
    '/api/auth',
    '/api/login',
    '/api/register',
    '/api/logout',
    '/api/me',
    '/api/twitter-config',
    '/api/ai-config',
    '/api/settings/notifications',
    '/api/metrics',
  ],
  noStore,
);
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationReq = req as CorrelationRequest;
  const supplied = correlationReq.get('x-correlation-id');
  correlationReq.correlationId =
    typeof supplied === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied)
      ? supplied
      : `request-${randomUUID()}`;
  res.setHeader('x-correlation-id', correlationReq.correlationId);
  next();
});

// After restore apply, config is live but SQLite swap waits for restart. Block
// mutating APIs so workers cannot run new config against the old database.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/api')) {
    next();
    return;
  }
  if (!isRestoreRestartRequired()) {
    next();
    return;
  }
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  if (method === 'POST' && (req.path === '/api/logout' || req.path === '/api/login')) {
    next();
    return;
  }
  res.status(503).json({
    error: {
      code: 'RESTART_REQUIRED',
      message:
        'A database restore is pending. Restart the service to finish applying it before making changes.',
    },
  });
});

const getPublicHealth = () => {
  const database = databaseHealthService.check();
  let scheduler: 'running' | 'disabled' | 'error' = 'error';
  try {
    scheduler = getConfig().scheduler.enabled ? 'running' : 'disabled';
  } catch {
    scheduler = 'error';
  }
  const restartRequired = isRestoreRestartRequired();
  return {
    status: database.status === 'ok' && scheduler !== 'error' ? ('ok' as const) : ('error' as const),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - SERVER_STARTED_AT) / 1000)),
    database: database.status,
    scheduler,
    restartRequired,
  };
};

app.get('/healthz', (_req, res) => {
  const health = getPublicHealth();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.get('/readyz', (_req, res) => {
  const health = getPublicHealth();
  const ready = health.status === 'ok' && !health.restartRequired;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    database: health.database,
    scheduler: health.scheduler,
    restartRequired: health.restartRequired,
  });
});

app.use(
  express.static(staticAssetsDir, {
    index: false,
  }),
);

interface AuthenticatedUser {
  id: string;
  username?: string;
  email?: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

type AuthedRequest = Omit<Request, 'params'> & {
  user: AuthenticatedUser;
  authMode?: 'bearer' | 'cookie';
  params: Record<string, string>;
};

type CorrelationRequest = Request & {
  correlationId: string;
};

type IngestionRequest = Request & {
  rawBody?: Buffer;
};

type AuthedRouteHandler = (req: AuthedRequest, res: Response) => void | Promise<void>;

const asAuthedHandler = (handler: AuthedRouteHandler): RequestHandler =>
  handler as unknown as RequestHandler;

interface MappingResponse extends Omit<AccountMapping, 'bskyPassword'> {
  revision: number;
  updatedAt: string;
  destinationState: 'enabled' | 'paused';
  sourceCount: number;
  activeSourceCount: number;
  credentialConfigured: boolean;
  blueskyAccount?: {
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
  };
  sources: Array<{
    username: string;
    routeId?: string;
    state: 'enabled' | 'paused';
    filters?: SourceFilterPolicy;
    routingPolicy?: RoutingPolicy;
    moderationPolicy?: ModerationPolicy;
    duplicateSuppression?: DuplicateSuppressionPolicy;
    delivery?: RouteDeliveryPolicy;
    schedule?: SourceSchedulePolicy;
    runtime?: ReturnType<typeof runtimeStateService.getSource>;
  }>;
  runtime: ReturnType<typeof runtimeStateService.getDestination>;
  queue: ReturnType<typeof postQueueService.getCounts>['perMapping'][number] | null;
  createdByLabel?: string;
  createdByUser?: {
    id: string;
    username?: string;
    email?: string;
    role: UserRole;
  };
}

interface UserSummaryResponse {
  id: string;
  username?: string;
  email?: string;
  role: UserRole;
  isAdmin: boolean;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  mappingCount: number;
  activeMappingCount: number;
  mappings: MappingResponse[];
}

const normalizeEmail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeUsername = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/^@/, '').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const routeParam = (value: string | undefined): string | undefined => normalizeOptionalString(value);

const getErrorMessage = (error: unknown, fallback = 'Request failed.'): string => {
  if (axios.isAxiosError(error)) {
    const apiError = error.response?.data as { error?: unknown } | undefined;
    if (typeof apiError?.error === 'string' && apiError.error.length > 0) {
      return apiError.error;
    }
    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
};

const EMAIL_LIKE_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;

const getUserPublicLabel = (user: Pick<WebUser, 'id' | 'username'>): string =>
  user.username || `user-${user.id.slice(0, 8)}`;

const getUserDisplayLabel = (user: Pick<WebUser, 'id' | 'username' | 'email'>): string =>
  user.username || user.email || `user-${user.id.slice(0, 8)}`;

const getActorLabel = (actor: AuthenticatedUser): string =>
  actor.username || actor.email || `user-${actor.id.slice(0, 8)}`;

const getActorPublicLabel = (actor: AuthenticatedUser): string => actor.username || `user-${actor.id.slice(0, 8)}`;

const sanitizeLabelForRequester = (label: string | undefined, requester: AuthenticatedUser): string | undefined => {
  if (!label) {
    return undefined;
  }
  if (requester.isAdmin) {
    return label;
  }
  return EMAIL_LIKE_PATTERN.test(label) ? 'private-user' : label;
};

const createUserLookupById = (config: AppConfig): Map<string, WebUser> =>
  new Map(config.users.map((user) => [user.id, user]));

const toAuthenticatedUser = (user: WebUser): AuthenticatedUser => ({
  id: user.id,
  username: user.username,
  email: user.email,
  isAdmin: user.role === 'admin',
  permissions:
    user.role === 'admin'
      ? { ...ADMIN_USER_PERMISSIONS }
      : {
          ...getDefaultUserPermissions('user'),
          ...user.permissions,
        },
});

const serializeAuthenticatedUser = (user: AuthenticatedUser) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  isAdmin: user.isAdmin,
  permissions: user.permissions,
});

const issueTokenForUser = (user: WebUser): string =>
  jwt.sign(
    {
      userId: user.id,
      email: user.email,
      username: user.username,
      tokenVersion: user.tokenVersion,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );

const parseCookies = (request: Request): Record<string, string> => {
  const header = request.headers?.cookie;
  if (typeof header !== 'string') return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return cookies;
};

const cookieSecureForRequest = (request: Request): boolean => request.secure === true;

const serializeCookie = (
  name: string,
  value: string,
  options: { httpOnly?: boolean; secure?: boolean; maxAge?: number } = {},
): string => {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (options.httpOnly) attributes.push('HttpOnly');
  if (options.secure) attributes.push('Secure');
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return attributes.join('; ');
};

const setAuthenticationCookies = (request: Request, response: Response, token: string): string => {
  const csrfToken = randomBytes(32).toString('base64url');
  const secure = cookieSecureForRequest(request);
  response.setHeader('Set-Cookie', [
    serializeCookie(AUTH_COOKIE_NAME, token, { httpOnly: true, secure }),
    serializeCookie(CSRF_COOKIE_NAME, csrfToken, { secure }),
  ]);
  return csrfToken;
};

const clearAuthenticationCookies = (request: Request, response: Response): void => {
  const secure = cookieSecureForRequest(request);
  response.setHeader('Set-Cookie', [
    serializeCookie(AUTH_COOKIE_NAME, '', { httpOnly: true, secure, maxAge: 0 }),
    serializeCookie(CSRF_COOKIE_NAME, '', { secure, maxAge: 0 }),
  ]);
};

const getBearerToken = (request: Request): string | undefined => {
  const header = request.headers?.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
};

const mutationRequiresCsrf = (request: Request): boolean =>
  !['GET', 'HEAD', 'OPTIONS'].includes(String(request.method || '').toUpperCase());

const findUserByIdentifier = (config: AppConfig, identifier: string): WebUser | undefined => {
  const normalizedEmail = normalizeEmail(identifier);
  if (normalizedEmail) {
    const foundByEmail = config.users.find((user) => normalizeEmail(user.email) === normalizedEmail);
    if (foundByEmail) {
      return foundByEmail;
    }
  }

  const normalizedUsername = normalizeUsername(identifier);
  if (!normalizedUsername) {
    return undefined;
  }
  return config.users.find((user) => normalizeUsername(user.username) === normalizedUsername);
};

export interface TokenSubjectMatch {
  user: WebUser;
  matchedBy: 'userId' | 'legacy-identifier';
}

let legacyIdentifierSessionCount = 0;

export function getLegacyIdentifierSessionCount(): number {
  return legacyIdentifierSessionCount;
}

const recordLegacyIdentifierSession = (payload: Record<string, unknown>): void => {
  legacyIdentifierSessionCount += 1;
  const identity = normalizeEmail(payload.email) ?? normalizeUsername(payload.username);
  console.warn(
    `⚠️ legacy-session-token-accepted identity=${identity ? hashAuditValue(identity) : 'unknown'}; the token predates userId claims. Users should re-authenticate to obtain a subject-bound token.`,
  );
};

/**
 * Resolves the token subject. A token that carries a `userId` claim must match
 * that exact account: falling back to the username or email would let a token
 * minted for a deleted user authenticate as a later account that reuses the
 * same identifier.
 */
const findUserFromTokenPayload = (
  config: AppConfig,
  payload: Record<string, unknown>,
): TokenSubjectMatch | undefined => {
  const tokenUserId = normalizeOptionalString(payload.userId) ?? normalizeOptionalString(payload.id);
  if (tokenUserId) {
    const byId = config.users.find((user) => user.id === tokenUserId);
    return byId ? { user: byId, matchedBy: 'userId' } : undefined;
  }

  const tokenEmail = normalizeEmail(payload.email);
  if (tokenEmail) {
    const byEmail = config.users.find((user) => normalizeEmail(user.email) === tokenEmail);
    if (byEmail) {
      recordLegacyIdentifierSession(payload);
      return { user: byEmail, matchedBy: 'legacy-identifier' };
    }
  }

  const tokenUsername = normalizeUsername(payload.username);
  if (tokenUsername) {
    const byUsername = config.users.find((user) => normalizeUsername(user.username) === tokenUsername);
    if (byUsername) {
      recordLegacyIdentifierSession(payload);
      return { user: byUsername, matchedBy: 'legacy-identifier' };
    }
  }

  return undefined;
};

const isActorAdmin = (user: AuthenticatedUser): boolean => user.isAdmin;

const canViewAllMappings = (user: AuthenticatedUser): boolean =>
  isActorAdmin(user) || user.permissions.viewAllMappings || user.permissions.manageAllMappings;

const canManageAllMappings = (user: AuthenticatedUser): boolean =>
  isActorAdmin(user) || user.permissions.manageAllMappings;

const canManageOwnMappings = (user: AuthenticatedUser): boolean =>
  isActorAdmin(user) || user.permissions.manageOwnMappings;

const canManageGroups = (user: AuthenticatedUser): boolean => isActorAdmin(user) || user.permissions.manageGroups;

const canQueueBackfills = (user: AuthenticatedUser): boolean => isActorAdmin(user) || user.permissions.queueBackfills;

const canRunNow = (user: AuthenticatedUser): boolean => isActorAdmin(user) || user.permissions.runNow;

const canManageMapping = (user: AuthenticatedUser, mapping: AccountMapping): boolean => {
  if (canManageAllMappings(user)) {
    return true;
  }
  if (!canManageOwnMappings(user)) {
    return false;
  }
  return mapping.createdByUserId === user.id;
};

/** True for unknown destinations so the route can return 404 after auth. */
const canManageDestination = (user: AuthenticatedUser, destinationId: string): boolean => {
  const mapping = getConfig().mappings.find((entry) => entry.id === destinationId);
  if (!mapping) return true;
  return canManageMapping(user, mapping);
};

const requireManageMappings = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as AuthedRequest).user;
  if (!user || (!canManageOwnMappings(user) && !canManageAllMappings(user))) {
    res.status(403).json({ error: 'You do not have permission to manage Bluesky accounts.' });
    return;
  }
  next();
};

const enqueueBackfillForMapping = (
  mapping: AccountMapping,
  limit?: number,
): { requestId: string } => {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : undefined;
  const queuedAt = Date.now();
  const sequence = backfillSequence++;
  const requestId = randomUUID();
  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== mapping.id);
  pendingBackfills.push({
    id: mapping.id,
    limit: safeLimit,
    queuedAt,
    sequence,
    requestId,
  });
  return { requestId };
};

const queueBackfill = (destinationIds: string[]): { queued: number; skipped: number } => {
  let queued = 0;
  let skipped = 0;
  const config = getConfig();
  for (const id of destinationIds) {
    const mapping = config.mappings.find((entry) => entry.id === id);
    if (!mapping || !mapping.enabled || getActiveTwitterUsernames(mapping).length === 0) {
      skipped += 1;
      continue;
    }
    enqueueBackfillForMapping(mapping);
    queued += 1;
  }
  pendingBackfills.sort((a, b) => a.sequence - b.sequence);
  if (queued > 0) signalSchedulerWake('backfill', destinationIds[0]);
  return { queued, skipped };
};

const getVisibleMappings = (config: AppConfig, user: AuthenticatedUser): AccountMapping[] => {
  if (canViewAllMappings(user)) {
    return config.mappings;
  }

  return config.mappings.filter((mapping) => mapping.createdByUserId === user.id);
};

const getVisibleMappingIdSet = (config: AppConfig, user: AuthenticatedUser): Set<string> => {
  const ids = new Set<string>();
  for (const mapping of getVisibleMappings(config, user)) {
    ids.add(mapping.id);
    const destination = findDestinationByLegacyId(config, mapping.id);
    for (const legacyId of destination?.metadata.legacyMappingIds ?? []) {
      ids.add(legacyId);
    }
  }
  return ids;
};

const getVisibleMappingIdentitySets = (config: AppConfig, user: AuthenticatedUser) => {
  const visible = getVisibleMappings(config, user);
  const twitterUsernames = new Set<string>();
  const bskyIdentifiers = new Set<string>();

  for (const mapping of visible) {
    for (const username of mapping.twitterUsernames) {
      twitterUsernames.add(normalizeActor(username));
    }
    bskyIdentifiers.add(normalizeActor(mapping.bskyIdentifier));
    for (const key of historyIdentityKeys(mapping)) {
      bskyIdentifiers.add(normalizeActor(key));
    }
  }

  return {
    twitterUsernames,
    bskyIdentifiers,
  };
};

const sanitizeMapping = (
  mapping: AccountMapping,
  usersById: Map<string, WebUser>,
  requester: AuthenticatedUser,
): MappingResponse => {
  const { bskyPassword: _password, ...rest } = mapping;
  const config = getConfig();
  const configVersion = getConfigVersion(config);
  const createdBy = mapping.createdByUserId ? usersById.get(mapping.createdByUserId) : undefined;
  const ownerLabel = sanitizeLabelForRequester(mapping.owner, requester);
  const accountView = mapping.bskyAccountId ? getBlueskyAccountView(config, mapping.bskyAccountId) : undefined;
  const credentialConfigured = accountView
    ? accountView.credentialConfigured
    : typeof mapping.bskyPassword === 'string' && mapping.bskyPassword.length > 0;

  const response: MappingResponse = {
    ...rest,
    ...configVersion,
    destinationState: mapping.enabled ? 'enabled' : 'paused',
    sourceCount: mapping.twitterUsernames.length,
    activeSourceCount: getActiveTwitterUsernames(mapping).length,
    credentialConfigured,
    ...(accountView
      ? {
          blueskyAccount: {
            id: accountView.id,
            label: accountView.label,
            loginIdentifier: accountView.loginIdentifier,
            canonicalHandle: accountView.canonicalHandle,
            did: accountView.did,
            serviceUrl: accountView.serviceUrl,
            credentialConfigured: accountView.credentialConfigured,
            health: accountView.health,
          },
        }
      : {}),
    sources: mapping.twitterUsernames.map((username) => {
      const source = config.sources.find((candidate) => candidate.username === username);
      const route = source
        ? config.routes.find((candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping.id)
        : undefined;
      return {
        username,
        routeId: route?.id,
        state: mapping.pausedTwitterUsernames?.includes(username) ? ('paused' as const) : ('enabled' as const),
        filters: route?.filters ?? source?.filters,
        routingPolicy: route?.routingPolicy,
        moderationPolicy: route?.moderationPolicy,
        duplicateSuppression: route?.duplicateSuppression,
        delivery: route?.delivery,
        schedule: source?.schedule,
        runtime: source ? runtimeStateService.getSource(source.id) : null,
      };
    }),
    runtime: runtimeStateService.getDestination(mapping.id),
    queue: postQueueService.getCounts().perMapping.find((entry) => entry.destination_id === mapping.id) ?? null,
    owner: ownerLabel,
    createdByLabel: createdBy
      ? requester.isAdmin
        ? getUserDisplayLabel(createdBy)
        : getUserPublicLabel(createdBy)
      : ownerLabel,
  };

  if (requester.isAdmin && createdBy) {
    response.createdByUser = {
      id: createdBy.id,
      username: createdBy.username,
      email: createdBy.email,
      role: createdBy.role,
    };
  }

  return response;
};

const parseMappingIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ids.push(normalized);
  }

  return ids;
};

const getDuplicateDestinationPayload = (mapping: AccountMapping) => ({
  error: `This Bluesky destination is already active as ${mapping.bskyCanonicalHandle || mapping.bskyIdentifier}.`,
  code: 'DUPLICATE_DESTINATION',
  duplicateDestination: {
    mappingId: mapping.id,
    did: mapping.bskyDid,
    handle: mapping.bskyCanonicalHandle || mapping.bskyIdentifier,
  },
  guidance:
    'Add the X sources to the existing destination, or pause one destination and explicitly choose credentials and ownership. Legacy duplicates are never merged automatically.',
});

const getSourceImpact = (mapping: AccountMapping, username: string) => {
  const source = getConfig().sources.find((candidate) => candidate.username === username);
  const route = source
    ? getConfig().routes.find(
        (candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping.id,
      )
    : undefined;
  return {
    username,
    sourceId: source?.id,
    routeId: route?.id,
    state: mapping.pausedTwitterUsernames?.includes(username) ? ('paused' as const) : ('enabled' as const),
    filters: route?.filters ?? source?.filters,
    routingPolicy: route?.routingPolicy,
    moderationPolicy: route?.moderationPolicy,
    duplicateSuppression: route?.duplicateSuppression,
    schedule: source?.schedule,
    runtime: source ? runtimeStateService.getSource(source.id) : null,
    dependencies: getSourceDependencies(mapping, username),
    queue: postQueueService.getSourceCounts(mapping.id, username),
    historyCount: historyIdentityKeys(mapping).reduce(
      (total, key) => total + dbService.countTweetsBySourceForDestination(username, key),
      0,
    ),
    pauseDefaults: { cancelPendingQueue: false },
    removalDefaults: {
      cancelPendingQueue: false,
      deleteHistory: false,
    },
  };
};

const getMappingMirrorSyncState = (mapping: AccountMapping) => ({
  sourceUsername: mapping.profileManagement.profileSync.sourceUsername,
  mirroredDisplayName: mapping.lastMirroredDisplayName,
  mirroredDescription: mapping.lastMirroredDescription,
  avatarUrl: mapping.lastMirroredAvatarUrl,
  bannerUrl: mapping.lastMirroredBannerUrl,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseSourceFiltersInput = (value: unknown, fallback: SourceFilterPolicy): SourceFilterPolicy => {
  if (!isRecord(value)) throw new Error('filters must be an object.');
  const booleanFields = [
    'originalPosts',
    'selfReplies',
    'externalReplies',
    'quotes',
    'reposts',
    'mediaOnly',
  ] as const;
  for (const field of booleanFields) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      throw new Error(`filters.${field} must be a boolean.`);
    }
  }
  for (const field of ['includeKeywords', 'excludeKeywords', 'languages'] as const) {
    if (
      value[field] !== undefined &&
      (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === 'string'))
    ) {
      throw new Error(`filters.${field} must be an array of strings.`);
    }
  }
  if (value.sensitiveContent !== undefined && value.sensitiveContent !== 'mirror' && value.sensitiveContent !== 'skip') {
    throw new Error('filters.sensitiveContent must be mirror or skip.');
  }
  return normalizeSourceFilters({ ...fallback, ...value });
};

const parseSourceScheduleInput = (value: unknown, fallback: SourceSchedulePolicy): SourceSchedulePolicy => {
  if (!isRecord(value)) throw new Error('schedule must be an object.');
  if (value.mode !== undefined && !['adaptive', 'fixed', 'inherit'].includes(String(value.mode))) {
    throw new Error('schedule.mode must be adaptive, fixed, or inherit.');
  }
  for (const field of ['minIntervalMinutes', 'maxIntervalMinutes', 'fixedIntervalMinutes'] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isInteger(value[field]) || Number(value[field]) < 1 || Number(value[field]) > 1440)
    ) {
      throw new Error(`schedule.${field} must be a whole number between 1 and 1440.`);
    }
  }
  const schedule = normalizeSourceSchedule({ ...fallback, ...value });
  if (
    Number(value.minIntervalMinutes ?? fallback.minIntervalMinutes) >
    Number(value.maxIntervalMinutes ?? fallback.maxIntervalMinutes)
  ) {
    throw new Error('schedule.minIntervalMinutes cannot exceed maxIntervalMinutes.');
  }
  const requestedFixed = Number(value.fixedIntervalMinutes ?? fallback.fixedIntervalMinutes);
  if (requestedFixed < schedule.minIntervalMinutes || requestedFixed > schedule.maxIntervalMinutes) {
    throw new Error('schedule.fixedIntervalMinutes must be within min/max bounds.');
  }
  return schedule;
};

const resolveStrictPolicySource = (
  twitterUsernames: string[],
  requestedSource: unknown,
  fallbackSource?: string,
): string | undefined => {
  if (requestedSource !== undefined) {
    const normalized = normalizeUsername(requestedSource);
    if (normalized && !twitterUsernames.includes(normalized)) {
      throw new Error(`@${normalized} is not a source in this destination.`);
    }
  }
  return resolveProfileSyncSourceUsername({ twitterUsernames, requestedSource, fallbackSource });
};

const parsePostingPolicyInput = (value: unknown, fallback: PostingPolicy): PostingPolicy => {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw new Error('postingPolicy must be an object.');
  const rawAttribution = value.attribution;
  if (rawAttribution !== undefined && !isRecord(rawAttribution)) {
    throw new Error('postingPolicy.attribution must be an object.');
  }
  const attribution = isRecord(rawAttribution) ? rawAttribution : {};
  const mode = attribution.mode ?? fallback.attribution.mode;
  if (mode !== 'never' && mode !== 'multiple-sources' && mode !== 'always') {
    throw new Error('Attribution mode must be never, multiple-sources, or always.');
  }
  const template = attribution.template ?? fallback.attribution.template;
  if (typeof template !== 'string') throw new Error('Attribution template must be a string.');
  validateAttributionTemplate(template);
  return {
    attribution: {
      mode,
      template,
      rootPostsOnly:
        attribution.rootPostsOnly === undefined
          ? fallback.attribution.rootPostsOnly
          : normalizeBoolean(attribution.rootPostsOnly, fallback.attribution.rootPostsOnly),
      linkSource:
        attribution.linkSource === undefined
          ? fallback.attribution.linkSource
          : normalizeBoolean(attribution.linkSource, fallback.attribution.linkSource),
    },
    appendOriginalPostLink:
      value.appendOriginalPostLink === undefined
        ? fallback.appendOriginalPostLink
        : normalizeBoolean(value.appendOriginalPostLink, fallback.appendOriginalPostLink),
  };
};

const parseProfileManagementInput = (
  value: unknown,
  fallback: ProfileManagementPolicy,
  twitterUsernames: string[],
): ProfileManagementPolicy => {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw new Error('profileManagement must be an object.');
  const rawProfileSync = value.profileSync;
  const rawPinSync = value.pinSync;
  if (rawProfileSync !== undefined && !isRecord(rawProfileSync)) throw new Error('profileSync must be an object.');
  if (rawPinSync !== undefined && !isRecord(rawPinSync)) throw new Error('pinSync must be an object.');
  const profileSync = isRecord(rawProfileSync) ? rawProfileSync : {};
  const pinSync = isRecord(rawPinSync) ? rawPinSync : {};
  const rawFields = profileSync.fields;
  if (rawFields !== undefined && !isRecord(rawFields)) throw new Error('profileSync.fields must be an object.');
  const fields = isRecord(rawFields) ? rawFields : {};
  const parseMode = (candidate: unknown, current: ProfileManagementPolicy['profileSync']['mode']) => {
    const mode = candidate ?? current;
    if (mode !== 'off' && mode !== 'manual' && mode !== 'scheduled') {
      throw new Error('Profile and pin sync modes must be off, manual, or scheduled.');
    }
    return mode;
  };
  const parseHours = (candidate: unknown, current: number) => {
    if (candidate === undefined) return current;
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 1 || candidate > 8760) {
      throw new Error('Profile and pin intervals must be whole hours between 1 and 8760.');
    }
    return candidate;
  };
  const profileSource = resolveStrictPolicySource(
    twitterUsernames,
    profileSync.sourceUsername,
    Object.hasOwn(profileSync, 'sourceUsername') ? undefined : fallback.profileSync.sourceUsername,
  );
  const pinSource = resolveStrictPolicySource(
    twitterUsernames,
    pinSync.sourceUsername,
    Object.hasOwn(pinSync, 'sourceUsername') ? undefined : fallback.pinSync.sourceUsername,
  );
  return {
    allowProfileMutation:
      value.allowProfileMutation === undefined
        ? fallback.allowProfileMutation
        : normalizeBoolean(value.allowProfileMutation, fallback.allowProfileMutation),
    ensureBotLabel:
      value.ensureBotLabel === undefined
        ? fallback.ensureBotLabel
        : normalizeBoolean(value.ensureBotLabel, fallback.ensureBotLabel),
    ensureDisplayNameBotSuffix:
      value.ensureDisplayNameBotSuffix === undefined
        ? fallback.ensureDisplayNameBotSuffix
        : normalizeBoolean(value.ensureDisplayNameBotSuffix, fallback.ensureDisplayNameBotSuffix),
    profileSync: {
      mode: parseMode(profileSync.mode, fallback.profileSync.mode),
      ...(profileSource ? { sourceUsername: profileSource } : {}),
      intervalHours: parseHours(profileSync.intervalHours, fallback.profileSync.intervalHours),
      fields: {
        displayName: normalizeBoolean(fields.displayName, fallback.profileSync.fields.displayName),
        description: normalizeBoolean(fields.description, fallback.profileSync.fields.description),
        avatar: normalizeBoolean(fields.avatar, fallback.profileSync.fields.avatar),
        banner: normalizeBoolean(fields.banner, fallback.profileSync.fields.banner),
      },
    },
    pinSync: {
      mode: parseMode(pinSync.mode, fallback.pinSync.mode),
      ...(pinSource ? { sourceUsername: pinSource } : {}),
      intervalHours: parseHours(pinSync.intervalHours, fallback.pinSync.intervalHours),
    },
  };
};

const getAccessibleGroups = (config: AppConfig, user: AuthenticatedUser) => {
  const allGroups = Array.isArray(config.groups)
    ? config.groups.filter((group) => getNormalizedGroupKey(group.name) !== RESERVED_UNGROUPED_KEY)
    : [];

  if (canViewAllMappings(user)) {
    return allGroups;
  }

  const visibleMappings = getVisibleMappings(config, user);
  const allowedKeys = new Set<string>();
  for (const mapping of visibleMappings) {
    const key = getNormalizedGroupKey(mapping.groupName);
    if (key && key !== RESERVED_UNGROUPED_KEY) {
      allowedKeys.add(key);
    }
  }

  const merged = new Map<string, { name: string; emoji?: string }>();
  for (const group of allGroups) {
    const key = getNormalizedGroupKey(group.name);
    if (!allowedKeys.has(key)) {
      continue;
    }
    merged.set(key, group);
  }

  for (const mapping of visibleMappings) {
    const groupName = normalizeGroupName(mapping.groupName);
    if (!groupName || getNormalizedGroupKey(groupName) === RESERVED_UNGROUPED_KEY) {
      continue;
    }
    const key = getNormalizedGroupKey(groupName);
    if (!merged.has(key)) {
      merged.set(key, {
        name: groupName,
        ...(mapping.groupEmoji ? { emoji: mapping.groupEmoji } : {}),
      });
    }
  }

  return [...merged.values()];
};

const parsePermissionsInput = (rawPermissions: unknown, role: UserRole): UserPermissions => {
  if (role === 'admin') {
    return { ...ADMIN_USER_PERMISSIONS };
  }

  const defaults = getDefaultUserPermissions(role);
  if (!rawPermissions || typeof rawPermissions !== 'object') {
    return defaults;
  }

  const record = rawPermissions as Record<string, unknown>;
  return {
    viewAllMappings: normalizeBoolean(record.viewAllMappings, defaults.viewAllMappings),
    manageOwnMappings: normalizeBoolean(record.manageOwnMappings, defaults.manageOwnMappings),
    manageAllMappings: normalizeBoolean(record.manageAllMappings, defaults.manageAllMappings),
    manageGroups: normalizeBoolean(record.manageGroups, defaults.manageGroups),
    queueBackfills: normalizeBoolean(record.queueBackfills, defaults.queueBackfills),
    runNow: normalizeBoolean(record.runNow, defaults.runNow),
    reevaluateQueuePolicies: normalizeBoolean(
      record.reevaluateQueuePolicies,
      defaults.reevaluateQueuePolicies,
    ),
  };
};

const validatePassword = (password: unknown): string | undefined => {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return undefined;
};

const buildUserSummary = (config: AppConfig, requester: AuthenticatedUser): UserSummaryResponse[] => {
  const usersById = createUserLookupById(config);
  return config.users
    .map((user) => {
      const ownedMappings = config.mappings.filter((mapping) => mapping.createdByUserId === user.id);
      const activeMappings = ownedMappings.filter((mapping) => mapping.enabled);
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        isAdmin: user.role === 'admin',
        permissions: user.permissions,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        mappingCount: ownedMappings.length,
        activeMappingCount: activeMappings.length,
        mappings: ownedMappings.map((mapping) => sanitizeMapping(mapping, usersById, requester)),
      };
    })
    .sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) {
        return -1;
      }
      if (!a.isAdmin && b.isAdmin) {
        return 1;
      }

      const aLabel = (a.username || a.email || '').toLowerCase();
      const bLabel = (b.username || b.email || '').toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
};

const ensureUniqueIdentity = (
  config: AppConfig,
  userId: string | undefined,
  username?: string,
  email?: string,
): string | null => {
  if (username) {
    const usernameTaken = config.users.some(
      (user) => user.id !== userId && normalizeUsername(user.username) === username,
    );
    if (usernameTaken) {
      return 'Username already exists.';
    }
  }
  if (email) {
    const emailTaken = config.users.some((user) => user.id !== userId && normalizeEmail(user.email) === email);
    if (emailTaken) {
      return 'Email already exists.';
    }
  }
  return null;
};

const authenticateToken = (req: Request, res: Response, next: NextFunction): void => {
  const bearerToken = getBearerToken(req);
  const cookieToken = parseCookies(req)[AUTH_COOKIE_NAME];
  const token = bearerToken ?? cookieToken;

  if (!token) {
    res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || typeof decoded !== 'object') {
      res.sendStatus(403);
      return;
    }

    const config = getConfig();
    const match = findUserFromTokenPayload(config, decoded as Record<string, unknown>);
    if (!match) {
      res.status(401).json({ error: { code: 'INVALID_SESSION', message: 'Session is no longer valid.' } });
      return;
    }
    const user = match.user;
    const payloadTokenVersion = Number((decoded as Record<string, unknown>).tokenVersion ?? 0);
    if (!Number.isInteger(payloadTokenVersion) || payloadTokenVersion !== user.tokenVersion) {
      res.status(401).json({ error: { code: 'SESSION_REVOKED', message: 'Session is no longer valid.' } });
      return;
    }
    if (!bearerToken && mutationRequiresCsrf(req)) {
      const csrfCookie = parseCookies(req)[CSRF_COOKIE_NAME];
      const csrfHeader = typeof req.headers?.['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined;
      if (!safeEqual(csrfCookie, csrfHeader)) {
        res.status(403).json({ error: { code: 'CSRF_REJECTED', message: 'CSRF validation failed.' } });
        return;
      }
    }

    const authedReq = req as AuthedRequest;
    authedReq.user = toAuthenticatedUser(user);
    authedReq.authMode = bearerToken ? 'bearer' : 'cookie';
    next();
  } catch {
    res.status(401).json({ error: { code: 'INVALID_SESSION', message: 'Session is invalid or expired.' } });
  }
};

const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as AuthedRequest).user;
  if (!user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

const verifyCurrentAdminPassword = async (request: AuthedRequest): Promise<boolean> => {
  const password =
    typeof request.body?.password === 'string'
      ? request.body.password
      : typeof request.get('x-reauth-password') === 'string'
        ? request.get('x-reauth-password')
        : undefined;
  if (!password) return false;
  const user = getConfig().users.find((candidate) => candidate.id === request.user?.id && candidate.role === 'admin');
  return Boolean(user && (await bcrypt.compare(password, user.passwordHash)));
};

/** Typed confirmation + current-admin password for destructive admin mutations. */
const requireDestructiveAdminStepUp = async (
  request: AuthedRequest,
  response: Response,
  expectedConfirmation: string,
): Promise<boolean> => {
  const header =
    typeof request.headers['x-destructive-confirmation'] === 'string'
      ? request.headers['x-destructive-confirmation']
      : undefined;
  const bodyConfirmation =
    typeof request.body?.confirmation === 'string' ? request.body.confirmation : undefined;
  if (header !== expectedConfirmation && bodyConfirmation !== expectedConfirmation) {
    response.status(403).json({
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: `Confirmation ${expectedConfirmation} is required.`,
      },
    });
    return false;
  }
  if (!(await verifyCurrentAdminPassword(request))) {
    response.status(401).json({
      error: {
        code: 'REAUTHENTICATION_FAILED',
        message: 'Current admin password verification is required.',
      },
    });
    return false;
  }
  return true;
};

function reconcileUpdateJobState() {
  if (!updateJobState.running) {
    return;
  }

  if (isProcessAlive(updateJobState.pid)) {
    return;
  }

  updateJobState = {
    ...updateJobState,
    running: false,
    finishedAt: updateJobState.finishedAt || Date.now(),
    exitCode: updateJobState.exitCode ?? null,
    signal: updateJobState.signal ?? null,
  };
}

function getUpdateStatusPayload(): UpdateStatusPayload {
  reconcileUpdateJobState();
  return {
    ...updateJobState,
    logTail: readLogTail(updateJobState.logFile),
  };
}

function startUpdateJob(startedBy: string): { ok: true; state: UpdateStatusPayload } | { ok: false; message: string } {
  reconcileUpdateJobState();

  if (updateJobState.running) {
    return { ok: false, message: 'Update already running.' };
  }

  if (!fs.existsSync(UPDATE_SCRIPT_PATH)) {
    return { ok: false, message: 'update.sh not found in app root.' };
  }

  fs.mkdirSync(UPDATE_LOG_DIR, { recursive: true });
  const logFile = path.join(UPDATE_LOG_DIR, `update-${Date.now()}.log`);
  const logFd = fs.openSync(logFile, 'a');
  fs.writeSync(logFd, `[${new Date().toISOString()}] Update requested by ${startedBy}\n`);

  try {
    const child = spawn('bash', [UPDATE_SCRIPT_PATH], {
      cwd: APP_ROOT_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });

    updateJobState = {
      running: true,
      pid: child.pid,
      startedAt: Date.now(),
      startedBy,
      logFile,
      finishedAt: undefined,
      exitCode: undefined,
      signal: undefined,
    };

    child.on('error', (error) => {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Failed to launch updater: ${error.message}\n`);
      updateJobState = {
        ...updateJobState,
        running: false,
        finishedAt: Date.now(),
        exitCode: 1,
      };
      notifyOperationsEvent({
        event: 'update-failure',
        occurredAt: new Date().toISOString(),
        message: 'Application update process failed to launch.',
      });
    });

    child.on('exit', (code, signal) => {
      const success = code === 0;
      fs.appendFileSync(
        logFile,
        `[${new Date().toISOString()}] Updater exited (${success ? 'success' : 'failure'}) code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
      );
      updateJobState = {
        ...updateJobState,
        running: false,
        finishedAt: Date.now(),
        exitCode: code ?? null,
        signal: signal ?? null,
      };
      if (!success) {
        notifyOperationsEvent({
          event: 'update-failure',
          occurredAt: new Date().toISOString(),
          message: 'Application update process exited unsuccessfully.',
          details: { exitCode: code ?? null },
        });
      }
    });

    child.unref();
    return { ok: true, state: getUpdateStatusPayload() };
  } catch (error) {
    return { ok: false, message: `Failed to start update process: ${(error as Error).message}` };
  } finally {
    fs.closeSync(logFd);
  }
}

const settingsRouterDependencies = {
  authenticateToken,
  requireAdmin,
  webhookRateLimiter,
  getConfig,
  saveConfig,
  getConfigVersion,
  rejectStaleConfigMutation,
  parseSchedulerIntervalMinutes,
  getSchedulerIntervalMinutes,
  getActiveTwitterUsernames,
  getSchedulerRuntime: () => ({ lastCheckTime, nextCheckTime }),
  setNextCheckTime: (value: number) => {
    nextCheckTime = value;
  },
  getNextCheckTimestamp,
  signalSchedulerWake,
  isRestoreRestartRequired,
  getErrorMessage,
  validateWebhookTarget,
  sanitizeError: (error: unknown) =>
    String((sanitizeForDiagnostics(error) as { message?: string }).message ?? error),
  listWebhookDeliveries: (limit: number) => webhookDeliveryService.list(limit),
  notifyOperationsEvent,
};
app.use('/api/settings', createSettingsRouter(settingsRouterDependencies));
app.use(
  '/api/backup',
  createBackupRouter({
    authenticateToken,
    requireAdmin,
    importRestoreRateLimiter,
    requireJsonObject,
    getBackupStorageStatus,
    createBackupBundle,
    validateBackupBundle,
    applyRestoreBundle,
    verifyCurrentAdminPassword,
    rejectMissingOrStaleRevision: (request, response) =>
      rejectMissingOrStaleConfigRevision(getConfig(), request.body, response),
    handleConfigConflict: sendConfigConflictIfStale,
    sendSafeError,
  }),
);
app.use(
  createDigestRouter({
    authenticateToken,
    requireAdmin,
    listJobs: () => digestJobService.list(),
    listEntries: (query) =>
      digestEntryService.list(query as Parameters<typeof digestEntryService.list>[0]),
    findRoute: (routeId) => getConfig().routes.find((route) => route.id === routeId),
    buildPreview: (entries, policy) =>
      buildDigestPreview(
        entries as Parameters<typeof buildDigestPreview>[0],
        policy as Parameters<typeof buildDigestPreview>[1],
      ),
    arm: (destinationId, routeId, nextRunAt) => digestJobService.arm(destinationId, routeId, nextRunAt),
    retry: (jobId) => digestJobService.retry(jobId),
    cancel: (jobId) => digestJobService.cancel(jobId),
  }),
);
app.use(
  createIngestionAdminRouter({
    authenticateToken,
    requireAdmin,
    credentialRateLimiter,
    findSource: (sourceId) => getConfig().sources.find((source) => source.id === sourceId),
    listCredentials: () => ingestionCredentialService.list(),
    createCredential: (input) => ingestionCredentialService.create(input),
    rotateCredential: (id, userId) => ingestionCredentialService.rotate(id, userId),
    revokeCredential: (id) => ingestionCredentialService.revoke(id),
    listAudit: (limit) => ingestionAuditService.list(limit),
    sendSafeError,
  }),
);
app.use(
  createBulkDestinationsRouter({
    authenticateToken,
    backfillRateLimiter: credentialRateLimiter,
    getConfig,
    getConfigVersion,
    saveCanonicalConfig,
    rejectStaleConfigMutation,
    canManageDestination,
    canQueueBackfills: (user) => canQueueBackfills(user as AuthenticatedUser),
    queueBackfill,
    sendSafeError,
  }),
);
app.use(
  createBlueskyAccountsRouter({
    authenticateToken,
    requireManageMappings,
    validationRateLimiter: credentialRateLimiter,
    getConfig,
    getConfigVersion,
    saveCanonicalConfig,
    rejectStaleConfigMutation,
    listAccounts: (requester) => {
      const config = getConfig();
      const user: AuthenticatedUser = {
        id: requester.id,
        isAdmin: requester.isAdmin,
        permissions: requester.isAdmin
          ? ADMIN_USER_PERMISSIONS
          : config.users.find((entry) => entry.id === requester.id)?.permissions ??
            getDefaultUserPermissions('user'),
      };
      // Keep list visibility aligned with mutation rights (linked destination,
      // creator of still-unlinked account, or manage-all).
      return listBlueskyAccountViews(config).filter((account) =>
        canMutateBlueskyAccount(config, user, account.id, {
          canManageAllMappings: canManageAllMappings(user),
          canManageDestination: (destinationId) => canManageDestination(user, destinationId),
        }),
      );
    },
    canMutateAccount: (requester, accountId) => {
      const user: AuthenticatedUser = {
        id: requester.id,
        isAdmin: requester.isAdmin,
        permissions: requester.isAdmin
          ? ADMIN_USER_PERMISSIONS
          : getConfig().users.find((entry) => entry.id === requester.id)?.permissions ??
            getDefaultUserPermissions('user'),
      };
      return canMutateBlueskyAccount(getConfig(), user, accountId, {
        canManageAllMappings: canManageAllMappings(user),
        canManageDestination: (destinationId) => canManageDestination(user, destinationId),
      });
    },
    createAccount: (config, input) =>
      createValidatedBlueskyAccount(
        config,
        {
          loginIdentifier: input.loginIdentifier,
          appPassword: input.appPassword,
          serviceUrl: input.serviceUrl,
          label: input.label,
          requesterId: input.requesterId,
        },
        saveCanonicalConfig,
      ),
    validateAccount: (config, accountId) =>
      validateExistingBlueskyAccount(config, accountId, saveCanonicalConfig),
    rotateCredentials: (config, input) =>
      rotateBlueskyAccountCredentials(config, input, saveCanonicalConfig),
    deleteAccount: (config, accountId) => deleteBlueskyAccount(config, accountId, saveCanonicalConfig),
    sendSafeError,
  }),
);
// --- Auth Routes ---

app.get('/api/auth/bootstrap-status', (_req, res) => {
  const config = getConfig();
  res.json({ bootstrapOpen: config.users.length === 0 });
});

let bootstrapRegisterChain: Promise<void> = Promise.resolve();

app.post('/api/register', authRateLimiter, (req, res) => {
  const work = bootstrapRegisterChain.then(async () => {
    const config = getConfig();
    if (config.users.length > 0) {
      res.status(403).json({ error: 'Registration is disabled. Ask an admin to create your account.' });
      return;
    }

    const email = normalizeEmail(req.body?.email);
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;

    if (!email && !username) {
      res.status(400).json({ error: 'Username or email is required.' });
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      res.status(400).json({ error: passwordError });
      return;
    }

    const uniqueIdentityError = ensureUniqueIdentity(config, undefined, username, email);
    if (uniqueIdentityError) {
      res.status(400).json({ error: uniqueIdentityError });
      return;
    }

    const nowIso = new Date().toISOString();
    const newUser: WebUser = {
      id: randomUUID(),
      username,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      tokenVersion: 0,
      role: 'admin',
      permissions: { ...ADMIN_USER_PERMISSIONS },
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    config.users.push(newUser);

    if (config.mappings.length > 0) {
      config.mappings = config.mappings.map((mapping) => ({
        ...mapping,
        createdByUserId: mapping.createdByUserId || newUser.id,
        owner: mapping.owner || getUserPublicLabel(newUser),
      }));
    }

    saveConfig(config);

    res.json({ success: true });
  });
  bootstrapRegisterChain = work.then(
    () => undefined,
    () => undefined,
  );
  void work.catch((error: unknown) => {
    if (!res.headersSent) {
      sendSafeError(res, 500, 'REGISTER_FAILED', error);
    }
  });
});

app.post('/api/login', authRateLimiter, async (req, res) => {
  const password = req.body?.password;
  const identifier = normalizeOptionalString(req.body?.identifier) ?? normalizeOptionalString(req.body?.email);
  if (!identifier || typeof password !== 'string') {
    res.status(400).json({ error: 'Username/email and password are required.' });
    return;
  }

  const config = getConfig();
  const user = findUserByIdentifier(config, identifier);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = issueTokenForUser(user);
  const csrfToken = setAuthenticationCookies(req, res, token);
  res.setHeader('Cache-Control', 'no-store');
  const includeBearerToken = req.body?.includeBearerToken === true;
  res.json({
    ...(includeBearerToken ? { token } : {}),
    csrfToken,
    isAdmin: user.role === 'admin',
  });
});

app.get('/api/me', authenticateToken, asAuthedHandler((req, res) => {
  res.json(serializeAuthenticatedUser(req.user));
}));

app.post('/api/logout', authenticateToken, asAuthedHandler((req, res) => {
  // Clearing the cookie cannot retire a captured bearer token, so the token
  // version is advanced instead. That invalidates every session for this
  // account, not just the caller's browser.
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === req.user.id);
  const user = config.users[userIndex];
  let allSessionsRevoked = false;
  if (userIndex !== -1 && user) {
    config.users[userIndex] = {
      ...user,
      tokenVersion: user.tokenVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      saveConfig(config);
      allSessionsRevoked = true;
    } catch (error) {
      console.error(`🛑 Could not revoke sessions during logout: ${sanitizeErrorMessage(error)}`);
    }
  }
  clearAuthenticationCookies(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    allSessionsRevoked,
    message: allSessionsRevoked
      ? 'Signed out of every active session for this account.'
      : 'Signed out of this browser. Existing API tokens could not be revoked; retry logout.',
  });
}));

app.post('/api/me/change-email', authenticateToken, asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === req.user.id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const currentEmail = normalizeEmail(req.body?.currentEmail);
  const newEmail = normalizeEmail(req.body?.newEmail);
  const password = req.body?.password;
  if (!newEmail) {
    res.status(400).json({ error: 'A new email is required.' });
    return;
  }
  if (typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required.' });
    return;
  }

  const existingEmail = normalizeEmail(user.email);
  if (existingEmail && currentEmail !== existingEmail) {
    res.status(400).json({ error: 'Current email does not match.' });
    return;
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Password verification failed.' });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, user.id, normalizeUsername(user.username), newEmail);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const updatedUser: WebUser = {
    ...user,
    email: newEmail,
    updatedAt: new Date().toISOString(),
  };
  config.users[userIndex] = updatedUser;
  saveConfig(config);

  const token = issueTokenForUser(updatedUser);
  const csrfToken = setAuthenticationCookies(req, res, token);
  res.json({
    success: true,
    token,
    csrfToken,
    me: serializeAuthenticatedUser(toAuthenticatedUser(updatedUser)),
  });
}));

app.post('/api/me/change-password', authenticateToken, asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === req.user.id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const currentPassword = req.body?.currentPassword;
  const newPassword = req.body?.newPassword;
  if (typeof currentPassword !== 'string') {
    res.status(400).json({ error: 'Current password is required.' });
    return;
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }

  config.users[userIndex] = {
    ...user,
    passwordHash: await bcrypt.hash(newPassword, 10),
    tokenVersion: user.tokenVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  saveConfig(config);
  const token = issueTokenForUser(config.users[userIndex] as WebUser);
  const csrfToken = setAuthenticationCookies(req, res, token);
  res.json({ success: true, csrfToken });
}));

app.get('/api/admin/users', authenticateToken, requireAdmin, asAuthedHandler((req, res) => {
  const config = getConfig();
  res.json(buildUserSummary(config, req.user));
}));

app.post('/api/admin/users', authenticateToken, requireAdmin, asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const username = normalizeUsername(req.body?.username);
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const role: UserRole = req.body?.isAdmin ? 'admin' : 'user';
  const permissions = parsePermissionsInput(req.body?.permissions, role);

  if (!username && !email) {
    res.status(400).json({ error: 'Username or email is required.' });
    return;
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, undefined, username, email);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const nowIso = new Date().toISOString();
  const newUser: WebUser = {
    id: randomUUID(),
    username,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    tokenVersion: 0,
    role,
    permissions,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  config.users.push(newUser);
  saveConfig(config);

  const summary = buildUserSummary(config, req.user).find((user) => user.id === newUser.id);
  res.json(summary || null);
}));

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, asAuthedHandler((req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const requestedRole: UserRole =
    req.body?.isAdmin === true ? 'admin' : req.body?.isAdmin === false ? 'user' : user.role;

  if (user.id === req.user.id && requestedRole !== 'admin') {
    res.status(400).json({ error: 'You cannot remove your own admin access.' });
    return;
  }

  if (user.role === 'admin' && requestedRole !== 'admin') {
    const adminCount = config.users.filter((entry) => entry.role === 'admin').length;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'At least one admin must remain.' });
      return;
    }
  }

  const username =
    req.body?.username !== undefined ? normalizeUsername(req.body?.username) : normalizeUsername(user.username);
  const email = req.body?.email !== undefined ? normalizeEmail(req.body?.email) : normalizeEmail(user.email);

  if (!username && !email) {
    res.status(400).json({ error: 'User must keep at least a username or email.' });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, user.id, username, email);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const permissions =
    req.body?.permissions !== undefined || req.body?.isAdmin !== undefined
      ? parsePermissionsInput(req.body?.permissions, requestedRole)
      : requestedRole === 'admin'
        ? { ...ADMIN_USER_PERMISSIONS }
        : user.permissions;

  config.users[userIndex] = {
    ...user,
    username,
    email,
    role: requestedRole,
    permissions,
    tokenVersion: user.tokenVersion + 1,
    updatedAt: new Date().toISOString(),
  };

  saveConfig(config);
  const summary = buildUserSummary(config, req.user).find((entry) => entry.id === id);
  res.json(summary || null);
}));

app.post('/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, asAuthedHandler(async (req, res) => {
  if (!(await requireDestructiveAdminStepUp(req, res, 'RESET_USER_PASSWORD'))) return;
  const { id } = req.params;
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const newPassword = req.body?.newPassword;
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  config.users[userIndex] = {
    ...user,
    passwordHash: await bcrypt.hash(newPassword, 10),
    tokenVersion: user.tokenVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  saveConfig(config);
  res.json({ success: true });
}));

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, asAuthedHandler((req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === id);
  const user = config.users[userIndex];

  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  if (user.id === req.user.id) {
    res.status(400).json({ error: 'You cannot delete your own account.' });
    return;
  }

  if (user.role === 'admin') {
    const adminCount = config.users.filter((entry) => entry.role === 'admin').length;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'At least one admin must remain.' });
      return;
    }
  }

  const ownedMappings = config.mappings.filter((mapping) => mapping.createdByUserId === user.id);
  const ownedMappingIds = new Set(ownedMappings.map((mapping) => mapping.id));
  config.mappings = config.mappings.map((mapping) =>
    mapping.createdByUserId === user.id
      ? {
          ...mapping,
          enabled: false,
        }
      : mapping,
  );

  config.users.splice(userIndex, 1);
  pendingBackfills = pendingBackfills.filter((backfill) => !ownedMappingIds.has(backfill.id));
  saveConfig(config);

  res.json({
    success: true,
    disabledMappings: ownedMappings.length,
  });
}));

// --- Provider-neutral sources, credentials, and inbound ingestion ---

app.get('/api/sources', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const configVersion = getConfigVersion(config);
  const visibleDestinationIds = new Set(getVisibleMappings(config, req.user).map((mapping) => mapping.id));
  res.json(
    config.sources
      .map((source) => ({
        ...source,
        ...configVersion,
        routes: config.routes.filter(
          (route) => route.sourceId === source.id && visibleDestinationIds.has(route.destinationId),
        ).map((route) => ({ ...route, ...configVersion })),
      }))
      .filter((source) => req.user.isAdmin || source.routes.length > 0),
  );
}));

app.post('/api/sources', authenticateToken, requireAdmin, asAuthedHandler((req, res) => {
  try {
    if (
      req.body?.token ||
      req.body?.secret ||
      req.body?.apiKey ||
      req.body?.hmacSecret ||
      req.body?.credentials
    ) {
      res.status(400).json({ error: 'Source configuration must not contain ingestion credentials.' });
      return;
    }
    const type = req.body?.type as 'x' | 'webhook' | 'api';
    if (!['x', 'webhook', 'api'].includes(type)) throw new Error('Source type must be x, webhook, or api.');
    const rawName =
      type === 'x'
        ? normalizeTwitterUsername(req.body?.username) ?? ''
        : String(req.body?.name ?? '').trim();
    const username =
      type === 'x' ? rawName : rawName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
    if (!username) throw new Error('A valid source username or name is required.');
    const config = getConfig();
    if (config.sources.some((source) => source.type === type && source.username === username)) {
      res.status(409).json({ error: 'Source already exists.' });
      return;
    }
    const sourceId = randomUUID();
    const now = new Date().toISOString();
    config.sources.push({
      id: sourceId,
      type,
      username,
      name: rawName,
      enabled: req.body?.enabled !== false,
      filters: normalizeSourceFilters(req.body?.filters ?? DEFAULT_SOURCE_FILTERS),
      schedule: normalizeSourceSchedule(req.body?.schedule ?? DEFAULT_SOURCE_SCHEDULE),
      state: { consecutiveFailures: 0 },
      createdAt: now,
      updatedAt: now,
    });
    const destinationIds: string[] = Array.isArray(req.body?.destinationIds)
      ? [...new Set<string>(req.body.destinationIds.filter((id: unknown): id is string => typeof id === 'string'))]
      : [];
    for (const destinationId of destinationIds) {
      if (!config.destinations.some((destination) => destination.id === destinationId)) continue;
      config.routes.push({
        id: randomUUID(),
        sourceId,
        destinationId,
        enabled: true,
        filters: normalizeSourceFilters(req.body?.filters ?? DEFAULT_SOURCE_FILTERS),
        routingPolicy: normalizeRoutingPolicy(req.body?.routingPolicy ?? DEFAULT_ROUTING_POLICY),
        moderationPolicy: normalizeModerationPolicy(req.body?.moderationPolicy ?? DEFAULT_MODERATION_POLICY),
        duplicateSuppression: normalizeDuplicateSuppression(
          req.body?.duplicateSuppression ?? DEFAULT_DUPLICATE_SUPPRESSION,
        ),
        delivery: {
          ...DEFAULT_ROUTE_DELIVERY,
          digest: { ...DEFAULT_ROUTE_DELIVERY.digest },
        },
        relationship: { sourcePaused: false, profileSyncSource: false, pinSyncSource: false },
        metadata: { legacyMappingIds: [] },
      });
    }
    saveCanonicalConfig(config);
    res.status(201).json(config.sources.find((source) => source.id === sourceId));
  } catch (error) {
    sendSafeError(res, 400, 'INVALID_SOURCE', error);
  }
}));

app.patch('/api/sources/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    if (req.body?.token || req.body?.secret || req.body?.credentials) {
      throw new Error('Source configuration must not contain credentials.');
    }
    const config = getConfig();
    if (rejectStaleConfigMutation(config, req.body, res)) return;
    const source = config.sources.find((candidate) => candidate.id === req.params.id);
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    if (typeof req.body?.enabled === 'boolean') source.enabled = req.body.enabled;
    if (typeof req.body?.name === 'string' && req.body.name.trim()) source.name = req.body.name.trim();
    if (req.body?.filters !== undefined) source.filters = normalizeSourceFilters(req.body.filters);
    if (req.body?.schedule !== undefined) source.schedule = normalizeSourceSchedule(req.body.schedule);
    source.updatedAt = new Date().toISOString();
    saveCanonicalConfig(config);
    res.json({ ...source, ...getConfigVersion(config) });
  } catch (error) {
    sendSafeError(res, 400, 'INVALID_SOURCE', error);
  }
});

app.delete('/api/sources/:id', authenticateToken, requireAdmin, (req, res) => {
  if (req.body?.confirmation !== `DELETE SOURCE ${req.params.id}`) {
    res.status(400).json({ error: 'Typed confirmation is required.' });
    return;
  }
  const config = getConfig();
  const source = config.sources.find((candidate) => candidate.id === req.params.id);
  if (!source) {
    res.status(404).json({ error: 'Source not found.' });
    return;
  }
  const routes = config.routes.filter((route) => route.sourceId === source.id);
  let cancelledImmediate = 0;
  let cancelledDigest = 0;
  for (const route of routes) {
    cancelledImmediate += postQueueService.cancelPendingByRouteId(route.id);
    cancelledDigest += digestEntryService.cancelPending(route.id);
    for (const job of digestJobService.list().filter((candidate) => candidate.routeId === route.id)) {
      digestJobService.cancel(job.id);
    }
  }
  for (const credential of ingestionCredentialService
    .list()
    .filter((candidate) => candidate.sourceId === source.id && !candidate.revokedAt)) {
    ingestionCredentialService.revoke(credential.id);
  }
  config.routes = config.routes.filter((route) => route.sourceId !== source.id);
  config.sources = config.sources.filter((candidate) => candidate.id !== source.id);
  saveCanonicalConfig(config);
  res.json({ deleted: true, cancelledImmediate, cancelledDigest });
});

app.post('/api/sources/:id/routes', authenticateToken, requireAdmin, (req, res) => {
  try {
    const config = getConfig();
    if (rejectStaleConfigMutation(config, req.body, res)) return;
    const source = config.sources.find((candidate) => candidate.id === req.params.id);
    const destination = config.destinations.find((candidate) => candidate.id === req.body?.destinationId);
    if (!source || !destination) throw new Error('Source or destination not found.');
    if (
      config.routes.some(
        (route) => route.sourceId === source.id && route.destinationId === destination.id,
      )
    ) {
      res.status(409).json({ error: 'Route already exists.' });
      return;
    }
    const route = {
      id: randomUUID(),
      sourceId: source.id,
      destinationId: destination.id,
      enabled: true,
      filters: normalizeSourceFilters(req.body?.filters ?? source.filters),
      routingPolicy: normalizeRoutingPolicy(req.body?.routingPolicy ?? DEFAULT_ROUTING_POLICY),
      moderationPolicy: normalizeModerationPolicy(req.body?.moderationPolicy ?? DEFAULT_MODERATION_POLICY),
      duplicateSuppression: normalizeDuplicateSuppression(
        req.body?.duplicateSuppression ?? DEFAULT_DUPLICATE_SUPPRESSION,
      ),
      delivery: normalizeRouteDelivery(req.body?.delivery ?? DEFAULT_ROUTE_DELIVERY),
      relationship: { sourcePaused: false, profileSyncSource: false, pinSyncSource: false },
      metadata: { legacyMappingIds: [] },
    };
    config.routes.push(route);
    saveCanonicalConfig(config);
    if (route.delivery.mode === 'digest') {
      digestJobService.arm(destination.id, route.id, nextDigestRun(route.delivery.digest));
    }
    res.status(201).json({ ...route, ...getConfigVersion(config) });
  } catch (error) {
    sendSafeError(res, 400, 'INVALID_ROUTE', error);
  }
});

app.delete('/api/routes/:id', authenticateToken, requireAdmin, (req, res) => {
  if (req.body?.confirmation !== `DELETE ROUTE ${req.params.id}`) {
    res.status(400).json({ error: 'Typed confirmation is required.' });
    return;
  }
  const config = getConfig();
  const route = config.routes.find((candidate) => candidate.id === req.params.id);
  if (!route) {
    res.status(404).json({ error: 'Route not found.' });
    return;
  }
  const cancelledImmediate = postQueueService.cancelPendingByRouteId(route.id);
  const cancelledDigest = digestEntryService.cancelPending(route.id);
  for (const job of digestJobService.list().filter((candidate) => candidate.routeId === route.id)) {
    digestJobService.cancel(job.id);
  }
  config.routes = config.routes.filter((candidate) => candidate.id !== route.id);
  saveCanonicalConfig(config);
  res.json({ deleted: true, cancelledImmediate, cancelledDigest });
});

app.patch('/api/routes/:id/delivery', authenticateToken, requireAdmin, asAuthedHandler((req, res) => {
  try {
    const config = getConfig();
    if (rejectStaleConfigMutation(config, req.body, res)) return;
    const route = config.routes.find((candidate) => candidate.id === req.params.id);
    if (!route) {
      res.status(404).json({ error: 'Route not found.' });
      return;
    }
    route.delivery = normalizeRouteDelivery({
      mode: req.body?.mode,
      digest: {
        ...DEFAULT_ROUTE_DELIVERY.digest,
        ...(route.delivery?.digest ?? {}),
        ...(req.body?.digest ?? {}),
        enabled: req.body?.mode === 'digest',
      },
    });
    saveCanonicalConfig(config);
    if (route.delivery.mode === 'digest') {
      digestJobService.arm(
        route.destinationId,
        route.id,
        nextDigestRun(route.delivery.digest),
      );
    }
    res.json({ ...route.delivery, ...getConfigVersion(config) });
  } catch (error) {
    sendSafeError(res, 400, 'INVALID_DIGEST_POLICY', error);
  }
}));

app.post('/api/ingest/v1/posts', ingestionRateLimiter, async (req: IngestionRequest, res: Response) => {
  const remoteAddressHash = hashAuditValue(getRequestIp(req));
  let credential: ReturnType<typeof ingestionCredentialService.authenticate>;
  let sourceId: string | undefined;
  let externalPostId: string | undefined;
  let idempotencyKey: string | undefined;
  let idempotencyClaimed = false;
  const audit = (outcome: string, statusCode: number, routeTrace?: unknown): void => {
    metricsService.increment(statusCode < 400 ? 'ingestionAccepted' : 'ingestionRejected');
    ingestionAuditService.record({
      credentialId: credential?.id,
      sourceId,
      externalPostId,
      idempotencyKeyHash: idempotencyKey ? hashAuditValue(idempotencyKey) : undefined,
      outcome,
      statusCode,
      routeTrace,
      remoteAddressHash,
    });
  };
  try {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_INSECURE_INGESTION !== 'true' &&
      !req.secure
    ) {
      throw new Error('Inbound ingestion requires HTTPS. Configure a trusted TLS reverse proxy.');
    }
    const token = getBearerToken(req);
    credential = token ? ingestionCredentialService.authenticate(token) : null;
    if (!credential) {
      audit('unauthorized', 401);
      res.status(401).json({ error: { code: 'INVALID_INGESTION_TOKEN', message: 'Invalid ingestion credential.' } });
      return;
    }
    if (!credential.scopes.includes('posts:write')) {
      audit('scope-denied', 403);
      res.status(403).json({ error: { code: 'SCOPE_DENIED', message: 'Credential lacks posts:write scope.' } });
      return;
    }
    sourceId = credential.sourceId;
    if (credential.hmacEnabled) {
      const timestamp = req.get('x-t2b-timestamp') ?? '';
      const nonce = req.get('x-t2b-nonce') ?? '';
      const signature = req.get('x-t2b-signature') ?? '';
      verifyIngestionHmac({
        secret: ingestionCredentialService.getHmacSecret(credential.id) ?? '',
        timestamp,
        nonce,
        signature,
        rawBody: req.rawBody ?? Buffer.from(JSON.stringify(req.body)),
      });
      if (
        !ingestionReplayService.consumeNonce(
          credential.id,
          nonce,
          Date.now() + INGESTION_TIMESTAMP_WINDOW_MS,
        )
      ) {
        audit('replay-rejected', 409);
        res.status(409).json({ error: { code: 'REPLAY_DETECTED', message: 'Nonce has already been used.' } });
        return;
      }
    }
    const post = validateNormalizedPost(req.body);
    externalPostId = post.externalId;
    if (post.sourceId !== credential.sourceId || !['webhook', 'api'].includes(post.sourceType)) {
      audit('source-binding-denied', 403);
      res.status(403).json({ error: { code: 'SOURCE_BINDING_DENIED', message: 'Credential is not bound to this source.' } });
      return;
    }
    idempotencyKey = req.get('idempotency-key')?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new Error('A valid Idempotency-Key header is required.');
    }
    const claim = ingestionReplayService.claimIdempotency({
      sourceId: post.sourceId,
      idempotencyKey,
      externalPostId: post.externalId,
    });
    if (!claim.accepted) {
      if (claim.conflict) {
        audit('idempotency-conflict', 409);
        res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Key or external post was already used.' } });
        return;
      }
      audit('idempotent-replay', 200, claim.response);
      res.json(claim.response ?? { duplicate: true, externalId: post.externalId });
      return;
    }
    idempotencyClaimed = true;
    const result = routeNormalizedPost(getConfig(), post, idempotencyKey);
    ingestionReplayService.saveResponse(post.sourceId, idempotencyKey, result);
    idempotencyClaimed = false;
    audit('accepted', 202, result.routes);
    res.status(202).json(result);
  } catch (error) {
    if (idempotencyClaimed && sourceId && idempotencyKey && externalPostId) {
      ingestionReplayService.releasePending(sourceId, idempotencyKey, externalPostId);
    }
    audit('rejected', 400);
    sendSafeError(res, 400, 'INGESTION_REJECTED', error);
  }
});

// --- Mapping Routes ---

app.get(['/api/destinations', '/api/mappings'], authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const usersById = createUserLookupById(config);
  const visibleMappings = getVisibleMappings(config, req.user);
  res.json(visibleMappings.map((mapping) => sanitizeMapping(mapping, usersById, req.user)));
}));

app.post('/api/sources/parse', authenticateToken, (req, res) => {
  res.json(parseTwitterUsernameInput(req.body?.sources ?? req.body?.twitterUsernames, req.body?.existing));
});

app.post('/api/policies/preview', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const destination = config.destinations.find((candidate) => candidate.id === req.body?.destinationId);
  const route = config.routes.find((candidate) => candidate.id === req.body?.routeId);
  const mapping = destination ? config.mappings.find((candidate) => candidate.id === destination.id) : undefined;
  if (!destination || !route || route.destinationId !== destination.id || !mapping) {
    res.status(404).json({ error: 'Destination route not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to preview this route.' });
    return;
  }
  const previewDestination = {
    ...destination,
    moderationPolicy:
      req.body?.moderationPolicy === undefined
        ? destination.moderationPolicy
        : normalizeModerationPolicy(req.body.moderationPolicy),
  };
  const previewRoute = {
    ...route,
    routingPolicy:
      req.body?.routingPolicy === undefined ? route.routingPolicy : normalizeRoutingPolicy(req.body.routingPolicy),
    moderationPolicy:
      req.body?.routeModerationPolicy === undefined
        ? route.moderationPolicy
        : normalizeModerationPolicy(req.body.routeModerationPolicy),
  };
  res.json({
    dryRun: true,
    decision: evaluateContentPolicy(previewDestination, previewRoute, req.body?.metadata ?? {}),
  });
}));

app.patch('/api/destinations/:id/content-policies', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const destination = config.destinations.find((candidate) => candidate.id === req.params.id);
  const mapping = config.mappings.find((candidate) => candidate.id === req.params.id);
  if (!destination || !mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to edit this destination.' });
    return;
  }
  if (req.body?.moderationPolicy !== undefined) {
    destination.moderationPolicy = normalizeModerationPolicy(req.body.moderationPolicy);
  }
  if (req.body?.aiOverrides !== undefined) {
    destination.aiOverrides = normalizeAiOverrides(req.body.aiOverrides);
  }
  if (req.body?.duplicateSuppression !== undefined) {
    destination.duplicateSuppression = normalizeDuplicateSuppression(req.body.duplicateSuppression);
  }
  const route = config.routes.find(
    (candidate) => candidate.id === req.body?.routeId && candidate.destinationId === destination.id,
  );
  if (req.body?.routeId && !route) {
    res.status(404).json({ error: 'Route not found.' });
    return;
  }
  if (route) {
    if (req.body.routingPolicy !== undefined) route.routingPolicy = normalizeRoutingPolicy(req.body.routingPolicy);
    if (req.body.routeModerationPolicy !== undefined) {
      route.moderationPolicy = normalizeModerationPolicy(req.body.routeModerationPolicy);
    }
    if (req.body.routeDuplicateSuppression !== undefined) {
      route.duplicateSuppression = normalizeDuplicateSuppression(req.body.routeDuplicateSuppression);
    }
  }
  saveCanonicalConfig(config);
  // Canonical destination fields were mutated in place; re-load so the projected
  // mapping (and revision tokens) match what was just persisted.
  const fresh = getConfig();
  const refreshed = fresh.mappings.find((entry) => entry.id === req.params.id);
  if (!refreshed) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  res.json({
    success: true,
    destination: sanitizeMapping(refreshed, createUserLookupById(fresh), req.user),
    route: route ? (fresh.routes.find((candidate) => candidate.id === route.id) ?? route) : undefined,
    ...getConfigVersion(fresh),
  });
}));

app.get(['/api/destinations/:id/sources', '/api/mappings/:id/sources'], authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const mapping = getVisibleMappings(config, req.user).find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  res.json({
    destinationId: mapping.id,
    destinationState: mapping.enabled ? 'enabled' : 'paused',
    sources: mapping.twitterUsernames.map((username) => getSourceImpact(mapping, username)),
  });
}));

app.get(
  ['/api/destinations/:id/sources/:username/impact', '/api/mappings/:id/sources/:username/impact'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const config = getConfig();
  const mapping = getVisibleMappings(config, req.user).find((entry) => entry.id === req.params.id);
  const username = normalizeTwitterUsername(req.params.username);
  if (!mapping || !username || !mapping.twitterUsernames.includes(username)) {
    res.status(404).json({ error: 'Destination source not found.' });
    return;
  }
    res.json(getSourceImpact(mapping, username));
  }),
);

app.post(['/api/destinations/:id/sources', '/api/mappings/:id/sources'], authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this destination.' });
    return;
  }
  const updatedMapping: AccountMapping = {
    ...mapping,
    twitterUsernames: [...mapping.twitterUsernames],
    pausedTwitterUsernames: [...(mapping.pausedTwitterUsernames ?? [])],
  };
  const result = addDestinationSources(updatedMapping, req.body?.sources ?? req.body?.twitterUsernames);
  if (result.added.length > 0) {
    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    config.mappings[index] = updatedMapping;
    saveConfig(config);
  }
  res.json({
    ...result,
    ...getConfigVersion(config),
    sourceCount: updatedMapping.twitterUsernames.length,
    automaticBackfill: false,
    message:
      result.added.length > 0
        ? `Added ${result.added.length} source(s). No history was backfilled.`
        : 'No sources were added.',
  });
}));

app.patch(
  ['/api/destinations/:id/sources/:username', '/api/mappings/:id/sources/:username'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this destination.' });
    return;
  }
  const state = req.body?.state;
  if (state !== undefined && state !== 'enabled' && state !== 'paused') {
    res.status(400).json({ error: 'Source state must be enabled or paused.' });
    return;
  }
  const cancelPendingQueue = req.body?.cancelPendingQueue ?? false;
  if (typeof cancelPendingQueue !== 'boolean') {
    res.status(400).json({ error: 'cancelPendingQueue must be a boolean.' });
    return;
  }
  try {
    const normalizedUsername = normalizeTwitterUsername(req.params.username);
    const source = config.sources.find((candidate) => candidate.username === normalizedUsername);
    if (!source) throw new Error('Canonical source not found.');
    const canonicalRoute = config.routes.find(
      (route) => route.sourceId === source.id && route.destinationId === mapping.id,
    );
    if (!canonicalRoute) throw new Error('Canonical route not found.');
    if (req.body?.schedule !== undefined) {
      const affectedDestinationIds = new Set(
        config.routes.filter((route) => route.sourceId === source.id).map((route) => route.destinationId),
      );
      const unauthorizedSharedDestination = config.mappings.find(
        (candidate) => affectedDestinationIds.has(candidate.id) && !canManageMapping(req.user, candidate),
      );
      if (unauthorizedSharedDestination) {
        res.status(403).json({
          error: 'This canonical source is shared with a destination you cannot manage; an administrator must edit its policy.',
        });
        return;
      }
    }
    const updatedMapping: AccountMapping = {
      ...mapping,
      twitterUsernames: [...mapping.twitterUsernames],
      pausedTwitterUsernames: [...(mapping.pausedTwitterUsernames ?? [])],
    };
    const username =
      state === undefined
        ? source.username
        : setDestinationSourcePaused(updatedMapping, req.params.username, state === 'paused');
    if (req.body?.filters !== undefined) {
      canonicalRoute.filters = parseSourceFiltersInput(req.body.filters, canonicalRoute.filters);
    }
    if (req.body?.schedule !== undefined) {
      source.schedule = parseSourceScheduleInput(req.body.schedule, source.schedule);
    }
    source.updatedAt = new Date().toISOString();
    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    config.mappings[index] = updatedMapping;
    const routeId = mapping.routeIdsByUsername?.[username];
    const cancelledQueueItems =
      state === 'paused' && cancelPendingQueue
        ? routeId
          ? postQueueService.cancelPendingByRouteId(routeId)
          : postQueueService.cancelPendingByMappingAndSource(mapping.id, username)
        : 0;
    saveConfig(config);
    res.json({
      success: true,
      ...getConfigVersion(config),
      username,
      state: state ?? (updatedMapping.pausedTwitterUsernames?.includes(username) ? 'paused' : 'enabled'),
      filters: canonicalRoute.filters,
      schedule: source.schedule,
      runtime: runtimeStateService.getSource(source.id),
      cancelledQueueItems,
      queuedItemsPreserved: !cancelPendingQueue,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Could not change source state.') });
  }
  }),
);

app.post(
  [
    '/api/destinations/:id/sources/:username/filter-preview',
    '/api/mappings/:id/sources/:username/filter-preview',
  ],
  authenticateToken,
  asAuthedHandler((req, res) => {
    const config = getConfig();
    const mapping = getVisibleMappings(config, req.user).find((entry) => entry.id === req.params.id);
    const username = normalizeTwitterUsername(req.params.username);
    const source = config.sources.find((candidate) => candidate.username === username);
    const route = source
      ? config.routes.find((candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping?.id)
      : undefined;
    if (!mapping || !source || !route || !mapping.twitterUsernames.includes(source.username)) {
      res.status(404).json({ error: 'Destination source not found.' });
      return;
    }
    if (!isRecord(req.body?.metadata)) {
      res.status(400).json({ error: 'metadata must be an object.' });
      return;
    }
    const metadata = req.body.metadata;
    let filters = route.filters;
    if (req.body?.filters !== undefined) {
      try {
        filters = parseSourceFiltersInput(req.body.filters, route.filters);
      } catch (error) {
        res.status(400).json({ error: getErrorMessage(error, 'Invalid filters for preview.') });
        return;
      }
    }
    res.json(
      evaluateSourceFilter(
        filters,
        {
          text: typeof metadata.text === 'string' ? metadata.text : undefined,
          language: typeof metadata.language === 'string' ? metadata.language : undefined,
          sensitive: metadata.sensitive === true,
          hasMedia: metadata.hasMedia === true,
          isRepost: metadata.isRepost === true,
          isQuote: metadata.isQuote === true,
          isReply: metadata.isReply === true,
          authorUsername: typeof metadata.authorUsername === 'string' ? metadata.authorUsername : source.username,
          authorId: typeof metadata.authorId === 'string' ? metadata.authorId : undefined,
          replyToUsername: typeof metadata.replyToUsername === 'string' ? metadata.replyToUsername : undefined,
          replyToUserId: typeof metadata.replyToUserId === 'string' ? metadata.replyToUserId : undefined,
          expectedSourceUsername: source.username,
        },
        { sourceEnabled: source.enabled },
      ),
    );
  }),
);

app.delete(
  ['/api/destinations/:id/sources/:username', '/api/mappings/:id/sources/:username'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this destination.' });
    return;
  }
  const cancelPendingQueue = req.body?.cancelPendingQueue ?? req.query?.cancelPendingQueue === 'true';
  const deleteHistory = req.body?.deleteHistory ?? req.query?.deleteHistory === 'true';
  if (typeof cancelPendingQueue !== 'boolean' || typeof deleteHistory !== 'boolean') {
    res.status(400).json({ error: 'cancelPendingQueue and deleteHistory must be explicit booleans.' });
    return;
  }
  const username = normalizeTwitterUsername(req.params.username);
  if (!username) {
    res.status(400).json({ error: 'Invalid X source username.' });
    return;
  }
  const impact = mapping.twitterUsernames.includes(username) ? getSourceImpact(mapping, username) : undefined;
  try {
    const updatedMapping: AccountMapping = {
      ...mapping,
      twitterUsernames: [...mapping.twitterUsernames],
      pausedTwitterUsernames: [...(mapping.pausedTwitterUsernames ?? [])],
    };
    removeDestinationSource(updatedMapping, username);
    const cancelledQueueItems = cancelPendingQueue
      ? postQueueService.cancelPendingByMappingAndSource(mapping.id, username)
      : 0;
    const deletedHistoryItems = deleteHistory
      ? historyIdentityKeys(mapping).reduce(
          (total, key) => total + dbService.deleteTweetsBySourceForDestination(username, key),
          0,
        )
      : 0;
    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    config.mappings[index] = updatedMapping;
    saveConfig(config);
    res.json({
      success: true,
      ...getConfigVersion(config),
      removed: username,
      impact,
      cancelledQueueItems,
      deletedHistoryItems,
      queuedItemsPreserved: !cancelPendingQueue,
      historyPreserved: !deleteHistory,
    });
  } catch (error) {
    res.status(409).json({
      error: getErrorMessage(error, 'Could not remove source.'),
      impact,
    });
  }
  }),
);

app.post(
  ['/api/destinations/:id/sources/:username/backfill', '/api/mappings/:id/sources/:username/backfill'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  if (!canQueueBackfills(req.user)) {
    res.status(403).json({ error: 'You do not have permission to queue backfills.' });
    return;
  }
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  const username = normalizeTwitterUsername(req.params.username);
  if (!mapping || !username || !mapping.twitterUsernames.includes(username)) {
    res.status(404).json({ error: 'Destination source not found.' });
    return;
  }
  const canonicalSource = config.sources.find((source) => source.username === username);
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have access to this destination.' });
    return;
  }
  if (!mapping.enabled || !canonicalSource?.enabled || mapping.pausedTwitterUsernames?.includes(username)) {
    res.status(409).json({ error: 'Resume the destination and source before requesting a backfill.' });
    return;
  }
  const parsedLimit = Number(req.body?.limit);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : undefined;
  const requestId = randomUUID();
  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== mapping.id);
  pendingBackfills.push({
    id: mapping.id,
    sourceUsernames: [username],
    limit,
    queuedAt: Date.now(),
    sequence: backfillSequence++,
    requestId,
  });
  pendingBackfills.sort((a, b) => a.sequence - b.sequence);
  signalSchedulerWake('backfill', mapping.id);
  res.json({ success: true, requestId, sourceUsername: username, explicitBackfill: true });
  }),
);

app.patch(['/api/destinations/:id/state', '/api/mappings/:id/state'], authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this destination.' });
    return;
  }
  const state = req.body?.state;
  if (state !== 'enabled' && state !== 'paused') {
    res.status(400).json({ error: 'Destination state must be enabled or paused.' });
    return;
  }
  if (state === 'enabled') {
    const duplicate = findDuplicateActiveDestination(config.mappings, mapping, mapping.id);
    if (duplicate) {
      res.status(409).json(getDuplicateDestinationPayload(duplicate));
      return;
    }
  }
  mapping.enabled = state === 'enabled';
  const destination = config.destinations.find((entry) => entry.id === mapping.id);
  if (destination) {
    destination.enabled = state === 'enabled';
  }
  saveCanonicalConfig(config);
  res.json({ success: true, state, queuedItemsPreserved: true, ...getConfigVersion(config) });
}));

app.post(
  ['/api/destinations/:id/credentials/test', '/api/mappings/:id/credentials/test'],
  credentialRateLimiter,
  authenticateToken,
  asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to test this destination.' });
    return;
  }
  const password =
    typeof req.body?.bskyPassword === 'string' && req.body.bskyPassword.length > 0
      ? req.body.bskyPassword
      : mapping.bskyPassword;
  try {
    const validation = await validateBlueskyCredentials({
      bskyIdentifier: normalizeOptionalString(req.body?.bskyIdentifier) || mapping.bskyIdentifier,
      bskyPassword: password,
      bskyServiceUrl: normalizeOptionalString(req.body?.bskyServiceUrl) || mapping.bskyServiceUrl,
    });
    res.json({ ...validation, readOnly: true });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Credential test failed.') });
  }
  }),
);

app.patch(
  ['/api/destinations/:id/credentials', '/api/mappings/:id/credentials'],
  credentialRateLimiter,
  authenticateToken,
  asAuthedHandler(async (req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this destination.' });
    return;
  }
  const password =
    typeof req.body?.bskyPassword === 'string' && req.body.bskyPassword.length > 0
      ? req.body.bskyPassword
      : mapping.bskyPassword;
  try {
    const validation = await validateBlueskyCredentials({
      bskyIdentifier: normalizeOptionalString(req.body?.bskyIdentifier) || mapping.bskyIdentifier,
      bskyPassword: password,
      bskyServiceUrl: normalizeOptionalString(req.body?.bskyServiceUrl) || mapping.bskyServiceUrl,
    });
    const candidate = applyValidatedDestinationIdentity({ ...mapping, bskyPassword: password }, validation);
    const duplicate = findDuplicateActiveDestination(config.mappings, candidate, mapping.id);
    if (duplicate) {
      res.status(409).json(getDuplicateDestinationPayload(duplicate));
      return;
    }
    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    const nextStorageKey = resolveDestinationStorageKey(candidate);
    clearCachedAgent(mapping);
    clearCachedAgent(candidate);
    config.mappings[index] = candidate;
    saveConfig(config);
    let rekeyed = { processed: 0, queued: 0 };
    for (const previousStorageKey of historyIdentityKeys(mapping)) {
      if (previousStorageKey !== nextStorageKey) {
        const result = dbService.rekeyDestinationIdentity(previousStorageKey, nextStorageKey);
        rekeyed = {
          processed: rekeyed.processed + result.processed,
          queued: rekeyed.queued + result.queued,
        };
      }
    }
    res.json({
      success: true,
      destination: sanitizeMapping(candidate, createUserLookupById(config), req.user),
      credentialsValidated: true,
      profileChanged: false,
      policiesChanged: false,
      sourcesChanged: false,
      rekeyed,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Credential update failed.') });
  }
  }),
);

app.patch(
  ['/api/destinations/:id/bluesky-account', '/api/mappings/:id/bluesky-account'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this destination.' });
    return;
  }
  const accountId = normalizeOptionalString(req.body?.bskyAccountId);
  if (!accountId) {
    res.status(400).json({ error: 'A Bluesky account is required.' });
    return;
  }
  const account = findBlueskyAccount(config, accountId);
  if (!account) {
    res.status(404).json({ error: 'Bluesky account not found.' });
    return;
  }
  if (
    !canMutateBlueskyAccount(config, req.user, account.id, {
      canManageAllMappings: canManageAllMappings(req.user),
      canManageDestination: (destinationId) => canManageDestination(req.user, destinationId),
    })
  ) {
    res.status(403).json({ error: 'You do not have permission to link that Bluesky account.' });
    return;
  }
  if (mapping.bskyAccountId === account.id) {
    res.json({
      success: true,
      changed: false,
      destination: sanitizeMapping(mapping, createUserLookupById(config), req.user),
      ...getConfigVersion(config),
    });
    return;
  }
  const linked = findDestinationForAccount(config, account.id);
  if (linked && linked.id !== mapping.id) {
    res.status(409).json({
      error: `That Bluesky account is already linked to another destination (${linked.bskyCanonicalHandle || linked.bskyIdentifier}).`,
      code: 'ACCOUNT_ALREADY_LINKED',
      destinationId: linked.id,
    });
    return;
  }
  const candidate = applyBlueskyAccountLink(mapping, account);
  const duplicate = findDuplicateActiveDestination(config.mappings, candidate, mapping.id);
  if (duplicate) {
    res.status(409).json(getDuplicateDestinationPayload(duplicate));
    return;
  }
  const previousAccountId = mapping.bskyAccountId;
  clearCachedAgent(mapping);
  clearCachedAgent(candidate);
  const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
  config.mappings[index] = candidate;
  saveConfig(config);
  // Re-project so the response carries the persisted account summary and revision.
  const fresh = getConfig();
  const refreshed = fresh.mappings.find((entry) => entry.id === mapping.id) ?? candidate;
  res.json({
    success: true,
    changed: true,
    previousAccountId: previousAccountId ?? null,
    destination: sanitizeMapping(refreshed, createUserLookupById(fresh), req.user),
    ...getConfigVersion(fresh),
  });
  }),
);

app.get('/api/groups', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  res.json(getAccessibleGroups(config, req.user));
}));

app.post('/api/groups', authenticateToken, asAuthedHandler((req, res) => {
  if (!canManageGroups(req.user)) {
    res.status(403).json({ error: 'You do not have permission to manage groups.' });
    return;
  }

  const config = getConfig();
  const normalizedName = normalizeGroupName(req.body?.name);
  const normalizedEmoji = normalizeGroupEmoji(req.body?.emoji);

  if (!normalizedName) {
    res.status(400).json({ error: 'Group name is required.' });
    return;
  }

  if (getNormalizedGroupKey(normalizedName) === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: '"Ungrouped" is reserved for default behavior.' });
    return;
  }

  ensureGroupExists(config, normalizedName, normalizedEmoji);
  saveConfig(config);

  const group = config.groups.find(
    (entry) => getNormalizedGroupKey(entry.name) === getNormalizedGroupKey(normalizedName),
  );
  res.json(group || { name: normalizedName, ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}) });
}));

app.put('/api/groups/:groupKey', authenticateToken, asAuthedHandler((req, res) => {
  if (!canManageGroups(req.user)) {
    res.status(403).json({ error: 'You do not have permission to manage groups.' });
    return;
  }

  const currentGroupKey = getNormalizedGroupKey(req.params.groupKey);
  if (!currentGroupKey || currentGroupKey === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: 'Invalid group key.' });
    return;
  }

  const requestedName = normalizeGroupName(req.body?.name);
  const requestedEmoji = normalizeGroupEmoji(req.body?.emoji);
  if (!requestedName) {
    res.status(400).json({ error: 'Group name is required.' });
    return;
  }

  const requestedGroupKey = getNormalizedGroupKey(requestedName);
  if (requestedGroupKey === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: '"Ungrouped" is reserved and cannot be edited.' });
    return;
  }

  const config = getConfig();
  if (!Array.isArray(config.groups)) {
    config.groups = [];
  }

  const groupIndex = config.groups.findIndex((group) => getNormalizedGroupKey(group.name) === currentGroupKey);
  if (groupIndex === -1) {
    res.status(404).json({ error: 'Group not found.' });
    return;
  }

  const mergeIndex = config.groups.findIndex(
    (group, index) => index !== groupIndex && getNormalizedGroupKey(group.name) === requestedGroupKey,
  );

  let finalName = requestedName;
  let finalEmoji = requestedEmoji || normalizeGroupEmoji(config.groups[groupIndex]?.emoji);
  if (mergeIndex !== -1) {
    finalName = normalizeGroupName(config.groups[mergeIndex]?.name) || requestedName;
    finalEmoji = requestedEmoji || normalizeGroupEmoji(config.groups[mergeIndex]?.emoji) || finalEmoji;

    config.groups[mergeIndex] = {
      name: finalName,
      ...(finalEmoji ? { emoji: finalEmoji } : {}),
    };
    config.groups.splice(groupIndex, 1);
  } else {
    config.groups[groupIndex] = {
      name: finalName,
      ...(finalEmoji ? { emoji: finalEmoji } : {}),
    };
  }

  const keysToRewrite = new Set([currentGroupKey, requestedGroupKey]);
  config.mappings = config.mappings.map((mapping) => {
    const mappingGroupKey = getNormalizedGroupKey(mapping.groupName);
    if (!keysToRewrite.has(mappingGroupKey)) {
      return mapping;
    }
    return {
      ...mapping,
      groupName: finalName,
      groupEmoji: finalEmoji || undefined,
    };
  });

  saveConfig(config);
  res.json({
    name: finalName,
    ...(finalEmoji ? { emoji: finalEmoji } : {}),
  });
}));

app.delete('/api/groups/:groupKey', authenticateToken, asAuthedHandler((req, res) => {
  if (!canManageGroups(req.user)) {
    res.status(403).json({ error: 'You do not have permission to manage groups.' });
    return;
  }

  const groupKey = getNormalizedGroupKey(req.params.groupKey);
  if (!groupKey || groupKey === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: 'Invalid group key.' });
    return;
  }

  const config = getConfig();
  if (!Array.isArray(config.groups)) {
    config.groups = [];
  }

  const beforeCount = config.groups.length;
  config.groups = config.groups.filter((group) => getNormalizedGroupKey(group.name) !== groupKey);
  if (config.groups.length === beforeCount) {
    res.status(404).json({ error: 'Group not found.' });
    return;
  }

  let reassigned = 0;
  config.mappings = config.mappings.map((mapping) => {
    if (getNormalizedGroupKey(mapping.groupName) !== groupKey) {
      return mapping;
    }
    reassigned += 1;
    return {
      ...mapping,
      groupName: undefined,
      groupEmoji: undefined,
    };
  });

  saveConfig(config);
  res.json({ success: true, reassignedCount: reassigned });
}));

app.post('/api/onboarding/twitter-profile', authenticateToken, asAuthedHandler(async (req, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to create mappings.' });
    return;
  }

  const twitterUsername = normalizeActor(req.body?.twitterUsername || '');
  if (!twitterUsername) {
    res.status(400).json({ error: 'Twitter username is required.' });
    return;
  }

  try {
    const profile = await fetchTwitterMirrorProfile(twitterUsername);
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to fetch Twitter profile metadata.') });
  }
}));

app.post('/api/onboarding/bsky-credentials', credentialRateLimiter, authenticateToken, asAuthedHandler(async (req, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to create mappings.' });
    return;
  }

  const bskyIdentifier = normalizeOptionalString(req.body?.bskyIdentifier);
  const bskyPassword = typeof req.body?.bskyPassword === 'string' ? req.body.bskyPassword : undefined;
  const bskyServiceUrl = normalizeOptionalString(req.body?.bskyServiceUrl);

  if (!bskyIdentifier || !bskyPassword) {
    res.status(400).json({ error: 'Bluesky identifier and app password are required.' });
    return;
  }

  try {
    const validation = await validateBlueskyCredentials({
      bskyIdentifier,
      bskyPassword,
      bskyServiceUrl,
    });
    const duplicate = findDuplicateActiveDestination(getConfig().mappings, {
      bskyIdentifier: validation.handle,
      bskyCanonicalHandle: validation.handle,
      bskyDid: validation.did,
      bskyServiceUrl: validation.serviceUrl,
    });
    if (duplicate) {
      res.status(409).json(getDuplicateDestinationPayload(duplicate));
      return;
    }
    res.json(validation);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to validate Bluesky credentials.') });
  }
}));

app.post(['/api/destinations', '/api/mappings'], authenticateToken, asAuthedHandler(async (req, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to create mappings.' });
    return;
  }

  const config = getConfig();
  const usersById = createUserLookupById(config);
  const sourceParsing = parseTwitterUsernameInput(req.body?.twitterUsernames ?? req.body?.sources);
  const twitterUsernames = sourceParsing.added;
  if (twitterUsernames.length === 0) {
    res.status(400).json({
      error: 'At least one valid X username is required.',
      sourceParsing,
    });
    return;
  }
  if (sourceParsing.invalid.length > 0) {
    res.status(400).json({
      error: 'One or more X usernames are invalid.',
      sourceParsing,
    });
    return;
  }

  // Credentials belong to a managed Bluesky account, so a destination is either
  // linked to an existing unlinked account or to one created here from the
  // supplied credentials. Inline destination passwords remain legacy-only.
  let linkedAccount: BlueskyAccount;
  let accountCreated = false;
  const requestedAccountId = normalizeOptionalString(req.body?.bskyAccountId);
  if (requestedAccountId) {
    const existingAccount = findBlueskyAccount(config, requestedAccountId);
    if (!existingAccount) {
      res.status(404).json({ error: 'Bluesky account not found.' });
      return;
    }
    if (
      !canMutateBlueskyAccount(config, req.user, existingAccount.id, {
        canManageAllMappings: canManageAllMappings(req.user),
        canManageDestination: (destinationId) => canManageDestination(req.user, destinationId),
      })
    ) {
      res.status(403).json({ error: 'You do not have permission to link that Bluesky account.' });
      return;
    }
    const alreadyLinked = findDestinationForAccount(config, existingAccount.id);
    if (alreadyLinked) {
      res.status(409).json({
        error: `That Bluesky account is already linked to another destination (${alreadyLinked.bskyCanonicalHandle || alreadyLinked.bskyIdentifier}).`,
        code: 'ACCOUNT_ALREADY_LINKED',
        destinationId: alreadyLinked.id,
      });
      return;
    }
    linkedAccount = existingAccount;
  } else {
    const bskyIdentifier = normalizeOptionalString(req.body?.bskyIdentifier);
    const bskyPassword = typeof req.body?.bskyPassword === 'string' ? req.body.bskyPassword : undefined;
    if (!bskyIdentifier || !bskyPassword) {
      res.status(400).json({ error: 'Select an existing Bluesky account or provide an identifier and app password.' });
      return;
    }
    let destinationValidation: Awaited<ReturnType<typeof validateBlueskyCredentials>>;
    try {
      destinationValidation = await validateBlueskyCredentials({
        bskyIdentifier,
        bskyPassword,
        bskyServiceUrl: normalizeOptionalString(req.body?.bskyServiceUrl),
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, 'Failed to validate Bluesky credentials.') });
      return;
    }
    const duplicateAccount = findBlueskyAccountByIdentity(config, {
      did: destinationValidation.did,
      serviceUrl: destinationValidation.serviceUrl,
      loginIdentifier: destinationValidation.handle,
    });
    if (duplicateAccount) {
      res.status(409).json({
        error: `A Bluesky account for ${duplicateAccount.canonicalHandle ?? duplicateAccount.loginIdentifier} already exists. Select it instead of entering credentials again.`,
        code: 'ACCOUNT_EXISTS',
        bskyAccountId: duplicateAccount.id,
      });
      return;
    }
    linkedAccount = applyValidatedAccountIdentity(
      createBlueskyAccount({
        loginIdentifier: bskyIdentifier,
        appPassword: bskyPassword,
        serviceUrl: normalizeOptionalString(req.body?.bskyServiceUrl),
        label: normalizeOptionalString(req.body?.bskyAccountLabel),
        createdByUserId: req.user.id,
      }),
      destinationValidation,
    );
    accountCreated = true;
  }
  const duplicate = findDuplicateActiveDestination(config.mappings, {
    bskyIdentifier: linkedAccount.loginIdentifier,
    bskyCanonicalHandle: linkedAccount.canonicalHandle,
    bskyDid: linkedAccount.did,
    bskyServiceUrl: linkedAccount.serviceUrl,
  });
  if (duplicate) {
    res.status(409).json(getDuplicateDestinationPayload(duplicate));
    return;
  }

  let createdByUserId = req.user.id;
  const requestedCreatorId = normalizeOptionalString(req.body?.createdByUserId);
  if (requestedCreatorId && requestedCreatorId !== req.user.id) {
    if (!canManageAllMappings(req.user)) {
      res.status(403).json({ error: 'You cannot assign mappings to another user.' });
      return;
    }
    if (!usersById.has(requestedCreatorId)) {
      res.status(400).json({ error: 'Selected account owner does not exist.' });
      return;
    }
    createdByUserId = requestedCreatorId;
  }

  const ownerUser = usersById.get(createdByUserId);
  const owner =
    normalizeOptionalString(req.body?.owner) ||
    (ownerUser ? getUserPublicLabel(ownerUser) : getActorPublicLabel(req.user));
  const normalizedGroupName = normalizeGroupName(req.body?.groupName);
  const normalizedGroupEmoji = normalizeGroupEmoji(req.body?.groupEmoji);
  let profileSyncSourceUsername: string | undefined;
  try {
    profileSyncSourceUsername = resolveStrictPolicySource(twitterUsernames, req.body?.profileSyncSourceUsername);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Invalid profile source.') });
    return;
  }
  const defaultPolicies = createDefaultMappingPolicies(twitterUsernames.length, profileSyncSourceUsername);
  let postingPolicy: PostingPolicy;
  let profileManagement: ProfileManagementPolicy;
  try {
    postingPolicy = parsePostingPolicyInput(req.body?.postingPolicy, defaultPolicies.postingPolicy);
    profileManagement = parseProfileManagementInput(
      req.body?.profileManagement,
      defaultPolicies.profileManagement,
      twitterUsernames,
    );
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Invalid destination policy.') });
    return;
  }

  const newMapping = applyBlueskyAccountLink({
    id: randomUUID(),
    twitterUsernames,
    pausedTwitterUsernames: [],
    bskyIdentifier: linkedAccount.loginIdentifier,
    bskyPassword: linkedAccount.appPassword,
    bskyServiceUrl: linkedAccount.serviceUrl,
    enabled: true,
    owner,
    groupName: normalizedGroupName || undefined,
    groupEmoji: normalizedGroupEmoji || undefined,
    createdByUserId,
    postingPolicy,
    aiOverrides: defaultPolicies.aiOverrides,
    moderationPolicy: defaultPolicies.moderationPolicy,
    duplicateSuppression: defaultPolicies.duplicateSuppression,
    profileManagement,
    profileSyncSourceUsername: profileManagement.profileSync.sourceUsername,
    hasBotLabel: false,
  }, linkedAccount);

  if (accountCreated) {
    config.blueskyAccounts.push(linkedAccount);
  }
  ensureGroupExists(config, normalizedGroupName, normalizedGroupEmoji);
  config.mappings.push(newMapping);
  saveConfig(config);
  if (accountCreated) {
    blueskyAccountRuntimeService.recordSuccess(linkedAccount.id, 'validate');
  }

  const fresh = getConfig();
  const created = fresh.mappings.find((entry) => entry.id === newMapping.id) ?? newMapping;
  res.json({
    ...sanitizeMapping(created, createUserLookupById(fresh), req.user),
    sourceParsing,
    automaticBackfill: false,
    accountCreated,
  });
}));

app.put(['/api/destinations/:id', '/api/mappings/:id'], authenticateToken, asAuthedHandler((req, res) => {
  const { id } = req.params;
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const usersById = createUserLookupById(config);
  const index = config.mappings.findIndex((mapping) => mapping.id === id);
  const existingMapping = config.mappings[index];

  if (index === -1 || !existingMapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, existingMapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  const protectedFields = ['twitterUsernames', 'sources', 'bskyIdentifier', 'bskyPassword', 'bskyServiceUrl'].filter(
    (field) => Object.hasOwn(req.body ?? {}, field),
  );
  if (protectedFields.length > 0) {
    res.status(400).json({
      error:
        'Use the source management and destination credential endpoints for source or credential changes. Policy edits never accept an app password.',
      protectedFields,
    });
    return;
  }

  const twitterUsernames = existingMapping.twitterUsernames;
  const bskyIdentifier = existingMapping.bskyIdentifier;

  let createdByUserId = existingMapping.createdByUserId || req.user.id;
  if (req.body?.createdByUserId !== undefined) {
    if (!canManageAllMappings(req.user)) {
      res.status(403).json({ error: 'You cannot reassign mapping ownership.' });
      return;
    }

    const requestedCreatorId = normalizeOptionalString(req.body?.createdByUserId);
    if (!requestedCreatorId || !usersById.has(requestedCreatorId)) {
      res.status(400).json({ error: 'Selected account owner does not exist.' });
      return;
    }
    createdByUserId = requestedCreatorId;
  }

  let nextGroupName = existingMapping.groupName;
  if (req.body?.groupName !== undefined) {
    const normalizedName = normalizeGroupName(req.body?.groupName);
    nextGroupName = normalizedName || undefined;
  }

  let nextGroupEmoji = existingMapping.groupEmoji;
  if (req.body?.groupEmoji !== undefined) {
    const normalizedEmoji = normalizeGroupEmoji(req.body?.groupEmoji);
    nextGroupEmoji = normalizedEmoji || undefined;
  }

  const ownerUser = usersById.get(createdByUserId);
  const owner =
    req.body?.owner !== undefined
      ? normalizeOptionalString(req.body?.owner) || existingMapping.owner
      : existingMapping.owner || (ownerUser ? getUserPublicLabel(ownerUser) : undefined);

  let profileSyncSourceUsername: string | undefined;
  try {
    profileSyncSourceUsername = resolveStrictPolicySource(
      twitterUsernames,
      req.body?.profileSyncSourceUsername,
      existingMapping.profileManagement.profileSync.sourceUsername,
    );
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Invalid profile source.') });
    return;
  }
  let postingPolicy: PostingPolicy;
  let profileManagement: ProfileManagementPolicy;
  try {
    postingPolicy = parsePostingPolicyInput(req.body?.postingPolicy, existingMapping.postingPolicy);
    profileManagement = parseProfileManagementInput(
      req.body?.profileManagement,
      existingMapping.profileManagement,
      twitterUsernames,
    );
    if (req.body?.profileSyncSourceUsername !== undefined) {
      profileManagement.profileSync.sourceUsername = profileSyncSourceUsername;
    }
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Invalid destination policy.') });
    return;
  }

  const updatedMapping: AccountMapping = {
    ...existingMapping,
    twitterUsernames,
    bskyIdentifier,
    bskyPassword: existingMapping.bskyPassword,
    bskyServiceUrl: existingMapping.bskyServiceUrl,
    enabled: normalizeBoolean(req.body?.enabled, existingMapping.enabled),
    owner,
    groupName: nextGroupName,
    groupEmoji: nextGroupEmoji,
    createdByUserId,
    postingPolicy,
    profileManagement,
    aiOverrides:
      req.body?.aiOverrides !== undefined
        ? normalizeAiOverrides(req.body.aiOverrides)
        : existingMapping.aiOverrides,
    profileSyncSourceUsername: profileManagement.profileSync.sourceUsername,
  };

  ensureGroupExists(config, nextGroupName, nextGroupEmoji);
  config.mappings[index] = updatedMapping;
  saveConfig(config);
  res.json(sanitizeMapping(updatedMapping, createUserLookupById(config), req.user));
}));

app.post('/api/mappings/:id/profile/preview', authenticateToken, asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to preview this mapping.' });
    return;
  }
  const decision = evaluateProfileMutation(mapping, 'profile-preview', {
    requestedSource: req.body?.sourceUsername ?? req.body?.sourceTwitterUsername,
  });
  if (!decision.allowed || !decision.sourceUsername) {
    res.status(400).json({ error: decision.reason || 'A valid profile source is required.' });
    return;
  }
  try {
    const [twitterProfile, profiles] = await Promise.all([
      fetchTwitterMirrorProfile(decision.sourceUsername),
      fetchProfilesByActor([mapping.bskyIdentifier]),
    ]);
    const current = profiles[normalizeActor(mapping.bskyIdentifier)] || {};
    const fields = mapping.profileManagement.profileSync.fields;
    const proposed = {
      displayName: fields.displayName ? twitterProfile.mirroredDisplayName : current.displayName,
      description: fields.description ? twitterProfile.mirroredDescription : current.description,
      avatarUrl: fields.avatar ? twitterProfile.avatarUrl : current.avatar,
      bannerUrl: fields.banner ? twitterProfile.bannerUrl : current.banner,
    };
    res.json({
      sourceUsername: decision.sourceUsername,
      current: {
        displayName: current.displayName,
        description: current.description,
        avatarUrl: current.avatar,
        bannerUrl: current.banner,
      },
      proposed,
      changes: {
        displayName: fields.displayName && current.displayName !== proposed.displayName,
        description: fields.description && current.description !== proposed.description,
        avatar: fields.avatar && current.avatar !== proposed.avatarUrl,
        banner: fields.banner && current.banner !== proposed.bannerUrl,
      },
      readOnly: true,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to build profile preview.') });
  }
}));

const handleProfileApplyRequest = async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  const config = getConfig();
  const mappingIndex = config.mappings.findIndex((entry) => entry.id === id);
  const mapping = config.mappings[mappingIndex];

  if (mappingIndex === -1 || !mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  const isExplicitApply = req.path.endsWith('/profile/apply');
  if (isExplicitApply && !isRecord(req.body?.fields)) {
    res.status(400).json({ error: 'Explicit profile fields are required.' });
    return;
  }
  let authorization: ReturnType<typeof assertProfileMutationAllowed>;
  try {
    authorization = assertProfileMutationAllowed(mapping, 'profile-apply', {
      requestedSource: req.body?.sourceUsername ?? req.body?.sourceTwitterUsername,
      requestedFields: isRecord(req.body?.fields)
        ? (req.body.fields as Partial<ProfileFieldPolicy>)
        : mapping.profileManagement.profileSync.fields,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Profile mutation is not allowed.') });
    return;
  }
  const sourceTwitterUsername = authorization.sourceUsername;
  const fields = authorization.fields;
  if (!sourceTwitterUsername || !fields) {
    res.status(400).json({ error: 'A source and explicit fields are required.' });
    return;
  }
  try {
    const result = await syncBlueskyProfileFromTwitter({
      twitterUsername: sourceTwitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      previousSync: getMappingMirrorSyncState(mapping),
      syncDisplayName: fields.displayName,
      syncDescription: fields.description,
      syncAvatar: fields.avatar,
      syncBanner: fields.banner,
      authorization,
    });

    const updatedMapping = applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result);
    config.mappings[mappingIndex] = updatedMapping;
    saveConfig(config);

    for (const key of [
      normalizeActor(updatedMapping.bskyIdentifier),
      normalizeActor(result.bsky.handle),
      normalizeActor(result.bsky.did),
    ]) {
      if (key) {
        profileCache.delete(key);
      }
    }

    res.json({
      success: true,
      sourceTwitterUsername,
      mapping: sanitizeMapping(updatedMapping, createUserLookupById(config), req.user),
      ...result,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to sync Bluesky profile from Twitter.') });
  }
};

app.post('/api/mappings/:id/profile/apply', authenticateToken, asAuthedHandler(handleProfileApplyRequest));
app.post('/api/mappings/:id/sync-profile-from-twitter', authenticateToken, asAuthedHandler(handleProfileApplyRequest));

app.post('/api/mappings/:id/pull-twitter-bio', authenticateToken, asAuthedHandler(async (req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mappingIndex = config.mappings.findIndex((entry) => entry.id === id);
  const mapping = config.mappings[mappingIndex];

  if (mappingIndex === -1 || !mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  let authorization: ReturnType<typeof assertProfileMutationAllowed>;
  try {
    authorization = assertProfileMutationAllowed(mapping, 'profile-apply', {
      requestedSource: req.body?.sourceUsername ?? req.body?.sourceTwitterUsername,
      requestedFields: { description: true },
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Bio mutation is not allowed.') });
    return;
  }
  const sourceTwitterUsername = authorization.sourceUsername;
  if (!sourceTwitterUsername) {
    res.status(400).json({ error: 'A valid profile source is required.' });
    return;
  }

  try {
    const result = await syncBlueskyProfileFromTwitter({
      twitterUsername: sourceTwitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      previousSync: getMappingMirrorSyncState(mapping),
      syncDisplayName: false,
      syncDescription: true,
      syncAvatar: false,
      syncBanner: false,
      authorization,
    });

    const updatedMapping = applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result);
    config.mappings[mappingIndex] = updatedMapping;
    saveConfig(config);

    for (const key of [
      normalizeActor(updatedMapping.bskyIdentifier),
      normalizeActor(result.bsky.handle),
      normalizeActor(result.bsky.did),
    ]) {
      if (key) {
        profileCache.delete(key);
      }
    }

    res.json({
      success: true,
      sourceTwitterUsername,
      mapping: sanitizeMapping(updatedMapping, createUserLookupById(config), req.user),
      ...result,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to pull Twitter bio.') });
  }
}));

app.post('/api/mappings/bot-label-all', authenticateToken, asAuthedHandler(async (req, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to update mappings.' });
    return;
  }

  const config = getConfig();
  const usersById = createUserLookupById(config);
  const manageableMappings = getVisibleMappings(config, req.user).filter((mapping) =>
    canManageMapping(req.user, mapping),
  );
  const requestedIds = parseMappingIds(req.body?.mappingIds);
  const requestedIdSet = requestedIds.length > 0 ? new Set(requestedIds) : null;
  const targets = requestedIdSet
    ? manageableMappings.filter((mapping) => requestedIdSet.has(mapping.id))
    : manageableMappings;

  if (targets.length === 0) {
    res.status(400).json({ error: 'No manageable mappings available for bot label update.' });
    return;
  }

  let labeled = 0;
  let alreadyLabeled = 0;
  let failed = 0;
  let changed = false;
  const failedMappings: Array<{ id: string; bskyIdentifier: string; error: string }> = [];

  for (const mapping of targets) {
    try {
      const authorization = assertProfileMutationAllowed(mapping, 'bot-label');
      const result = await ensureBlueskyBotSelfLabel({
        bskyIdentifier: mapping.bskyIdentifier,
        bskyPassword: mapping.bskyPassword,
        bskyServiceUrl: mapping.bskyServiceUrl,
        authorization,
      });

      if (result.updated) {
        labeled += 1;
      } else {
        alreadyLabeled += 1;
      }

      if (!mapping.hasBotLabel) {
        mapping.hasBotLabel = true;
        changed = true;
      }

      for (const key of [
        normalizeActor(mapping.bskyIdentifier),
        normalizeActor(result.bsky.handle),
        normalizeActor(result.bsky.did),
      ]) {
        if (key) {
          profileCache.delete(key);
        }
      }
    } catch (error) {
      failed += 1;
      failedMappings.push({
        id: mapping.id,
        bskyIdentifier: mapping.bskyIdentifier,
        error: getErrorMessage(error, 'Failed to update bot label.'),
      });
    }
  }

  if (changed) {
    saveConfig(config);
  }

  res.json({
    success: true,
    total: targets.length,
    labeled,
    alreadyLabeled,
    failed,
    failedMappings,
    mappings: targets.map((mapping) => sanitizeMapping(mapping, usersById, req.user)),
  });
}));

app.post('/api/mappings/append-bot-name-all', authenticateToken, asAuthedHandler(async (req, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to update mappings.' });
    return;
  }

  const config = getConfig();
  const usersById = createUserLookupById(config);
  const manageableMappings = getVisibleMappings(config, req.user).filter((mapping) =>
    canManageMapping(req.user, mapping),
  );
  const requestedIds = parseMappingIds(req.body?.mappingIds);
  const requestedIdSet = requestedIds.length > 0 ? new Set(requestedIds) : null;
  const targets = requestedIdSet
    ? manageableMappings.filter((mapping) => requestedIdSet.has(mapping.id))
    : manageableMappings;

  if (targets.length === 0) {
    res.status(400).json({ error: 'No manageable mappings available for display-name update.' });
    return;
  }

  let appended = 0;
  let alreadyAppended = 0;
  let failed = 0;
  let changed = false;
  const failedMappings: Array<{ id: string; bskyIdentifier: string; error: string }> = [];

  for (const mapping of targets) {
    try {
      const authorization = assertProfileMutationAllowed(mapping, 'display-name-suffix');
      const sourceDecision = evaluateProfileMutation(mapping, 'profile-preview', {
        requestedSource: mapping.profileManagement.profileSync.sourceUsername,
      });
      const sourceTwitterUsername = sourceDecision.sourceUsername;
      if (!sourceTwitterUsername) {
        failed += 1;
        failedMappings.push({
          id: mapping.id,
          bskyIdentifier: mapping.bskyIdentifier,
          error: 'Mapping has no Twitter source usernames.',
        });
        continue;
      }

      const result = await ensureBlueskyDisplayNameBotSuffix({
        bskyIdentifier: mapping.bskyIdentifier,
        bskyPassword: mapping.bskyPassword,
        bskyServiceUrl: mapping.bskyServiceUrl,
        twitterUsername: sourceTwitterUsername,
        authorization,
      });

      if (result.updated) {
        appended += 1;
      } else {
        alreadyAppended += 1;
      }

      if (mapping.profileSyncSourceUsername !== sourceTwitterUsername) {
        mapping.profileSyncSourceUsername = sourceTwitterUsername;
        changed = true;
      }

      if (mapping.lastMirroredDisplayName !== result.displayName) {
        mapping.lastMirroredDisplayName = result.displayName;
        changed = true;
      }

      for (const key of [
        normalizeActor(mapping.bskyIdentifier),
        normalizeActor(result.bsky.handle),
        normalizeActor(result.bsky.did),
      ]) {
        if (key) {
          profileCache.delete(key);
        }
      }
    } catch (error) {
      failed += 1;
      failedMappings.push({
        id: mapping.id,
        bskyIdentifier: mapping.bskyIdentifier,
        error: getErrorMessage(error, 'Failed to append display-name suffix.'),
      });
    }
  }

  if (changed) {
    saveConfig(config);
  }

  res.json({
    success: true,
    total: targets.length,
    appended,
    alreadyAppended,
    failed,
    failedMappings,
    mappings: targets.map((mapping) => sanitizeMapping(mapping, usersById, req.user)),
  });
}));

app.post('/api/mappings/:id/bridge-to-fediverse', authenticateToken, asAuthedHandler(async (req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to bridge this mapping.' });
    return;
  }
  if (req.body?.confirmed !== true) {
    res.status(400).json({ error: 'Explicit confirmation is required before enabling the Fediverse bridge.' });
    return;
  }

  try {
    const result = await bridgeBlueskyAccountToFediverse({
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
    });

    fediverseBridgeStatusCache.set(normalizeActor(mapping.bskyIdentifier), {
      value: {
        bridged: true,
        checkedAt: new Date().toISOString(),
      },
      expiresAt: nowMs() + FEDIVERSE_BRIDGE_STATUS_CACHE_TTL_MS,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to bridge account to the fediverse.') });
  }
}));

app.post('/api/mappings/fediverse-bridge-status', authenticateToken, asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const visibleMappings = getVisibleMappings(config, req.user);
  const visibleMappingsById = new Map(visibleMappings.map((mapping) => [mapping.id, mapping] as const));

  const requestedIds = parseMappingIds(req.body?.mappingIds);
  const idsToCheck = (requestedIds.length > 0 ? requestedIds : visibleMappings.map((mapping) => mapping.id))
    .filter((id) => visibleMappingsById.has(id))
    .slice(0, 200);

  if (idsToCheck.length === 0) {
    res.json({});
    return;
  }

  const actorByMappingId = new Map<string, string>();
  const actorsToCheck: string[] = [];
  const statuses: Record<string, FediverseBridgeStatusView> = {};

  for (const id of idsToCheck) {
    const mapping = visibleMappingsById.get(id);
    if (!mapping) {
      statuses[id] = {
        bridged: false,
        checkedAt: new Date().toISOString(),
        error: 'Mapping not visible to current user.',
      };
      continue;
    }

    const actor = normalizeActor(mapping.bskyIdentifier);
    if (!actor) {
      statuses[id] = {
        bridged: false,
        checkedAt: new Date().toISOString(),
        error: 'Missing Bluesky identifier for mapping.',
      };
      continue;
    }

    actorByMappingId.set(id, actor);
    actorsToCheck.push(actor);
  }

  const actorStatuses = await fetchFediverseBridgeStatusesByActor(actorsToCheck);

  for (const [mappingId, actor] of actorByMappingId.entries()) {
    const actorStatus = actorStatuses[actor];
    if (actorStatus) {
      statuses[mappingId] = actorStatus;
      continue;
    }

    statuses[mappingId] = {
      bridged: false,
      checkedAt: new Date().toISOString(),
      error: 'Bridge status could not be determined for this account.',
    };
  }

  res.json(statuses);
}));

app.delete('/api/mappings/:id', authenticateToken, asAuthedHandler((req, res) => {
  const id = routeParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Missing destination id.' });
    return;
  }
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to delete this mapping.' });
    return;
  }

  config.mappings = config.mappings.filter((entry) => entry.id !== id);
  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== id);
  const destination = findDestinationByLegacyId(config, id);
  for (const destinationId of [id, ...(destination?.metadata.legacyMappingIds ?? [])]) {
    postQueueService.deleteByMappingId(destinationId);
  }
  saveConfig(config);
  res.json({ success: true });
}));

app.delete('/api/mappings/:id/cache', authenticateToken, requireAdmin, (req, res) => {
  const id = routeParam(typeof req.params.id === 'string' ? req.params.id : undefined);
  if (!id) {
    res.status(400).json({ error: 'Missing destination id.' });
    return;
  }
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  for (const username of mapping.twitterUsernames) {
    dbService.deleteTweetsByUsername(username);
  }

  res.json({ success: true, message: 'Cache cleared for all associated accounts' });
});

app.post('/api/mappings/:id/delete-all-posts', authenticateToken, requireAdmin, asAuthedHandler(async (req, res) => {
  if (!(await requireDestructiveAdminStepUp(req, res, 'DELETE_ALL_POSTS'))) return;
  const id = routeParam(typeof req.params.id === 'string' ? req.params.id : undefined);
  if (!id) {
    res.status(400).json({ error: 'Missing destination id.' });
    return;
  }
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  try {
    const deletedCount = await deleteAllPosts(id);

    for (const key of historyIdentityKeys(mapping)) {
      dbService.deleteTweetsByBskyIdentifier(key);
    }

    res.json({
      success: true,
      message: `Deleted ${deletedCount} posts from ${mapping.bskyIdentifier} and cleared local cache.`,
    });
  } catch (err) {
    console.error('Failed to delete all posts:', sanitizeForDiagnostics(err));
    sendSafeError(res, 500, 'DELETE_ALL_POSTS_FAILED', err);
  }
}));

// --- Twitter Config Routes (Admin Only) ---

app.get('/api/twitter-config', authenticateToken, requireAdmin, (_req, res) => {
  const config = getConfig();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.json({
    ...getConfigVersion(config),
    authToken: '',
    ct0: '',
    backupAuthToken: '',
    backupCt0: '',
    hasAuthToken: Boolean(config.twitter.authToken),
    hasCt0: Boolean(config.twitter.ct0),
    hasBackupAuthToken: Boolean(config.twitter.backupAuthToken),
    hasBackupCt0: Boolean(config.twitter.backupCt0),
  });
});

app.post('/api/twitter-config', credentialRateLimiter, authenticateToken, requireAdmin, (req, res) => {
  const { authToken, ct0, backupAuthToken, backupCt0 } = req.body;
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  config.twitter = {
    authToken: typeof authToken === 'string' && authToken.length > 0 ? authToken : config.twitter.authToken,
    ct0: typeof ct0 === 'string' && ct0.length > 0 ? ct0 : config.twitter.ct0,
    backupAuthToken:
      typeof backupAuthToken === 'string' && backupAuthToken.length > 0
        ? backupAuthToken
        : config.twitter.backupAuthToken,
    backupCt0: typeof backupCt0 === 'string' && backupCt0.length > 0 ? backupCt0 : config.twitter.backupCt0,
  };
  if (!config.twitter.authToken || !config.twitter.ct0) {
    res.status(400).json({ error: 'Primary auth token and ct0 are required.' });
    return;
  }
  saveConfig(config);
  res.json({ success: true, ...getConfigVersion(config) });
});

app.get('/api/ai-config', authenticateToken, requireAdmin, (_req, res) => {
  const config = getConfig();
  const aiConfig = config.ai;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.json({
    ...getConfigVersion(config),
    enabled: aiConfig.enabled,
    purpose: aiConfig.purpose,
    provider: aiConfig.provider,
    model: aiConfig.model,
    baseUrl: aiConfig.baseUrl,
    apiKey: '',
    hasApiKey: Boolean(aiConfig.apiKey || config.geminiApiKey),
    maxAltTextChars: aiConfig.maxAltTextChars,
    privacyDescription: aiConfig.privacyDescription,
    textCapabilities: aiConfig.textCapabilities,
  });
});

app.post('/api/ai-config', credentialRateLimiter, authenticateToken, requireAdmin, (req, res) => {
  const { enabled, provider, apiKey, model, baseUrl, maxAltTextChars, privacyDescription, textCapabilities } =
    req.body;
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  if (!['gemini', 'openai', 'anthropic', 'custom'].includes(provider)) {
    res.status(400).json({ error: 'Unsupported AI provider.' });
    return;
  }

  config.ai = {
    ...config.ai,
    enabled: enabled === true,
    purpose: 'image-alt-text',
    provider: provider as AppConfig['ai']['provider'],
    apiKey: typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : config.ai?.apiKey || config.geminiApiKey,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    maxAltTextChars,
    privacyDescription,
    textCapabilities:
      textCapabilities && typeof textCapabilities === 'object'
        ? Object.fromEntries(
            (['translation', 'summarization', 'cleanup', 'hashtags'] as const).map((capability) => [
              capability,
              {
                ...config.ai.textCapabilities[capability],
                ...textCapabilities[capability],
                enabled: textCapabilities[capability]?.enabled === true,
                purpose: capability,
              },
            ]),
          ) as AppConfig['ai']['textCapabilities']
        : config.ai.textCapabilities,
  };

  config.geminiApiKey = undefined; // legacy field; dropped from config.json on save

  saveConfig(config);
  res.json({ success: true, ...getConfigVersion(config) });
});

app.post('/api/ai-config/test', credentialRateLimiter, authenticateToken, requireAdmin, async (_req, res) => {
  const result = await testAIProvider();
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/ai/preview-text', credentialRateLimiter, authenticateToken, requireAdmin, async (req, res) => {
  const capability = req.body?.capability as AITextCapability;
  if (!['translation', 'summarization', 'cleanup', 'hashtags'].includes(capability)) {
    res.status(400).json({ error: 'Unknown text capability.' });
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 5000) : '';
  if (!text) {
    res.status(400).json({ error: 'Preview text is required.' });
    return;
  }
  try {
    res.json(await previewTextCapability({ capability, text }));
  } catch (error) {
    sendSafeError(res, 502, 'AI_PREVIEW_FAILED', error);
  }
});

app.post('/api/mappings/:id/posting/preview', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const mapping = getVisibleMappings(config, req.user).find((entry) => entry.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  try {
    const policy = parsePostingPolicyInput(req.body?.postingPolicy, mapping.postingPolicy);
    const twitterUsername =
      normalizeUsername(req.body?.twitterUsername) ||
      mapping.twitterUsernames.find((username) => username.length > 0) ||
      'source';
    const tweetId = normalizeOptionalString(req.body?.tweetId) || '1234567890';
    const originalPostUrl = `https://x.com/${twitterUsername}/status/${tweetId}`;
    const result = applyPostingPolicy(normalizeOptionalString(req.body?.text) || 'Example post text…', policy, {
      twitterUsername,
      tweetId,
      originalPostUrl,
      destinationIdentifier: mapping.bskyIdentifier,
      sourceCount: mapping.twitterUsernames.length,
      isReply: req.body?.isReply === true,
      isThreadRoot: req.body?.isThreadRoot !== false && req.body?.isReply !== true,
    });
    res.json({ ...result, policy, queuedItemsUseCurrentPolicy: true });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Invalid posting policy preview.') });
  }
}));

app.patch(
  ['/api/destinations/:id/migration-review', '/api/mappings/:id/migration-review'],
  authenticateToken,
  requireAdmin,
  asAuthedHandler((req, res) => {
  const config = getConfig();
  if (rejectStaleConfigMutation(config, req.body, res)) return;
  const destination = config.destinations.find((entry) => entry.id === req.params.id);
  if (!destination) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  if (!destination.migrationReview) {
    res.status(400).json({ error: 'This mapping has no migration review notice.' });
    return;
  }
  destination.migrationReview = {
    ...destination.migrationReview,
    needsAdminReview: false,
    reviewedAt: new Date().toISOString(),
  };
  saveCanonicalConfig(config);
  // Review state belongs to the canonical destination; re-project so the
  // response mapping and revision tokens match what was persisted.
  const fresh = getConfig();
  const refreshed = fresh.mappings.find((entry) => entry.id === destination.id);
  if (!refreshed) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  res.json({
    success: true,
    migrationReview: destination.migrationReview,
    destination: sanitizeMapping(refreshed, createUserLookupById(fresh), req.user),
    ...getConfigVersion(fresh),
  });
}),
);

// --- Status & Actions Routes ---

app.get('/api/health/details', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const visibleMappings = getVisibleMappings(config, req.user);
  const queue = postQueueService.getCounts();
  const visibleDestinationIds = new Set(visibleMappings.map((mapping) => mapping.id));
  const digestJobs = digestJobService.list().filter((job) => visibleDestinationIds.has(job.destinationId));
  const digestEntries = digestEntryService
    .list({ limit: 1000 })
    .filter((entry) => visibleDestinationIds.has(entry.destinationId));
  const now = Date.now();
  const twitterRuntime = authRuntimeStateService.get('twitter');
  res.json({
    ...getPublicHealth(),
    databaseMigration: databaseHealthService.check().latestMigration,
    queue: {
      depth: queue.pending + queue.processing + queue.failed,
      pending: queue.pending,
      processing: queue.processing,
      failed: queue.failed,
      oldestAgeMs: queue.perMapping.reduce<number | null>((oldest, entry) => {
        if (entry.oldest_enqueued_at === null) return oldest;
        const age = Math.max(0, now - entry.oldest_enqueued_at);
        return oldest === null ? age : Math.max(oldest, age);
      }, null),
    },
    digests: {
      pendingEntries: digestEntries.filter((entry) => entry.status === 'pending').length,
      processingJobs: digestJobs.filter((job) => job.status === 'processing').length,
      failedJobs: digestJobs.filter((job) => job.status === 'failed').length,
      nextRunAt: digestJobs.reduce<number | null>(
        (next, job) => (next === null ? job.nextRunAt : Math.min(next, job.nextRunAt)),
        null,
      ),
    },
    cookies: {
      primaryConfigured: Boolean(config.twitter.authToken && config.twitter.ct0),
      backupConfigured: Boolean(config.twitter.backupAuthToken && config.twitter.backupCt0),
      active: twitterRuntime?.activeSlot,
      lastSuccessAt: twitterRuntime?.lastSuccessAt,
      lastAuthenticationFailureAt: twitterRuntime?.lastFailureAt,
      lastAuthenticationFailureCategory: twitterRuntime?.lastErrorCategory,
    },
    destinations: visibleMappings.map((mapping) => ({
      id: mapping.id,
      identifier: mapping.bskyIdentifier,
      runtime: runtimeStateService.getDestination(mapping.id),
      queue: queue.perMapping.find((entry) => entry.destination_id === mapping.id) ?? null,
      profile: {
        mutationAllowed: mapping.profileManagement.allowProfileMutation,
        mode: mapping.profileManagement.profileSync.mode,
      },
      attribution: mapping.postingPolicy.attribution.mode,
      sources: mapping.twitterUsernames.map((username) => {
        const source = config.sources.find((candidate) => candidate.username === username);
        return {
          id: source?.id,
          username,
          runtime: source ? runtimeStateService.getSource(source.id) : null,
        };
      }),
    })),
  });
}));

app.get('/api/metrics', authenticateToken, requireAdmin, (_req, res) => {
  res.json(metricsService.snapshot());
});

app.get('/api/metrics/prometheus', authenticateToken, requireAdmin, (_req, res) => {
  if (process.env.ENABLE_PROMETHEUS_METRICS !== 'true') {
    res.status(404).json({ error: 'Prometheus metrics are disabled.' });
    return;
  }
  res.type('text/plain; version=0.0.4').send(metricsService.toPrometheus());
});

app.get('/api/status', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const now = Date.now();
  const nextRunMs = Math.max(0, nextCheckTime - now);
  const visibleMappingIds = getVisibleMappingIdSet(config, req.user);
  const scopedPendingBackfills = pendingBackfills
    .filter((backfill) => visibleMappingIds.has(backfill.id))
    .sort((a, b) => a.sequence - b.sequence);

  const scopedStatus =
    currentAppStatus.state === 'backfilling' &&
    currentAppStatus.backfillMappingId &&
    !visibleMappingIds.has(currentAppStatus.backfillMappingId)
      ? {
          state: 'idle',
          message: 'Idle',
          lastUpdate: currentAppStatus.lastUpdate,
        }
      : currentAppStatus;

  // Jobs are scoped like backfills: by mapping id when set, otherwise by the
  // Bluesky target of a mapping the user can see.
  const visibleBskyIdentifiers = new Set(
    config.mappings
      .filter((mapping) => visibleMappingIds.has(mapping.id))
      .map((mapping) => mapping.bskyIdentifier.toLowerCase()),
  );
  const scopedJobs = getActiveJobsSnapshot().filter((job) => {
    if (job.mappingId) return visibleMappingIds.has(job.mappingId);
    if (job.target) return visibleBskyIdentifiers.has(job.target.toLowerCase());
    return true;
  });

  // Post-queue state comes straight from SQLite, so what the dashboard shows
  // is exactly what the workers will post — no in-memory drift.
  const queueCounts = postQueueService.getCounts();
  const scopedQueueMappings = queueCounts.perMapping.filter(
    (entry) => visibleMappingIds.has(entry.mapping_id) && entry.pending + entry.processing + entry.failed > 0,
  );
  const queueSummary = {
    pending: scopedQueueMappings.reduce((total, entry) => total + entry.pending, 0),
    processing: scopedQueueMappings.reduce((total, entry) => total + entry.processing, 0),
    failed: scopedQueueMappings.reduce((total, entry) => total + entry.failed, 0),
    oldestEnqueuedAt: scopedQueueMappings.reduce<number | null>(
      (oldest, entry) =>
        entry.oldest_enqueued_at !== null && (oldest === null || entry.oldest_enqueued_at < oldest)
          ? entry.oldest_enqueued_at
          : oldest,
      null,
    ),
    perMapping: scopedQueueMappings,
  };

  res.json({
    lastCheckTime,
    nextCheckTime: config.scheduler.enabled ? nextCheckTime : null,
    nextCheckMinutes: Math.ceil(nextRunMs / 60000),
    checkIntervalMinutes: getSchedulerIntervalMinutes(config),
    scheduler: buildSchedulerSettingsResponse(settingsRouterDependencies, config),
    pendingBackfills: scopedPendingBackfills.map((backfill, index) => ({
      ...backfill,
      position: index + 1,
    })),
    currentStatus: scopedStatus,
    activeJobs: scopedJobs,
    queue: queueSummary,
  });
}));

// Detailed post-queue listing, scoped to the mappings the caller can see.
app.get('/api/queue', authenticateToken, asAuthedHandler((req, res) => {
  const config = getConfig();
  const visibleMappingIds = getVisibleMappingIdSet(config, req.user);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 200;

  const items = postQueueService.listItems({ mappingIds: visibleMappingIds, limit }).map((item) => {
    const destination = config.destinations.find((candidate) => candidate.id === item.destination_id);
    const route = config.routes.find((candidate) => candidate.id === item.route_id);
    const current = destination && route ? createPolicySnapshot({ destination, route, ai: config.ai }) : undefined;
    return {
      ...item,
      policyDifference: current
        ? diffPolicySnapshots(parsePolicySnapshot(item.policy_snapshot), current)
        : { changed: true, fields: ['missing-current-policy'] },
    };
  });
  res.json({
    counts: postQueueService.getCounts().perMapping.filter((entry) => visibleMappingIds.has(entry.mapping_id)),
    items,
  });
}));

const queueScopeForPath = (kind: string, id: string) => {
  if (kind === 'destination') return { destinationId: id };
  if (kind === 'route') return { routeId: id };
  if (kind === 'source') return { sourceId: id };
  if (kind === 'request') return { requestId: id };
  return null;
};

const canOperateQueueScope = (user: AuthenticatedUser, scope: Parameters<typeof postQueueService.inspect>[0]): boolean => {
  if (isActorAdmin(user)) return true;
  const config = getConfig();
  const matching = postQueueService.inspect(scope);
  if (matching.length > 0) {
    return matching.every((item) => {
      const mapping = config.mappings.find((candidate) => candidate.id === item.mapping_id);
      return Boolean(mapping && canManageMapping(user, mapping));
    });
  }
  const destinationId = scope.destinationId ??
    (scope.routeId ? config.routes.find((route) => route.id === scope.routeId)?.destinationId : undefined);
  const mapping = config.mappings.find(
    (candidate) => candidate.id === scope.mappingId || candidate.id === destinationId,
  );
  return Boolean(mapping && canManageMapping(user, mapping));
};

app.use(
  createQueueControlRouter({
    authenticateToken,
    requireAdmin,
    scopeForPath: queueScopeForPath,
    canOperate: (user, scope) =>
      canOperateQueueScope(
        user as AuthenticatedUser,
        scope as Parameters<typeof canOperateQueueScope>[1],
      ),
    inspect: (scope) => postQueueService.inspect(scope),
    retryFailed: (scope) => postQueueService.retryFailed(scope),
    clearFailed: (scope) => postQueueService.clearFailed(scope),
    cancelPending: (scope) => postQueueService.cancelPending(scope),
  }),
);

app.get('/api/queue/items/:bskyIdentifier/:tweetId', authenticateToken, asAuthedHandler((req, res) => {
  const scope = { bskyIdentifier: req.params.bskyIdentifier, twitterId: req.params.tweetId };
  if (!canOperateQueueScope(req.user, scope)) {
    res.status(403).json({ error: 'You do not have permission to inspect this queue item.' });
    return;
  }
  const item = postQueueService.inspect(scope)[0];
  if (!item) {
    res.status(404).json({ error: 'Queue item not found.' });
    return;
  }
  res.json(item);
}));

app.post('/api/queue/items/:bskyIdentifier/:tweetId/retry', authenticateToken, asAuthedHandler((req, res) => {
  const scope = { bskyIdentifier: req.params.bskyIdentifier, twitterId: req.params.tweetId };
  if (!canOperateQueueScope(req.user, scope)) {
    res.status(403).json({ error: 'You do not have permission to retry this queue item.' });
    return;
  }
  const item = postQueueService.inspect(scope)[0];
  if (!item) {
    res.status(404).json({ error: 'Queue item not found.' });
    return;
  }
  if (item.status !== 'failed') {
    res.status(409).json({ error: 'Only failed queue items can be retried.' });
    return;
  }
  res.json({ success: true, affected: postQueueService.retryFailed(scope) });
}));

app.post('/api/queue/items/:bskyIdentifier/:tweetId/reevaluate-policy', authenticateToken, asAuthedHandler(async (req, res) => {
  const scope = { bskyIdentifier: req.params.bskyIdentifier, twitterId: req.params.tweetId };
  if (!canOperateQueueScope(req.user, scope)) {
    res.status(403).json({ error: 'You do not have permission to update this queue item.' });
    return;
  }
  if (!req.user.isAdmin && !req.user.permissions.reevaluateQueuePolicies) {
    res.status(403).json({ error: 'Re-evaluating queued policy snapshots requires explicit permission.' });
    return;
  }
  if (req.get('x-queue-confirmation') !== 'REEVALUATE_POLICY') {
    res.status(400).json({ error: 'Policy re-evaluation requires x-queue-confirmation: REEVALUATE_POLICY.' });
    return;
  }
  const config = getConfig();
  try {
    const item = postQueueService.getItem(scope);
    if (!item) {
      res.status(404).json({ error: 'Queue item not found.' });
      return;
    }
    if (item.status === 'processing') {
      res.status(409).json({ error: 'Processing queue items are immutable.' });
      return;
    }
    const destination = config.destinations.find((candidate) => candidate.id === item.destination_id);
    const route = config.routes.find((candidate) => candidate.id === item.route_id);
    if (!destination || !route) {
      res.status(409).json({ error: 'Current destination policy is unavailable.' });
      return;
    }
    // Queued items are not always X posts, so the payload has to be normalized
    // by source type; parsing a webhook/API item as an X tweet yields empty
    // text and misclassified content.
    const { post, imageUrls: mediaUrls } = queuedPostForPolicyEvaluation(item);
    const metadata = {
      ...contentPolicyMetadataForPost(post),
      // Routing predicates match the configured source username, not its id.
      sourceUsername: item.twitter_username,
      createdAt: item.source_created_at,
    };
    const contentDecision = evaluateContentPolicy(destination, route, metadata);
    const dedupPolicy = route.duplicateSuppression.enabled
      ? route.duplicateSuppression
      : destination.duplicateSuppression;
    let duplicate = null;
    let imageHash: string | undefined;
    if (contentDecision.allowed && dedupPolicy.enabled) {
      if (dedupPolicy.perceptualImageHash) {
        imageHash = combinePerceptualHashes(
          (await computePerceptualHashes(mediaUrls, { enabled: true })).hashes,
        );
      }
      duplicate = duplicateFingerprintService.findRecent({
        destinationId: destination.id,
        routeId: route.id,
        routeScoped: route.duplicateSuppression.enabled,
        textUrlHash: contentSha256(post.text, post.urls),
        imageHash,
        since: Date.now() - dedupPolicy.windowHours * 60 * 60 * 1000,
        excludeExternalPostId: item.external_post_id,
      });
    }
    const decision = duplicate
      ? {
          allowed: false,
          reason: 'duplicate-suppressed',
          detail: String(duplicate.id),
          decisionVersion: contentDecision.decisionVersion,
          trace: [
            ...contentDecision.trace,
            { policy: 'duplicate-suppression', predicate: 'recent-fingerprint', matched: true },
          ],
        }
      : {
          ...contentDecision,
          trace: [
            ...contentDecision.trace,
            {
              policy: 'duplicate-suppression',
              predicate: 'recent-fingerprint',
              matched: false,
              detail: dedupPolicy.enabled ? 'checked' : 'disabled',
            },
          ],
        };
    if (!decision.allowed) {
      res.status(409).json({ success: false, affected: 0, decision });
      return;
    }
    const snapshot = createPolicySnapshot({ destination, route, ai: config.ai });
    const affected = postQueueService.rewritePolicySnapshots(
      scope,
      req.user.id,
      typeof req.body?.reason === 'string' ? req.body.reason : 'User requested current policy',
      () => ({
        policyVersion: POLICY_SNAPSHOT_VERSION,
        policySnapshot: serializePolicySnapshot(snapshot),
        decisionVersion: decision.decisionVersion,
        decisionTrace: JSON.stringify(decision.trace),
      }),
    );
    metricsService.increment('snapshotRewrites', affected);
    if (affected > 0) {
      policyOverrideAuditService.record({
        destinationId: destination.id,
        routeId: route.id,
        externalPostId: item.external_post_id,
        actorId: req.user.id,
        action: 'current-policy-requeue',
        priorReason: item.status === 'failed' ? item.last_error : undefined,
        decisionVersion: decision.decisionVersion,
        decisionTrace: JSON.stringify(decision.trace),
        policyHash: snapshot.hash,
      });
    }
    res.json({ success: true, affected, decision, policyHash: snapshot.hash, requeued: item.status === 'failed' });
  } catch (error) {
    sendSafeError(res, 409, 'POLICY_SNAPSHOT_UPDATE_FAILED', error);
  }
}));

app.post('/api/activity/:destinationId/:tweetId/override-requeue', authenticateToken, asAuthedHandler(async (req, res) => {
  const config = getConfig();
  const destination = config.destinations.find((candidate) => candidate.id === req.params.destinationId);
  const mapping = config.mappings.find((candidate) => candidate.id === req.params.destinationId);
  if (!destination || !mapping) {
    res.status(404).json({ error: 'Destination not found.' });
    return;
  }
  if (
    !canManageMapping(req.user, mapping) ||
    (!req.user.isAdmin && !req.user.permissions.reevaluateQueuePolicies)
  ) {
    res.status(403).json({ error: 'Override requeue requires destination access and policy permission.' });
    return;
  }
  if (req.get('x-queue-confirmation') !== 'OVERRIDE_POLICY_SKIP') {
    res.status(400).json({ error: 'Override requeue requires x-queue-confirmation: OVERRIDE_POLICY_SKIP.' });
    return;
  }
  const tweetId = routeParam(req.params.tweetId);
  if (!tweetId) {
    res.status(400).json({ error: 'Missing tweet id.' });
    return;
  }
  const skipped = dbService.getPost(tweetId, destination.id);
  if (!skipped || skipped.status !== 'skipped') {
    res.status(404).json({ error: 'Retained skipped item not found.' });
    return;
  }
  if (skipped.override_requeued_at) {
    res.status(409).json({ error: 'This skipped item was already override-requeued.' });
    return;
  }
  const retained = parseRetainedCandidate(skipped.retained_candidate_json);
  if (!retained) {
    res.status(410).json({ error: 'The retained candidate is missing, invalid, or expired.' });
    return;
  }
  const route = config.routes.find(
    (candidate) => candidate.id === skipped.route_id && candidate.destinationId === destination.id,
  );
  if (!route) {
    res.status(409).json({ error: 'The current route no longer exists.' });
    return;
  }
  const contentDecision = evaluateContentPolicy(destination, route, retained.normalized);
  const dedupPolicy = route.duplicateSuppression.enabled
    ? route.duplicateSuppression
    : destination.duplicateSuppression;
  let imageHash: string | undefined;
  if (contentDecision.allowed && dedupPolicy.enabled && dedupPolicy.perceptualImageHash) {
    imageHash = combinePerceptualHashes(
      (await computePerceptualHashes(retained.normalized.mediaUrls, { enabled: true })).hashes,
    );
  }
  const textUrlHash = contentSha256(retained.normalized.text ?? '', retained.normalized.urls);
  const duplicate =
    contentDecision.allowed && dedupPolicy.enabled
      ? duplicateFingerprintService.findRecent({
          destinationId: destination.id,
          routeId: route.id,
          routeScoped: route.duplicateSuppression.enabled,
          textUrlHash,
          imageHash,
          since: Date.now() - dedupPolicy.windowHours * 60 * 60 * 1000,
          excludeExternalPostId: retained.normalized.externalPostId,
        })
      : null;
  const policyDecision = duplicate
    ? {
        allowed: false,
        reason: 'duplicate-suppressed',
        decisionVersion: contentDecision.decisionVersion,
        trace: [
          ...contentDecision.trace,
          { policy: 'duplicate-suppression', predicate: 'recent-fingerprint', matched: true },
        ],
      }
    : contentDecision;
  const explicitOverride = req.body?.override === true;
  if (!policyDecision.allowed && !explicitOverride) {
    res.status(409).json({ success: false, affected: 0, decision: policyDecision, requiresOverride: true });
    return;
  }
  const decision = explicitOverride
    ? {
        ...policyDecision,
        allowed: true,
        reason: 'authorized-policy-override',
        trace: [
          ...policyDecision.trace,
          { policy: 'authorized-override', predicate: 'explicit-confirmation', matched: true },
        ],
      }
    : policyDecision;
  const snapshot = createPolicySnapshot({ destination, route, ai: config.ai });
  // Consume the retained skip record *before* enqueueing: a worker's
  // idempotency check reads the same history row, so if the row were still
  // present when the new queue item became visible, a worker could see the
  // stale skip and silently drop the override without ever posting it.
  const consumed = dbService.finalizeOverrideRequeue(
    retained.normalized.externalPostId,
    destination.id,
    req.user.id,
  );
  if (consumed !== 1) {
    res.status(409).json({ error: 'This skipped item was already override-requeued.' });
    return;
  }
  const affected = postQueueService.enqueue([
    {
      twitter_id: retained.normalized.externalPostId,
      bsky_identifier: destination.storageKey,
      mapping_id: mapping.id,
      twitter_username: retained.normalized.sourceUsername || skipped.twitter_username,
      source_type: 'x',
      external_post_id: retained.normalized.externalPostId,
      destination_id: destination.id,
      route_id: route.id,
      source_id: skipped.source_id,
      source_created_at: retained.normalized.createdAt,
      policy_version: POLICY_SNAPSHOT_VERSION,
      policy_snapshot: serializePolicySnapshot(snapshot),
      decision_version: decision.decisionVersion,
      decision_trace: JSON.stringify(decision.trace),
      kind: 'backfill',
      request_id: `override-${randomUUID()}`,
      tweet_json: JSON.stringify(retained.sourcePayload),
      tweet_text: retained.normalized.text?.slice(0, 300),
    },
  ]);
  if (affected !== 1) {
    // The skip record is already consumed; restore it so the retained
    // candidate is not lost and the caller can retry the override.
    // Keep the original created_at (via saveTweet) so settlement does not
    // treat this restored skip as fresher than the already-queued item.
    dbService.saveTweet({ ...skipped, override_requeued_at: undefined, override_requeued_by: undefined });
    res.status(409).json({ error: 'The retained candidate is already queued.' });
    return;
  }
  if (dedupPolicy.enabled) {
    duplicateFingerprintService.record({
      destinationId: destination.id,
      routeId: route.id,
      externalPostId: retained.normalized.externalPostId,
      textUrlHash,
      imageHash,
      overrideOfId: duplicate?.id,
    });
  }
  policyOverrideAuditService.record({
    destinationId: destination.id,
    routeId: route.id,
    externalPostId: retained.normalized.externalPostId,
    actorId: req.user.id,
    action: 'override-requeue',
    priorReason: skipped.skip_reason,
    decisionVersion: decision.decisionVersion,
    decisionTrace: JSON.stringify(decision.trace),
    policyHash: snapshot.hash,
  });
  res.json({ success: true, affected, decision, policyHash: snapshot.hash, retainedDegraded: retained.degraded });
}));

app.post(
  ['/api/destinations/:id/queue/retry-failed', '/api/mappings/:id/queue/retry-failed'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const scope = { destinationId: req.params.id };
  if (!canOperateQueueScope(req.user, scope)) {
    res.status(403).json({ error: 'You do not have permission to operate on this destination queue.' });
    return;
  }
  res.json({ success: true, affected: postQueueService.retryFailed(scope) });
  }),
);

app.delete(
  ['/api/destinations/:id/queue/failed', '/api/mappings/:id/queue/failed'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const scope = { destinationId: req.params.id };
  if (!canOperateQueueScope(req.user, scope)) {
    res.status(403).json({ error: 'You do not have permission to operate on this destination queue.' });
    return;
  }
  res.json({ success: true, affected: postQueueService.clearFailed(scope) });
  }),
);

app.delete(
  ['/api/destinations/:id/queue/pending', '/api/mappings/:id/queue/pending'],
  authenticateToken,
  asAuthedHandler((req, res) => {
  const scope = { destinationId: req.params.id };
  if (!canOperateQueueScope(req.user, scope)) {
    res.status(403).json({ error: 'You do not have permission to operate on this destination queue.' });
    return;
  }
  if (req.get('x-queue-confirmation') !== 'CLEAR_PENDING') {
    res.status(400).json({ error: 'Bulk pending cancellation requires x-queue-confirmation: CLEAR_PENDING.' });
    return;
  }
  res.json({ success: true, affected: postQueueService.cancelPending(scope) });
  }),
);

app.get('/api/version', authenticateToken, (_req, res) => {
  res.json(getRuntimeVersionInfo());
});

app.get('/api/update-status', authenticateToken, requireAdmin, (_req, res) => {
  res.json(getUpdateStatusPayload());
});

app.post('/api/update', authenticateToken, requireAdmin, asAuthedHandler(async (req, res) => {
  if (!(await requireDestructiveAdminStepUp(req, res, 'RUN_UPDATE'))) return;
  const startedBy = getActorLabel(req.user);
  const result = startUpdateJob(startedBy);
  if (!result.ok) {
    const message = result.message;
    const statusCode = message === 'Update already running.' ? 409 : 500;
    res.status(statusCode).json({ error: message });
    return;
  }

  res.json({
    success: true,
    message: 'Update started. Service may restart automatically.',
    status: result.state,
    version: getRuntimeVersionInfo(),
  });
}));

app.post('/api/run-now', authenticateToken, asAuthedHandler((req, res) => {
  if (!canRunNow(req.user)) {
    res.status(403).json({ error: 'You do not have permission to run checks manually.' });
    return;
  }

  requestImmediateSchedulerPass();
  res.json({ success: true, message: 'Check triggered' });
}));

app.post('/api/backfill/clear-all', authenticateToken, requireAdmin, asAuthedHandler(async (req, res) => {
  if (!(await requireDestructiveAdminStepUp(req, res, 'CLEAR_ALL_BACKFILLS'))) return;
  pendingBackfills = [];
  postQueueService.cancelPendingBackfills();
  updateAppStatus({
    state: 'idle',
    message: 'All backfills cleared',
    backfillMappingId: undefined,
    backfillRequestId: undefined,
  });
  signalSchedulerWake();
  res.json({ success: true, message: 'All backfills cleared' });
}));

app.post('/api/backfill/:id', authenticateToken, asAuthedHandler((req, res) => {
  if (!canQueueBackfills(req.user)) {
    res.status(403).json({ error: 'You do not have permission to queue backfills.' });
    return;
  }

  const id = routeParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Missing destination id.' });
    return;
  }
  const { limit } = req.body;
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have access to this mapping.' });
    return;
  }

  if (!mapping.enabled) {
    res.status(409).json({ error: 'Resume the destination before requesting a backfill.' });
    return;
  }
  const activeSources = getActiveTwitterUsernames(mapping);
  if (activeSources.length === 0) {
    res.status(400).json({ error: 'Destination has no enabled X sources.' });
    return;
  }

  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : undefined;
  const { requestId } = enqueueBackfillForMapping(mapping, safeLimit);
  pendingBackfills.sort((a, b) => a.sequence - b.sequence);
  signalSchedulerWake('backfill', id);

  res.json({
    success: true,
    message: `Backfill queued for @${activeSources.join(', ')}`,
    requestId,
  });
}));

app.post('/api/pin-sync/:id', authenticateToken, asAuthedHandler((req, res) => {
  if (!canQueueBackfills(req.user)) {
    res.status(403).json({ error: 'You do not have permission to sync pinned tweets.' });
    return;
  }

  const id = routeParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Missing destination id.' });
    return;
  }
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have access to this mapping.' });
    return;
  }

  if (!Array.isArray(mapping.twitterUsernames) || mapping.twitterUsernames.length === 0) {
    res.status(400).json({ error: 'Mapping has no Twitter source accounts configured.' });
    return;
  }
  let authorization: ReturnType<typeof assertProfileMutationAllowed>;
  try {
    authorization = assertProfileMutationAllowed(mapping, 'pin-sync-manual', {
      requestedSource: req.body?.sourceUsername,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Pin synchronization is not allowed.') });
    return;
  }

  pendingPinSyncs = pendingPinSyncs.filter((entry) => entry.id !== id);
  pendingPinSyncs.push({
    id,
    queuedAt: Date.now(),
    requestId: randomUUID(),
    sourceUsername: authorization.sourceUsername,
  });
  signalSchedulerWake('pin-sync', id);

  res.json({
    success: true,
    message: `Pin sync queued for ${mapping.bskyIdentifier}`,
  });
}));

app.delete('/api/backfill/:id', authenticateToken, asAuthedHandler((req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this queue entry.' });
    return;
  }

  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== id);
  postQueueService.cancelPendingBackfills(id);
  signalSchedulerWake();
  res.json({ success: true });
}));

// --- Config Management Routes ---

app.post('/api/config/migration-report', authenticateToken, requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  try {
    const report = getConfigMigrationReport(req.body?.config);
    res.json(report);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Could not inspect configuration migration.') });
  }
});

app.get('/api/config/export', authenticateToken, requireAdmin, asAuthedHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  const requestedMode = req.query.mode ?? 'redacted';
  if (requestedMode !== 'redacted' && requestedMode !== 'full') {
    res.status(400).json({ error: 'Export mode must be redacted or full.' });
    return;
  }
  if (requestedMode === 'full' && req.get('x-config-export-confirmation') !== 'EXPORT_WITH_SECRETS') {
    res.status(403).json({
      error: 'Full export requires the x-config-export-confirmation: EXPORT_WITH_SECRETS header.',
    });
    return;
  }
  if (requestedMode === 'full' && !(await verifyCurrentAdminPassword(req))) {
    res.status(401).json({ error: 'Current admin password verification is required for a full export.' });
    return;
  }

  const config = getConfig();
  const exportData = createConfigExport(config, requestedMode);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=tweets-2-bsky-config-${requestedMode}.json`);
  res.json(exportData);
}));

app.post(
  '/api/config/import',
  importRestoreRateLimiter,
  authenticateToken,
  requireAdmin,
  requireJsonObject,
  asAuthedHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (!(await requireDestructiveAdminStepUp(req, res, 'IMPORT_CONFIG'))) return;
    try {
      const currentConfig = getConfig();
      if (rejectMissingOrStaleConfigRevision(currentConfig, req.body, res)) return;
      const {
        password: _reauthPassword,
        confirmation: _confirmation,
        ...importPayload
      } = req.body as Record<string, unknown>;
      const newConfig = mergeImportedConfig(currentConfig, importPayload);
      saveConfig(newConfig);
      res.json({ success: true, message: 'Configuration imported successfully' });
    } catch (err) {
      if (sendConfigConflictIfStale(err, res)) return;
      console.error('Import failed:', sanitizeForDiagnostics(err));
      res.status(400).json({
        error: 'Failed to process import file.',
      });
    }
  }),
);

app.get('/api/recent-activity', authenticateToken, asAuthedHandler((req, res) => {
  const limitCandidate = req.query.limit ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(limitCandidate) ? Math.max(1, Math.min(limitCandidate, 200)) : 50;
  const config = getConfig();
  const visibleSets = getVisibleMappingIdentitySets(config, req.user);
  const scanLimit = canViewAllMappings(req.user) ? limit : Math.max(limit * 6, 150);

  const tweets = dbService.getRecentProcessedTweets(scanLimit);
  const filtered = canViewAllMappings(req.user)
    ? tweets
    : tweets.filter(
        (tweet) =>
          visibleSets.twitterUsernames.has(normalizeActor(tweet.twitter_username)) ||
          visibleSets.bskyIdentifiers.has(normalizeActor(tweet.bsky_identifier)),
      );

  res.json(filtered.slice(0, limit));
}));

app.post('/api/bsky/profiles', authenticateToken, async (req, res) => {
  const actors = Array.isArray(req.body?.actors)
    ? req.body.actors.filter((actor: unknown) => typeof actor === 'string')
    : [];

  if (actors.length === 0) {
    res.json({});
    return;
  }

  const limitedActors = actors.slice(0, 200);
  const profiles = await fetchProfilesByActor(limitedActors);
  res.json(profiles);
});

app.get('/api/posts/search', authenticateToken, asAuthedHandler((req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  if (!query.trim()) {
    res.json([]);
    return;
  }

  const requestedLimit = req.query.limit ? Number(req.query.limit) : 80;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 80;
  const searchLimit = Math.min(200, Math.max(80, limit * 4));
  const config = getConfig();
  const visibleSets = getVisibleMappingIdentitySets(config, req.user);

  const scopedRows = dbService
    .searchMigratedTweets(query, searchLimit)
    .filter(
      (row) =>
        canViewAllMappings(req.user) ||
        visibleSets.twitterUsernames.has(normalizeActor(row.twitter_username)) ||
        visibleSets.bskyIdentifiers.has(normalizeActor(row.bsky_identifier)),
    )
    .slice(0, limit);

  const results = scopedRows.map<LocalPostSearchResult>((row) => ({
    twitterId: row.twitter_id,
    twitterUsername: row.twitter_username,
    bskyIdentifier: row.bsky_identifier,
    tweetText: row.tweet_text,
    bskyUri: row.bsky_uri,
    bskyCid: row.bsky_cid,
    createdAt: row.created_at,
    postUrl: buildPostUrl(row.bsky_identifier, row.bsky_uri),
    twitterUrl: buildTwitterPostUrl(row.twitter_username, row.twitter_id),
    score: Number(row.score.toFixed(2)),
  }));

  res.json(results);
}));

app.get('/api/posts/enriched', authenticateToken, asAuthedHandler(async (req, res) => {
  const requestedLimit = req.query.limit ? Number(req.query.limit) : 24;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 80)) : 24;
  const config = getConfig();
  const visibleSets = getVisibleMappingIdentitySets(config, req.user);

  const recent = dbService.getRecentProcessedTweets(limit * 8);
  const migratedWithUri = recent.filter(
    (row) =>
      row.status === 'migrated' &&
      row.bsky_uri &&
      (canViewAllMappings(req.user) ||
        visibleSets.twitterUsernames.has(normalizeActor(row.twitter_username)) ||
        visibleSets.bskyIdentifiers.has(normalizeActor(row.bsky_identifier))),
  );

  const deduped: ProcessedTweet[] = [];
  const seenUris = new Set<string>();
  for (const row of migratedWithUri) {
    const uri = row.bsky_uri;
    if (!uri || seenUris.has(uri)) continue;
    seenUris.add(uri);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }

  const uris = deduped.map((row) => row.bsky_uri).filter((uri): uri is string => typeof uri === 'string');
  const postViewsByUri = await fetchPostViewsByUri(uris);
  const enriched = deduped.map((row) =>
    buildEnrichedPost(row, row.bsky_uri ? postViewsByUri.get(row.bsky_uri) : undefined),
  );

  res.json(enriched);
}));
// Export for use by index.ts
export function updateLastCheckTime() {
  const config = getConfig();
  lastCheckTime = Date.now();
  nextCheckTime = getNextCheckTimestamp(lastCheckTime, getSchedulerIntervalMinutes(config));
}

export function updateAppStatus(status: Partial<AppStatus>) {
  currentAppStatus = {
    ...currentAppStatus,
    ...status,
    lastUpdate: Date.now(),
  };
}

export function getPendingBackfills(): PendingBackfill[] {
  return [...pendingBackfills].sort((a, b) => a.sequence - b.sequence);
}

export function getNextCheckTime(): number {
  return nextCheckTime;
}

export function getSchedulerWakeSignal(): number {
  return schedulerCommandState.sequence;
}

export function getSchedulerCommandsSince(sequence: number) {
  return readSchedulerCommandsSince(schedulerCommandState, sequence);
}

export function recalculateNextCheckTime(intervalMinutes = getSchedulerIntervalMinutes(getConfig())): number {
  nextCheckTime = getNextCheckTimestamp(Date.now(), intervalMinutes);
  signalSchedulerWake('reschedule');
  return nextCheckTime;
}

export function triggerImmediateRun(): void {
  requestImmediateSchedulerPass();
}

export function clearBackfill(id: string, requestId?: string) {
  if (requestId) {
    pendingBackfills = pendingBackfills.filter((bid) => !(bid.id === id && bid.requestId === requestId));
    return;
  }
  pendingBackfills = pendingBackfills.filter((bid) => bid.id !== id);
}

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { type?: unknown; status?: unknown };
  return record.type === 'entity.too.large' || record.status === 413;
}

function isInvalidJsonBody(error: unknown): error is SyntaxError & { body: unknown } {
  return error instanceof SyntaxError && 'body' in error;
}

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (isPayloadTooLarge(error)) {
    sendSafeError(res, 413, 'BODY_TOO_LARGE', 'Request body exceeds this route limit.');
    return;
  }
  if (isInvalidJsonBody(error)) {
    sendSafeError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
    return;
  }
  if (sendConfigConflictIfStale(error, res)) {
    return;
  }
  sendSafeError(res, 500, 'INTERNAL_ERROR', error);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found.' } });
});

// Serve the frontend for any other route (middleware approach for Express 5)
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(staticAssetsDir, 'index.html'));
});

export function startServer() {
  app.listen(PORT, HOST, () => {
    console.log(`🚀 Web interface running at http://localhost:${PORT}`);
    if (HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost') {
      console.log(`🔒 Bound to ${HOST} (local-only). Use Tailscale Serve or a reverse proxy for remote access.`);
      return;
    }
    console.log('📡 Accessible on your local network/Tailscale via your IP.');
  });
}
