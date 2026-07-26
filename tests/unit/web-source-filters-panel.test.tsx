import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceFiltersPanel } from '../../web/src/features/destinations/source-filters-panel';
import { pickSelectedUsername } from '../../web/src/features/destinations/source-selection';
import type { AccountMapping, SourceFilterPolicy } from '../../web/src/features/destinations/types';
import { EditDestinationDialog } from '../../web/src/features/destinations/edit-destination-dialog';
import { defaultMappingForm } from '../../web/src/lib/dashboard-utils';

const DEFAULT_FILTERS: SourceFilterPolicy = {
  originalPosts: true,
  selfReplies: true,
  externalReplies: false,
  quotes: true,
  reposts: false,
  mediaOnly: false,
  includeKeywords: [],
  excludeKeywords: [],
  languages: [],
  sensitiveContent: 'mirror',
};

const mappingWithSources = (usernames: string[]): AccountMapping =>
  ({
    revision: 3,
    updatedAt: '2026-07-24T20:00:00.000Z',
    id: 'destination-1',
    twitterUsernames: usernames,
    pausedTwitterUsernames: [],
    bskyIdentifier: 'aggregate.bsky.social',
    bskyServiceUrl: 'https://bsky.social',
    enabled: true,
    credentialConfigured: true,
    sources: usernames.map((username, index) => ({
      username,
      routeId: `route-${index}`,
      state: 'enabled' as const,
      filters: {
        ...DEFAULT_FILTERS,
        mediaOnly: username === 'gamma',
      },
    })),
  }) as unknown as AccountMapping;

describe('pickSelectedUsername', () => {
  test('prefers an explicit focus username when present', () => {
    expect(pickSelectedUsername(['alpha', 'gamma'], 'alpha', 'gamma')).toBe('gamma');
  });

  test('keeps the current username when still present', () => {
    expect(pickSelectedUsername(['alpha', 'beta'], 'beta')).toBe('beta');
  });

  test('falls back to the first username when current is removed', () => {
    expect(pickSelectedUsername(['alpha', 'beta'], 'gone')).toBe('alpha');
  });

  test('returns empty string when there are no sources', () => {
    expect(pickSelectedUsername([], 'alpha', 'beta')).toBe('');
  });

  test('normalizes @ prefixes when matching preferred and current', () => {
    expect(pickSelectedUsername(['Alpha', 'beta'], '@beta', '@Beta')).toBe('beta');
    expect(pickSelectedUsername(['Alpha', 'beta'], '@Alpha')).toBe('Alpha');
  });
});

describe('SourceFiltersPanel', () => {
  test('lists every persisted source in the filter select', () => {
    const markup = renderToStaticMarkup(
      <SourceFiltersPanel
        mapping={mappingWithSources(['alpha', 'gamma'])}
        busy={false}
        onSaveFilters={async () => undefined}
        onPreviewFilter={async () => ({ allowed: true, reason: 'allowed' })}
      />,
    );

    expect(markup).toContain('id="source-filter-username"');
    expect(markup).toContain('@alpha');
    expect(markup).toContain('@gamma');
  });

  test('selects the preferred username when provided', () => {
    const markup = renderToStaticMarkup(
      <SourceFiltersPanel
        mapping={mappingWithSources(['alpha', 'gamma'])}
        busy={false}
        selectedUsername="gamma"
        onSaveFilters={async () => undefined}
        onPreviewFilter={async () => ({ allowed: true, reason: 'allowed' })}
      />,
    );

    expect(markup).toContain('value="gamma"');
    // gamma fixture enables mediaOnly; default sources leave it unchecked.
    expect(markup).toMatch(/checked=""[^>]*>\s*Media-only posts/);
  });

  test('shows empty guidance when no sources exist', () => {
    const markup = renderToStaticMarkup(
      <SourceFiltersPanel
        mapping={mappingWithSources([])}
        busy={false}
        onSaveFilters={async () => undefined}
        onPreviewFilter={async () => ({ allowed: true, reason: 'allowed' })}
      />,
    );

    expect(markup).toContain('Add at least one X source before editing filters.');
  });
});

describe('edit destination sources copy', () => {
  test('states that source membership applies immediately', () => {
    const markup = renderToStaticMarkup(
      <EditDestinationDialog
        mapping={mappingWithSources(['alpha'])}
        form={defaultMappingForm()}
        sources={['alpha']}
        sourceInput=""
        parseSummary={{ duplicates: [], invalid: [] }}
        busy={false}
        canReviewMigration={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
        onFormChange={() => undefined}
        onSourceInputChange={() => undefined}
        onAddSources={async () => undefined}
        onRemoveSource={() => undefined}
        onManageAccount={() => undefined}
        onDismissMigrationReview={() => undefined}
        onSaveSourceFilters={async () => undefined}
        onPreviewSourceFilter={async () => ({ allowed: true, reason: 'allowed' })}
        onPreviewPosting={async () => ({ text: 'preview', attributionApplied: false, originalLinkApplied: false })}
        onPreviewProfileSync={() => undefined}
        onApplyProfileSync={() => undefined}
        onQueuePinSync={() => undefined}
        onSaveContentPolicy={async () => undefined}
        onPreviewContentPolicy={async () => ({ allowed: true, reason: 'allowed', trace: [] })}
        onSaveRouteDelivery={async () => undefined}
        initialSection="sources"
      />,
    );

    expect(markup).toContain('Source add/remove applies immediately');
    expect(markup).not.toContain('Source add/remove is applied when you click Save Destination');
    expect(markup).toContain('@alpha');
  });
});
