import { describe, expect, test } from 'bun:test';
import {
  ALT_TEXT_MAX_GRAPHEMES,
  normalizeAltText,
  orderMediaForUpload,
  shouldDropCardLinkFromText,
} from '../../src/media-policy.js';

const graphemeCount = (value: string) =>
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;

describe('alt text', () => {
  test('missing alt text stays empty instead of a placeholder', () => {
    expect(normalizeAltText(undefined)).toBe('');
    expect(normalizeAltText('   ')).toBe('');
    expect(normalizeAltText('  A cat on a sofa ')).toBe('A cat on a sofa');
  });

  test('long alt text is capped at the Bluesky grapheme limit without splitting an emoji', () => {
    const family = '👨‍👩‍👧‍👦';
    const capped = normalizeAltText(family.repeat(ALT_TEXT_MAX_GRAPHEMES + 50));
    expect(graphemeCount(capped)).toBe(ALT_TEXT_MAX_GRAPHEMES);
    expect(capped.endsWith(`${family}…`)).toBe(true);
    const exact = 'a'.repeat(ALT_TEXT_MAX_GRAPHEMES);
    expect(normalizeAltText(exact)).toBe(exact);
  });
});

describe('media upload order', () => {
  test('a video or GIF is tried before photos, keeping the rest in order', () => {
    const media = [
      { id: 'p1', type: 'photo' },
      { id: 'v1', type: 'video' },
      { id: 'p2', type: 'photo' },
      { id: 'g1', type: 'animated_gif' },
    ];
    expect(orderMediaForUpload(media).map((entry) => entry.id)).toEqual(['v1', 'g1', 'p1', 'p2']);
    expect(media.map((entry) => entry.id)).toEqual(['p1', 'v1', 'p2', 'g1']);
  });
});

describe('dropping the card link from long text', () => {
  const link = 'https://example.com/article';

  test('counts graphemes, as Bluesky does', () => {
    // 280 emoji are 560 UTF-16 units but only 280 graphemes, so this fits once the link goes.
    const text = `${'😀'.repeat(280)} ${link}`;
    expect(text.length).toBeGreaterThan(300);
    expect(shouldDropCardLinkFromText(text, link)).toBe(true);
  });

  test('keeps the link when the text fits or still overflows without it', () => {
    expect(shouldDropCardLinkFromText(`Short ${link}`, link)).toBe(false);
    expect(shouldDropCardLinkFromText(`${'x'.repeat(320)} ${link}`, link)).toBe(false);
    expect(shouldDropCardLinkFromText('x'.repeat(320), link)).toBe(false);
  });
});
