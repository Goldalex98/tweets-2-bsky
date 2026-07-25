import type { SourceFilterPolicy } from './config/schemas.js';
import type { NormalizedPost } from './normalized-post.js';

export const SOURCE_FILTER_POLICY_VERSION = 2;

export type SourceFilterReason =
  | 'allowed'
  | 'bypass-filters'
  | 'source-disabled'
  | 'author-mismatch'
  | 'repost-disabled'
  | 'quote-disabled'
  | 'self-reply-disabled'
  | 'external-reply-disabled'
  | 'original-post-disabled'
  | 'media-required'
  | 'sensitive-content'
  | 'language-not-allowed'
  | 'excluded-keyword'
  | 'required-keyword-missing';

export interface SourceFilterMetadata {
  text?: string;
  language?: string;
  sensitive?: boolean;
  hasMedia?: boolean;
  isRepost?: boolean;
  isQuote?: boolean;
  isReply?: boolean;
  authorUsername?: string;
  authorId?: string;
  replyToUsername?: string;
  replyToUserId?: string;
  expectedSourceUsername?: string;
}

/**
 * `expectedSourceUsername` must come from configuration, not from the post:
 * deriving both sides from `post.sourceId` made the author-mismatch check a
 * tautology and left reply-target identity blank, so every reply looked
 * external.
 */
export function sourceFilterMetadataForPost(
  post: NormalizedPost,
  options: { expectedSourceUsername?: string } = {},
): SourceFilterMetadata {
  return {
    text: post.text,
    language: post.language,
    sensitive: post.sensitive,
    hasMedia: post.media.length > 0,
    isReply: Boolean(post.replyTo),
    isQuote: Boolean(post.quotedPost),
    isRepost: Boolean(post.repostOf),
    authorUsername: post.author?.username,
    authorId: post.author?.id,
    replyToUsername: post.replyToAuthor?.username,
    replyToUserId: post.replyToAuthor?.id,
    expectedSourceUsername: options.expectedSourceUsername,
  };
}

export interface SourceFilterDecision {
  allowed: boolean;
  reason: SourceFilterReason;
  detail?: string;
  policyVersion: number;
}

const decision = (allowed: boolean, reason: SourceFilterReason, detail?: string): SourceFilterDecision => ({
  allowed,
  reason,
  ...(detail ? { detail } : {}),
  policyVersion: SOURCE_FILTER_POLICY_VERSION,
});

const normalized = (value?: string): string => value?.trim().replace(/^@/, '').toLowerCase() ?? '';

function isSelfReply(metadata: SourceFilterMetadata): boolean {
  if (!metadata.isReply) return false;
  const authorId = normalized(metadata.authorId);
  const replyId = normalized(metadata.replyToUserId);
  if (authorId && replyId) return authorId === replyId;
  // Falling back to the configured source username keeps detection working when
  // the payload carries handles but no numeric ids.
  const author = normalized(metadata.authorUsername) || normalized(metadata.expectedSourceUsername);
  const replyTo = normalized(metadata.replyToUsername);
  return Boolean(author && replyTo && author === replyTo);
}

/**
 * Deterministic evaluation order (first skip wins):
 * enabled, repost, quote, reply kind, original, media, sensitive, language,
 * excluded keywords, required keywords.
 *
 * Classification filters intentionally run before content filters so Activity
 * always reports the stable structural reason for the same post.
 */
export function evaluateSourceFilter(
  policy: SourceFilterPolicy,
  postOrMetadata: SourceFilterMetadata | NormalizedPost,
  options: { sourceEnabled?: boolean; bypassFilters?: boolean; expectedSourceUsername?: string } = {},
): SourceFilterDecision {
  const metadata =
    'sourceType' in postOrMetadata
      ? sourceFilterMetadataForPost(postOrMetadata, {
          expectedSourceUsername: options.expectedSourceUsername,
        })
      : {
          ...postOrMetadata,
          expectedSourceUsername: postOrMetadata.expectedSourceUsername ?? options.expectedSourceUsername,
        };
  if (options.sourceEnabled === false) return decision(false, 'source-disabled');
  if (options.bypassFilters) return decision(true, 'bypass-filters');

  const expectedSource = normalized(metadata.expectedSourceUsername);
  const author = normalized(metadata.authorUsername);
  if (expectedSource && author && expectedSource !== author) return decision(false, 'author-mismatch', author);

  if (metadata.isRepost && !policy.reposts) return decision(false, 'repost-disabled');
  if (metadata.isQuote && !policy.quotes) return decision(false, 'quote-disabled');

  if (metadata.isReply) {
    if (isSelfReply(metadata)) {
      if (!policy.selfReplies) return decision(false, 'self-reply-disabled');
    } else if (!policy.externalReplies) {
      return decision(false, 'external-reply-disabled');
    }
  } else if (!metadata.isQuote && !metadata.isRepost && !policy.originalPosts) {
    return decision(false, 'original-post-disabled');
  }

  if (policy.mediaOnly && !metadata.hasMedia) return decision(false, 'media-required');
  if (policy.sensitiveContent === 'skip' && metadata.sensitive) return decision(false, 'sensitive-content');

  const language = normalized(metadata.language);
  if (policy.languages.length > 0 && (!language || !policy.languages.includes(language))) {
    return decision(false, 'language-not-allowed', language || 'unknown');
  }

  const text = (metadata.text ?? '').toLocaleLowerCase();
  const excluded = policy.excludeKeywords.find((keyword) => text.includes(keyword.toLocaleLowerCase()));
  if (excluded) return decision(false, 'excluded-keyword', excluded);

  if (
    policy.includeKeywords.length > 0 &&
    !policy.includeKeywords.some((keyword) => text.includes(keyword.toLocaleLowerCase()))
  ) {
    return decision(false, 'required-keyword-missing');
  }

  return decision(true, 'allowed');
}
