import { createHash } from 'node:crypto';
import type { NormalizedMediaDescriptor, NormalizedPost } from './normalized-post.js';
import { facetsForFirstChunk, type LinkFacet, splitPostText } from './post-transform.js';

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface GenericPostChunk {
  index: number;
  text: string;
  facets: LinkFacet[];
  createdAt: string;
  idempotencyKey: string;
  reply?: { root: StrongRef; parent: StrongRef };
  media: NormalizedMediaDescriptor[];
}

function byteOffset(text: string, utf16Offset: number): number {
  return Buffer.byteLength(text.slice(0, utf16Offset), 'utf8');
}

export function linkFacetsForNormalizedPost(post: NormalizedPost): LinkFacet[] {
  const facets: LinkFacet[] = [];
  const seen = new Set<string>();
  for (const url of post.urls) {
    if (seen.has(url)) continue;
    const index = post.text.indexOf(url);
    if (index < 0) continue;
    seen.add(url);
    facets.push({
      index: {
        byteStart: byteOffset(post.text, index),
        byteEnd: byteOffset(post.text, index + url.length),
      },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
  }
  return facets;
}

export function createGenericPostPlan(
  post: NormalizedPost,
  destinationId: string,
  reply?: { root: StrongRef; parent: StrongRef },
): GenericPostChunk[] {
  const chunks = splitPostText(post.text, 300);
  const facets = linkFacetsForNormalizedPost(post);
  const parent = reply?.parent;
  const root = reply?.root;
  return chunks.map((text, index) => {
    const contentHash = createHash('sha256').update(text).digest('hex');
    const chunk: GenericPostChunk = {
      index,
      text,
      facets: facetsForFirstChunk(facets, text, index),
      createdAt: post.createdAt,
      idempotencyKey: createHash('sha256')
        .update(`${destinationId}\0${post.sourceType}\0${post.sourceId}\0${post.externalId}\0${index}\0${contentHash}`)
        .digest('hex'),
      media: index === 0 ? post.media : [],
    };
    if (root && parent) chunk.reply = { root, parent };
    // Parent refs after chunk zero are filled by the delivery result.
    return chunk;
  });
}

export interface GenericDeliveryClient {
  createPost(
    chunk: GenericPostChunk,
    context: { previous?: StrongRef },
  ): Promise<StrongRef>;
}

export async function deliverGenericPost(
  client: GenericDeliveryClient,
  plan: readonly GenericPostChunk[],
  completed: readonly StrongRef[] = [],
  onCheckpoint?: (index: number, result: StrongRef) => void | Promise<void>,
): Promise<StrongRef[]> {
  const results = [...completed];
  let previous = results[results.length - 1];
  for (let index = results.length; index < plan.length; index += 1) {
    const source = plan[index];
    if (!source) continue;
    const chunk: GenericPostChunk =
      previous && index > 0
        ? {
            ...source,
            reply: {
              root: results[0] ?? previous,
              parent: previous,
            },
          }
        : source;
    const result = await client.createPost(chunk, { previous });
    results.push(result);
    previous = result;
    await onCheckpoint?.(index, result);
  }
  return results;
}
