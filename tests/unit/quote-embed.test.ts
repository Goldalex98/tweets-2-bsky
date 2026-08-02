import { describe, expect, test } from 'bun:test';
import {
  buildQuoteCardMetadata,
  canonicalQuotedPostUrl,
  quoteFallbackOrder,
  removeEmbeddedQuoteUrl,
  resolveQuoteStrongRef,
} from '../../src/quote-embed.js';

describe('quoted X post embed planning', () => {
  test('prefers parsed cards, then screenshots, then the raw link', () => {
    expect(
      quoteFallbackOrder({
        hasSynthesizedMetadata: true,
        canUseExternalCard: true,
        canUseScreenshot: true,
      }),
    ).toEqual(['synthesized-card', 'screenshot', 'link']);
    expect(
      quoteFallbackOrder({
        hasSynthesizedMetadata: false,
        canUseExternalCard: true,
        canUseScreenshot: true,
      }),
    ).toEqual(['open-graph-card', 'screenshot', 'link']);
    expect(
      quoteFallbackOrder({
        hasSynthesizedMetadata: true,
        canUseExternalCard: false,
        canUseScreenshot: false,
      }),
    ).toEqual(['link']);
  });

  test('builds a natural canonical card and suppresses sensitive thumbnails', () => {
    const card = buildQuoteCardMetadata(
      {
        id: 'quote-1',
        username: 'original_author',
        text: 'Complete quoted post text.',
        permanentUrl: 'https://twitter.com/original_author/status/quote-1',
        thumbnailUrl: 'https://cdn.example.invalid/quote.jpg',
      },
      'quote-1',
    );
    expect(card).toEqual({
      uri: 'https://x.com/original_author/status/quote-1',
      title: 'Quoted post by @original_author on X',
      description: 'Complete quoted post text.',
      thumbnailUrl: 'https://cdn.example.invalid/quote.jpg',
    });
    expect(
      buildQuoteCardMetadata(
        {
          id: 'quote-1',
          username: 'original_author',
          text: 'Complete quoted post text.',
          thumbnailUrl: 'https://cdn.example.invalid/quote.jpg',
          sensitive: true,
        },
        'quote-1',
      )?.thumbnailUrl,
    ).toBeUndefined();
  });

  test('uses local native records before cross-destination records', () => {
    expect(
      resolveQuoteStrongRef(
        { uri: 'at://local/app.bsky.feed.post/one', cid: 'local-cid' },
        { uri: 'at://other/app.bsky.feed.post/two', cid: 'other-cid' },
      ),
    ).toEqual({ uri: 'at://local/app.bsky.feed.post/one', cid: 'local-cid' });
    expect(
      resolveQuoteStrongRef(null, { uri: 'at://other/app.bsky.feed.post/two', cid: 'other-cid' }),
    ).toEqual({ uri: 'at://other/app.bsky.feed.post/two', cid: 'other-cid' });
    expect(resolveQuoteStrongRef({ uri: 'at://incomplete' }, null)).toBeNull();
  });

  test('removes the redundant text URL after attaching a card', () => {
    const url = canonicalQuotedPostUrl({ id: 'quote-2', username: 'author' }, 'quote-2');
    expect(
      removeEmbeddedQuoteUrl(
        'Commentary\n\nhttps://twitter.com/i/status/quote-2',
        url,
        ['https://twitter.com/i/status/quote-2'],
      ),
    ).toBe('Commentary');
  });
});
