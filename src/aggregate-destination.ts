import type { AccountMapping } from './config/schemas.js';
import {
  getCanonicalDestinationKey,
  normalizeBlueskyServiceUrl,
  normalizeTwitterUsername,
  parseTwitterUsernameInput,
  type TwitterUsernameParseResult,
} from './mapping-helpers.js';

export interface ValidatedDestinationIdentity {
  did: string;
  handle: string;
  serviceUrl: string;
}

export interface SourceDependencies {
  profile: boolean;
  pin: boolean;
}

export function applyValidatedDestinationIdentity(
  mapping: AccountMapping,
  validation: ValidatedDestinationIdentity,
): AccountMapping {
  return {
    ...mapping,
    bskyIdentifier: validation.handle.trim().replace(/^@+/, '').toLowerCase(),
    bskyServiceUrl: normalizeBlueskyServiceUrl(validation.serviceUrl),
    bskyDid: validation.did.trim(),
    bskyCanonicalHandle: validation.handle.trim().replace(/^@+/, '').toLowerCase(),
  };
}

const destinationAliasKeys = (
  mapping: Pick<AccountMapping, 'bskyDid' | 'bskyCanonicalHandle' | 'bskyIdentifier' | 'bskyServiceUrl'>,
): Set<string> => {
  const keys = new Set([getCanonicalDestinationKey(mapping)]);
  const service = normalizeBlueskyServiceUrl(mapping.bskyServiceUrl);
  for (const value of [mapping.bskyIdentifier, mapping.bskyCanonicalHandle]) {
    const identifier = normalizeTwitterUsername(value);
    if (identifier) {
      keys.add(`service:${service}|${identifier}`);
    }
  }
  if (mapping.bskyDid?.trim()) {
    keys.add(mapping.bskyDid.trim().toLowerCase());
  }
  return keys;
};

export function findDuplicateActiveDestination(
  mappings: readonly AccountMapping[],
  candidate: Pick<AccountMapping, 'bskyDid' | 'bskyCanonicalHandle' | 'bskyIdentifier' | 'bskyServiceUrl'>,
  excludeMappingId?: string,
): AccountMapping | undefined {
  const candidateKeys = destinationAliasKeys(candidate);
  return mappings.find((mapping) => {
    if (!mapping.enabled || mapping.id === excludeMappingId) {
      return false;
    }
    for (const key of destinationAliasKeys(mapping)) {
      if (candidateKeys.has(key)) {
        return true;
      }
    }
    return false;
  });
}

export function getSourceDependencies(mapping: AccountMapping, source: unknown): SourceDependencies {
  const username = normalizeTwitterUsername(source);
  if (!username) {
    return { profile: false, pin: false };
  }
  return {
    profile:
      mapping.profileManagement.profileSync.mode !== 'off' &&
      normalizeTwitterUsername(mapping.profileManagement.profileSync.sourceUsername) === username,
    pin:
      mapping.profileManagement.pinSync.mode !== 'off' &&
      normalizeTwitterUsername(mapping.profileManagement.pinSync.sourceUsername) === username,
  };
}

export function addDestinationSources(mapping: AccountMapping, input: unknown): TwitterUsernameParseResult {
  const parsed = parseTwitterUsernameInput(input, mapping.twitterUsernames);
  if (parsed.added.length > 0) {
    mapping.twitterUsernames = [...mapping.twitterUsernames, ...parsed.added];
  }
  return parsed;
}

export function setDestinationSourcePaused(mapping: AccountMapping, source: unknown, paused: boolean): string {
  const username = normalizeTwitterUsername(source);
  if (!username || !mapping.twitterUsernames.includes(username)) {
    throw new Error('Source is not part of this destination.');
  }
  const pausedSet = new Set(mapping.pausedTwitterUsernames ?? []);
  if (paused) {
    pausedSet.add(username);
  } else {
    pausedSet.delete(username);
  }
  mapping.pausedTwitterUsernames = mapping.twitterUsernames.filter((candidate) => pausedSet.has(candidate));
  return username;
}

export function removeDestinationSource(mapping: AccountMapping, source: unknown): string {
  const username = normalizeTwitterUsername(source);
  if (!username || !mapping.twitterUsernames.includes(username)) {
    throw new Error('Source is not part of this destination.');
  }
  if (mapping.twitterUsernames.length <= 1) {
    throw new Error('A destination must keep at least one X source. Delete the destination instead.');
  }
  const dependencies = getSourceDependencies(mapping, username);
  if (dependencies.profile || dependencies.pin) {
    const names = [
      dependencies.profile ? 'profile synchronization' : '',
      dependencies.pin ? 'pin synchronization' : '',
    ].filter(Boolean);
    throw new Error(`@${username} is the active source for ${names.join(' and ')}. Change that policy first.`);
  }
  mapping.twitterUsernames = mapping.twitterUsernames.filter((candidate) => candidate !== username);
  mapping.pausedTwitterUsernames = (mapping.pausedTwitterUsernames ?? []).filter((candidate) => candidate !== username);
  return username;
}
