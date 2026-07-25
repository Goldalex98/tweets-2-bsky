import type { ReactNode } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus';
import { cn } from '../../lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  titleId: string;
  descriptionId?: string;
  variant?: 'center' | 'sheet';
  panelClassName?: string;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  titleId,
  descriptionId,
  variant = 'center',
  panelClassName,
  children,
}: DialogProps) {
  const panelRef = useDialogFocus(open, onClose);

  if (!open) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex bg-black/60 animate-backdrop-fade',
        variant === 'sheet'
          ? 'items-end justify-center p-0 sm:items-stretch sm:justify-end'
          : 'items-center justify-center p-4',
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        ref={panelRef}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={cn('m-0 max-h-none max-w-none border-0 p-0 text-foreground', panelClassName)}
      >
        {children}
      </dialog>
    </div>
  );
}
