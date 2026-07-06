// Smoke test: verify branded/ad tweets (unified cards) recover their media.
//
// Usage:
//   bun scripts/test-ad-tweet.ts [username] [tweetId]
//
// Fetches the tweet like the app does (scraper timeline), then runs the same
// card-recovery pipeline from src/tweet-cards.ts: syndication card fetch,
// sponsored-card detection, and media/link injection. No posting happens.
import 'dotenv/config';
import { Scraper } from '@the-convocation/twitter-scraper';
import axios from 'axios';
import { getConfig } from '../src/config-manager.js';
import { type CardTweet, buildPollNote, ensureSponsoredLinks, recoverCardData } from '../src/tweet-cards.js';

const username = (process.argv[2] || 'Arsenal').replace(/^@/, '');
const tweetId = process.argv[3]; // optional: check one specific tweet

let authToken = (process.env.TWITTER_AUTH_TOKEN || process.env.auth_token)?.trim();
let ct0 = (process.env.TWITTER_CT0 || process.env.CT0)?.trim();

if (!authToken || !ct0) {
  const config = getConfig();
  authToken = config.twitter.authToken;
  ct0 = config.twitter.ct0;
}

if (!authToken || !ct0) {
  console.error('❌ No Twitter credentials found. Set TWITTER_AUTH_TOKEN and TWITTER_CT0 in .env');
  process.exit(1);
}

const scraper = new Scraper();
await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);

interface LocalTweet extends CardTweet {
  id?: string;
  full_text?: string;
}

async function checkUrl(url: string): Promise<string> {
  try {
    const res = await axios.head(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return `${res.status} ${res.headers['content-type'] || ''}`;
  } catch (err) {
    return `unreachable (${err instanceof Error ? err.message : err})`;
  }
}

async function runPipeline(tweet: LocalTweet): Promise<boolean> {
  console.log(`\n━━━ Tweet ${tweet.id} ━━━`);
  console.log(`Text: ${tweet.full_text?.slice(0, 100)?.replace(/\n/g, ' ')}`);

  const nativeMedia = tweet.extended_entities?.media || tweet.entities?.media || [];
  console.log(`Native media entities: ${nativeMedia.length}`);

  // Same check stage as processTweet in src/index.ts
  const { isSponsoredCard } = await recoverCardData(tweet);
  if (tweet.card) console.log(`Card: ${tweet.card.name}`);

  const media = tweet.extended_entities?.media || tweet.entities?.media || [];
  console.log(`Sponsored card: ${isSponsoredCard} | media after injection: ${media.length}`);

  for (const entity of media) {
    if (entity.type === 'photo') {
      const url = entity.media_url_https;
      console.log(`  📷 photo ${url}`);
      if (url) console.log(`     :orig → ${await checkUrl(`${url}:orig`)}`);
    } else {
      const variants = entity.video_info?.variants || [];
      const best = variants
        .filter((v) => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      console.log(`  🎬 ${entity.type} (${variants.length} variants) thumb=${entity.media_url_https}`);
      if (best) console.log(`     best mp4 (${best.bitrate}bps) → ${await checkUrl(best.url)}`);
    }
    console.log(`     alt: ${entity.ext_alt_text}`);
  }

  let text = ensureSponsoredLinks(tweet.full_text || '', tweet);
  const pollNote = buildPollNote(tweet.card, `https://x.com/${username}/status/${tweet.id}`);
  if (pollNote) text = `${text}\n\n${pollNote}`;
  const appended = text.slice((tweet.full_text || '').length).trim();
  if (appended) console.log(`Appended:\n  ${appended.replace(/\n/g, '\n  ')}`);

  return media.length > 0 || !!pollNote;
}

// biome-ignore lint/suspicious/noExplicitAny: raw scraper payload
function toLocalTweet(raw: any, id?: string): LocalTweet {
  return {
    id: raw?.id_str || id,
    full_text: raw?.full_text,
    entities: raw?.entities,
    extended_entities: raw?.extended_entities,
    card: raw?.card,
  };
}

let pass = 0;
let fail = 0;
let found = false;
for await (const scraped of scraper.getTweets(username, 40)) {
  if (tweetId && scraped.id !== tweetId) continue;
  const tweet = toLocalTweet(scraped.__raw_UNSTABLE, scraped.id);
  const hadNativeMedia = (tweet.extended_entities?.media || tweet.entities?.media || []).length > 0;
  if (!tweetId && hadNativeMedia) continue; // only exercise tweets that would have lost media

  found = true;
  const ok = await runPipeline(tweet);
  if (ok) pass++;
  else fail++;
  if (tweetId) break;
}

// Older tweets fall out of the recent timeline — exercise the recovery stage directly
if (tweetId && !found) {
  console.log(`\n(${tweetId} not in @${username}'s recent timeline — running syndication recovery directly)`);
  const ok = await runPipeline({ id: tweetId, full_text: '(text unavailable outside timeline)' });
  if (ok) pass++;
  else fail++;
}

console.log(`\n✅ ${pass} tweet(s) recovered card content, ⚠️ ${fail} text-only (plain text tweets are expected here)`);
