import { describe, expect, test } from 'bun:test';
import { defaultPostingPolicy, defaultProfileManagementPolicy } from '../../src/config/defaults.js';
import type { AccountMapping } from '../../src/config/schemas.js';
import {
  assertProfileMutationAllowed,
  evaluateProfileMutation,
  resolvePinPolicySource,
  resolveProfilePolicySource,
} from '../../src/profile-policy.js';

const createMapping = (sources = ['one']): AccountMapping => ({
  id: 'mapping',
  twitterUsernames: sources,
  bskyIdentifier: 'destination.example',
  bskyPassword: 'redacted',
  enabled: true,
  postingPolicy: defaultPostingPolicy(sources.length),
  profileManagement: defaultProfileManagementPolicy(sources.length === 1 ? sources[0] : undefined),
});

describe('profile mutation policy', () => {
  test('blocks all mutation actions behind the master gate', () => {
    const mapping = createMapping();
    mapping.profileManagement.ensureBotLabel = true;
    mapping.profileManagement.profileSync.mode = 'manual';
    mapping.profileManagement.profileSync.fields.displayName = true;
    expect(evaluateProfileMutation(mapping, 'bot-label').allowed).toBe(false);
    expect(evaluateProfileMutation(mapping, 'profile-apply').allowed).toBe(false);
    expect(evaluateProfileMutation(mapping, 'pin-sync-manual').allowed).toBe(false);
  });

  test('requires each mode, flag, and requested field', () => {
    const mapping = createMapping();
    mapping.profileManagement.allowProfileMutation = true;
    mapping.profileManagement.profileSync.mode = 'manual';
    mapping.profileManagement.profileSync.fields.description = true;
    expect(
      assertProfileMutationAllowed(mapping, 'profile-apply', {
        requestedFields: { description: true, avatar: true },
      }),
    ).toMatchObject({
      sourceUsername: 'one',
      fields: { displayName: false, description: true, avatar: false, banner: false },
    });
    expect(() => assertProfileMutationAllowed(mapping, 'bot-label')).toThrow('not enabled');
    expect(() => assertProfileMutationAllowed(mapping, 'pin-sync-manual')).toThrow('not enabled');
  });

  test('keeps profile and pin source resolution independent', () => {
    const mapping = createMapping(['one', 'two']);
    mapping.profileManagement.profileSync.sourceUsername = 'one';
    mapping.profileManagement.pinSync.sourceUsername = 'two';
    expect(resolveProfilePolicySource(mapping)).toBe('one');
    expect(resolvePinPolicySource(mapping)).toBe('two');
  });

  test('never infers an aggregate source from array order', () => {
    const mapping = createMapping(['first', 'second']);
    expect(resolveProfilePolicySource(mapping)).toBeUndefined();
    expect(resolvePinPolicySource(mapping)).toBeUndefined();
    expect(evaluateProfileMutation(mapping, 'profile-preview').allowed).toBe(false);
  });
});
