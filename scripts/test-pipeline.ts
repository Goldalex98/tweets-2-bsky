// Pre-push smoke test for the fetch-sweep + post-queue pipeline.
//
// Usage:
//   bun scripts/test-pipeline.ts [user1,user2,...] [limit]
//   bun run test:pipeline
//
// What it does:
//   1. Timed timeline fetches for a few accounts through the same global
//      rate-limiter gap the daemon uses, then projects full-sweep duration
//      for 50/100/300-account instances.
//   2. A full post_queue lifecycle (enqueue → dedupe → claim → retry →
//      crash-recovery → done) using the real fetched tweets, against a
//      throwaway data dir — your real database is never touched.
//
// Read-only on the Twitter side, no Bluesky involved. Credentials come from
// .env (auth_token/CT0 or TWITTER_AUTH_TOKEN/TWITTER_CT0), falling back to
// the dashboard config.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scraper } from '@the-convocation/twitter-scraper';

// --- Throwaway data dir (must be set before db.js is imported) ---
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-pipeline-test-'));
process.env.TWEETS2BSKY_DATA_DIR = scratchDir;
const { postQueueService } = await import('../src/db.js');

const usernames = (process.argv[2] || 'nasa,github,bsky')
  .split(',')
  .map((name) => name.trim().replace(/^@/, ''))
  .filter(Boolean);
const fetchLimit = Number.parseInt(process.argv[3] || '20', 10) || 20;

