import { describe, expect, test } from 'bun:test';
import { LayoutDashboard, Settings } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewPage } from '../../web/src/features/overview/overview-page';
import { PostsPage } from '../../web/src/features/posts/posts-page';
import { parseTwitterUsernameInput } from '../../web/src/lib/dashboard-utils';

describe('modular frontend features', () => {
  test('overview renders its own empty state and navigation', () => {
    const markup = renderToStaticMarkup(
      <OverviewPage
        mappings={[]}
        queuedPostCount={0}
        pendingBackfillCount={0}
        dashboardTabs={[
          { id: 'overview', label: 'Overview', icon: LayoutDashboard },
          { id: 'settings', label: 'Settings', icon: Settings },
        ]}
        loading={false}
        error={null}
        onRetry={() => undefined}
        onNavigate={() => undefined}
      />,
    );

    expect(markup).toContain('No destinations configured yet.');
    expect(markup).toContain('Open Settings');
  });

  test('overview prefers canonical handle over raw DID identifiers', () => {
    const markup = renderToStaticMarkup(
      <OverviewPage
        mappings={[
          {
            id: 'dest-1',
            twitterUsernames: ['source'],
            bskyIdentifier: 'did:plc:abcdef',
            bskyCanonicalHandle: 'mirror.example',
            bskyServiceUrl: 'https://bsky.social',
            enabled: true,
            postingPolicy: { attribution: { mode: 'off' } },
            profileManagement: { profileSync: { mode: 'off' } },
            sources: [],
          } as never,
        ]}
        queuedPostCount={0}
        pendingBackfillCount={0}
        dashboardTabs={[{ id: 'overview', label: 'Overview', icon: LayoutDashboard }]}
        loading={false}
        error={null}
        onRetry={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain('@mirror.example');
    expect(markup).not.toContain('@did:plc:abcdef');
  });

  test('posts renders a feature-owned empty state', () => {
    const markup = renderToStaticMarkup(
      <PostsPage
        searchQuery=""
        onSearchQueryChange={() => undefined}
        searching={false}
        groupFilter="all"
        onGroupFilterChange={() => undefined}
        groupOptions={[]}
        localResults={[]}
        posts={[]}
        resolveLocalMapping={() => undefined}
        resolvePostMapping={() => undefined}
        getProfile={() => undefined}
      />,
    );

    expect(markup).toContain('Already Posted');
    expect(markup).toContain('No posted entries yet.');
  });

  test('source parser normalizes and de-duplicates wizard input', () => {
    const result = parseTwitterUsernameInput(['alpha'], '@Beta beta, invalid-user!');
    expect(result.usernames).toEqual(['alpha', 'beta']);
    expect(result.summary.duplicates).toHaveLength(1);
    expect(result.summary.invalid).toHaveLength(1);
  });
});
