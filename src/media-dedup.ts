import { perceptualImageHash } from './content-dedup.js';

export const MEDIA_HASH_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_HASH_TIMEOUT_MS = 8_000;
export const MEDIA_HASH_MAX_IMAGES = 4;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_HOSTS = new Set(['pbs.twimg.com']);

export interface MediaHashDependencies {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  hash: (buffer: Buffer) => Promise<string>;
  now: () => number;
}

export interface MediaHashResult {
  hashes: string[];
  attempted: number;
  failures: Array<{ url: string; reason: string }>;
}

const defaultDependencies: MediaHashDependencies = {
  fetch: globalThis.fetch,
  hash: perceptualImageHash,
  now: Date.now,
};

function validateMediaUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('media-url-not-allowed');
  }
  return url.toString();
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('media-too-large');
  if (!response.body) throw new Error('media-body-missing');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('media-too-large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function computePerceptualHashes(
  mediaUrls: readonly string[],
  options: {
    enabled: boolean;
    maxBytes?: number;
    timeoutMs?: number;
    dependencies?: Partial<MediaHashDependencies>;
  },
): Promise<MediaHashResult> {
  if (!options.enabled) return { hashes: [], attempted: 0, failures: [] };
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const maxBytes = Math.max(1024, Math.min(options.maxBytes ?? MEDIA_HASH_MAX_BYTES, MEDIA_HASH_MAX_BYTES));
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? MEDIA_HASH_TIMEOUT_MS, MEDIA_HASH_TIMEOUT_MS));
  const hashes: string[] = [];
  const failures: MediaHashResult['failures'] = [];
  const urls = [...new Set(mediaUrls)].slice(0, MEDIA_HASH_MAX_IMAGES);
  for (const rawUrl of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = validateMediaUrl(rawUrl);
      const response = await dependencies.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' },
      });
      if (!response.ok) throw new Error('media-http-error');
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!contentType || !ALLOWED_TYPES.has(contentType)) throw new Error('media-type-not-allowed');
      const buffer = await readBoundedBody(response, maxBytes);
      hashes.push(await dependencies.hash(buffer));
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? 'media-timeout'
          : (error as Error).message.slice(0, 80);
      failures.push({ url: rawUrl.slice(0, 2048), reason });
    } finally {
      clearTimeout(timer);
    }
  }
  return { hashes: [...new Set(hashes)].sort(), attempted: urls.length, failures };
}

export function combinePerceptualHashes(hashes: readonly string[]): string | undefined {
  return hashes.length > 0 ? [...hashes].sort().join(',') : undefined;
}
