import { UserRound, type LucideIcon } from 'lucide-react';
import type { DashboardTab } from '../../api/types';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import type { ActivityLog } from '../activity/types';
import type { AccountMapping, BskyProfileView } from '../destinations/types';
import type { StatusState } from '../status/types';
import { formatCompactNumber, formatState } from '../../lib/dashboard-utils';

interface DashboardLink {
  id: DashboardTab;
  label: string;
  icon: LucideIcon;
}

interface OverviewPageProps {
  mappings: AccountMapping[];
  queuedPostCount: number;
  pendingBackfillCount: number;
  currentStatus?: StatusState;
  latestActivity?: ActivityLog;
  topAccount?: { identifier: string; score: number; posts: number };
  topAccountProfile?: BskyProfileView;
  dashboardTabs: DashboardLink[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onNavigate(tab: DashboardTab): void;
}

export function OverviewPage({
  mappings,
  queuedPostCount,
  pendingBackfillCount,
  currentStatus,
  latestActivity,
  topAccount,
  topAccountProfile,
  dashboardTabs,
  loading,
  error,
  onRetry,
  onNavigate,
}: OverviewPageProps) {
  if (loading && mappings.length === 0) {
    return <output className="block py-12 text-center text-sm text-muted-foreground">Loading overview…</output>;
  }
  if (error && mappings.length === 0) {
    return (
      <Card role="alert">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button variant="outline" onClick={onRetry}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-6 animate-fade-in" aria-labelledby="page-title">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Mapped Accounts" value={mappings.length} />
        <Metric label="Bot-Labeled" value={mappings.filter((mapping) => mapping.hasBotLabel === true).length} />
        <Metric label="Queued Posts" value={queuedPostCount}>
          {pendingBackfillCount > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              +{pendingBackfillCount} backfill fetch{pendingBackfillCount === 1 ? '' : 'es'} pending
            </p>
          ) : null}
        </Metric>
        <Metric label="Current State" value={formatState(currentStatus?.state || 'idle')} />
        <Metric
          label="Latest Activity"
          value={latestActivity?.created_at ? new Date(latestActivity.created_at).toLocaleString() : 'No activity yet'}
          compact
        />
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Top Account (Engagement)</p>
            {topAccount ? (
              <div className="mt-2 flex items-center gap-3">
                {topAccountProfile?.avatar ? (
                  <img
                    className="h-9 w-9 rounded-full border border-border/70 object-cover"
                    src={topAccountProfile.avatar}
                    alt={`${topAccountProfile.handle || topAccount.identifier} avatar`}
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground">
                    <UserRound className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">@{topAccountProfile?.handle || topAccount.identifier}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatCompactNumber(topAccount.score)} interactions • {topAccount.posts} posts
                  </p>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No engagement data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Source and Destination Health</CardTitle>
          <CardDescription>Last checks/posts, queue age, profile policy, and attribution state.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {mappings.length === 0 ? <p className="text-sm text-muted-foreground">No destinations configured yet.</p> : null}
          {mappings.map((mapping) => (
            <div key={`health-${mapping.id}`} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {mapping.bskyCanonicalHandle
                    ? `@${mapping.bskyCanonicalHandle}`
                    : mapping.bskyIdentifier.startsWith('did:')
                      ? mapping.bskyIdentifier
                      : `@${mapping.bskyIdentifier}`}
                </p>
                <span className="text-xs text-muted-foreground">
                  Last post: {mapping.runtime?.lastBskyPostAt ? new Date(mapping.runtime.lastBskyPostAt).toLocaleString() : 'never'}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Queue: {mapping.queue?.pending ?? 0} pending, {mapping.queue?.failed ?? 0} failed · Profile:{' '}
                {mapping.profileManagement.profileSync.mode} · Attribution: {mapping.postingPolicy.attribution.mode}
              </p>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {(mapping.sources ?? []).map((source) => (
                  <div key={`${mapping.id}-${source.username}`} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">@{source.username}</span> · last check{' '}
                    {source.runtime?.lastCheckAt ? new Date(source.runtime.lastCheckAt).toLocaleString() : 'never'}
                    {source.runtime?.lastErrorCategory
                      ? ` · ${source.runtime.lastErrorCategory}: ${source.runtime.lastErrorMessage ?? 'failed'}`
                      : ''}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Navigation</CardTitle>
          <CardDescription>Use tabs to focus one workflow at a time, especially on mobile.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-0">
          {dashboardTabs.filter((tab) => tab.id !== 'overview').map((tab) => {
            const Icon = tab.icon;
            return (
              <Button key={tab.id} variant="outline" onClick={() => onNavigate(tab.id)}>
                <Icon className="mr-2 h-4 w-4" />Open {tab.label}
              </Button>
            );
          })}
        </CardContent>
      </Card>
    </section>
  );
}

function Metric({
  label,
  value,
  compact = false,
  children,
}: {
  label: string;
  value: string | number;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={compact ? 'mt-2 text-sm font-medium text-foreground' : 'mt-2 text-2xl font-semibold'}>{value}</p>
        {children}
      </CardContent>
    </Card>
  );
}
