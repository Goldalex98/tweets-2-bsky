import type {
  Destination,
  ModerationPolicy,
  Route,
  RoutingContentType,
  RoutingMediaType,
  RoutingPolicy,
} from './config/schemas.js';
import {
  type NormalizedPost,
  normalizedPostContentType,
} from './normalized-post.js';

export const CONTENT_POLICY_DECISION_VERSION = 1;

export interface ContentPolicyMetadata {
  text?: string;
  urls?: string[];
  sourceUsername?: string;
  language?: string;
  sensitive?: boolean;
  contentType?: RoutingContentType;
  mediaTypes?: RoutingMediaType[];
  createdAt?: number;
}

export function contentPolicyMetadataForPost(post: NormalizedPost): ContentPolicyMetadata {
  return {
    text: post.text,
    urls: post.urls,
    // Moderation block lists store X/webhook author handles, not canonical source ids.
    sourceUsername: post.author?.username,
    language: post.language,
    sensitive: post.sensitive,
    contentType: normalizedPostContentType(post),
    mediaTypes: post.media.map((media) => media.type),
    createdAt: Date.parse(post.createdAt),
  };
}

export interface PolicyTraceEntry {
  policy: 'routing' | 'destination-moderation' | 'route-moderation';
  predicate: string;
  matched: boolean;
  detail?: string;
}

export interface ContentPolicyDecision {
  allowed: boolean;
  reason: string;
  detail?: string;
  decisionVersion: number;
  trace: PolicyTraceEntry[];
  requiresConfirmation?: boolean;
}

const normalize = (value?: string): string => value?.trim().toLocaleLowerCase() ?? '';
const normalizeDomain = (value: string): string => value.trim().toLocaleLowerCase().replace(/^www\./, '');

export function extractCanonicalDomains(text = '', suppliedUrls: readonly string[] = []): string[] {
  const urls = [...suppliedUrls, ...(text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [])];
  const domains = new Set<string>();
  for (const raw of urls) {
    try {
      const domain = normalizeDomain(new URL(raw).hostname);
      if (domain) domains.add(domain);
    } catch {
      // Invalid URL-like text is not a domain predicate match.
    }
  }
  return [...domains].sort();
}

function keywordMatch(values: readonly string[], text: string): string | undefined {
  return values.find((value) => text.includes(normalize(value)));
}

function domainMatch(values: readonly string[], domains: readonly string[]): string | undefined {
  return values.map(normalizeDomain).find((blocked) =>
    domains.some((domain) => domain === blocked || domain.endsWith(`.${blocked}`)),
  );
}

function localHour(timestamp: number, timezone: string): number | undefined {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    })
      .formatToParts(new Date(timestamp))
      .find((entry) => entry.type === 'hour')?.value;
    const hour = Number(part);
    return Number.isInteger(hour) ? hour : undefined;
  } catch {
    return undefined;
  }
}

function evaluateRouting(
  policy: RoutingPolicy,
  metadata: ContentPolicyMetadata,
  trace: PolicyTraceEntry[],
): Omit<ContentPolicyDecision, 'decisionVersion' | 'trace'> | undefined {
  const text = normalize(metadata.text);
  const domains = extractCanonicalDomains(metadata.text, metadata.urls);
  const excludedKeyword = keywordMatch(policy.excludeKeywords, text);
  trace.push({ policy: 'routing', predicate: 'exclude-keywords', matched: Boolean(excludedKeyword), detail: excludedKeyword });
  if (excludedKeyword) return { allowed: false, reason: 'routing-excluded-keyword', detail: excludedKeyword };

  const excludedDomain = domainMatch(policy.excludeDomains, domains);
  trace.push({ policy: 'routing', predicate: 'exclude-domains', matched: Boolean(excludedDomain), detail: excludedDomain });
  if (excludedDomain) return { allowed: false, reason: 'routing-excluded-domain', detail: excludedDomain };

  const includedKeyword =
    policy.includeKeywords.length === 0 ? undefined : keywordMatch(policy.includeKeywords, text);
  trace.push({
    policy: 'routing',
    predicate: 'include-keywords',
    matched: policy.includeKeywords.length === 0 || Boolean(includedKeyword),
    detail: includedKeyword,
  });
  if (policy.includeKeywords.length > 0 && !includedKeyword) {
    return { allowed: false, reason: 'routing-required-keyword-missing' };
  }

  const includedDomain =
    policy.includeDomains.length === 0 ? undefined : domainMatch(policy.includeDomains, domains);
  trace.push({
    policy: 'routing',
    predicate: 'include-domains',
    matched: policy.includeDomains.length === 0 || Boolean(includedDomain),
    detail: includedDomain,
  });
  if (policy.includeDomains.length > 0 && !includedDomain) {
    return { allowed: false, reason: 'routing-required-domain-missing' };
  }

  const contentAllowed =
    policy.contentTypes.length === 0 ||
    Boolean(metadata.contentType && policy.contentTypes.includes(metadata.contentType));
  trace.push({ policy: 'routing', predicate: 'content-type', matched: contentAllowed, detail: metadata.contentType });
  if (!contentAllowed) return { allowed: false, reason: 'routing-content-type' };

  const actualMedia: readonly RoutingMediaType[] = metadata.mediaTypes?.length ? metadata.mediaTypes : ['none'];
  const mediaAllowed =
    policy.mediaTypes.length === 0 || actualMedia.some((media) => policy.mediaTypes.includes(media));
  trace.push({ policy: 'routing', predicate: 'media-type', matched: mediaAllowed, detail: actualMedia.join(',') });
  if (!mediaAllowed) return { allowed: false, reason: 'routing-media-type' };

  const language = normalize(metadata.language);
  const languageAllowed = policy.languages.length === 0 || Boolean(language && policy.languages.includes(language));
  trace.push({ policy: 'routing', predicate: 'language', matched: languageAllowed, detail: language || 'unknown' });
  if (!languageAllowed) return { allowed: false, reason: 'routing-language' };

  const hour = localHour(metadata.createdAt ?? Date.now(), policy.timezone);
  const hourAllowed = policy.allowedHours.length === 0 || (hour !== undefined && policy.allowedHours.includes(hour));
  trace.push({ policy: 'routing', predicate: 'schedule-hour', matched: hourAllowed, detail: String(hour ?? 'unknown') });
  if (!hourAllowed) return { allowed: false, reason: 'routing-schedule' };
  return undefined;
}

