import type { ConfigVersion, DashboardTab, SettingsSection } from '../api/types';
import type { ActivityLog, BskyFacet } from '../features/activity/types';
import type {
  AccountMapping,
  AttributionMode,
  MappingFormState,
  SourceParseSummary,
} from '../features/destinations/types';
import type { AppState } from '../features/status/types';

export const DEFAULT_GROUP_NAME = 'Ungrouped';
export const DEFAULT_GROUP_EMOJI = '📁';
export const DEFAULT_GROUP_KEY = 'ungrouped';
export const INITIAL_CONFIG_VERSION: ConfigVersion = { revision: 0, updatedAt: new Date(0).toISOString() };
export const TAB_PATHS: Record<DashboardTab, string> = {
  overview: '/',
  accounts: '/accounts',
  posts: '/posts',
  activity: '/activity',
  settings: '/settings',
};
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'account',
  'system',
  'scheduler',
  'users',
  'twitter',
  'bluesky',
  'ai',
  'notifications',
  'ingestion',
  'data',
] as const;

export interface DashboardLocation {
  tab: DashboardTab;
  settingsSection?: SettingsSection;
  destinationId?: string;
  routeId?: string;
  editSection?: string;
}

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

function isDashboardTab(value: string): value is DashboardTab {
  return value in TAB_PATHS;
}

export function parseDashboardLocation(pathname: string, search: string): DashboardLocation {
  const normalized = normalizePath(pathname);
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const destinationId = params.get('destinationId') ?? undefined;
  const routeId = params.get('routeId') ?? undefined;
  const sectionParam = params.get('section') ?? undefined;

  if (normalized === '/settings' || normalized.startsWith('/settings/')) {
    const sectionSegment = normalized.slice('/settings'.length).replace(/^\//, '');
    const settingsSection =
      sectionSegment && isSettingsSection(sectionSegment) ? sectionSegment : 'account';
    return {
      tab: 'settings',
      settingsSection,
      ...(destinationId ? { destinationId } : {}),
      ...(routeId ? { routeId } : {}),
      ...(sectionParam ? { editSection: sectionParam } : {}),
    };
  }

  const tab = getTabFromPath(normalized) ?? 'overview';
  return {
    tab,
    ...(destinationId ? { destinationId } : {}),
    ...(routeId ? { routeId } : {}),
    ...(sectionParam ? { editSection: sectionParam } : {}),
  };
}

export function buildDashboardUrl(location: DashboardLocation): string {
  const tab = isDashboardTab(location.tab) ? location.tab : 'overview';
  if (tab === 'settings') {
    const section =
      location.settingsSection && isSettingsSection(location.settingsSection)
        ? location.settingsSection
        : 'account';
    return section === 'account' ? '/settings' : `/settings/${section}`;
  }

  const base = TAB_PATHS[tab];
  const params = new URLSearchParams();
  if (location.destinationId) params.set('destinationId', location.destinationId);
  if (location.editSection) params.set('section', location.editSection);
  if (location.routeId) params.set('routeId', location.routeId);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
export const ADD_ACCOUNT_STEPS = ['Sources', 'Create', 'Bluesky', 'Verify & Create'] as const;
export const ADD_ACCOUNT_STEP_COUNT = ADD_ACCOUNT_STEPS.length;
export const ACCOUNT_SEARCH_MIN_SCORE = 22;
export const ACCOUNT_PAGE_SIZE_DEFAULT = 50;
export const DEFAULT_BACKFILL_LIMIT = 15;
export const FEDIVERSE_BRIDGE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const selectClassName =
  'flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Mirrors `parseSchedulerIntervalMinutes` in `src/scheduler-timing.ts`. */
export const MIN_CHECK_INTERVAL_MINUTES = 1;
export const MAX_CHECK_INTERVAL_MINUTES = 1440;

export interface CheckIntervalParseResult {
  minutes: number | null;
  error: string | null;
}

export function parseCheckIntervalMinutes(raw: string): CheckIntervalParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { minutes: null, error: 'Enter a check interval in minutes.' };
  const candidate = Number(trimmed);
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate)) {
    return { minutes: null, error: 'Check interval must be a whole number of minutes.' };
  }
  if (candidate < MIN_CHECK_INTERVAL_MINUTES || candidate > MAX_CHECK_INTERVAL_MINUTES) {
    return {
      minutes: null,
      error: `Check interval must be between ${MIN_CHECK_INTERVAL_MINUTES} and ${MAX_CHECK_INTERVAL_MINUTES} minutes.`,
    };
  }
  return { minutes: candidate, error: null };
}

