import type { AccountMapping } from './config/schemas.js';

export const X_USERNAME_PATTERN = /^[a-z0-9_]{1,15}$/;

export interface InvalidTwitterUsername {
  input: string;
  normalized?: string;
  reason: string;
}

export interface DuplicateTwitterUsername {
  input: string;
  username: string;
  reason: 'input' | 'existing';
}

export interface TwitterUsernameParseResult {
  added: string[];
  duplicates: DuplicateTwitterUsername[];
  invalid: InvalidTwitterUsername[];
}

const tokenizeTwitterUsernameInput = (value: unknown): Array<{ input: string; candidate: unknown }> => {
  const tokens: Array<{ input: string; candidate: unknown }> = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== 'string') {
      tokens.push({ input: String(candidate), candidate });
      return;
    }
    for (const part of candidate.split(/[,\s]+/)) {
      if (part.length > 0) {
        tokens.push({ input: part, candidate: part });
      }
    }
  };

  if (Array.isArray(value)) {
    for (const candidate of value) {
      add(candidate);
    }
  } else if (value !== undefined && value !== null) {
    add(value);
  }
  return tokens;
};

export function normalizeTwitterUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().replace(/^@+/, '').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseTwitterUsernameInput(value: unknown, existing: readonly string[] = []): TwitterUsernameParseResult {
  const existingSet = new Set(
    existing.map(normalizeTwitterUsername).filter((username): username is string => Boolean(username)),
  );
  const seenInput = new Set<string>();
  const result: TwitterUsernameParseResult = {
    added: [],
    duplicates: [],
    invalid: [],
  };

  for (const token of tokenizeTwitterUsernameInput(value)) {
    const normalized = normalizeTwitterUsername(token.candidate);
    if (!normalized) {
      result.invalid.push({ input: token.input, reason: 'X usernames must be text.' });
      continue;
    }
    if (!X_USERNAME_PATTERN.test(normalized)) {
      result.invalid.push({
        input: token.input,
        normalized,
        reason: 'Use 1-15 letters, numbers, or underscores.',
      });
      continue;
    }
    if (existingSet.has(normalized)) {
      result.duplicates.push({ input: token.input, username: normalized, reason: 'existing' });
      continue;
    }
    if (seenInput.has(normalized)) {
      result.duplicates.push({ input: token.input, username: normalized, reason: 'input' });
      continue;
    }
    seenInput.add(normalized);
    result.added.push(normalized);
  }

  return result;
}

export function parseTwitterUsernames(value: unknown, legacyValue?: unknown): string[] {
  const parsed = parseTwitterUsernameInput(value);
  if (parsed.added.length > 0) {
    return parsed.added;
  }
  return parseTwitterUsernameInput(legacyValue).added;
}

export function normalizeBlueskyServiceUrl(value?: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'https://bsky.social';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '').toLowerCase();
}

export function getCanonicalDestinationKey(
  mapping: Pick<AccountMapping, 'bskyDid' | 'bskyCanonicalHandle' | 'bskyIdentifier' | 'bskyServiceUrl'>,
): string {
  const did = typeof mapping.bskyDid === 'string' ? mapping.bskyDid.trim().toLowerCase() : '';
  if (did) {
    return did;
  }
  const identifier = normalizeTwitterUsername(mapping.bskyCanonicalHandle ?? mapping.bskyIdentifier) ?? '';
  return `service:${normalizeBlueskyServiceUrl(mapping.bskyServiceUrl)}|${identifier}`;
}

export function getDestinationStorageKey(
  mapping: Pick<AccountMapping, 'bskyDid' | 'bskyCanonicalHandle' | 'bskyIdentifier'>,
): string {
  return (
    (typeof mapping.bskyDid === 'string' ? mapping.bskyDid.trim().toLowerCase() : '') ||
    normalizeTwitterUsername(mapping.bskyCanonicalHandle ?? mapping.bskyIdentifier) ||
    mapping.bskyIdentifier.trim().toLowerCase()
  );
}

export function getActiveTwitterUsernames(
  mapping: Pick<AccountMapping, 'twitterUsernames' | 'pausedTwitterUsernames'>,
): string[] {
  const paused = new Set(
    (mapping.pausedTwitterUsernames ?? [])
      .map(normalizeTwitterUsername)
      .filter((username): username is string => Boolean(username)),
  );
  return mapping.twitterUsernames.filter((username) => !paused.has(normalizeTwitterUsername(username) ?? ''));
}

export function resolveProfileSyncSourceUsername(args: {
  twitterUsernames: string[];
  requestedSource?: unknown;
  fallbackSource?: string;
}): string | undefined {
  const twitterUsernames = args.twitterUsernames
    .map(normalizeTwitterUsername)
    .filter((username): username is string => Boolean(username));
  if (twitterUsernames.length === 0) {
    return undefined;
  }

  const normalizedRequested =
    args.requestedSource !== undefined ? normalizeTwitterUsername(String(args.requestedSource || '')) : undefined;
  const normalizedFallback = normalizeTwitterUsername(args.fallbackSource);

  let resolved = normalizedRequested;
  if (!resolved && normalizedFallback && twitterUsernames.includes(normalizedFallback)) {
    resolved = normalizedFallback;
  }

  if (resolved && twitterUsernames.includes(resolved)) {
    return resolved;
  }

  return twitterUsernames.length === 1 ? twitterUsernames[0] : undefined;
}

export function resolveRuntimeProfileSyncSource(args: {
  twitterUsernames: string[];
  profileSyncSourceUsername?: string;
  profileManagement?: {
    profileSync?: {
      sourceUsername?: string;
    };
  };
}): string | null {
  const candidates = args.twitterUsernames
    .map(normalizeTwitterUsername)
    .filter((username): username is string => Boolean(username));
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  const selected = normalizeTwitterUsername(
    args.profileManagement?.profileSync?.sourceUsername ?? args.profileSyncSourceUsername,
  );
  return selected && candidates.includes(selected) ? selected : null;
}

export function getCompatibleProfileSyncSourceUsername(args: {
  profileSyncSourceUsername?: string;
  profileManagement?: {
    profileSync?: {
      sourceUsername?: string;
    };
  };
}): string | undefined {
  return normalizeTwitterUsername(
    args.profileManagement?.profileSync?.sourceUsername ?? args.profileSyncSourceUsername,
  );
}
