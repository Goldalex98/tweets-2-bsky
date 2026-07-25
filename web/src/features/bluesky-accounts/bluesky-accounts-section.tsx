import { Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import type { BlueskyAccountFormState, BlueskyAccountView } from './types';

const EMPTY_FORM: BlueskyAccountFormState = {
  loginIdentifier: '',
  appPassword: '',
  serviceUrl: 'https://bsky.social',
  label: '',
};

interface BlueskyAccountsSectionProps {
  accounts: BlueskyAccountView[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  onCreate(form: BlueskyAccountFormState): Promise<unknown>;
  onValidate(account: BlueskyAccountView): Promise<unknown>;
  onRotate(account: BlueskyAccountView, password: string): Promise<unknown>;
  onDelete(account: BlueskyAccountView): Promise<unknown>;
  onManageDestination?(destinationId: string): void;
}

export function BlueskyAccountsSection(props: BlueskyAccountsSectionProps) {
  const [form, setForm] = useState<BlueskyAccountFormState>(EMPTY_FORM);
  const [search, setSearch] = useState('');
  const [rotatePassword, setRotatePassword] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<BlueskyAccountView | null>(null);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return props.accounts;
    return props.accounts.filter((account) =>
      [account.loginIdentifier, account.canonicalHandle, account.label, account.did]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [props.accounts, search]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Bluesky accounts</CardTitle>
          <CardDescription>
            Manage app passwords separately from destination policy. Each account can link to at most one destination.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="bsky-account-identifier">Login identifier</Label>
              <Input
                id="bsky-account-identifier"
                value={form.loginIdentifier}
                onChange={(event) => setForm((current) => ({ ...current, loginIdentifier: event.target.value }))}
                placeholder="handle.bsky.social or email"
              />
            </div>
            <div>
              <Label htmlFor="bsky-account-password">App password</Label>
              <Input
                id="bsky-account-password"
                type="password"
                value={form.appPassword}
                onChange={(event) => setForm((current) => ({ ...current, appPassword: event.target.value }))}
                placeholder="Create in Bluesky settings"
              />
            </div>
            <div>
              <Label htmlFor="bsky-account-label">Label (optional)</Label>
              <Input
                id="bsky-account-label"
                value={form.label}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="bsky-account-service">Service URL</Label>
              <Input
                id="bsky-account-service"
                value={form.serviceUrl}
                onChange={(event) => setForm((current) => ({ ...current, serviceUrl: event.target.value }))}
              />
            </div>
          </div>
          <Button
            disabled={props.busy || !form.loginIdentifier.trim() || !form.appPassword}
            onClick={() => {
              void props.onCreate(form).then(() => setForm(EMPTY_FORM));
            }}
          >
            {props.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Add Bluesky account
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Managed accounts</CardTitle>
              <CardDescription>{props.accounts.length} account{props.accounts.length === 1 ? '' : 's'}</CardDescription>
            </div>
            <Input
              className="max-w-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search accounts"
              aria-label="Search Bluesky accounts"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-3 border-t pt-4">
          {props.error ? <p role="alert" className="text-sm text-red-600">{props.error}</p> : null}
          {props.loading && filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading Bluesky accounts…</p>
          ) : null}
          {filtered.length === 0 && !props.loading ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No Bluesky accounts yet. Add one above, then select it when creating a destination.
            </p>
          ) : null}
          {filtered.map((account) => {
            const handle = account.canonicalHandle || account.loginIdentifier;
            const errorCategory = account.health?.lastErrorCategory;
            const healthLabel = errorCategory
              ? errorCategory === 'did-mismatch'
                ? 'DID mismatch'
                : errorCategory === 'bsky-auth'
                  ? 'Auth issue'
                  : 'Health issue'
              : account.credentialConfigured
                ? 'Ready'
                : 'Missing password';
            const healthDanger = Boolean(errorCategory);
            return (
              <div key={account.id} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">@{handle}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.label ? `${account.label} · ` : ''}
                      {account.serviceUrl}
                      {account.did ? ` · ${account.did}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={account.linkedDestinationId ? 'success' : 'outline'}>
                      {account.linkedDestinationId ? 'Linked' : 'Unlinked'}
                    </Badge>
                    <Badge
                      variant={healthDanger ? 'danger' : account.credentialConfigured ? 'success' : 'warning'}
                    >
                      {healthLabel}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    type="password"
                    value={rotatePassword[account.id] ?? ''}
                    onChange={(event) =>
                      setRotatePassword((current) => ({ ...current, [account.id]: event.target.value }))
                    }
                    placeholder="Saved — enter to rotate app password"
                    aria-label={`Rotate password for @${handle}`}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.busy}
                      onClick={() => void props.onValidate(account)}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.busy || !(rotatePassword[account.id] ?? '').trim()}
                      onClick={() => {
                        const password = rotatePassword[account.id] ?? '';
                        void props.onRotate(account, password).then(() =>
                          setRotatePassword((current) => ({ ...current, [account.id]: '' })),
                        );
                      }}
                    >
                      <Save className="mr-1 h-3.5 w-3.5" />
                      Rotate
                    </Button>
                    {account.linkedDestinationId && props.onManageDestination ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => props.onManageDestination?.(account.linkedDestinationId as string)}
                      >
                        Manage destination
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={props.busy || Boolean(account.linkedDestinationId)}
                      onClick={() => setPendingDelete(account)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove Bluesky account?"
        description={
          pendingDelete
            ? `Remove @${pendingDelete.canonicalHandle || pendingDelete.loginIdentifier}? This only deletes the managed credential.`
            : ''
        }
        confirmLabel="Remove account"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          void props.onDelete(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
