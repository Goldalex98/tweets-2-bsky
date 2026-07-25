import { Folder, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';
import { DestinationCard } from './destination-card';
import { DestinationsTable } from './destinations-table';
import type { AccountMapping, BskyProfileView } from './types';

interface DestinationGroup {
  key: string;
  name: string;
  emoji: string;
  mappings: AccountMapping[];
}

interface DestinationsPageProps {
  groups: Array<{ key: string; name: string; emoji: string }>;
  selectedFolderKey: string;
  onSelectFolder(key: string): void;
  searchQuery: string;
  onSearchQueryChange(value: string): void;
  groupedMappings: DestinationGroup[];
  matchCount: number;
  loading: boolean;
  error: string | null;
  canCreate: boolean;
  onAdd(): void;
  getProfile(actor: string): BskyProfileView | undefined;
  canManage(mapping: AccountMapping): boolean;
  isBackfillQueued(id: string): boolean;
  isBackfillActive(id: string): boolean;
  onEdit(mapping: AccountMapping): void;
  onDelete(mapping: AccountMapping): void;
  onBackfill(mapping: AccountMapping): void;
  onCancelBackfill(mapping: AccountMapping): void;
  onApplyProfileSync?(mapping: AccountMapping): void;
  onQueuePinSync?(mapping: AccountMapping): void;
}

export function DestinationsPage(props: DestinationsPageProps) {
  const flatMappings = props.groupedMappings.flatMap((group) => group.mappings);
  const [confirmation, setConfirmation] = useState<{ action: 'delete' | 'cancel-backfill'; mapping: AccountMapping } | null>(null);
  return (
    <section className="grid gap-6 lg:grid-cols-[240px_1fr] animate-fade-in" aria-labelledby="destinations-title" aria-busy={props.loading}>
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <Card>
          <CardContent className="space-y-0.5 p-2">
            <FolderButton active={props.selectedFolderKey === '__all__'} onClick={() => props.onSelectFolder('__all__')} emoji="🌐" name="All Accounts" />
            {props.groups.map((group) => (
              <FolderButton key={group.key} active={props.selectedFolderKey === group.key} onClick={() => props.onSelectFolder(group.key)} emoji={group.emoji} name={group.name} />
            ))}
          </CardContent>
        </Card>
      </aside>
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><CardTitle id="destinations-title">Bluesky Destinations</CardTitle><CardDescription>Manage destination identities, X sources, folders, and delivery state.</CardDescription></div>
              {props.canCreate ? <Button onClick={props.onAdd}><Plus className="mr-2 h-4 w-4" />Add Bluesky destination</Button> : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <label className="relative block" htmlFor="accounts-search">
              <span className="sr-only">Search accounts</span>
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input id="accounts-search" className="pl-9" value={props.searchQuery} onChange={(event) => props.onSearchQueryChange(event.target.value)} placeholder="Search destinations, sources, owners, or folders" />
            </label>
            {props.error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{props.error}</p> : null}
            <p className="text-xs text-muted-foreground">{props.matchCount} destination{props.matchCount === 1 ? '' : 's'}</p>
            {flatMappings.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{props.loading ? 'Loading destinations…' : 'No destinations match this view.'}</div> : null}
            <DestinationsTable mappings={flatMappings} getProfile={props.getProfile} canManage={props.canManage} onEdit={props.onEdit} onDelete={(mapping) => setConfirmation({ action: 'delete', mapping })} onBackfill={props.onBackfill} />
            <div className="grid gap-3 md:hidden">
              {flatMappings.map((mapping) => (
                <DestinationCard
                  key={mapping.id}
                  mapping={mapping}
                  profile={props.getProfile(mapping.bskyIdentifier)}
                  canManage={props.canManage(mapping)}
                  backfillQueued={props.isBackfillQueued(mapping.id)}
                  backfillActive={props.isBackfillActive(mapping.id)}
                  onEdit={() => props.onEdit(mapping)}
                  onDelete={() => setConfirmation({ action: 'delete', mapping })}
                  onBackfill={() => props.onBackfill(mapping)}
                  onCancelBackfill={() => setConfirmation({ action: 'cancel-backfill', mapping })}
                  onApplyProfileSync={
                    props.onApplyProfileSync ? () => props.onApplyProfileSync?.(mapping) : undefined
                  }
                  onQueuePinSync={props.onQueuePinSync ? () => props.onQueuePinSync?.(mapping) : undefined}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.action === 'delete' ? 'Delete destination?' : 'Cancel queued backfill?'}
        description={
          confirmation?.action === 'delete'
            ? `Delete @${confirmation.mapping.bskyIdentifier}? Existing queue and history handling follows the selected server policy.`
            : `Cancel the queued backfill for @${confirmation?.mapping.bskyIdentifier}?`
        }
        confirmLabel={confirmation?.action === 'delete' ? 'Delete destination' : 'Cancel backfill'}
        destructive
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation) return;
          if (confirmation.action === 'delete') props.onDelete(confirmation.mapping);
          else props.onCancelBackfill(confirmation.mapping);
          setConfirmation(null);
        }}
      />
    </section>
  );
}

function FolderButton({ active, onClick, emoji, name }: { active: boolean; onClick(): void; emoji: string; name: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background', active ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}><span aria-hidden="true">{emoji}</span><span className="truncate">{name}</span><Folder aria-hidden="true" className="ml-auto h-3.5 w-3.5 opacity-60" /></button>;
}
