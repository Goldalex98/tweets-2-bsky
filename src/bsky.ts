import { createHash } from 'node:crypto';
import { BskyAgent } from '@atproto/api';
import { getConfig } from './config-manager.js';
import { blueskyAccountRuntimeService, runtimeStateService } from './db.js';
import { getCanonicalDestinationKey, normalizeBlueskyServiceUrl } from './mapping-helpers.js';

const activeAgents = new Map<string, BskyAgent>();

type AgentMappingIdentity = {
  bskyAccountId?: string;
  bskyIdentifier: string;
  bskyPassword?: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
};

function agentCacheKey(mapping: AgentMappingIdentity): string {
  const canonical = getCanonicalDestinationKey(mapping);
  const credentialFingerprint = createHash('sha256')
    .update(`${normalizeBlueskyServiceUrl(mapping.bskyServiceUrl)}\0${mapping.bskyPassword ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return `${canonical}#${credentialFingerprint}`;
}

function clearCachedAgentsForIdentity(mapping: AgentMappingIdentity): void {
  const prefix = `${getCanonicalDestinationKey(mapping)}#`;
  for (const key of activeAgents.keys()) {
    if (key.startsWith(prefix) || key === getCanonicalDestinationKey(mapping)) {
      activeAgents.delete(key);
    }
  }
}

export function clearCachedAgent(mapping: AgentMappingIdentity): void {
  clearCachedAgentsForIdentity(mapping);
  activeAgents.delete(agentCacheKey(mapping));
}

/**
 * Drops a cached agent whose session the PDS no longer accepts, so the next
 * call authenticates again. Without this a revoked or expired refresh token
 * leaves the destination permanently broken until the process restarts, since
 * `getAgent` keeps handing back the dead agent.
 */
export function invalidateCachedAgentOnAuthFailure(
  mapping: AgentMappingIdentity,
  errorCategory: string,
): boolean {
  if (errorCategory !== 'bsky-auth') return false;
  const before = activeAgents.size;
  clearCachedAgentsForIdentity(mapping);
  return activeAgents.size < before || activeAgents.delete(agentCacheKey(mapping));
}

export async function getAgent(mapping: {
  id?: string;
  bskyAccountId?: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
  bskyCanonicalHandle?: string;
}): Promise<BskyAgent | null> {
  const serviceUrl = mapping.bskyServiceUrl || 'https://bsky.social';
  const cacheKey = agentCacheKey(mapping);
  const existing = activeAgents.get(cacheKey);
  if (existing) return existing;

  const agent = new BskyAgent({ service: serviceUrl });
  try {
    await agent.login({ identifier: mapping.bskyIdentifier, password: mapping.bskyPassword });
    activeAgents.set(cacheKey, agent);
    if (mapping.id) runtimeStateService.recordDestinationEvent(mapping.id, 'login');
    if (mapping.bskyAccountId) blueskyAccountRuntimeService.recordSuccess(mapping.bskyAccountId, 'login');
    return agent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mapping.id) {
      runtimeStateService.recordDestinationFailure(mapping.id, 'login', message);
    }
    if (mapping.bskyAccountId) {
      blueskyAccountRuntimeService.recordFailure(mapping.bskyAccountId, 'bsky-auth', message);
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
  const repoDid = agent.session?.did;
  if (!repoDid) throw new Error('Bluesky session did is missing');

  let cursor: string | undefined;
  let deletedCount = 0;

  console.log(`[${mapping.bskyIdentifier}] 🗑️ Starting deletion of all posts...`);

  // Safety break to prevent infinite loops
  let loops = 0;
  while (loops < 1000) {
    loops++;
    try {
      const { data } = await agent.com.atproto.repo.listRecords({
        repo: repoDid,
        collection: 'app.bsky.feed.post',
        limit: 50, // Keep batch size reasonable
        cursor,
      });

      if (!data.records || data.records.length === 0) {
        break;
      }

      // Use p-limit like approach or just Promise.all since 50 is manageable
      const results = await Promise.all(
        data.records.map(async (r) => {
          const rkey = r.uri.split('/').pop();
          if (!rkey) {
            console.warn(`Failed to delete record ${r.uri}: missing rkey`);
            return false;
          }
          try {
            await agent.com.atproto.repo.deleteRecord({
              repo: repoDid,
              collection: 'app.bsky.feed.post',
              rkey,
            });
            return true;
          } catch (e) {
            console.warn(`Failed to delete record ${r.uri}:`, e);
            return false;
          }
        }),
      );

      deletedCount += results.filter(Boolean).length;
      cursor = data.cursor;
      if (!cursor) break;

      // Small delay to be nice to the API
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (e) {
      console.error(`[${mapping.bskyIdentifier}] Error listing records:`, e);
      throw e;
    }
  }

  console.log(`[${mapping.bskyIdentifier}] ✅ Deleted ${deletedCount} posts.`);
  return deletedCount;
}
