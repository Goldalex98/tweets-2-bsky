import { isIP } from 'node:net';

export type NormalizedSourceType = 'x' | 'webhook' | 'api';
export type NormalizedMediaType = 'image' | 'video' | 'gif';

export interface NormalizedPostReference {
  sourceType: NormalizedSourceType;
  sourceId: string;
  externalId: string;
}

/**
 * Upstream account identity. `sourceId` names the configured source, not the
 * person who wrote the post, so author and reply-target identities need their
 * own carrier for self-reply detection and author-mismatch checks to work.
 */
export interface NormalizedActor {
  username?: string;
  id?: string;
}

export interface NormalizedMediaDescriptor {
  type: NormalizedMediaType;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  /** Canonical supplied alt text. `suppliedAlt` remains a compatibility alias. */
  alt?: string;
  suppliedAlt?: string;
}

export interface NormalizedPost {
  sourceType: NormalizedSourceType;
  sourceId: string;
  externalId: string;
  text: string;
  createdAt: string;
  urls: string[];
  language?: string;
  sensitive: boolean;
  author?: NormalizedActor;
  replyToAuthor?: NormalizedActor;
  replyTo?: NormalizedPostReference;
  threadRoot?: NormalizedPostReference;
  quotedPost?: NormalizedPostReference;
  repostOf?: NormalizedPostReference;
  media: NormalizedMediaDescriptor[];
}

export interface NormalizedPostLimits {
  maxTextGraphemes: number;
  maxUrls: number;
  maxMedia: number;
  maxMediaBytes: number;
  maxAltGraphemes: number;
}

export const DEFAULT_NORMALIZED_POST_LIMITS: Readonly<NormalizedPostLimits> = {
  maxTextGraphemes: 10_000,
  maxUrls: 32,
  maxMedia: 4,
  maxMediaBytes: 50 * 1024 * 1024,
  maxAltGraphemes: 2_000,
};

const SOURCE_TYPES = new Set<NormalizedSourceType>(['x', 'webhook', 'api']);
const MEDIA_TYPES = new Set<NormalizedMediaType>(['image', 'video', 'gif']);
const MIME_BY_TYPE: Record<NormalizedMediaType, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  gif: ['image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
};

const graphemeCount = (value: string): number => {
  if (Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
  }
  return Array.from(value).length;
};

function requiredString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  const containsControl = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > maxLength || containsControl) {
    throw new Error(`${field} is missing or invalid.`);
  }
  return normalized;
}

function optionalLanguage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const language = requiredString(value, 'language', 35).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) throw new Error('language is invalid.');
  return language;
}

export function normalizePublicHttpUrl(value: unknown, field = 'url'): string {
  const raw = requiredString(value, field, 4096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${field} must be an absolute HTTP(S) URL without embedded credentials.`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateIp =
    isIP(host) > 0 &&
    (/^(?:10|127|0)\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) ||
      host === '::1' ||
      host === '::' ||
      /^f[cd][0-9a-f]{2}:/i.test(host) ||
      /^fe[89ab][0-9a-f]:/i.test(host));
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    privateIp
  ) {
    throw new Error(`${field} must not target a local or private address.`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeReference(value: unknown, field: string): NormalizedPostReference | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const record = value as Record<string, unknown>;
  if (!SOURCE_TYPES.has(record.sourceType as NormalizedSourceType)) throw new Error(`${field}.sourceType is invalid.`);
  return {
    sourceType: record.sourceType as NormalizedSourceType,
    sourceId: requiredString(record.sourceId, `${field}.sourceId`),
    externalId: requiredString(record.externalId, `${field}.externalId`),
  };
}

function normalizeActor(value: unknown, field: string): NormalizedActor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const record = value as Record<string, unknown>;
  const username =
    record.username === undefined || record.username === null || record.username === ''
      ? undefined
      : requiredString(record.username, `${field}.username`, 100).replace(/^@/, '').toLowerCase();
  const id =
    record.id === undefined || record.id === null || record.id === ''
      ? undefined
      : requiredString(record.id, `${field}.id`, 100);
  return username || id ? { ...(username ? { username } : {}), ...(id ? { id } : {}) } : undefined;
}

function normalizeMedia(
  value: unknown,
  index: number,
  limits: NormalizedPostLimits,
): NormalizedMediaDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`media[${index}] must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const type = record.type as NormalizedMediaType;
  if (!MEDIA_TYPES.has(type)) throw new Error(`media[${index}].type is invalid.`);
  const mimeType = requiredString(record.mimeType, `media[${index}].mimeType`, 100).toLowerCase();
  if (!MIME_BY_TYPE[type].includes(mimeType)) {
    throw new Error(`media[${index}].mimeType does not match its media type.`);
  }
  const sizeBytes = Number(record.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > limits.maxMediaBytes) {
    throw new Error(`media[${index}].sizeBytes is outside the allowed range.`);
  }
  const optionalDimension = (name: 'width' | 'height'): number | undefined => {
    if (record[name] === undefined) return undefined;
    const dimension = Number(record[name]);
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 16_384) {
      throw new Error(`media[${index}].${name} is invalid.`);
    }
    return dimension;
  };
  const suppliedAltValue = record.alt ?? record.suppliedAlt;
  const suppliedAlt =
    suppliedAltValue === undefined
      ? undefined
      : requiredString(suppliedAltValue, `media[${index}].alt`, 10_000);
  if (suppliedAlt && graphemeCount(suppliedAlt) > limits.maxAltGraphemes) {
    throw new Error(`media[${index}].suppliedAlt is too long.`);
  }
  const url = normalizePublicHttpUrl(record.url, `media[${index}].url`);
  if (!url.startsWith('https://')) throw new Error(`media[${index}].url must use HTTPS.`);
  return {
    type,
    url,
    mimeType,
    sizeBytes,
    width: optionalDimension('width'),
    height: optionalDimension('height'),
    alt: suppliedAlt,
    suppliedAlt,
  };
}

