import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MODERATION_POLICY,
  DEFAULT_ROUTING_POLICY,
} from '../../src/config/defaults.js';
import {
  contentPolicyMetadataForPost,
  evaluateContentPolicy,
} from '../../src/content-policy.js';
import type { NormalizedPost } from '../../src/normalized-post.js';

function samplePost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    sourceType: 'x',
    sourceId: 'source_abc123deadbeef',
    externalId: '123',
    text: 'hello',
    createdAt: '2026-07-24T12:00:00.000Z',
    urls: [],
    sensitive: false,
    author: { username: 'mirrored_user' },
    media: [],
    ...overrides,
  };
}

describe('traceable routing and moderation', () => {
  test('returns deterministic first-match routing trace', () => {
    const decision = evaluateContentPolicy(
      { moderationPolicy: DEFAULT_MODERATION_POLICY },
      {
        routingPolicy: {
          ...DEFAULT_ROUTING_POLICY,
          excludeDomains: ['blocked.example'],
        },
        moderationPolicy: DEFAULT_MODERATION_POLICY,
      },
      { text: 'Read https://blocked.example/article', contentType: 'original', mediaTypes: ['none'] },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('routing-excluded-domain');
    expect(decision.trace.map((entry) => entry.predicate)).toEqual([
      'exclude-keywords',
      'exclude-domains',
    ]);
  });

  test('keeps destination and route moderation independently visible', () => {
    const decision = evaluateContentPolicy(
      {
        moderationPolicy: {
          ...DEFAULT_MODERATION_POLICY,
          blockKeywords: ['spoiler'],
        },
      },
      {
        routingPolicy: DEFAULT_ROUTING_POLICY,
        moderationPolicy: DEFAULT_MODERATION_POLICY,
      },
      { text: 'A spoiler appears', sourceUsername: 'source' },
    );
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'moderation-blocked-keyword',
      detail: 'spoiler',
      decisionVersion: 1,
    });
  });

  test('records moderation matches without blocking in dry-run mode', () => {
    const decision = evaluateContentPolicy(
      {
        moderationPolicy: {
          ...DEFAULT_MODERATION_POLICY,
          blockKeywords: ['spoiler'],
          dryRun: true,
        },
      },
      { routingPolicy: DEFAULT_ROUTING_POLICY, moderationPolicy: DEFAULT_MODERATION_POLICY },
      { text: 'A spoiler appears', sourceUsername: 'source' },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.trace.find((entry) => entry.predicate === 'block-keyword')).toMatchObject({
      matched: true,
      detail: 'spoiler (dry-run)',
    });
  });

  test('maps NormalizedPost sourceUsername from author handle, not source id', () => {
    const metadata = contentPolicyMetadataForPost(samplePost());
    expect(metadata.sourceUsername).toBe('mirrored_user');
    expect(metadata.sourceUsername).not.toBe('source_abc123deadbeef');
  });

  test('blocks NormalizedPost when author username is in blockSourceUsernames', () => {
    const decision = evaluateContentPolicy(
      {
        moderationPolicy: {
          ...DEFAULT_MODERATION_POLICY,
          blockSourceUsernames: ['mirrored_user'],
        },
      },
      { routingPolicy: DEFAULT_ROUTING_POLICY, moderationPolicy: DEFAULT_MODERATION_POLICY },
      samplePost(),
    );
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'moderation-blocked-source',
      detail: 'mirrored_user',
    });
  });

  test('does not treat canonical source id as a blocked username', () => {
    const decision = evaluateContentPolicy(
      {
        moderationPolicy: {
          ...DEFAULT_MODERATION_POLICY,
          blockSourceUsernames: ['source_abc123deadbeef'],
        },
      },
      { routingPolicy: DEFAULT_ROUTING_POLICY, moderationPolicy: DEFAULT_MODERATION_POLICY },
      samplePost(),
    );
    expect(decision.allowed).toBe(true);
  });
});
