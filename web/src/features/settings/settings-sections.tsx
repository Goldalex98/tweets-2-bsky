import { Download, Loader2, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import { type Dispatch, type FormEvent, type SetStateAction, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  estimateChecksPerHour,
  MAX_CHECK_INTERVAL_MINUTES,
  MIN_CHECK_INTERVAL_MINUTES,
  parseCheckIntervalMinutes,
} from '../../lib/dashboard-utils';
import type { SchedulerSettings } from '../status/types';
import type {
  AccountSecurityEmailState,
  AccountSecurityPasswordState,
  AIConfig,
  AuthUser,
  ManagedUser,
  NotificationSettings,
  RuntimeVersionInfo,
  TwitterConfig,
  UpdateStatusInfo,
  UserFormState,
  UserPermissions,
} from './types';
import { PERMISSION_OPTIONS } from './utils';

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
}: {
  value: SchedulerSettings;
  setValue: Dispatch<SetStateAction<SchedulerSettings | null>>;
  saving: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduler</CardTitle>
        <CardDescription>Controls automatic fetch sweeps. Manual operations remain available while disabled.</CardDescription>
      </CardHeader>
      <CardContent className="border-t pt-4">
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
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
                : `${MIN_CHECK_INTERVAL_MINUTES}-${MAX_CHECK_INTERVAL_MINUTES} minutes. ${value.enabledSourceCount} enabled source${value.enabledSourceCount === 1 ? '' : 's'} means about ${checksPerHour} X check${checksPerHour === 1 ? '' : 's'} per hour.`}
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
      </CardContent>
    </Card>
  );
}

export function TwitterSettingsSection({ value, setValue, busy, onSubmit }: { value: TwitterConfig; setValue: Dispatch<SetStateAction<TwitterConfig>>; busy: boolean; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  return <Card><CardHeader><CardTitle>Twitter Credentials</CardTitle><CardDescription>Secrets are write-only; saved values are never returned.</CardDescription></CardHeader><CardContent className="border-t pt-4"><form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}><div><Label htmlFor="twitter-auth-token">Auth token</Label><Input id="twitter-auth-token" type="password" value={value.authToken} placeholder={value.hasAuthToken ? 'Saved — enter to replace' : ''} onChange={(event) => setValue((current) => ({ ...current, authToken: event.target.value }))} /></div><div><Label htmlFor="twitter-ct0">ct0</Label><Input id="twitter-ct0" type="password" value={value.ct0} placeholder={value.hasCt0 ? 'Saved — enter to replace' : ''} onChange={(event) => setValue((current) => ({ ...current, ct0: event.target.value }))} /></div><Button type="submit" disabled={busy}><Save className="mr-2 h-4 w-4" />Save Twitter credentials</Button></form></CardContent></Card>;
}

export function AiSettingsSection({ value, setValue, busy, onSubmit }: { value: AIConfig; setValue: Dispatch<SetStateAction<AIConfig>>; busy: boolean; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  return <Card><CardHeader><CardTitle>Image Alt Text</CardTitle><CardDescription>Provider access is scoped to configured capabilities.</CardDescription></CardHeader><CardContent className="border-t pt-4"><form className="space-y-4" onSubmit={onSubmit}><label className="flex items-center gap-2"><input type="checkbox" checked={value.enabled} onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))} />Enable AI image alt text</label><div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="ai-provider">Provider</Label><select id="ai-provider" className="h-10 w-full rounded-md border bg-background px-3" value={value.provider} onChange={(event) => setValue((current) => ({ ...current, provider: event.target.value as AIConfig['provider'] }))}><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="custom">Custom</option></select></div><div><Label htmlFor="ai-api-key">API key</Label><Input id="ai-api-key" type="password" value={value.apiKey || ''} placeholder={value.hasApiKey ? 'Saved — enter to replace' : ''} onChange={(event) => setValue((current) => ({ ...current, apiKey: event.target.value }))} /></div><div><Label htmlFor="ai-model">Model</Label><Input id="ai-model" value={value.model || ''} onChange={(event) => setValue((current) => ({ ...current, model: event.target.value }))} /></div><div><Label htmlFor="ai-max-alt">Maximum alt text characters</Label><Input id="ai-max-alt" type="number" value={value.maxAltTextChars} onChange={(event) => setValue((current) => ({ ...current, maxAltTextChars: Number(event.target.value) }))} /></div></div><Button type="submit" disabled={busy}><Save className="mr-2 h-4 w-4" />Save image alt text</Button></form></CardContent></Card>;
}

