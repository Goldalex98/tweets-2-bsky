import { createHash } from 'node:crypto';
import type { QueueBatch } from '../db.js';
import { createGenericPostPlan, type StrongRef } from '../generic-delivery.js';
import {
  type NormalizedMediaDescriptor,
  type NormalizedPost,
  validateNormalizedPost,
} from '../normalized-post.js';

export interface NormalizedDeliveryCheckpoint {
  uri?: string;
  cid?: string;
  root?: StrongRef;
  parent?: StrongRef;
  tail?: StrongRef;
  completedAt?: number;
}

export interface NormalizedProcessedPost {
  bsky_uri?: string;
  bsky_cid?: string;
  bsky_root_uri?: string;
  bsky_root_cid?: string;
  bsky_tail_uri?: string;
  bsky_tail_cid?: string;
}

export interface NormalizedDeliveryAdapter {
  prepareText(text: string): Promise<{ text: string; facets?: unknown[] }>;
  downloadMedia(media: NormalizedMediaDescriptor): Promise<Buffer>;
  uploadImage(buffer: Buffer, mimeType: string): Promise<unknown>;
  uploadVideo(buffer: Buffer, sourceUrl: string): Promise<unknown>;
  publish(input: {
    destinationId: string;
    externalPostId: string;
    chunkIndex: number;
    record: Record<string, unknown>;
  }): Promise<StrongRef>;
}

export interface NormalizedDeliveryDependencies {
  clock: { now(): number };
  findProcessedReply(post: NormalizedPost, destinationId: string): NormalizedProcessedPost | null;
  checkpoints: {
    initialize(
      destinationId: string,
      externalPostId: string,
      chunks: Array<{ contentHash: string; createdAt: string }>,
    ): NormalizedDeliveryCheckpoint[];
    list(destinationId: string, externalPostId: string): NormalizedDeliveryCheckpoint[];
    recordSuccess(input: {
      destinationId: string;
      externalPostId: string;
      chunkIndex: number;
      uri: string;
      cid: string;
      root: StrongRef;
      parent?: StrongRef;
      tail: StrongRef;
    }): void;
    finalize(record: {
      twitter_id: string;
      twitter_username: string;
      bsky_identifier: string;
      source_type: string;
      external_post_id: string;
      destination_id: string;
      route_id?: string;
      source_id: string;
      source_created_at: number;
      posted_at: number;
      policy_version: number;
      policy_snapshot?: string;
      decision_version: number;
      decision_trace?: string;
      tweet_text: string;
      bsky_uri: string;
      bsky_cid: string;
      bsky_root_uri: string;
      bsky_root_cid: string;
      bsky_tail_uri: string;
      bsky_tail_cid: string;
      status: 'migrated';
    }, checkpointExternalPostId: string): void;
  };
}

const contentHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

function replyFor(post: NormalizedPost, destinationId: string, dependencies: NormalizedDeliveryDependencies) {
  if (!post.replyTo) return undefined;
  const parent = dependencies.findProcessedReply(post, destinationId);
  if (!parent?.bsky_uri || !parent.bsky_cid) return undefined;
  return {
    root:
      parent.bsky_root_uri && parent.bsky_root_cid
        ? { uri: parent.bsky_root_uri, cid: parent.bsky_root_cid }
        : { uri: parent.bsky_uri, cid: parent.bsky_cid },
    parent:
      parent.bsky_tail_uri && parent.bsky_tail_cid
        ? { uri: parent.bsky_tail_uri, cid: parent.bsky_tail_cid }
        : { uri: parent.bsky_uri, cid: parent.bsky_cid },
  };
}

/**
 * Delivers source-neutral normalized queue rows, including bounded media,
 * threading, deterministic chunk publication, and durable checkpoints.
 */
export class NormalizedDeliveryService {
  constructor(private readonly dependencies: NormalizedDeliveryDependencies) {}

