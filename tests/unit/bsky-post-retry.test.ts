import { describe, expect, test } from 'bun:test';
import { XRPCError } from '@atproto/api';
import {
  BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS,
  BSKY_POST_RETRY_DELAY_MS,
  blueskyPostRetryDelayMs,
} from '../../src/bsky-post-retry.js';

const now = Date.parse('2026-10-03T12:00:00.000Z');
const rateLimited = (resetInSeconds: number) =>
  new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded', {
    'ratelimit-reset': String(Math.floor(now / 1000) + resetInSeconds),
  });

describe('Bluesky post retry policy', () => {
  test('network failures retry after the short delay', () => {
    expect(blueskyPostRetryDelayMs(new Error('socket hang up'), now)).toBe(BSKY_POST_RETRY_DELAY_MS);
  });

  test('a dead session is not retried inline', () => {
    expect(blueskyPostRetryDelayMs(new XRPCError(400, 'ExpiredToken', 'Token has expired'), now)).toBeUndefined();
  });

  test('a short rate limit waits until the advertised reset', () => {
    expect(blueskyPostRetryDelayMs(rateLimited(20), now)).toBe(21_000);
    expect(blueskyPostRetryDelayMs(rateLimited(0), now)).toBe(BSKY_POST_RETRY_DELAY_MS);
  });

  test('a long rate limit is handed back to the queue', () => {
    expect(blueskyPostRetryDelayMs(rateLimited(3600), now)).toBeUndefined();
  });

  test('a rate limit without a reset header is handed back to the queue', () => {
    expect(blueskyPostRetryDelayMs(new XRPCError(429), now)).toBeUndefined();
  });

  test('inline rate-limit waits share one budget per post', () => {
    expect(blueskyPostRetryDelayMs(rateLimited(40), now, BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS)).toBe(41_000);
    expect(blueskyPostRetryDelayMs(rateLimited(40), now, BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS - 41_000)).toBeUndefined();
  });

  test('a rejected request is not retried, but a server error is', () => {
    expect(blueskyPostRetryDelayMs(new XRPCError(400, 'InvalidRequest', 'Invalid record'), now)).toBeUndefined();
    expect(blueskyPostRetryDelayMs(new XRPCError(502, 'UpstreamFailure', 'Upstream failure'), now)).toBe(
      BSKY_POST_RETRY_DELAY_MS,
    );
  });
});
