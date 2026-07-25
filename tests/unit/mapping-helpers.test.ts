import { describe, expect, test } from 'bun:test';
import {
  getActiveTwitterUsernames,
  getCanonicalDestinationKey,
  getDestinationStorageKey,
  normalizeTwitterUsername,
  parseTwitterUsernameInput,
  parseTwitterUsernames,
  resolveProfileSyncSourceUsername,
  resolveRuntimeProfileSyncSource,
} from '../../src/mapping-helpers.js';

describe('Twitter username parsing', () => {
  test('trims, removes one @ prefix, lowercases, and deduplicates', () => {
    expect(parseTwitterUsernames([' @Primary ', 'SECONDARY', '@primary', 42])).toEqual(['primary', 'secondary']);
    expect(normalizeTwitterUsername(' @Mixed_Case ')).toBe('mixed_case');
  });

  test('accepts comma-separated values and falls back to the legacy field', () => {
    expect(parseTwitterUsernames('one, @Two, one')).toEqual(['one', 'two']);
    expect(parseTwitterUsernames('one two\tthree\nfour')).toEqual(['one', 'two', 'three', 'four']);
    expect(parseTwitterUsernames(['one two', 'three,\nfour'])).toEqual(['one', 'two', 'three', 'four']);
    expect(parseTwitterUsernames(undefined, '@Legacy')).toEqual(['legacy']);
    expect(parseTwitterUsernames([], '@Legacy')).toEqual(['legacy']);
  });

  test('reports additions, duplicates, and invalid entries without silently dropping them', () => {
    expect(parseTwitterUsernameInput([' @NEW ', 'existing', 'new', 'bad-name', 'sixteen_chars_long'], ['existing'])).toEqual({
      added: ['new'],
      duplicates: [
        { input: 'existing', username: 'existing', reason: 'existing' },
        { input: 'new', username: 'new', reason: 'input' },
      ],
      invalid: [
        { input: 'bad-name', normalized: 'bad-name', reason: 'Use 1-15 letters, numbers, or underscores.' },
        {
          input: 'sixteen_chars_long',
          normalized: 'sixteen_chars_long',
          reason: 'Use 1-15 letters, numbers, or underscores.',
        },
      ],
    });
  });
});

describe('destination runtime identity', () => {
  test('uses a validated DID for locking and service plus identifier as fallback', () => {
    expect(
      getCanonicalDestinationKey({
        bskyDid: 'did:plc:ABC',
        bskyIdentifier: 'old.example',
        bskyServiceUrl: 'https://bsky.social/',
      }),
    ).toBe('did:plc:abc');
    expect(
      getCanonicalDestinationKey({
        bskyIdentifier: '@Example.Bsky.Social',
        bskyServiceUrl: 'bsky.social/',
      }),
    ).toBe('service:https://bsky.social|example.bsky.social');
    expect(
      getDestinationStorageKey({
        bskyDid: 'did:plc:ABC',
        bskyIdentifier: 'old.example',
      }),
    ).toBe('did:plc:abc');
  });

  test('filters paused sources without affecting the compatibility source list', () => {
    const mapping = {
      twitterUsernames: ['one', 'two'],
      pausedTwitterUsernames: ['two'],
    };
    expect(getActiveTwitterUsernames(mapping)).toEqual(['one']);
    expect(mapping.twitterUsernames).toEqual(['one', 'two']);
  });
});

describe('current profile source resolution', () => {
  const twitterUsernames = ['primary', 'secondary'];

  test('uses a valid requested or existing source', () => {
    expect(resolveProfileSyncSourceUsername({ twitterUsernames, requestedSource: '@SECONDARY' })).toBe('secondary');
    expect(resolveProfileSyncSourceUsername({ twitterUsernames, fallbackSource: '@SECONDARY' })).toBe('secondary');
  });

  test('uses the sole source but never infers an aggregate source from order', () => {
    expect(resolveProfileSyncSourceUsername({ twitterUsernames })).toBeUndefined();
    expect(resolveProfileSyncSourceUsername({ twitterUsernames, requestedSource: 'missing' })).toBeUndefined();
    expect(resolveProfileSyncSourceUsername({ twitterUsernames: ['only'] })).toBe('only');
  });

  test('runtime resolution requires a selection only when multiple sources remain unnormalized', () => {
    expect(resolveRuntimeProfileSyncSource({ twitterUsernames: ['Only_Source'] })).toBe('only_source');
    expect(resolveRuntimeProfileSyncSource({ twitterUsernames })).toBeNull();
    expect(
      resolveRuntimeProfileSyncSource({
        twitterUsernames,
        profileSyncSourceUsername: '@SECONDARY',
      }),
    ).toBe('secondary');
    expect(
      resolveRuntimeProfileSyncSource({
        twitterUsernames,
        profileManagement: {
          profileSync: { sourceUsername: '@SECONDARY' },
        },
      }),
    ).toBe('secondary');
  });
});
