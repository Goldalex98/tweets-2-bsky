import { describe, expect, test } from 'bun:test';
import { type PipelineRunMode, PipelineRunService } from '../../src/pipeline/run-service.js';

describe('shared pipeline run service', () => {
  test('live and backfill modes share normalize, policy, queue, and delivery', async () => {
    for (const mode of ['daemon', 'scheduled', 'run-once', 'backfill', 'pin-backfill'] satisfies PipelineRunMode[]) {
      const calls: string[] = [];
      const service = new PipelineRunService<number, string>({
        clock: { now: () => 42 },
        fetch: async () => {
          calls.push('fetch');
          return [1, 2];
        },
        normalize: (raw) => {
          calls.push(`normalize:${raw}`);
          return `post-${raw}`;
        },
        applyPolicy: (candidates) => {
          calls.push('policy');
          return {
            accepted: candidates.slice(0, 1),
            skipped: [{ candidate: candidates[1] as string, reason: 'test-policy' }],
          };
        },
        enqueue: async (candidates, request) => {
          calls.push(`enqueue:${request.requestedAt}:${candidates.join(',')}`);
          return { inserted: 1, queueIds: ['queue-1'] };
        },
        deliver: async (queueIds) => {
          calls.push(`deliver:${queueIds.join(',')}`);
          return 1;
        },
      });

      const result = await service.execute({
        mode,
        sourceId: 'source-1',
        destinationId: 'destination-1',
        routeId: 'route-1',
      });
      expect(calls).toEqual(['fetch', 'normalize:1', 'normalize:2', 'policy', 'enqueue:42:post-1', 'deliver:queue-1']);
      expect(result).toMatchObject({ dryRun: false, enqueued: 1, delivered: 1 });
    }
  });

  test('dry-run and preview never persist or deliver', async () => {
    for (const mode of ['dry-run', 'preview'] satisfies PipelineRunMode[]) {
      let mutations = 0;
      const service = new PipelineRunService<number, number>({
        clock: { now: () => 42 },
        fetch: async () => [1],
        normalize: (raw) => raw,
        applyPolicy: (accepted) => ({ accepted, skipped: [] }),
        enqueue: async () => {
          mutations += 1;
          return { inserted: 1, queueIds: ['forbidden'] };
        },
        deliver: async () => {
          mutations += 1;
          return 1;
        },
      });

      const result = await service.execute({
        mode,
        sourceId: 'source-1',
        destinationId: 'destination-1',
        routeId: 'route-1',
      });
      expect(mutations).toBe(0);
      expect(result).toMatchObject({ dryRun: true, enqueued: 0, delivered: 0 });
    }
  });
});
