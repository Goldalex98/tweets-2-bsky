import { describe, expect, test } from 'bun:test';
import {
  createRetainedCandidate,
  parseRetainedCandidate,
  RETAINED_CANDIDATE_MAX_BYTES,
  serializeRetainedCandidate,
} from '../../src/retained-candidate.js';

describe('retained policy candidates', () => {
  test('bounds payloads, removes secret-shaped fields, and expires records', () => {
    const candidate = createRetainedCandidate({
      externalPostId: 'tweet-1',
      now: 1000,
      ttlMs: 60_000,
      maxBytes: 1000,
      metadata: {
        text: 'candidate text',
        sourceUsername: 'source',
        language: 'en',
        contentType: 'original',
        mediaTypes: ['image'],
      },
      mediaUrls: ['https://pbs.twimg.com/media/example.jpg'],
      sourcePayload: {
        id_str: 'tweet-1',
        full_text: 'candidate text',
        apiKey: 'must-not-survive',
        nested: { authorization: 'must-not-survive', safe: 'yes' },
        huge: 'x'.repeat(RETAINED_CANDIDATE_MAX_BYTES),
      },
    });
    const serialized = serializeRetainedCandidate(candidate);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(RETAINED_CANDIDATE_MAX_BYTES);
    expect(serialized).not.toContain('must-not-survive');
    expect(candidate.degraded).toBe(true);
    expect(parseRetainedCandidate(serialized, 1001)?.normalized.externalPostId).toBe('tweet-1');
    expect(parseRetainedCandidate(serialized, 61_001)).toBeUndefined();
  });
});
