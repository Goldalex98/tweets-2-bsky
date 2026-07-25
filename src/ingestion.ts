import type { AppConfig, Route } from './config/schemas.js';
import { contentSha256 } from './content-dedup.js';
import { evaluateContentPolicy } from './content-policy.js';
import {
  dbService,
  digestEntryService,
  duplicateFingerprintService,
  postQueueService,
} from './db.js';
import type { NormalizedPost } from './normalized-post.js';
import {
  createPolicySnapshot,
  POLICY_SNAPSHOT_VERSION,
  serializePolicySnapshot,
} from './policy-snapshot.js';
import { evaluateSourceFilter } from './source-filter.js';

export interface IngestionRouteTrace {
  routeId: string;
  destinationId: string;
  outcome: 'accepted' | 'skipped' | 'duplicate';
  deliveryMode: 'immediate' | 'digest';
  reason: string;
  decisionTrace?: unknown[];
}

export interface NormalizedIngestionResult {
  externalId: string;
  accepted: number;
  skipped: number;
  duplicates: number;
  routes: IngestionRouteTrace[];
}

function routeMode(route: Route): 'immediate' | 'digest' {
  return route.delivery?.mode === 'digest' && route.delivery.digest.enabled ? 'digest' : 'immediate';
}

export function routeNormalizedPost(
  config: AppConfig,
  post: NormalizedPost,
  requestId?: string,
): NormalizedIngestionResult {
  const source = config.sources.find(
    (candidate) => candidate.id === post.sourceId && candidate.type === post.sourceType,
  );
  if (!source || !source.enabled) throw new Error('Normalized post source is unknown or disabled.');
  const routes = config.routes.filter(
    (route) => route.sourceId === source.id && route.enabled && !route.relationship.sourcePaused,
  );
  const result: NormalizedIngestionResult = {
    externalId: post.externalId,
    accepted: 0,
    skipped: 0,
    duplicates: 0,
    routes: [],
  };
  for (const route of routes) {
    const destination = config.destinations.find(
      (candidate) => candidate.id === route.destinationId && candidate.enabled,
    );
    if (!destination) continue;
    const deliveryMode = routeMode(route);
    const sourceDecision = evaluateSourceFilter(route.filters, post, {
      sourceEnabled: source.enabled,
      expectedSourceUsername: post.sourceType === 'x' ? source.username : undefined,
    });
    if (!sourceDecision.allowed) {
      result.skipped += 1;
      result.routes.push({
        routeId: route.id,
        destinationId: destination.id,
        outcome: 'skipped',
        deliveryMode,
        reason: sourceDecision.reason,
      });
      continue;
    }
    const policyDecision = evaluateContentPolicy(destination, route, post);
    if (!policyDecision.allowed) {
      result.skipped += 1;
      result.routes.push({
        routeId: route.id,
        destinationId: destination.id,
        outcome: 'skipped',
        deliveryMode,
        reason: policyDecision.reason,
        decisionTrace: policyDecision.trace,
      });
      continue;
    }
    if (
      postQueueService.hasQueuedPost({
        sourceType: post.sourceType,
        sourceId: post.sourceId,
        externalPostId: post.externalId,
        destinationId: destination.id,
      }) ||
      dbService.getPostForSource(post.externalId, destination.id, post.sourceType, post.sourceId)
    ) {
      result.duplicates += 1;
      result.routes.push({
        routeId: route.id,
        destinationId: destination.id,
        outcome: 'duplicate',
        deliveryMode,
        reason: 'external-post-duplicate',
      });
      continue;
    }
    const duplicatePolicy = route.duplicateSuppression.enabled
      ? route.duplicateSuppression
      : destination.duplicateSuppression;
    const fingerprint = contentSha256(post.text, post.urls);
    // Reserving records the fingerprint in the same transaction that checks for
    // one, so accepted content is remembered and identical content that arrives
    // later is suppressed instead of being reprocessed forever.
    const reservation = duplicatePolicy.enabled
      ? duplicateFingerprintService.reserve({
          destinationId: destination.id,
          routeId: route.id,
          routeScoped: route.duplicateSuppression.enabled,
          externalPostId: post.externalId,
          textUrlHash: fingerprint,
          since: Date.now() - duplicatePolicy.windowHours * 60 * 60_000,
        })
      : { duplicate: null, fingerprintId: undefined };
    if (reservation.duplicate) {
      result.duplicates += 1;
      result.routes.push({
        routeId: route.id,
        destinationId: destination.id,
        outcome: 'duplicate',
        deliveryMode,
        reason: 'content-duplicate',
      });
      continue;
    }
    const snapshot = serializePolicySnapshot(
      createPolicySnapshot({ destination, route, ai: config.ai }),
    );
    const accepted =
      deliveryMode === 'digest'
        ? digestEntryService.enqueue({
            destinationId: destination.id,
            routeId: route.id,
            post,
            policySnapshot: snapshot,
          })
        : postQueueService.enqueue([
            {
              twitter_id:
                post.sourceType === 'x'
                  ? post.externalId
                  : `${post.sourceType}:${post.sourceId}:${post.externalId}`,
              bsky_identifier: destination.storageKey,
              mapping_id: destination.id,
              twitter_username: source.username,
              source_type: post.sourceType,
              external_post_id: post.externalId,
              destination_id: destination.id,
              route_id: route.id,
              source_id: source.id,
              source_created_at: Date.parse(post.createdAt),
              policy_version: POLICY_SNAPSHOT_VERSION,
              policy_snapshot: snapshot,
              decision_version: policyDecision.decisionVersion,
              decision_trace: JSON.stringify(policyDecision.trace),
              kind: 'scheduled',
              request_id: requestId,
              tweet_json: JSON.stringify(post),
              tweet_text: post.text.slice(0, 300),
            },
          ]) === 1;
    if (!accepted) {
      duplicateFingerprintService.release(reservation.fingerprintId);
      result.duplicates += 1;
      result.routes.push({
        routeId: route.id,
        destinationId: destination.id,
        outcome: 'duplicate',
        deliveryMode,
        reason: 'queue-duplicate',
      });
      continue;
    }
    result.accepted += 1;
    result.routes.push({
      routeId: route.id,
      destinationId: destination.id,
      outcome: 'accepted',
      deliveryMode,
      reason: deliveryMode === 'digest' ? 'digest-entry-created' : 'queued',
      decisionTrace: policyDecision.trace,
    });
  }
  return result;
}
