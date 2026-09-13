import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  prepareExternalThumbnail,
  downloadVideoVariant,
  waitForVideoProcessing,
  THUMBNAIL_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VIDEO_PROCESSING_TIMEOUT_MS,
} from '../../src/media-delivery-policy.js';
import { runWithDeliveryContext } from '../../src/services/delivery-context.js';

describe('external-card thumbnails', () => {
  test('validates decoded bytes at the exact limit and compresses a larger thumbnail', async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fedcba' } })
      .png()
      .toBuffer();
    const exact = Buffer.concat([png, Buffer.alloc(THUMBNAIL_MAX_BYTES - png.length)]);
    const accepted = await prepareExternalThumbnail(exact);
    expect(accepted.buffer.length).toBe(THUMBNAIL_MAX_BYTES);
    expect(accepted.mimeType).toBe('image/png');
    const larger = await prepareExternalThumbnail(Buffer.concat([png, Buffer.alloc(1_500_000)]));
    expect(larger.buffer.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    expect(larger.mimeType).toBe('image/jpeg');
    expect((await sharp(larger.buffer).metadata()).width).toBe(32);
  });
  test('rejects HTML and damaged image payloads regardless of claimed image MIME', async () => {
    await expect(prepareExternalThumbnail(Buffer.from('<html>not an image</html>'))).rejects.toThrow();
    await expect(prepareExternalThumbnail(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).rejects.toThrow();
  });
});

describe('video policy', () => {
  const variants = [
    { url: 'high', content_type: 'video/mp4', bitrate: 2000 },
    { url: 'low', content_type: 'video/mp4', bitrate: 1000 },
  ];
  test('accepts three and ten minutes and missing duration, rejects over ten without downloading', async () => {
    for (const duration of [0, 180000, 600000]) {
      expect((await downloadVideoVariant(variants, duration, async () => Buffer.from('video'))).url).toBe('high');
    }
    let calls = 0;
    await expect(
      downloadVideoVariant(variants, 600001, async () => {
        calls++;
        return Buffer.alloc(0);
      }),
    ).rejects.toThrow('ten minutes');
    expect(calls).toBe(0);
  });
  test('tries lower quality after oversized download, using mocked lengths', async () => {
    const calls: string[] = [];
    const result = await downloadVideoVariant(variants, 600000, async (url) => {
      calls.push(url);
      return url === 'high' ? ({ length: VIDEO_MAX_BYTES + 1 } as Buffer) : Buffer.from('video');
    });
    expect(calls).toEqual(['high', 'low']);
    expect(result.url).toBe('low');
    await expect(
      downloadVideoVariant(variants, 0, async () => ({ length: VIDEO_MAX_BYTES + 1 }) as Buffer),
    ).rejects.toThrow('size limit');
    await expect(downloadVideoVariant([], 0, async () => Buffer.alloc(0))).rejects.toThrow('no supported MP4');
  });
  test('recovers from a thrown download error and ignores unsupported streaming variants', async () => {
    const calls: string[] = [];
    const result = await downloadVideoVariant(
      [{ url: 'stream', content_type: 'application/x-mpegURL', bitrate: 3000 }, ...variants],
      180000,
      async (url) => {
        calls.push(url);
        if (url === 'high') throw new Error('Fixture HTTP 503');
        return Buffer.from('short-video');
      },
    );
    expect(calls).toEqual(['high', 'low']);
    expect(result.buffer.toString()).toBe('short-video');
  });
  test('prefers the highest-quality variant estimated to fit a ten-minute video', async () => {
    const calls: string[] = [];
    const result = await downloadVideoVariant(
      [
        { url: 'low', content_type: 'video/mp4', bitrate: 1_000_000 },
        { url: 'oversized', content_type: 'video/mp4', bitrate: 8_000_000 },
        { url: 'best-fitting', content_type: 'video/mp4', bitrate: 3_000_000 },
      ],
      600000,
      async (url) => {
        calls.push(url);
        return Buffer.from('video');
      },
    );
    expect(calls).toEqual(['best-fitting']);
    expect(result.url).toBe('best-fitting');
  });
  test('bounds failed downloads to five distinct MP4 URLs even with duplicates', async () => {
    const calls: string[] = [];
    const manyVariants = Array.from({ length: 7 }, (_, index) => ({
      url: `quality-${index}`,
      content_type: 'video/mp4',
      bitrate: 7000 - index * 1000,
    }));
    manyVariants.splice(1, 0, { url: 'quality-0', content_type: 'video/mp4', bitrate: 7000 });
    await expect(
      downloadVideoVariant(manyVariants, 0, async (url) => {
        calls.push(url);
        throw new Error(`Fixture download failed: ${url}`);
      }),
    ).rejects.toThrow('quality-4');
    expect(calls).toEqual(['quality-0', 'quality-1', 'quality-2', 'quality-3', 'quality-4']);
  });
  test('accepts the exact byte ceiling and rejects empty downloads', async () => {
    const result = await downloadVideoVariant(variants, 0, async () => ({ length: VIDEO_MAX_BYTES }) as Buffer);
    expect(result.buffer.length).toBe(VIDEO_MAX_BYTES);
    await expect(downloadVideoVariant(variants, 0, async () => Buffer.alloc(0))).rejects.toThrow('size limit');
  });
  test('cancellation cannot be swallowed as a lower-quality retry', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runWithDeliveryContext({ controller, assertOwnership() {} }, () =>
        downloadVideoVariant(variants, 0, async () => {
          calls++;
          controller.abort(new Error('cancelled'));
          throw new Error('network aborted');
        }),
      ),
    ).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });
  test('processing deadline includes request time and supports successful/error states', async () => {
    let now = 0;
    const clock = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    let requests = 0;
    await expect(
      waitForVideoProcessing(async (remaining) => {
        requests++;
        now += Math.min(remaining, 30000);
        return null;
      }, clock),
    ).rejects.toThrow('20 minutes');
    expect(now).toBe(VIDEO_PROCESSING_TIMEOUT_MS);
    expect(requests).toBeLessThan(40);
    expect(await waitForVideoProcessing(async () => ({ state: 'JOB_STATE_COMPLETED', blob: 'blob' }), clock)).toBe(
      'blob',
    );
    await expect(
      waitForVideoProcessing(async () => ({ state: 'JOB_STATE_FAILED', error: 'unsupported' }), clock),
    ).rejects.toThrow('unsupported');
  });
  test('processing cancellation during an in-flight successful response never returns its blob', async () => {
    const controller = new AbortController();
    await expect(
      runWithDeliveryContext({ controller, assertOwnership() {} }, () =>
        waitForVideoProcessing(async () => {
          controller.abort(new Error('Fixture delivery cancelled'));
          return { state: 'JOB_STATE_COMPLETED', blob: 'late-blob' };
        }),
      ),
    ).rejects.toThrow('Fixture delivery cancelled');
  });
  test('processing cancellation during a failed request does not retry or sleep', async () => {
    const controller = new AbortController();
    let requests = 0;
    let sleeps = 0;
    await expect(
      runWithDeliveryContext({ controller, assertOwnership() {} }, () =>
        waitForVideoProcessing(
          async () => {
            requests++;
            controller.abort(new Error('Fixture delivery cancelled'));
            throw new Error('Fixture fetch aborted');
          },
          {
            now: () => 0,
            sleep: async () => {
              sleeps++;
            },
          },
        ),
      ),
    ).rejects.toThrow('Fixture delivery cancelled');
    expect(requests).toBe(1);
    expect(sleeps).toBe(0);
  });
});
