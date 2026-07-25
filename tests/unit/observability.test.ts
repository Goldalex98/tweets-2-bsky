import { describe, expect, test } from 'bun:test';
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
});
