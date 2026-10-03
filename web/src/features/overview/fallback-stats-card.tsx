import { useEffect, useState } from 'react';
import api from '../../api/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import type { AccountMapping } from '../destinations/types';

interface DestinationFallbackStats {
  destinationId: string;
  bskyIdentifier: string;
  posted: number;
  postsWithFallback: number;
  byKind: Record<string, number>;
}

const FALLBACK_LABELS: Record<string, string> = {
  'video-link': 'video as link',
  'quote-card': 'quote as card',
  'quote-screenshot': 'quote as screenshot',
  'quote-link': 'quote as link',
  'poll-note': 'poll as text',
  'poll-card': 'poll as card',
  'repost-wrapper-fallback': 'repost as link',
};

const STATS_DAYS = 30;

/** Per destination, how many recent posts could not mirror something natively. */
export function FallbackStatsCard({ mappings }: { mappings: AccountMapping[] }) {
  const [stats, setStats] = useState<DestinationFallbackStats[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ destinations?: DestinationFallbackStats[] }>(`/api/delivery-fallbacks?days=${STATS_DAYS}`)
      .then((response) => {
        if (cancelled) return;
        setStats(Array.isArray(response.data?.destinations) ? response.data.destinations : []);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = (entry: DestinationFallbackStats) => {
    const mapping = mappings.find((candidate) => candidate.id === entry.destinationId);
    const handle = mapping?.bskyCanonicalHandle || entry.bskyIdentifier;
    return handle.startsWith('did:') ? handle : `@${handle}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Native vs Fallback</CardTitle>
        <CardDescription>
          Posts in the last {STATS_DAYS} days that mirrored something as a link, card or text instead of natively.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {failed ? <p className="text-sm text-muted-foreground">Fallback stats are unavailable right now.</p> : null}
        {!failed && stats === null ? <p className="text-sm text-muted-foreground">Loading fallback stats…</p> : null}
        {!failed && stats?.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts in the last {STATS_DAYS} days.</p>
        ) : null}
        {stats?.map((entry) => {
          const kinds = Object.entries(entry.byKind ?? {}).filter(([, count]) => count > 0);
          return (
            <div
              key={`fallback-${entry.destinationId}`}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border p-3"
            >
              <p className="font-medium">{label(entry)}</p>
              <p className="text-xs text-muted-foreground">
                {entry.posted - entry.postsWithFallback} of {entry.posted} native
                {kinds.length > 0
                  ? ` · ${kinds.map(([kind, count]) => `${count} ${FALLBACK_LABELS[kind] ?? kind}`).join(', ')}`
                  : ''}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
