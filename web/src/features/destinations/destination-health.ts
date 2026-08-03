import type { BadgeProps } from '../../components/ui/badge';
import type { AccountMapping } from './types';

export type HealthSeverity = 'healthy' | 'warning' | 'danger' | 'neutral';

export interface DestinationHealthSummary {
  severity: HealthSeverity;
  label: string;
  detail?: string;
}

export const HEALTH_BADGE_VARIANT: Record<HealthSeverity, NonNullable<BadgeProps['variant']>> = {
  healthy: 'success',
  warning: 'warning',
  danger: 'danger',
  neutral: 'outline',
};

export function summarizeDestinationHealth(mapping: AccountMapping): DestinationHealthSummary {
  if (mapping.destinationState === 'paused' || !mapping.enabled) {
    return { severity: 'warning', label: 'Paused' };
  }
  if (mapping.queue?.failed) {
    return {
      severity: 'danger',
      label: `${mapping.queue.failed} failed`,
      detail: 'Open Activity to retry or inspect failed deliveries.',
    };
  }
  if (mapping.runtime?.lastErrorCategory?.includes('auth') || mapping.runtime?.lastErrorCategory === 'bsky-auth') {
    return {
      severity: 'danger',
      label: 'Auth issue',
      detail: mapping.runtime.lastErrorMessage || 'Bluesky authentication failed.',
    };
  }
  // Strict === false so older servers that omit the field do not trigger this.
  if (mapping.credentialConfigured === false) {
    return {
      severity: 'danger',
      label: 'Missing credential',
      detail: 'Add an app password in Settings → Bluesky accounts.',
    };
  }
  if (mapping.blueskyAccount?.health?.lastErrorCategory === 'did-mismatch') {
    const handle =
      mapping.blueskyAccount.canonicalHandle || mapping.blueskyAccount.loginIdentifier || mapping.bskyIdentifier;
    return {
      severity: 'danger',
      label: 'DID mismatch',
      detail: `Account @${handle} resolved a different DID than expected.`,
    };
  }
  const sourceIssue = mapping.sources?.find((source) => source.runtime?.lastErrorCategory);
  if (sourceIssue?.runtime?.lastErrorCategory) {
    return {
      severity: 'warning',
      label: 'Source issue',
      detail: `@${sourceIssue.username}: ${sourceIssue.runtime.lastErrorMessage || sourceIssue.runtime.lastErrorCategory}`,
    };
  }
  if (mapping.queue?.pending) {
    return { severity: 'neutral', label: `${mapping.queue.pending} queued` };
  }
  return { severity: 'healthy', label: 'Healthy' };
}
