import { selectClassName } from '../../lib/dashboard-utils';
import type { BlueskyAccountView } from '../bluesky-accounts/types';

interface BlueskyAccountSelectProps {
  id: string;
  accounts: readonly BlueskyAccountView[];
  value: string;
  disabled?: boolean;
  placeholder?: string;
  describedById?: string;
  onChange(accountId: string): void;
}

export function describeBlueskyAccount(account: BlueskyAccountView): string {
  const handle = account.canonicalHandle || account.loginIdentifier;
  const label = account.label ? ` — ${account.label}` : '';
  const credential = account.credentialConfigured ? '' : ' (missing app password)';
  return `@${handle}${label}${credential}`;
}

export function BlueskyAccountSelect(props: BlueskyAccountSelectProps) {
  return (
    <select
      id={props.id}
      className={selectClassName}
      value={props.value}
      disabled={props.disabled}
      aria-describedby={props.describedById}
      onChange={(event) => props.onChange(event.target.value)}
    >
      <option value="">{props.placeholder ?? 'Select a Bluesky account…'}</option>
      {props.accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {describeBlueskyAccount(account)}
        </option>
      ))}
    </select>
  );
}
