import { describe, expect, test } from 'bun:test';
import type { DigestPolicy } from '../../src/config/schemas.js';
import { buildDigestPreview, nextDigestRun } from '../../src/digest.js';
import type { DigestEntry } from '../../src/db.js';

const policy: DigestPolicy = {
  enabled: true,
  cadence: 'daily',
  timezone: 'America/New_York',
  hour: 9,
  minute: 30,
  grouping: 'source',
  template: 'Daily digest\n\n{entries}',
  maxEntries: 10,
  maxGraphemes: 2_000,
  includeSourceAttribution: true,
};

const entry = (id: number, sourceId = 'news'): DigestEntry => ({
  id,
  destinationId: 'destination',
  routeId: 'route',
  sourceId,
  sourceType: 'webhook',
  externalPostId: `post-${id}`,
  post: {
    sourceType: 'webhook',
    sourceId,
    externalId: `post-${id}`,
    text: `Entry ${id}`,
    createdAt: '2026-07-24T12:00:00.000Z',
    urls: [`https://example.com/${id}`],
    sensitive: false,
    media: [],
  },
  deliveryDiagnostics: [],
  status: 'pending',
  createdAt: id,
});

describe('durable digest planning', () => {
  test('calculates timezone-aware daily and weekly schedules', () => {
    const next = nextDigestRun(policy, Date.parse('2026-07-24T12:00:00Z'));
    expect(new Date(next).toISOString()).toBe('2026-07-24T13:30:00.000Z');
    const weekly = nextDigestRun(
      { ...policy, cadence: 'weekly', dayOfWeek: 1 },
      Date.parse('2026-07-24T12:00:00Z'),
    );
    expect(new Date(weekly).getUTCDay()).toBe(1);
  });

  test('groups entries and creates deterministic numbered chunks', () => {
    const entries = [entry(1, 'alpha'), entry(2, 'beta')];
    const first = buildDigestPreview(entries, policy, 'job-1');
    const second = buildDigestPreview(entries, policy, 'job-1');
    expect(first).toEqual(second);
    expect(first.text).toContain('alpha');
    expect(first.text).toContain('beta');
    expect(first.entryIds).toEqual([1, 2]);
  });

  test('retains entries excluded by entry and grapheme limits', () => {
    const preview = buildDigestPreview(
      [entry(1), { ...entry(2), post: { ...entry(2).post, text: 'x'.repeat(500) } }, entry(3)],
      { ...policy, maxEntries: 2, maxGraphemes: 120 },
    );
    expect(preview.entryIds).toEqual([1, 3]);
    expect(preview.truncatedEntryIds).toEqual([2]);
  });

  test('prefers the wrapper status URL for repost entries', () => {
    const repost = entry(4);
    repost.post = {
      ...repost.post,
      sourceType: 'x',
      externalId: 'wrapper-4',
      text: 'RT @author: Recovered repost',
      urls: [
        'https://example.com/article',
        'https://x.com/other/status/quoted-4',
        'https://x.com/source/status/wrapper-4',
      ],
      repostOf: { sourceType: 'x', sourceId: 'news', externalId: 'original-4' },
    };
    const preview = buildDigestPreview([repost], { ...policy, grouping: 'none' });
    expect(preview.text).toContain('https://x.com/source/status/wrapper-4');
    expect(preview.text).toContain('https://example.com/article');
    expect(preview.text).toContain('Repost on X: https://x.com/source/status/wrapper-4');
    expect(preview.text).not.toContain('Repost on X: https://x.com/other/status/quoted-4');
  });
});