// --- Credentials (values may be wrapped in quotes; strip them) ---
const unquote = (value?: string): string | undefined => value?.trim().replace(/^["']|["']$/g, '') || undefined;
let authToken = unquote(process.env.TWITTER_AUTH_TOKEN) ?? unquote(process.env.auth_token);
let ct0 = unquote(process.env.TWITTER_CT0) ?? unquote(process.env.CT0) ?? unquote(process.env.ct0);
let source = '.env';
if (!authToken || !ct0) {
  const { getConfig } = await import('../src/config-manager.js');
  const config = getConfig();
  authToken = config.twitter.authToken;
  ct0 = config.twitter.ct0;
  source = 'config.json';
}
if (!authToken || !ct0) {
  console.error('❌ No Twitter credentials found. Set auth_token/CT0 (or TWITTER_AUTH_TOKEN/TWITTER_CT0) in .env');
  process.exit(1);
}

// Same defaults as the daemon's global scraper limiter.
const SCRAPER_MIN_GAP_MS = Number(process.env.SCRAPER_MIN_GAP_MS) || 800;
const SCRAPER_JITTER_MS = Number(process.env.SCRAPER_JITTER_MS) || 400;
let nextSlotMs = 0;
async function acquireScraperSlot(): Promise<void> {
  const gap = SCRAPER_MIN_GAP_MS + Math.floor(Math.random() * (SCRAPER_JITTER_MS + 1));
  const now = Date.now();
  const slot = Math.max(now, nextSlotMs);
  nextSlotMs = slot + gap;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
}

const fail = (message: string): never => {
  console.error(`\n❌ FAIL: ${message}`);
  fs.rmSync(scratchDir, { recursive: true, force: true });
  process.exit(1);
};
const check = (condition: boolean, label: string) => {
  if (!condition) fail(label);
  console.log(`   ✔ ${label}`);
};

console.log(`🔑 Credentials from ${source} (auth_token …${authToken.slice(-4)})`);
console.log(`🗂  Scratch data dir: ${scratchDir}`);
console.log(`\n━━ Phase 1: fetch speed (${usernames.length} account(s), limit ${fetchLimit}) ━━`);

const scraper = new Scraper();
await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);

interface FetchedAccount {
  username: string;
  tweets: { id: string; text: string; isRetweet: boolean }[];
  ms: number;
}

const results: FetchedAccount[] = [];
const sweepStart = Date.now();
for (const username of usernames) {
  const start = Date.now();
  await acquireScraperSlot();
  const gateMs = Date.now() - start;
  const tweets: FetchedAccount['tweets'] = [];
  try {
    for await (const tweet of scraper.getTweets(username, fetchLimit)) {
      if (tweet.id) tweets.push({ id: tweet.id, text: tweet.text || '', isRetweet: Boolean(tweet.isRetweet) });
      if (tweets.length >= fetchLimit) break;
    }
  } catch (error) {
    fail(`@${username} fetch errored: ${error instanceof Error ? error.message : error}`);
  }
  const ms = Date.now() - start;
  results.push({ username, tweets, ms });
  console.log(
    `   @${username.padEnd(15)} ${String(tweets.length).padStart(3)} tweets in ${ms}ms (limiter wait ${gateMs}ms)`,
  );
  if (tweets.length === 0)
    fail(`@${username} returned 0 tweets — credentials may be rate-limited or account is protected`);
}
const sweepMs = Date.now() - sweepStart;
// The first fetch pays one-time session warmup the daemon only pays at boot,
// so steady-state projections use the median account time instead of the mean.
const sorted = results.map((entry) => entry.ms).sort((a, b) => a - b);
const perAccountMs = sorted[Math.floor(sorted.length / 2)] ?? sweepMs / usernames.length;
console.log(
  `   Total: ${sweepMs}ms (first fetch includes session warmup); median ${Math.round(perAccountMs)}ms/account`,
);
for (const size of [50, 100, 300]) {
  // The daemon runs FETCH_CONCURRENCY sessions but the shared limiter gap is
  // the floor, so the projection uses max(gap, per-account/concurrency).
  const concurrency = Number(process.env.FETCH_CONCURRENCY) || 4;
  const projected = (size * Math.max(SCRAPER_MIN_GAP_MS + SCRAPER_JITTER_MS / 2, perAccountMs / concurrency)) / 1000;
  console.log(`   Projected full sweep @ ${String(size).padStart(3)} accounts: ~${Math.round(projected)}s`);
}

console.log('\n━━ Phase 2: post queue lifecycle (scratch DB) ━━');
const primary = results[0];
if (!primary) fail('no fetch results');
const mappingId = 'test-mapping';
const bsky = 'pipeline-test.bsky.social';
const toInput = (tweet: { id: string; text: string }) => ({
  twitter_id: tweet.id,
  bsky_identifier: bsky,
  mapping_id: mappingId,
  twitter_username: primary!.username,
  kind: 'scheduled' as const,
  tweet_json: JSON.stringify(tweet),
  tweet_text: tweet.text.slice(0, 300),
});

const originals = primary!.tweets.filter((tweet) => !tweet.isRetweet);
const inserted = postQueueService.enqueue(originals.map(toInput));
check(inserted === originals.length, `enqueued ${inserted} real tweet(s) from @${primary!.username}`);
check(postQueueService.enqueue(originals.map(toInput)) === 0, 'second enqueue fully deduped');

const allowed = new Set([mappingId]);
const batch = postQueueService.claimNextBatch(new Set(), allowed);
check(batch !== null && batch.items.length === inserted, `claimed all ${inserted} as one batch`);
const ids = batch!.items.map((item) => item.twitter_id);
check(
  ids.every((id, i) => i === 0 || BigInt(id) > BigInt(ids[i - 1] ?? '0')),
  'batch ordered oldest → newest (thread-safe ordering)',
);
check(postQueueService.claimNextBatch(new Set(), allowed) === null, 'mapping locked while batch in flight');

// Simulate: first tweet posts, second fails once, rest crash mid-flight.
postQueueService.markDone(ids[0]!, bsky);
if (batch!.items[1]) postQueueService.releaseForRetry(batch!.items[1]!, 'simulated post failure', 8);
let counts = postQueueService.getCounts();
check(counts.pending === 1 && counts.processing === inserted - 2, 'done row removed, failed row pending with backoff');
check(postQueueService.resetProcessing() === inserted - 2, 'crash recovery re-armed in-flight rows');
counts = postQueueService.getCounts();
check(counts.pending === inserted - 1 && counts.failed === 0, 'queue consistent after recovery');
for (const item of batch!.items.slice(1)) postQueueService.releaseForRetry(item, 'park it', 1);
check(postQueueService.getCounts().failed === inserted - 1, 'max-attempts parks rows as failed');
check(postQueueService.retryFailed() === inserted - 1, 'admin retry-failed requeues everything');
check(postQueueService.deleteByMappingId(mappingId) === inserted - 1, 'mapping purge clears the queue');

fs.rmSync(scratchDir, { recursive: true, force: true });
console.log(
  `\n✅ Pipeline smoke test passed — fetch median ${Math.round(perAccountMs)}ms/account (warm), queue lifecycle OK.`,
);
process.exit(0);
