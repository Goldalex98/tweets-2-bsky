import { describe, expect, test } from 'bun:test';
import { DEFAULT_SOURCE_FILTERS } from '../../src/config/defaults.js';
import { normalizeXPost } from '../../src/normalized-post.js';
import { evaluateSourceFilter } from '../../src/source-filter.js';

const policy = () => ({
  ...DEFAULT_SOURCE_FILTERS,
  includeKeywords: [],
  excludeKeywords: [],
  languages: [],
});

describe('source filters', () => {
  test('returns a structured allow decision', () => {
    expect(evaluateSourceFilter(policy(), { text: 'hello' })).toMatchObject({
      allowed: true,
      reason: 'allowed',
      policyVersion: 2,
    });
  });

  test.each([
    [{}, { sourceEnabled: false }, 'source-disabled'],
    [{ authorUsername: 'other', expectedSourceUsername: 'source' }, {}, 'author-mismatch'],
    [{ isRepost: true }, {}, 'repost-disabled'],
    [{ isQuote: true }, { policy: { quotes: false } }, 'quote-disabled'],
    [{ isReply: true, authorId: '1', replyToUserId: '1' }, { policy: { selfReplies: false } }, 'self-reply-disabled'],
    [{ isReply: true, authorId: '1', replyToUserId: '2' }, {}, 'external-reply-disabled'],
    [{}, { policy: { originalPosts: false } }, 'original-post-disabled'],
    [{}, { policy: { mediaOnly: true } }, 'media-required'],
    [{ sensitive: true }, { policy: { sensitiveContent: 'skip' } }, 'sensitive-content'],
    [{ language: 'fr' }, { policy: { languages: ['en'] } }, 'language-not-allowed'],
    [{ text: 'blocked phrase' }, { policy: { excludeKeywords: ['blocked'] } }, 'excluded-keyword'],
    [{ text: 'nothing relevant' }, { policy: { includeKeywords: ['required'] } }, 'required-keyword-missing'],
  ] as const)('reports %s', (metadata, options, reason) => {
    const configured = { ...policy(), ...('policy' in options ? options.policy : {}) };
    const evaluationOptions = 'sourceEnabled' in options ? { sourceEnabled: options.sourceEnabled } : {};
    expect(evaluateSourceFilter(configured, metadata, evaluationOptions).reason).toBe(reason);
  });

  test('uses documented structural-before-content order', () => {
    expect(
      evaluateSourceFilter(
        { ...policy(), includeKeywords: ['required'], excludeKeywords: ['blocked'] },
        { isRepost: true, text: 'blocked' },
      ).reason,
    ).toBe('repost-disabled');
  });
});

describe('identity carried through X normalization', () => {
  const tweet = (overrides: Record<string, unknown>) => ({
    id_str: '42',
    full_text: 'a reply',
    created_at: '2026-07-24T12:00:00Z',
    user: { screen_name: 'source', id_str: '900' },
    in_reply_to_status_id_str: '41',
    ...overrides,
  });

  test("a source replying to itself is a self-reply, not an 'external' one", () => {
    const post = normalizeXPost(
      tweet({ in_reply_to_screen_name: 'source', in_reply_to_user_id_str: '900' }),
      'source-x',
      'source',
    );
    // Before identity was carried through normalization this was classified as
    // an external reply, so self-reply threads were dropped by default.
    expect(
      evaluateSourceFilter(policy(), post, { expectedSourceUsername: 'source' }).reason,
    ).toBe('allowed');
    expect(
      evaluateSourceFilter({ ...policy(), selfReplies: false }, post, {
        expectedSourceUsername: 'source',
      }).reason,
    ).toBe('self-reply-disabled');
  });

  test('a reply to somebody else stays external even when handles are the only identity', () => {
    const post = normalizeXPost(
      tweet({ user: { screen_name: 'source' }, in_reply_to_screen_name: 'stranger' }),
      'source-x',
      'source',
    );
    expect(evaluateSourceFilter(policy(), post, { expectedSourceUsername: 'source' }).reason).toBe(
      'external-reply-disabled',
    );
  });

  test('a reply whose target is unknown is treated as external rather than mirrored', () => {
    const post = normalizeXPost(tweet({}), 'source-x', 'source');
    expect(evaluateSourceFilter(policy(), post, { expectedSourceUsername: 'source' }).reason).toBe(
      'external-reply-disabled',
    );
  });

  test('a foreign author injected into the timeline is rejected', () => {
    const post = normalizeXPost(
      {
        id_str: '43',
        full_text: 'not from this source',
        created_at: '2026-07-24T12:00:00Z',
        user: { screen_name: 'someone_else', id_str: '901' },
      },
      'source-x',
      'source',
    );
    // The check used to compare post.sourceId with itself, which never failed.
    expect(evaluateSourceFilter(policy(), post, { expectedSourceUsername: 'source' })).toMatchObject({
      allowed: false,
      reason: 'author-mismatch',
      detail: 'someone_else',
    });
  });
});
