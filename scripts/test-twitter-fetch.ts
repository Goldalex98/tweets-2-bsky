// Smoke test: verify Twitter credentials can fetch tweets end-to-end.
//
// Usage:
//   bun scripts/test-twitter-fetch.ts [username] [limit]
//
// Credentials are read from .env (TWITTER_AUTH_TOKEN / TWITTER_CT0), falling
// back to the saved dashboard config (config.twitter). No posting happens —
// this only exercises the scraper fetch path.
import 'dotenv/config';
import { Scraper } from '@the-convocation/twitter-scraper';
import { getConfig } from '../src/config-manager.js';

const username = (process.argv[2] || process.env.TWITTER_TARGET_USERNAME || 'x').replace(/^@/, '');
const limit = Number.parseInt(process.argv[3] || '5', 10) || 5;

let authToken = process.env.TWITTER_AUTH_TOKEN?.trim();
let ct0 = process.env.TWITTER_CT0?.trim();
let source = '.env';

if (!authToken || !ct0) {
  const config = getConfig();
  authToken = config.twitter.authToken;
  ct0 = config.twitter.ct0;
  source = 'config.json';
}

if (!authToken || !ct0) {
  console.error('❌ No Twitter credentials found. Set TWITTER_AUTH_TOKEN and TWITTER_CT0 in .env');
  process.exit(1);
}

console.log(`🔑 Using credentials from ${source}`);
console.log(`🔍 Fetching up to ${limit} tweets from @${username}...\n`);

const scraper = new Scraper();
await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);

let count = 0;
let withMedia = 0;
try {
  for await (const tweet of scraper.getTweets(username, limit)) {
    count += 1;
    const raw = tweet.__raw_UNSTABLE;
    const mediaCount =
      raw?.extended_entities?.media?.length ??
      raw?.entities?.media?.length ??
      tweet.photos.length + tweet.videos.length;
    if (mediaCount > 0) withMedia += 1;
    const text = (tweet.text || '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  ${count}. [${tweet.id}] media=${mediaCount} rt=${tweet.isRetweet ? 'y' : 'n'} :: ${text}`);
    if (count >= limit) break;
  }
} catch (error) {
  console.error(`\n❌ Fetch failed: ${error instanceof Error ? error.message : error}`);
  console.error('   Check that auth_token/ct0 are current (they expire when the session is logged out).');
  process.exit(1);
}

if (count === 0) {
  console.error(
    '\n⚠️ Fetch succeeded but returned 0 tweets. Credentials may be rate-limited or the account is empty/protected.',
  );
  process.exit(1);
}

console.log(`\n✅ Fetched ${count} tweet(s) (${withMedia} with media). Twitter credentials are working.`);
process.exit(0);
