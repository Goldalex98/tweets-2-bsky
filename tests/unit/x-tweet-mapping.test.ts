import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import type { Tweet as ScraperTweet } from '@the-convocation/twitter-scraper';
import { normalizeXPost } from '../../src/normalized-post.js';
import { applyPostingPolicy, splitPostText } from '../../src/post-transform.js';
import { mapScraperTweetToLocalTweet } from '../../src/x-tweet-mapping.js';

const scraperTweet = (value: Record<string, unknown>): ScraperTweet =>
  value as unknown as ScraperTweet;

describe('X scraper tweet mapping', () => {
  test('matches the installed scraper nested-repost contract using a redacted fixture', () => {
    const fixture = JSON.parse(
      fs.readFileSync(new URL('../fixtures/x-repost-nested-redacted.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const mapped = mapScraperTweetToLocalTweet(scraperTweet(fixture));

    expect(mapped).toMatchObject({
      id_str: '900000000000000001',
      retweeted_status_id_str: '800000000000000001',
      repostContentSource: 'nested',
      permanentUrl: 'https://x.com/source_account/status/900000000000000001',
      lang: 'en',
    });
    expect(mapped.full_text).toEndWith('This closing sentence must survive mapping.');
    expect(mapped.extended_entities?.media?.[0]?.ext_alt_text).toBe('Redacted representative alt text');
  });

  test('recovers complete nested repost content while preserving wrapper identity', () => {
    const finalSentence = 'This final sentence proves the complete repost survived.';
    const nestedText = `${'Complete original content with enough words to require threading. '.repeat(8)}${finalSentence}`;
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-42',
        username: 'SourceAccount',
        userId: 'source-user',
        isRetweet: true,
        permanentUrl: 'https://twitter.com/SourceAccount/status/wrapper-42',
        text: 'RT @OriginalAuthor: Complete original content…',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
        __raw_UNSTABLE: {
          id_str: 'wrapper-42',
          full_text: 'RT @OriginalAuthor: Complete original content…',
          created_at: '2026-08-01T12:00:00Z',
          retweeted_status_id_str: 'original-7',
          entities: { urls: [] },
        },
        retweetedStatusId: 'original-7',
        retweetedStatus: {
          id: 'original-7',
          username: 'OriginalAuthor',
          text: nestedText,
          sensitiveContent: true,
          urls: ['https://example.com/story'],
          photos: [],
          videos: [],
          hashtags: [],
          mentions: [],
          thread: [],
          __raw_UNSTABLE: {
            id_str: 'original-7',
            full_text: nestedText,
            lang: 'en',
            possibly_sensitive: true,
            entities: { urls: [{ url: 'https://t.co/story', expanded_url: 'https://example.com/story' }] },
            extended_entities: {
              media: [
                {
                  url: 'https://t.co/photo',
                  media_url_https: 'https://cdn.example.com/photo.jpg',
                  type: 'photo',
                  ext_alt_text: 'Recovered photo description',
                },
                {
                  url: 'https://t.co/video',
                  media_url_https: 'https://cdn.example.com/video-preview.jpg',
                  type: 'video',
                  video_info: { variants: [{ content_type: 'video/mp4', url: 'https://cdn.example.com/video.mp4' }] },
                },
              ],
            },
            card: { name: 'poll2choice_text_only', url: 'https://x.com/i/status/original-7' },
          },
        },
      }),
    );

    expect(mapped).toMatchObject({
      id_str: 'wrapper-42',
      created_at: '2026-08-01T12:00:00Z',
      retweeted_status_id_str: 'original-7',
      permanentUrl: 'https://x.com/SourceAccount/status/wrapper-42',
      user: { screen_name: 'SourceAccount', id_str: 'source-user' },
      possibly_sensitive: true,
      lang: 'en',
      card: { name: 'poll2choice_text_only' },
      repostContentSource: 'nested',
    });
    expect(mapped.full_text).toBe(`RT @OriginalAuthor: ${nestedText}`);
    expect(mapped.full_text?.match(/^RT @OriginalAuthor:/g)).toHaveLength(1);
    expect(mapped.entities?.urls?.[0]?.expanded_url).toBe('https://example.com/story');
    expect(mapped.extended_entities?.media).toHaveLength(2);
    expect(mapped.extended_entities?.media?.[0]?.ext_alt_text).toBe('Recovered photo description');

    const normalized = normalizeXPost(mapped as unknown as Record<string, unknown>, 'source-x', 'sourceaccount');
    expect(normalized.repostOf?.externalId).toBe('original-7');
    expect(normalized.repostContentSource).toBe('nested');
    expect(normalized.urls).toContain('https://x.com/SourceAccount/status/wrapper-42');
    const transformed = applyPostingPolicy(
      normalized.text,
      {
        attribution: { mode: 'never', template: 'Source: @{username}', rootPostsOnly: true, linkSource: true },
        appendOriginalPostLink: false,
      },
      {
        twitterUsername: 'sourceaccount',
        tweetId: 'wrapper-42',
        originalPostUrl: mapped.permanentUrl ?? '',
        destinationIdentifier: 'destination.bsky.social',
        sourceCount: 1,
        isReply: false,
        isThreadRoot: true,
        forceOriginalPostLink: true,
      },
    );
    const chunks = splitPostText(transformed.text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain(finalSentence);
    expect(transformed.text.split(mapped.permanentUrl ?? '')).toHaveLength(2);
  });

  test('recovers long-form note text retained in a nested repost result', () => {
    const noteText =
      'A long-form repost continues past the legacy cutoff and preserves every sentence after the media link.';
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-note',
        username: 'source',
        isRetweet: true,
        text: 'RT @author: A long-form repost continues…',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
        __raw_UNSTABLE: {
          id_str: 'wrapper-note',
          full_text: 'RT @author: A long-form repost continues…',
          retweeted_status_result: {
            result: {
              note_tweet: {
                note_tweet_results: {
                  result: { text: noteText },
                },
              },
            },
          },
        },
        retweetedStatusId: 'original-note',
        retweetedStatus: {
          id: 'original-note',
          username: 'author',
          text: 'A long-form repost continues https://t.co/media',
          urls: [],
          photos: [],
          videos: [],
          hashtags: [],
          mentions: [],
          thread: [],
          __raw_UNSTABLE: {
            id_str: 'original-note',
            full_text: 'A long-form repost continues https://t.co/media',
          },
        },
      }),
    );

    expect(mapped.full_text).toBe(`RT @author: ${noteText}`);
    expect(mapped.full_text).not.toContain('https://t.co/media');
    expect(mapped.repostContentSource).toBe('nested');
  });

  test('synthesizes nested links and media when raw nested data is unavailable', () => {
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-2',
        username: 'source',
        isRetweet: true,
        text: 'RT @author: short…',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
        retweetedStatus: {
          id: 'original-2',
          username: 'author',
          text: 'Complete fallback body',
          urls: ['https://example.com/fallback'],
          photos: [{ id: 'photo', url: 'https://cdn.example.com/fallback.jpg', alt_text: 'Fallback alt' }],
          videos: [{ id: 'video', preview: 'https://cdn.example.com/preview.jpg', url: 'https://cdn.example.com/video.mp4' }],
          hashtags: [],
          mentions: [],
          thread: [],
        },
      }),
    );

    expect(mapped.full_text).toBe('RT @author: Complete fallback body');
    expect(mapped.retweeted_status_id_str).toBe('original-2');
    expect(mapped.entities?.urls?.[0]?.expanded_url).toBe('https://example.com/fallback');
    expect(mapped.extended_entities?.media?.map((media) => media.type)).toEqual(['photo', 'video']);
  });

  test('retains complete quoted-post metadata from inside a repost', () => {
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-quote',
        username: 'source',
        isRetweet: true,
        text: 'RT @author: Commentary on a quoted post…',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
        retweetedStatus: {
          id: 'repost-body',
          username: 'author',
          text: 'Commentary on a quoted post',
          quotedStatusId: 'quoted-99',
          urls: [],
          photos: [],
          videos: [],
          hashtags: [],
          mentions: [],
          thread: [],
          quotedStatus: {
            id: 'quoted-99',
            username: 'quoted_author',
            text: 'Fallback parsed text',
            permanentUrl: 'https://twitter.com/quoted_author/status/quoted-99',
            sensitiveContent: false,
            urls: [],
            photos: [{ id: 'photo-1', url: 'https://cdn.example.invalid/quoted.jpg', alt_text: 'Quoted image' }],
            videos: [],
            hashtags: [],
            mentions: [],
            thread: [],
            __raw_UNSTABLE: { full_text: 'Complete quoted post text from raw data.' },
          },
        },
      }),
    );

    expect(mapped.quoted_status_id_str).toBe('quoted-99');
    expect(mapped.is_quote_status).toBe(true);
    expect(mapped.quotedPost).toEqual({
      id: 'quoted-99',
      username: 'quoted_author',
      text: 'Complete quoted post text from raw data.',
      permanentUrl: 'https://x.com/quoted_author/status/quoted-99',
      thumbnailUrl: 'https://cdn.example.invalid/quoted.jpg',
      sensitive: false,
    });
  });

  test('retains parsed quoted-post metadata without unstable raw data', () => {
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'direct-quote',
        username: 'source',
        text: 'Direct quote commentary',
        quotedStatusId: 'quoted-parsed',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
        quotedStatus: {
          id: 'quoted-parsed',
          username: 'parsed_author',
          text: 'Complete parsed quote text.',
          urls: [],
          photos: [],
          videos: [{ id: 'video-1', preview: 'https://cdn.example.invalid/preview.jpg', url: 'https://cdn.example.invalid/video.mp4' }],
          hashtags: [],
          mentions: [],
          thread: [],
        },
      }),
    );

    expect(mapped.quotedPost).toMatchObject({
      id: 'quoted-parsed',
      username: 'parsed_author',
      text: 'Complete parsed quote text.',
      permanentUrl: 'https://x.com/parsed_author/status/quoted-parsed',
      thumbnailUrl: 'https://cdn.example.invalid/preview.jpg',
    });
  });

  test('keeps the wrapper text when nested repost data is missing', () => {
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-3',
        username: 'source',
        isRetweet: true,
        text: 'RT @missing: Only the wrapper is available…',
        permanentUrl: 'https://twitter.com/source/status/wrapper-3',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
      }),
    );

    expect(mapped.full_text).toBe('RT @missing: Only the wrapper is available…');
    expect(mapped.permanentUrl).toBe('https://x.com/source/status/wrapper-3');
    expect(mapped.repostContentSource).toBe('wrapper');
  });

  test('treats a textless nested status as wrapper fallback without losing wrapper entities', () => {
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-empty',
        username: 'source',
        isRetweet: true,
        text: 'RT @author: Wrapper body…',
        urls: ['https://example.com/wrapper'],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
        retweetedStatusId: 'original-empty',
        retweetedStatus: {
          id: 'original-empty',
          username: 'author',
          text: '   ',
          urls: [],
          photos: [],
          videos: [],
          hashtags: [],
          mentions: [],
          thread: [],
        },
      }),
    );

    expect(mapped.full_text).toBe('RT @author: Wrapper body…');
    expect(mapped.entities?.urls?.[0]?.expanded_url).toBe('https://example.com/wrapper');
    expect(mapped.retweeted_status_id_str).toBe('original-empty');
    expect(mapped.repostContentSource).toBe('wrapper');
  });

  test('recognizes an ID-only repost payload as wrapper fallback', () => {
    const mapped = mapScraperTweetToLocalTweet(
      scraperTweet({
        id: 'wrapper-id-only',
        username: 'source',
        text: 'RT @author: Wrapper only…',
        retweetedStatusId: 'original-id-only',
        urls: [],
        photos: [],
        videos: [],
        hashtags: [],
        mentions: [],
        thread: [],
      }),
    );

    expect(mapped.isRetweet).toBe(true);
    expect(mapped.retweeted_status_id_str).toBe('original-id-only');
    expect(mapped.repostContentSource).toBe('wrapper');
    expect(normalizeXPost(mapped as unknown as Record<string, unknown>, 'source-x', 'source').repostContentSource)
      .toBe('wrapper');
  });
});
