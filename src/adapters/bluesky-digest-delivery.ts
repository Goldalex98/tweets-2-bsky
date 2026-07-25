import { type BskyAgent, RichText } from '@atproto/api';
import type { AccountMapping } from '../config-manager.js';
import type {
  DigestDeliveryAdapter,
  DigestDeliverySession,
} from '../services/digest-worker-service.js';

export interface BlueskyDigestDeliveryDependencies {
  getAgent(mapping: AccountMapping): Promise<BskyAgent | null>;
  publish(
    agent: BskyAgent,
    mapping: AccountMapping,
    input: Parameters<DigestDeliverySession['publish']>[0] & {
      record: Record<string, unknown>;
    },
  ): Promise<{ uri: string; cid: string }>;
}

export function createBlueskyDigestDeliveryAdapter(
  dependencies: BlueskyDigestDeliveryDependencies,
): DigestDeliveryAdapter<AccountMapping> {
  return {
    createSession: async (mapping) => {
      const agent = await dependencies.getAgent(mapping);
      if (!agent) return null;
      return {
        publish: async (input) => {
          const richText = new RichText({ text: input.chunk.text });
          await richText.detectFacets(agent);
          return dependencies.publish(agent, mapping, {
            ...input,
            record: {
              text: richText.text,
              facets: richText.facets,
              createdAt: input.createdAt,
              ...(input.reply ? { reply: input.reply } : {}),
            },
          });
        },
      };
    },
  };
}
