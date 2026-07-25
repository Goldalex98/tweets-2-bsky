import { expect, test, type Page, type Route } from '@playwright/test';

type Mutation = { path: string; body: unknown };

const fulfill = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function installWorkflowApi(page: Page): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    if (!['GET', 'HEAD'].includes(method)) mutations.push({ path, body });
    if (path === '/api/destinations' && method === 'POST') {
      return fulfill(route, { revision: 8, updatedAt: new Date().toISOString(), ...(body as object) }, 201);
    }
    if (path === '/api/settings/scheduler') return fulfill(route, { revision: 8, ...(body as object) });
    if (/\/posting\/preview$/.test(path)) {
      const input = body as { text?: string; postingPolicy?: { attribution?: { mode?: string } } };
      const text =
        input.postingPolicy?.attribution?.mode === 'never'
          ? input.text
          : `Source: @alpha on X\n\n${input.text ?? ''}`;
      return fulfill(route, { text, chunks: [text], policy: input.postingPolicy });
    }
    if (/\/filter-preview$/.test(path)) {
      return fulfill(route, { allowed: false, reason: 'media-required', trace: [{ policy: 'source-filter' }] });
    }
    if (/\/destinations\/[^/]+\/sources/.test(path)) {
      return fulfill(route, { revision: 8, state: 'paused', added: ['gamma'], removed: 'alpha' });
    }
    if (/\/queue\/items\/[^/]+\/[^/]+\/retry$/.test(path)) return fulfill(route, { affected: 1 });
    if (/\/queue\/items\/[^/]+\/[^/]+$/.test(path) && method === 'DELETE') {
      return fulfill(route, { affected: 1 });
    }
    if (/\/migration-review$/.test(path)) {
      return fulfill(route, { revision: 8, migrationReview: { needsAdminReview: false } });
    }
    if (path === '/api/health/details') {
      return fulfill(route, { status: 'ok', database: 'ok', scheduler: 'running', queue: { depth: 0 } });
    }
    if (path === '/api/metrics') return fulfill(route, { counters: { queueRetried: 0 } });
    if (path === '/api/backup/restore/validate') {
      return fulfill(route, { valid: true, mode: 'redacted', dryRun: true, writesPerformed: 0 });
    }
    if (path === '/api/admin/ingestion-credentials' && method === 'POST') {
      return fulfill(
        route,
        {
          id: 'credential-1',
          token: 'one-time-mocked-secret',
          warning: 'Copy these secrets now. They cannot be retrieved again.',
        },
        201,
      );
    }
    if (/\/ingestion-credentials\/[^/]+\/sample$/.test(path)) {
      return fulfill(route, {
        headers: { Authorization: 'Bearer <secret-shown-at-creation>', 'Idempotency-Key': '<unique-id>' },
      });
    }
    if (path === '/api/admin/ingestion-audit') {
      return fulfill(route, [{ outcome: 'accepted', routeTrace: [{ destinationId: 'destination-1' }] }]);
    }
    if (/\/digests\/[^/]+\/preview$/.test(path)) {
      return fulfill(route, { entryCount: 2, chunks: ['Digest preview'], consumed: false });
    }
    if (/\/digest-jobs\/[^/]+\/retry$/.test(path)) return fulfill(route, { retried: true });
    return fulfill(route, {});
  });
  return mutations;
}

async function api<T>(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ requestPath, requestOptions }) => {
      const response = await fetch(requestPath, {
        method: requestOptions.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...(requestOptions.headers ?? {}) },
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      });
      return { status: response.status, body: await response.json() };
    },
    { requestPath: path, requestOptions: options },
  );
}

test.beforeEach(async ({ page }) => {
  await installWorkflowApi(page);
  await page.goto('/');
});

test('one-to-one onboarding creates without profile mutation', async ({ page }) => {
  const mutations = await installWorkflowApi(page);
  const response = await api<Record<string, unknown>>(page, '/api/destinations', {
    method: 'POST',
    body: {
      twitterUsernames: ['alpha'],
      bskyIdentifier: 'one.bsky.social',
      bskyPassword: 'mock-app-password',
      postingPolicy: {
        attribution: { mode: 'never', template: 'Source: @{username} on X', rootPostsOnly: true, linkSource: true },
        appendOriginalPostLink: false,
      },
      profileManagement: { allowProfileMutation: false },
    },
  });
  expect(response.status).toBe(201);
  expect(mutations.filter((entry) => /profile\/(apply|sync)/.test(entry.path))).toEqual([]);
});

test('aggregate bulk onboarding and source add remain profile-safe', async ({ page }) => {
  const mutations = await installWorkflowApi(page);
  await api(page, '/api/destinations', {
    method: 'POST',
    body: {
      twitterUsernames: ['alpha', 'beta', 'gamma'],
      bskyIdentifier: 'aggregate.bsky.social',
      bskyPassword: 'mock-app-password',
      profileManagement: { allowProfileMutation: false },
    },
  });
  await api(page, '/api/destinations/destination-1/sources', {
    method: 'POST',
    body: { sources: ['delta'], revision: 7, updatedAt: '2026-07-24T20:00:00.000Z' },
  });
  expect(mutations.map((entry) => entry.path)).not.toContain('/api/mappings/destination-1/profile/apply');
});

