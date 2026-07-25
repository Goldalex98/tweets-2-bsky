import { useId } from 'react';
import { Button } from './button';
import { Dialog } from './dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const instanceId = useId();
  const titleId = `confirm-dialog-title-${instanceId}`;
  const descriptionId = `confirm-dialog-description-${instanceId}`;
  return (
    <Dialog open={open} onClose={onCancel} titleId={titleId} descriptionId={descriptionId}>
      <div className="w-[min(92vw,30rem)] space-y-4 rounded-lg bg-background p-5 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>
        <div className="flex justify-end gap-2">
          <Button data-autofocus={destructive || undefined} variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button data-autofocus={destructive ? undefined : true} variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
