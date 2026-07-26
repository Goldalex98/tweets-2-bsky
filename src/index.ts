import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppBskyRichtextFacet, type BskyAgent, RichText } from '@atproto/api';
import type { BlobRef } from '@atproto/api';
import { Scraper } from '@the-convocation/twitter-scraper';
import type { Tweet as ScraperTweet } from '@the-convocation/twitter-scraper';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as francModule from 'franc-min';
import iso6391 from 'iso-639-1';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { fetchPublicHttps } from './public-http-fetch.js';
import { isRestoreRestartRequired } from './backup-service.js';
import { resolveWebhookTarget, sendPinnedHttpsRequest } from './webhook.js';
import { applyTextCapabilities, generateAltText, isAltTextConfigured } from './ai-manager.js';
import { createBlueskyDigestDeliveryAdapter } from './adapters/bluesky-digest-delivery.js';
import { createBlueskyNormalizedDeliveryAdapter } from './adapters/bluesky-normalized-delivery.js';
import { contentSha256 } from './content-dedup.js';
import { evaluateContentPolicy } from './content-policy.js';
import {
  type DeliveryFallbackEvent,
  serializeDeliveryDiagnostics,
} from './delivery-diagnostics.js';
import { combinePerceptualHashes, computePerceptualHashes } from './media-dedup.js';
import { createRetainedCandidate, serializeRetainedCandidate } from './retained-candidate.js';

import {
  type AccountMapping,
  type AIConfig,
  type AppConfig,
  getConfig,
  saveConfig,
} from './config-manager.js';
import {
  getActiveTwitterUsernames,
  getCanonicalDestinationKey,
  findProcessedTweetDual,
  historyIdentityKeys,
  resolveDestinationStorageKey,
} from './mapping-helpers.js';
import {
  applyPostingPolicy,
  facetsForFirstChunk,
  splitPostText,
} from './post-transform.js';
import { assertProfileMutationAllowed, evaluateProfileMutation } from './profile-policy.js';
import { applyProfileMirrorSyncState, syncBlueskyProfileFromTwitter } from './profile-mirror.js';
import { parseRuntimeOptions } from './runtime-options.js';
import { CanonicalSourceSweepService } from './pipeline/source-sweep.js';
import {
  PipelineRunService,
  type EnqueueResult,
  type PolicyDecision,
} from './pipeline/run-service.js';
import { isBackfillStillRequested } from './pipeline/backfill-cancellation.js';
import {
  LEGACY_DELIVERY_POLICY,
  mergeSnapshotAiCredentials,
  recoveredRecordMatches,
  resolveDeliveryPolicy,
  type DeliveryPolicy,
} from './pipeline/delivery-policy.js';
import { evaluateSourceFilter, SOURCE_FILTER_POLICY_VERSION } from './source-filter.js';
import type { SourceFilterDecision } from './source-filter.js';
import { getSchedulerIntervalMinutes } from './scheduler-timing.js';
import {
  XRateGovernor,
  isAuthError,
  isRateLimitError,
  parseRateLimitResetMs,
} from './x-rate-limit.js';
import {
  buildPollNote,
  detectCardMedia,
  detectCarouselLinks,
  ensureSponsoredLinks,
  recoverCardData,
} from './tweet-cards.js';
import type { MediaEntity, TweetCard, TweetEntities } from './tweet-cards.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Type Definitions
// ============================================================================

interface ProcessedTweetEntry {
  uri?: string;
  cid?: string;
  root?: { uri: string; cid: string };
  tail?: { uri: string; cid: string };
  migrated?: boolean;
  skipped?: boolean;
  text?: string;
}

interface ProcessedTweetsMap {
  [twitterId: string]: ProcessedTweetEntry;
}

interface Tweet {
  id?: string;
  id_str?: string;
  text?: string;
  full_text?: string;
  created_at?: string;
  entities?: TweetEntities;
  extended_entities?: TweetEntities;
  quoted_status_id_str?: string;
  retweeted_status_id_str?: string;
  is_quote_status?: boolean;
  in_reply_to_status_id_str?: string;
  in_reply_to_status_id?: string;
  in_reply_to_user_id_str?: string;
  in_reply_to_user_id?: string;
  isRetweet?: boolean;
  isPin?: boolean;
  possibly_sensitive?: boolean;
  lang?: string;
  user?: {
    screen_name?: string;
    id_str?: string;
  };
  card?: TweetCard | null;
  permanentUrl?: string;
}

interface AspectRatio {
  width: number;
  height: number;
}

interface MockBlobRef {
  ref: { toString: () => string };
  mimeType: string;
  size: number;
}

type EmbedBlobRef = BlobRef | MockBlobRef;

interface ImageEmbed {
  alt: string;
  image: EmbedBlobRef;
  aspectRatio?: AspectRatio;
}

interface VideoJobStatus {
  state: string;
  progress?: number;
  blob?: BlobRef;
  error?: string;
}

interface VideoJobStatusResponse {
  jobStatus: VideoJobStatus;
}

interface VideoUploadResponse {
  jobId: string;
  state: string;
  blob?: BlobRef;
}

interface ExternalEmbedCard extends PostEmbed {
  $type: 'app.bsky.embed.external';
  external: {
    uri: string;
    title: string;
    description: string;
    thumb?: BlobRef;
  };
}

interface PdsServiceEntry {
  id?: string;
  type?: string;
  serviceEndpoint?: string;
}

interface DidDocument {
  service?: PdsServiceEntry[];
}

interface PostEmbed {
  $type: string;
  [key: string]: unknown;
}

interface StrongRef {
  uri: string;
  cid: string;
}

interface PostRecord extends Record<string, unknown> {
  text: string;
  facets?: AppBskyRichtextFacet.Main[];
  langs: string[];
  createdAt: string;
  embed?: PostEmbed;
  labels?: {
    $type: 'com.atproto.label.defs#selfLabels';
    values: Array<{ val: string }>;
  };
  reply?: {
    root: StrongRef;
    parent: StrongRef;
  };
}

interface PostResponse {
  uri: string;
  cid: string;
}

interface DryRunAgent {
  post(_record: Record<string, unknown>): Promise<PostResponse>;
  uploadBlob(_data: Uint8Array): Promise<{ data: { blob: MockBlobRef } }>;
  session: { did: string };
  com: {
    atproto: {
      repo: {
        describeRepo(): Promise<{ data: Record<string, unknown> }>;
      };
    };
  };
}

import {
  authRuntimeStateService,
  blueskyAccountRuntimeService,
  dbService,
  digestEntryService,
  digestJobService,
  deliveryCheckpointService,
  destinationLeaseService,
  duplicateFingerprintService,
  backfillJobService,
  parseSqliteUtcTimestampMs,
  postQueueService,
  runtimeStateService,
} from './db.js';
import {
  createPolicySnapshot,
  POLICY_SNAPSHOT_VERSION,
  parsePolicySnapshot,
  serializePolicySnapshot,
} from './policy-snapshot.js';
import type { BackfillJob, ProcessedTweetLookupEntry, QueueBatch } from './db.js';
import { metricsService } from './metrics.js';
import {
  normalizeXPost,
  type NormalizedPost,
} from './normalized-post.js';
import { notifyOperationsEvent } from './notification-service.js';
import { buildDigestPreview, nextDigestRun } from './digest.js';
import {
  type CorrelationContext,
  classifyQueueError,
  createStructuredLogger,
  sanitizedErrorMessage,
} from './observability.js';
import {
  DigestWorkerService,
} from './services/digest-worker-service.js';
import { NormalizedDeliveryService } from './services/normalized-delivery-service.js';
import {
  DestinationQueueWorkerService,
  recoverDestinationQueue,
  type QueueSettlement,
} from './services/queue-worker-service.js';
import { SchedulerService } from './services/scheduler-service.js';
import { XSourceSweepService } from './services/x-source-sweep-service.js';

// ============================================================================
// State Management
// ============================================================================

const PROCESSED_DIR = path.join(__dirname, '..', 'processed');

