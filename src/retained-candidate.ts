import type { ContentPolicyMetadata } from './content-policy.js';

export const RETAINED_CANDIDATE_VERSION = 1;
export const RETAINED_CANDIDATE_MAX_BYTES = 64 * 1024;
export const RETAINED_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SECRET_KEY = /(?:password|secret|token|cookie|authorization|api.?key|ct0)/i;

export interface RetainedCandidate {
  version: typeof RETAINED_CANDIDATE_VERSION;
  retainedAt: number;
  expiresAt: number;
  normalized: ContentPolicyMetadata & {
    externalPostId: string;
    mediaUrls: string[];
  };
  sourcePayload: Record<string, unknown>;
  degraded: boolean;
}

function boundedString(value: string, max = 5000): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .slice(0, max);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 7 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeValue(entry, depth + 1));
  if (typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (SECRET_KEY.test(key)) continue;
    const sanitized = sanitizeValue(child, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function minimalSourcePayload(normalized: RetainedCandidate['normalized']): Record<string, unknown> {
  return {
    id_str: normalized.externalPostId,
    full_text: normalized.text?.slice(0, 5000) ?? '',
    text: normalized.text?.slice(0, 5000) ?? '',
    lang: normalized.language,
    possibly_sensitive: normalized.sensitive,
    user: { screen_name: normalized.sourceUsername },
    entities: {
      urls: (normalized.urls ?? []).slice(0, 20).map((url) => ({ expanded_url: url, url })),
      media: [],
    },
  };
}

export function createRetainedCandidate(input: {
  externalPostId: string;
  metadata: ContentPolicyMetadata;
  mediaUrls?: readonly string[];
  sourcePayload: unknown;
  now?: number;
  ttlMs?: number;
  maxBytes?: number;
}): RetainedCandidate {
  const now = input.now ?? Date.now();
  const normalized: RetainedCandidate['normalized'] = {
    externalPostId: boundedString(input.externalPostId, 128),
    text: boundedString(input.metadata.text ?? '', 5000),
    urls: (input.metadata.urls ?? []).slice(0, 20).map((url) => boundedString(url, 2048)),
    mediaUrls: (input.mediaUrls ?? []).slice(0, 4).map((url) => boundedString(url, 2048)),
    sourceUsername: boundedString(input.metadata.sourceUsername ?? '', 64),
    language: boundedString(input.metadata.language ?? '', 32),
    sensitive: Boolean(input.metadata.sensitive),
    contentType: input.metadata.contentType,
    mediaTypes: input.metadata.mediaTypes?.slice(0, 4),
    createdAt: input.metadata.createdAt,
  };
  const base = {
    version: RETAINED_CANDIDATE_VERSION,
    retainedAt: now,
    expiresAt: now + Math.max(60_000, input.ttlMs ?? RETAINED_CANDIDATE_TTL_MS),
    normalized,
  } as const;
  const sanitized = (sanitizeValue(input.sourcePayload) ?? {}) as Record<string, unknown>;
  const candidate: RetainedCandidate = { ...base, sourcePayload: sanitized, degraded: false };
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= (input.maxBytes ?? RETAINED_CANDIDATE_MAX_BYTES)) {
    return candidate;
  }
  return {
    ...base,
    sourcePayload: minimalSourcePayload(normalized),
    degraded: true,
  };
}

export function serializeRetainedCandidate(candidate: RetainedCandidate): string {
  const serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized, 'utf8') > RETAINED_CANDIDATE_MAX_BYTES) {
    throw new Error('Retained candidate exceeds the storage limit.');
  }
  return serialized;
}

export function parseRetainedCandidate(value?: string, now = Date.now()): RetainedCandidate | undefined {
  if (!value || Buffer.byteLength(value, 'utf8') > RETAINED_CANDIDATE_MAX_BYTES) return undefined;
  try {
    const parsed = JSON.parse(value) as RetainedCandidate;
    if (
      parsed.version !== RETAINED_CANDIDATE_VERSION ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= now ||
      !parsed.normalized?.externalPostId ||
      !parsed.sourcePayload
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
