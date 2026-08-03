import { describe, expect, test } from 'bun:test';
import {
  normalizeXPost,
  queuedPostForPolicyEvaluation,
  validateNormalizedPost,
} from '../../src/normalized-post.js';

const post = {
  sourceType: 'webhook',
  sourceId: 'source-webhook',
  externalId: 'external-1',
  text: 'A normalized post https://example.com/a',
  createdAt: '2026-07-24T12:00:00.000Z',
  urls: ['https://example.com/a#fragment'],
  language: 'en-US',
  sensitive: false,
  media: [
    {
      type: 'image',
      url: 'https://cdn.example.com/a.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      width: 800,
      height: 600,
      suppliedAlt: 'A useful description',
    },
  ],
} as const;

describe('provider-neutral normalized posts', () => {
  test('normalizes strict URL and timestamp metadata', () => {
    expect(validateNormalizedPost(post)).toMatchObject({
      sourceType: 'webhook',
      urls: ['https://example.com/a'],
      createdAt: '2026-07-24T12:00:00.000Z',
      language: 'en-us',
    });
  });

  test('rejects private URLs and mismatched media metadata', () => {
    expect(() =>
      validateNormalizedPost({
        ...post,
        media: [{ ...post.media[0], url: 'http://127.0.0.1/file.jpg' }],
      }),
    ).toThrow('local or private');
    expect(() =>
      validateNormalizedPost({
        ...post,
        media: [{ ...post.media[0], type: 'video' }],
      }),
    ).toThrow('does not match');
  });

  test('enforces content, collection, and media size limits', () => {
    expect(() => validateNormalizedPost({ ...post, text: 'x'.repeat(10_001) })).toThrow('grapheme');
    expect(() => validateNormalizedPost({ ...post, urls: Array(33).fill('https://example.com') })).toThrow(
      'urls',
    );
    expect(() =>
      validateNormalizedPost({
        ...post,
        media: [{ ...post.media[0], sizeBytes: 51 * 1024 * 1024 }],
      }),
    ).toThrow('sizeBytes');
  });

  test('treats blank optional media alt text as absent', () => {
    const normalized = validateNormalizedPost({
      ...post,
      media: [{ ...post.media[0], suppliedAlt: '', alt: '' }],
    });
    expect(normalized.media[0]?.alt).toBeUndefined();
    expect(normalized.media[0]?.suppliedAlt).toBeUndefined();
  });

  test('adapts X replies, quotes, media, and URLs once at the boundary', () => {
    const normalized = normalizeXPost(
      {
        id_str: '42',
        full_text: 'hello https://example.com',
        created_at: '2026-07-24T12:00:00Z',
        lang: 'en',
        in_reply_to_status_id_str: '41',
        conversation_id_str: '40',
        quoted_status_id_str: '30',
        entities: { urls: [{ expanded_url: 'https://example.com' }] },
        extended_entities: {
          media: [{ type: 'photo', media_url_https: 'https://cdn.example.com/image.jpg' }],
        },
      },
      'source-x',
      'Example',
    );
    expect(normalized).toMatchObject({
      sourceType: 'x',
      sourceId: 'source-x',
      externalId: '42',
      replyTo: { externalId: '41' },
      threadRoot: { externalId: '40' },
      quotedPost: { externalId: '30' },
      media: [{ type: 'image', mimeType: 'image/jpeg' }],
    });
  });

  test('drops blank X media alt text instead of aborting the sweep', () => {
    const normalized = normalizeXPost(
      {
        id_str: '43',
        full_text: 'photo without alt text',
        created_at: '2026-07-24T12:00:00Z',
        extended_entities: {
          media: [
            { type: 'photo', media_url_https: 'https://cdn.example.com/image.jpg', ext_alt_text: '' },
          ],
        },
      },
      'source-x',
      'Example',
    );
    expect(normalized.media).toEqual([
      expect.objectContaining({ type: 'image', alt: undefined, suppliedAlt: undefined }),
    ]);
  });

  test('carries the author and reply-target identity X supplies', () => {
    const normalized = normalizeXPost(
      {
        id_str: '42',
        full_text: 'a reply',
        created_at: '2026-07-24T12:00:00Z',
        user: { screen_name: 'Example', id_str: '900' },
        in_reply_to_status_id_str: '41',
        in_reply_to_screen_name: 'Somebody_Else',
        in_reply_to_user_id_str: '901',
      },
      'source-x',
      'example',
    );
    expect(normalized.author).toEqual({ username: 'example', id: '900' });
    expect(normalized.replyToAuthor).toEqual({ username: 'somebody_else', id: '901' });
  });

  test('falls back to the configured source handle when the payload omits the user', () => {
    const normalized = normalizeXPost(
      { id_str: '42', full_text: 'no user block', created_at: '2026-07-24T12:00:00Z' },
      'source-x',
      '@Example',
    );
    expect(normalized.author).toEqual({ username: 'example' });
    expect(normalized.replyToAuthor).toBeUndefined();
  });

  test('drops author identity that a scraper payload cannot supply cleanly', () => {
    const normalized = normalizeXPost(
      {
        id_str: '42',
        full_text: 'garbage identity',
        created_at: '2026-07-24T12:00:00Z',
        user: { screen_name: 'not a handle!', id_str: '  ' },
      },
      'source-x',
      'example',
    );
    expect(normalized.author).toBeUndefined();
  });
});

