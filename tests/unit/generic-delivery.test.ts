import { expect, test } from 'bun:test';
import {
  createGenericPostPlan,
  deliverGenericPost,
} from '../../src/generic-delivery.js';
import type { NormalizedPost } from '../../src/normalized-post.js';

const post: NormalizedPost = {
  sourceType: 'api',
  sourceId: 'feed',
  externalId: 'post-1',
  text: `A link https://example.com and enough content to split. ${'word '.repeat(80)}`,
  createdAt: '2026-07-24T12:00:00.000Z',
  urls: ['https://example.com'],
  sensitive: false,
  media: [],
};

test('generic delivery creates deterministic facets, chunks, and idempotency keys', () => {
  const first = createGenericPostPlan(post, 'destination');
  const second = createGenericPostPlan(post, 'destination');
  expect(first).toEqual(second);
  expect(first.length).toBeGreaterThan(1);
  expect(first[0]?.facets[0]?.features[0]?.uri).toBe('https://example.com');
  expect(first[1]?.facets).toEqual([]);
});

test('generic delivery resumes after completed chunks and threads remaining chunks', async () => {
  const plan = createGenericPostPlan(post, 'destination');
  const calls: Array<Record<string, unknown>> = [];
  const completed = [{ uri: 'at://root', cid: 'root-cid' }];
  const result = await deliverGenericPost(
    {
      createPost: async (chunk, context) => {
        calls.push({ chunk, context });
        return { uri: `at://chunk-${chunk.index}`, cid: `cid-${chunk.index}` };
      },
    },
    plan,
    completed,
  );
  expect(calls).toHaveLength(plan.length - 1);
  expect((calls[0]?.chunk as { reply?: { root: { uri: string } } }).reply?.root.uri).toBe('at://root');
  expect(result).toHaveLength(plan.length);
});
