import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  canonicalizeContent,
  contentSha256,
  hammingDistance,
  perceptualImageHash,
} from '../../src/content-dedup.js';

describe('content duplicate fingerprints', () => {
  test('canonicalizes text and URL tracking deterministically', () => {
    const left = contentSha256('  HELLO   world https://www.example.com/a?utm_source=x&b=2&a=1 ');
    const right = contentSha256('hello world https://example.com/a?a=1&b=2');
    expect(left).toBe(right);
    expect(canonicalizeContent('Text', ['https://example.com/#fragment']).urls).toEqual([
      'https://example.com/',
    ]);
  });

  test('computes image hashes only when explicitly called', async () => {
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#224466' },
    })
      .png()
      .toBuffer();
    const first = await perceptualImageHash(image);
    const second = await perceptualImageHash(image);
    expect(first).toHaveLength(16);
    expect(hammingDistance(first, second)).toBe(0);
  });
});