function evaluateModeration(
  policy: ModerationPolicy,
  label: 'destination-moderation' | 'route-moderation',
  metadata: ContentPolicyMetadata,
  trace: PolicyTraceEntry[],
): Omit<ContentPolicyDecision, 'decisionVersion' | 'trace'> | undefined {
  const text = normalize(metadata.text);
  const source = normalize(metadata.sourceUsername).replace(/^@/, '');
  const domains = extractCanonicalDomains(metadata.text, metadata.urls);
  const sourceMatch = policy.blockSourceUsernames.find((value) => normalize(value).replace(/^@/, '') === source);
  trace.push({
    policy: label,
    predicate: 'block-source',
    matched: Boolean(sourceMatch),
    detail: sourceMatch && policy.dryRun ? `${sourceMatch} (dry-run)` : sourceMatch,
  });
  if (sourceMatch && !policy.dryRun) return { allowed: false, reason: 'moderation-blocked-source', detail: sourceMatch };
  const keyword = keywordMatch(policy.blockKeywords, text);
  trace.push({
    policy: label,
    predicate: 'block-keyword',
    matched: Boolean(keyword),
    detail: keyword && policy.dryRun ? `${keyword} (dry-run)` : keyword,
  });
  if (keyword && !policy.dryRun) return { allowed: false, reason: 'moderation-blocked-keyword', detail: keyword };
  const domain = domainMatch(policy.blockDomains, domains);
  trace.push({
    policy: label,
    predicate: 'block-domain',
    matched: Boolean(domain),
    detail: domain && policy.dryRun ? `${domain} (dry-run)` : domain,
  });
  if (domain && !policy.dryRun) return { allowed: false, reason: 'moderation-blocked-domain', detail: domain };
  const sensitiveMatched = Boolean(metadata.sensitive);
  trace.push({ policy: label, predicate: 'sensitive-content', matched: sensitiveMatched, detail: policy.sensitiveContent });
  if (sensitiveMatched && policy.sensitiveContent === 'block' && !policy.dryRun) {
    return { allowed: false, reason: 'moderation-sensitive-content' };
  }
  if (sensitiveMatched && policy.sensitiveContent === 'warn' && !policy.dryRun) {
    return {
      allowed: false,
      reason: 'moderation-sensitive-confirmation',
      requiresConfirmation: true,
    };
  }
  return undefined;
}

export function evaluateContentPolicy(
  destination: Pick<Destination, 'moderationPolicy'>,
  route: Pick<Route, 'routingPolicy' | 'moderationPolicy'>,
  postOrMetadata: ContentPolicyMetadata | NormalizedPost,
): ContentPolicyDecision {
  const metadata =
    'sourceType' in postOrMetadata
      ? contentPolicyMetadataForPost(postOrMetadata)
      : postOrMetadata;
  const trace: PolicyTraceEntry[] = [];
  const result =
    evaluateRouting(route.routingPolicy, metadata, trace) ??
    evaluateModeration(destination.moderationPolicy, 'destination-moderation', metadata, trace) ??
    evaluateModeration(route.moderationPolicy, 'route-moderation', metadata, trace);
  return {
    ...(result ?? { allowed: true, reason: 'allowed' }),
    decisionVersion: CONTENT_POLICY_DECISION_VERSION,
    trace,
  };
}