async function migrateJsonToSqlite() {
  if (!fs.existsSync(PROCESSED_DIR)) return;

  const files = fs.readdirSync(PROCESSED_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return;

  console.log(`📦 Found ${files.length} legacy cache files. Migrating to SQLite...`);
  const config = getConfig();

  for (const file of files) {
    const username = file.replace('.json', '').toLowerCase();
    // Try to find a matching bskyIdentifier from config
    const mapping = config.mappings.find((m) => m.twitterUsernames.map((u) => u.toLowerCase()).includes(username));
    const bskyIdentifier = mapping?.bskyIdentifier || 'unknown';

    try {
      const filePath = path.join(PROCESSED_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProcessedTweetsMap;

      for (const [twitterId, entry] of Object.entries(data)) {
        dbService.saveTweet({
          twitter_id: twitterId,
          twitter_username: username,
          bsky_identifier: bskyIdentifier,
          bsky_uri: entry.uri,
          bsky_cid: entry.cid,
          bsky_root_uri: entry.root?.uri,
          bsky_root_cid: entry.root?.cid,
          status: entry.migrated ? 'migrated' : entry.skipped ? 'skipped' : 'failed',
        });
      }
      // Move file to backup
      const backupDir = path.join(PROCESSED_DIR, 'backup');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
      fs.renameSync(filePath, path.join(backupDir, file));
    } catch (err) {
      console.error(`❌ Failed to migrate ${file}:`, err);
    }
  }

  // REPAIR STEP: Fix any 'unknown' records in SQLite that came from the broken schema migration
  for (const mapping of config.mappings) {
    for (const username of mapping.twitterUsernames) {
      dbService.repairUnknownIdentifiers(username, resolveDestinationStorageKey(mapping));
    }
  }

  console.log('✅ Migration complete.');
}

function loadProcessedTweets(bskyIdentifier: string): ProcessedTweetsMap {
  const entries = dbService.getTweetsByBskyIdentifier(bskyIdentifier);
  return Object.fromEntries(
    Object.entries(entries).map(([twitterId, entry]: [string, ProcessedTweetLookupEntry]) => {
      const root =
        entry.root?.uri && entry.root.cid
          ? { uri: entry.root.uri, cid: entry.root.cid }
          : undefined;
      if (entry.root?.uri && !entry.root.cid) {
        console.warn(
          `[${bskyIdentifier}] Skipping incomplete thread root for ${twitterId}: root URI present without CID.`,
        );
      }
      return [
        twitterId,
        {
          ...entry,
          root,
        },
      ];
    }),
  );
}

/** Union history under sticky storageKey and recomputed DID/handle aliases. Sticky wins on conflicts. */
function loadProcessedTweetsForDestination(mapping: AccountMapping): ProcessedTweetsMap {
  const merged: ProcessedTweetsMap = {};
  const sticky = resolveDestinationStorageKey(mapping);
  for (const key of historyIdentityKeys(mapping)) {
    if (key === sticky) continue;
    Object.assign(merged, loadProcessedTweets(key));
  }
  Object.assign(merged, loadProcessedTweets(sticky));
  return merged;
}

function saveProcessedTweet(
  twitterUsername: string,
  bskyIdentifier: string,
  twitterId: string,
  entry: ProcessedTweetEntry,
  mapping?: AccountMapping,
  sourceCreatedAt?: number,
  skipReason?: string,
  checkpointed = false,
  deliveryDiagnostics?: string,
): void {
  const config = getConfig();
  const source = config.sources.find((candidate) => candidate.username === twitterUsername.toLowerCase());
  const route = source
    ? config.routes.find((candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping?.id)
    : undefined;
  const record = {
    twitter_id: twitterId,
    twitter_username: twitterUsername.toLowerCase(),
    bsky_identifier: bskyIdentifier.toLowerCase(),
    source_type: 'x',
    external_post_id: twitterId,
    destination_id: mapping?.id ?? bskyIdentifier.toLowerCase(),
    route_id: mapping?.routeIdsByUsername?.[twitterUsername.toLowerCase()],
    source_id: source?.id,
    source_created_at: sourceCreatedAt,
    posted_at: entry.migrated ? Date.now() : undefined,
    skip_reason: entry.skipped ? skipReason ?? 'policy' : undefined,
    policy_version: SOURCE_FILTER_POLICY_VERSION,
    policy_snapshot: route ? JSON.stringify(route.filters) : undefined,
    tweet_text: entry.text,
    bsky_uri: entry.uri,
    bsky_cid: entry.cid,
    bsky_root_uri: entry.root?.uri,
    bsky_root_cid: entry.root?.cid,
    bsky_tail_uri: entry.tail?.uri,
    bsky_tail_cid: entry.tail?.cid,
    delivery_diagnostics: deliveryDiagnostics,
    status: entry.migrated || (entry.uri && entry.cid) ? 'migrated' : entry.skipped ? 'skipped' : 'failed',
  } as const;
  if (checkpointed && record.status === 'migrated') {
    deliveryCheckpointService.finalize(record);
  } else {
    dbService.saveTweet(record);
  }
}

function getTweetSourceCreatedAt(tweet: Tweet): number | undefined {
  const parsed = tweet.created_at ? Date.parse(tweet.created_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ============================================================================
// Custom Twitter Client
// ============================================================================

const scraperSessions = new Map<string, Scraper>();
const sessionCookies = new Map<string, { authToken: string; ct0: string }>();
let useBackupCredentials = false;
const lastCreatedAtByBsky = new Map<string, number>();
const SUBBRANCH_COUNT = 5;

// --- Pipeline tunables (env-overridable) ---
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw)) return Math.min(max, Math.max(min, Math.round(raw)));
  return fallback;
}

// How many timeline fetches run concurrently during a sweep. All sessions
// share one Twitter login, so the global scraper gap below is what actually
// bounds the request rate — this only hides per-request latency.
const FETCH_CONCURRENCY = envInt('FETCH_CONCURRENCY', 4, 1, 16);
// How many Bluesky accounts post from the queue at once. Media downloads can
// buffer hundreds of MB each, so keep this aligned with available RAM.
const POST_WORKER_CONCURRENCY = envInt('POST_WORKER_CONCURRENCY', 5, 1, 16);
// Pause between posted tweets within one account. Bluesky's own rate limit is
// ~1,666 posts/hour per account, so this is cosmetic pacing, not protection —
// and since it now runs inside a per-account worker it never delays others.
const POST_PACING_MIN_MS = envInt('POST_PACING_MIN_MS', 3000, 0, 120_000);
const POST_PACING_MAX_MS = Math.max(envInt('POST_PACING_MAX_MS', 8000, 0, 300_000), POST_PACING_MIN_MS);
// Retries per queued tweet before it is parked as failed (visible in the UI).
const QUEUE_MAX_ATTEMPTS = envInt('QUEUE_MAX_ATTEMPTS', 8, 1, 50);
const QUEUE_AGE_ALERT_MS = envInt('QUEUE_AGE_ALERT_MS', 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000);
// Spacing between Twitter API calls across the whole process, plus random
// jitter. Every timeline fetch and tweet lookup waits for a slot here.
const SCRAPER_MIN_GAP_MS = envInt('SCRAPER_MIN_GAP_MS', 800, 0, 60_000);
const SCRAPER_JITTER_MS = envInt('SCRAPER_JITTER_MS', 400, 0, 60_000);
// Sustained ceiling on X requests. Spacing alone only bounds burst rate, so a
// backfill storm or retry loop could still run hot for hours; X measures usage
// over ~15 minute windows, so the budget is enforced over the same shape.
const SCRAPER_WINDOW_MS = envInt('SCRAPER_WINDOW_MS', 15 * 60_000, 60_000, 60 * 60_000);
const SCRAPER_MAX_REQUESTS_PER_WINDOW = envInt('SCRAPER_MAX_REQUESTS_PER_WINDOW', 150, 1, 5_000);
// Applied when X reports a limit without telling us when it lifts.
const SCRAPER_COOLDOWN_BASE_MS = envInt('SCRAPER_COOLDOWN_BASE_MS', 30_000, 1_000, 60 * 60_000);
const SCRAPER_COOLDOWN_MAX_MS = envInt('SCRAPER_COOLDOWN_MAX_MS', 15 * 60_000, 1_000, 6 * 60 * 60_000);
// Upper bound on sources fetched in one sweep. Without this a large install
// fetches every due source back-to-back, which is the shape X flags.
const SCHEDULER_MAX_SOURCES_PER_SWEEP = envInt('SCHEDULER_MAX_SOURCES_PER_SWEEP', 25, 1, 10_000);
// Queue items claimed per destination batch.
const QUEUE_BATCH_MAX_ITEMS = envInt('QUEUE_BATCH_MAX_ITEMS', 50, 1, 500);
// Destination leases are renewed roughly once per second by the worker loop, so
// the TTL only has to outlive one slow batch plus a scheduling gap.
const DESTINATION_LEASE_TTL_MS = envInt('DESTINATION_LEASE_TTL_MS', 5 * 60_000, 10_000, 60 * 60_000);
// Identifies this process when taking destination leases and durable backfill
// claims, so a second replica can tell whose lock it is looking at.
const RUNTIME_OWNER_ID = `${process.env.HOSTNAME || 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;

const pipelineLogger = createStructuredLogger();

const logPipeline = (
  tag: 'Sweep' | 'Queue',
  message: string,
  isError = false,
  context: Partial<CorrelationContext> = {},
): void => {
  const logger = pipelineLogger.child({
    correlationId:
      context.correlationId ??
      context.sweepId ??
      context.requestId ??
      context.queueId ??
      `${tag.toLowerCase()}-${randomUUID()}`,
    ...context,
  });
  if (isError) logger.error(message, { subsystem: tag.toLowerCase() });
  else logger.info(message, { subsystem: tag.toLowerCase() });
};

const formatDurationMs = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
};

const xRateGovernor = new XRateGovernor({
  minGapMs: SCRAPER_MIN_GAP_MS,
  jitterMs: SCRAPER_JITTER_MS,
  maxRequestsPerWindow: SCRAPER_MAX_REQUESTS_PER_WINDOW,
  windowMs: SCRAPER_WINDOW_MS,
  cooldownBaseMs: SCRAPER_COOLDOWN_BASE_MS,
  cooldownMaxMs: SCRAPER_COOLDOWN_MAX_MS,
  onCooldown: ({ untilMs, consecutiveHits, fromHeader }) => {
    console.warn(
      `⏳ X reported a rate limit (hit ${consecutiveHits}). Pausing all X requests for ` +
        `${formatDurationMs(untilMs - Date.now())}${fromHeader ? ' (per response headers)' : ''}.`,
    );
  },
});

async function acquireScraperSlot(): Promise<void> {
  await xRateGovernor.acquire();
}

function getUniqueCreatedAtIso(bskyIdentifier: string, desiredMs: number): string {
  const key = bskyIdentifier.toLowerCase();
  const lastMs = lastCreatedAtByBsky.get(key) ?? Number.MIN_SAFE_INTEGER;
  const nextMs = Math.max(desiredMs, lastMs + 1);
  lastCreatedAtByBsky.set(key, nextMs);
  return new Date(nextMs).toISOString();
}

function getActiveTwitterCredentials(): { authToken: string; ct0: string } | null {
  const config = getConfig();
  let authToken = config.twitter.authToken;
  let ct0 = config.twitter.ct0;

  // Use backup if toggled
  if (useBackupCredentials && config.twitter.backupAuthToken && config.twitter.backupCt0) {
    authToken = config.twitter.backupAuthToken;
    ct0 = config.twitter.backupCt0;
  }

  if (!authToken || !ct0) return null;
  return { authToken, ct0 };
}

async function getTwitterScraper(sessionKey = 'default', forceReset = false): Promise<Scraper | null> {
  const credentials = getActiveTwitterCredentials();
  if (!credentials) return null;
  const { authToken, ct0 } = credentials;

  // Re-initialize if config changed, not yet initialized, or forced reset
  const existingScraper = scraperSessions.get(sessionKey);
  const existingCookies = sessionCookies.get(sessionKey);
  if (!existingScraper || forceReset || existingCookies?.authToken !== authToken || existingCookies?.ct0 !== ct0) {
    console.log(`🔄 Initializing Twitter scraper with ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} credentials...`);
    const scraper = new Scraper();
    await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);
    scraperSessions.set(sessionKey, scraper);
    sessionCookies.set(sessionKey, {
      authToken: authToken,
      ct0: ct0,
    });
  }
  return scraperSessions.get(sessionKey) ?? null;
}

async function switchCredentials() {
  const config = getConfig();
  if (config.twitter.backupAuthToken && config.twitter.backupCt0) {
    useBackupCredentials = !useBackupCredentials;
    console.log(`⚠️ Switching to ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} Twitter credentials...`);
    scraperSessions.clear();
    sessionCookies.clear();
    return true;
  }
  console.log('⚠️ No backup credentials available to switch to.');
  return false;
}

// Public web bearer token (stable since 2018), used by every browser session.
const TWITTER_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let cachedUserTweetsUrlTemplate: string | null | undefined;

// X dropped pinned_tweet_ids_str from the profile endpoint, so the only place
// the pinned tweet id still appears is the UserTweets timeline payload — which
// the scraper parses but does not expose. Read the request URL template from
// the installed scraper bundle (keeps queryId/features in sync with the
// package) so we can make the same call and extract the pin ourselves.
function getUserTweetsUrlTemplate(): string | null {
  if (cachedUserTweetsUrlTemplate !== undefined) return cachedUserTweetsUrlTemplate;
  cachedUserTweetsUrlTemplate = null;
  try {
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve('@the-convocation/twitter-scraper');
    const candidates = [entryPath, path.join(path.dirname(entryPath), '..', 'esm', 'index.mjs')];
    for (const candidate of candidates) {
      try {
        const source = fs.readFileSync(candidate, 'utf8');
        const match = source.match(/UserTweets:\s*["'](https:\/\/[^"']+)["']/);
        if (match?.[1]) {
          cachedUserTweetsUrlTemplate = match[1];
          break;
        }
      } catch {
        // try next candidate
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not read UserTweets endpoint from scraper bundle:', (err as Error).message);
  }
  return cachedUserTweetsUrlTemplate;
}

type PinnedTweetLookup = { ok: true; pinnedTweetId?: string } | { ok: false };

interface TimelineInstruction {
  type?: string;
  entry?: { entryId?: string };
}

interface PinnedTweetGraphqlResponse {
  data?: {
    user?: {
      result?: {
        timeline?: {
          timeline?: {
            instructions?: TimelineInstruction[];
          };
        };
      };
    };
  };
}

async function fetchPinnedTweetId(scraper: Scraper, username: string): Promise<PinnedTweetLookup> {
  // Preferred path, in case the scraper exposes it again in a future version
  try {
    await acquireScraperSlot();
    const profile = await scraper.getProfile(username);
    if (profile.pinnedTweetIds && profile.pinnedTweetIds.length > 0) {
      return { ok: true, pinnedTweetId: profile.pinnedTweetIds[0] };
    }
  } catch (err) {
    console.warn(`[${username}] ⚠️ Profile lookup failed during pin sync:`, (err as Error).message);
  }

  const urlTemplate = getUserTweetsUrlTemplate();
  const credentials = getActiveTwitterCredentials();
  if (!urlTemplate || !credentials) return { ok: false };

  try {
    await acquireScraperSlot();
    const userId = await scraper.getUserIdByScreenName(username);
    const url = urlTemplate.replace(/%22userId%22%3A%22\d+%22/, `%22userId%22%3A%22${userId}%22`);
    await acquireScraperSlot();
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        authorization: `Bearer ${TWITTER_WEB_BEARER}`,
        cookie: `auth_token=${credentials.authToken}; ct0=${credentials.ct0}`,
        'x-csrf-token': credentials.ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    const responseData = res.data as PinnedTweetGraphqlResponse;
    const instructions = responseData.data?.user?.result?.timeline?.timeline?.instructions ?? [];
    for (const instruction of instructions) {
      if (instruction?.type === 'TimelinePinEntry') {
        const match = String(instruction.entry?.entryId ?? '').match(/tweet-(\d+)/);
        if (match?.[1]) return { ok: true, pinnedTweetId: match[1] };
      }
    }

    // Fallback: the author's user object inside any tweet still carries the field
    const findAuthorPin = (node: unknown): string | undefined | null => {
      if (!node || typeof node !== 'object') return undefined;
      const record = node as Record<string, unknown>;
      const legacy =
        record.legacy && typeof record.legacy === 'object'
          ? (record.legacy as Record<string, unknown>)
          : undefined;
      if (record.rest_id === userId && legacy && Array.isArray(legacy.pinned_tweet_ids_str)) {
        const pinnedId = legacy.pinned_tweet_ids_str[0];
        if (typeof pinnedId === 'string') return pinnedId;
        if (typeof pinnedId === 'number') return String(pinnedId);
        return null; // null = author found, no pin
      }
      for (const value of Object.values(record)) {
        const found = findAuthorPin(value);
        if (found !== undefined) return found;
      }
      return undefined;
    };

    const found = findAuthorPin(res.data);
    if (found !== undefined) {
      return { ok: true, pinnedTweetId: found ?? undefined };
    }
    return { ok: false };
  } catch (err) {
    console.warn(`[${username}] ⚠️ Raw pinned-tweet lookup failed:`, (err as Error).message);
    return { ok: false };
  }
}

function mapScraperTweetToLocalTweet(scraperTweet: ScraperTweet): Tweet {
  const raw = scraperTweet.__raw_UNSTABLE;
  if (!raw) {
    // Fallback if raw data is missing (shouldn't happen for timeline tweets usually)
    return {
      id: scraperTweet.id,
      id_str: scraperTweet.id,
      text: scraperTweet.text,
      full_text: scraperTweet.text,
      isRetweet: scraperTweet.isRetweet,
      // Construct minimal entities from parsed data
      entities: {
        urls: scraperTweet.urls.map((url: string) => ({ url, expanded_url: url })),
        media: scraperTweet.photos.map((p) => ({
          url: p.url,
          expanded_url: p.url,
          media_url_https: p.url,
          type: 'photo',
          ext_alt_text: p.alt_text,
        })),
      },
      created_at: scraperTweet.timeParsed?.toUTCString(),
      permanentUrl: scraperTweet.permanentUrl,
      isPin: scraperTweet.isPin,
      possibly_sensitive: scraperTweet.sensitiveContent,
      lang:
        typeof (scraperTweet as unknown as { language?: unknown }).language === 'string'
          ? String((scraperTweet as unknown as { language?: unknown }).language)
          : undefined,
    };
  }

  const rawExtras = raw as typeof raw & {
    possibly_sensitive?: unknown;
    lang?: unknown;
    in_reply_to_user_id_str?: string;
    card?: TweetCard | null;
  };

  return {
    id: raw.id_str,
    id_str: raw.id_str,
    text: raw.full_text,
    full_text: raw.full_text,
    created_at: raw.created_at,
    isRetweet: scraperTweet.isRetweet,
    isPin: scraperTweet.isPin,
    possibly_sensitive: Boolean(rawExtras.possibly_sensitive) || scraperTweet.sensitiveContent,
    lang: typeof rawExtras.lang === 'string' ? rawExtras.lang : undefined,
    entities: raw.entities as unknown as TweetEntities,
    extended_entities: raw.extended_entities as unknown as TweetEntities,
    quoted_status_id_str: raw.quoted_status_id_str,
    retweeted_status_id_str: raw.retweeted_status_id_str,
    is_quote_status: !!raw.quoted_status_id_str,
    in_reply_to_status_id_str: raw.in_reply_to_status_id_str,
    in_reply_to_user_id_str: rawExtras.in_reply_to_user_id_str,
    card: rawExtras.card,
    permanentUrl: scraperTweet.permanentUrl,
    user: {
      screen_name: scraperTweet.username,
      id_str: scraperTweet.userId,
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

// Mirror Twitter's sensitive-media flags as Bluesky self labels. Per-media
// warnings map to specific labels; the tweet-level possibly_sensitive flag has
// no category, so it maps to the mildest adult label.
function buildSensitiveLabels(tweet: Tweet, mediaEntities: MediaEntity[]): string[] {
  const values = new Set<string>();
  for (const media of mediaEntities) {
    const warning = media.ext_sensitive_media_warning;
    if (!warning) continue;
    if (warning.adult_content) values.add('porn');
    if (warning.graphic_violence) values.add('graphic-media');
    if (warning.other) values.add('graphic-media');
  }
  if (values.size === 0 && tweet.possibly_sensitive) {
    values.add('sexual');
  }
  return [...values];
}

function addTextFallbacks(text: string): string {
  return text.replace(/\s+$/g, '').trim();
}

function getTweetText(tweet: Tweet): string {
  return tweet.full_text || tweet.text || '';
}

function normalizeContextText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function addTweetsToMap(tweetMap: Map<string, Tweet>, tweets: Tweet[]): void {
  for (const tweet of tweets) {
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;
    tweetMap.set(String(tweetId), tweet);
  }
}

function buildThreadContext(tweet: Tweet, tweetMap: Map<string, Tweet>, maxHops = 8): string {
  const parts: string[] = [];
  const visited = new Set<string>();
  let current: Tweet | undefined = tweet;

  for (let hops = 0; hops < maxHops; hops++) {
    const parentId = current?.in_reply_to_status_id_str || current?.in_reply_to_status_id;
    if (!parentId) break;
    const parentKey = String(parentId);
    if (visited.has(parentKey)) break;
    visited.add(parentKey);

    const parentTweet = tweetMap.get(parentKey);
    if (!parentTweet) break;

    const parentText = normalizeContextText(getTweetText(parentTweet));
    if (parentText) parts.push(parentText);

    current = parentTweet;
  }

  if (parts.length === 0) return '';
  return parts.reverse().join(' | ');
}

function buildAltTextContext(tweet: Tweet, tweetText: string, tweetMap: Map<string, Tweet>): string {
  const threadContext = buildThreadContext(tweet, tweetMap);
  const currentText = normalizeContextText(tweetText);

  if (threadContext && currentText) {
    return `Thread above: ${threadContext}. Current tweet: ${currentText}`;
  }

  if (threadContext) return `Thread above: ${threadContext}.`;
  return currentText;
}

function detectLanguage(text: string): string[] {
  if (!text || text.trim().length === 0) return ['en'];
  try {
    const code3 = (francModule as unknown as (text: string) => string)(text);
    if (code3 === 'und') return ['en'];
    const code2 = iso6391.getCode(code3);
    return code2 ? [code2] : ['en'];
  } catch {
    return ['en'];
  }
}

async function expandUrl(shortUrl: string): Promise<string> {
  try {
    const head = await fetchPublicHttps(shortUrl, {
      method: 'HEAD',
      timeoutMs: 10_000,
      maxRedirects: 5,
      maxResponseBytes: 8 * 1024,
    });
    return head.url || shortUrl;
  } catch {
    try {
      const get = await fetchPublicHttps(shortUrl, {
        method: 'GET',
        timeoutMs: 10_000,
        maxRedirects: 5,
        maxResponseBytes: 64 * 1024,
      });
      return get.url || shortUrl;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/too many redirects|private network|HTTPS|credentials/i.test(message)) {
        return shortUrl;
      }
      return shortUrl;
    }
  }
}

interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

// Hard cap on media downloads. Bluesky rejects videos over 300MB anyway, so
// anything larger aborts early (→ link fallback) instead of buffering gigabytes
// of RAM — with 5 subbranches downloading in parallel that risks OOM.
const MAX_MEDIA_DOWNLOAD_BYTES = 320 * 1024 * 1024;

async function downloadMedia(url: string, maxDurationMs = 120000): Promise<DownloadedMedia> {
  const resolved = await resolveWebhookTarget(url, false);
  const response = await sendPinnedHttpsRequest({
    target: resolved.target,
    ...(resolved.pinnedAddress ? { pinnedAddress: resolved.pinnedAddress } : {}),
    ...(resolved.family ? { family: resolved.family } : {}),
    method: 'GET',
    headers: { 'user-agent': 'tweets-2-bsky-media/1' },
    timeoutMs: Math.min(30_000, maxDurationMs),
    maxResponseBytes: MAX_MEDIA_DOWNLOAD_BYTES,
  });
  if (response.status !== 200) {
    throw new Error(`Media request returned HTTP ${response.status}.`);
  }
  return {
    buffer: response.body,
    mimeType: String(response.headers['content-type'] ?? 'application/octet-stream'),
  };
}

const BLOB_UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

async function uploadToBluesky(agent: BskyAgent, buffer: Buffer, mimeType: string): Promise<BlobRef> {
  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  // Bluesky accepts image blobs up to 2MB; stay slightly under for safety.
  const MAX_SIZE = 1900 * 1024;

  const isPng = mimeType === 'image/png';
  const isWebp = mimeType === 'image/webp';
  const isGif = mimeType === 'image/gif';
  const isAnimation = isGif || isWebp;

  if (
    (buffer.length > MAX_SIZE && (mimeType.startsWith('image/') || mimeType === 'application/octet-stream')) ||
    (isPng && buffer.length > MAX_SIZE)
  ) {
    console.log(`[UPLOAD] ⚖️ Image too large (${(buffer.length / 1024).toFixed(2)} KB). Optimizing...`);
    try {
      let image = sharp(buffer);
      const metadata = await image.metadata();
      let currentBuffer = buffer;
      let width = metadata.width || 2000;
      let quality = 95;

      // Iterative compression loop. With the 2MB ceiling we can afford to keep
      // media crisp: large dimensions, gentle quality steps, high quality floor.
      let attempts = 0;
      while (currentBuffer.length > MAX_SIZE && attempts < 5) {
        attempts++;
        console.log(`[UPLOAD] 📉 Compression attempt ${attempts}: Width ${width}, Quality ${quality}...`);

        let attemptMimeType: string;
        if (isAnimation) {
          // For animations (GIF/WebP), we can only do so much without losing frames.
          // Convert GIF to WebP for better compression, or re-encode WebP.
          image = sharp(buffer, { animated: true });
          // Resize if really big
          if (metadata.width && metadata.width > 1280) {
            image = image.resize({ width: 1280, withoutEnlargement: true });
          }
          image = image.webp({ quality, effort: 6 });
          attemptMimeType = 'image/webp';
          quality = Math.max(60, quality - 10);
        } else {
          // Static images
          if (width > 2560) width = 2560;
          else if (attempts > 1) width = Math.floor(width * 0.85);

          quality = Math.max(70, quality - 5);

          image = sharp(buffer).resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true });

          attemptMimeType = 'image/jpeg';
        }

        currentBuffer = await image.toBuffer();
        // Keep the smallest result so far, even if still above the limit.
        if (currentBuffer.length < finalBuffer.length) {
          finalBuffer = currentBuffer;
          finalMimeType = attemptMimeType;
        }
        if (currentBuffer.length <= MAX_SIZE) {
          console.log(`[UPLOAD] ✅ Optimized to ${(currentBuffer.length / 1024).toFixed(2)} KB`);
          break;
        }
      }
    } catch (err) {
      console.warn('[UPLOAD] ⚠️ Optimization failed:', (err as Error).message);
    }

    // Bluesky rejects image blobs over the embed size limit at post time; uploading
    // an oversized blob "succeeds" but leaves the tweet permanently failing. Bail out
    // instead so callers can fall back to the standard-quality image or skip this one.
    if (finalBuffer.length > MAX_SIZE) {
      throw new Error(
        `Image still ${(finalBuffer.length / 1024).toFixed(2)} KB after optimization (limit ${(MAX_SIZE / 1024).toFixed(0)} KB)`,
      );
    }
  }

  const { data } = await withTimeout(
    agent.uploadBlob(finalBuffer, { encoding: finalMimeType }),
    BLOB_UPLOAD_TIMEOUT_MS,
    `Blob upload timed out after ${Math.round(BLOB_UPLOAD_TIMEOUT_MS / 1000)}s`,
  );
  return data.blob;
}

interface ScreenshotResult {
  buffer: Buffer;
  width: number;
  height: number;
}

async function captureTweetScreenshot(tweetUrl: string): Promise<ScreenshotResult | null> {
  const browserPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  const executablePath = browserPaths.find((p) => fs.existsSync(p));

  if (!executablePath) {
    console.warn('[SCREENSHOT] ⏩ Skipping screenshot (no Chrome/Chromium found at common paths).');
    return null;
  }

  console.log(`[SCREENSHOT] 📸 Capturing screenshot for: ${tweetUrl} using ${executablePath}`);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 2 });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { 
            margin: 0; 
            padding: 20px; 
            background: #ffffff; 
            display: flex; 
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          }
          #container { width: 550px; }
        </style>
      </head>
      <body>
        <div id="container">
          <blockquote class="twitter-tweet" data-dnt="true">
            <a href="${tweetUrl}"></a>
          </blockquote>
          <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
        </div>
      </body>
      </html>
    `;

    // setContent only accepts document lifecycle events; the widget iframe is
    // waited for explicitly below, which is what actually matters here.
    await page.setContent(html, { waitUntil: 'load' });

    try {
      await page.waitForSelector('iframe', { timeout: 10000 });
      // Small extra wait for images inside iframe
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      console.warn('[SCREENSHOT] ⚠️ Timeout waiting for tweet iframe, taking screenshot anyway.');
    }

    const element = await page.$('#container');
    if (element) {
      const box = await element.boundingBox();
      const buffer = await element.screenshot({ type: 'png', omitBackground: true });
      if (box) {
        console.log(
          `[SCREENSHOT] ✅ Captured successfully (${(buffer.length / 1024).toFixed(2)} KB) - ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
        return { buffer: buffer as Buffer, width: Math.round(box.width), height: Math.round(box.height) };
      }
    }
  } catch (err) {
    console.error('[SCREENSHOT] ❌ Error capturing tweet:', (err as Error).message);
  } finally {
    if (browser) await browser.close();
  }
  return null;
}

async function pollForVideoProcessing(jobId: string): Promise<BlobRef> {
  console.log('[VIDEO] ⏳ Polling for processing completion (this can take a minute)...');
  let attempts = 0;
  let blob: BlobRef | undefined;

  while (!blob) {
    attempts++;
    const statusUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.getJobStatus');
    statusUrl.searchParams.append('jobId', jobId);

    let statusResponse: Response;
    try {
      statusResponse = await fetch(statusUrl, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
      console.warn(`[VIDEO] ⚠️ Job status fetch errored (${(err as Error).message}), retrying...`);
      if (attempts > 60) throw new Error('Video processing timed out after 5 minutes.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (!statusResponse.ok) {
      console.warn(`[VIDEO] ⚠️ Job status fetch failed (${statusResponse.status}), retrying...`);
      if (attempts > 60) throw new Error('Video processing timed out after 5 minutes.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    const statusData = (await statusResponse.json()) as VideoJobStatusResponse;
    const state = statusData.jobStatus.state;
    const progress = statusData.jobStatus.progress || 0;

    console.log(`[VIDEO] 🔄 Job ${jobId}: ${state} (${progress}%)`);

    if (statusData.jobStatus.blob) {
      blob = statusData.jobStatus.blob;
      console.log('[VIDEO] 🎉 Video processing complete! Blob ref obtained.');
    } else if (state === 'JOB_STATE_FAILED') {
      throw new Error(`Video processing failed: ${statusData.jobStatus.error || 'Unknown error'}`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    if (attempts > 60) {
      // ~5 minute timeout
      throw new Error('Video processing timed out after 5 minutes.');
    }
  }
  if (!blob) throw new Error('Video processing completed without a blob reference.');
  return blob;
}

async function fetchEmbedUrlCard(agent: BskyAgent, url: string): Promise<ExternalEmbedCard | null> {
  try {
    const response = await fetchPublicHttps(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeoutMs: 10_000,
      maxRedirects: 5,
      maxResponseBytes: 2 * 1024 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    const $ = cheerio.load(response.body.toString('utf8'));
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    const description =
      $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    let thumbBlob: BlobRef | undefined;

    let imageUrl = $('meta[property="og:image"]').attr('content');
    if (imageUrl) {
      if (!imageUrl.startsWith('http')) {
        const baseUrl = new URL(response.url || url);
        imageUrl = new URL(imageUrl, baseUrl.origin).toString();
      }
      try {
        const { buffer, mimeType } = await downloadMedia(imageUrl);
        thumbBlob = await uploadToBluesky(agent, buffer, mimeType);
      } catch {
        // Silently fail thumbnail upload
      }
    }

    if (!title && !description) return null;

    const external: ExternalEmbedCard['external'] = {
      uri: response.url || url,
      title: title || url,
      description: description,
    };

    if (thumbBlob) {
      external.thumb = thumbBlob;
    }

    return {
      $type: 'app.bsky.embed.external',
      external,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/too many redirects|private network|HTTPS|credentials/i.test(message)) {
      return null;
    }
    console.warn(`Failed to fetch embed card for ${url}:`, describeError(error));
    return null;
  }
}

async function uploadVideoToBluesky(agent: BskyAgent, buffer: Buffer, filename: string): Promise<BlobRef> {
  const sanitizedFilename = filename.split('?')[0] || 'video.mp4';
  console.log(
    `[VIDEO] 🟢 Starting upload process for ${sanitizedFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
  );

  try {
    // 1. Get Service Auth
    // We need to resolve the actual PDS host for this DID
    const did = agent.session?.did;
    if (!did) {
      throw new Error('Cannot upload video: Bluesky agent session is missing a DID.');
    }
    console.log(`[VIDEO] 🔍 Resolving PDS host for DID: ${did}...`);
    const { data: repoDesc } = await agent.com.atproto.repo.describeRepo({ repo: did });

    // didDoc might be present in repoDesc
    const didDoc = repoDesc.didDoc as DidDocument;
    const pdsService = didDoc.service?.find(
      (service) => service.id === '#atproto_pds' || service.type === 'AtProtoPds',
    );
    const pdsUrl = pdsService?.serviceEndpoint;
    const pdsHost = pdsUrl ? new URL(pdsUrl).host : 'bsky.social';

    console.log(`[VIDEO] 🌐 PDS Host detected: ${pdsHost}`);
    console.log(`[VIDEO] 🔑 Requesting service auth token for audience: did:web:${pdsHost}...`);

    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${pdsHost}`,
      lxm: 'com.atproto.repo.uploadBlob',
      exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });
    console.log('[VIDEO] ✅ Service auth token obtained.');

    const token = serviceAuth.token;

    // 2. Upload to Video Service
    const uploadUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo');
    uploadUrl.searchParams.append('did', did);
    uploadUrl.searchParams.append('name', sanitizedFilename);

    console.log(`[VIDEO] 📤 Uploading to ${uploadUrl.href}...`);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'video/mp4',
      },
      body: new Blob([new Uint8Array(buffer)]),
      // Videos can be up to ~300MB; allow a generous window but never hang forever.
      signal: AbortSignal.timeout(45 * 60 * 1000),
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();

      // Handle specific error cases
      try {
        const errorJson = JSON.parse(errorText);

        // Handle server overload gracefully
        if (
          uploadResponse.status === 503 ||
          errorJson.error === 'Server does not have enough capacity to handle uploads'
        ) {
          console.warn('[VIDEO] ⚠️ Server overloaded (503). Skipping video upload and falling back to link.');
          throw new Error('VIDEO_FALLBACK_503');
        }

        if (errorJson.error === 'already_exists' && errorJson.jobId) {
          console.log(`[VIDEO] ♻️ Video already exists. Resuming with Job ID: ${errorJson.jobId}`);
          return await pollForVideoProcessing(errorJson.jobId);
        }
        if (
          errorJson.error === 'unconfirmed_email' ||
          (errorJson.jobStatus && errorJson.jobStatus.error === 'unconfirmed_email')
        ) {
          console.error(
            '[VIDEO] 🛑 BLUESKY ERROR: Your email is unconfirmed. You MUST verify your email on Bluesky to upload videos.',
          );
          throw new Error('Bluesky Email Unconfirmed - Video Upload Rejected');
        }
      } catch (e) {
        if ((e as Error).message === 'VIDEO_FALLBACK_503') throw e;
        // Not JSON or missing fields, proceed with throwing original error
      }

      console.error(`[VIDEO] ❌ Server responded with ${uploadResponse.status}: ${errorText}`);
      throw new Error(`Video upload failed: ${uploadResponse.status} ${errorText}`);
    }

    const jobStatus = (await uploadResponse.json()) as VideoUploadResponse;
    console.log(`[VIDEO] 📦 Upload accepted. Job ID: ${jobStatus.jobId}, State: ${jobStatus.state}`);

    if (jobStatus.blob) {
      return jobStatus.blob;
    }

    // 3. Poll for processing status
    return await pollForVideoProcessing(jobStatus.jobId);
  } catch (err) {
    console.error('[VIDEO] ❌ Error in uploadVideoToBluesky:', (err as Error).message);
    throw err;
  }
}

function utf16IndexToUtf8Index(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function addTwitterHandleLinkFacets(
  text: string,
  facets?: AppBskyRichtextFacet.Main[],
): AppBskyRichtextFacet.Main[] | undefined {
  const existingFacets = facets ?? [];
  const newFacets: AppBskyRichtextFacet.Main[] = [];
  const regex = /@([A-Za-z0-9_]{1,15})/g;

  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const handle = match[1];
    if (!handle) continue;

    const atIndex = match.index;
    const prevChar = atIndex > 0 ? text[atIndex - 1] : '';
    if (prevChar && /[A-Za-z0-9_]/.test(prevChar)) continue;

    const endIndex = atIndex + handle.length + 1;
    const trailing = text.slice(endIndex);
    if (trailing.startsWith('.') && /^\.[A-Za-z0-9-]+/.test(trailing)) continue;

    const nextChar = endIndex < text.length ? text[endIndex] : '';
    if (nextChar && /[A-Za-z0-9_]/.test(nextChar)) continue;

    const byteStart = utf16IndexToUtf8Index(text, atIndex);
    const byteEnd = utf16IndexToUtf8Index(text, endIndex);

    const overlaps = existingFacets.some((facet) =>
      rangesOverlap(byteStart, byteEnd, facet.index.byteStart, facet.index.byteEnd),
    );
    if (overlaps) continue;

    newFacets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: 'app.bsky.richtext.facet#link',
          uri: `https://twitter.com/${handle}`,
        },
      ],
    });
  }

  if (newFacets.length === 0) return facets;
  return [...existingFacets, ...newFacets].sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// Uses the UserTweets endpoint (not Search) via the scraper's getTweets;
