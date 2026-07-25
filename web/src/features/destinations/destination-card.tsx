import { Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { getMappingGroupMeta } from '../../lib/dashboard-utils';
import type { AccountMapping, BskyProfileView } from './types';

interface DestinationCardProps {
  mapping: AccountMapping;
  profile?: BskyProfileView;
  canManage: boolean;
  backfillQueued: boolean;
  backfillActive: boolean;
  onEdit(): void;
  onDelete(): void;
  onBackfill(): void;
  onCancelBackfill(): void;
}

export function DestinationCard({
  mapping,
  profile,
  canManage,
  backfillQueued,
  backfillActive,
  onEdit,
  onDelete,
  onBackfill,
  onCancelBackfill,
}: DestinationCardProps) {
  const group = getMappingGroupMeta(mapping);
  return (
    <Card className="cv-auto">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {profile?.avatar ? (
              <img className="h-10 w-10 rounded-full border object-cover" src={profile.avatar} alt="" loading="lazy" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted font-semibold">
                {mapping.bskyIdentifier.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-semibold">@{profile?.handle || mapping.bskyIdentifier}</p>
              <p className="truncate text-xs text-muted-foreground">
                {mapping.twitterUsernames.map((username) => `@${username}`).join(', ')}
              </p>
            </div>
          </div>
          <Badge variant={mapping.destinationState === 'paused' || !mapping.enabled ? 'warning' : 'success'}>
            {mapping.destinationState === 'paused' || !mapping.enabled ? 'Paused' : 'Active'}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">{group.emoji} {group.name}</Badge>
          <Badge variant="outline">{mapping.queue?.pending ?? 0} queued</Badge>
          {mapping.queue?.failed ? <Badge variant="danger">{mapping.queue.failed} failed</Badge> : null}
        </div>
        {profile?.description ? <p className="line-clamp-2 text-sm text-muted-foreground">{profile.description}</p> : null}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>
            {backfillQueued || backfillActive ? (
              <Button size="sm" variant="outline" onClick={onCancelBackfill}><Pause className="mr-1 h-3.5 w-3.5" />Cancel backfill</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onBackfill}><Play className="mr-1 h-3.5 w-3.5" />Backfill</Button>
            )}
            <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
