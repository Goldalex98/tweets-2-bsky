import { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import type { BlueskyAccountView } from '../bluesky-accounts/types';
import { BlueskyAccountSelect } from './bluesky-account-select';
import type { AccountMapping } from './types';

interface DestinationAccountCardProps {
  mapping: AccountMapping;
  /** Managed accounts that are unlinked, plus this destination's own account. */
  accounts?: readonly BlueskyAccountView[];
  canChangeAccount?: boolean;
  busy?: boolean;
  onManageAccount(): void;
  onChangeAccount?(accountId: string): void;
}

function formatEpoch(value?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toLocaleString();
}

function accountHealthLabel(lastErrorCategory?: string, credentialConfigured?: boolean): {
  label: string;
  variant: 'success' | 'warning' | 'danger' | 'outline';
} {
  if (lastErrorCategory === 'did-mismatch') return { label: 'DID mismatch', variant: 'danger' };
  if (lastErrorCategory === 'bsky-auth') return { label: 'Auth issue', variant: 'danger' };
  if (lastErrorCategory) return { label: 'Health issue', variant: 'danger' };
  if (credentialConfigured) return { label: 'Ready', variant: 'success' };
  return { label: 'Missing password', variant: 'warning' };
}

function AccountSwitcher({
  mapping,
  accounts,
  busy,
  onChangeAccount,
}: {
  mapping: AccountMapping;
  accounts: readonly BlueskyAccountView[];
  busy?: boolean;
  onChangeAccount(accountId: string): void;
}) {
  const linkedId = mapping.bskyAccountId ?? '';
  const [selected, setSelected] = useState(linkedId);

  useEffect(() => {
    setSelected(linkedId);
  }, [linkedId]);

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <Label htmlFor="destination-bsky-account">Posting account</Label>
      <p id="destination-bsky-account-hint" className="text-xs text-muted-foreground">
        Accounts are added and their app passwords rotated in Settings → Bluesky accounts. Only accounts that are not
        already linked to another destination can be chosen. Mirror history stays with this destination, so a newly
        linked account receives future posts only.
      </p>
      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No managed Bluesky accounts are available. Add one in Settings → Bluesky accounts first.
        </p>
      ) : (
        <div className="space-y-2">
          <BlueskyAccountSelect
            id="destination-bsky-account"
            describedById="destination-bsky-account-hint"
            accounts={accounts}
            value={selected}
            disabled={busy}
            onChange={setSelected}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || selected === '' || selected === linkedId}
            onClick={() => onChangeAccount(selected)}
          >
            {linkedId ? 'Switch account' : 'Link account'}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DestinationAccountCard(props: DestinationAccountCardProps) {
  const { mapping, onManageAccount } = props;
  const account = mapping.blueskyAccount;
  const onChangeAccount = props.onChangeAccount;
  const switcher =
    props.canChangeAccount && onChangeAccount ? (
      <AccountSwitcher
        mapping={mapping}
        accounts={props.accounts ?? []}
        busy={props.busy}
        onChangeAccount={onChangeAccount}
      />
    ) : null;

  if (account) {
    const handle = account.canonicalHandle || account.loginIdentifier;
    const health = accountHealthLabel(account.health?.lastErrorCategory, account.credentialConfigured);
    const lastValidated = formatEpoch(account.health?.lastValidatedAt);
    const lastSuccess = formatEpoch(account.health?.lastSuccessAt);
    return (
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold">Linked Bluesky account</p>
            <p className="text-sm text-muted-foreground">
              App passwords are never shown here. Manage credentials in Settings → Bluesky accounts.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={account.credentialConfigured ? 'success' : 'warning'}>
              {account.credentialConfigured ? 'Credential saved' : 'Missing password'}
            </Badge>
            <Badge variant={health.variant}>{health.label}</Badge>
          </div>
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Handle</dt>
            <dd className="font-medium">@{handle}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Service URL</dt>
            <dd className="break-all">{account.serviceUrl}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">DID</dt>
            <dd className="break-all">{account.did || 'DID not resolved yet'}</dd>
          </div>
          {account.label ? (
            <div>
              <dt className="text-xs text-muted-foreground">Label</dt>
              <dd>{account.label}</dd>
            </div>
          ) : null}
          {lastValidated ? (
            <div>
              <dt className="text-xs text-muted-foreground">Last validated</dt>
              <dd>{lastValidated}</dd>
            </div>
          ) : null}
          {lastSuccess ? (
            <div>
              <dt className="text-xs text-muted-foreground">Last success</dt>
              <dd>{lastSuccess}</dd>
            </div>
          ) : null}
        </dl>
        {switcher}
        <Button type="button" variant="outline" size="sm" onClick={onManageAccount}>
          Manage in Settings
        </Button>
      </div>
    );
  }

  if (mapping.bskyAccountId) {
    return (
      <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
        <div>
          <p className="font-semibold">Linked account record missing</p>
          <p className="text-sm text-muted-foreground">
            This destination references account <code className="text-xs">{mapping.bskyAccountId}</code>, but that
            managed account could not be loaded. Open Settings → Bluesky accounts to repair it, or link this
            destination to a different account below.
          </p>
        </div>
        {switcher}
        <Button type="button" variant="outline" size="sm" onClick={onManageAccount}>
          Manage in Settings
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <p className="font-semibold">Legacy destination identity</p>
        <p className="text-sm text-muted-foreground">
          This destination uses a legacy inline credential and is not linked to a managed Bluesky account. Add the
          account under Settings → Bluesky accounts, then link it below so its password is managed there. App
          passwords are never displayed in this editor.
        </p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Identifier</dt>
          <dd className="font-medium">@{mapping.bskyIdentifier}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Service URL</dt>
          <dd className="break-all">{mapping.bskyServiceUrl || 'https://bsky.social'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">DID</dt>
          <dd className="break-all">{mapping.bskyDid || 'DID not resolved yet'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Credential</dt>
          <dd>
            <Badge variant={mapping.credentialConfigured === false ? 'warning' : 'success'}>
              {mapping.credentialConfigured === false ? 'Missing' : 'Configured'}
            </Badge>
          </dd>
        </div>
      </dl>
      {switcher}
      <Button type="button" variant="outline" size="sm" onClick={onManageAccount}>
        Open Bluesky accounts
      </Button>
    </div>
  );
}
