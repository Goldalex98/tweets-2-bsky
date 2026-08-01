import type { Tweet as ScraperTweet } from '@the-convocation/twitter-scraper';
import type { TweetCard, TweetEntities } from './tweet-cards.js';

export interface LocalTweet {
  id?: string;
  id_str?: string;
  text?: string;
  full_text?: string;
  created_at?: string;
  entities?: TweetEntities;
  extended_entities?: TweetEntities;
  quoted_status_id_str?: string;
  retweeted_status_id_str?: string;
  is_quote_status?: boolean;
  in_reply_to_status_id_str?: string;
  in_reply_to_status_id?: string;
  in_reply_to_user_id_str?: string;
  in_reply_to_user_id?: string;
  isRetweet?: boolean;
  isPin?: boolean;
  possibly_sensitive?: boolean;
  lang?: string;
  user?: {
    screen_name?: string;
    id_str?: string;
  };
  card?: TweetCard | null;
  permanentUrl?: string;
  repostContentSource?: 'nested' | 'wrapper';
}

interface RawExtras {
  possibly_sensitive?: unknown;
  lang?: unknown;
  in_reply_to_user_id_str?: string;
  card?: TweetCard | null;
}

const normalizeXStatusUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() === 'twitter.com' || parsed.hostname.toLowerCase() === 'www.twitter.com') {
      parsed.hostname = 'x.com';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value.replace('twitter.com', 'x.com');
  }
};

const fallbackPermanentUrl = (tweet: ScraperTweet): string | undefined => {
  const id = tweet.id;
  const username = tweet.username;
  return id && username ? `https://x.com/${username}/status/${id}` : undefined;
};

const scraperLanguage = (tweet: ScraperTweet | undefined): string | undefined => {
  const language = (tweet as unknown as { language?: unknown } | undefined)?.language;
  return typeof language === 'string' ? language : undefined;
};

const fallbackEntities = (tweet: ScraperTweet): TweetEntities => ({
  urls: tweet.urls.map((url) => ({ url, expanded_url: url })),
  media: [
    ...tweet.photos.map((photo) => ({
      url: photo.url,
      expanded_url: photo.url,
      media_url_https: photo.url,
      type: 'photo' as const,
      ext_alt_text: photo.alt_text,
    })),
    ...tweet.videos.map((video) => ({
      url: video.url,
      expanded_url: video.url,
      media_url_https: video.preview,
      type: 'video' as const,
      video_info: video.url
        ? { variants: [{ content_type: 'video/mp4', url: video.url }] }
        : undefined,
    })),
  ],
});

const nestedRepostText = (nested: ScraperTweet | undefined): string | undefined => {
  if (!nested) return undefined;
  const rawText = nested.__raw_UNSTABLE?.full_text;
  if (typeof rawText === 'string' && rawText.trim()) return rawText;
  return typeof nested.text === 'string' && nested.text.trim() ? nested.text : undefined;
};

const repostText = (wrapperText: string, nested: ScraperTweet, nestedText: string): string => {
  const existingPrefix = wrapperText.match(/^RT\s+@[^:]+:\s*/i)?.[0];
  const prefix = existingPrefix ?? (nested.username ? `RT @${nested.username}: ` : 'RT: ');
  return `${prefix}${nestedText}`;
};

/**
 * Converts the scraper's parsed tweet into the legacy-shaped object consumed by
 * the X pipeline. Repost wrappers retain their identity while their canonical
 * content comes from the complete nested status exposed by the scraper.
 */
