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

export interface RouteView {
  id: string;
  username: string;
  destinationId: string;
  state: 'enabled' | 'paused';
  delivery?: RouteDeliveryPolicy;
  routingPolicy?: RoutingPolicy;
  moderationPolicy?: ModerationPolicy;
  duplicateSuppression?: DuplicateSuppressionPolicy;
}

/** @deprecated Prefer DestinationView. Compatibility alias during AccountMapping retirement. */
export type { AccountMapping as LegacyAccountMapping } from './types';

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

export function toRouteViews(destination: DestinationView): RouteView[] {
  return toSourceViews(destination)
    .filter((source): source is SourceView & { routeId: string } => Boolean(source.routeId))
    .map((source) => ({
      id: source.routeId,
      username: source.username,
      destinationId: destination.id,
      state: source.state,
      delivery: source.delivery,
      routingPolicy: source.routingPolicy,
      moderationPolicy: source.moderationPolicy,
      duplicateSuppression: source.duplicateSuppression,
    }));
}
