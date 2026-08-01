import { createHash } from 'node:crypto';
import type { DigestPolicy } from './config/schemas.js';
import type { DigestEntry } from './db.js';
import { splitPostText } from './post-transform.js';

export interface DigestChunk {
  index: number;
  count: number;
  text: string;
  contentHash: string;
  idempotencyKey: string;
}

export interface DigestPreview {
  text: string;
  entryIds: number[];
  truncatedEntryIds: number[];
  chunks: DigestChunk[];
}

function zonedParts(timestamp: number, timezone: string): {
  hour: number;
  minute: number;
  weekday: number;
  date: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
  return {
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    weekday,
    date: `${value('year')}-${value('month')}-${value('day')}`,
  };
}

export function nextDigestRun(policy: DigestPolicy, after = Date.now()): number {
  try {
    zonedParts(after, policy.timezone);
  } catch {
    throw new Error(`Invalid digest timezone: ${policy.timezone}.`);
  }
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  const maxMinutes = policy.cadence === 'weekly' ? 15 * 24 * 60 : 3 * 24 * 60;
  for (let offset = 0; offset <= maxMinutes; offset += 1) {
    const candidate = start + offset * 60_000;
    const parts = zonedParts(candidate, policy.timezone);
    const minuteMatches = parts.minute === policy.minute;
    const hourMatches = policy.cadence === 'hourly' || parts.hour === policy.hour;
    const dayMatches = policy.cadence !== 'weekly' || parts.weekday === (policy.dayOfWeek ?? 1);
    if (minuteMatches && hourMatches && dayMatches) return candidate;
  }
  throw new Error('Could not calculate the next digest run.');
}

const graphemes = (value: string): number =>
  Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
    : Array.from(value).length;

const isXStatusUrl = (url: string): boolean =>
  /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/[^/?#]+/i.test(url);

const xStatusId = (url: string): string | undefined => {
  if (!isXStatusUrl(url)) return undefined;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const statusIndex = segments.findIndex((segment) => segment.toLowerCase() === 'status');
    return statusIndex >= 0 ? segments[statusIndex + 1] : undefined;
  } catch {
    return undefined;
  }
};

function entryLine(entry: DigestEntry, index: number, includeSource: boolean): string {
  const attribution = includeSource ? ` (${entry.post.sourceId})` : '';
  const repostStatusUrl = entry.post.repostOf
    ? entry.post.urls.find((url) => xStatusId(url) === entry.post.externalId)
    : undefined;
  const externalUrl = entry.post.repostOf
    ? entry.post.urls.find((url) => !isXStatusUrl(url))
    : entry.post.urls[0];
  const links = [
    externalUrl,
    repostStatusUrl ? `Repost on X: ${repostStatusUrl}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const linkText = links.length > 0 ? ` ${links.join(' ')}` : '';
  return `${index + 1}. ${entry.post.text}${linkText}${attribution}`.trim();
}

function renderGroupedEntries(entries: readonly DigestEntry[], policy: DigestPolicy): string {
  if (policy.grouping === 'none') {
    return entries.map((entry, index) => entryLine(entry, index, policy.includeSourceAttribution)).join('\n\n');
  }
  const groups = new Map<string, DigestEntry[]>();
  for (const entry of entries) {
    const key =
      policy.grouping === 'source'
        ? entry.post.sourceId
        : zonedParts(Date.parse(entry.post.createdAt), policy.timezone).date;
    const values = groups.get(key) ?? [];
    values.push(entry);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .map(([key, values]) => `${key}\n${values.map((entry, index) => entryLine(entry, index, false)).join('\n')}`)
    .join('\n\n');
}

export function buildDigestPreview(
  entries: readonly DigestEntry[],
  policy: DigestPolicy,
  jobId = 'preview',
): DigestPreview {
  const selected: DigestEntry[] = [];
  const truncatedEntryIds: number[] = [];
  for (const entry of entries) {
    if (selected.length >= policy.maxEntries) {
      truncatedEntryIds.push(entry.id);
      continue;
    }
    const candidate = [...selected, entry];
    const rendered = policy.template.replace('{entries}', renderGroupedEntries(candidate, policy));
    if (graphemes(rendered) > policy.maxGraphemes && selected.length > 0) {
      truncatedEntryIds.push(entry.id);
      continue;
    }
    selected.push(entry);
  }
  const text = policy.template.replace('{entries}', renderGroupedEntries(selected, policy)).trim();
  const rawChunks = splitPostText(text, 285);
  const chunks = rawChunks.map((chunk, index): DigestChunk => {
    const numbered = rawChunks.length > 1 ? `${chunk}\n\n${index + 1}/${rawChunks.length}` : chunk;
    const contentHash = createHash('sha256').update(numbered).digest('hex');
    return {
      index,
      count: rawChunks.length,
      text: numbered,
      contentHash,
      idempotencyKey: createHash('sha256')
        .update(`${jobId}\0${index}\0${contentHash}`)
        .digest('hex'),
    };
  });
  return {
    text,
    entryIds: selected.map((entry) => entry.id),
    truncatedEntryIds,
    chunks,
  };
}