  async deliver(adapter: NormalizedDeliveryAdapter, batch: QueueBatch): Promise<void> {
    for (const item of batch.items) {
      const post = validateNormalizedPost(JSON.parse(item.tweet_json));
      const plan = createGenericPostPlan(
        post,
        batch.destination_id,
        replyFor(post, batch.destination_id, this.dependencies),
      );
      let checkpoints = this.dependencies.checkpoints.initialize(
        batch.destination_id,
        item.twitter_id,
        plan.map((chunk) => ({
          contentHash: contentHash(chunk.text),
          createdAt: chunk.createdAt,
        })),
      );

      for (const chunk of plan) {
        const saved = checkpoints[chunk.index];
        if (saved?.completedAt && saved.uri && saved.cid) continue;
        const richText = await adapter.prepareText(chunk.text);
        const imageEmbeds: Array<{
          alt: string;
          image: unknown;
          aspectRatio?: { width: number; height: number };
        }> = [];
        let videoEmbed: Record<string, unknown> | undefined;
        for (const media of chunk.media) {
          const buffer = await adapter.downloadMedia(media);
          if (buffer.length < 1 || buffer.length > media.sizeBytes) {
            throw new Error('Normalized media exceeded its declared size.');
          }
          if (media.type === 'video') {
            if (videoEmbed || imageEmbeds.length > 0) {
              throw new Error('Bluesky delivery supports either one video or up to four images per post.');
            }
            videoEmbed = {
              $type: 'app.bsky.embed.video',
              video: await adapter.uploadVideo(buffer, media.url),
              alt: media.suppliedAlt ?? '',
              ...(media.width && media.height
                ? { aspectRatio: { width: media.width, height: media.height } }
                : {}),
            };
          } else {
            if (videoEmbed) throw new Error('Bluesky delivery cannot mix video and image embeds.');
            imageEmbeds.push({
              alt: media.suppliedAlt ?? '',
              image: await adapter.uploadImage(buffer, media.mimeType),
              ...(media.width && media.height
                ? { aspectRatio: { width: media.width, height: media.height } }
                : {}),
            });
          }
        }

        const prior = checkpoints[chunk.index - 1];
        const root =
          chunk.reply?.root ??
          prior?.root ??
          (checkpoints[0]?.uri && checkpoints[0]?.cid
            ? { uri: checkpoints[0].uri, cid: checkpoints[0].cid }
            : undefined);
        const parent =
          chunk.reply?.parent ??
          prior?.tail ??
          (prior?.uri && prior?.cid ? { uri: prior.uri, cid: prior.cid } : undefined);
        const response = await adapter.publish({
          destinationId: batch.destination_id,
          externalPostId: item.twitter_id,
          chunkIndex: chunk.index,
          record: {
            text: richText.text,
            facets: richText.facets,
            createdAt: chunk.createdAt,
            ...(videoEmbed
              ? { embed: videoEmbed }
              : imageEmbeds.length > 0
                ? {
                    embed: {
                      $type: 'app.bsky.embed.images',
                      images: imageEmbeds,
                    },
                  }
                : {}),
            ...(root && parent ? { reply: { root, parent } } : {}),
          },
        });
        this.dependencies.checkpoints.recordSuccess({
          destinationId: batch.destination_id,
          externalPostId: item.twitter_id,
          chunkIndex: chunk.index,
          uri: response.uri,
          cid: response.cid,
          root: root ?? response,
          parent,
          tail: response,
        });
        checkpoints = this.dependencies.checkpoints.list(batch.destination_id, item.twitter_id);
      }

      const first = checkpoints[0];
      const last = checkpoints[checkpoints.length - 1];
      if (!first?.uri || !first.cid || !last?.uri || !last.cid) {
        throw new Error('Normalized delivery checkpoint is incomplete.');
      }
      this.dependencies.checkpoints.finalize(
        {
          twitter_id: item.twitter_id,
          twitter_username: post.sourceId,
          bsky_identifier: batch.bsky_identifier,
          source_type: post.sourceType,
          external_post_id: post.externalId,
          destination_id: batch.destination_id,
          route_id: item.route_id,
          source_id: post.sourceId,
          source_created_at: Date.parse(post.createdAt),
          posted_at: this.dependencies.clock.now(),
          policy_version: item.policy_version,
          policy_snapshot: item.policy_snapshot,
          decision_version: item.decision_version,
          decision_trace: item.decision_trace,
          tweet_text: post.text,
          bsky_uri: first.uri,
          bsky_cid: first.cid,
          bsky_root_uri: first.root?.uri ?? first.uri,
          bsky_root_cid: first.root?.cid ?? first.cid,
          bsky_tail_uri: last.uri,
          bsky_tail_cid: last.cid,
          status: 'migrated',
        },
        item.twitter_id,
      );
    }
  }
}
