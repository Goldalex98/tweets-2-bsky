import { Button } from './ui/button';
import { cn } from '../lib/utils';

export interface RecoveryNotice {
  id: string;
  severity: 'warning' | 'danger';
  title: string;
  detail: string;
  actionLabel: string;
  onAction(): void;
}

interface RecoveryBannersProps {
  notices: RecoveryNotice[];
}

export function RecoveryBanners({ notices }: RecoveryBannersProps) {
  if (notices.length === 0) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {notices.map((notice) => (
        <output
          key={notice.id}
          className={cn(
            'flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left',
            notice.severity === 'danger'
              ? 'border-red-500/40 bg-red-500/10'
              : 'border-amber-500/40 bg-amber-500/10',
          )}
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold">{notice.title}</p>
            <p className="text-xs text-muted-foreground">{notice.detail}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={notice.onAction}>
            {notice.actionLabel}
          </Button>
        </output>
      ))}
    </div>
  );
}
