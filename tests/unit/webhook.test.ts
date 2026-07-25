import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { NotificationConfig } from '../../src/config/schemas.js';
import {
  WebhookNotifier,
  type PinnedRequest,
  isPrivateNetworkAddress,
  resolveWebhookTarget,
  sendPinnedHttpsRequest,
  unwrapIpLiteralHostname,
  validateWebhookTarget,
} from '../../src/webhook.js';

const config = (overrides: Partial<NotificationConfig> = {}): NotificationConfig => ({
  enabled: true,
  webhookUrl: 'https://hooks.example.test/events',
  webhookSecret: 'test-signing-secret',
  allowPrivate: false,
  events: {
    'twitter-auth-failure': true,
    'bsky-auth-failure': true,
    'queue-parked': true,
    'queue-age': false,
    'update-failure': true,
  },
  maxAttempts: 3,
  backoffMs: 100,
  timeoutMs: 1000,
  ...overrides,
});

const clock = (start = 1_700_000_000_000) => {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  };
};

describe('webhook notifications', () => {
  test('blocks non-HTTPS and private DNS unless explicitly allowed', async () => {
    expect(isPrivateNetworkAddress('127.0.0.1')).toBe(true);
    expect(isPrivateNetworkAddress('10.2.3.4')).toBe(true);
    expect(isPrivateNetworkAddress('8.8.8.8')).toBe(false);
    expect(isPrivateNetworkAddress('::1')).toBe(true);
    expect(isPrivateNetworkAddress('[::1]')).toBe(true);
    expect(unwrapIpLiteralHostname('[::1]')).toBe('::1');
    await expect(validateWebhookTarget('http://example.test/x', false, async () => [])).rejects.toThrow('HTTPS');
    await expect(
      validateWebhookTarget('https://internal.test/x', false, async () => [
        { address: '192.168.1.5', family: 4 },
      ]),
    ).rejects.toThrow('private network');
    // Bracketed IPv6 literals must be classified offline — Bun keeps brackets in
    // URL.hostname, and DNS for "[::1]" can ENOTFOUND on Linux CI runners.
    await expect(
      validateWebhookTarget('https://[::1]/x', false, async () => {
        throw new Error('resolver must not be called for IPv6 literals');
      }),
    ).rejects.toThrow('private network');
    await expect(
      validateWebhookTarget('https://hooks.local/x', false, async () => [
        { address: '203.0.113.8', family: 4 },
      ]),
    ).rejects.toThrow('private network');
    await expect(
      validateWebhookTarget('https://svc.localhost/x', false, async () => [
        { address: '203.0.113.8', family: 4 },
      ]),
    ).rejects.toThrow('private network');
    expect(
      (
        await validateWebhookTarget('https://internal.test/x', true, async () => [
          { address: '192.168.1.5', family: 4 },
        ])
      ).hostname,
    ).toBe('internal.test');
  });

  test('returns the validated address so the request cannot re-resolve DNS', async () => {
    const resolved = await resolveWebhookTarget('https://hooks.example.test/events', false, async () => [
      { address: '203.0.113.8', family: 4 },
    ]);
    expect(resolved.pinnedAddress).toBe('203.0.113.8');
    expect(resolved.family).toBe(4);
    expect(resolved.target.hostname).toBe('hooks.example.test');

    const allowedPrivate = await resolveWebhookTarget('https://internal.test/x', true, async () => [
      { address: '192.168.1.5', family: 4 },
    ]);
    expect(allowedPrivate.pinnedAddress).toBeUndefined();
  });

  test('the transport dials the pinned address instead of resolving the hostname', async () => {
    await expect(
      sendPinnedHttpsRequest({
        target: new URL('http://hooks.example.test/events'),
        method: 'POST',
        headers: {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow('must use HTTPS');

    // Nothing is listening on the pinned port, so a refused loopback connection
    // proves the hostname was never resolved: that would fail with ENOTFOUND.
    const error = await sendPinnedHttpsRequest({
      target: new URL('https://hooks.example.invalid:9/events'),
      pinnedAddress: '127.0.0.1',
      family: 4,
      method: 'POST',
      headers: {},
      timeoutMs: 500,
    }).catch((reason: NodeJS.ErrnoException) => reason);
    expect((error as NodeJS.ErrnoException).code).not.toBe('ENOTFOUND');
    expect(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']).toContain((error as NodeJS.ErrnoException).code);
  });

  test('filters events, signs redacted payloads, and retries with backoff', async () => {
    const requests: PinnedRequest[] = [];
    const timing = clock();
    let attempts = 0;
    const notifier = new WebhookNotifier(() => config(), {
      lookup: async () => [{ address: '203.0.113.8', family: 4 }],
      clock: timing.clock,
      send: async (request) => {
        attempts += 1;
        requests.push(request);
        const status = attempts < 3 ? 503 : 204;
        return { status, ok: status >= 200 && status < 300, headers: {}, body: Buffer.alloc(0) };
      },
    });

    const filtered = await notifier.notify({
      event: 'queue-age',
      occurredAt: new Date(timing.clock.now()).toISOString(),
      message: 'old queue',
    });
    expect(filtered.status).toBe('filtered');
    expect(attempts).toBe(0);

    const delivered = await notifier.notify({
      event: 'queue-parked',
      occurredAt: new Date(timing.clock.now()).toISOString(),
      message: 'Bearer secret-token',
      details: { password: 'hidden', category: 'timeout' },
    });
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 3, statusCode: 204 });
    expect(timing.sleeps).toEqual([100, 200]);

    const first = requests[0];
    expect(first?.body).not.toContain('secret-token');
    expect(first?.body).not.toContain('hidden');
    // The connection is pinned to the validated address while Host and SNI stay
    // on the configured hostname.
    expect(first?.pinnedAddress).toBe('203.0.113.8');
    expect(first?.target.hostname).toBe('hooks.example.test');
    const timestamp = first?.headers['x-tweets2bsky-timestamp'] ?? '';
    const expected = createHmac('sha256', 'test-signing-secret')
      .update(`${timestamp}.${first?.body}`)
      .digest('hex');
    expect(first?.headers['x-tweets2bsky-signature']).toBe(`sha256=${expected}`);
  });

  test('a rebinding answer on a retry is refused instead of being dialled', async () => {
    const requests: PinnedRequest[] = [];
    const timing = clock();
    let resolutions = 0;
    const notifier = new WebhookNotifier(() => config({ maxAttempts: 2 }), {
      // First answer is public, the second flips to loopback: classic DNS
      // rebinding against a validate-then-connect implementation.
      lookup: async () => {
        resolutions += 1;
        return resolutions === 1
          ? [{ address: '203.0.113.8', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      clock: timing.clock,
      send: async (request) => {
        requests.push(request);
        return { status: 503, ok: false, headers: {}, body: Buffer.alloc(0) };
      },
    });

    const result = await notifier.notify({
      event: 'queue-parked',
      occurredAt: new Date(timing.clock.now()).toISOString(),
      message: 'rebinding probe',
    });

    expect(resolutions).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pinnedAddress).toBe('203.0.113.8');
    expect(result.status).toBe('failed');
    expect(result.lastError).toContain('private network');
  });

  test('a redirect is reported as a failure and never followed', async () => {
    const timing = clock();
    const targets: PinnedRequest[] = [];
    const notifier = new WebhookNotifier(() => config({ maxAttempts: 1 }), {
      lookup: async () => [{ address: '203.0.113.8', family: 4 }],
      clock: timing.clock,
      send: async (request) => {
        targets.push(request);
        return {
          status: 302,
          ok: false,
          headers: { location: 'https://169.254.169.254/latest/meta-data' },
          body: Buffer.alloc(0),
        };
      },
    });

    const result = await notifier.notify({
      event: 'queue-parked',
      occurredAt: new Date(timing.clock.now()).toISOString(),
      message: 'redirect probe',
    });

    expect(targets).toHaveLength(1);
    expect(result).toMatchObject({ status: 'failed', statusCode: 302 });
    expect(result.lastError).toContain('redirects are not followed');
  });
});