export function estimateChecksPerHour(sourceCount: number, intervalMinutes: number): number {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return 0;
  return Math.round((sourceCount * 60) / intervalMinutes);
}

export const ATTRIBUTION_MODE_OPTIONS: Array<{ value: AttributionMode; label: string }> = [
  { value: 'never', label: 'Never (one-to-one mirror)' },
  { value: 'multiple-sources', label: 'Only when this destination has multiple X sources (aggregate)' },
  { value: 'always', label: 'Always' },
];

/** Mirrors the server-side attribution template contract in `src/post-transform.ts`. */
export const ALLOWED_ATTRIBUTION_TEMPLATE_VARIABLES = ['username', 'url', 'postUrl', 'destination'] as const;

const attributionTemplateVariablePattern = /\{([^{}]*)\}/g;

export function validateAttributionTemplate(template: string): string | null {
  if (typeof template !== 'string' || template.length < 1 || template.length > 160) {
    return 'Attribution template must contain between 1 and 160 characters.';
  }
  const allowed = new Set<string>(ALLOWED_ATTRIBUTION_TEMPLATE_VARIABLES);
  for (const match of template.matchAll(attributionTemplateVariablePattern)) {
    const variable = match[1] || '';
    if (!allowed.has(variable)) return `Attribution template contains unsupported variable: {${variable}}.`;
  }
  const withoutVariables = template.replace(attributionTemplateVariablePattern, '');
  if (withoutVariables.includes('{') || withoutVariables.includes('}')) {
    return 'Attribution template contains an invalid variable expression.';
  }
  return null;
}

/** The attribution mode a destination should default to for a given source count. */
export function defaultAttributionMode(sourceCount: number): AttributionMode {
  return sourceCount > 1 ? 'multiple-sources' : 'never';
}

/**
 * Re-applies the source-count default when the operator has not overridden it.
 * An explicit choice that differs from the previous default is preserved.
 */
export function nextAttributionModeForSourceChange(
  currentMode: AttributionMode,
  previousSourceCount: number,
  nextSourceCount: number,
): AttributionMode {
  const previousDefault = defaultAttributionMode(previousSourceCount);
  const nextDefault = defaultAttributionMode(nextSourceCount);
  if (previousDefault === nextDefault) return currentMode;
  return currentMode === previousDefault ? nextDefault : currentMode;
}

export function describeAttribution(mode: AttributionMode, sourceCount: number): string {
  if (mode === 'always') return 'Every mirrored post is prefixed with its X source.';
  if (mode === 'never') return 'Mirrored posts are never prefixed with an X source.';
  return sourceCount > 1
    ? `Active: this destination has ${sourceCount} X sources, so posts are prefixed with their source.`
    : 'Inactive while this destination has a single X source; it turns on automatically when a second source is added.';
}

export function defaultMappingForm(): MappingFormState {
  return {
    owner: '',
    bskyIdentifier: '',
    bskyPassword: '',
    bskyServiceUrl: 'https://bsky.social',
    groupName: '',
    groupEmoji: '📁',
    postingPolicy: {
      attribution: {
        mode: 'never',
        template: 'Source: @{username} on X',
        rootPostsOnly: true,
        linkSource: true,
      },
      appendOriginalPostLink: false,
    },
    profileManagement: {
      allowProfileMutation: false,
      ensureBotLabel: false,
      ensureDisplayNameBotSuffix: false,
      profileSync: {
        mode: 'off',
        intervalHours: 24,
        fields: { displayName: false, description: false, avatar: false, banner: false },
      },
      pinSync: { mode: 'off', intervalHours: 24 },
    },
    aiOverrides: {
      imageAltText: 'inherit',
      textCapabilities: {
        translation: 'inherit',
        summarization: 'inherit',
        cleanup: 'inherit',
        hashtags: 'inherit',
      },
    },
  };
}

