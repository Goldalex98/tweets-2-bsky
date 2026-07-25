import { createHash } from 'node:crypto';
import type { AIConfig, Route } from '../config/schemas.js';
import type { PolicySnapshotDocument } from '../policy-snapshot.js';

/**
 * What the accepted route policy permits at delivery time. Legacy delivery
 * hardcoded "skip reposts" and "skip external replies", which silently
 * overrode routes that had explicitly enabled them.
 */
export interface DeliveryPolicy {
  allowReposts: boolean;
  allowExternalReplies: boolean;
}

export const LEGACY_DELIVERY_POLICY: DeliveryPolicy = {
  allowReposts: false,
  allowExternalReplies: false,
};

/**
 * Resolves what delivery may post. The snapshot wins when it carries filters,
 * so a queued item keeps the policy it was accepted under; snapshots taken
 * before filters were captured fall back to the route's current filters.
 */
export function resolveDeliveryPolicy(input: {
  snapshot?: Pick<PolicySnapshotDocument, 'filters'>;
  routeFilters?: Route['filters'];
}): DeliveryPolicy {
  const accepted = input.snapshot?.filters ?? input.routeFilters;
  return {
    allowReposts: accepted?.reposts === true,
    allowExternalReplies: accepted?.externalReplies === true,
  };
}

/**
 * Restores the credential that snapshots deliberately omit. Snapshots must
 * never persist an API key, but a delivery running from a snapshot still needs
 * one or it silently loses AI alt-text generation.
 */
export function mergeSnapshotAiCredentials(
  snapshotAi: Omit<AIConfig, 'apiKey'> | AIConfig | undefined,
  currentAi: AIConfig,
): AIConfig {
  if (!snapshotAi) return currentAi;
  const { overrides: _overrides, ...rest } = snapshotAi as AIConfig & { overrides?: unknown };
  return { ...(rest as AIConfig), apiKey: currentAi.apiKey };
}

const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * True when a record already in the repo is the one this call was about to
 * create. rkeys are derived from (destination, post, chunk), so a collision
 * normally means "already delivered" — but a truncated-hash collision or a
 * reused external id would otherwise make us adopt an unrelated post as ours
 * and record it as a successful delivery.
 */
export function recoveredRecordMatches(existing: unknown, intended: Record<string, unknown>): boolean {
  if (!existing || typeof existing !== 'object') return false;
  const existingText = (existing as { text?: unknown }).text;
  const intendedText = intended.text;
  if (typeof intendedText !== 'string' || typeof existingText !== 'string') return false;
  return contentHash(existingText) === contentHash(intendedText);
}
