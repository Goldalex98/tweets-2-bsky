import { describe, expect, test } from 'bun:test';
import type { Tweet as ScraperTweet } from '@the-convocation/twitter-scraper';
import { normalizeXPost } from '../../src/normalized-post.js';
import { applyPostingPolicy, splitPostText } from '../../src/post-transform.js';
import { mapScraperTweetToLocalTweet } from '../../src/x-tweet-mapping.js';

const scraperTweet = (value: Record<string, unknown>): ScraperTweet =>
  value as unknown as ScraperTweet;

describe('X scraper tweet mapping', () => {
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
    });
    expect(mapped.full_text).toBe(`RT @OriginalAuthor: ${nestedText}`);
    expect(mapped.full_text?.match(/^RT @OriginalAuthor:/g)).toHaveLength(1);
    expect(mapped.entities?.urls?.[0]?.expanded_url).toBe('https://example.com/story');
    expect(mapped.extended_entities?.media).toHaveLength(2);
    expect(mapped.extended_entities?.media?.[0]?.ext_alt_text).toBe('Recovered photo description');

    const normalized = normalizeXPost(mapped as unknown as Record<string, unknown>, 'source-x', 'sourceaccount');
    expect(normalized.repostOf?.externalId).toBe('original-7');
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
  });
});
