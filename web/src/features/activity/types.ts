import type { AccountMapping } from '../destinations/types';

export interface DeliveryFallbackEvent {
  kind: string;
  reason: string;
}

export interface ActivityLog {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  tweet_text?: string;
  bsky_uri?: string;
  status: 'migrated' | 'skipped' | 'failed';
  skip_reason?: string;
  error_category?: string;
  error_message?: string;
  policy_version?: number;
  policy_snapshot?: string;
  destination_id?: string;
  retained_until?: number;
  override_requeued_at?: number;
  attempts?: number;
  created_at?: string;
  delivery_diagnostics?: string;
}

export interface QueueItemView {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  destination_id: string;
  route_id?: string;
  source_id?: string;
  request_id?: string;
  status: 'pending' | 'processing' | 'failed';
  attempts: number;
  error_category?: string;
  error_message?: string;
  policy_version: number;
  policy_snapshot?: string;
  policyDifference?: {
    changed: boolean;
    savedHash?: string;
    currentHash?: string;
    fields: string[];
  };
  enqueued_at: number;
  first_failure_at?: number;
  last_failure_at?: number;
  tweet_text?: string;
  delivery_diagnostics?: string;
}

export interface BskyFacetFeatureLink {
  $type: 'app.bsky.richtext.facet#link';
  uri: string;
}

export interface BskyFacetFeatureMention {
  $type: 'app.bsky.richtext.facet#mention';
  did: string;
}

export interface BskyFacetFeatureTag {
  $type: 'app.bsky.richtext.facet#tag';
  tag: string;
}

export type BskyFacetFeature = BskyFacetFeatureLink | BskyFacetFeatureMention | BskyFacetFeatureTag;

export interface BskyFacet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: BskyFacetFeature[];
}

export interface EnrichedPostMedia {
  type: 'image' | 'video' | 'external';
  url?: string;
  thumb?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
}

export interface EnrichedPost {
  bskyUri: string;
  bskyCid?: string;
  bskyIdentifier: string;
  twitterId: string;
  twitterUsername: string;
  twitterUrl?: string;
  postUrl?: string;
  createdAt?: string;
  text: string;
  facets: BskyFacet[];
  author: {
    did?: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  stats: {
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    engagement: number;
  };
  media: EnrichedPostMedia[];
}

export interface LocalPostSearchResult {
  twitterId: string;
  twitterUsername: string;
  bskyIdentifier: string;
  tweetText?: string;
  bskyUri?: string;
  bskyCid?: string;
  createdAt?: string;
  postUrl?: string;
  twitterUrl?: string;
  score: number;
}

export type ResolveActivityMapping = (activity: ActivityLog) => AccountMapping | undefined;
