import { Download, Loader2, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import { type Dispatch, type FormEvent, type SetStateAction, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  estimateChecksPerHour,
  formatLocalDateTime,
  MAX_CHECK_INTERVAL_MINUTES,
  MIN_CHECK_INTERVAL_MINUTES,
  parseCheckIntervalMinutes,
} from '../../lib/dashboard-utils';
import {
  SourcePollingPanel,
  uniquePollingOptions,
} from '../destinations/source-polling-panel';
import type { AccountMapping, SourceSchedulePolicy } from '../destinations/types';
import type { SchedulerSettings } from '../status/types';
import type {
  AccountSecurityEmailState,
  AccountSecurityPasswordState,
  AIConfig,
  AuthUser,
  CookieHealthStatus,
  ManagedUser,
  NotificationEvent,
  NotificationSettings,
  RuntimeVersionInfo,
  TwitterConfig,
  UpdateStatusInfo,
  UserFormState,
  UserPermissions,
} from './types';
import { PERMISSION_OPTIONS } from './utils';

const NOTIFICATION_EVENT_OPTIONS: Array<{ key: NotificationEvent; label: string; hint: string }> = [
  { key: 'twitter-auth-failure', label: 'X / Twitter auth failure', hint: 'Cookie or scraper authentication failed.' },
  { key: 'bsky-auth-failure', label: 'Bluesky auth failure', hint: 'Destination login or app password rejected.' },
  { key: 'queue-parked', label: 'Queue item parked', hint: 'A post exhausted retries and was parked as failed.' },
  { key: 'queue-age', label: 'Queue age alert', hint: 'Oldest pending item exceeded QUEUE_AGE_ALERT_MS (default 1 hour). Off by default.' },
  { key: 'update-failure', label: 'Update failure', hint: 'In-app update process failed to start or exit cleanly.' },
];

function formatCookieTimestamp(value?: number): string {
  if (!value) return 'Never';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Unknown';
  }
}

