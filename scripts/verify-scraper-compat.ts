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
for (const candidate of candidates) {
  try {
    const match = fs
      .readFileSync(candidate, 'utf8')
      .match(/UserTweets:\s*["'](https:\/\/[^"']+)["']/);
    if (match?.[1]) {
      template = match[1];
      break;
    }
  } catch {
    // try next candidate
  }
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
