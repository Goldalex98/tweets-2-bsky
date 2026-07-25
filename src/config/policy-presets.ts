import {
  DEFAULT_DUPLICATE_SUPPRESSION,
  DEFAULT_MODERATION_POLICY,
  DEFAULT_ROUTE_DELIVERY,
  DEFAULT_ROUTING_POLICY,
  createDefaultMappingPolicies,
} from './defaults.js';
import type { DestinationAIOverrides, PostingPolicy, ProfileManagementPolicy, RouteDeliveryPolicy } from './schemas.js';

export type PolicyPresetId = 'one-to-one' | 'aggregate-feed' | 'daily-digest';

export interface PolicyPresetDefinition {
  id: PolicyPresetId;
  name: string;
  description: string;
  requiresDigestConfirmation?: boolean;
}

export const POLICY_PRESET_DEFINITIONS: readonly PolicyPresetDefinition[] = [
  {
    id: 'one-to-one',
    name: 'Standard one-to-one mirror',
    description: 'No source attribution, mutations off, dedup off.',
  },
  {
    id: 'aggregate-feed',
    name: 'Aggregate feed',
    description: 'Source attribution for multi-source destinations, duplicate suppression on.',
  },
  {
    id: 'daily-digest',
    name: 'Daily digest',
    description: 'Digest delivery with source attribution. Confirm timezone and publish hour.',
    requiresDigestConfirmation: true,
  },
];

export interface AppliedPolicyPreset {
  postingPolicy: PostingPolicy;
  profileManagement: ProfileManagementPolicy;
  aiOverrides: DestinationAIOverrides;
  moderationPolicy: typeof DEFAULT_MODERATION_POLICY;
  duplicateSuppression: typeof DEFAULT_DUPLICATE_SUPPRESSION;
  routingPolicy: typeof DEFAULT_ROUTING_POLICY;
  delivery: RouteDeliveryPolicy;
}

export function applyPolicyPreset(
  presetId: PolicyPresetId,
  options: { sourceCount: number; timezone?: string; hour?: number } = { sourceCount: 1 },
): AppliedPolicyPreset {
  const defaults = createDefaultMappingPolicies(options.sourceCount);
  if (presetId === 'one-to-one') {
    return {
      ...defaults,
      postingPolicy: {
        ...defaults.postingPolicy,
        attribution: { ...defaults.postingPolicy.attribution, mode: 'never' },
      },
      duplicateSuppression: { ...DEFAULT_DUPLICATE_SUPPRESSION, enabled: false },
      routingPolicy: { ...DEFAULT_ROUTING_POLICY },
      delivery: { ...DEFAULT_ROUTE_DELIVERY, digest: { ...DEFAULT_ROUTE_DELIVERY.digest } },
    };
  }
  if (presetId === 'aggregate-feed') {
    return {
      ...defaults,
      postingPolicy: {
        ...defaults.postingPolicy,
        attribution: { ...defaults.postingPolicy.attribution, mode: 'multiple-sources' },
      },
      duplicateSuppression: { ...DEFAULT_DUPLICATE_SUPPRESSION, enabled: true, windowHours: 24 },
      moderationPolicy: { ...DEFAULT_MODERATION_POLICY, dryRun: true },
      routingPolicy: { ...DEFAULT_ROUTING_POLICY },
      delivery: { ...DEFAULT_ROUTE_DELIVERY, digest: { ...DEFAULT_ROUTE_DELIVERY.digest } },
    };
  }
  return {
    ...defaults,
    postingPolicy: {
      ...defaults.postingPolicy,
      attribution: { ...defaults.postingPolicy.attribution, mode: 'multiple-sources' },
    },
    duplicateSuppression: { ...DEFAULT_DUPLICATE_SUPPRESSION, enabled: true },
    routingPolicy: { ...DEFAULT_ROUTING_POLICY },
    delivery: {
      mode: 'digest',
      digest: {
        ...DEFAULT_ROUTE_DELIVERY.digest,
        enabled: true,
        cadence: 'daily',
        timezone: options.timezone || 'UTC',
        hour: options.hour ?? 9,
        minute: 0,
        includeSourceAttribution: true,
      },
    },
  };
}

export function listPolicyPresets(): readonly PolicyPresetDefinition[] {
  return POLICY_PRESET_DEFINITIONS;
}