// processedIds allows the caller to stop early once already-seen tweets appear.
async function fetchUserTweets(
  username: string,
  limit: number,
  processedIds?: Set<string>,
  sessionKey = 'default',
  throwOnFailure = false,
): Promise<Tweet[]> {
  const client = await getTwitterScraper(sessionKey);
  if (!client) {
    if (throwOnFailure) throw new Error('Twitter credentials are unavailable.');
    return [];
  }

  let retries = 3;
  while (retries > 0) {
    try {
      await acquireScraperSlot();
      const tweets: Tweet[] = [];
      const generator = client.getTweets(username, limit);
      let consecutiveProcessedCount = 0;

      for await (const t of generator) {
        const tweet = mapScraperTweetToLocalTweet(t);
        const tweetId = tweet.id_str || tweet.id;

        // Early stopping logic: if we see 3 consecutive tweets we've already processed, stop.
        // This assumes timeline order (mostly true).
        if (processedIds && tweetId && processedIds.has(tweetId)) {
          consecutiveProcessedCount++;
          if (consecutiveProcessedCount >= 3) {
            console.log(`[${username}] 🛑 Found 3 consecutive processed tweets. Stopping fetch early.`);
            break;
          }
        } else {
          consecutiveProcessedCount = 0;
        }

        tweets.push(tweet);
        if (tweets.length >= limit) break;
      }
      const twitterConfig = getConfig().twitter;
      authRuntimeStateService.save({
        provider: 'twitter',
        configured: Boolean(twitterConfig.authToken && twitterConfig.ct0),
        activeSlot: useBackupCredentials ? 'backup' : 'primary',
        lastSuccessAt: Date.now(),
      });
      xRateGovernor.noteSuccess();
      return tweets;
    } catch (error: unknown) {
      retries--;

      // A rate limit is not a transient error: retrying through it is what
      // escalates X throttling into a suspended scraping account. Park every X
      // request until the advertised reset, and keep using the same credentials
      // — switching just spends the backup account's budget too.
      if (isRateLimitError(error)) {
        const resumesAt = xRateGovernor.noteRateLimited(parseRateLimitResetMs(error, Date.now()));
        console.warn(
          `⚠️ [${username}] X rate limit reached; retrying after ${formatDurationMs(resumesAt - Date.now())}.`,
        );
        if (retries > 0) continue;
      } else if (isAuthError(error)) {
        // Dead or challenged cookies never recover by retrying. Try the backup
        // slot once, otherwise surface the failure so the operator re-auths.
        console.warn(`⚠️ [${username}] X rejected the current credentials (${describeError(error)}).`);
        if (await switchCredentials()) {
          console.log('🔄 Retrying with backup credentials...');
          continue;
        }
        retries = 0;
      } else {
        const errorMessage = describeError(error);
        const responseStatus = axios.isAxiosError(error)
          ? error.response?.status
          : (error as { response?: { status?: number } })?.response?.status;
        const responseData = axios.isAxiosError(error)
          ? error.response?.data
          : (error as { response?: { data?: unknown } })?.response?.data;
        const transient =
          errorMessage.includes('ServiceUnavailable') ||
          errorMessage.includes('Timeout') ||
          (responseStatus === 400 &&
            JSON.stringify(responseData ?? {}).includes('InternalServerError'));
        if (transient && retries > 0) {
          const waitMs = 5000 * 2 ** (2 - retries);
          console.warn(
            `⚠️ [${username}] Transient X error (${errorMessage}). Retrying in ${formatDurationMs(waitMs)}.`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }

      console.warn(`Error fetching tweets for ${username}:`, describeError(error));
      const previousAuth = authRuntimeStateService.get('twitter');
      const category = classifyQueueError(error);
      authRuntimeStateService.save({
        provider: 'twitter',
        configured: Boolean(getConfig().twitter.authToken && getConfig().twitter.ct0),
        activeSlot: useBackupCredentials ? 'backup' : 'primary',
        lastSuccessAt: previousAuth?.lastSuccessAt,
        lastFailureAt: Date.now(),
        lastErrorCategory: category,
      });
      if (throwOnFailure) throw error;
      return [];
    }
  }

  console.log(`[${username}] ⚠️ Scraper returned 0 tweets (or failed silently) after retries.`);
  if (throwOnFailure) throw new Error(`Twitter fetch failed for @${username} after retries.`);
  return [];
}

// ============================================================================
// Main Processing Logic
// ============================================================================

// ============================================================================
// Main Processing Logic
// ============================================================================

const checkpointContentHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

async function postWithDeterministicRkey(
  agent: BskyAgent,
  mapping: AccountMapping,
  destinationId: string,
  externalPostId: string,
  chunkIndex: number,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  const rkey = createHash('sha256')
    .update(`${destinationId}\0${externalPostId}\0${chunkIndex}`)
    .digest('hex')
    .slice(0, 24);
  try {
    return await (agent.post as unknown as (
      post: Record<string, unknown>,
      options: { rkey: string },
    ) => Promise<{ uri: string; cid: string }>)(record, { rkey });
  } catch (error) {
    const message = sanitizedErrorMessage(error).toLowerCase();
    if (!message.includes('already') && !message.includes('exists')) throw error;
    const repo = agent.session?.did ?? mapping.bskyDid;
    if (!repo) throw error;
    const response = await agent.com.atproto.repo.getRecord({
      repo,
      collection: 'app.bsky.feed.post',
      rkey,
    });
    const cid = response.data?.cid;
    if (!cid) throw error;
    if (!recoveredRecordMatches(response.data?.value, record)) {
      throw new Error(
        `Refusing to adopt the existing record at rkey ${rkey}: its content does not match the post being delivered.`,
      );
    }
    return {
      uri: `at://${repo}/app.bsky.feed.post/${rkey}`,
      cid: String(cid),
    };
  }
}

async function processTweets(
  agent: BskyAgent,
  twitterUsername: string,
  bskyIdentifier: string,
  mapping: AccountMapping,
  tweets: Tweet[],
  dryRun = false,
  sharedProcessedMap?: ProcessedTweetsMap,
  sharedTweetMap?: Map<string, Tweet>,
  sessionKey = 'default',
  aiConfigOverride?: AIConfig,
  deliveryPolicy: DeliveryPolicy = LEGACY_DELIVERY_POLICY,
): Promise<void> {
  // Filter tweets to ensure they're actually from this user
  const filteredTweets = tweets.filter((t) => {
    const authorScreenName = t.user?.screen_name?.toLowerCase();
    if (authorScreenName && authorScreenName !== twitterUsername.toLowerCase()) {
      console.log(
        `[${twitterUsername}] ⏩ Skipping tweet ${t.id_str || t.id} - author is @${t.user?.screen_name}, not @${twitterUsername}`,
      );
      return false;
    }
    return true;
  });

  const tweetMap = sharedTweetMap ?? new Map<string, Tweet>();
  addTweetsToMap(tweetMap, filteredTweets);

  // Maintain a local map that updates in real-time for intra-batch replies
  const localProcessedMap: ProcessedTweetsMap =
    sharedProcessedMap ?? { ...loadProcessedTweetsForDestination(mapping) };

  const toProcess = filteredTweets.filter((t) => !localProcessedMap[t.id_str || t.id || '']);

  if (toProcess.length === 0) {
    console.log(`[${twitterUsername}] ✅ No new tweets to process for ${bskyIdentifier}.`);
    return;
  }

  console.log(`[${twitterUsername}] 🚀 Processing ${toProcess.length} new tweets for ${bskyIdentifier}...`);

  const mirrorJobId = `mirror:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  let mirroredCount = 0;

  filteredTweets.reverse();
  let count = 0;
  for (const tweet of filteredTweets) {
    count++;
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;

    if (localProcessedMap[tweetId]) continue;

    // Fallback to DB in case a nested backfill already saved this tweet.
    const dbRecord = findProcessedTweetDual(
      (twitterId, key) => dbService.getTweet(twitterId, key),
      tweetId,
      mapping,
    );
    if (dbRecord) {
      localProcessedMap[tweetId] = {
        uri: dbRecord.bsky_uri,
        cid: dbRecord.bsky_cid,
        root:
          dbRecord.bsky_root_uri && dbRecord.bsky_root_cid
            ? { uri: dbRecord.bsky_root_uri, cid: dbRecord.bsky_root_cid }
            : undefined,
        tail:
          dbRecord.bsky_tail_uri && dbRecord.bsky_tail_cid
            ? { uri: dbRecord.bsky_tail_uri, cid: dbRecord.bsky_tail_cid }
            : undefined,
        migrated: dbRecord.status === 'migrated',
        skipped: dbRecord.status === 'skipped',
      };
      continue;
    }

    const isRetweet = tweet.isRetweet || tweet.retweeted_status_id_str || tweet.text?.startsWith('RT @');

    if (isRetweet && !deliveryPolicy.allowReposts) {
      console.log(`[${twitterUsername}] ⏩ Skipping retweet ${tweetId}.`);
      if (!dryRun) {
        // Save as skipped so we don't check it again
        saveProcessedTweet(
          twitterUsername,
          bskyIdentifier,
          tweetId,
          { skipped: true, text: tweet.text },
          mapping,
          getTweetSourceCreatedAt(tweet),
          'policy-filter',
        );
        localProcessedMap[tweetId] = { skipped: true, text: tweet.text };
      }
      continue;
    }

    console.log(`\n[${twitterUsername}] 🔍 Inspecting tweet: ${tweetId}`);
    updateJob(mirrorJobId, {
      kind: 'mirroring',
      account: twitterUsername,
      target: bskyIdentifier,
      message: `Mirroring tweet ${tweetId}`,
      processedCount: mirroredCount,
      totalCount: toProcess.length,
    });
    updateAppStatus({
      state: 'processing',
      currentAccount: twitterUsername,
      processedCount: count,
      totalCount: filteredTweets.length,
      message: `Inspecting tweet ${tweetId}`,
    });

    const replyStatusId = tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id;
    const replyUserId = tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id;
    const tweetText = tweet.full_text || tweet.text || '';
    const isReply = !!replyStatusId || !!replyUserId || tweetText.trim().startsWith('@');

    let replyParentInfo: ProcessedTweetEntry | null = null;

    if (isReply) {
      if (replyStatusId && localProcessedMap[replyStatusId]) {
        console.log(`[${twitterUsername}] 🧵 Threading reply to post in ${bskyIdentifier}: ${replyStatusId}`);
        replyParentInfo = localProcessedMap[replyStatusId] ?? null;
      } else if (replyStatusId) {
        // Parent missing from local batch/DB. Attempt to fetch it if it's a self-thread.
        // We assume it's a self-thread if we don't have it, but we'll verify author after fetch.
        console.log(`[${twitterUsername}] 🕵️ Parent ${replyStatusId} missing. Checking if backfillable...`);

        let parentBackfilled = false;
        try {
          const scraper = await getTwitterScraper(sessionKey);
          if (scraper) {
            await acquireScraperSlot();
            const parentRaw = await scraper.getTweet(replyStatusId);
            if (parentRaw) {
              const parentTweet = mapScraperTweetToLocalTweet(parentRaw);
              const parentAuthor = parentTweet.user?.screen_name;

              if (parentAuthor?.toLowerCase() === twitterUsername.toLowerCase()) {
                console.log(`[${twitterUsername}] 🔄 Parent is ours (@${parentAuthor}). Backfilling parent first...`);
                addTweetsToMap(tweetMap, [parentTweet]);
                // Recursively process the parent
                await processTweets(
                  agent,
                  twitterUsername,
                  bskyIdentifier,
                  mapping,
                  [parentTweet],
                  dryRun,
                  localProcessedMap,
                  tweetMap,
                  sessionKey,
                );

                const savedParent = findProcessedTweetDual(
                  (twitterId, key) => dbService.getTweet(twitterId, key),
                  replyStatusId,
                  mapping,
                );
                if (savedParent && savedParent.status === 'migrated') {
                  localProcessedMap[replyStatusId] = {
                    uri: savedParent.bsky_uri,
                    cid: savedParent.bsky_cid,
                    root:
                      savedParent.bsky_root_uri && savedParent.bsky_root_cid
                        ? { uri: savedParent.bsky_root_uri, cid: savedParent.bsky_root_cid }
                        : undefined,
                    tail:
                      savedParent.bsky_tail_uri && savedParent.bsky_tail_cid
                        ? { uri: savedParent.bsky_tail_uri, cid: savedParent.bsky_tail_cid }
                        : undefined,
                    migrated: true,
                  };
                  replyParentInfo = localProcessedMap[replyStatusId] ?? null;
                  parentBackfilled = true;
                  console.log(`[${twitterUsername}] ✅ Parent backfilled. Resuming thread.`);
                }
              } else {
                console.log(`[${twitterUsername}] ⏩ Parent is by @${parentAuthor}. Skipping external reply.`);
              }
            }
          }
        } catch (e) {
          console.warn(`[${twitterUsername}] ⚠️ Failed to fetch/backfill parent ${replyStatusId}:`, e);
        }

        // An allowed external reply is mirrored as a standalone post: the parent
        // does not exist on Bluesky, so there is nothing to thread it onto.
        if (!parentBackfilled && !deliveryPolicy.allowExternalReplies) {
          console.log(`[${twitterUsername}] ⏩ Skipping external/unknown reply (Parent not found or external).`);
          if (!dryRun) {
            saveProcessedTweet(
              twitterUsername,
              bskyIdentifier,
              tweetId,
              { skipped: true, text: tweetText },
              mapping,
              getTweetSourceCreatedAt(tweet),
              'external-reply',
            );
            localProcessedMap[tweetId] = { skipped: true, text: tweetText };
          }
          continue;
        }
      } else if (!deliveryPolicy.allowExternalReplies) {
        console.log(`[${twitterUsername}] ⏩ Skipping external/unknown reply.`);
        if (!dryRun) {
          saveProcessedTweet(
            twitterUsername,
            bskyIdentifier,
            tweetId,
            { skipped: true, text: tweetText },
            mapping,
            getTweetSourceCreatedAt(tweet),
            'external-reply',
          );
          localProcessedMap[tweetId] = { skipped: true, text: tweetText };
        }
        continue;
      }
    }

    // Removed early dryRun continue to allow verifying logic

    let text = tweetText
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const deliveryFallbacks: DeliveryFallbackEvent[] = [];

    // 1. Link Expansion
    console.log(`[${twitterUsername}] 🔗 Expanding links...`);
    const urls = tweet.entities?.urls || [];
    for (const urlEntity of urls) {
      const tco = urlEntity.url;
      const expanded = urlEntity.expanded_url;
      if (tco && expanded) text = text.replace(tco, expanded);
    }

    // Fallback: Regex for t.co links (if entities failed or missed one)
    const tcoRegex = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
    const matches = text.match(tcoRegex) || [];
    // Media t.co links (photos/videos) live in entities.media, not entities.urls.
    // They must NOT be expanded here: the media is crossposted natively and the
    // cleanup below only knows the t.co form, so expanding would leave a stray
    // twitter.com/…/photo/1 link in the post text.
    const mediaTcoLinks = new Set(
      (tweet.extended_entities?.media || tweet.entities?.media || [])
        .map((media) => media.url)
        .filter(Boolean) as string[],
    );
    for (const tco of matches) {
      // Avoid re-resolving if we already handled it via entities
      if (urls.some((u) => u.url === tco)) continue;
      if (mediaTcoLinks.has(tco)) continue;

      console.log(`[${twitterUsername}] 🔍 Resolving fallback link: ${tco}`);
      const resolved = await expandUrl(tco);
      if (resolved !== tco) {
        text = text.replace(tco, resolved);
        // Add to urls array so it can be used for card embedding later
        urls.push({ url: tco, expanded_url: resolved });
      }
    }

    // Card check stage: recover card data (ads/branded media, polls) the scraper drops
    const { isSponsoredCard } = await recoverCardData(tweet);
    if (isSponsoredCard) {
      console.log(`[${twitterUsername}] 🧩 Sponsored/card payload detected. Card media injected.`);
    }

    // 2. Media Handling
    const images: ImageEmbed[] = [];
    let videoBlob: EmbedBlobRef | null = null;
    let videoAspectRatio: AspectRatio | undefined;
    const mediaEntities = tweet.extended_entities?.media || tweet.entities?.media || [];
    const mediaLinksToRemove: string[] = [];

    console.log(`[${twitterUsername}] 🖼️ Found ${mediaEntities.length} media entities.`);

    for (const media of mediaEntities) {
      if (media.url) {
        mediaLinksToRemove.push(media.url);
        if (media.expanded_url) {
          mediaLinksToRemove.push(media.expanded_url);
          mediaLinksToRemove.push(media.expanded_url.replace('twitter.com', 'x.com'));
        }
      }
      if (media.source === 'card' && media.media_url_https) {
        mediaLinksToRemove.push(media.media_url_https);
      }

      let aspectRatio: AspectRatio | undefined;
      if (media.sizes?.large) {
        aspectRatio = { width: media.sizes.large.w, height: media.sizes.large.h };
      } else if (media.original_info) {
        aspectRatio = { width: media.original_info.width, height: media.original_info.height };
      }

      if (media.type === 'photo') {
        const url = media.media_url_https;
        if (!url) continue;
        try {
          const highQualityUrl = url.includes('?') ? url.replace('?', ':orig?') : `${url}:orig`;
          console.log(`[${twitterUsername}] 📥 Downloading image (high quality): ${path.basename(highQualityUrl)}`);
          updateAppStatus({ message: 'Downloading high quality image...' });
          const { buffer, mimeType } = await downloadMedia(highQualityUrl);

          let blob: EmbedBlobRef;
          if (dryRun) {
            console.log(
              `[${twitterUsername}] 🧪 [DRY RUN] Would upload image (${(buffer.length / 1024).toFixed(2)} KB)`,
            );
            blob = { ref: { toString: () => 'mock-blob' }, mimeType, size: buffer.length };
          } else {
            console.log(`[${twitterUsername}] 📤 Uploading image to Bluesky...`);
            updateAppStatus({ message: 'Uploading image to Bluesky...' });
            blob = await uploadToBluesky(agent, buffer, mimeType);
          }

          let altText = media.ext_alt_text;
          if (!altText && isAltTextConfigured(mapping.aiOverrides, aiConfigOverride)) {
            console.log(`[${twitterUsername}] 🤖 Generating alt text via AI provider...`);
            // Use original tweet text for context, not the modified/cleaned one
            const altTextContext = buildAltTextContext(tweet, tweetText, tweetMap);
            altText = await generateAltText(buffer, mimeType, altTextContext, {
              overrides: mapping.aiOverrides,
              config: aiConfigOverride,
            });
            if (altText) console.log(`[${twitterUsername}] ✅ Alt text generated: ${altText.substring(0, 50)}...`);
          }

          images.push({ alt: altText || 'Image from Twitter', image: blob, aspectRatio });
          console.log(`[${twitterUsername}] ✅ Image uploaded.`);
        } catch (err) {
          console.error(`[${twitterUsername}] ❌ High quality upload failed:`, (err as Error).message);
          try {
            console.log(`[${twitterUsername}] 🔄 Retrying with standard quality...`);
            updateAppStatus({ message: 'Retrying with standard quality...' });
            const { buffer, mimeType } = await downloadMedia(url);
            const blob = await uploadToBluesky(agent, buffer, mimeType);
            images.push({ alt: media.ext_alt_text || 'Image from Twitter', image: blob, aspectRatio });
            console.log(`[${twitterUsername}] ✅ Image uploaded on retry.`);
          } catch (retryErr) {
            console.error(`[${twitterUsername}] ❌ Retry also failed:`, (retryErr as Error).message);
          }
        }
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const variants = media.video_info?.variants || [];
        const duration = media.video_info?.duration_millis || 0;

        if (duration > 180000) {
          // 3 minutes
          console.warn(`[${twitterUsername}] ⚠️ Video too long (${(duration / 1000).toFixed(1)}s). Fallback to link.`);
          const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
          if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
          deliveryFallbacks.push({
            kind: 'video-link',
            reason: `Video too long (${(duration / 1000).toFixed(1)}s)`,
          });
          continue;
        }

        const mp4s = variants
          .filter((v) => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (mp4s.length > 0) {
          const firstVariant = mp4s[0];
          if (firstVariant) {
            const videoUrl = firstVariant.url;
            try {
              console.log(`[${twitterUsername}] 📥 Downloading video: ${videoUrl}`);
              updateAppStatus({ message: `Downloading video: ${path.basename(videoUrl)}` });
              const { buffer } = await downloadMedia(videoUrl, 30 * 60 * 1000);

              // Bluesky accepts videos up to 300MB; stay slightly under for safety
              // (280MiB = ~293.6M bytes, under the limit on either MB interpretation).
              if (buffer.length <= 280 * 1024 * 1024) {
                const filename = videoUrl.split('/').pop() || 'video.mp4';
                if (dryRun) {
                  console.log(
                    `[${twitterUsername}] 🧪 [DRY RUN] Would upload video: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
                  );
                  videoBlob = {
                    ref: { toString: () => 'mock-video-blob' },
                    mimeType: 'video/mp4',
                    size: buffer.length,
                  };
                } else {
                  updateAppStatus({ message: 'Uploading video to Bluesky...' });
                  videoBlob = await uploadVideoToBluesky(agent, buffer, filename);
                }
                videoAspectRatio = aspectRatio;
                console.log(`[${twitterUsername}] ✅ Video upload process complete.`);
                break; // Prioritize first video
              }

              console.warn(
                `[${twitterUsername}] ⚠️ Video too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB). Fallback to link.`,
              );
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
              deliveryFallbacks.push({
                kind: 'video-link',
                reason: `Video too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`,
              });
            } catch (err) {
              const errMsg = (err as Error).message;
              if (errMsg !== 'VIDEO_FALLBACK_503') {
                console.error(`[${twitterUsername}] ❌ Failed video upload flow:`, errMsg);
              }
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
              deliveryFallbacks.push({
                kind: 'video-link',
                reason: errMsg === 'VIDEO_FALLBACK_503' ? 'Video processing unavailable (503)' : `Video upload failed: ${errMsg}`,
              });
            }
          }
        }
      }
    }

    // Cleanup text
    for (const link of mediaLinksToRemove) text = text.split(link).join('').trim();
    if (isSponsoredCard) {
      const cardLinks = detectCarouselLinks(tweet);
      const cardPrimaryLink = detectCardMedia(tweet).link;
      const requestedLinks = [cardPrimaryLink, ...cardLinks].filter(Boolean) as string[];
      for (const link of requestedLinks) {
        if (!urls.some((u) => u.expanded_url === link || u.url === link)) {
          urls.push({ url: link, expanded_url: link });
        }
      }
    }
    text = text.replace(/\n\s*\n/g, '\n\n').trim();
    text = addTextFallbacks(text);

    // 3. Quoting Logic
    let quoteEmbed: { $type: string; record: { uri: string; cid: string } } | null = null;
    let externalQuoteUrl: string | null = null;
    let linkCard: ExternalEmbedCard | null = null;

    if (tweet.is_quote_status && tweet.quoted_status_id_str) {
      const quoteId = tweet.quoted_status_id_str;
      const quoteRef = localProcessedMap[quoteId];
      if (quoteRef?.uri && quoteRef.cid) {
        console.log(`[${twitterUsername}] 🔄 Found quoted tweet in local history. Natively embedding.`);
        quoteEmbed = { $type: 'app.bsky.embed.record', record: { uri: quoteRef.uri, cid: quoteRef.cid } };
      } else {
        const quoteUrlEntity = urls.find((u) => u.expanded_url?.includes(quoteId));
        const qUrl = quoteUrlEntity?.expanded_url || `https://twitter.com/i/status/${quoteId}`;

        // Check if it's a self-quote (same user)
        const isSelfQuote =
          qUrl.toLowerCase().includes(`twitter.com/${twitterUsername.toLowerCase()}/`) ||
          qUrl.toLowerCase().includes(`x.com/${twitterUsername.toLowerCase()}/`);

        if (!isSelfQuote) {
          externalQuoteUrl = qUrl;
          console.log(`[${twitterUsername}] 🔗 Quoted tweet is external: ${externalQuoteUrl}`);

          // Try to capture screenshot for external QTs if we have space for images
          if (images.length < 4 && !videoBlob) {
            const ssResult = await captureTweetScreenshot(externalQuoteUrl);
            if (ssResult) {
              try {
                let blob: EmbedBlobRef;
                if (dryRun) {
                  console.log(
                    `[${twitterUsername}] 🧪 [DRY RUN] Would upload screenshot for quote (${(ssResult.buffer.length / 1024).toFixed(2)} KB)`,
                  );
                  blob = {
                    ref: { toString: () => 'mock-ss-blob' },
                    mimeType: 'image/png',
                    size: ssResult.buffer.length,
                  };
                } else {
                  blob = await uploadToBluesky(agent, ssResult.buffer, 'image/png');
                }
                images.push({
                  alt: `Quote Tweet: ${externalQuoteUrl}`,
                  image: blob,
                  aspectRatio: { width: ssResult.width, height: ssResult.height },
                });
                deliveryFallbacks.push({
                  kind: 'quote-screenshot',
                  reason: 'External quote screenshot attached',
                });
              } catch {
                console.warn(`[${twitterUsername}] ⚠️ Failed to upload screenshot blob.`);
              }
            }
          }
        } else {
          console.log(`[${twitterUsername}] 🔁 Quoted tweet is a self-quote, skipping link.`);
        }
      }
    } else if ((images.length === 0 && !videoBlob) || isSponsoredCard) {
      // If no media and no quote, check for external links to embed
      // We prioritize the LAST link found as it's often the main content
      const potentialLinks = urls
        .map((u) => u.expanded_url)
        .filter((u) => u && !u.includes('twitter.com') && !u.includes('x.com')) as string[];

      if (potentialLinks.length > 0) {
        const linkToEmbed = potentialLinks[potentialLinks.length - 1];
        if (linkToEmbed) {
          // Optimization: If text is too long, but removing the link makes it fit, do it!
          // The link will be present in the embed card anyway.
          if (text.length > 300 && text.includes(linkToEmbed)) {
            const lengthWithoutLink = text.length - linkToEmbed.length;
            // Allow some buffer (e.g. whitespace cleanup might save 1-2 chars)
            if (lengthWithoutLink <= 300) {
              console.log(
                `[${twitterUsername}] 📏 Optimizing: Removing link ${linkToEmbed} from text to avoid threading (Card will embed it).`,
              );
              text = text.replace(linkToEmbed, '').trim();
              // Clean up potential double punctuation/spaces left behind
              text = text.replace(/\s\.$/, '.').replace(/\s\s+/g, ' ');
            }
          }

          console.log(`[${twitterUsername}] 🃏 Fetching link card for: ${linkToEmbed}`);
          linkCard = await fetchEmbedUrlCard(agent, linkToEmbed);
        }
      }
    }

    // Only append link for external quotes IF we couldn't natively embed it OR screenshot it
    const hasScreenshot = images.some((img) => img.alt.startsWith('Quote Tweet:'));
    if (externalQuoteUrl && !quoteEmbed && !hasScreenshot && !text.includes(externalQuoteUrl)) {
      text += `\n\nQT: ${externalQuoteUrl}`;
      deliveryFallbacks.push({
        kind: 'quote-link',
        reason: images.length >= 4
          ? 'No image slots for quote screenshot'
          : videoBlob
            ? 'Quote screenshot skipped because video embed is present'
            : 'Quote screenshot unavailable; appended QT link',
      });
    }

    if (isSponsoredCard) {
      const hasCardImages = mediaEntities.some((media) => media.source === 'card');
      if (hasCardImages) {
        text = ensureSponsoredLinks(text, tweet);
      }
    }

    // Polls can't be mirrored on Bluesky — point readers at the original tweet.
    // If this pushes the text over the limit, splitText threads it automatically.
    const pollUrl = (tweet.permanentUrl || `https://x.com/${twitterUsername}/status/${tweetId}`).replace(
      'twitter.com',
      'x.com',
    );
    const pollNote = buildPollNote(tweet.card, pollUrl);
    if (pollNote && !text.includes(pollUrl)) {
      console.log(`[${twitterUsername}] Poll detected. Linking back to the original tweet.`);
      text = `${text}\n\n${pollNote}`.trim();
      deliveryFallbacks.push({ kind: 'poll-note', reason: 'Poll mirrored as text note with X link' });
    }
    // When a poll has no other embed, attach an external URL card for the status.
    if (pollNote && !quoteEmbed && !videoBlob && images.length === 0 && !linkCard) {
      console.log(`[${twitterUsername}] Attaching poll link card for ${pollUrl}`);
      linkCard = await fetchEmbedUrlCard(agent, pollUrl);
      if (linkCard) {
        deliveryFallbacks.push({ kind: 'poll-card', reason: 'Poll link card attached' });
      }
    }

    const aiTransformed = await applyTextCapabilities(text, {
      overrides: mapping.aiOverrides,
      config: aiConfigOverride,
    });
    text = aiTransformed.text;

    const transformed = applyPostingPolicy(text, mapping.postingPolicy, {
      twitterUsername,
      tweetId,
      originalPostUrl: pollUrl,
      destinationIdentifier: mapping.bskyIdentifier,
      sourceCount: mapping.twitterUsernames.length,
      isReply: Boolean(replyParentInfo),
      isThreadRoot: !replyParentInfo,
    });
    text = transformed.text;
    const deliveryDiagnosticsJson = serializeDeliveryDiagnostics(deliveryFallbacks);
    if (deliveryDiagnosticsJson && !dryRun) {
      try {
        postQueueService.setDeliveryDiagnostics(tweetId, bskyIdentifier, deliveryDiagnosticsJson);
      } catch {
        // Queue row may already be gone or not yet claimed; processed history still records diagnostics.
      }
    }

    // 4. Threading and Posting
    const chunks = splitPostText(text);
    console.log(`[${twitterUsername}] 📝 Splitting text into ${chunks.length} chunks.`);
    const preparedChunks = chunks.map((chunk, index) =>
      chunks.length > 1 ? `${chunk} (${index + 1}/${chunks.length})` : chunk,
    );
    const parsedCreatedAt = tweet.created_at ? Date.parse(tweet.created_at) : Number.NaN;
    const baseCreatedAtMs = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now();
    const checkpoints = dryRun
      ? []
      : deliveryCheckpointService.initialize(
          mapping.id,
          tweetId,
          preparedChunks.map((chunk, index) => ({
            contentHash: checkpointContentHash(chunk),
            createdAt: getUniqueCreatedAtIso(bskyIdentifier, baseCreatedAtMs + index * 1000),
          })),
        );
    const firstMissingChunk = dryRun
      ? 0
      : deliveryCheckpointService.firstMissing(mapping.id, tweetId);

    let lastPostInfo: ProcessedTweetEntry | null = replyParentInfo;

    // We will save the first chunk as the "Root" of this tweet, and the last chunk as the "Tail".
    let firstChunkInfo: { uri: string; cid: string; root?: { uri: string; cid: string } } | null = null;
    let lastChunkInfo: { uri: string; cid: string; root?: { uri: string; cid: string } } | null = null;

    for (const checkpoint of checkpoints.slice(0, firstMissingChunk)) {
      if (!checkpoint.uri || !checkpoint.cid) continue;
      const restored = {
        uri: checkpoint.uri,
        cid: checkpoint.cid,
        root: checkpoint.root,
        text: preparedChunks[checkpoint.chunkIndex],
      };
      if (checkpoint.chunkIndex === 0) firstChunkInfo = restored;
      lastChunkInfo = restored;
      lastPostInfo = restored;
    }

    for (let i = firstMissingChunk; i < preparedChunks.length; i++) {
      const chunk = preparedChunks[i] as string;

      console.log(`[${twitterUsername}] 📤 Posting chunk ${i + 1}/${chunks.length}...`);
      updateAppStatus({ message: `Posting chunk ${i + 1}/${chunks.length}...` });

      const rt = new RichText({ text: chunk });
      try {
        await withTimeout(rt.detectFacets(agent), 60000, 'Facet detection timed out');
      } catch (facetErr) {
        console.warn(
          `[${twitterUsername}] ⚠️ Facet detection failed, posting with basic text:`,
          (facetErr as Error).message,
        );
      }
      const policyFacets = facetsForFirstChunk(transformed.facets, rt.text, i);
      if (policyFacets.length > 0) {
        const detectedFacets = rt.facets ?? [];
        rt.facets = [
          ...policyFacets,
          ...detectedFacets.filter((facet) =>
            policyFacets.every(
              (policyFacet) =>
                !rangesOverlap(
                  policyFacet.index.byteStart,
                  policyFacet.index.byteEnd,
                  facet.index.byteStart,
                  facet.index.byteEnd,
                ),
            ),
          ),
        ];
      }
      rt.facets = addTwitterHandleLinkFacets(rt.text, rt.facets);
      const detectedLangs = detectLanguage(chunk);

      // Preserve original timing when available, but enforce monotonic per-account
      // timestamps to avoid equal-createdAt collisions in fast self-thread replies.
      const postRecord: PostRecord = {
        text: rt.text,
        facets: rt.facets,
        langs: detectedLangs,
        // CID is generated by the PDS from record content; unique createdAt keeps
        // near-simultaneous self-thread posts from colliding on identical payloads.
        createdAt:
          checkpoints[i]?.createdAt ??
          getUniqueCreatedAtIso(bskyIdentifier, baseCreatedAtMs + i * 1000),
      };

      if (i === 0) {
        if (videoBlob) {
          const videoEmbed: PostEmbed & {
            $type: 'app.bsky.embed.video';
            video: EmbedBlobRef;
            aspectRatio?: AspectRatio;
          } = {
            $type: 'app.bsky.embed.video',
            video: videoBlob,
          };
          if (videoAspectRatio) videoEmbed.aspectRatio = videoAspectRatio;
          if (quoteEmbed) {
            postRecord.embed = { $type: 'app.bsky.embed.recordWithMedia', media: videoEmbed, record: quoteEmbed };
          } else {
            postRecord.embed = videoEmbed;
          }
        } else if (images.length > 0) {
          const imagesEmbed = { $type: 'app.bsky.embed.images', images };
          if (quoteEmbed) {
            postRecord.embed = { $type: 'app.bsky.embed.recordWithMedia', media: imagesEmbed, record: quoteEmbed };
          } else {
            postRecord.embed = imagesEmbed;
          }
        } else if (quoteEmbed) {
          postRecord.embed = quoteEmbed;
        } else if (linkCard) {
          postRecord.embed = linkCard;
        }

        if (videoBlob || images.length > 0) {
          const sensitiveLabels = buildSensitiveLabels(tweet, mediaEntities);
          if (sensitiveLabels.length > 0) {
            console.log(`[${twitterUsername}] 🔞 Applying self labels: ${sensitiveLabels.join(', ')}`);
            postRecord.labels = {
              $type: 'com.atproto.label.defs#selfLabels',
              values: sensitiveLabels.map((val) => ({ val })),
            };
          }
        }
      }

      // Threading logic
      // Determine actual parent URI/CID to reply to
      let parentRef: { uri: string; cid: string } | null = null;
      let rootRef: { uri: string; cid: string } | null = null;

      if (lastPostInfo?.uri && lastPostInfo?.cid) {
        // If this is the start of a new tweet (i=0), check if parent has a tail
        if (i === 0 && lastPostInfo.tail) {
          parentRef = lastPostInfo.tail;
        } else {
          // Otherwise (intra-tweet or parent has no tail), use the main uri/cid (which is the previous post/chunk)
          parentRef = { uri: lastPostInfo.uri, cid: lastPostInfo.cid };
        }

        rootRef = lastPostInfo.root || { uri: lastPostInfo.uri, cid: lastPostInfo.cid };
      }

      if (parentRef && rootRef) {
        postRecord.reply = {
          root: rootRef,
          parent: parentRef,
        };
      }

      try {
        // Retry logic for network/socket errors
        let response: PostResponse | undefined;
        let retries = 3;

        if (dryRun) {
          console.log(`[${twitterUsername}] 🧪 [DRY RUN] Would post chunk ${i + 1}/${chunks.length}`);
          if (postRecord.embed) console.log(`   - With embed: ${postRecord.embed.$type}`);
          if (postRecord.reply) console.log(`   - As reply to: ${postRecord.reply.parent.uri}`);
          response = { uri: 'at://did:plc:mock/app.bsky.feed.post/mock', cid: 'mock-cid' };
        } else {
          while (retries > 0) {
            try {
              response = await withTimeout(
                postWithDeterministicRkey(agent, mapping, mapping.id, tweetId, i, postRecord),
                120000,
                'Post request timed out after 120s',
              );
              break;
            } catch (error: unknown) {
              retries--;
              if (retries === 0) throw error;
              console.warn(
                `[${twitterUsername}] ⚠️ Post failed (Socket/Network), retrying in 5s... (${retries} retries left)`,
              );
              await new Promise((r) => setTimeout(r, 5000));
            }
          }
        }

        if (!response) {
          throw new Error(`Posting chunk ${i + 1} completed without a response.`);
        }
        const currentPostInfo = {
          uri: response.uri,
          cid: response.cid,
          root: postRecord.reply ? postRecord.reply.root : { uri: response.uri, cid: response.cid },
          // Text is just the current chunk text
          text: chunk,
        };

        if (i === 0) firstChunkInfo = currentPostInfo;
        lastChunkInfo = currentPostInfo;
        lastPostInfo = currentPostInfo; // Update for next iteration

        if (!dryRun) {
          const parent = postRecord.reply?.parent as { uri: string; cid: string } | undefined;
          deliveryCheckpointService.recordSuccess({
            destinationId: mapping.id,
            externalPostId: tweetId,
            chunkIndex: i,
            uri: response.uri,
            cid: response.cid,
            root: currentPostInfo.root,
            parent,
            tail: { uri: response.uri, cid: response.cid },
          });
        }

        console.log(`[${twitterUsername}] ✅ Chunk ${i + 1} posted successfully.`);

        if (chunks.length > 1) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch (err) {
        console.error(`[${twitterUsername}] ❌ Failed to post ${tweetId} (chunk ${i + 1}):`, err);
        throw err;
      }
    }

    // Save to DB and Map
    if (firstChunkInfo && lastChunkInfo) {
      const entry: ProcessedTweetEntry = {
        uri: firstChunkInfo.uri,
        cid: firstChunkInfo.cid,
        root: firstChunkInfo.root,
        tail: { uri: lastChunkInfo.uri, cid: lastChunkInfo.cid }, // Save tail!
        text: tweetText,
      };

      if (!dryRun) {
        saveProcessedTweet(
          twitterUsername,
          bskyIdentifier,
          tweetId,
          entry,
          mapping,
          getTweetSourceCreatedAt(tweet),
          undefined,
          true,
          deliveryDiagnosticsJson,
        );
        runtimeStateService.recordDestinationEvent(mapping.id, 'post');
        localProcessedMap[tweetId] = entry; // Update local map for subsequent replies in this batch
      }
      mirroredCount++;
    }

    // Human-like pause between posts. This only delays the current account's
    // queue worker — other accounts keep posting in parallel.
    const wait = POST_PACING_MIN_MS + Math.floor(Math.random() * (POST_PACING_MAX_MS - POST_PACING_MIN_MS + 1));
    console.log(`[${twitterUsername}] 😴 Pacing: Waiting ${wait / 1000}s before next tweet.`);
    updateJob(mirrorJobId, {
      message: `Mirrored tweet ${tweetId}. Pacing ${Math.round(wait / 1000)}s before the next one`,
      processedCount: mirroredCount,
    });
    updateAppStatus({ state: 'pacing', message: `Pacing: Waiting ${wait / 1000}s...` });
    await new Promise((r) => setTimeout(r, wait));
  }

  updateJob(mirrorJobId, null);
}

