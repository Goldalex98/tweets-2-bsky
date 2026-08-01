/**
 * Manual check that the installed scraper still exposes what the pipeline reads
 * out of its bundle. X rotates GraphQL query ids, so `src/index.ts` scrapes the
 * UserTweets request template from the installed package rather than hardcoding
 * it; a package layout change would silently disable pinned-tweet sync.
 *
 * Run after upgrading @the-convocation/twitter-scraper:
 *   bun scripts/verify-scraper-compat.ts
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const failures: string[] = [];

const scraper = require('@the-convocation/twitter-scraper');
for (const symbol of ['Scraper', 'SearchMode']) {
  if (!(symbol in scraper)) failures.push(`missing export: ${symbol}`);
}
console.log(`exports: ${Object.keys(scraper).sort().join(', ')}`);

const entryPath = require.resolve('@the-convocation/twitter-scraper');
const candidates = [entryPath, path.join(path.dirname(entryPath), '..', 'esm', 'index.mjs')];
let template: string | null = null;
const readableBundles: string[] = [];
for (const candidate of candidates) {
  try {
    const contents = fs.readFileSync(candidate, 'utf8');
    readableBundles.push(contents);
    const match = contents.match(/UserTweets:\s*["'](https:\/\/[^"']+)["']/);
    if (match?.[1]) template ??= match[1];
  } catch {
    // try next candidate
  }
}

const scraperTypesPath = path.join(path.dirname(entryPath), '..', '..', 'types', 'index.d.ts');
try {
  const scraperTypes = fs.readFileSync(scraperTypesPath, 'utf8');
  for (const field of ['retweetedStatus?: Tweet', 'retweetedStatusId?: string']) {
    if (!scraperTypes.includes(field)) failures.push(`scraper Tweet type is missing ${field}`);
  }
} catch {
  failures.push('could not read the scraper Tweet type declarations');
}
if (!readableBundles.some((bundle) => bundle.includes('retweeted_status_result')) ||
  !readableBundles.some((bundle) => bundle.includes('retweetedStatus ='))) {
  failures.push('scraper bundle no longer appears to populate nested retweetedStatus content');
}
if (!template) {
  failures.push('could not read the UserTweets request template from the bundle');
} else {
  const queryId = template.match(/\/graphql\/([^/]+)\/UserTweets/)?.[1];
  console.log(`UserTweets queryId: ${queryId ?? 'unparsed'}`);
  if (!queryId) failures.push('UserTweets template found but the query id did not parse');
}

const atproto = require('@atproto/api');
for (const symbol of ['BskyAgent', 'RichText']) {
  if (!(symbol in atproto)) failures.push(`missing @atproto/api export: ${symbol}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nInstalled X and Bluesky packages match what the pipeline expects.');