export function mapScraperTweetToLocalTweet(scraperTweet: ScraperTweet): LocalTweet {
  const wrapperRaw = scraperTweet.__raw_UNSTABLE;
  const wrapperExtras = wrapperRaw as (typeof wrapperRaw & RawExtras) | undefined;
  const nestedCandidate = scraperTweet.retweetedStatus;
  const recoveredNestedText = nestedRepostText(nestedCandidate);
  // A textless nested object is not usable content. Treat it exactly like a
  // missing nested status so wrapper text, entities and diagnostics survive.
  const nested = recoveredNestedText ? nestedCandidate : undefined;
  const nestedRaw = nested?.__raw_UNSTABLE;
  const nestedExtras = nestedRaw as (typeof nestedRaw & RawExtras) | undefined;
  const wrapperText = wrapperRaw?.full_text ?? scraperTweet.text ?? '';
  const contentText = nested && recoveredNestedText
    ? repostText(wrapperText, nested, recoveredNestedText)
    : wrapperText;
  const contentEntities = nestedRaw?.entities as unknown as TweetEntities | undefined;
  const contentExtendedEntities = nestedRaw?.extended_entities as unknown as TweetEntities | undefined;
  const synthesizedNestedEntities = nested ? fallbackEntities(nested) : undefined;
  const wrapperFallbackEntities = !wrapperRaw ? fallbackEntities(scraperTweet) : undefined;
  const permanentUrl = normalizeXStatusUrl(scraperTweet.permanentUrl) ?? fallbackPermanentUrl(scraperTweet);

  return {
    id: wrapperRaw?.id_str ?? scraperTweet.id,
    id_str: wrapperRaw?.id_str ?? scraperTweet.id,
    text: contentText,
    full_text: contentText,
    created_at: wrapperRaw?.created_at ?? scraperTweet.timeParsed?.toUTCString(),
    isRetweet: Boolean(
      scraperTweet.isRetweet ||
      nestedCandidate ||
      scraperTweet.retweetedStatusId ||
      wrapperRaw?.retweeted_status_id_str
    ),
    isPin: scraperTweet.isPin,
    possibly_sensitive:
      Boolean(nestedExtras?.possibly_sensitive) ||
      Boolean(nested?.sensitiveContent) ||
      Boolean(wrapperExtras?.possibly_sensitive) ||
      scraperTweet.sensitiveContent,
    lang:
      typeof nestedExtras?.lang === 'string'
        ? nestedExtras.lang
        : scraperLanguage(nested) ??
          (typeof wrapperExtras?.lang === 'string'
          ? wrapperExtras.lang
            : scraperLanguage(scraperTweet)),
    entities:
      (nested ? contentEntities ?? synthesizedNestedEntities : wrapperRaw?.entities as unknown as TweetEntities) ??
      wrapperFallbackEntities,
    extended_entities: nested
      ? contentExtendedEntities ?? synthesizedNestedEntities
      : (wrapperRaw?.extended_entities as unknown as TweetEntities | undefined),
    quoted_status_id_str: nested ? nestedRaw?.quoted_status_id_str : wrapperRaw?.quoted_status_id_str,
    retweeted_status_id_str:
      wrapperRaw?.retweeted_status_id_str ?? scraperTweet.retweetedStatusId ?? nestedCandidate?.id,
    is_quote_status: nested ? Boolean(nestedRaw?.quoted_status_id_str) : Boolean(wrapperRaw?.quoted_status_id_str),
    in_reply_to_status_id_str: nested ? nestedRaw?.in_reply_to_status_id_str : wrapperRaw?.in_reply_to_status_id_str,
    in_reply_to_user_id_str: nested ? nestedExtras?.in_reply_to_user_id_str : wrapperExtras?.in_reply_to_user_id_str,
    card: nested
      ? nestedExtras?.card ?? (nested as unknown as { card?: TweetCard }).card ?? wrapperExtras?.card
      : wrapperExtras?.card,
    permanentUrl,
    repostContentSource: nested
      ? 'nested'
      : scraperTweet.isRetweet || nestedCandidate || scraperTweet.retweetedStatusId || wrapperRaw?.retweeted_status_id_str
        ? 'wrapper'
        : undefined,
    user: {
      screen_name: scraperTweet.username,
      id_str: scraperTweet.userId,
    },
  };
}