export function formatState(state: AppState): string {
  switch (state) {
    case 'checking':
      return 'Checking';
    case 'backfilling':
      return 'Backfilling';
    case 'pacing':
      return 'Pacing';
    case 'processing':
      return 'Processing';
    default:
      return 'Idle';
  }
}

export function getBskyPostUrl(activity: ActivityLog): string | null {
  if (!activity.bsky_uri || !activity.bsky_identifier) return null;
  const postId = activity.bsky_uri.split('/').filter(Boolean).pop();
  return postId ? `https://bsky.app/profile/${activity.bsky_identifier}/post/${postId}` : null;
}

export function normalizeTwitterUsername(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function normalizeGroupName(value?: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_GROUP_NAME;
}

export function normalizeGroupEmoji(value?: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_GROUP_EMOJI;
}

export function getGroupKey(groupName?: string): string {
  return normalizeGroupName(groupName).toLowerCase();
}

export function getGroupMeta(groupName?: string, groupEmoji?: string) {
  const name = normalizeGroupName(groupName);
  const emoji = normalizeGroupEmoji(groupEmoji);
  return { key: getGroupKey(name), name, emoji };
}

export function getMappingGroupMeta(mapping?: Pick<AccountMapping, 'groupName' | 'groupEmoji'>) {
  return getGroupMeta(mapping?.groupName, mapping?.groupEmoji);
}

export function getTwitterPostUrl(twitterUsername?: string, twitterId?: string): string | undefined {
  if (!twitterUsername || !twitterId) return undefined;
  return `https://x.com/${normalizeTwitterUsername(twitterUsername)}/status/${twitterId}`;
}

export function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

export function getTabFromPath(pathname: string): DashboardTab | null {
  const normalized = normalizePath(pathname);
  const entry = (Object.entries(TAB_PATHS) as Array<[DashboardTab, string]>).find(([, path]) => path === normalized);
  return entry ? entry[0] : null;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function getProfileAgeMs(createdAt?: string): number | null {
  if (!createdAt) return null;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : null;
}

export function canBridgeToFediverse(createdAt?: string): boolean {
  const ageMs = getProfileAgeMs(createdAt);
  return ageMs !== null && ageMs >= FEDIVERSE_BRIDGE_MIN_AGE_MS;
}

export function parseTwitterUsernameInput(
  current: string[],
  value: string,
): { usernames: string[]; summary: SourceParseSummary } {
  const seen = new Set(current.map(normalizeTwitterUsername));
  const next = [...current];
  const inputSeen = new Set<string>();
  const summary: SourceParseSummary = { duplicates: [], invalid: [] };
  for (const input of value.split(/[\s,]+/).filter(Boolean)) {
    const candidate = normalizeTwitterUsername(input);
    if (!/^[a-z0-9_]{1,15}$/.test(candidate)) {
      summary.invalid.push({
        input,
        normalized: candidate || undefined,
        reason: 'Use 1-15 letters, numbers, or underscores.',
      });
      continue;
    }
    if (seen.has(candidate)) {
      summary.duplicates.push({ input, username: candidate, reason: 'existing' });
      continue;
    }
    if (inputSeen.has(candidate)) {
      summary.duplicates.push({ input, username: candidate, reason: 'input' });
      continue;
    }
    inputSeen.add(candidate);
    seen.add(candidate);
    next.push(candidate);
  }
  return { usernames: next, summary };
}

export function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@#._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeSearchValue(value: string): string[] {
  return value ? value.split(' ').filter((token) => token.length > 0) : [];
}

function orderedSubsequenceScore(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  let matched = 0;
  let searchIndex = 0;
  for (const char of query) {
    const foundIndex = candidate.indexOf(char, searchIndex);
    if (foundIndex === -1) continue;
    matched += 1;
    searchIndex = foundIndex + 1;
  }
  return matched / query.length;
}

function buildBigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length < 2) {
    if (value.length === 1) result.add(value);
    return result;
  }
  for (let i = 0; i < value.length - 1; i += 1) result.add(value.slice(i, i + 2));
  return result;
}

