import { describe, expect, test } from 'bun:test';
import { summarizeDestinationHealth } from '../../web/src/features/destinations/destination-health';
import type { AccountMapping } from '../../web/src/features/destinations/types';
import { defaultMappingForm } from '../../web/src/lib/dashboard-utils';

function mapping(patch: Partial<AccountMapping> = {}): AccountMapping {
  const form = defaultMappingForm();
  return {
    revision: 3,
    updatedAt: '2026-07-24T20:00:00.000Z',
    id: 'destination-1',
    twitterUsernames: ['alpha'],
    pausedTwitterUsernames: [],
    bskyIdentifier: 'aggregate.bsky.social',
    bskyServiceUrl: 'https://bsky.social',
    enabled: true,
    destinationState: 'enabled',
    credentialConfigured: true,
    postingPolicy: form.postingPolicy,
    aiOverrides: form.aiOverrides,
    moderationPolicy: {
      blockKeywords: [],
      blockDomains: [],
      blockSourceUsernames: [],
      blockSensitive: false,
      dryRun: false,
    },
    duplicateSuppression: { enabled: false },
    profileManagement: form.profileManagement,
    ...patch,
  } as AccountMapping;
}

describe('summarizeDestinationHealth', () => {
  test('missing credentialConfigured is danger', () => {
    const summary = summarizeDestinationHealth(mapping({ credentialConfigured: false }));
    expect(summary).toMatchObject({ severity: 'danger', label: 'Missing credential' });
  });

  test('an omitted credentialConfigured field does not imply missing credential', () => {
    const summary = summarizeDestinationHealth(mapping({ credentialConfigured: undefined }));
    expect(summary.label).not.toBe('Missing credential');
    expect(summary.severity).toBe('healthy');
  });

  test('DID mismatch on the linked account is danger', () => {
    const summary = summarizeDestinationHealth(
      mapping({
        blueskyAccount: {
          id: 'acct-1',
          loginIdentifier: 'aggregate.bsky.social',
          serviceUrl: 'https://bsky.social',
          credentialConfigured: true,
          health: { lastErrorCategory: 'did-mismatch', consecutiveFailures: 1 },
        },
      }),
    );
    expect(summary).toMatchObject({ severity: 'danger', label: 'DID mismatch' });
  });

  test('paused beats a failed queue', () => {
    const summary = summarizeDestinationHealth(
      mapping({
        enabled: false,
        destinationState: 'paused',
        queue: {
          mapping_id: 'destination-1',
          bsky_identifier: 'aggregate.bsky.social',
          pending: 0,
          failed: 3,
          processing: 0,
          oldest_enqueued_at: null,
        },
      }),
    );
    expect(summary.label).toBe('Paused');
  });

  test('failed queue is reported', () => {
    const summary = summarizeDestinationHealth(
      mapping({
        queue: {
          mapping_id: 'destination-1',
          bsky_identifier: 'aggregate.bsky.social',
          pending: 0,
          failed: 2,
          processing: 0,
          oldest_enqueued_at: null,
        },
      }),
    );
    expect(summary.label).toBe('2 failed');
  });

  test('missing credential beats a source issue', () => {
    const summary = summarizeDestinationHealth(
      mapping({
        credentialConfigured: false,
        sources: [
          {
            username: 'alpha',
            state: 'enabled',
            runtime: {
              consecutiveFailures: 1,
              lastErrorCategory: 'x-rate-limit',
              lastErrorMessage: 'rate limited',
            },
          },
        ],
      }),
    );
    expect(summary.label).toBe('Missing credential');
  });

  test('a healthy linked destination is healthy', () => {
    const summary = summarizeDestinationHealth(
      mapping({
        bskyAccountId: 'acct-1',
        blueskyAccount: {
          id: 'acct-1',
          loginIdentifier: 'aggregate.bsky.social',
          serviceUrl: 'https://bsky.social',
          credentialConfigured: true,
          health: { consecutiveFailures: 0 },
        },
      }),
    );
    expect(summary).toMatchObject({ severity: 'healthy', label: 'Healthy' });
  });
});
