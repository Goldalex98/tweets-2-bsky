import { describe, expect, test } from 'bun:test';
import { computePerceptualHashes, MEDIA_HASH_MAX_BYTES } from '../../src/media-dedup.js';

describe('pre-enqueue perceptual media hashing', () => {
  test('disabled mode performs no request or hash', async () => {
    let requests = 0;
    let hashes = 0;
    const result = await computePerceptualHashes(['https://pbs.twimg.com/media/test.jpg'], {
      enabled: false,
      dependencies: {
        fetch: async () => {
          requests += 1;
          return new Response();
        },
        hash: async () => {
          hashes += 1;
          return 'hash';
        },
      },
    });
    expect(result).toEqual({ hashes: [], attempted: 0, failures: [] });
    expect({ requests, hashes }).toEqual({ requests: 0, hashes: 0 });
  });

  test('uses injected fetch and hash while enforcing media type and size', async () => {
    const accepted = await computePerceptualHashes(['https://pbs.twimg.com/media/test.jpg'], {
      enabled: true,
      dependencies: {
        fetch: async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
          }),
        hash: async (buffer) => `bytes-${buffer.byteLength}`,
      },
    });
    expect(accepted.hashes).toEqual(['bytes-3']);

    const invalidType = await computePerceptualHashes(['https://pbs.twimg.com/media/test.jpg'], {
      enabled: true,
      dependencies: {
        fetch: async () => new Response('not an image', { headers: { 'content-type': 'text/html' } }),
        hash: async () => 'must-not-run',
      },
    });
    expect(invalidType.failures[0]?.reason).toBe('media-type-not-allowed');

    const oversized = await computePerceptualHashes(['https://pbs.twimg.com/media/test.jpg'], {
      enabled: true,
      dependencies: {
        fetch: async () =>
          new Response(new Uint8Array([1]), {
            headers: { 'content-type': 'image/png', 'content-length': String(MEDIA_HASH_MAX_BYTES + 1) },
          }),
        hash: async () => 'must-not-run',
      },
    });
    expect(oversized.failures[0]?.reason).toBe('media-too-large');
  });
});
