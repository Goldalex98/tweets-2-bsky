import type { BskyAgent } from '@atproto/api';
import { describe, expect, test } from 'bun:test';
import { createBlueskyNormalizedDeliveryAdapter } from '../../src/adapters/bluesky-normalized-delivery.js';
import type { NormalizedMediaDescriptor } from '../../src/normalized-post.js';

function createAdapter() {
  return createBlueskyNormalizedDeliveryAdapter({
    agent: {} as BskyAgent,
    uploadImage: async () => ({}),
    uploadVideo: async () => ({}),
    publish: async () => ({ uri: 'at://example/post/1', cid: 'cid-1' }),
  });
}

function media(url: string): NormalizedMediaDescriptor {
  return { type: 'image', url, mimeType: 'image/jpeg', sizeBytes: 1024 };
}

describe('normalized media downloads', () => {
  test('refuse targets the webhook rules already block', async () => {
    const adapter = createAdapter();
    // Address literals are checked without a DNS lookup, so this stays offline.
    await expect(adapter.downloadMedia(media('https://127.0.0.1/a.jpg'))).rejects.toThrow('private network');
    await expect(adapter.downloadMedia(media('https://169.254.169.254/latest/meta-data'))).rejects.toThrow(
      'private network',
    );
    await expect(adapter.downloadMedia(media('https://[::1]/a.jpg'))).rejects.toThrow('private network');
    await expect(adapter.downloadMedia(media('http://203.0.113.8/a.jpg'))).rejects.toThrow('HTTPS');
    await expect(adapter.downloadMedia(media('https://user:pass@203.0.113.8/a.jpg'))).rejects.toThrow(
      'credentials',
    );
    await expect(adapter.downloadMedia(media('not-a-url'))).rejects.toThrow('invalid');
  });
});
