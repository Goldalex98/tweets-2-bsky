import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourcePollingPanel, uniquePollingOptions } from '../../web/src/features/destinations/source-polling-panel';
import type { AccountMapping } from '../../web/src/features/destinations/types';

function mapping(id: string, username: string, mode: 'inherit' | 'adaptive' | 'fixed'): AccountMapping {
  return {
    revision: 4,
    updatedAt: '2026-08-01T12:00:00.000Z',
    id,
    twitterUsernames: [username],
    bskyIdentifier: `${id}.bsky.social`,
    enabled: true,
    sources: [
      {
        username,
        state: 'enabled',
        schedule: {
          mode,
          minIntervalMinutes: 1,
          maxIntervalMinutes: 15,
          fixedIntervalMinutes: 2,
          timezone: 'UTC',
        },
        runtime: {
          lastCheckAt: Date.parse('2026-08-01T11:59:00.000Z'),
          lastFetchSuccessAt: Date.parse('2026-08-01T11:59:00.000Z'),
          lastTweetSeenAt: Date.parse('2026-08-01T11:55:00.000Z'),
          nextEligibleCheckAt: Date.parse('2026-08-01T12:00:00.000Z'),
          consecutiveFailures: 0,
        },
        initialImportMode: 'inherit',
      },
    ],
  } as unknown as AccountMapping;
}

describe('SourcePollingPanel', () => {
  test('shows adaptive bounds, runtime state, and the global wake constraint', () => {
    const sourceMapping = mapping('breaking-news', 'fastwire', 'adaptive');
    const source = sourceMapping.sources?.[0];
    const markup = renderToStaticMarkup(
      <SourcePollingPanel
        options={[
          { mapping: sourceMapping, username: 'fastwire', schedule: source?.schedule, runtime: source?.runtime },
        ]}
        globalIntervalMinutes={5}
        busy={false}
        onSave={async () => undefined}
      />,
    );

    expect(markup).toContain('Adaptive');
    expect(markup).toContain('Minimum interval (minutes)');
    expect(markup).toContain('Maximum interval (minutes)');
    expect(markup).toContain('cannot actually be checked');
    expect(markup).toContain('Runtime status');
    expect(markup).toContain('Next eligible check');
    expect(markup).toContain('Consecutive failures');
  });

  test('describes inherited schedules without showing adaptive inputs', () => {
    const sourceMapping = mapping('ordinary', 'dailybrief', 'inherit');
    const source = sourceMapping.sources?.[0];
    const markup = renderToStaticMarkup(
      <SourcePollingPanel
        options={[{ mapping: sourceMapping, username: 'dailybrief', schedule: source?.schedule }]}
        globalIntervalMinutes={5}
        busy={false}
        onSave={async () => undefined}
      />,
    );

    expect(markup).toContain('Uses the global 5-minute scheduler interval.');
    expect(markup).not.toContain('Minimum interval (minutes)');
  });

  test('shows the persisted initial import mode and current global default', () => {
    const sourceMapping = mapping('ordinary', 'dailybrief', 'inherit');
    const source = sourceMapping.sources?.[0];
    const markup = renderToStaticMarkup(
      <SourcePollingPanel
        options={[
          {
            mapping: sourceMapping,
            username: 'dailybrief',
            schedule: source?.schedule,
            initialImportMode: source?.initialImportMode,
          },
        ]}
        globalIntervalMinutes={5}
        globalInitialImportDefault="new-only"
        busy={false}
        onSave={async () => undefined}
        onSaveInitialImportMode={async () => undefined}
      />,
    );

    expect(markup).toContain('Use global default');
    expect(markup).toContain('Current global default: Start with new posts only.');
    expect(markup).toContain('Changing it after initialization does not import');
    expect(markup).toContain('Save initial import setting');
  });

  test('deduplicates canonical sources shown through multiple destinations', () => {
    const first = mapping('one', 'sharedwire', 'adaptive');
    const second = mapping('two', 'sharedwire', 'adaptive');

    expect(uniquePollingOptions([first, second])).toHaveLength(1);
  });
});