export function NotificationsSection({ value, setValue, busy, onSubmit }: { value: NotificationSettings; setValue: Dispatch<SetStateAction<NotificationSettings>>; busy: boolean; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  return <Card><CardHeader><CardTitle>Webhook Notifications</CardTitle><CardDescription>Send selected operational events to an HTTPS endpoint.</CardDescription></CardHeader><CardContent className="border-t pt-4"><form className="space-y-4" onSubmit={onSubmit}><label className="flex items-center gap-2"><input type="checkbox" checked={value.enabled} onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))} />Enable notifications</label><Label htmlFor="notification-url">Webhook URL</Label><Input id="notification-url" type="url" value={value.webhookUrl} placeholder={value.webhookConfigured ? 'Saved — enter to replace' : 'https://'} onChange={(event) => setValue((current) => ({ ...current, webhookUrl: event.target.value }))} /><Label htmlFor="notification-secret">Webhook secret</Label><Input id="notification-secret" type="password" value={value.webhookSecret} placeholder={value.secretConfigured ? 'Saved — enter to replace' : ''} onChange={(event) => setValue((current) => ({ ...current, webhookSecret: event.target.value }))} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.allowPrivate} onChange={(event) => setValue((current) => ({ ...current, allowPrivate: event.target.checked }))} />Allow private-network targets</label><Button type="submit" disabled={busy}><Save className="mr-2 h-4 w-4" />Save notifications</Button></form></CardContent></Card>;
}

export function UsersSection({ users, form, setForm, editingId, busy, onCreate, onEdit, onDelete }: { users: ManagedUser[]; form: UserFormState; setForm: Dispatch<SetStateAction<UserFormState>>; editingId: string | null; busy: boolean; onCreate(event: FormEvent<HTMLFormElement>): void; onEdit(user: ManagedUser): void; onDelete(user: ManagedUser): void }) {
  return <Card><CardHeader><CardTitle>User Access Manager</CardTitle><CardDescription>Create users and review destination access.</CardDescription></CardHeader><CardContent className="space-y-5 border-t pt-4"><form className="grid gap-3 sm:grid-cols-2" onSubmit={onCreate}><div><Label htmlFor="new-user-name">Username</Label><Input id="new-user-name" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} /></div><div><Label htmlFor="new-user-email">Email</Label><Input id="new-user-email" type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></div><div><Label htmlFor="new-user-password">Password</Label><Input id="new-user-password" type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} required /></div><label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={form.isAdmin} onChange={(event) => setForm((current) => ({ ...current, isAdmin: event.target.checked }))} />Administrator</label><Button type="submit" disabled={busy}><Plus className="mr-2 h-4 w-4" />Create user</Button></form><div className="space-y-2">{users.length === 0 ? <p className="text-sm text-muted-foreground">No additional users.</p> : null}{users.map((user) => <div key={user.id} className="flex items-center justify-between rounded-md border p-3"><div><p className="font-medium">{user.username || user.email}</p><p className="text-xs text-muted-foreground">{user.role} · {user.mappingCount} destinations</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => onEdit(user)}>{editingId === user.id ? 'Editing' : 'Edit'}</Button><Button size="sm" variant="destructive" onClick={() => onDelete(user)}><Trash2 className="h-3.5 w-3.5" /><span className="sr-only">Delete {user.username || user.email}</span></Button></div></div>)}</div></CardContent></Card>;
}

export function DataManagementSection({ busy, onExport, onImport, onBackup, onRestore }: { busy: boolean; onExport(): void; onImport(): void; onBackup(mode: 'redacted' | 'full'): void; onRestore(): void }) {
  return <Card><CardHeader><CardTitle>Data Management</CardTitle><CardDescription>Export/import mappings and provider settings, or create and restore backups.</CardDescription></CardHeader><CardContent className="grid gap-3 border-t pt-4 sm:grid-cols-2"><Button variant="outline" onClick={onExport} disabled={busy}><Download className="mr-2 h-4 w-4" />Export configuration</Button><Button variant="outline" onClick={onImport} disabled={busy}><Upload className="mr-2 h-4 w-4" />Import configuration</Button><Button variant="outline" onClick={() => onBackup('redacted')} disabled={busy}><Download className="mr-2 h-4 w-4" />Create redacted backup</Button><Button variant="outline" onClick={() => onBackup('full')} disabled={busy}><Download className="mr-2 h-4 w-4" />Create full backup</Button><Button variant="destructive" onClick={onRestore} disabled={busy}><Upload className="mr-2 h-4 w-4" />Restore backup</Button></CardContent></Card>;
}
