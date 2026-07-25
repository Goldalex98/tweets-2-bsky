import { describe, expect, test } from 'bun:test';
import {
  addDestinationSources,
  applyValidatedDestinationIdentity,
  findDuplicateActiveDestination,
  removeDestinationSource,
  setDestinationSourcePaused,
} from '../../src/aggregate-destination.js';
import { defaultPostingPolicy, defaultProfileManagementPolicy } from '../../src/config/defaults.js';
import type { AccountMapping } from '../../src/config/schemas.js';

const createMapping = (overrides: Partial<AccountMapping> = {}): AccountMapping => ({
  id: 'mapping-one',
  twitterUsernames: ['one', 'two'],
  pausedTwitterUsernames: [],
  bskyIdentifier: 'destination.example',
  bskyPassword: '<redacted-app-password>',
  bskyServiceUrl: 'https://bsky.social',
  enabled: true,
  postingPolicy: defaultPostingPolicy(2),
  profileManagement: defaultProfileManagementPolicy(),
  ...overrides,
});

describe('aggregate destination sources', () => {
  test('adds valid bulk sources without changing credentials, policies, profile state, or backfilling', () => {
    const mapping = createMapping();
    const before = {
      password: mapping.bskyPassword,
      postingPolicy: structuredClone(mapping.postingPolicy),
      profileManagement: structuredClone(mapping.profileManagement),
    };
    const result = addDestinationSources(mapping, 'three\n@FOUR invalid-name, one');
    expect(result.added).toEqual(['three', 'four']);
    expect(result.duplicates).toEqual([{ input: 'one', username: 'one', reason: 'existing' }]);
    expect(result.invalid).toHaveLength(1);
    expect(mapping.twitterUsernames).toEqual(['one', 'two', 'three', 'four']);
    expect(mapping.bskyPassword).toBe(before.password);
    expect(mapping.postingPolicy).toEqual(before.postingPolicy);
    expect(mapping.profileManagement).toEqual(before.profileManagement);
  });

  test('blocks removal of an active profile or pin source until policy changes', () => {
    const mapping = createMapping();
    mapping.profileManagement.profileSync = {
      ...mapping.profileManagement.profileSync,
      mode: 'scheduled',
      sourceUsername: 'one',
    };
    expect(() => removeDestinationSource(mapping, 'one')).toThrow('active source');
    mapping.profileManagement.profileSync.mode = 'off';
    mapping.profileManagement.pinSync = {
      ...mapping.profileManagement.pinSync,
      mode: 'manual',
      sourceUsername: 'one',
    };
    expect(() => removeDestinationSource(mapping, 'one')).toThrow('active source');
    mapping.profileManagement.pinSync.mode = 'off';
    expect(removeDestinationSource(mapping, 'one')).toBe('one');
    expect(mapping.twitterUsernames).toEqual(['two']);
  });

  test('pauses a source transitionally while preserving queued-work compatibility fields', () => {
    const mapping = createMapping();
    expect(setDestinationSourcePaused(mapping, 'TWO', true)).toBe('two');
    expect(mapping.pausedTwitterUsernames).toEqual(['two']);
    expect(mapping.twitterUsernames).toEqual(['one', 'two']);
    setDestinationSourcePaused(mapping, 'two', false);
    expect(mapping.pausedTwitterUsernames).toEqual([]);
  });
});

describe('canonical destinations', () => {
  test('persists validated DID, canonical handle, and normalized service URL', () => {
    const original = createMapping();
    const mapping = applyValidatedDestinationIdentity(original, {
      did: 'did:plc:destination',
      handle: 'Canonical.Example',
      serviceUrl: 'https://BSKY.SOCIAL/',
    });
    expect(mapping).toMatchObject({
      bskyIdentifier: 'canonical.example',
      bskyCanonicalHandle: 'canonical.example',
      bskyDid: 'did:plc:destination',
      bskyServiceUrl: 'https://bsky.social',
    });
    expect(mapping.twitterUsernames).toEqual(original.twitterUsernames);
    expect(mapping.bskyPassword).toBe(original.bskyPassword);
    expect(mapping.postingPolicy).toEqual(original.postingPolicy);
    expect(mapping.profileManagement).toEqual(original.profileManagement);
  });

  test('reports duplicate active DIDs without merging credentials or ownership', () => {
    const existing = createMapping({
      bskyDid: 'did:plc:same',
      bskyCanonicalHandle: 'old-handle.example',
      owner: 'first-owner',
    });
    const duplicate = findDuplicateActiveDestination([existing], {
      bskyDid: 'did:plc:same',
      bskyCanonicalHandle: 'new-handle.example',
      bskyIdentifier: 'new-handle.example',
      bskyServiceUrl: 'https://bsky.social',
    });
    expect(duplicate).toBe(existing);
    expect(duplicate?.bskyPassword).toBe('<redacted-app-password>');
    expect(duplicate?.owner).toBe('first-owner');
    existing.enabled = false;
    expect(
      findDuplicateActiveDestination([existing], {
        bskyDid: 'did:plc:same',
        bskyIdentifier: 'new-handle.example',
        bskyServiceUrl: 'https://bsky.social',
      }),
    ).toBeUndefined();
  });
});
