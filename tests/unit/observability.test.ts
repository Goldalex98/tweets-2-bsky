import { describe, expect, test } from 'bun:test';
import { XRPCError } from '@atproto/api';
import { ApiError } from '@the-convocation/twitter-scraper';
import {
  classifyQueueError,
  createStructuredLogger,
  sanitizeForDiagnostics,
} from '../../src/observability.js';

describe('operations logging', () => {
  test('recursively redacts secret keys, headers, cookies, JWTs, and nested errors', () => {
    const error = new Error('Bearer abc.def.ghi auth_token=secret-cookie');
    (error as Error & { cause?: unknown }).cause = {
      password: 'hunter2',
      nested: { webhookSecret: 'signing-value', safe: 'visible' },
    };
    const sanitized = sanitizeForDiagnostics({
      authorization: 'Bearer top-secret',
      apiKey: 'secret-key',
      cookie: 'auth_token=cookie-value',
      error,
    });
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain('top-secret');
    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('cookie-value');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('signing-value');
    expect(text).toContain('visible');
    expect(text).toContain('[REDACTED]');
  });

  test('redacts camelCase appPassword and bskyPassword keys', () => {
    const sanitized = sanitizeForDiagnostics({
      appPassword: 'xxxx-xxxx-xxxx-xxxx',
      bskyPassword: 'legacy-inline-secret',
      loginIdentifier: 'mirror.example',
    });
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain('xxxx-xxxx-xxxx-xxxx');
    expect(text).not.toContain('legacy-inline-secret');
    expect(text).toContain('mirror.example');
    expect(text).toContain('[REDACTED]');
  });

  test('emits JSON with one correlation id and sanitized data', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger(
      { correlationId: 'sweep-1', sourceId: 'source-1' },
      {
        json: true,
        clock: { now: () => 0 },
        sink: {
          debug: (line) => lines.push(String(line)),
          info: (line) => lines.push(String(line)),
          warn: (line) => lines.push(String(line)),
          error: (line) => lines.push(String(line)),
        },
      },
    );
    logger.child({ destinationId: 'destination-1' }).info('queued', { password: 'nope' });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      correlationId: 'sweep-1',
      sourceId: 'source-1',
      destinationId: 'destination-1',
      data: { password: '[REDACTED]' },
    });
  });

  test('normalizes common delivery failures', () => {
    expect(classifyQueueError(new Error('Bluesky login failed with 401'))).toBe('bsky-auth');
    expect(classifyQueueError(new Error('Twitter rate limit 429'))).toBe('twitter-rate-limit');
    expect(classifyQueueError(new Error('image upload failed'))).toBe('media-upload');
    expect(classifyQueueError(new Error('request timed out'))).toBe('timeout');
  });

  test('classifies real atproto errors by status and error code', () => {
    // Real XRPCError messages never mention Bluesky, atproto, or a PDS.
    expect(classifyQueueError(new XRPCError(400, 'ExpiredToken', 'Token has expired'))).toBe('bsky-auth');
    expect(classifyQueueError(new XRPCError(400, 'InvalidToken', 'Token could not be verified'))).toBe('bsky-auth');
    expect(classifyQueueError(new XRPCError(401, 'AuthenticationRequired', 'Invalid identifier or password'))).toBe(
      'bsky-auth',
    );
    expect(classifyQueueError(new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded'))).toBe('bsky-rate-limit');
    expect(classifyQueueError(new XRPCError(429))).toBe('bsky-rate-limit');
    expect(classifyQueueError(new XRPCError(400, 'BlobTooLarge', 'blob is too large'))).toBe('media-upload');
  });

  test('classifies real scraper errors by HTTP status', () => {
    const scraperError = (status: number) => new ApiError(new Response('{}', { status }), { errors: [] });
    expect(classifyQueueError(scraperError(401))).toBe('twitter-auth');
    expect(classifyQueueError(scraperError(403))).toBe('twitter-auth');
    expect(classifyQueueError(scraperError(429))).toBe('twitter-rate-limit');
    expect(classifyQueueError(scraperError(500))).toBe('twitter-fetch');
  });

  test('an X fetch context classifies generic auth and rate failures as X', () => {
    expect(classifyQueueError(Object.assign(new Error('Forbidden'), { status: 403 }), 'twitter')).toBe('twitter-auth');
    expect(classifyQueueError(new Error('Too Many Requests'), 'twitter')).toBe('twitter-rate-limit');
    expect(classifyQueueError(new Error('socket hang up'), 'twitter')).toBe('twitter-fetch');
    expect(classifyQueueError(new Error('Sweep fetch timed out after 90s'), 'twitter')).toBe('timeout');
  });
});
