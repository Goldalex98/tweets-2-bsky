import { describe, expect, test } from 'bun:test';
import { fetchPublicHttps } from '../../src/public-http-fetch.js';
import type { PinnedRequest, PinnedResponse } from '../../src/webhook.js';

describe('public HTTPS fetch', () => {
  test('refuses private and local targets before dialing', async () => {
    const send = async () => {
      throw new Error('send must not be called');
    };
    await expect(
      fetchPublicHttps('https://127.0.0.1/secret', {
        send,
        lookup: async () => {
          throw new Error('lookup must not run for literals');
        },
      }),
    ).rejects.toThrow('private network');
    await expect(
      fetchPublicHttps('https://meta.local/card', {
        send,
        lookup: async () => [{ address: '203.0.113.8', family: 4 }],
      }),
    ).rejects.toThrow('private network');
    await expect(
      fetchPublicHttps('https://app.localhost/expand', {
        send,
        lookup: async () => [{ address: '203.0.113.8', family: 4 }],
      }),
    ).rejects.toThrow('private network');
  });

  test('re-validates each redirect hop and returns the final public URL', async () => {
    const requests: string[] = [];
    const send = async (request: PinnedRequest): Promise<PinnedResponse> => {
      requests.push(request.target.toString());
      if (request.target.hostname === 'tco.example.test') {
        return {
          status: 302,
          ok: false,
          headers: { location: 'https://news.example.test/article' },
          body: Buffer.alloc(0),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html></html>'),
      };
    };
    const result = await fetchPublicHttps('https://tco.example.test/abc', {
      method: 'HEAD',
      send,
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
    });
    expect(requests).toEqual(['https://tco.example.test/abc', 'https://news.example.test/article']);
    expect(result.url).toBe('https://news.example.test/article');
    expect(result.status).toBe(200);
  });

  test('blocks redirects that land on a private address', async () => {
    const send = async (request: PinnedRequest): Promise<PinnedResponse> => {
      if (request.target.hostname === 'public.example.test') {
        return {
          status: 302,
          ok: false,
          headers: { location: 'https://169.254.169.254/latest/meta-data' },
          body: Buffer.alloc(0),
        };
      }
      throw new Error('should not dial the private hop');
    };
    await expect(
      fetchPublicHttps('https://public.example.test/card', {
        send,
        lookup: async (hostname) => {
          if (hostname === 'public.example.test') return [{ address: '203.0.113.20', family: 4 }];
          throw new Error(`unexpected lookup ${hostname}`);
        },
      }),
    ).rejects.toThrow('private network');
  });
});
