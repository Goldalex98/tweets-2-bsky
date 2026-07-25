import { describe, expect, test } from 'bun:test';
import type { QueueBatch, QueueItem } from '../../src/db.js';
import {
  type NormalizedDeliveryCheckpoint,
  NormalizedDeliveryService,
} from '../../src/services/normalized-delivery-service.js';

function queueItem(): QueueItem {
  return {
    twitter_id: 'external',
    bsky_identifier: 'destination.test',
    mapping_id: 'destination',
    twitter_username: 'source',
    source_type: 'webhook',
    external_post_id: 'external',
    destination_id: 'destination',
    source_id: 'source',
    policy_version: 1,
    decision_version: 1,
    kind: 'scheduled',
    tweet_json: JSON.stringify({
      sourceType: 'webhook',
      sourceId: 'source',
      externalId: 'external',
      text: `${'a'.repeat(305)} end`,
      createdAt: new Date(1_000).toISOString(),
      urls: [],
      media: [],
    }),
    status: 'processing',
    attempts: 0,
    not_before: 0,
    enqueued_at: 1,
    updated_at: 1,
  };
}

describe('NormalizedDeliveryService', () => {
  test('resumes incomplete chunks and finalizes the checkpointed thread', async () => {
    const events: string[] = [];
    let checkpoints: NormalizedDeliveryCheckpoint[] = [
      {
        uri: 'at://first',
        cid: 'first',
        root: { uri: 'at://first', cid: 'first' },
        tail: { uri: 'at://first', cid: 'first' },
        completedAt: 1,
      },
      {},
    ];
    const service = new NormalizedDeliveryService({
      clock: { now: () => 5_000 },
      findProcessedReply: () => null,
      checkpoints: {
        initialize: () => checkpoints,
        list: () => checkpoints,
        recordSuccess: (input) => {
          events.push(`checkpoint:${input.chunkIndex}:${input.parent?.uri}`);
          checkpoints = [
            checkpoints[0] ?? {},
            {
              uri: input.uri,
              cid: input.cid,
              root: input.root,
              parent: input.parent,
              tail: input.tail,
              completedAt: 2,
            },
          ];
        },
        finalize: (record) => events.push(`finalize:${record.bsky_tail_uri}:${record.posted_at}`),
      },
    });
    const batch: QueueBatch = {
      mapping_id: 'destination',
      bsky_identifier: 'destination.test',
      destination_id: 'destination',
      destination_key: 'destination',
      twitter_username: 'source',
      items: [queueItem()],
    };

    await service.deliver(
      {
        prepareText: async (text) => ({ text }),
        downloadMedia: async () => Buffer.from('unused'),
        uploadImage: async () => ({}),
        uploadVideo: async () => ({}),
        publish: async ({ chunkIndex, record }) => {
          events.push(`publish:${chunkIndex}:${(record.reply as { parent?: { uri: string } })?.parent?.uri}`);
          return { uri: 'at://second', cid: 'second' };
        },
      },
      batch,
    );

    expect(events).not.toContain('publish:0:undefined');
    expect(events).toContain('publish:1:at://first');
    expect(events).toContain('checkpoint:1:at://first');
    expect(events).toContain('finalize:at://second:5000');
  });
});
