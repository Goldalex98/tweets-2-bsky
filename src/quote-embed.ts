export interface QuotedPostSnapshot {
  id: string;
  username?: string;
  text?: string;
  permanentUrl?: string;
  thumbnailUrl?: string;
  sensitive?: boolean;
}

export interface QuoteStrongRef {
  uri: string;
  cid: string;
}

export interface QuoteCardMetadata {
  uri: string;
  title: string;
  description: string;
  thumbnailUrl?: string;
}

export type QuoteFallbackStrategy =
  | 'synthesized-card'
  | 'open-graph-card'
  | 'screenshot'
  | 'link';

export function quoteFallbackOrder(args: {
  hasSynthesizedMetadata: boolean;
  canUseExternalCard: boolean;
  canUseScreenshot: boolean;
}): QuoteFallbackStrategy[] {
  const order: QuoteFallbackStrategy[] = [];
  if (args.canUseExternalCard) {
    order.push(args.hasSynthesizedMetadata ? 'synthesized-card' : 'open-graph-card');
  }
  if (args.canUseScreenshot) order.push('screenshot');
  order.push('link');
  return order;
}

const trimGraphemes = (value: string, limit: number): string => {
  const normalized = value.trim();
  const graphemes = Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)].map((entry) => entry.segment)
    : Array.from(normalized);
  if (graphemes.length <= limit) return graphemes.join('');
  return `${graphemes.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
};

const normalizeCardText = (value: string | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();

export function canonicalQuotedPostUrl(snapshot: QuotedPostSnapshot | undefined, quoteId: string): string {
  const candidate = snapshot?.permanentUrl;
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (['twitter.com', 'www.twitter.com', 'www.x.com'].includes(parsed.hostname.toLowerCase())) {
        parsed.hostname = 'x.com';
      }
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return candidate.replace('twitter.com', 'x.com');
    }
  }
  return snapshot?.username
    ? `https://x.com/${snapshot.username}/status/${quoteId}`
    : `https://x.com/i/status/${quoteId}`;
}

export function buildQuoteCardMetadata(
  snapshot: QuotedPostSnapshot | undefined,
  quoteId: string,
): QuoteCardMetadata | null {
  const username = normalizeCardText(snapshot?.username);
  const description = normalizeCardText(snapshot?.text);
  if (!username && !description) return null;

  const metadata: QuoteCardMetadata = {
    uri: canonicalQuotedPostUrl(snapshot, quoteId),
    title: trimGraphemes(username ? `Quoted post by @${username} on X` : 'Quoted post on X', 300),
    description: trimGraphemes(description || 'View the quoted post on X.', 1_000),
  };
  if (snapshot?.thumbnailUrl && !snapshot.sensitive) metadata.thumbnailUrl = snapshot.thumbnailUrl;
  return metadata;
}

export function resolveQuoteStrongRef(
  local: Partial<QuoteStrongRef> | null | undefined,
  crossDestination: Partial<QuoteStrongRef> | null | undefined,
): QuoteStrongRef | null {
  for (const candidate of [local, crossDestination]) {
    if (candidate?.uri && candidate.cid) return { uri: candidate.uri, cid: candidate.cid };
  }
  return null;
}

export function removeEmbeddedQuoteUrl(text: string, quoteUrl: string, aliases: string[] = []): string {
  const urls = [quoteUrl, ...aliases].filter(Boolean);
  const variants = new Set(
    urls.flatMap((url) => [
      url,
      url.replace('https://x.com/', 'https://twitter.com/'),
      url.replace('https://twitter.com/', 'https://x.com/'),
    ]),
  );
  let cleaned = text;
  for (const variant of variants) cleaned = cleaned.split(variant).join('');
  return cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/g, '').trim();
}
