import sharp from 'sharp';
import { assertDeliveryActive, deliverySleep } from './services/delivery-context.js';

export const THUMBNAIL_MAX_BYTES = 1_000_000;
export const VIDEO_MAX_BYTES = 280 * 1024 * 1024;
export const VIDEO_MAX_DURATION_MS = 600_000;
export const VIDEO_PROCESSING_TIMEOUT_MS = 20 * 60 * 1000;

/** Validate decoded content, retaining acceptable thumbnail bytes when possible. */
export async function prepareExternalThumbnail(buffer: Buffer): Promise<{ buffer: Buffer; mimeType: string }> {
  const decoder = sharp(buffer);
  const metadata = await decoder.metadata();
  const mimeTypes: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  const mimeType = metadata.format ? mimeTypes[metadata.format] : undefined;
  if (!mimeType || !metadata.width || !metadata.height) throw new Error('Thumbnail content is not a supported image.');
  await decoder.stats();
  assertDeliveryActive();
  if (buffer.length <= THUMBNAIL_MAX_BYTES) return { buffer, mimeType };
  for (const width of [1600, 1200, 900, 600, 300]) {
    const candidate = await sharp(buffer)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    assertDeliveryActive();
    if (candidate.length <= THUMBNAIL_MAX_BYTES) return { buffer: candidate, mimeType: 'image/jpeg' };
  }
  throw new Error('Thumbnail exceeds the external-card size limit.');
}

export interface VideoVariant {
  url: string;
  content_type?: string;
  bitrate?: number;
}

export async function downloadVideoVariant(
  variants: readonly VideoVariant[],
  durationMs: number,
  download: (url: string) => Promise<Buffer>,
): Promise<{ buffer: Buffer; url: string }> {
  if (durationMs > VIDEO_MAX_DURATION_MS) throw new Error('Video exceeds ten minutes.');
  const oversizedEstimate = (variant: VideoVariant) =>
    durationMs > 0 && ((variant.bitrate ?? 0) * durationMs) / 8000 > VIDEO_MAX_BYTES;
  const ranked = variants
    .filter((variant) => variant.content_type === 'video/mp4')
    .slice()
    .sort((a, b) => Number(oversizedEstimate(a)) - Number(oversizedEstimate(b)) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  let lastError: unknown = new Error('Video has no supported MP4 variant.');
  const attempted = new Set<string>();
  for (const variant of ranked) {
    if (attempted.has(variant.url)) continue;
    if (attempted.size >= 5) break;
    attempted.add(variant.url);
    assertDeliveryActive();
    try {
      const buffer = await download(variant.url);
      assertDeliveryActive();
      if (!buffer.length || buffer.length > VIDEO_MAX_BYTES)
        throw new Error('Video variant exceeds the upload size limit.');
      return { buffer, url: variant.url };
    } catch (error) {
      assertDeliveryActive();
      lastError = error;
    }
  }
  throw lastError;
}

export interface VideoProcessingStatus<T> {
  state: string;
  blob?: T;
  error?: string;
}

export async function waitForVideoProcessing<T>(
  fetchStatus: (remainingMs: number) => Promise<VideoProcessingStatus<T> | null>,
  clock = { now: () => Date.now(), sleep: deliverySleep },
): Promise<T> {
  const deadline = clock.now() + VIDEO_PROCESSING_TIMEOUT_MS;
  while (clock.now() < deadline) {
    assertDeliveryActive();
    let status: VideoProcessingStatus<T> | null = null;
    try {
      status = await fetchStatus(deadline - clock.now());
    } catch {
      assertDeliveryActive();
    }
    assertDeliveryActive();
    if (clock.now() >= deadline) break;
    if (status?.blob) return status.blob;
    if (status?.state === 'JOB_STATE_FAILED')
      throw new Error(`Video processing failed: ${status.error ?? 'Unknown error'}`);
    await clock.sleep(Math.min(5000, deadline - clock.now()));
  }
  throw new Error('Video processing timed out after 20 minutes.');
}