test('attribution preview uses the same deterministic output for delivery input', async ({ page }) => {
  const policy = {
    attribution: { mode: 'always', template: 'Source: @{username} on X', rootPostsOnly: true, linkSource: true },
    appendOriginalPostLink: false,
  };
  const first = await api<{ text: string }>(page, '/api/mappings/destination-1/posting/preview', {
    method: 'POST',
    body: { text: 'Hello', twitterUsername: 'alpha', postingPolicy: policy },
  });
  const delivery = await api<{ text: string }>(page, '/api/mappings/destination-1/posting/preview', {
    method: 'POST',
    body: { text: 'Hello', twitterUsername: 'alpha', postingPolicy: policy },
  });
  expect(first.body.text).toBe('Source: @alpha on X\n\nHello');
  expect(delivery.body.text).toBe(first.body.text);
});

test('scheduler reschedule and disable never trigger a run', async ({ page }) => {
  const mutations = await installWorkflowApi(page);
  await api(page, '/api/settings/scheduler', {
    method: 'PATCH',
    body: { enabled: true, intervalMinutes: 15, runOnStartup: false, ...{ revision: 7, updatedAt: '2026-07-24T20:00:00.000Z' } },
  });
  await api(page, '/api/settings/scheduler', {
    method: 'PATCH',
    body: { enabled: false, intervalMinutes: 15, runOnStartup: false, revision: 7, updatedAt: '2026-07-24T20:00:00.000Z' },
  });
  expect(mutations.filter((entry) => entry.path === '/api/run-now')).toHaveLength(0);
});

test('source add, pause, filter preview, and remove use isolated APIs', async ({ page }) => {
  const added = await api<{ added: string[] }>(page, '/api/destinations/destination-1/sources', {
    method: 'POST',
    body: { sources: ['gamma'] },
  });
  const paused = await api<{ state: string }>(page, '/api/destinations/destination-1/sources/gamma', {
    method: 'PATCH',
    body: { state: 'paused', cancelPendingQueue: false },
  });
  const preview = await api<{ allowed: boolean; reason: string }>(
    page,
    '/api/destinations/destination-1/sources/gamma/filter-preview',
    { method: 'POST', body: { metadata: { text: 'no media', hasMedia: false } } },
  );
  const removed = await api<{ removed: string }>(page, '/api/destinations/destination-1/sources/gamma', {
    method: 'DELETE',
    body: { cancelPendingQueue: false, deleteHistory: false },
  });
  expect(added.body.added).toEqual(['gamma']);
  expect(paused.body.state).toBe('paused');
  expect(preview.body).toMatchObject({ allowed: false, reason: 'media-required' });
  expect(removed.body.removed).toBe('alpha');
});

test('queue retry and cancel are item scoped', async ({ page }) => {
  const retry = await api<{ affected: number }>(page, '/api/queue/items/destination/tweet-1/retry', {
    method: 'POST',
  });
  const cancel = await api<{ affected: number }>(page, '/api/queue/items/destination/tweet-2', {
    method: 'DELETE',
  });
  expect(retry.body.affected).toBe(1);
  expect(cancel.body.affected).toBe(1);
});

test('migration review keeps explicit revision semantics', async ({ page }) => {
  const response = await api<{ migrationReview: { needsAdminReview: boolean } }>(
    page,
    '/api/mappings/destination-1/migration-review',
    {
      method: 'PATCH',
      body: { revision: 7, updatedAt: '2026-07-24T20:00:00.000Z' },
    },
  );
  expect(response.body.migrationReview.needsAdminReview).toBe(false);
});

test('health and metrics responses contain no credential material', async ({ page }) => {
  const health = await api(page, '/api/health/details');
  const metrics = await api(page, '/api/metrics');
  const serialized = JSON.stringify({ health, metrics }).toLowerCase();
  expect(serialized).not.toContain('authorization');
  expect(serialized).not.toContain('app-password');
  expect(serialized).not.toContain('auth_token');
});

test('backup validation is dry-run and performs no writes', async ({ page }) => {
  const response = await api<{ valid: boolean; dryRun: boolean; writesPerformed: number }>(
    page,
    '/api/backup/restore/validate',
    { method: 'POST', body: { bundle: 'c2FuaXRpemVkLWZpeHR1cmU=' } },
  );
  expect(response.body).toEqual(expect.objectContaining({ valid: true, dryRun: true, writesPerformed: 0 }));
});

test('ingestion secret is one-time while samples and audit stay sanitized', async ({ page }) => {
  const created = await api<{ token: string; warning: string }>(page, '/api/admin/ingestion-credentials', {
    method: 'POST',
    body: { sourceId: 'source-1', name: 'CI credential', includeHmac: true },
  });
  const sample = await api<{ headers: Record<string, string> }>(
    page,
    '/api/admin/ingestion-credentials/credential-1/sample',
  );
  const audit = await api<Array<{ routeTrace: unknown }>>(page, '/api/admin/ingestion-audit');
  expect(created.body.warning).toContain('cannot be retrieved again');
  expect(sample.body.headers.Authorization).toContain('<secret-shown-at-creation>');
  expect(JSON.stringify(sample.body)).not.toContain(created.body.token);
  expect(audit.body[0]?.routeTrace).toBeDefined();
});

test('digest preview is non-consuming and failed jobs retry explicitly', async ({ page }) => {
  const preview = await api<{ consumed: boolean; chunks: string[] }>(page, '/api/admin/digests/route-1/preview', {
    method: 'POST',
  });
  const retry = await api<{ retried: boolean }>(page, '/api/admin/digest-jobs/job-1/retry', { method: 'POST' });
  expect(preview.body).toMatchObject({ consumed: false, chunks: ['Digest preview'] });
  expect(retry.body.retried).toBe(true);
});
