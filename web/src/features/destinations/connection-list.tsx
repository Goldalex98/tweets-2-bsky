import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { toSourceViews } from './canonical-views';
import type { AccountMapping } from './types';

interface ConnectionListProps {
  mapping: AccountMapping;
  onOpenSection?(section: 'sources' | 'moderation' | 'delivery', username?: string): void;
}

export function ConnectionList({ mapping, onOpenSection }: ConnectionListProps) {
  const sources = toSourceViews(mapping);

  if (sources.length === 0) {
    return <p className="text-sm text-muted-foreground">No sources connected yet.</p>;
  }

  return (
    <ul className="space-y-2" aria-label="Source to destination connections">
      {sources.map((source) => (
        <li key={source.username} className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              <span className="font-semibold">@{source.username}</span>
              <span className="text-muted-foreground"> → @{mapping.bskyCanonicalHandle || mapping.bskyIdentifier}</span>
            </p>
            <div className="flex flex-wrap gap-1">
              <Badge variant={source.state === 'paused' ? 'warning' : 'success'}>{source.state}</Badge>
              {source.delivery?.mode === 'digest' ? (
                <Badge variant="outline">digest</Badge>
              ) : (
                <Badge variant="outline">immediate</Badge>
              )}
              {source.routeId ? <Badge variant="outline">route {source.routeId.slice(0, 8)}</Badge> : null}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenSection?.('sources', source.username)}>
              Filters
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenSection?.('moderation', source.username)}>
              Moderation
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenSection?.('delivery', source.username)}>
              Delivery
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
