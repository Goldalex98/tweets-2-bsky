import { describe, expect, test } from 'bun:test';
import {
  applyCurrentSourceAttribution,
  applyPostingPolicy,
  splitPostText,
  validateAttributionTemplate,
} from '../../src/post-transform.js';

describe('current source attribution', () => {
  test('unconditionally prefixes root posts', () => {
    expect(applyCurrentSourceAttribution('Hello from X', 'SourceAccount', false)).toBe(
      'Source: @sourceaccount on X\n\nHello from X',
    );
  });

  test('does not prefix replies', () => {
    expect(applyCurrentSourceAttribution('A threaded reply', 'SourceAccount', true)).toBe('A threaded reply');
  });
});

describe('current post text splitting', () => {
  test('leaves text at or below the limit unchanged', () => {
    expect(splitPostText('short post', 20)).toEqual(['short post']);
  });

  test('prefers paragraph boundaries and reserves numbering space', () => {
    const chunks = splitPostText(
      'First paragraph has enough words.\n\nSecond paragraph also has enough words to require another chunk.',
      55,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe('First paragraph has enough words.');
    expect(chunks.every((chunk) => chunk.length <= 47)).toBe(true);
    expect(chunks.map((chunk, index) => `${chunk} (${index + 1}/${chunks.length})`).every((chunk) => chunk.length <= 55)).toBe(
      true,
    );
  });

  test('force-splits text without whitespace', () => {
    expect(splitPostText('abcdefghijklmnopqrstuv', 20)).toEqual(['abcdefghijkl', 'mnopqrstuv']);
  });

  test('splits on grapheme boundaries without losing unicode content', () => {
    const input = '👨‍👩‍👧‍👦'.repeat(20);
    const chunks = splitPostText(input, 12);
    expect(chunks.every((chunk) => !chunk.includes('\uFFFD'))).toBe(true);
    expect(chunks.join('')).toBe(input);
  });
});

describe('posting policy transformer', () => {
  const context = {
    twitterUsername: 'sourcé',
    tweetId: '42',
    originalPostUrl: 'https://x.com/sourc%C3%A9/status/42',
    destinationIdentifier: 'destination.bsky.social',
    sourceCount: 2,
    isReply: false,
    isThreadRoot: true,
  };

  test('supports conditional attribution and original links through one transformer', () => {
    const result = applyPostingPolicy(
      'Body',
      {
        attribution: {
          mode: 'multiple-sources',
          template: 'Via @{username} for {destination}',
          rootPostsOnly: true,
          linkSource: true,
        },
        appendOriginalPostLink: true,
      },
      context,
    );
    expect(result.text).toContain('Via @sourcé for destination.bsky.social');
    expect(result.text).toEndWith(context.originalPostUrl);
    expect(result.attributionApplied).toBe(true);
    expect(result.originalLinkApplied).toBe(true);
    expect(result.facets[0]).toMatchObject({
      index: { byteStart: 4, byteEnd: Buffer.byteLength('Via @sourcé', 'utf8') },
      features: [{ uri: 'https://x.com/sourcé' }],
    });
  });

  test('never and root-only modes suppress attribution as configured', () => {
    const policy = {
      attribution: {
        mode: 'always' as const,
        template: 'Source: @{username}',
        rootPostsOnly: true,
        linkSource: true,
      },
      appendOriginalPostLink: false,
    };
    expect(applyPostingPolicy('Reply', policy, { ...context, isThreadRoot: false, isReply: true }).text).toBe('Reply');
    expect(
      applyPostingPolicy(
        'Root',
        { ...policy, attribution: { ...policy.attribution, mode: 'never' as const } },
        context,
      ).text,
    ).toBe('Root');
  });

  test('rejects unknown and malformed template variables', () => {
    expect(() => validateAttributionTemplate('Source: {unknown}')).toThrow('unsupported variable');
    expect(() => validateAttributionTemplate('Source: {username')).toThrow('invalid variable');
  });

  test('long attribution can add chunks without dropping original content', () => {
    const body = 'Original body with emoji 👩🏽‍💻 and a final sentence.';
    const transformed = applyPostingPolicy(
      body,
      {
        attribution: {
          mode: 'always',
          template: `${'Attribution '.repeat(8)}@{username}`,
          rootPostsOnly: true,
          linkSource: true,
        },
        appendOriginalPostLink: false,
      },
      context,
    );
    const chunks = splitPostText(transformed.text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain(body);
    expect(chunks.filter((chunk) => chunk.includes('@sourcé'))).toHaveLength(1);
  });
});
