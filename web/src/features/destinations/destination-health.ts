import type { AccountMapping } from './types';

export type HealthSeverity = 'healthy' | 'warning' | 'danger' | 'neutral';

export interface DestinationHealthSummary {
  severity: HealthSeverity;
  label: string;
  detail?: string;
}

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
  const sourceIssue = mapping.sources?.find((source) => source.runtime?.lastErrorCategory);
  if (sourceIssue?.runtime?.lastErrorCategory) {
    return {
      severity: 'warning',
      label: 'Source issue',
      detail: `@${sourceIssue.username}: ${sourceIssue.runtime.lastErrorMessage || sourceIssue.runtime.lastErrorCategory}`,
    };
  }
  if (mapping.migrationReview?.needsAdminReview) {
    return { severity: 'warning', label: 'Needs review' };
  }
  if (mapping.queue?.pending) {
    return { severity: 'neutral', label: `${mapping.queue.pending} queued` };
  }
  return { severity: 'healthy', label: 'Healthy' };
}
