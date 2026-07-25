import { type BskyAgent, RichText } from '@atproto/api';
import type { NormalizedDeliveryAdapter } from '../services/normalized-delivery-service.js';
import { resolveWebhookTarget, sendPinnedHttpsRequest } from '../webhook.js';

export interface BlueskyNormalizedDeliveryDependencies {
  agent: BskyAgent;
  uploadImage(buffer: Buffer, mimeType: string): Promise<unknown>;
  uploadVideo(buffer: Buffer, filename: string): Promise<unknown>;
  publish(input: {
    destinationId: string;
    externalPostId: string;
    chunkIndex: number;
    record: Record<string, unknown>;
  }): Promise<{ uri: string; cid: string }>;
}

/**
 * Network adapter for normalized Bluesky delivery. The service owns delivery
 * policy and checkpoints; this adapter owns RichText and bounded media I/O.
 */
export function createBlueskyNormalizedDeliveryAdapter(
  dependencies: BlueskyNormalizedDeliveryDependencies,
): NormalizedDeliveryAdapter {
  return {
    prepareText: async (text) => {
      const richText = new RichText({ text });
      await richText.detectFacets(dependencies.agent);
      return { text: richText.text, facets: richText.facets };
    },
    downloadMedia: async (media) => {
      const resolved = await resolveWebhookTarget(media.url, false);
      const response = await sendPinnedHttpsRequest({
        target: resolved.target,
        ...(resolved.pinnedAddress ? { pinnedAddress: resolved.pinnedAddress } : {}),
        ...(resolved.family ? { family: resolved.family } : {}),
        method: 'GET',
        headers: { 'user-agent': 'tweets-2-bsky-media/1' },
        timeoutMs: 30_000,
        maxResponseBytes: media.sizeBytes,
      });
      if (response.status !== 200) {
        throw new Error(`Normalized media request returned HTTP ${response.status}.`);
      }
      const contentType = String(response.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== media.mimeType) {
        throw new Error('Normalized media Content-Type did not match its descriptor.');
      }
      return response.body;
    },
    uploadImage: dependencies.uploadImage,
    uploadVideo: (buffer, sourceUrl) =>
      dependencies.uploadVideo(
        buffer,
        new URL(sourceUrl).pathname.split('/').pop() || 'video.mp4',
      ),
    publish: dependencies.publish,
  };
}
