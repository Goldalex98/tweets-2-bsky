import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

interface BulkActionBarProps {
  selectedCount: number;
  busy: boolean;
  folderName: string;
  onFolderNameChange(value: string): void;
  confirmation: string;
  onConfirmationChange(value: string): void;
  onPause(): void;
  onResume(): void;
  onMoveFolder(): void;
  onBackfill(): void;
  onClearSelection(): void;
}

export function BulkActionBar(props: BulkActionBarProps) {
  if (props.selectedCount === 0) return null;
  return (
    <section
      className="sticky bottom-3 z-10 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur"
      aria-label="Bulk destination actions"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">{props.selectedCount} selected</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={props.busy} onClick={props.onPause}>
            Pause
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={props.busy} onClick={props.onResume}>
            Resume
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onClearSelection}>
            Clear
          </Button>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor="bulk-folder-name">Move to folder</Label>
          <div className="flex gap-2">
            <Input
              id="bulk-folder-name"
              value={props.folderName}
              onChange={(event) => props.onFolderNameChange(event.target.value)}
              placeholder="Folder name"
            />
            <Button type="button" size="sm" variant="outline" disabled={props.busy || !props.folderName.trim()} onClick={props.onMoveFolder}>
              Move
            </Button>
          </div>
        </div>
        <div>
          <Label htmlFor="bulk-backfill-confirm">Confirm backfill</Label>
          <div className="flex gap-2">
            <Input
              id="bulk-backfill-confirm"
              value={props.confirmation}
              onChange={(event) => props.onConfirmationChange(event.target.value)}
              placeholder={`BACKFILL ${props.selectedCount}`}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.busy || props.confirmation !== `BACKFILL ${props.selectedCount}`}
              onClick={props.onBackfill}
            >
              Backfill
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
