import { ArrowUpRight, History } from 'lucide-react';
import { formatLocalTime } from '../../lib/dashboard-utils';
import { describePolicyDifference } from '../../lib/policy-snapshot-labels';
import { Badge } from '../ui/badge';
import { Button, buttonVariants } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';

export interface ActivityQueueItem {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  status: 'pending' | 'processing' | 'failed';
  attempts: number;
  enqueued_at: number;
  tweet_text?: string;
  error_category?: string;
  error_message?: string;
  policy_version: number;
  policy_snapshot?: string;
  policyDifference?: { changed: boolean; fields: string[] };
  delivery_diagnostics?: string;
}

export interface ActivityEntry {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  status: 'migrated' | 'skipped' | 'failed';
  created_at?: string;
  tweet_text?: string;
  skip_reason?: string;
  error_category?: string;
  policy_version?: number;
  policy_snapshot?: string;
  destination_id?: string;
  retained_until?: number;
  override_requeued_at?: number;
  delivery_diagnostics?: string;
}

function parseDiagnostics(raw?: string): Array<{ kind: string; reason: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { kind: string; reason: string } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as { kind?: unknown }).kind === 'string' &&
        typeof (entry as { reason?: unknown }).reason === 'string',
    );
  } catch {
    return [];
  }
}

interface ActivityQueuePageProps {
  queueItems: ActivityQueueItem[];
  recentActivity: ActivityEntry[];
  groupOptions: Array<{ key: string; name: string; emoji: string }>;
  groupFilter: string;
  setGroupFilter(value: string): void;
  canReevaluateQueue: boolean;
  canOverrideSkipped: boolean;
  getSourceUrl(username?: string, id?: string): string | undefined;
  getDestinationUrl(activity: ActivityEntry): string | null;
  getActivityGroup(activity: ActivityEntry): { name: string; emoji: string };
  copyDiagnostic(item: ActivityQueueItem): Promise<void>;
  reevaluatePolicy(item: ActivityQueueItem): Promise<void>;
  operateItem(item: ActivityQueueItem, action: 'retry' | 'cancel'): Promise<void>;
  overrideSkipped(activity: ActivityEntry): Promise<void>;
}

