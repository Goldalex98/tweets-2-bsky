/**
 * Canonical dashboard view contracts. First-party UI should prefer these names.
 * AccountMapping remains a compatibility projection returned by /api/destinations
 * and /api/mappings during the deprecation window.
 */
import type {
  DestinationView,
  ModerationPolicy,
  DuplicateSuppressionPolicy,
  RoutingPolicy,
  RouteDeliveryPolicy,
  SourceFilterPolicy,
  SourceRuntimeState,
  SourceSchedulePolicy,
} from './types';
import type { BlueskyAccountView } from '../bluesky-accounts/types';

export type { BlueskyAccountView, DestinationView };

export interface SourceView {
  username: string;
  routeId?: string;
  state: 'enabled' | 'paused';
  filters?: SourceFilterPolicy;
  routingPolicy?: RoutingPolicy;
  moderationPolicy?: ModerationPolicy;
  duplicateSuppression?: DuplicateSuppressionPolicy;
  delivery?: RouteDeliveryPolicy;
  schedule?: SourceSchedulePolicy;
  runtime?: SourceRuntimeState | null;
}

export function toSourceViews(destination: DestinationView): SourceView[] {
  return (
    destination.sources ??
    destination.twitterUsernames.map((username) => ({
      username,
      state: destination.pausedTwitterUsernames?.includes(username)
        ? ('paused' as const)
        : ('enabled' as const),
    }))
  );
}