function diceCoefficient(a: string, b: string): number {
  const aBigrams = buildBigrams(a);
  const bBigrams = buildBigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) return 0;
  let overlap = 0;
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (aBigrams.size + bBigrams.size);
}

function scoreSearchField(query: string, tokens: string[], candidateValue?: string): number {
  const candidate = normalizeSearchValue(candidateValue || '');
  if (!query || !candidate) return 0;
  let score = 0;
  if (candidate === query) score += 170;
  else if (candidate.startsWith(query)) score += 138;
  else if (candidate.includes(query)) score += 108;

  let matchedTokens = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) {
      matchedTokens += 1;
      score += token.length >= 4 ? 18 : 12;
    }
  }
  if (tokens.length > 0) score += (matchedTokens / tokens.length) * 46;
  return score + orderedSubsequenceScore(query, candidate) * 45 + diceCoefficient(query, candidate) * 52;
}

export function scoreAccountMapping(mapping: AccountMapping, query: string, tokens: string[]): number {
  const usernameScores = mapping.twitterUsernames.map((username) => scoreSearchField(query, tokens, username) * 1.24);
  const bestUsernameScore = usernameScores.length > 0 ? Math.max(...usernameScores) : 0;
  const identifierScore = scoreSearchField(query, tokens, mapping.bskyIdentifier) * 1.2;
  const ownerScore = scoreSearchField(query, tokens, mapping.owner) * 0.92;
  const groupScore = scoreSearchField(query, tokens, mapping.groupName) * 0.72;
  const combined = [bestUsernameScore, identifierScore, ownerScore, groupScore];
  const maxScore = Math.max(...combined);
  return maxScore + (combined.reduce((total, fieldScore) => total + fieldScore, 0) - maxScore) * 0.24;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const compactNumberFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export type FacetSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; text: string; href: string }
  | { type: 'tag'; text: string; href: string };

function sliceByBytes(bytes: Uint8Array, start: number, end: number): string {
  return textDecoder.decode(bytes.slice(start, end));
}

export function buildFacetSegments(text: string, facets: BskyFacet[]): FacetSegment[] {
  const bytes = textEncoder.encode(text);
  const sortedFacets = [...facets].sort((a, b) => (a.index?.byteStart || 0) - (b.index?.byteStart || 0));
  const segments: FacetSegment[] = [];
  let cursor = 0;
  for (const facet of sortedFacets) {
    const start = Number(facet.index?.byteStart);
    const end = Number(facet.index?.byteEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < cursor || end <= start || end > bytes.length) {
      continue;
    }
    if (start > cursor) segments.push({ type: 'text', text: sliceByBytes(bytes, cursor, start) });
    const rawText = sliceByBytes(bytes, start, end);
    const feature = facet.features?.[0];
    if (feature?.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
      segments.push({ type: 'link', text: rawText, href: feature.uri });
    } else if (feature?.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
      segments.push({ type: 'mention', text: rawText, href: `https://bsky.app/profile/${feature.did}` });
    } else if (feature?.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
      segments.push({ type: 'tag', text: rawText, href: `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}` });
    } else {
      segments.push({ type: 'text', text: rawText });
    }
    cursor = end;
  }
  if (cursor < bytes.length) segments.push({ type: 'text', text: sliceByBytes(bytes, cursor, bytes.length) });
  return segments.length > 0 ? segments : [{ type: 'text', text }];
}

export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(Math.max(0, value));
}

/**
 * Parse API/SQLite timestamps for display. Naive "YYYY-MM-DD HH:MM:SS" values
 * from SQLite CURRENT_TIMESTAMP are UTC and must not be treated as local.
 */
export function parseDisplayInstant(value?: string | number | null): Date | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = trimmed.includes('T') ? `${trimmed}Z` : `${trimmed.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatLocalDateTime(value?: string | number | null): string {
  const date = parseDisplayInstant(value);
  return date ? date.toLocaleString() : 'Unknown time';
}

export function formatLocalTime(value?: string | number | null): string {
  const date = parseDisplayInstant(value);
  return date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--';
}