import { getAgent, invalidateCachedAgentOnAuthFailure } from './bsky.js';

// ============================================================================
// Fetch Sweep + Post Queue Workers (daemon mode)
//
// The daemon splits work into two independent halves:
//   1. Fetch sweep — Twitter-side only. Checks every source account's
//      timeline (rate-limited by acquireScraperSlot) and drops new tweets
//      into the durable post_queue table. Fast and cheap, so the configured
//      check interval actually holds regardless of how much is being posted.
//   2. Post workers — Bluesky-side only. Drain the queue with writes
//      serialized per destination lease (threads stay ordered) while
//      different destinations run concurrently, so a slow video upload or a
//      long thread never delays other accounts.
// One-shot CLI modes (--run-once, --backfill-mapping, --import-history) also
// drain the durable queue after their sync; only --dry-run stays fully inline.
// ============================================================================

// Filters a fetched timeline down to enqueueable tweets and inserts them.
// Retweets are recorded as skipped immediately so they never occupy queue
// space; author-mismatch entries (stray timeline injections) are dropped.
function filterTweetForSource(
  tweet: Tweet,
  source: AppConfig['sources'][number],
  filters = source.filters,
  bypassFilters = false,
): SourceFilterDecision {
  return evaluateSourceFilter(
    filters,
    {
      text: tweet.full_text || tweet.text,
      language: tweet.lang,
      sensitive: tweet.possibly_sensitive,
      hasMedia: Boolean(tweet.extended_entities?.media?.length || tweet.entities?.media?.length),
      isRepost: Boolean(tweet.isRetweet || tweet.retweeted_status_id_str || (tweet.text || '').startsWith('RT @')),
      isQuote: Boolean(tweet.is_quote_status || tweet.quoted_status_id_str),
      isReply: Boolean(tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id),
      authorUsername: tweet.user?.screen_name,
      authorId: tweet.user?.id_str,
      replyToUserId: tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id,
      expectedSourceUsername: source.username,
    },
    { sourceEnabled: source.enabled, bypassFilters },
  );
}

