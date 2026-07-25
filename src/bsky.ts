import { BskyAgent } from '@atproto/api';
import { getConfig } from './config-manager.js';
import { getCanonicalDestinationKey } from './mapping-helpers.js';
import { runtimeStateService } from './db.js';

const activeAgents = new Map<string, BskyAgent>();

export function clearCachedAgent(mapping: {
  bskyIdentifier: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
}): void {
  activeAgents.delete(getCanonicalDestinationKey(mapping));
}

/**
 * Drops a cached agent whose session the PDS no longer accepts, so the next
 * call authenticates again. Without this a revoked or expired refresh token
 * leaves the destination permanently broken until the process restarts, since
 * `getAgent` keeps handing back the dead agent.
 */
export function invalidateCachedAgentOnAuthFailure(
  mapping: { bskyIdentifier: string; bskyServiceUrl?: string; bskyDid?: string; bskyCanonicalHandle?: string },
  errorCategory: string,
): boolean {
  if (errorCategory !== 'bsky-auth') return false;
  const cacheKey = getCanonicalDestinationKey(mapping);
  return activeAgents.delete(cacheKey);
}

export async function getAgent(mapping: {
  id?: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
}): Promise<BskyAgent | null> {
  const serviceUrl = mapping.bskyServiceUrl || 'https://bsky.social';
  const cacheKey = getCanonicalDestinationKey(mapping);
  const existing = activeAgents.get(cacheKey);
  if (existing) return existing;

  const agent = new BskyAgent({ service: serviceUrl });
  try {
    await agent.login({ identifier: mapping.bskyIdentifier, password: mapping.bskyPassword });
    activeAgents.set(cacheKey, agent);
    if (mapping.id) runtimeStateService.recordDestinationEvent(mapping.id, 'login');
    return agent;
  } catch (err) {
    if (mapping.id) {
      runtimeStateService.recordDestinationFailure(
        mapping.id,
        'login',
        err instanceof Error ? err.message : String(err),
      );
    }
    console.error(`Failed to login to Bluesky for ${mapping.bskyIdentifier} on ${serviceUrl}:`, err);
    return null;
  }
}

export async function deleteAllPosts(mappingId: string): Promise<number> {
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === mappingId);
  if (!mapping) throw new Error('Mapping not found');

  const agent = await getAgent(mapping);
  if (!agent) throw new Error('Failed to authenticate with Bluesky');

  let cursor: string | undefined;
  let deletedCount = 0;

  console.log(`[${mapping.bskyIdentifier}] 🗑️ Starting deletion of all posts...`);

  // Safety loop limit to prevent infinite loops
  let loops = 0;
  while (loops < 1000) {
    loops++;
    try {
      const { data } = await agent.com.atproto.repo.listRecords({
        repo: agent.session!.did,
        collection: 'app.bsky.feed.post',
        limit: 50, // Keep batch size reasonable
        cursor,
      });

      if (data.records.length === 0) break;

      console.log(`[${mapping.bskyIdentifier}] 🗑️ Deleting batch of ${data.records.length} posts...`);

      // Use p-limit like approach or just Promise.all since 50 is manageable
      await Promise.all(
        data.records.map((r) =>
          agent.com.atproto.repo
            .deleteRecord({
              repo: agent.session!.did,
              collection: 'app.bsky.feed.post',
              rkey: r.uri.split('/').pop()!,
            })
            .catch((e) => console.warn(`Failed to delete record ${r.uri}:`, e)),
        ),
      );

      deletedCount += data.records.length;
      cursor = data.cursor;

      if (!cursor) break;

      // Small delay to be nice to the server
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[${mapping.bskyIdentifier}] ❌ Error during deletion loop:`, err);
      throw err;
    }
  }

  console.log(`[${mapping.bskyIdentifier}] ✅ Deleted ${deletedCount} posts.`);
  return deletedCount;
}