describe('queued policy re-evaluation payloads', () => {
  test('an X row is parsed as a scraper tweet', () => {
    const { post, imageUrls } = queuedPostForPolicyEvaluation({
      source_type: 'x',
      source_id: 'source-x',
      twitter_username: 'example',
      external_post_id: '42',
      tweet_json: JSON.stringify({
        id_str: '42',
        full_text: 'a tweet https://example.com',
        created_at: '2026-07-24T12:00:00Z',
        retweeted_status_id_str: '7',
        extended_entities: {
          media: [{ type: 'photo', media_url_https: 'https://cdn.example.com/x.jpg' }],
        },
      }),
    });
    expect(post).toMatchObject({ sourceType: 'x', text: 'a tweet https://example.com' });
    expect(imageUrls).toEqual(['https://cdn.example.com/x.jpg']);
  });

  test('a generic row is parsed as a normalized post, not as an X tweet', () => {
    const normalized = {
      sourceType: 'api',
      sourceId: 'source-api',
      externalId: 'api-1',
      text: 'a generic post about https://example.com',
      createdAt: '2026-07-24T12:00:00.000Z',
      urls: ['https://example.com/a'],
      sensitive: true,
      quotedPost: { sourceType: 'api', sourceId: 'source-api', externalId: 'api-0' },
      media: [
        {
          type: 'image',
          url: 'https://cdn.example.com/generic.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 2048,
        },
      ],
    };
    const { post, imageUrls } = queuedPostForPolicyEvaluation({
      source_type: 'api',
      source_id: 'source-api',
      twitter_username: 'source-api',
      external_post_id: 'api-1',
      tweet_json: JSON.stringify(normalized),
    });

    // Parsing this as an X tweet used to yield empty text, no URLs, no media
    // and an `original` content type, so keyword, domain, media and content-type
    // predicates all silently passed.
    expect(post.text).toBe('a generic post about https://example.com');
    expect(post.urls).toEqual(['https://example.com/a']);
    expect(post.sensitive).toBe(true);
    expect(post.quotedPost?.externalId).toBe('api-0');
    expect(imageUrls).toEqual(['https://cdn.example.com/generic.jpg']);
  });

  test('a corrupt generic payload is rejected rather than judged as empty', () => {
    expect(() =>
      queuedPostForPolicyEvaluation({
        source_type: 'api',
        twitter_username: 'source-api',
        external_post_id: 'api-1',
        tweet_json: JSON.stringify({ sourceType: 'api', sourceId: 'source-api' }),
      }),
    ).toThrow();
  });
});