function contentPolicyMetadataForTweet(tweet: Tweet, sourceUsername: string) {
  const media = tweet.extended_entities?.media || tweet.entities?.media || [];
  const mediaTypes = [
    ...new Set(
      media.map((entry) =>
        entry.type === 'photo' ? 'image' : entry.type === 'animated_gif' ? 'gif' : 'video',
      ),
    ),
  ] as Array<'image' | 'gif' | 'video'>;
  const isRepost = Boolean(tweet.isRetweet || tweet.retweeted_status_id_str || (tweet.text || '').startsWith('RT @'));
  const isQuote = Boolean(tweet.is_quote_status || tweet.quoted_status_id_str);
  const isReply = Boolean(tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id);
  const urls = ((tweet.entities as { urls?: Array<{ expanded_url?: string; url?: string }> } | undefined)?.urls ?? [])
    .map((entry) => entry.expanded_url || entry.url)
    .filter((entry): entry is string => Boolean(entry));
  const contentType: 'repost' | 'quote' | 'reply' | 'original' = isRepost
    ? 'repost'
    : isQuote
      ? 'quote'
      : isReply
        ? 'reply'
        : 'original';
  return {
    text: tweet.full_text || tweet.text || '',
    urls,
    sourceUsername,
    language: tweet.lang,
    sensitive: tweet.possibly_sensitive,
    contentType,
    mediaTypes: mediaTypes.length > 0 ? mediaTypes : (['none'] as Array<'none'>),
    createdAt: getTweetSourceCreatedAt(tweet),
  };
}

