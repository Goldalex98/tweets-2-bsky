import { describe, expect, test } from 'bun:test';
import { applyValidatedDestinationIdentity } from '../../src/aggregate-destination.js';
import { getDestinationStorageKey, resolveDestinationStorageKey } from '../../src/mapping-helpers.js';
import type { AccountMapping } from '../../src/config/schemas.js';
import { createDefaultMappingPolicies } from '../../src/config/defaults.js';

function sampleMapping(overrides: Partial<AccountMapping> = {}): AccountMapping {
  const policies = createDefaultMappingPolicies(1);
  return {
    id: 'destination-1',
    twitterUsernames: ['source'],
    bskyIdentifier: 'destination.example',
    bskyPassword: 'app-password',
    bskyServiceUrl: 'https://bsky.social',
    storageKey: 'destination.example',
    enabled: true,
    ...policies,
    ...overrides,
  };
}

describe('destination storage key immutability', () => {
  test('credential validation metadata does not change the persisted storage key', () => {
    const mapping = sampleMapping();
    const validated = applyValidatedDestinationIdentity(mapping, {
      did: 'did:plc:destination',
      handle: 'new.handle.bsky.social',
      serviceUrl: 'https://bsky.social',
      active: true,
    });

    expect(getDestinationStorageKey(validated)).toBe('did:plc:destination');
    expect(resolveDestinationStorageKey({ ...validated, storageKey: mapping.storageKey })).toBe(
      'destination.example',
    );
    expect(mapping.id).toBe('destination-1');
  });

  test('seed helper remains available for new destinations without a storageKey', () => {
    expect(
      resolveDestinationStorageKey({
        bskyIdentifier: 'fresh.example',
      }),
    ).toBe('fresh.example');
  });
});