export function ActivityQueuePage(props: ActivityQueuePageProps) {
  return (
    <section className="space-y-6 animate-fade-in" aria-labelledby="activity-page-title">
      <h2 id="activity-page-title" className="sr-only">
        Queue and recent activity
      </h2>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Durable Queue</CardTitle>
          <CardDescription>Pending, active, and parked deliveries. Active items are protected from deletion.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-0" aria-live="polite">
          {props.queueItems.map((item) => {
            const sourceUrl = props.getSourceUrl(item.twitter_username, item.twitter_id);
            const ageMinutes = Math.max(0, Math.floor((Date.now() - item.enqueued_at) / 60_000));
            return (
              <article
                key={`${item.bsky_identifier}-${item.twitter_id}`}
                className="rounded-md border border-border p-3 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={item.status === 'failed' ? 'danger' : item.status === 'processing' ? 'warning' : 'outline'}>
                        {item.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">queued {ageMinutes}m · {item.attempts} attempt(s)</span>
                      {item.error_category ? <Badge variant="outline">{item.error_category}</Badge> : null}
                    </div>
                    <p className="truncate font-medium">@{item.twitter_username}: {item.tweet_text || item.twitter_id}</p>
                    <p className="text-xs text-muted-foreground">
                      Policy v{item.policy_version} · {item.policy_snapshot ? 'snapshotted behavior' : 'current destination behavior'} ·{' '}
                      {item.policyDifference?.changed ? describePolicyDifference(item.policyDifference.fields) : 'matches current policy'}
                    </p>
                    {item.error_message ? <p className="max-w-3xl text-xs text-red-600 dark:text-red-400">{item.error_message}</p> : null}
                    {parseDiagnostics(item.delivery_diagnostics).length > 0 ? (
                      <div className="flex flex-wrap gap-1 pt-1" data-testid="queue-delivery-fallbacks">
                        {parseDiagnostics(item.delivery_diagnostics).map((event) => (
                          <Badge key={`${event.kind}-${event.reason}`} variant="outline" title={event.reason}>
                            {event.kind}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {sourceUrl ? <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={sourceUrl} target="_blank" rel="noreferrer">Source</a> : null}
                    <Button size="sm" variant="outline" onClick={() => void props.copyDiagnostic(item)}>Copy diagnostic</Button>
                    {props.canReevaluateQueue && item.status !== 'processing' && item.policyDifference?.changed ? (
                      <Button size="sm" variant="outline" onClick={() => void props.reevaluatePolicy(item)}>Use current policy</Button>
                    ) : null}
                    {item.status === 'failed' ? <Button size="sm" onClick={() => void props.operateItem(item, 'retry')}>Retry</Button> : null}
                    {item.status === 'pending' ? <Button size="sm" variant="destructive" onClick={() => void props.operateItem(item, 'cancel')}>Cancel</Button> : null}
                  </div>
                </div>
              </article>
            );
          })}
          {props.queueItems.length === 0 ? <p className="text-sm text-muted-foreground">The durable queue is empty.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2"><History className="h-4 w-4" />Recent Activity</CardTitle>
              <CardDescription>Latest migration outcomes from the processing database.</CardDescription>
            </div>
            <div className="w-full max-w-xs">
              <Label htmlFor="activity-group-filter">Filter group</Label>
              <select id="activity-group-filter" className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={props.groupFilter} onChange={(event) => props.setGroupFilter(event.target.value)}>
                <option value="all">All folders</option>
                {props.groupOptions.map((group) => <option key={group.key} value={group.key}>{group.emoji} {group.name}</option>)}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-2 py-3">Time</th><th className="px-2 py-3">Twitter User</th><th className="px-2 py-3">Group</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Details</th><th className="px-2 py-3 text-right">Links</th></tr>
              </thead>
              <tbody>
                {props.recentActivity.map((activity, index) => {
                  const destinationUrl = props.getDestinationUrl(activity);
                  const sourceUrl = props.getSourceUrl(activity.twitter_username, activity.twitter_id);
                  const group = props.getActivityGroup(activity);
                  const canOverride = activity.status === 'skipped' && activity.destination_id && activity.retained_until && activity.retained_until > Date.now() && !activity.override_requeued_at && props.canOverrideSkipped;
                  return (
                    <tr key={`${activity.twitter_id}-${activity.created_at || index}`} className="interactive-row border-b border-border/60 last:border-0">
                      <td className="px-2 py-3 align-top text-xs text-muted-foreground">{formatLocalTime(activity.created_at)}</td>
                      <td className="px-2 py-3 align-top font-medium">@{activity.twitter_username}</td>
                      <td className="px-2 py-3 align-top"><Badge variant="outline">{group.emoji} {group.name}</Badge></td>
                      <td className="px-2 py-3 align-top"><Badge variant={activity.status === 'migrated' ? 'success' : activity.status === 'failed' ? 'danger' : 'outline'}>{activity.status}</Badge></td>
                      <td className="px-2 py-3 align-top text-xs text-muted-foreground">
                        <div className="max-w-[340px] truncate">{activity.tweet_text || `Tweet ID: ${activity.twitter_id}`}</div>
                        {activity.skip_reason ? <div>Reason: {activity.skip_reason}</div> : null}
                        {activity.error_category ? <div>Category: {activity.error_category}</div> : null}
                        <div>Policy v{activity.policy_version ?? 1} · {activity.policy_snapshot ? 'snapshotted behavior' : 'current behavior'}</div>
                        {parseDiagnostics(activity.delivery_diagnostics).length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {parseDiagnostics(activity.delivery_diagnostics).map((event) => (
                              <Badge key={`${activity.twitter_id}-${event.kind}`} variant="outline" title={event.reason}>
                                {event.kind}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 align-top text-right">
                        <div className="flex flex-col items-end gap-1">
                          {sourceUrl ? <a className="inline-flex items-center text-xs underline-offset-4 hover:underline" href={sourceUrl} target="_blank" rel="noreferrer">Source<ArrowUpRight className="ml-1 h-3 w-3" /></a> : null}
                          {destinationUrl ? <a className="inline-flex items-center text-xs underline-offset-4 hover:underline" href={destinationUrl} target="_blank" rel="noreferrer">Bluesky<ArrowUpRight className="ml-1 h-3 w-3" /></a> : <span className="text-xs text-muted-foreground">--</span>}
                          {canOverride ? <Button size="sm" variant="outline" onClick={() => void props.overrideSkipped(activity)}>Override &amp; requeue</Button> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {props.recentActivity.length === 0 ? <tr><td className="px-2 py-6 text-center text-sm text-muted-foreground" colSpan={6}>No activity for this filter.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
