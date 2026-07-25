import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { cn } from '../../lib/utils';

interface Job {
  id: string;
  kind: string;
  account?: string;
  target?: string;
  message?: string;
  processedCount?: number;
  totalCount?: number;
}

interface Queue {
  pending: number;
  processing: number;
  failed: number;
}

interface RuntimeStatus {
  state: string;
  currentAccount?: string;
  message?: string;
  processedCount?: number;
  totalCount?: number;
}

interface OperationsStatusProps {
  jobs: Job[];
  queue?: Queue;
  queuedCount: number;
  pendingBackfillCount: number;
  status?: RuntimeStatus;
  progressPercent: number;
  canManageAll: boolean;
  onRetryFailed: () => void;
  onClearFailed: () => void;
}

const jobLabels: Record<string, string> = {
  checking: 'Checking',
  mirroring: 'Mirroring',
  backfilling: 'Backfilling',
  'profile-sync': 'Profile sync',
  'pin-sync': 'Pin sync',
};

const jobDots: Record<string, string> = {
  checking: 'bg-sky-500',
  mirroring: 'bg-emerald-500',
  backfilling: 'bg-amber-500',
  'profile-sync': 'bg-violet-500',
  'pin-sync': 'bg-pink-500',
};

export function OperationsStatus({
  jobs,
  queue,
  queuedCount,
  pendingBackfillCount,
  status,
  progressPercent,
  canManageAll,
  onRetryFailed,
  onClearFailed,
}: OperationsStatusProps) {
  const visible =
    jobs.length > 0 || queuedCount > 0 || (queue?.failed ?? 0) > 0 || Boolean(status && status.state !== 'idle');
  if (!visible) return null;

  const summary =
    jobs.length > 0
      ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} running`
      : queuedCount > 0
        ? `${queuedCount} tweet${queuedCount === 1 ? '' : 's'} queued to post`
        : (queue?.failed ?? 0) > 0
          ? `${queue?.failed} tweet${queue?.failed === 1 ? '' : 's'} failed to post`
          : `${status?.state ?? 'processing'} in progress`;

  return (
    <Card className="mb-6" aria-live="polite" aria-atomic="false">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <p className="text-sm font-semibold">{summary}</p>
        <div className="flex flex-wrap items-center gap-3">
          {jobs.length > 0 && queuedCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {queue?.processing ?? 0} posting · {queue?.pending ?? 0} waiting
            </p>
          ) : null}
          {pendingBackfillCount > 0 ? (
            <p className="text-xs text-muted-foreground">{pendingBackfillCount} backfill(s) queued</p>
          ) : null}
          {(queue?.failed ?? 0) > 0 ? (
            <p className="text-xs text-red-600 dark:text-red-400">{queue?.failed} failed</p>
          ) : null}
          {canManageAll && (queue?.failed ?? 0) > 0 ? (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={onRetryFailed}>
                Retry failed
              </Button>
              <Button size="sm" variant="outline" onClick={onClearFailed}>
                Clear failed
              </Button>
            </span>
          ) : null}
        </div>
      </div>
      {jobs.length > 0 ? (
        <ul className="divide-y divide-border">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2 text-sm">
              <span
                aria-hidden="true"
                className={cn('inline-block h-2 w-2 shrink-0 self-center rounded-full', jobDots[job.kind] || 'bg-muted-foreground')}
              />
              <span className="font-medium">{jobLabels[job.kind] || job.kind}</span>
              {job.account ? <span className="font-mono text-xs">@{job.account}</span> : null}
              {job.target ? <span className="text-xs text-muted-foreground">→ {job.target}</span> : null}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{job.message}</span>
              {typeof job.totalCount === 'number' && job.totalCount > 0 ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {job.processedCount ?? 0}/{job.totalCount}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : status ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <p className="text-sm text-muted-foreground">
            {status.currentAccount ? `@${status.currentAccount} • ` : ''}
            {status.message || 'Working through account queue.'}
          </p>
          {status.totalCount ? (
            <p className="font-mono text-xs text-muted-foreground">
              {(status.processedCount || 0).toLocaleString()} / {status.totalCount.toLocaleString()} ({progressPercent}%)
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