export function AccountSecuritySection({
  user,
  email,
  setEmail,
  password,
  setPassword,
  busy,
  onSaveEmail,
  onSavePassword,
}: {
  user: AuthUser;
  email: AccountSecurityEmailState;
  setEmail: Dispatch<SetStateAction<AccountSecurityEmailState>>;
  password: AccountSecurityPasswordState;
  setPassword: Dispatch<SetStateAction<AccountSecurityPasswordState>>;
  busy: boolean;
  onSaveEmail(event: FormEvent<HTMLFormElement>): void;
  onSavePassword(event: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Account Security</CardTitle><CardDescription>Update the email and password for {user.username || user.email || 'your account'}.</CardDescription></CardHeader>
      <CardContent className="grid gap-6 border-t pt-4 lg:grid-cols-2">
        <form className="space-y-3" onSubmit={onSaveEmail}>
          <p className="font-semibold">Change Email</p>
          <Label htmlFor="account-current-email">Current Email</Label><Input id="account-current-email" value={email.currentEmail} disabled />
          <Label htmlFor="account-new-email">New Email</Label><Input id="account-new-email" type="email" value={email.newEmail} onChange={(event) => setEmail((current) => ({ ...current, newEmail: event.target.value }))} required />
          <Label htmlFor="account-email-password">Current Password</Label><Input id="account-email-password" type="password" value={email.password} onChange={(event) => setEmail((current) => ({ ...current, password: event.target.value }))} required />
          <Button size="sm" type="submit" disabled={busy}><Save className="mr-2 h-4 w-4" />Save Email</Button>
        </form>
        <form className="space-y-3" onSubmit={onSavePassword}>
          <p className="font-semibold">Change Password</p>
          <Label htmlFor="account-current-password">Current Password</Label><Input id="account-current-password" type="password" value={password.currentPassword} onChange={(event) => setPassword((current) => ({ ...current, currentPassword: event.target.value }))} required />
          <Label htmlFor="account-new-password">New Password</Label><Input id="account-new-password" type="password" value={password.newPassword} onChange={(event) => setPassword((current) => ({ ...current, newPassword: event.target.value }))} required />
          <Label htmlFor="account-confirm-password">Confirm New Password</Label><Input id="account-confirm-password" type="password" value={password.confirmPassword} onChange={(event) => setPassword((current) => ({ ...current, confirmPassword: event.target.value }))} required />
          <Button size="sm" type="submit" disabled={busy}><Save className="mr-2 h-4 w-4" />Save Password</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function AccessScopeSection({ permissions }: { permissions: UserPermissions }) {
  return <Card><CardHeader><CardTitle>Access Scope</CardTitle><CardDescription>Your current account permissions.</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2 pt-0">{PERMISSION_OPTIONS.filter((item) => permissions[item.key]).map((item) => <Badge key={item.key} variant="outline">{item.label}</Badge>)}</CardContent></Card>;
}

export function SystemSection({
  runtime,
  update,
  updating,
  canCreate,
  onUpdate,
  onAdd,
}: {
  runtime: RuntimeVersionInfo | null;
  update: UpdateStatusInfo | null;
  updating: boolean;
  canCreate: boolean;
  onUpdate(): void;
  onAdd(): void;
}) {
  return <Card><CardHeader><CardTitle>Admin Settings</CardTitle><CardDescription>Running version, updates, and quick account creation.</CardDescription></CardHeader><CardContent className="space-y-4 pt-0"><div className="rounded-lg border p-3"><p className="font-semibold">Running Version</p><p className="font-mono text-sm">v{runtime?.version || 'unknown'}{runtime?.commit ? ` (${runtime.commit})` : ''}</p><p className="text-xs text-muted-foreground">{update?.running ? 'Update running' : 'No update running'}</p></div><div className="flex gap-2"><Button variant="outline" onClick={onUpdate} disabled={updating || update?.running}>{updating || update?.running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Update</Button>{canCreate ? <Button onClick={onAdd}><Plus className="mr-2 h-4 w-4" />Add Destination</Button> : null}</div></CardContent></Card>;
}

export function SchedulerSection({
  value,
  setValue,
  saving,
  onSubmit,
  mappings = [],
  onSaveSourceSchedule,
}: {
  value: SchedulerSettings;
  setValue: Dispatch<SetStateAction<SchedulerSettings | null>>;
  saving: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  mappings?: readonly AccountMapping[];
  onSaveSourceSchedule?(mapping: AccountMapping, username: string, schedule: SourceSchedulePolicy): Promise<void>;
}) {
  // The field is kept as text so clearing it shows an error instead of posting NaN.
  const [draft, setDraft] = useState(String(value.intervalMinutes));
  const committed = useRef(value.intervalMinutes);
  if (committed.current !== value.intervalMinutes) {
    committed.current = value.intervalMinutes;
    if (parseCheckIntervalMinutes(draft).minutes !== value.intervalMinutes) setDraft(String(value.intervalMinutes));
  }

  const parsed = parseCheckIntervalMinutes(draft);
  const checksPerHour = parsed.minutes === null ? null : estimateChecksPerHour(value.enabledSourceCount, parsed.minutes);
  const pollingOptions = uniquePollingOptions(mappings);
  const diagnostics = value.diagnostics;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduler</CardTitle>
        <CardDescription>Controls automatic fetch sweeps. Manual operations remain available while disabled.</CardDescription>
      </CardHeader>
      <CardContent className="border-t pt-4">
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">Last scheduler sweep</dt>
              <dd className="font-medium">
                {value.lastCheckTime ? formatLocalDateTime(value.lastCheckTime) : 'No completed sweep yet'}
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">Next scheduler wake</dt>
              <dd className="font-medium">
                {!value.enabled
                  ? 'Disabled'
                  : value.nextCheckTime
                    ? formatLocalDateTime(value.nextCheckTime)
                    : 'Pending'}
              </dd>
            </div>
          </dl>
          <label className="flex items-center justify-between rounded-md border p-3 text-sm">
            <span>
              <strong>Enable scheduled checks</strong>
              <span className="block text-xs text-muted-foreground">Automatic X fetch sweeps only.</span>
            </span>
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => setValue((current) => (current ? { ...current, enabled: event.target.checked } : current))}
            />
          </label>
          <div className="space-y-1">
            <Label htmlFor="scheduler-interval">Check every (minutes)</Label>
            <Input
              id="scheduler-interval"
              type="number"
              inputMode="numeric"
              min={MIN_CHECK_INTERVAL_MINUTES}
              max={MAX_CHECK_INTERVAL_MINUTES}
              step={1}
              value={draft}
              aria-invalid={parsed.error !== null}
              aria-describedby="scheduler-interval-hint"
              onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                const result = parseCheckIntervalMinutes(next);
                if (result.minutes === null) return;
                committed.current = result.minutes;
                setValue((current) => (current ? { ...current, intervalMinutes: result.minutes as number } : current));
              }}
            />
            <p
              id="scheduler-interval-hint"
              className={parsed.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
              role={parsed.error ? 'alert' : undefined}
            >
              {parsed.error
                ? parsed.error
                : `${MIN_CHECK_INTERVAL_MINUTES}-${MAX_CHECK_INTERVAL_MINUTES} minutes. If every source is due, ${value.enabledSourceCount} enabled source${value.enabledSourceCount === 1 ? '' : 's'} means up to about ${checksPerHour} timeline check${checksPerHour === 1 ? '' : 's'} per hour; adaptive policies are usually lower.`}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.runOnStartup}
              onChange={(event) => setValue((current) => (current ? { ...current, runOnStartup: event.target.checked } : current))}
            />
            Run once on startup
          </label>
          <Button type="submit" disabled={saving || parsed.error !== null}>
            <Save className="mr-2 h-4 w-4" />Save scheduler
          </Button>
        </form>

        {onSaveSourceSchedule ? (
          <div className="mt-6 border-t pt-6">
            <SourcePollingPanel
              options={pollingOptions}
              globalIntervalMinutes={value.intervalMinutes}
              busy={saving}
              onSave={(option, schedule) =>
                onSaveSourceSchedule(option.mapping, option.username, schedule)
              }
              title="Per-source polling"
              description="Canonical X source policies apply everywhere that source is routed. Adaptive mode is recommended for breaking-news accounts."
            />
          </div>
        ) : null}

        {diagnostics ? (
          <div className="mt-6 space-y-3 border-t pt-6" data-testid="scheduler-safety-diagnostics">
            <div>
              <h3 className="text-sm font-semibold">X request safety guardrails</h3>
              <p className="text-xs text-muted-foreground">
                Effective runtime values are read-only here. Change environment overrides only when operational
                metrics show sustained headroom; changes require a restart.
              </p>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">Sustained request budget</dt>
                <dd className="font-medium">
                  {diagnostics.scraperMaxRequestsPerWindow ?? '—'} per{' '}
                  {diagnostics.scraperWindowMs ? Math.round(diagnostics.scraperWindowMs / 60_000) : '—'} minutes
                </dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">Request spacing</dt>
                <dd className="font-medium">
                  {diagnostics.scraperMinGapMs ?? '—'}ms + up to {diagnostics.scraperJitterMs ?? '—'}ms jitter
                </dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">Source schedule jitter</dt>
                <dd className="font-medium">±{diagnostics.schedulerJitterPercent ?? '—'}%</dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">429 cooldown range</dt>
                <dd className="font-medium">
                  {diagnostics.scraperCooldownBaseMs ? Math.round(diagnostics.scraperCooldownBaseMs / 1000) : '—'}s–
                  {diagnostics.scraperCooldownMaxMs ? Math.round(diagnostics.scraperCooldownMaxMs / 60_000) : '—'}m
                </dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">Maximum sources per sweep</dt>
                <dd className="font-medium">{diagnostics.schedulerMaxSourcesPerSweep ?? '—'}</dd>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">Fetch concurrency</dt>
                <dd className="font-medium">{diagnostics.fetchConcurrency ?? '—'}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function TwitterSettingsSection({
  value,
  setValue,
  cookieHealth,
  busy,
  onSubmit,
}: {
  value: TwitterConfig;
  setValue: Dispatch<SetStateAction<TwitterConfig>>;
  cookieHealth: CookieHealthStatus | null;
  busy: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Twitter Credentials</CardTitle>
        <CardDescription>Secrets are write-only; saved values are never returned. Backup cookies are used when the primary slot fails authentication.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 border-t pt-4">
        {cookieHealth ? (
          <div className="rounded-md border p-3 text-sm" data-testid="twitter-cookie-health">
            <p className="font-semibold">Cookie health</p>
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <div>Primary: {cookieHealth.primaryConfigured ? 'Configured' : 'Missing'}</div>
              <div>Backup: {cookieHealth.backupConfigured ? 'Configured' : 'Missing'}</div>
              <div>Active slot: {cookieHealth.active || 'Unknown'}</div>
              <div>Last success: {formatCookieTimestamp(cookieHealth.lastSuccessAt)}</div>
              <div>Last auth failure: {formatCookieTimestamp(cookieHealth.lastAuthenticationFailureAt)}</div>
              <div>Failure category: {cookieHealth.lastAuthenticationFailureCategory || 'None'}</div>
            </dl>
          </div>
        ) : null}
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
          <div>
            <Label htmlFor="twitter-auth-token">Auth token</Label>
            <Input
              id="twitter-auth-token"
              type="password"
              value={value.authToken}
              placeholder={value.hasAuthToken ? 'Saved — enter to replace' : ''}
              onChange={(event) => setValue((current) => ({ ...current, authToken: event.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="twitter-ct0">ct0</Label>
            <Input
              id="twitter-ct0"
              type="password"
              value={value.ct0}
              placeholder={value.hasCt0 ? 'Saved — enter to replace' : ''}
              onChange={(event) => setValue((current) => ({ ...current, ct0: event.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="twitter-backup-auth-token">Backup auth token</Label>
            <Input
              id="twitter-backup-auth-token"
              type="password"
              value={value.backupAuthToken || ''}
              placeholder={value.hasBackupAuthToken ? 'Saved — enter to replace' : ''}
              onChange={(event) => setValue((current) => ({ ...current, backupAuthToken: event.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="twitter-backup-ct0">Backup ct0</Label>
            <Input
              id="twitter-backup-ct0"
              type="password"
              value={value.backupCt0 || ''}
              placeholder={value.hasBackupCt0 ? 'Saved — enter to replace' : ''}
              onChange={(event) => setValue((current) => ({ ...current, backupCt0: event.target.value }))}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              <Save className="mr-2 h-4 w-4" />
              Save Twitter credentials
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const AI_TEXT_CAPABILITY_OPTIONS = [
  { key: 'cleanup' as const, label: 'Cleanup / rewrite' },
  { key: 'translation' as const, label: 'Translation' },
  { key: 'summarization' as const, label: 'Summarization' },
  { key: 'hashtags' as const, label: 'Hashtag suggestions' },
];

export function AiSettingsSection({
  value,
  setValue,
  busy,
  onSubmit,
  onPreviewText,
}: {
  value: AIConfig;
  setValue: Dispatch<SetStateAction<AIConfig>>;
  busy: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onPreviewText(capability: 'translation' | 'summarization' | 'cleanup' | 'hashtags', text: string): Promise<{ enabled: boolean; output?: string }>;
}) {
  const [previewCapability, setPreviewCapability] = useState<(typeof AI_TEXT_CAPABILITY_OPTIONS)[number]['key']>('cleanup');
  const [previewText, setPreviewText] = useState('Example post that could use a light cleanup.');
  const [previewOutput, setPreviewOutput] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const anyTextEnabled = AI_TEXT_CAPABILITY_OPTIONS.some((option) => value.textCapabilities[option.key].enabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI</CardTitle>
        <CardDescription>
          Image alt text and optional text transforms. Text capabilities are off by default and apply in order: cleanup, translation, summarization, hashtags.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 border-t pt-4">
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Enable AI image alt text
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ai-provider">Provider</Label>
              <select
                id="ai-provider"
                className="h-10 w-full rounded-md border bg-background px-3"
                value={value.provider}
                onChange={(event) => setValue((current) => ({ ...current, provider: event.target.value as AIConfig['provider'] }))}
              >
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <Label htmlFor="ai-api-key">API key</Label>
              <Input
                id="ai-api-key"
                type="password"
                value={value.apiKey || ''}
                placeholder={value.hasApiKey ? 'Saved — enter to replace' : ''}
                onChange={(event) => setValue((current) => ({ ...current, apiKey: event.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="ai-model">Model</Label>
              <Input id="ai-model" value={value.model || ''} onChange={(event) => setValue((current) => ({ ...current, model: event.target.value }))} />
            </div>
            <div>
              <Label htmlFor="ai-max-alt">Maximum alt text characters</Label>
              <Input
                id="ai-max-alt"
                type="number"
                value={value.maxAltTextChars}
                onChange={(event) => setValue((current) => ({ ...current, maxAltTextChars: Number(event.target.value) }))}
              />
            </div>
          </div>
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-semibold">Text capabilities</legend>
            <p className="text-xs text-muted-foreground">
              Post text is sent to the provider only for enabled capabilities. Failures skip that step and continue posting.
            </p>
            {AI_TEXT_CAPABILITY_OPTIONS.map((option) => (
              <label key={option.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={value.textCapabilities[option.key].enabled}
                  onChange={(event) =>
                    setValue((current) => ({
                      ...current,
                      textCapabilities: {
                        ...current.textCapabilities,
                        [option.key]: {
                          ...current.textCapabilities[option.key],
                          enabled: event.target.checked,
                        },
                      },
                    }))
                  }
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {value.textCapabilities[option.key].privacyDescription}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={busy}>
            <Save className="mr-2 h-4 w-4" />
            Save AI settings
          </Button>
        </form>
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <p className="text-sm font-semibold">Preview text capability</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="ai-preview-capability">Capability</Label>
              <select
                id="ai-preview-capability"
                className="h-10 w-full rounded-md border bg-background px-3"
                value={previewCapability}
                onChange={(event) => setPreviewCapability(event.target.value as typeof previewCapability)}
              >
                {AI_TEXT_CAPABILITY_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ai-preview-text">Sample text</Label>
              <Input id="ai-preview-text" value={previewText} onChange={(event) => setPreviewText(event.target.value)} />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || previewBusy || !anyTextEnabled}
            onClick={() => {
              setPreviewBusy(true);
              void onPreviewText(previewCapability, previewText)
                .then((result) => setPreviewOutput(result.enabled ? result.output || '(empty response)' : 'Capability disabled'))
                .catch((error: unknown) => setPreviewOutput(error instanceof Error ? error.message : 'Preview failed'))
                .finally(() => setPreviewBusy(false));
            }}
          >
            {previewBusy ? 'Previewing…' : 'Run preview'}
          </Button>
          {previewOutput ? <p className="whitespace-pre-wrap text-sm" data-testid="ai-text-preview-output">{previewOutput}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function NotificationsSection({
  value,
  setValue,
  busy,
  onSubmit,
  onTest,
}: {
  value: NotificationSettings;
  setValue: Dispatch<SetStateAction<NotificationSettings>>;
  busy: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onTest(): void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook Notifications</CardTitle>
        <CardDescription>Send selected operational events to an HTTPS endpoint. The URL and signing secret are never returned by the API.</CardDescription>
      </CardHeader>
      <CardContent className="border-t pt-4">
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Enable notifications
          </label>
          <div>
            <Label htmlFor="notification-url">Webhook URL</Label>
            <Input
              id="notification-url"
              type="url"
              value={value.webhookUrl}
              placeholder={value.webhookConfigured ? 'Saved — enter to replace' : 'https://'}
              onChange={(event) => setValue((current) => ({ ...current, webhookUrl: event.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="notification-secret">Webhook secret</Label>
            <Input
              id="notification-secret"
              type="password"
              value={value.webhookSecret}
              placeholder={value.secretConfigured ? 'Saved — enter to replace' : ''}
              onChange={(event) => setValue((current) => ({ ...current, webhookSecret: event.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.allowPrivate}
              onChange={(event) => setValue((current) => ({ ...current, allowPrivate: event.target.checked }))}
            />
            Allow private-network targets
          </label>
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-semibold">Events</legend>
            {NOTIFICATION_EVENT_OPTIONS.map((option) => (
              <label key={option.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={value.events[option.key]}
                  onChange={(event) =>
                    setValue((current) => ({
                      ...current,
                      events: { ...current.events, [option.key]: event.target.checked },
                    }))
                  }
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              <Save className="mr-2 h-4 w-4" />
              Save notifications
            </Button>
            <Button type="button" variant="outline" disabled={busy || !value.enabled} onClick={onTest}>
              Send test notification
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function UsersSection({ users, form, setForm, editingId, busy, onCreate, onEdit, onDelete }: { users: ManagedUser[]; form: UserFormState; setForm: Dispatch<SetStateAction<UserFormState>>; editingId: string | null; busy: boolean; onCreate(event: FormEvent<HTMLFormElement>): void; onEdit(user: ManagedUser): void; onDelete(user: ManagedUser): void }) {
  return <Card><CardHeader><CardTitle>User Access Manager</CardTitle><CardDescription>Create users and review destination access.</CardDescription></CardHeader><CardContent className="space-y-5 border-t pt-4"><form className="grid gap-3 sm:grid-cols-2" onSubmit={onCreate}><div><Label htmlFor="new-user-name">Username</Label><Input id="new-user-name" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} /></div><div><Label htmlFor="new-user-email">Email</Label><Input id="new-user-email" type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></div><div><Label htmlFor="new-user-password">Password</Label><Input id="new-user-password" type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} required /></div><label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={form.isAdmin} onChange={(event) => setForm((current) => ({ ...current, isAdmin: event.target.checked }))} />Administrator</label><Button type="submit" disabled={busy}><Plus className="mr-2 h-4 w-4" />Create user</Button></form><div className="space-y-2">{users.length === 0 ? <p className="text-sm text-muted-foreground">No additional users.</p> : null}{users.map((user) => <div key={user.id} className="flex items-center justify-between rounded-md border p-3"><div><p className="font-medium">{user.username || user.email}</p><p className="text-xs text-muted-foreground">{user.role} · {user.mappingCount} destinations</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => onEdit(user)}>{editingId === user.id ? 'Editing' : 'Edit'}</Button><Button size="sm" variant="destructive" onClick={() => onDelete(user)}><Trash2 className="h-3.5 w-3.5" /><span className="sr-only">Delete {user.username || user.email}</span></Button></div></div>)}</div></CardContent></Card>;
}

export function DataManagementSection({ busy, onExport, onImport, onBackup, onRestore }: { busy: boolean; onExport(): void; onImport(): void; onBackup(mode: 'redacted' | 'full'): void; onRestore(): void }) {
  return <Card><CardHeader><CardTitle>Data Management</CardTitle><CardDescription>Export/import mappings and provider settings, or create and restore backups.</CardDescription></CardHeader><CardContent className="grid gap-3 border-t pt-4 sm:grid-cols-2"><Button variant="outline" onClick={onExport} disabled={busy}><Download className="mr-2 h-4 w-4" />Export configuration</Button><Button variant="outline" onClick={onImport} disabled={busy}><Upload className="mr-2 h-4 w-4" />Import configuration</Button><Button variant="outline" onClick={() => onBackup('redacted')} disabled={busy}><Download className="mr-2 h-4 w-4" />Create redacted backup</Button><Button variant="outline" onClick={() => onBackup('full')} disabled={busy}><Download className="mr-2 h-4 w-4" />Create full backup</Button><Button variant="destructive" onClick={onRestore} disabled={busy}><Upload className="mr-2 h-4 w-4" />Restore backup</Button></CardContent></Card>;
}