function imageMediaUrlsForTweet(tweet: Tweet): string[] {
  const media = tweet.extended_entities?.media || tweet.entities?.media || [];
  return [
    ...new Set(
      media
        .filter((entry) => entry.type === 'photo')
        .map((entry) => entry.media_url_https)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function enqueueTweetsForMapping(
  mapping: AccountMapping,
  twitterUsername: string,
  tweets: Tweet[],
  kind: 'scheduled' | 'backfill',
  requestId?: string,
  sourcePolicyAlreadyApplied = false,
): number {
  const inputs = [];
  const destinationStorageKey = resolveDestinationStorageKey(mapping);
  const config = getConfig();
  const source = config.sources.find((candidate) => candidate.username === twitterUsername.toLowerCase());
  const route = source
    ? config.routes.find((candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping.id)
    : undefined;
  const destination = config.destinations.find((candidate) => candidate.id === mapping.id);
  const policySnapshot =
    route && destination
      ? serializePolicySnapshot(createPolicySnapshot({ destination, route, ai: config.ai }))
      : undefined;
  if (source && route?.delivery?.mode === 'digest' && route.delivery.digest.enabled) {
    return tweets.reduce((count, tweet) => {
      try {
        const post = normalizeXPost(tweet as unknown as Record<string, unknown>, source.id, source.username);
        return (
          count +
          (digestEntryService.enqueue({
            destinationId: route.destinationId,
            routeId: route.id,
            post,
            policySnapshot,
          })
            ? 1
            : 0)
        );
      } catch {
        return count;
      }
    }, 0);
  }
  for (const tweet of tweets) {
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;
    const author = tweet.user?.screen_name?.toLowerCase();
    if (!sourcePolicyAlreadyApplied && author && author !== twitterUsername.toLowerCase()) continue;
    const isRetweet = tweet.isRetweet || tweet.retweeted_status_id_str || (tweet.text || '').startsWith('RT @');
    if (!sourcePolicyAlreadyApplied && isRetweet) {
      saveProcessedTweet(
        twitterUsername,
        destinationStorageKey,
        tweetId,
        { skipped: true, text: tweet.text },
        mapping,
        getTweetSourceCreatedAt(tweet),
        'retweet',
      );
      continue;
    }
    inputs.push({
      twitter_id: tweetId,
      bsky_identifier: destinationStorageKey,
      mapping_id: mapping.id,
      twitter_username: twitterUsername,
      source_type: 'x',
      external_post_id: tweetId,
      destination_id: mapping.id,
      route_id: mapping.routeIdsByUsername?.[twitterUsername.toLowerCase()],
      source_id: source?.id,
      source_created_at: getTweetSourceCreatedAt(tweet),
      policy_version: POLICY_SNAPSHOT_VERSION,
      policy_snapshot: policySnapshot,
      decision_version: 1,
      kind,
      request_id: requestId,
      tweet_json: JSON.stringify(tweet),
      tweet_text: (tweet.full_text || tweet.text || '').slice(0, 300),
    });
  }
  return postQueueService.enqueue(inputs);
}

// Sweep each eligible canonical source once, then fan out to destinations.
async function executeCanonicalXSourceSweep(
  config: AppConfig,
  eligibleSourceIds: ReadonlySet<string>,
  sweepId: string,
) {
  const fetchTimeoutMs = envInt('SWEEP_FETCH_TIMEOUT_MS', 180_000, 30_000, 1_800_000);
  const fetchedBySource = new Map<string, Tweet[]>();
  const errorsBySource = new Map<string, string>();
  const errorCategoriesBySource = new Map<string, ReturnType<typeof classifyQueueError>>();
  const queuedIdsByDestination = new Map<string, Set<string>>();
  const mediaHashByTweet = new Map<string, Promise<string | undefined>>();
  const rawTweetByPost = new Map<string, Tweet>();
  const mappingByDestination = new Map(config.mappings.map((mapping) => [mapping.id, mapping]));
  const service = new CanonicalSourceSweepService<Tweet, NormalizedPost>({
    fetch: async (source) => {
      const checkJobId = `check:${source.id}`;
      updateJob(checkJobId, {
        kind: 'checking',
        account: source.username,
        message: 'Checking for new tweets',
      });
      try {
        // Discovery must not use any destination's history for early stopping.
        const tweets = await withTimeout(
          fetchUserTweets(source.username, 50, undefined, `sweep-${source.id}`, true),
          fetchTimeoutMs,
          `[${source.username}] Sweep fetch timed out after ${Math.round(fetchTimeoutMs / 1000)}s`,
        );
        fetchedBySource.set(source.id, tweets);
        metricsService.increment('fetchSuccess');
        return tweets;
      } catch (error) {
        metricsService.increment('fetchFailure');
        const message = describeError(error);
        errorsBySource.set(source.id, message);
        errorCategoriesBySource.set(source.id, classifyQueueError(error));
        logPipeline('Sweep', `❌ Source fetch failed: ${message}`, true, {
          sweepId,
          sourceId: source.id,
        });
        if (classifyQueueError(error) === 'twitter-auth') {
          notifyOperationsEvent({
            event: 'twitter-auth-failure',
            occurredAt: new Date().toISOString(),
            message: 'X authentication failed during a source sweep.',
            details: { sourceId: source.id, category: 'twitter-auth' },
          });
        }
        return [];
      } finally {
        updateJob(checkJobId, null);
      }
    },
    normalize: (tweet, source) => {
      const normalized = normalizeXPost(tweet as unknown as Record<string, unknown>, source.id, source.username);
      rawTweetByPost.set(`${source.id}\0${normalized.externalId}`, tweet);
      return normalized;
    },
    identify: (post) => post.externalId,
    applySourcePolicy: (post, { source, route }) =>
      evaluateSourceFilter(route.filters, post, {
        sourceEnabled: source.enabled,
        expectedSourceUsername: source.username,
      }),
    applyRoutePolicy: (post, { destination, route }) =>
      evaluateContentPolicy(destination, route, post),
    isDestinationDuplicate: async (post, destination, route) => {
      const tweetId = post.externalId;
      let queued = queuedIdsByDestination.get(destination.id);
      if (!queued) {
        queued = postQueueService.getQueuedExternalPostIdSet(destination.id);
        queuedIdsByDestination.set(destination.id, queued);
      }
      if (queued.has(tweetId) || Boolean(dbService.getPost(tweetId, destination.id))) return true;
      const routePolicy = route.duplicateSuppression;
      const destinationPolicy = destination.duplicateSuppression;
      const policy = routePolicy.enabled ? routePolicy : destinationPolicy;
      if (!policy.enabled) return false;
      const fingerprint = contentSha256(post.text, post.urls);
      let imageHash: string | undefined;
      if (policy.perceptualImageHash) {
        let pending = mediaHashByTweet.get(tweetId);
        if (!pending) {
          pending = computePerceptualHashes(
            post.media.filter((media) => media.type === 'image').map((media) => media.url),
            { enabled: true },
          ).then((result) =>
            combinePerceptualHashes(result.hashes),
          );
          mediaHashByTweet.set(tweetId, pending);
        }
        imageHash = await pending;
      }
      return Boolean(
        duplicateFingerprintService.findRecent({
          destinationId: destination.id,
          routeId: route.id,
          routeScoped: routePolicy.enabled,
          textUrlHash: fingerprint,
          imageHash,
          since: Date.now() - policy.windowHours * 60 * 60 * 1000,
        }),
      );
    },
    persistSkip: (post, filterDecision, { source, destination, route }) => {
      metricsService.increment('policySkips');
      if (filterDecision.reason === 'duplicate-suppressed') {
        metricsService.increment('duplicateSuppressed');
      }
      const tweetId = post.externalId;
      if (!tweetId || dbService.getPost(tweetId, destination.id)) return;
      const retained = createRetainedCandidate({
        externalPostId: tweetId,
        metadata: {
          text: post.text,
          urls: post.urls,
          sourceUsername: source.username,
          language: post.language,
          sensitive: post.sensitive,
          contentType: post.repostOf ? 'repost' : post.quotedPost ? 'quote' : post.replyTo ? 'reply' : 'original',
          mediaTypes: post.media.map((media) => media.type),
          createdAt: Date.parse(post.createdAt),
        },
        mediaUrls: post.media.filter((media) => media.type === 'image').map((media) => media.url),
        sourcePayload: rawTweetByPost.get(`${source.id}\0${post.externalId}`) ?? post,
      });
      dbService.saveTweet({
        twitter_id: tweetId,
        twitter_username: source.username,
        bsky_identifier: destination.storageKey,
        source_type: 'x',
        external_post_id: tweetId,
        destination_id: destination.id,
        route_id: route.id,
        source_id: source.id,
        source_created_at: Date.parse(post.createdAt),
        skip_reason: filterDecision.reason,
        policy_version: POLICY_SNAPSHOT_VERSION,
        policy_snapshot: serializePolicySnapshot(createPolicySnapshot({ destination, route, ai: config.ai })),
        decision_version: filterDecision.decisionVersion ?? filterDecision.policyVersion ?? 1,
        decision_trace: filterDecision.trace ? JSON.stringify(filterDecision.trace) : undefined,
        retained_candidate_json: serializeRetainedCandidate(retained),
        retained_until: retained.expiresAt,
        tweet_text: post.text.slice(0, 300),
        status: 'skipped',
      });
    },
    enqueue: async (posts, { source, destination, route }) => {
      const mapping = mappingByDestination.get(destination.id);
      if (!mapping || posts.length === 0) return 0;
      const rawTweets = posts
        .map((post) => rawTweetByPost.get(`${source.id}\0${post.externalId}`))
        .filter((tweet): tweet is Tweet => Boolean(tweet));
      await maybeSyncPinnedTweetFromTimeline(mapping, source.username, rawTweets, false, getMappingLogPrefix(mapping));
      const policySnapshot = serializePolicySnapshot(createPolicySnapshot({ destination, route, ai: config.ai }));
      const digestMode = route.delivery?.mode === 'digest' && route.delivery.digest.enabled;
      const inserted = digestMode
        ? posts.reduce(
            (count, post) =>
              count +
              (digestEntryService.enqueue({
                destinationId: destination.id,
                routeId: route.id,
                post,
                policySnapshot,
              })
                ? 1
                : 0),
            0,
          )
        : enqueueTweetsForMapping(mapping, source.username, rawTweets, 'scheduled', undefined, true);
      const routePolicy = route.duplicateSuppression;
      const destinationPolicy = destination.duplicateSuppression;
      const policy = routePolicy.enabled ? routePolicy : destinationPolicy;
      if (policy.enabled && inserted > 0) {
        for (const post of posts) {
          duplicateFingerprintService.record({
            destinationId: destination.id,
            routeId: route.id,
            externalPostId: post.externalId,
            textUrlHash: contentSha256(post.text, post.urls),
            imageHash: await mediaHashByTweet.get(post.externalId),
          });
        }
      }
      const queued = queuedIdsByDestination.get(destination.id);
      for (const post of posts) {
        if (post.externalId) queued?.add(post.externalId);
      }
      return inserted;
    },
  });
  const sweep = await service.execute(config, eligibleSourceIds);
  return {
    sweep,
    attempts: config.sources
      .filter((source) => eligibleSourceIds.has(source.id) && source.id in sweep.fetchesBySource)
      .map((source) => {
        const tweets = fetchedBySource.get(source.id) ?? [];
        const newest = tweets[0];
        return {
          sourceId: source.id,
          success: !errorsBySource.has(source.id),
          foundPosts: tweets.length,
          newestPostId: newest ? String(newest.id_str || newest.id || '') || undefined : undefined,
          newestPostCreatedAt: newest ? getTweetSourceCreatedAt(newest) : undefined,
          errorCategory: errorCategoriesBySource.get(source.id),
          errorMessage: errorsBySource.get(source.id),
        };
      }),
  };
}

const xSourceSweepService = new XSourceSweepService({
  clock: { now: () => Date.now() },
  random: { next: () => Math.random() },
  requestBudget: (config) =>
    envInt(
      'SCHEDULER_REQUEST_BUDGET',
      Math.max(1, Math.min(config.sources.length, SCHEDULER_MAX_SOURCES_PER_SWEEP)),
      1,
      10_000,
    ),
  jitterRatio: () => envInt('SCHEDULER_JITTER_PERCENT', 10, 0, 50) / 100,
  queueAgeAlertMs: () => QUEUE_AGE_ALERT_MS,
  listSourceStates: () => runtimeStateService.listSources(),
  saveSourceState: (state) => runtimeStateService.saveSource(state),
  executeCanonical: executeCanonicalXSourceSweep,
  runHousekeeping: async (config) => {
    for (const mapping of config.mappings) {
      if (!mapping.enabled) continue;
      const logPrefix = getMappingLogPrefix(mapping);
      try {
        await maybeSyncMappingProfileInBackground(mapping, false, logPrefix);
        await maybeSyncPinnedTweetDaily(mapping, false, 'sweep-1', logPrefix);
      } catch (error) {
        console.error(`${logPrefix} ❌ Daily sync failed: ${describeError(error)}`);
      }
    }
  },
  getQueueCounts: () => postQueueService.getCounts(),
  incrementMetric: (name, amount = 1) => metricsService.increment(name, amount),
  notifyQueueAge: (ageMs, depth) =>
    notifyOperationsEvent({
      event: 'queue-age',
      occurredAt: new Date().toISOString(),
      message: 'The oldest queue item exceeded the configured age threshold.',
      details: { ageMs, depth },
    }),
  log: (message, isError, sweepId) =>
    logPipeline('Sweep', message, isError, { sweepId }),
  formatDuration: formatDurationMs,
  createSweepId: () => `sweep-${randomUUID()}`,
});

async function runFetchSweep(config: AppConfig): Promise<number> {
  return xSourceSweepService.run(config);
}

/**
 * Fetch phase of a queued backfill: pull history for one source account and hand
 * it to the post queue instead of posting inline.
 *
 * Runs through `PipelineRunService` so backfill shares one orchestration
 * contract (fetch → normalize → policy → enqueue → deliver) with the other run
 * modes, and so failures surface to the caller instead of being swallowed —
 * swallowing them is what let a transient error complete a lost backfill.
 */
async function fetchAndEnqueueBackfill(
  mapping: AccountMapping,
  twitterUsername: string,
  limit: number,
  ignoreCancellation: boolean,
  requestId: string | undefined,
  sessionKey: string,
): Promise<void> {
  const backfillJobId = `backfill:${mapping.bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  updateJob(backfillJobId, {
    kind: 'backfilling',
    account: twitterUsername,
    target: mapping.bskyIdentifier,
    mappingId: mapping.id,
    message: `Fetching up to ${limit || 100} tweets from the timeline`,
  });

  const initialConfig = getConfig();
  const backfillSource = initialConfig.sources.find(
    (candidate) => candidate.username === twitterUsername.toLowerCase(),
  );
  const backfillRoute = backfillSource
    ? initialConfig.routes.find(
        (candidate) => candidate.sourceId === backfillSource.id && candidate.destinationId === mapping.id,
      )
    : undefined;
  // Perceptual hashes computed while judging policy, reused when the accepted
  // tweets are recorded as fingerprints. Scoped to this run so concurrent
  // backfills cannot consume each other's entries.
  const mediaHashes = new Map<string, string | undefined>();
  const runService = new PipelineRunService<Tweet, Tweet>({
    clock: { now: () => Date.now() },
    fetch: (request) =>
      fetchBackfillTimeline(
        mapping,
        twitterUsername,
        request.limit ?? 100,
        ignoreCancellation,
        requestId,
        sessionKey,
      ),
    normalize: (raw) => raw,
    applyPolicy: (candidates) => applyBackfillPolicy(mapping, twitterUsername, candidates, mediaHashes),
    enqueue: async (candidates) =>
      enqueueBackfillCandidates(mapping, twitterUsername, candidates, requestId, mediaHashes),
    // Queue-mode backfill never posts inline; the durable post workers deliver.
    deliver: async () => 0,
  });

  try {
    await runService.execute({
      mode: 'backfill',
      sourceId: backfillSource?.id ?? twitterUsername.toLowerCase(),
      destinationId: mapping.id,
      routeId: backfillRoute?.id ?? '',
      limit: limit || 100,
    });
  } finally {
    updateJob(backfillJobId, null);
  }
}

async function fetchBackfillTimeline(
  mapping: AccountMapping,
  twitterUsername: string,
  fetchLimit: number,
  ignoreCancellation: boolean,
  requestId: string | undefined,
  sessionKey: string,
): Promise<Tweet[]> {
  const client = await getTwitterScraper(sessionKey);
  if (!client) {
    throw new Error(`[${twitterUsername}] Twitter credentials are not set; cannot backfill.`);
  }

  const seenIds = new Set(Object.keys(loadProcessedTweetsForDestination(mapping)));
  for (const key of historyIdentityKeys(mapping)) {
    for (const id of postQueueService.getQueuedIdSet(key)) {
      seenIds.add(id);
    }
  }

  const found: Tweet[] = [];
  await acquireScraperSlot();
  const generator = client.getTweets(twitterUsername, fetchLimit);
  for await (const scraperTweet of generator) {
    if (!ignoreCancellation) {
      if (!backfillStillRequested(mapping.id, requestId)) {
        console.log(`[${twitterUsername}] 🛑 Backfill cancelled.`);
        return found;
      }
    }
    const tweet = mapScraperTweetToLocalTweet(scraperTweet);
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId || seenIds.has(tweetId)) continue;
    seenIds.add(tweetId);
    found.push(tweet);
    if (found.length >= fetchLimit) break;
  }
  return found;
}

async function applyBackfillPolicy(
  mapping: AccountMapping,
  twitterUsername: string,
  found: readonly Tweet[],
  mediaHashByTweet: Map<string, string | undefined>,
): Promise<PolicyDecision<Tweet>> {
  const destinationStorageKey = resolveDestinationStorageKey(mapping);
  const config = getConfig();
  const source = config.sources.find((candidate) => candidate.username === twitterUsername.toLowerCase());
  const route = source
    ? config.routes.find(
        (candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping.id,
      )
    : undefined;
  const destination = config.destinations.find((candidate) => candidate.id === mapping.id);
  const accepted: Tweet[] = [];
  const skipped: Array<{ candidate: Tweet; reason: string }> = [];
  for (const tweet of found) {
      const filterDecision = source
        ? filterTweetForSource(tweet, source, route?.filters ?? source.filters)
        : ({ allowed: false, reason: 'source-disabled', policyVersion: SOURCE_FILTER_POLICY_VERSION } as const);
      const tweetId = String(tweet.id_str || tweet.id || '');
      const contentDecision =
        filterDecision.allowed && destination && route
          ? evaluateContentPolicy(
              destination,
              route,
              contentPolicyMetadataForTweet(tweet, twitterUsername),
            )
          : undefined;
      const effectiveDecision = filterDecision.allowed ? contentDecision : filterDecision;
      if (filterDecision.allowed && !contentDecision) {
        accepted.push(tweet);
        continue;
      }
      if (effectiveDecision?.allowed) {
        const routePolicy = route?.duplicateSuppression;
        const destinationPolicy = destination?.duplicateSuppression;
        const dedupPolicy = routePolicy?.enabled ? routePolicy : destinationPolicy;
        const metadata = contentPolicyMetadataForTweet(tweet, twitterUsername);
        const imageHash =
          dedupPolicy?.enabled && dedupPolicy.perceptualImageHash
            ? combinePerceptualHashes(
                (await computePerceptualHashes(imageMediaUrlsForTweet(tweet), { enabled: true })).hashes,
              )
            : undefined;
        mediaHashByTweet.set(tweetId, imageHash);
        const duplicate =
          dedupPolicy?.enabled && destination && route
            ? Boolean(
                duplicateFingerprintService.findRecent({
                  destinationId: destination.id,
                  routeId: route.id,
                  routeScoped: routePolicy?.enabled,
                  textUrlHash: contentSha256(metadata.text, metadata.urls),
                  imageHash,
                  since: Date.now() - dedupPolicy.windowHours * 60 * 60 * 1000,
                }),
              )
            : false;
        if (!duplicate) {
          accepted.push(tweet);
          continue;
        }
      }
      if (tweetId && destination && route) {
        const metadata = contentPolicyMetadataForTweet(tweet, twitterUsername);
        const retained = createRetainedCandidate({
          externalPostId: tweetId,
          metadata,
          mediaUrls: imageMediaUrlsForTweet(tweet),
          sourcePayload: tweet,
        });
        dbService.saveTweet({
          twitter_id: tweetId,
          twitter_username: twitterUsername,
          bsky_identifier: destinationStorageKey,
          source_type: 'x',
          external_post_id: tweetId,
          destination_id: destination.id,
          route_id: route.id,
          source_id: source?.id,
          source_created_at: getTweetSourceCreatedAt(tweet),
          skip_reason: effectiveDecision?.allowed ? 'duplicate-suppressed' : effectiveDecision?.reason,
          policy_version: POLICY_SNAPSHOT_VERSION,
          policy_snapshot: serializePolicySnapshot(createPolicySnapshot({ destination, route, ai: config.ai })),
          decision_version:
            'decisionVersion' in (effectiveDecision ?? {})
              ? (effectiveDecision as { decisionVersion?: number }).decisionVersion
              : filterDecision.policyVersion,
          decision_trace:
            effectiveDecision && 'trace' in effectiveDecision
              ? JSON.stringify((effectiveDecision as { trace?: unknown[] }).trace)
              : undefined,
          retained_candidate_json: serializeRetainedCandidate(retained),
          retained_until: retained.expiresAt,
          tweet_text: (tweet.full_text || tweet.text || '').slice(0, 300),
          status: 'skipped',
        });
      }
      skipped.push({
        candidate: tweet,
        reason: effectiveDecision?.allowed ? 'duplicate-suppressed' : (effectiveDecision?.reason ?? 'skipped'),
      });
  }
  return { accepted, skipped };
}

async function enqueueBackfillCandidates(
  mapping: AccountMapping,
  twitterUsername: string,
  accepted: readonly Tweet[],
  requestId: string | undefined,
  mediaHashByTweet: Map<string, string | undefined>,
): Promise<EnqueueResult> {
  const config = getConfig();
  const source = config.sources.find((candidate) => candidate.username === twitterUsername.toLowerCase());
  const route = source
    ? config.routes.find(
        (candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping.id,
      )
    : undefined;
  const destination = config.destinations.find((candidate) => candidate.id === mapping.id);
  const queued = enqueueTweetsForMapping(
    mapping,
    twitterUsername,
    [...accepted],
    'backfill',
    requestId,
    true,
  );
  const routeDedup = route?.duplicateSuppression;
  const destinationDedup = destination?.duplicateSuppression;
  if (queued > 0 && destination && route && (routeDedup?.enabled || destinationDedup?.enabled)) {
    for (const tweet of accepted) {
      const metadata = contentPolicyMetadataForTweet(tweet, twitterUsername);
      duplicateFingerprintService.record({
        destinationId: destination.id,
        routeId: route.id,
        externalPostId: String(tweet.id_str || tweet.id || ''),
        textUrlHash: contentSha256(metadata.text, metadata.urls),
        imageHash: mediaHashByTweet.get(String(tweet.id_str || tweet.id || '')),
      });
    }
  }
  mediaHashByTweet.clear();
  console.log(`[${twitterUsername}] 📬 Backfill queued ${queued} tweet(s) for ${mapping.bskyIdentifier}.`);
  return {
    inserted: queued,
    queueIds: postQueueService.getQueueIds({
      destinationId: mapping.id,
      ...(requestId ? { requestId } : {}),
    }),
  };
}

// --- Post workers ---

const activePostDestinations = new Set<string>();

function queueBatchTimeoutMs(itemCount: number): number {
  // Pacing plus media work make big batches legitimately slow; scale the
  // watchdog with batch size so it only catches genuine hangs.
  return Math.max(resolveScheduledAccountTimeoutMs(), itemCount * 120_000);
}

const normalizedDeliveryService = new NormalizedDeliveryService({
  clock: { now: () => Date.now() },
  findProcessedReply: (post, destinationId) =>
    post.replyTo
      ? dbService.getPostForSource(
          post.replyTo.externalId,
          destinationId,
          post.replyTo.sourceType,
          post.replyTo.sourceId,
        )
      : null,
  checkpoints: {
    initialize: (destinationId, externalPostId, chunks) =>
      deliveryCheckpointService.initialize(destinationId, externalPostId, chunks),
    list: (destinationId, externalPostId) => deliveryCheckpointService.list(destinationId, externalPostId),
    recordSuccess: (input) => deliveryCheckpointService.recordSuccess(input),
    finalize: (record, checkpointExternalPostId) =>
      deliveryCheckpointService.finalize(record, checkpointExternalPostId),
  },
});

async function deliverNormalizedQueueItems(
  agent: BskyAgent,
  mapping: AccountMapping,
  batch: QueueBatch,
): Promise<void> {
  await normalizedDeliveryService.deliver(
    createBlueskyNormalizedDeliveryAdapter({
      agent,
      uploadImage: (buffer, mimeType) => uploadToBluesky(agent, buffer, mimeType),
      uploadVideo: (buffer, filename) => uploadVideoToBluesky(agent, buffer, filename),
      publish: ({ destinationId, externalPostId, chunkIndex, record }) =>
        postWithDeterministicRkey(
          agent,
          mapping,
          destinationId,
          externalPostId,
          chunkIndex,
          record,
        ),
    }),
    batch,
  );
}

async function deliverPostBatch(mapping: AccountMapping, batch: QueueBatch, sessionKey: string): Promise<void> {
  const snapshot = parsePolicySnapshot(batch.items[0]?.policy_snapshot);
  const effectiveMapping: AccountMapping = snapshot
    ? {
        ...mapping,
        bskyServiceUrl: snapshot.delivery.serviceUrl,
        postingPolicy: snapshot.posting,
        aiOverrides: snapshot.ai.overrides,
      }
    : mapping;
  const currentAi = getConfig().ai;
  const effectiveAiConfig = mergeSnapshotAiCredentials(
    snapshot?.ai ?? { overrides: mapping.aiOverrides, ...currentAi },
    currentAi,
  );
  const deliveryPolicy: DeliveryPolicy = resolveDeliveryPolicy({
    ...(snapshot ? { snapshot } : {}),
    ...(batch.route_id
      ? { routeFilters: getConfig().routes.find((candidate) => candidate.id === batch.route_id)?.filters }
      : {}),
  });
  const logPrefix = getMappingLogPrefix(effectiveMapping);
  const agent = await getAgent(effectiveMapping);
  if (!agent) {
    notifyOperationsEvent({
      event: 'bsky-auth-failure',
      occurredAt: new Date().toISOString(),
      message: 'Bluesky authentication failed for a destination worker.',
      details: { destinationId: effectiveMapping.id, category: 'bsky-auth' },
    });
    throw new Error('Bluesky login failed');
  }
  runtimeStateService.recordDestinationEvent(effectiveMapping.id, 'login');

  if (batch.items.every((item) => item.source_type !== 'x')) {
    await withTimeout(
      deliverNormalizedQueueItems(agent, effectiveMapping, batch),
      queueBatchTimeoutMs(batch.items.length),
      `[${batch.twitter_username}] Generic posting batch timed out`,
    );
  } else {
    const tweets: Tweet[] = [];
    for (const item of batch.items) {
      try {
        tweets.push(JSON.parse(item.tweet_json) as Tweet);
      } catch {
        console.error(`${logPrefix} ⚠️ Corrupt queued payload for tweet ${item.twitter_id}; it will be retried out.`);
      }
    }

    // Queue batches arrive oldest-first; processTweets expects timeline order
    // (newest first) and reverses internally.
    tweets.reverse();

    await withTimeout(
      processTweets(
        agent,
        batch.twitter_username,
        batch.bsky_identifier,
        effectiveMapping,
        tweets,
        false,
        undefined,
        undefined,
        sessionKey,
        effectiveAiConfig,
        deliveryPolicy,
      ),
      queueBatchTimeoutMs(batch.items.length),
      `[${batch.twitter_username}] Posting batch timed out`,
    );
  }
}

const digestWorkerService = new DigestWorkerService(
  {
    sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    getConfig,
    jobs: {
      resetProcessing: () => digestJobService.resetProcessing(),
      list: () => digestJobService.list(),
      arm: (destinationId, routeId, nextRunAt) => digestJobService.arm(destinationId, routeId, nextRunAt),
      claimNext: (excludedDestinationIds, resolveMaxEntries, acquireLease) => {
        if (isRestoreRestartRequired()) return null;
        return digestJobService.claimNext(
          excludedDestinationIds,
          Date.now(),
          200,
          resolveMaxEntries,
          acquireLease,
        );
      },
      checkpoint: (id, claimToken, checkpoint, contentHash) =>
        digestJobService.checkpoint(id, claimToken, checkpoint, contentHash),
      releaseEntries: (id, claimToken, entryIds) => digestJobService.releaseEntries(id, claimToken, entryIds),
      complete: (id, claimToken, nextRunAt, deliveredEntryIds) =>
        digestJobService.complete(id, claimToken, nextRunAt, Date.now(), deliveredEntryIds),
      fail: (id, claimToken, error) => digestJobService.fail(id, claimToken, error),
    },
    entries: digestEntryService,
    checkpoints: {
      initialize: (destinationId, externalPostId, chunks) =>
        deliveryCheckpointService.initialize(destinationId, externalPostId, chunks),
      list: (destinationId, externalPostId) => deliveryCheckpointService.list(destinationId, externalPostId),
      recordSuccess: (input) => deliveryCheckpointService.recordSuccess(input),
    },
    delivery: createBlueskyDigestDeliveryAdapter({
      getAgent,
      publish: (agent, mapping, input) =>
        postWithDeterministicRkey(
          agent,
          mapping,
          input.destinationId,
          input.runKey,
          input.chunk.index,
          input.record,
        ),
    }),
    buildPreview: (entries, policy, runKey) => buildDigestPreview(entries, policy, runKey),
    nextRun: (policy) => nextDigestRun(policy),
    metrics: {
      increment: (name) => metricsService.increment(name),
    },
    leases: {
      heldByOthers: () => destinationLeaseService.listHeldByOthers(RUNTIME_OWNER_ID),
      acquire: (destinationId) =>
        Boolean(
          destinationLeaseService.acquire({
            destinationKey: destinationId,
            ownerId: RUNTIME_OWNER_ID,
            ttlMs: DESTINATION_LEASE_TTL_MS,
          }),
        ),
      renew: (destinationId) =>
        destinationLeaseService.renew(destinationId, RUNTIME_OWNER_ID, DESTINATION_LEASE_TTL_MS),
      release: (destinationId) => {
        destinationLeaseService.release(destinationId, RUNTIME_OWNER_ID);
      },
    },
    onWorkerError: (error) =>
      logPipeline('Queue', `❌ Digest worker crashed: ${describeError(error)}`, true),
  },
  activePostDestinations,
);

const queueBatchStarts = new WeakMap<
  QueueBatch,
  { startedAt: number; queueContext: Partial<CorrelationContext> }
>();

const queueWorkerService = new DestinationQueueWorkerService(
  {
    clock: { now: () => Date.now() },
    sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    getConfig,
    findMapping: (config, mappingId) => {
      const destinationId =
        config.destinations.find(
          (destination) =>
            destination.id === mappingId || destination.metadata.legacyMappingIds.includes(mappingId),
        )?.id ?? mappingId;
      return config.mappings.find((mapping) => mapping.id === destinationId);
    },
    claimNextBatch: (
      active: Set<string>,
      allowed: Set<string>,
      resolveDestinationKey: (mappingId: string) => string,
      acquireLease?: (destinationKey: string) => boolean,
    ) => {
      if (isRestoreRestartRequired()) return null;
      return postQueueService.claimNextBatch(
        active,
        allowed,
        resolveDestinationKey,
        QUEUE_BATCH_MAX_ITEMS,
        acquireLease,
      );
    },
    leases: {
      heldByOthers: () => destinationLeaseService.listHeldByOthers(RUNTIME_OWNER_ID),
      acquire: (destinationKey) =>
        Boolean(
          destinationLeaseService.acquire({
            destinationKey,
            ownerId: RUNTIME_OWNER_ID,
            ttlMs: DESTINATION_LEASE_TTL_MS,
          }),
        ),
      renew: (destinationKey) =>
        destinationLeaseService.renew(destinationKey, RUNTIME_OWNER_ID, DESTINATION_LEASE_TTL_MS),
      release: (destinationKey) => {
        destinationLeaseService.release(destinationKey, RUNTIME_OWNER_ID);
      },
    },
    deleteByMappingId: (mappingId) => postQueueService.deleteByMappingId(mappingId),
    deliver: (mapping, batch, context) =>
      deliverPostBatch(mapping, batch, context.mode === 'drain' ? 'one-shot-queue' : 'post-worker'),
    findSettlement: (item) => {
      const mapping =
        getConfig().mappings.find((candidate) => candidate.id === item.destination_id) ??
        getConfig().mappings.find((candidate) =>
          historyIdentityKeys(candidate).includes(item.bsky_identifier.toLowerCase()),
        );
      const record = mapping
        ? findProcessedTweetDual(
            (twitterId, key) => dbService.getTweet(twitterId, key),
            item.twitter_id,
            mapping,
          )
        : dbService.getTweet(item.twitter_id, item.bsky_identifier);
      return record
        ? { status: record.status, recordedAt: parseSqliteUtcTimestampMs(record.created_at) }
        : null;
    },
    markDone: (item) =>
      item.queue_id
        ? void postQueueService.markDoneById(item.queue_id)
        : postQueueService.markDone(item.twitter_id, item.bsky_identifier),
    releaseForRetry: (item, error, maxAttempts) =>
      postQueueService.releaseForRetry(item, error, maxAttempts),
    describeError,
    classifyError: classifyQueueError,
    metrics: {
      increment: (name, amount) => metricsService.increment(name, amount),
      observe: (name, value) => metricsService.observe(name, value),
    },
    recordDestinationFailure: (destinationId, category, message) => {
      runtimeStateService.recordDestinationFailure(destinationId, category, message);
      const mapping = getConfig().mappings.find((candidate) => candidate.id === destinationId);
      if (mapping?.bskyAccountId && category === 'bsky-auth') {
        blueskyAccountRuntimeService.recordFailure(mapping.bskyAccountId, category, message);
      }
      if (mapping && invalidateCachedAgentOnAuthFailure(mapping, category)) {
        console.warn(
          `[${mapping.bskyIdentifier}] 🔑 Bluesky rejected the cached session; re-authenticating on the next attempt.`,
        );
      }
    },
    notifyParked: (destinationId, parked, category) =>
      notifyOperationsEvent({
        event: 'queue-parked',
        occurredAt: new Date().toISOString(),
        message: `${parked} queue item(s) were parked after repeated delivery failures.`,
        details: { destinationId, category },
      }),
    updateJob: (id, patch) =>
      updateJob(
        id,
        patch
          ? {
              kind: 'mirroring',
              account: patch.account,
              target: patch.target,
              mappingId: patch.mappingId,
              message: `Posting ${patch.itemCount} queued tweet(s)`,
              processedCount: 0,
              totalCount: patch.itemCount,
            }
          : null,
      ),
    onBatchStart: (mapping, batch) => {
      const startedAt = Date.now();
      const oldestEnqueuedAt = Math.min(...batch.items.map((item) => item.enqueued_at));
      const queueContext: Partial<CorrelationContext> = {
        queueId: `${batch.destination_id}:${batch.items[0]?.external_post_id ?? 'batch'}`,
        requestId: batch.items[0]?.request_id,
        destinationId: batch.destination_id,
        sourceId: batch.items[0]?.source_id,
      };
      queueBatchStarts.set(batch, { startedAt, queueContext });
      metricsService.observe('queueDelayMs', Math.max(0, startedAt - oldestEnqueuedAt));
      logPipeline(
        'Queue',
        `▶️ @${batch.twitter_username} → ${mapping.bskyIdentifier}: posting ${batch.items.length} tweet(s) ` +
          `(oldest waited ${formatDurationMs(startedAt - oldestEnqueuedAt)} in queue).`,
        false,
        queueContext,
      );
    },
    onBatchSettled: (mapping, batch, settlement: QueueSettlement) => {
      const context = queueBatchStarts.get(batch);
      const startedAt = context?.startedAt ?? Date.now();
      if (settlement.error) {
        console.error(`${getMappingLogPrefix(mapping)} ❌ Post batch failed: ${settlement.error}`);
      }
      const parts = [`${settlement.posted} posted`];
      if (settlement.skipped > 0) parts.push(`${settlement.skipped} skipped`);
      if (settlement.retrying > 0) parts.push(`${settlement.retrying} will retry`);
      if (settlement.parked > 0) parts.push(`${settlement.parked} parked as failed`);
      logPipeline(
        'Queue',
        `${settlement.retrying + settlement.parked > 0 ? '⚠️' : '✅'} @${batch.twitter_username} → ${mapping.bskyIdentifier}: ` +
          `${parts.join(', ')} in ${formatDurationMs(Date.now() - startedAt)}.`,
        settlement.retrying + settlement.parked > 0,
        context?.queueContext,
      );
      queueBatchStarts.delete(batch);
    },
    onWorkerError: (error) =>
      logPipeline('Queue', `❌ Worker scheduler error: ${describeError(error)}`, true),
  },
  POST_WORKER_CONCURRENCY,
  QUEUE_MAX_ATTEMPTS,
  activePostDestinations,
);

function startPostWorkers(): void {
  digestWorkerService.start();
  queueWorkerService.start();
  logPipeline('Queue', `🚚 Post workers started (up to ${POST_WORKER_CONCURRENCY} accounts posting in parallel).`);
}

async function drainDurableQueue(_config = getConfig()): Promise<void> {
  await queueWorkerService.drain();
}

async function importHistory(
  twitterUsername: string,
  bskyIdentifier: string,
  limit = 15,
  dryRun = false,
  ignoreCancellation = false,
  requestId?: string,
  sessionKey = 'default',
  // 'queue' hands the fetched tweets to the durable post queue (daemon mode);
  // 'inline' posts them before returning (CLI one-shots and dry runs).
  delivery: 'inline' | 'queue' = 'inline',
  bypassFilters = false,
): Promise<void> {
  const config = getConfig();
  const mapping = config.mappings.find(
    (candidate) =>
      candidate.bskyIdentifier.toLowerCase() === bskyIdentifier.toLowerCase() &&
      candidate.twitterUsernames.map((username) => username.toLowerCase()).includes(twitterUsername.toLowerCase()),
  );
  if (!mapping) {
    console.error(`No mapping found for twitter username: ${twitterUsername}`);
    return;
  }
  const destinationStorageKey = resolveDestinationStorageKey(mapping);

  if (delivery === 'queue' && !dryRun) {
    await fetchAndEnqueueBackfill(mapping, twitterUsername, limit, ignoreCancellation, requestId, sessionKey);
    return;
  }

  const authenticatedAgent = await getAgent(mapping);
  let agent: BskyAgent;
  if (authenticatedAgent) {
    agent = authenticatedAgent;
  } else {
    if (dryRun) {
      console.log('⚠️  Could not login to Bluesky, but proceeding with MOCK AGENT for Dry Run.');
      const mockAgent: DryRunAgent = {
        post: async (_record) => ({ uri: 'at://did:plc:mock/app.bsky.feed.post/mock', cid: 'mock-cid' }),
        uploadBlob: async (_data) => ({
          data: {
            blob: { ref: { toString: () => 'mock-blob' }, mimeType: 'application/octet-stream', size: 0 },
          },
        }),
        // Add other necessary methods if they are called outside of the already mocked dryRun blocks
        // But since we mocked the calls inside processTweets for dryRun, we just need the object to exist.
        session: { did: 'did:plc:mock' },
        com: { atproto: { repo: { describeRepo: async () => ({ data: {} }) } } },
      };
      agent = mockAgent as unknown as BskyAgent;
    } else {
      return;
    }
  }

  console.log(`Starting full history import for ${twitterUsername} -> ${mapping.bskyIdentifier}...`);

  const allFoundTweets: Tweet[] = [];
  const seenIds = new Set<string>();
  const processedTweets = loadProcessedTweetsForDestination(mapping);

  console.log(`Fetching tweets for ${twitterUsername}...`);
  updateAppStatus({ message: 'Fetching tweets...' });
  const backfillJobId = `backfill:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  updateJob(backfillJobId, {
    kind: 'backfilling',
    account: twitterUsername,
    target: bskyIdentifier,
    mappingId: mapping.id,
    message: `Fetching up to ${limit || 100} tweets from the timeline`,
  });

  try {
    const client = await getTwitterScraper(sessionKey);
    if (client) {
      try {
        // Use getTweets which reliably fetches user timeline. Callers pass an
        // explicit limit for history import; 100 is only the fallback for
        // limit === 0/undefined.
        const fetchLimit = limit || 100;
        await acquireScraperSlot();
        const generator = client.getTweets(twitterUsername, fetchLimit);

        for await (const scraperTweet of generator) {
          if (!ignoreCancellation) {
            if (!backfillStillRequested(mapping.id, requestId)) {
              console.log(`[${twitterUsername}] 🛑 Backfill cancelled.`);
              break;
            }
          }

          const t = mapScraperTweetToLocalTweet(scraperTweet);
          const tid = t.id_str || t.id;
          if (!tid) continue;

          if (!processedTweets[tid] && !seenIds.has(tid)) {
            allFoundTweets.push(t);
            seenIds.add(tid);
          }

          if (allFoundTweets.length >= fetchLimit) break;
        }
      } catch (e) {
        console.warn('Error during history fetch:', e);
      }
    }

    const source = config.sources.find((candidate) => candidate.username === twitterUsername.toLowerCase());
    const route = source
      ? config.routes.find((candidate) => candidate.sourceId === source.id && candidate.destinationId === mapping.id)
      : undefined;
    const policyAccepted = allFoundTweets.filter((tweet) => {
      const filterDecision = source
        ? filterTweetForSource(tweet, source, route?.filters ?? source.filters, bypassFilters)
        : ({ allowed: false, reason: 'source-disabled', policyVersion: SOURCE_FILTER_POLICY_VERSION } as const);
      if (filterDecision.allowed) return true;
      const tweetId = String(tweet.id_str || tweet.id || '');
      console.log(`[${twitterUsername}] ⏩ Filter skipped ${tweetId}: ${filterDecision.reason}.`);
      if (!dryRun && tweetId) {
        saveProcessedTweet(
          twitterUsername,
          destinationStorageKey,
          tweetId,
          { skipped: true, text: tweet.full_text || tweet.text },
          mapping,
          getTweetSourceCreatedAt(tweet),
          filterDecision.reason,
        );
      }
      return false;
    });
    console.log(
      `Fetch complete. Found ${allFoundTweets.length} new tweets; ${policyAccepted.length} passed source policy.`,
    );
    if (policyAccepted.length > 0) {
      updateJob(backfillJobId, { message: `Backfilling ${policyAccepted.length} tweet(s)` });
      await processTweets(
        agent as BskyAgent,
        twitterUsername,
        destinationStorageKey,
        mapping,
        policyAccepted,
        dryRun,
        undefined,
        undefined,
        sessionKey,
      );
      console.log('History import complete.');
    }
  } finally {
    updateJob(backfillJobId, null);
    updateJob(`mirror:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`, null);
  }
}

// Task management
const activeTasks = new Map<string, Promise<void>>();
// These must comfortably exceed normal processing time: the pipeline paces
// 5-15s between tweets on purpose, so a 15-tweet backfill alone takes ~2.5-4
// minutes. A too-short watchdog abandons runs that are still posting in the
// background, which risks duplicate posts when the next cycle overlaps them.
const DEFAULT_BACKFILL_ACCOUNT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SCHEDULED_ACCOUNT_TIMEOUT_MS = 20 * 60 * 1000;
let profileSyncStateWriteQueue: Promise<void> = Promise.resolve();

function describeError(error: unknown): string {
  return sanitizedErrorMessage(error);
}

const getMappingLogPrefix = (mapping: AccountMapping): string => {
  const owner = mapping.owner?.trim() || 'unknown-owner';
  const creator = mapping.createdByUserId || 'unknown-user';
  return `[mapping:${mapping.id}] [owner:${owner}] [creator:${creator}] [target:${mapping.bskyIdentifier}]`;
};

const resolveBackfillAccountTimeoutMs = (): number => {
  const raw = Number(process.env.BACKFILL_ACCOUNT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 15_000) {
    return raw;
  }
  return DEFAULT_BACKFILL_ACCOUNT_TIMEOUT_MS;
};

const resolveScheduledAccountTimeoutMs = (): number => {
  const raw = Number(process.env.SCHEDULED_ACCOUNT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 30_000) {
    return raw;
  }
  return DEFAULT_SCHEDULED_ACCOUNT_TIMEOUT_MS;
};

const parseIsoTimestampMs = (value?: string): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isProfileSyncDue = (mapping: AccountMapping): boolean => {
  const lastSyncMs = parseIsoTimestampMs(mapping.lastProfileSyncAt);
  if (!lastSyncMs) {
    return true;
  }
  return Date.now() - lastSyncMs >= mapping.profileManagement.profileSync.intervalHours * 60 * 60 * 1000;
};

const persistProfileSyncResult = (
  mappingId: string,
  sourceTwitterUsername: string,
  updateResult: Awaited<ReturnType<typeof syncBlueskyProfileFromTwitter>>,
) => {
  profileSyncStateWriteQueue = profileSyncStateWriteQueue
    .then(() => {
      const config = getConfig();
      const index = config.mappings.findIndex((entry) => entry.id === mappingId);
      const mapping = config.mappings[index];
      if (index === -1 || !mapping) {
        return;
      }

      config.mappings[index] = applyProfileMirrorSyncState(mapping, sourceTwitterUsername, updateResult);
      saveConfig(config);
    })
    .catch((error) => {
      console.error(`[Scheduler] Failed persisting profile sync metadata for mapping ${mappingId}:`, error);
    });

  return profileSyncStateWriteQueue;
};

const persistPinnedTweetState = (mappingId: string, pinnedTweetId: string | undefined) => {
  profileSyncStateWriteQueue = profileSyncStateWriteQueue
    .then(() => {
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === mappingId);
      if (!mapping) {
        return;
      }
      mapping.lastPinnedTweetId = pinnedTweetId;
      saveConfig(config);
    })
    .catch((error) => {
      console.error(`[Scheduler] Failed persisting pinned tweet state for mapping ${mappingId}:`, error);
    });

  return profileSyncStateWriteQueue;
};

const persistPinSyncTimestamp = (mappingId: string, lastPinSyncAt: string) => {
  profileSyncStateWriteQueue = profileSyncStateWriteQueue
    .then(() => {
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === mappingId);
      if (!mapping) {
        return;
      }
      mapping.lastPinSyncAt = lastPinSyncAt;
      saveConfig(config);
    })
    .catch((error) => {
      console.error(`[Scheduler] Failed persisting pin sync timestamp for mapping ${mappingId}:`, error);
    });

  return profileSyncStateWriteQueue;
};

// Authoritative pin check at least once every 24h per mapping (the timeline
// isPin path only catches pins that are inside the fetched window). Unchanged
// pins are a cheap no-op: two API reads, no backfill, no profile write.
async function maybeSyncPinnedTweetDaily(
  mapping: AccountMapping,
  dryRun: boolean,
  sessionKey: string,
  logPrefix: string,
): Promise<void> {
  const authorization = evaluateProfileMutation(mapping, 'pin-sync-scheduled');
  if (!authorization.allowed) {
    return;
  }
  if (dryRun) {
    return;
  }
  const pinSyncIntervalMs = mapping.profileManagement.pinSync.intervalHours * 60 * 60 * 1000;

  const lastMs = parseIsoTimestampMs(mapping.lastPinSyncAt);
  if (!lastMs) {
    // First run after upgrade: spread mappings across the 24h window so a
    // large instance (100 mappings) doesn't burst the Twitter API in one cycle.
    const staggered = new Date(Date.now() - Math.floor(Math.random() * pinSyncIntervalMs)).toISOString();
    mapping.lastPinSyncAt = staggered;
    await persistPinSyncTimestamp(mapping.id, staggered);
    return;
  }
  if (Date.now() - lastMs < pinSyncIntervalMs) {
    return;
  }

  // Bump the timestamp before running so failures retry in 24h, not every cycle.
  const stamp = new Date().toISOString();
  mapping.lastPinSyncAt = stamp;
  await persistPinSyncTimestamp(mapping.id, stamp);

  try {
    const message = await syncPinnedTweetViaProfile(mapping, dryRun, sessionKey, 'pin-sync-scheduled');
    console.log(`${logPrefix} 📌 Daily pin check: ${message}`);
  } catch (error) {
    console.error(`${logPrefix} ❌ Daily pin check failed: ${describeError(error)}`);
  }
}

// Pin policy has its own source and cadence. Aggregate destinations never
// infer either profile or pin source from source-array order.
const resolvePinSourceForMapping = (
  mapping: AccountMapping,
  action: 'pin-sync-manual' | 'pin-sync-scheduled',
): string | null => {
  const decision = evaluateProfileMutation(mapping, action);
  return decision.allowed && decision.sourceUsername ? decision.sourceUsername : null;
};

async function setBlueskyPinnedPost(
  agent: BskyAgent,
  mapping: AccountMapping,
  ref: { uri: string; cid: string } | null,
  dryRun: boolean,
  logPrefix: string,
  action: 'pin-sync-manual' | 'pin-sync-scheduled',
  requestedSource?: string,
): Promise<void> {
  assertProfileMutationAllowed(mapping, action, { requestedSource });
  if (dryRun) {
    console.log(`${logPrefix} 🧪 [DRY RUN] Would ${ref ? `pin ${ref.uri}` : 'clear pinned post'} on Bluesky.`);
    return;
  }
  await agent.upsertProfile((existing) => {
    const profile = { ...(existing ?? {}) };
    if (ref) {
      profile.pinnedPost = { uri: ref.uri, cid: ref.cid };
    } else {
      // biome-ignore lint/performance/noDelete: the key must be absent from the atproto record; an explicit undefined could still trip lexicon validation
      delete profile.pinnedPost;
    }
    return profile;
  });
  runtimeStateService.recordDestinationEvent(mapping.id, 'pin');
}

// Apply a pinned tweet to the Bluesky profile once the tweet is mirrored.
// Returns true when the Bluesky pin state now matches `pinnedTweetId`.
async function applyPinnedTweet(
  agent: BskyAgent,
  mapping: AccountMapping,
  pinnedTweetId: string | undefined,
  dryRun: boolean,
  logPrefix: string,
  action: 'pin-sync-manual' | 'pin-sync-scheduled',
  requestedSource?: string,
): Promise<boolean> {
  assertProfileMutationAllowed(mapping, action, { requestedSource });
  if (!pinnedTweetId) {
    if (!mapping.lastPinnedTweetId) {
      return true;
    }
    console.log(`${logPrefix} 📌 Tweet unpinned on Twitter. Clearing Bluesky pinned post.`);
    await setBlueskyPinnedPost(agent, mapping, null, dryRun, logPrefix, action, requestedSource);
    if (!dryRun) {
      mapping.lastPinnedTweetId = undefined;
      await persistPinnedTweetState(mapping.id, undefined);
    }
    return true;
  }

  if (pinnedTweetId === mapping.lastPinnedTweetId) {
    return true;
  }

  const record = findProcessedTweetDual(
    (twitterId, bskyIdentifier) => dbService.getTweet(twitterId, bskyIdentifier),
    pinnedTweetId,
    mapping,
  );
  if (record && record.status === 'skipped') {
    // Pinned retweets/external replies are never mirrored — remember that so we
    // don't retry (and log) every cycle.
    console.log(`${logPrefix} 📌 Pinned tweet ${pinnedTweetId} was skipped (retweet/external reply). Not pinning.`);
    if (!dryRun) {
      mapping.lastPinnedTweetId = pinnedTweetId;
      await persistPinnedTweetState(mapping.id, pinnedTweetId);
    }
    return true;
  }
  if (!record || record.status !== 'migrated' || !record.bsky_uri || !record.bsky_cid) {
    console.log(`${logPrefix} 📌 Pinned tweet ${pinnedTweetId} is not mirrored yet. Pin sync deferred.`);
    return false;
  }

  console.log(`${logPrefix} 📌 Pinning mirrored post for tweet ${pinnedTweetId} on Bluesky.`);
  await setBlueskyPinnedPost(
    agent,
    mapping,
    { uri: record.bsky_uri, cid: record.bsky_cid },
    dryRun,
    logPrefix,
    action,
    requestedSource,
  );
  if (!dryRun) {
    mapping.lastPinnedTweetId = pinnedTweetId;
    await persistPinnedTweetState(mapping.id, pinnedTweetId);
  }
  return true;
}

// Zero-extra-request pin sync: the timeline fetch already marks the pinned
// tweet (isPin), so scheduled cycles can mirror pin changes for free.
async function maybeSyncPinnedTweetFromTimeline(
  mapping: AccountMapping,
  twitterUsername: string,
  tweets: Tweet[],
  dryRun: boolean,
  logPrefix: string,
): Promise<void> {
  const pinSource = resolvePinSourceForMapping(mapping, 'pin-sync-scheduled');
  if (!pinSource || pinSource.toLowerCase() !== twitterUsername.toLowerCase()) {
    return;
  }

  const pinnedTweet = tweets.find((tweet) => tweet.isPin);
  const pinnedTweetId = pinnedTweet ? pinnedTweet.id_str || pinnedTweet.id : undefined;

  // isPin only fires when the pinned tweet is inside the fetched window, so its
  // absence is NOT proof of an unpin (old pins never appear here). Never unpin
  // from this path — the explicit pin-sync button does an authoritative check.
  if (!pinnedTweetId) {
    return;
  }
  if (pinnedTweetId === mapping.lastPinnedTweetId) {
    return;
  }

  // Only log in to Bluesky once we know the pin actually changed.
  const agent = await getAgent(mapping);
  if (!agent) {
    return;
  }

  try {
    await applyPinnedTweet(agent, mapping, pinnedTweetId, dryRun, logPrefix, 'pin-sync-scheduled');
  } catch (error) {
    console.error(`${logPrefix} ❌ Pin sync failed: ${describeError(error)}`);
  }
}

// Explicit "backfill pins" path (web button): fetch the profile's pinned tweet,
// mirror it first if needed, then pin the mirrored post on Bluesky.
async function syncPinnedTweetViaProfile(
  mapping: AccountMapping,
  dryRun: boolean,
  sessionKey: string,
  action: 'pin-sync-manual' | 'pin-sync-scheduled' = 'pin-sync-manual',
  requestedSource?: string,
): Promise<string> {
  const logPrefix = getMappingLogPrefix(mapping);
  const authorization = assertProfileMutationAllowed(mapping, action, { requestedSource });
  const pinSource = authorization.sourceUsername || resolvePinSourceForMapping(mapping, action);
  if (!pinSource) {
    return mapping.twitterUsernames.length > 1
      ? 'No profile-sync source account selected for this multi-account mapping. Pick which account to pull the bio/avatar (and pin) from first.'
      : 'No Twitter source account configured.';
  }

  const pinJobId = `pin:${mapping.id}`;
  updateJob(pinJobId, {
    kind: 'pin-sync',
    account: pinSource,
    target: mapping.bskyIdentifier,
    mappingId: mapping.id,
    message: `Checking @${pinSource}'s pinned tweet`,
  });
  try {
    const scraper = await getTwitterScraper(sessionKey);
    if (!scraper) {
      return 'Twitter credentials are not configured.';
    }

    const agent = await getAgent(mapping);
    if (!agent) {
      return 'Bluesky login failed.';
    }

    const lookup = await fetchPinnedTweetId(scraper, pinSource);
    if (!lookup.ok) {
      return `Could not determine @${pinSource}'s pinned tweet (Twitter API lookup failed). Nothing changed.`;
    }
    const pinnedTweetId = lookup.pinnedTweetId;

    if (!pinnedTweetId) {
      await applyPinnedTweet(agent, mapping, undefined, dryRun, logPrefix, action, pinSource);
      return `@${pinSource} has no pinned tweet. Bluesky pin cleared if one was set.`;
    }

    if (pinnedTweetId === mapping.lastPinnedTweetId) {
      return `Pinned tweet unchanged (${pinnedTweetId}). Nothing to do.`;
    }

    const destinationStorageKey = resolveDestinationStorageKey(mapping);
    let record = findProcessedTweetDual(
      (twitterId, bskyIdentifier) => dbService.getTweet(twitterId, bskyIdentifier),
      pinnedTweetId,
      mapping,
    );
    if (!record || record.status !== 'migrated') {
      console.log(`${logPrefix} 📌 Pinned tweet ${pinnedTweetId} not mirrored yet. Backfilling it now...`);
      await acquireScraperSlot();
      const rawPinned = await scraper.getTweet(pinnedTweetId);
      if (rawPinned) {
        // getTweet resolves the whole self-thread; mirror all of it so the pinned
        // post threads on Bluesky exactly like a live thread would.
        const seenIds = new Set<string>();
        const threadTweets = [rawPinned, ...(rawPinned.thread ?? [])]
          .map(mapScraperTweetToLocalTweet)
          .filter((threadTweet) => {
            const threadId = threadTweet.id_str || threadTweet.id;
            if (!threadId || seenIds.has(threadId)) return false;
            seenIds.add(threadId);
            return true;
          })
          // processTweets expects timeline order (newest first) and reverses internally
          .sort((a, b) => (BigInt(b.id_str || b.id || '0') < BigInt(a.id_str || a.id || '0') ? -1 : 1));
        if (threadTweets.length > 1) {
          console.log(
            `${logPrefix} 📌 Pinned tweet is part of a thread (${threadTweets.length} tweets). Mirroring the whole thread.`,
          );
        }
        await processTweets(
          agent,
          pinSource,
          destinationStorageKey,
          mapping,
          threadTweets,
          dryRun,
          undefined,
          undefined,
          sessionKey,
        );
        record = findProcessedTweetDual(
          (twitterId, bskyIdentifier) => dbService.getTweet(twitterId, bskyIdentifier),
          pinnedTweetId,
          mapping,
        );
      }
    }

    if (!dryRun && (!record || record.status !== 'migrated')) {
      return `Pinned tweet ${pinnedTweetId} could not be mirrored (it may be a retweet or an external reply).`;
    }

    const synced = await applyPinnedTweet(agent, mapping, pinnedTweetId, dryRun, logPrefix, action, pinSource);
    return synced
      ? `Pinned tweet synced for ${mapping.bskyIdentifier}.`
      : `Pinned tweet ${pinnedTweetId} is not mirrored yet; try a backfill first.`;
  } finally {
    updateJob(pinJobId, null);
    updateJob(`mirror:${mapping.bskyIdentifier.toLowerCase()}:${pinSource.toLowerCase()}`, null);
  }
}

async function maybeSyncMappingProfileInBackground(
  mapping: AccountMapping,
  dryRun: boolean,
  logPrefix: string,
): Promise<void> {
  const authorization = evaluateProfileMutation(mapping, 'profile-sync-scheduled');
  if (!authorization.allowed || !authorization.sourceUsername || !authorization.fields) {
    return;
  }
  if (dryRun) {
    return;
  }
  if (!isProfileSyncDue(mapping)) {
    return;
  }

  const sourceTwitterUsername = authorization.sourceUsername;
  if (!sourceTwitterUsername) {
    if (mapping.twitterUsernames.length > 1) {
      console.warn(
        `${logPrefix} ⚠️ Skipping automatic profile sync: multi-source mapping requires profileSyncSourceUsername selection.`,
      );
    }
    return;
  }

  const profileJobId = `profile:${mapping.id}`;
  updateJob(profileJobId, {
    kind: 'profile-sync',
    account: sourceTwitterUsername,
    target: mapping.bskyIdentifier,
    mappingId: mapping.id,
    message: `Pulling bio/avatar from @${sourceTwitterUsername}`,
  });
  try {
    console.log(`${logPrefix} 🪞 Running automatic profile sync from @${sourceTwitterUsername}.`);
    const result = await syncBlueskyProfileFromTwitter({
      twitterUsername: sourceTwitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      syncDisplayName: authorization.fields.displayName,
      syncDescription: authorization.fields.description,
      syncAvatar: authorization.fields.avatar,
      syncBanner: authorization.fields.banner,
      authorization: assertProfileMutationAllowed(mapping, 'profile-sync-scheduled'),
      previousSync: {
        sourceUsername: mapping.profileManagement.profileSync.sourceUsername,
        mirroredDisplayName: mapping.lastMirroredDisplayName,
        mirroredDescription: mapping.lastMirroredDescription,
        avatarUrl: mapping.lastMirroredAvatarUrl,
        bannerUrl: mapping.lastMirroredBannerUrl,
      },
    });

    Object.assign(mapping, applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result));
    await persistProfileSyncResult(mapping.id, sourceTwitterUsername, result);
    if (!dryRun && !result.skipped) runtimeStateService.recordDestinationEvent(mapping.id, 'profile');

    if (result.skipped) {
      console.log(`${logPrefix} 🪞 Profile sync skipped (no Twitter profile changes).`);
      return;
    }

    if (result.warnings.length > 0) {
      console.warn(`${logPrefix} ⚠️ Profile sync completed with ${result.warnings.length} warning(s).`);
      return;
    }

    console.log(`${logPrefix} ✅ Profile sync completed.`);
  } catch (error) {
    console.error(`${logPrefix} ❌ Automatic profile sync failed: ${describeError(error)}`);
  } finally {
    updateJob(profileJobId, null);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runAccountTask(
  mapping: AccountMapping,
  backfillRequest?: PendingBackfill,
  dryRun = false,
  sessionKey = 'default',
  backfillDelivery: 'inline' | 'queue' = 'inline',
  bypassFilters = false,
) {
  const logPrefix = getMappingLogPrefix(mapping);
  const destinationTaskKey = getCanonicalDestinationKey(mapping);
  const existingTask = activeTasks.get(destinationTaskKey);
  if (existingTask) {
    console.log(`${logPrefix} ⏳ Task already in progress. Reusing active run.`);
    return existingTask;
  }

  const task = (async () => {
    let checkedSources = 0;
    let sourceErrors = 0;
    let lastBackfillError: unknown;
    const taskMode = backfillRequest ? 'backfill' : 'scheduled';
    console.log(`${logPrefix} ▶️ Starting ${taskMode} task for ${mapping.twitterUsernames.length} source account(s).`);

    // Backfill requests are mirrored into a durable row before any network call,
    // so a transient X/Bluesky failure or a restart reschedules the job instead
    // of losing it. `settleBackfill` is the single exit point for that row.
    let durableClaim: BackfillJob | null = null;
    const settleBackfill = (
      outcome: { ok: true } | { ok: false; error: unknown; category?: string; retryable: boolean },
    ): void => {
      if (!durableClaim?.claimToken) return;
      const claimed = durableClaim;
      durableClaim = null;
      if (outcome.ok) {
        backfillJobService.complete(claimed.id, claimed.claimToken as string);
        return;
      }
      const next = backfillJobService.reschedule({
        id: claimed.id,
        claimToken: claimed.claimToken as string,
        error: outcome.error,
        category: outcome.category,
        retryable: outcome.retryable,
      });
      console.warn(
        `${logPrefix} ${next?.status === 'pending' ? '♻️ Backfill will retry' : '⛔ Backfill parked'}: ${describeError(outcome.error)}`,
      );
    };

    try {
      const backfillReq = backfillRequest ?? getPendingBackfills().find((b) => b.id === mapping.id);
      if (backfillReq) {
        const durable = backfillJobService.upsert({
          id: backfillReq.requestId,
          destinationId: mapping.id,
          sourceUsernames: backfillReq.sourceUsernames,
          limit: backfillReq.limit || 15,
          queuedAt: backfillReq.queuedAt,
        });
        durableClaim = backfillJobService.claim(durable.id);
        if (!durableClaim) {
          console.log(`${logPrefix} ⏳ Backfill ${durable.id} is already claimed elsewhere; skipping.`);
          return;
        }
      }

      if (mapping.twitterUsernames.length === 0) {
        console.warn(`${logPrefix} ⚠️ No Twitter usernames configured. Skipping mapping.`);
        settleBackfill({ ok: true });
        if (backfillReq) {
          clearBackfill(mapping.id, backfillReq.requestId);
          updateAppStatus({
            state: 'idle',
            currentAccount: undefined,
            processedCount: 0,
            totalCount: 0,
            message: `Backfill skipped for ${mapping.bskyIdentifier}: no source accounts configured`,
            backfillMappingId: undefined,
            backfillRequestId: undefined,
          });
        }
        return;
      }

      // Queue-delivered backfills only discover and enqueue; Bluesky delivery
      // happens later in the post workers. Requiring a session here turned an
      // auth blip into a dropped backfill.
      const requiresBlueskySession = !backfillReq || backfillDelivery === 'inline';
      const agent = await getAgent(mapping);
      if (!agent && requiresBlueskySession) {
        console.warn(`${logPrefix} ⚠️ Unable to authenticate Bluesky account. Skipping task.`);
        if (backfillReq) {
          settleBackfill({
            ok: false,
            error: new Error('Bluesky login failed before an inline backfill could start.'),
            category: 'bsky-auth',
            retryable: true,
          });
          updateAppStatus({
            state: 'idle',
            currentAccount: undefined,
            processedCount: 0,
            totalCount: mapping.twitterUsernames.length,
            message: `Backfill deferred for ${mapping.bskyIdentifier}: Bluesky login failed`,
            backfillMappingId: undefined,
            backfillRequestId: undefined,
          });
        }
        return;
      }

      const explicitBackfill = Boolean(backfillRequest);

      if (backfillReq) {
        const limit = backfillReq.limit || 15;
        const backfillAccountTimeoutMs = resolveBackfillAccountTimeoutMs();
        const backfillSources = getActiveTwitterUsernames(mapping).filter(
          (username) => !backfillReq.sourceUsernames || backfillReq.sourceUsernames.includes(username),
        );
        const accountCount = backfillSources.length;
        const estimatedTotalTweets = accountCount * limit;
        console.log(
          `${logPrefix} Running backfill for ${backfillSources.length} active accounts (limit ${limit})...`,
        );
        updateAppStatus({
          state: 'backfilling',
          currentAccount: backfillSources[0],
          processedCount: 0,
          totalCount: accountCount,
          message: `Backfill queued for ${accountCount} account(s), up to ${estimatedTotalTweets} tweets`,
          backfillMappingId: mapping.id,
          backfillRequestId: backfillReq.requestId,
        });

        for (let i = 0; i < backfillSources.length; i += 1) {
          const twitterUsername = backfillSources[i];
          if (!twitterUsername) {
            continue;
          }
          const stillPending = explicitBackfill
            ? true
            : getPendingBackfills().some((b) => b.id === mapping.id && b.requestId === backfillReq.requestId);
          if (!stillPending) {
            console.log(`${logPrefix} 🛑 Backfill request replaced; stopping.`);
            break;
          }

          try {
            checkedSources += 1;
            updateAppStatus({
              state: 'backfilling',
              currentAccount: twitterUsername,
              processedCount: i,
              totalCount: accountCount,
              message: `Backfill ${i + 1}/${accountCount}: @${twitterUsername} (limit ${limit})`,
              backfillMappingId: mapping.id,
              backfillRequestId: backfillReq.requestId,
            });
            await withTimeout(
              importHistory(
                twitterUsername,
                mapping.bskyIdentifier,
                limit,
                dryRun,
                false,
                backfillReq.requestId,
                sessionKey,
                backfillDelivery,
                bypassFilters,
              ),
              backfillAccountTimeoutMs,
              `[${twitterUsername}] Backfill timed out after ${Math.round(backfillAccountTimeoutMs / 1000)}s`,
            );
            updateAppStatus({
              state: 'backfilling',
              currentAccount: twitterUsername,
              processedCount: i + 1,
              totalCount: accountCount,
              message: `Completed ${i + 1}/${accountCount} for ${mapping.bskyIdentifier}`,
              backfillMappingId: mapping.id,
              backfillRequestId: backfillReq.requestId,
            });
          } catch (err) {
            sourceErrors += 1;
            lastBackfillError = err;
            console.error(`${logPrefix} ❌ Error backfilling @${twitterUsername}: ${describeError(err)}`);
          }
        }
        if (sourceErrors > 0 && lastBackfillError !== undefined) {
          settleBackfill({
            ok: false,
            error: lastBackfillError,
            category: classifyQueueError(lastBackfillError),
            retryable: true,
          });
        } else {
          settleBackfill({ ok: true });
        }
        clearBackfill(mapping.id, backfillReq.requestId);
        updateAppStatus({
          state: 'idle',
          processedCount: accountCount,
          totalCount: accountCount,
          message:
            backfillDelivery === 'queue'
              ? `Backfill queued for ${mapping.bskyIdentifier}; posting continues in the background`
              : `Backfill complete for ${mapping.bskyIdentifier}`,
          backfillMappingId: undefined,
          backfillRequestId: undefined,
        });
        console.log(`${logPrefix} Backfill ${backfillDelivery === 'queue' ? 'fetch queued' : 'complete'}.`);
      } else if (!agent) {
        return;
      } else {
        updateAppStatus({ backfillMappingId: undefined, backfillRequestId: undefined });
        const scheduledAccountTimeoutMs = resolveScheduledAccountTimeoutMs();

        // Pre-load processed IDs for optimization
        const destinationStorageKey = resolveDestinationStorageKey(mapping);
        const processedMap = loadProcessedTweetsForDestination(mapping);
        const processedIds = new Set(Object.keys(processedMap));

        for (const twitterUsername of getActiveTwitterUsernames(mapping)) {
          const checkJobId = `check:${mapping.id}:${twitterUsername.toLowerCase()}`;
          try {
            checkedSources += 1;
            console.log(`[${twitterUsername}] 🏁 Starting check for new tweets...`);
            updateJob(checkJobId, {
              kind: 'checking',
              account: twitterUsername,
              target: mapping.bskyIdentifier,
              mappingId: mapping.id,
              message: 'Checking for new tweets',
            });
            updateAppStatus({
              state: 'checking',
              currentAccount: twitterUsername,
              message: 'Fetching latest tweets...',
              backfillMappingId: undefined,
              backfillRequestId: undefined,
            });

            // Use fetchUserTweets with early stopping optimization
            // Increase limit slightly since we have early stopping now
            const tweets = await withTimeout(
              fetchUserTweets(twitterUsername, 50, processedIds, sessionKey),
              scheduledAccountTimeoutMs,
              `[${twitterUsername}] Scheduled fetch timed out after ${Math.round(scheduledAccountTimeoutMs / 1000)}s`,
            );

            if (!tweets || tweets.length === 0) {
              console.log(`[${twitterUsername}] ℹ️ No tweets found (or fetch failed).`);
              continue;
            }

            const canonicalSource = getConfig().sources.find(
              (source) => source.username === twitterUsername.toLowerCase(),
            );
            const canonicalRoute = canonicalSource
              ? getConfig().routes.find(
                  (route) => route.sourceId === canonicalSource.id && route.destinationId === mapping.id,
                )
              : undefined;
            const policyAccepted = canonicalSource
              ? tweets.filter((tweet) => {
                  const filterDecision = filterTweetForSource(
                    tweet,
                    canonicalSource,
                    canonicalRoute?.filters ?? canonicalSource.filters,
                    bypassFilters,
                  );
                  if (!filterDecision.allowed) {
                    console.log(
                      `[${twitterUsername}] ⏩ Filter skipped ${tweet.id_str || tweet.id}: ${filterDecision.reason}.`,
                    );
                  }
                  return filterDecision.allowed;
                })
              : [];
            console.log(
              `[${twitterUsername}] 📥 Fetched ${tweets.length} tweets; ${policyAccepted.length} passed source policy.`,
            );
            if (policyAccepted.length === 0) continue;
            await withTimeout(
              processTweets(
                agent,
                twitterUsername,
                destinationStorageKey,
                mapping,
                policyAccepted,
                dryRun,
                undefined,
                undefined,
                sessionKey,
              ),
              scheduledAccountTimeoutMs,
              `[${twitterUsername}] Scheduled processing timed out after ${Math.round(scheduledAccountTimeoutMs / 1000)}s`,
            );

            await maybeSyncPinnedTweetFromTimeline(mapping, twitterUsername, policyAccepted, dryRun, logPrefix);
          } catch (err) {
            sourceErrors += 1;
            console.error(`${logPrefix} ❌ Error checking @${twitterUsername}: ${describeError(err)}`);
          } finally {
            updateJob(checkJobId, null);
            // Clear the mirror job too in case processing threw mid-tweet
            updateJob(`mirror:${mapping.bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`, null);
          }
        }

        await maybeSyncMappingProfileInBackground(mapping, dryRun, logPrefix);
        await maybeSyncPinnedTweetDaily(mapping, dryRun, sessionKey, logPrefix);
      }
    } catch (err) {
      sourceErrors += 1;
      console.error(`${logPrefix} ❌ Mapping task failed: ${describeError(err)}`);
      settleBackfill({ ok: false, error: err, category: classifyQueueError(err), retryable: true });
    } finally {
      // A claim that survived every branch above (an early `return`, say) must
      // still be released, or the job stays 'processing' until crash recovery.
      settleBackfill({
        ok: false,
        error: new Error('Backfill task ended without settling its claim.'),
        retryable: true,
      });
      activeTasks.delete(destinationTaskKey);
      console.log(`${logPrefix} ✅ Task finished. Sources checked=${checkedSources}, source errors=${sourceErrors}.`);
    }
  })();

  activeTasks.set(destinationTaskKey, task);
  return task; // Return task promise for await in main loop
}

import {
  clearBackfill,
  clearPinSync,
  getNextCheckTime,
  getPendingBackfills,
  getPendingPinSyncs,
  getSchedulerCommandsSince,
  getSchedulerWakeSignal,
  recalculateNextCheckTime,
  startServer,
  updateAppStatus,
  updateJob,
  updateLastCheckTime,
} from './server.js';
import type { PendingBackfill } from './server.js';

/**
 * Durable rows are the source of truth for backfills that survived a restart;
 * the in-memory list from the web process is still authoritative for requests
 * submitted since. Merging on request id keeps a durable job from being run
 * twice while making sure an orphaned one is picked up again.
 */
function mergedPendingBackfills(): PendingBackfill[] {
  const merged = new Map<string, PendingBackfill>();
  for (const durable of backfillJobService.listDue()) {
    merged.set(durable.id, {
      id: durable.destinationId,
      sourceUsernames: durable.sourceUsernames,
      limit: durable.limit,
      queuedAt: durable.queuedAt,
      sequence: durable.sequence,
      requestId: durable.id,
    });
  }
  for (const pending of getPendingBackfills()) merged.set(pending.requestId, pending);
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
}

function backfillStillRequested(destinationId: string, requestId?: string): boolean {
  return isBackfillStillRequested({
    destinationId,
    ...(requestId ? { requestId, durableJob: backfillJobService.get(requestId) } : {}),
    pending: mergedPendingBackfills(),
  });
}

async function main(): Promise<void> {
  const options = parseRuntimeOptions();
  if (options.bypassFilters && !options.dryRun) {
    throw new Error('--bypass-filters is only allowed with --dry-run.');
  }

  const config = getConfig();

  await migrateJsonToSqlite();

  if (!options.web) {
    console.log('🌐 Web interface is disabled.');
  } else {
    startServer();
    if (config.users.length === 0) {
      console.log('ℹ️  No users found. Please register on the web interface to get started.');
    }
  }

  if (options.importHistory) {
    const username = options.username;
    if (!username) {
      console.error('Please specify a username with --username <username>');
      process.exit(1);
    }
    const client = await getTwitterScraper();
    if (!client) {
      console.error('Twitter credentials not set. Cannot import history.');
      process.exit(1);
    }
    const mapping = config.mappings.find((m) =>
      m.twitterUsernames.map((u) => u.toLowerCase()).includes(username.toLowerCase()),
    );
    if (!mapping) {
      console.error(`No mapping found for ${username}`);
      process.exit(1);
    }
    if (!mapping.enabled || !getActiveTwitterUsernames(mapping).includes(username.toLowerCase())) {
      console.error(`Destination or @${username} is paused. Resume it before importing history.`);
      process.exit(1);
    }
    await importHistory(
      username,
      mapping.bskyIdentifier,
      options.limit,
      options.dryRun,
      true,
      undefined,
      'history-import',
      options.dryRun ? 'inline' : 'queue',
      options.bypassFilters,
    );
    if (!options.dryRun) {
      await drainDurableQueue(getConfig());
    }
    process.exit(0);
  }

  const findMappingById = (mappings: AccountMapping[], id: string) => mappings.find((mapping) => mapping.id === id);
  const normalizeHandle = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const findMappingByRef = (mappings: AccountMapping[], ref: string) => {
    const needle = normalizeHandle(ref);
    return mappings.find(
      (mapping) =>
        mapping.id === ref ||
        normalizeHandle(mapping.bskyIdentifier) === needle ||
        mapping.twitterUsernames.some((username) => normalizeHandle(username) === needle),
    );
  };

  const createSubbranches = <T>(items: T[], branchCount = SUBBRANCH_COUNT): T[][] => {
    const branches = Array.from({ length: Math.max(1, branchCount) }, () => [] as T[]);
    for (let index = 0; index < items.length; index += 1) {
      branches[index % branches.length]?.push(items[index] as T);
    }
    return branches;
  };

  const runMappingsWithSubbranches = async (
    mappings: AccountMapping[],
    dryRun: boolean,
    modeLabel: 'scheduled' | 'run-once',
  ) => {
    const enabledMappings = mappings.filter((mapping) => mapping.enabled);
    if (enabledMappings.length === 0) {
      const logPrefix = modeLabel === 'run-once' ? '[CLI]' : '[Scheduler]';
      console.log(`${logPrefix} ℹ️ No enabled mappings found for ${modeLabel} cycle.`);
      return;
    }

    const branches = createSubbranches(enabledMappings);
    const tasks = branches.map(async (branchMappings, branchIndex) => {
      const sessionKey = `subbranch-${branchIndex + 1}`;
      if (branchMappings.length === 0) return;
      console.log(
        `[${modeLabel}] 🌿 Subbranch ${branchIndex + 1}/${branches.length} processing ${branchMappings.length} mapping(s).`,
      );
      for (const mapping of branchMappings) {
        await runAccountTask(mapping, undefined, dryRun, sessionKey, 'inline', options.bypassFilters);
      }
    });

    await Promise.all(tasks);
  };

  const runSingleCycle = async (cycleConfig: ReturnType<typeof getConfig>) => {
    if (options.backfillMapping) {
      const mapping = findMappingByRef(cycleConfig.mappings, options.backfillMapping);
      if (!mapping) {
        console.error(`No mapping found for '${options.backfillMapping}'.`);
        process.exit(1);
      }
      if (!mapping.enabled) {
        console.error(`Mapping '${mapping.bskyIdentifier}' is disabled.`);
        process.exit(1);
      }

      const requestId = `cli-${Date.now()}`;
      const backfillRequest: PendingBackfill = {
        id: mapping.id,
        limit: options.backfillLimit || options.limit || 15,
        queuedAt: Date.now(),
        sequence: 0,
        requestId,
      };

      console.log(`[CLI] 🚧 Running backfill for ${mapping.bskyIdentifier}...`);
      await runAccountTask(
        mapping,
        backfillRequest,
        options.dryRun,
        'subbranch-1',
        options.dryRun ? 'inline' : 'queue',
        options.bypassFilters,
      );
      if (!options.dryRun) {
        await drainDurableQueue(getConfig());
      }
      updateAppStatus({ state: 'idle', message: `Backfill complete for ${mapping.bskyIdentifier}` });
      return;
    }

    if (options.dryRun) {
      await runMappingsWithSubbranches(cycleConfig.mappings, true, 'run-once');
    } else {
      await runFetchSweep(cycleConfig);
      await drainDurableQueue(cycleConfig);
    }
    updateAppStatus({ state: 'idle', message: options.dryRun ? 'Dry run cycle complete' : 'Run-once cycle complete' });
  };

  if (options.runOnce || options.backfillMapping || options.dryRun) {
    await runSingleCycle(getConfig());
    console.log(options.dryRun ? 'Dry run cycle complete. Exiting.' : 'Run-once cycle complete. Exiting.');
    process.exit(0);
  }

  console.log(`Scheduler started. Base interval: ${getSchedulerIntervalMinutes(config)} minutes.`);
  console.log(
    `Pipeline config: fetch concurrency ${FETCH_CONCURRENCY}, scraper gap ${SCRAPER_MIN_GAP_MS}+${SCRAPER_JITTER_MS}ms jitter, ` +
      `post workers ${POST_WORKER_CONCURRENCY}, pacing ${POST_PACING_MIN_MS}-${POST_PACING_MAX_MS}ms, max attempts ${QUEUE_MAX_ATTEMPTS}.`,
  );
  recalculateNextCheckTime();

  recoverDestinationQueue(
    {
      resetProcessing: () => postQueueService.resetProcessing(),
      purgeFailedOlderThan: (ageMs) => postQueueService.purgeFailedOlderThan(ageMs),
      listMappingIds: () => postQueueService.getCounts().perMapping.map((entry) => entry.mapping_id),
      deleteByMappingId: (mappingId) => postQueueService.deleteByMappingId(mappingId),
      pendingCount: () => postQueueService.getCounts().pending,
      getConfig,
      onRecovered: (count) =>
        logPipeline('Queue', `♻️ Recovered ${count} in-flight tweet(s) from a previous run.`),
      onPending: (count) =>
        logPipeline('Queue', `📬 ${count} tweet(s) already queued; post workers will resume.`),
    },
    14 * 24 * 60 * 60 * 1000,
  );
  const recoveredBackfills = backfillJobService.resetProcessing();
  if (recoveredBackfills > 0) {
    logPipeline('Queue', `♻️ Recovered ${recoveredBackfills} interrupted backfill job(s).`);
  }
  destinationLeaseService.releaseOwner(RUNTIME_OWNER_ID);
  destinationLeaseService.purgeExpired();
  startPostWorkers();

  const schedulerService = new SchedulerService({
    clock: { now: () => Date.now() },
    sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    getConfig,
    getNextCheckTime,
    getWakeSignal: getSchedulerWakeSignal,
    getCommandsSince: getSchedulerCommandsSince,
    getPendingBackfills: mergedPendingBackfills,
    getPendingPinSyncs: () => getPendingPinSyncs().slice(0, SUBBRANCH_COUNT),
    processPinSyncs: async (pendingPinSyncs, cycleConfig) => {
      if (isRestoreRestartRequired()) {
        console.warn('[Scheduler] Restore restart required; skipping pin syncs.');
        return;
      }
      for (const pinSync of pendingPinSyncs) {
        const mapping = findMappingById(cycleConfig.mappings, pinSync.id);
        clearPinSync(pinSync.id);
        if (!mapping || !mapping.enabled) continue;
        const logPrefix = getMappingLogPrefix(mapping);
        try {
          updateAppStatus({ state: 'processing', message: `Syncing pinned tweet for ${mapping.bskyIdentifier}...` });
          const message = await syncPinnedTweetViaProfile(
            mapping,
            options.dryRun,
            'subbranch-1',
            'pin-sync-manual',
            pinSync.sourceUsername,
          );
          console.log(`${logPrefix} 📌 ${message}`);
          updateAppStatus({ state: 'idle', message });
        } catch (error) {
          console.error(`${logPrefix} ❌ Pin sync failed: ${describeError(error)}`);
          updateAppStatus({ state: 'idle', message: `Pin sync failed for ${mapping.bskyIdentifier}` });
        }
      }
    },
    processBackfills: async (pendingBackfills, cycleConfig) => {
      if (isRestoreRestartRequired()) {
        console.warn('[Scheduler] Restore restart required; skipping backfills.');
        return;
      }
      const estimatedPendingTweets = pendingBackfills.reduce((total, backfill) => {
        const mapping = findMappingById(cycleConfig.mappings, backfill.id);
        const accountCount = mapping
          ? Math.max(1, backfill.sourceUsernames?.length ?? getActiveTwitterUsernames(mapping).length)
          : 1;
        return total + accountCount * (backfill.limit || 15);
      }, 0);
      updateAppStatus({
        state: 'backfilling',
        message: `Backfill queue priority: ${pendingBackfills.length} job(s), ~${estimatedPendingTweets} tweets pending`,
      });

      const selectedBackfills: PendingBackfill[] = [];
      const mappingIds = new Set<string>();
      for (const backfill of pendingBackfills) {
        if (mappingIds.has(backfill.id)) continue;
        mappingIds.add(backfill.id);
        selectedBackfills.push(backfill);
        if (selectedBackfills.length >= SUBBRANCH_COUNT) break;
      }
      await Promise.all(
        selectedBackfills.map(async (backfill, branchIndex) => {
          const mapping = findMappingById(cycleConfig.mappings, backfill.id);
          if (mapping?.enabled) {
            const limit = backfill.limit || 15;
            console.log(
              `[Scheduler] 🚧 Backfill subbranch ${branchIndex + 1}/${SUBBRANCH_COUNT}: ${mapping.bskyIdentifier} (limit ${limit})`,
            );
            await runAccountTask(mapping, backfill, options.dryRun, `subbranch-${branchIndex + 1}`, 'queue');
          } else {
            backfillJobService.cancel({ id: backfill.requestId });
            clearBackfill(backfill.id, backfill.requestId);
          }
        }),
      );
    },
    runSweep: async (cycleConfig) => {
      if (isRestoreRestartRequired()) {
        console.warn('[Scheduler] Restore restart required; skipping fetch sweep.');
        return;
      }
      await runFetchSweep(cycleConfig);
    },
    updateLastCheckTime,
    onBackfillsDrained: ({ deferredSweep, scheduledSweepWasDue }) =>
      updateAppStatus({
        state: 'idle',
        message:
          deferredSweep || scheduledSweepWasDue
            ? 'Backfill queue complete. Scheduled checks next.'
            : 'Backfill queue empty',
        backfillMappingId: undefined,
        backfillRequestId: undefined,
      }),
    onSweepStarted: ({ deferred }) =>
      console.log(
        deferred
          ? `[${new Date().toISOString()}] ⏰ Running deferred scheduled checks after backfill queue.`
          : `[${new Date().toISOString()}] ⏰ Scheduled check triggered.`,
      ),
    onSweepCompleted: () =>
      updateAppStatus({ state: 'idle', message: 'Scheduled checks complete' }),
  });
  await schedulerService.runForever();
}

main();