export function validateNormalizedPost(
  value: unknown,
  limits: NormalizedPostLimits = DEFAULT_NORMALIZED_POST_LIMITS,
): NormalizedPost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Post payload must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const sourceType = record.sourceType as NormalizedSourceType;
  if (!SOURCE_TYPES.has(sourceType)) throw new Error('sourceType is invalid.');
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text || graphemeCount(text) > limits.maxTextGraphemes) {
    throw new Error('text is missing or exceeds the configured grapheme limit.');
  }
  const timestamp = typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new Error('createdAt must be a valid ISO-8601 timestamp.');
  const rawUrls = record.urls === undefined ? [] : record.urls;
  if (!Array.isArray(rawUrls) || rawUrls.length > limits.maxUrls) throw new Error('urls exceeds the allowed limit.');
  const urls = [...new Set(rawUrls.map((url, index) => normalizePublicHttpUrl(url, `urls[${index}]`)))];
  const rawMedia = record.media === undefined ? [] : record.media;
  if (!Array.isArray(rawMedia) || rawMedia.length > limits.maxMedia) throw new Error('media exceeds the allowed limit.');
  return {
    sourceType,
    sourceId: requiredString(record.sourceId, 'sourceId'),
    externalId: requiredString(record.externalId, 'externalId'),
    text,
    createdAt: new Date(timestamp).toISOString(),
    urls,
    language: optionalLanguage(record.language),
    sensitive: record.sensitive === true,
    author: normalizeActor(record.author, 'author'),
    replyToAuthor: normalizeActor(record.replyToAuthor, 'replyToAuthor'),
    replyTo: normalizeReference(record.replyTo, 'replyTo'),
    threadRoot: normalizeReference(record.threadRoot, 'threadRoot'),
    quotedPost: normalizeReference(record.quotedPost, 'quotedPost'),
    repostOf: normalizeReference(record.repostOf, 'repostOf'),
    media: rawMedia.map((item, index) => normalizeMedia(item, index, limits)),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function entityUrl(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  const record = readRecord(entry);
  if (!record) return undefined;
  const expanded = record.expanded_url ?? record.url;
  return typeof expanded === 'string' ? expanded : undefined;
}

function xMediaDescriptor(value: Record<string, unknown>): NormalizedMediaDescriptor | undefined {
  const rawType = String(value.type ?? '').toLowerCase();
  const type: NormalizedMediaType | undefined =
    rawType === 'photo' || rawType === 'image'
      ? 'image'
      : rawType === 'animated_gif' || rawType === 'gif'
        ? 'gif'
        : rawType === 'video'
          ? 'video'
          : undefined;
  const url = value.media_url_https ?? value.media_url ?? value.url;
  if (!type || typeof url !== 'string') return undefined;
  const mimeType =
    value.mimeType ??
    value.mime_type ??
    (type === 'image' ? 'image/jpeg' : type === 'gif' ? 'image/gif' : 'video/mp4');
  const sizeBytes = value.sizeBytes;
  return {
    type,
    url: normalizePublicHttpUrl(url),
    mimeType: typeof mimeType === 'string' ? mimeType : String(mimeType),
    // X's scraper often omits content length. Boundary normalization uses a
    // conservative non-zero unknown marker; inbound API validation never does.
    sizeBytes:
      typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 ? sizeBytes : 1,
    width: Number.isInteger(value.width) ? (value.width as number) : undefined,
    height: Number.isInteger(value.height) ? (value.height as number) : undefined,
    alt: typeof value.ext_alt_text === 'string' ? value.ext_alt_text : undefined,
    suppliedAlt: typeof value.ext_alt_text === 'string' ? value.ext_alt_text : undefined,
  };
}

// Scraper payloads are untrusted, so anything that would fail actor validation
// is dropped rather than allowed to abort normalization of the whole post.
const actorOrUndefined = (username: unknown, id: unknown): NormalizedActor | undefined => {
  const rawHandle = typeof username === 'string' ? username.trim().replace(/^@/, '').toLowerCase() : '';
  const handle = /^[a-z0-9_.-]{1,100}$/.test(rawHandle) ? rawHandle : '';
  const rawId = id === undefined || id === null ? '' : String(id).trim();
  const identifier = /^[A-Za-z0-9_:-]{1,100}$/.test(rawId) ? rawId : '';
  if (!handle && !identifier) return undefined;
  return { ...(handle ? { username: handle } : {}), ...(identifier ? { id: identifier } : {}) };
};

/** Adapts an X scraper tweet exactly once at the ingestion boundary. */
export function normalizeXPost(tweet: Record<string, unknown>, sourceId: string, username: string): NormalizedPost {
  const externalId = String(tweet.id_str ?? tweet.id ?? '').trim();
  const repostId = tweet.retweeted_status_id_str ?? tweet.retweeted_status_id;
  const isRepost = Boolean(repostId || tweet.isRetweet);
  const entities = [
    ...readArray(readRecord(tweet.entities)?.urls),
    ...readArray(tweet.urls),
  ];
  const urls = entities.map(entityUrl).filter((entry): entry is string => typeof entry === 'string');
  if (isRepost && typeof tweet.permanentUrl === 'string') {
    urls.push(tweet.permanentUrl);
  }
  const mediaValues = [
    ...readArray(readRecord(tweet.extended_entities)?.media),
    ...readArray(tweet.media),
  ];
  const created = tweet.created_at ?? tweet.createdAt ?? Date.now();
  const user = readRecord(tweet.user);
  const post: NormalizedPost = {
    sourceType: 'x',
    sourceId,
    externalId,
    text: String(tweet.full_text ?? tweet.text ?? '').trim(),
    createdAt: new Date(typeof created === 'number' ? created : Date.parse(String(created))).toISOString(),
    urls: [...new Set(urls.map((url) => normalizePublicHttpUrl(url)))],
    language: optionalLanguage(tweet.lang ?? tweet.language),
    sensitive: tweet.possibly_sensitive === true || tweet.sensitive === true,
    // Carried through so downstream filtering can tell a self-reply from a
    // reply to somebody else, and can reject stray timeline injections.
    author: actorOrUndefined(
      user?.screen_name ?? tweet.username ?? username,
      user?.id_str ?? user?.id ?? tweet.userId,
    ),
    media: mediaValues
      .map((entry) => {
        const record = readRecord(entry);
        return record ? xMediaDescriptor(record) : undefined;
      })
      .filter((entry: NormalizedMediaDescriptor | undefined): entry is NormalizedMediaDescriptor => Boolean(entry)),
  };
  const replyId = tweet.in_reply_to_status_id_str ?? tweet.in_reply_to_status_id ?? tweet.inReplyToStatusId;
  if (replyId) {
    post.replyTo = {
      sourceType: 'x',
      sourceId,
      externalId: String(replyId),
    };
    post.replyToAuthor = actorOrUndefined(
      tweet.in_reply_to_screen_name ?? tweet.inReplyToScreenName,
      tweet.in_reply_to_user_id_str ?? tweet.in_reply_to_user_id ?? tweet.inReplyToUserId,
    );
  }
  const rootId = tweet.conversation_id_str ?? tweet.conversation_id;
  if (rootId && String(rootId) !== externalId) {
    post.threadRoot = { sourceType: 'x', sourceId, externalId: String(rootId) };
  }
  const quoteId = tweet.quoted_status_id_str ?? tweet.quoted_status_id;
  if (quoteId) post.quotedPost = { sourceType: 'x', sourceId, externalId: String(quoteId) };
  if (isRepost) {
    post.repostOf = {
      sourceType: 'x',
      sourceId,
      externalId: String(repostId ?? externalId),
    };
  }
  return validateNormalizedPost(post, {
    ...DEFAULT_NORMALIZED_POST_LIMITS,
    maxMediaBytes: Number.MAX_SAFE_INTEGER,
  });
}

export function normalizedPostContentType(post: NormalizedPost): 'original' | 'reply' | 'quote' | 'repost' {
  return post.repostOf ? 'repost' : post.quotedPost ? 'quote' : post.replyTo ? 'reply' : 'original';
}

/** The queue-row fields needed to rebuild a post for policy evaluation. */
export interface QueuedPostPayload {
  source_type: string;
  source_id?: string;
  twitter_username: string;
  external_post_id: string;
  tweet_json: string;
}

/**
 * Rebuilds the canonical post behind a queue row. X rows hold a raw scraper
 * tweet; every other source type holds an already-normalized post, so parsing
 * both as X tweets produced empty text, `original` content type and no media —
 * silently re-approving generic items that policy should have judged on their
 * real content.
 */
export function queuedPostForPolicyEvaluation(item: QueuedPostPayload): {
  post: NormalizedPost;
  imageUrls: string[];
} {
  const payload = JSON.parse(item.tweet_json) as Record<string, unknown>;
  const post =
    item.source_type === 'x'
      ? normalizeXPost(
          payload as Parameters<typeof normalizeXPost>[0],
          item.source_id || item.twitter_username,
          item.twitter_username,
        )
      : validateNormalizedPost(payload);
  return {
    post,
    imageUrls: [
      ...new Set(post.media.filter((media) => media.type === 'image').map((media) => media.url)),
    ],
  };
}
