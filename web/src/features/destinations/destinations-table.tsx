import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { getMappingGroupMeta } from '../../lib/dashboard-utils';
import { HEALTH_BADGE_VARIANT, summarizeDestinationHealth } from './destination-health';
import type { AccountMapping, BskyProfileView } from './types';

interface DestinationsTableProps {
  mappings: AccountMapping[];
  getProfile(actor: string): BskyProfileView | undefined;
  canManage(mapping: AccountMapping): boolean;
  selectedIds: Set<string>;
  onToggle(id: string): void;
  onToggleAll(): void;
  onEdit(mapping: AccountMapping): void;
  onDelete(mapping: AccountMapping): void;
  onBackfill(mapping: AccountMapping): void;
}

export function DestinationsTable({
  mappings,
  getProfile,
  canManage,
  selectedIds,
  onToggle,
  onToggleAll,
  onEdit,
  onDelete,
  onBackfill,
}: DestinationsTableProps) {
  const allSelected = mappings.length > 0 && mappings.every((mapping) => selectedIds.has(mapping.id));
  return (
    <div className="hidden overflow-x-auto rounded-lg border md:block">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-3">
              <input
                type="checkbox"
                aria-label="Select all destinations"
                checked={allSelected}
                onChange={onToggleAll}
              />
            </th>
            <th className="px-3 py-3">Destination</th>
            <th className="px-3 py-3">Sources</th>
            <th className="px-3 py-3">Folder</th>
            <th className="px-3 py-3">Queue</th>
            <th className="px-3 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((mapping) => {
            const profile = getProfile(mapping.bskyIdentifier);
            const group = getMappingGroupMeta(mapping);
            const health = summarizeDestinationHealth(mapping);
            return (
              <tr key={mapping.id} className="interactive-row border-b last:border-0">
                <td className="px-3 py-3 align-top">
                  <input
                    type="checkbox"
                    aria-label={`Select @${mapping.bskyIdentifier}`}
                    checked={selectedIds.has(mapping.id)}
                    onChange={() => onToggle(mapping.id)}
                  />
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    {profile?.avatar ? <img className="h-8 w-8 rounded-full border object-cover" src={profile.avatar} alt="" loading="lazy" /> : null}
                    <div>
                      <p className="font-medium">@{profile?.handle || mapping.bskyIdentifier}</p>
                      <Badge variant={HEALTH_BADGE_VARIANT[health.severity]} title={health.detail}>
                        {health.label}
                      </Badge>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3">{mapping.twitterUsernames.map((source) => `@${source}`).join(', ')}</td>
                <td className="px-3 py-3">{group.emoji} {group.name}</td>
                <td className="px-3 py-3">{mapping.queue?.pending ?? 0} pending · {mapping.queue?.failed ?? 0} failed</td>
                <td className="px-3 py-3">
                  {canManage(mapping) ? (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => onBackfill(mapping)}>Backfill</Button>
                      <Button size="sm" variant="outline" onClick={() => onEdit(mapping)}><Pencil className="h-3.5 w-3.5" /><span className="sr-only">Edit {mapping.bskyIdentifier}</span></Button>
                      <Button size="sm" variant="destructive" onClick={() => onDelete(mapping)}><Trash2 className="h-3.5 w-3.5" /><span className="sr-only">Delete {mapping.bskyIdentifier}</span></Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
