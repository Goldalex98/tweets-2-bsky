import { createHash } from 'node:crypto';
import sharp from 'sharp';

export interface CanonicalContent {
  text: string;
  urls: string[];
}

function canonicalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    const entries = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
      a === b ? av.localeCompare(bv) : a.localeCompare(b),
    );
    url.search = '';
    for (const [key, child] of entries) url.searchParams.append(key, child);
    return url.toString();
  } catch {
    return undefined;
  }
}

export function canonicalizeContent(text: string, suppliedUrls: readonly string[] = []): CanonicalContent {
  const embeddedUrls = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const urls = [...new Set([...embeddedUrls, ...suppliedUrls].map(canonicalUrl).filter(Boolean) as string[])].sort();
  const urlSet = new Set(embeddedUrls);
  const canonicalText = text
    .split(/\s+/)
    .filter((token) => !urlSet.has(token))
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return { text: canonicalText, urls };
}

export function contentSha256(text: string, urls: readonly string[] = []): string {
  const canonical = canonicalizeContent(text, urls);
  return createHash('sha256')
    .update(canonical.text)
    .update('\0')
    .update(canonical.urls.join('\n'))
    .digest('hex');
}

/**
 * Computes a small average hash. The caller must gate this behind the
 * perceptualImageHash policy; no source bytes are retained.
 */
export async function perceptualImageHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer({
    resolveWithObject: true,
  });
  const average = data.reduce((sum, value) => sum + value, 0) / data.length;
  let bits = '';
  for (const value of data) bits += value >= average ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hammingDistance(left: string, right: string): number {
  try {
    let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
    let count = 0;
    while (value) {
      count += Number(value & 1n);
      value >>= 1n;
    }
    return count;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
