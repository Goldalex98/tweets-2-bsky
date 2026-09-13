import { expect, test } from '@playwright/test';

test('deployed authenticated dashboard serves real APIs and navigates without mutations', async ({ page, request }) => {
  // Never log provider responses, cookie contents, console text, or query strings.
  const failures: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', () => failures.push('uncaught browser exception'));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push('browser console error');
  });
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    // This existing batched POST only fetches public profiles (server.ts); it never updates a profile.
    const publicProfileRead =
      sent.method() === 'POST' &&
      url.origin === new URL(process.env.DEPLOYMENT_BASE_URL ?? '').origin &&
      url.pathname === '/api/bsky/profiles';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(sent.method()) && !publicProfileRead)
      mutations.push(`${sent.method()} request`);
  });
  page.on('requestfailed', (sent) => {
    // A navigation can cancel the dashboard's old polling request legitimately.
    if (sent.failure()?.errorText === 'net::ERR_ABORTED') return;
    failures.push(`failed ${sent.resourceType()} request`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failures.push(`HTTP ${response.status()} ${response.request().resourceType()} response`);
  });

  const identity = await request.get('/api/me', { timeout: 30_000 });
  expect(identity.status(), 'Existing deployment session must be authenticated.').toBe(200);
  expect((await identity.json()).isAdmin, 'Acceptance requires visibility of all managed accounts.').toBe(true);
  const version = await request.get('/api/version', { timeout: 30_000 });
  expect(version.status(), 'Existing deployment session must authorize the real version endpoint.').toBe(200);
  const actual = await version.json();
  expect(actual.version, 'Running app version must match the released artifact.').toBe(
    process.env.DEPLOYMENT_EXPECTED_VERSION,
  );

  for (const [path, heading, requiredApis] of [
    ['/', 'Overview', ['/api/status', '/api/destinations', '/api/posts/enriched']],
    ['/accounts', 'Accounts', ['/api/destinations', '/api/groups']],
    ['/posts', 'Posts', ['/api/posts/enriched']],
    ['/activity', 'Activity', ['/api/recent-activity', '/api/queue']],
    ['/settings', 'Settings', ['/api/version', '/api/settings/scheduler']],
  ] as const) {
    // Register before navigation, then require each real data response to finish.
    // Static headings alone can appear while a broken API hangs indefinitely.
    const loaded = Promise.all(
      requiredApis.map(async (apiPath) => {
        const response = await page.waitForResponse(
          (candidate) => {
            const url = new URL(candidate.url());
            return (
              url.origin === new URL(process.env.DEPLOYMENT_BASE_URL ?? '').origin &&
              url.pathname === apiPath &&
              candidate.request().method() === 'GET'
            );
          },
          { timeout: 30_000 },
        );
        expect(response.status(), `Required ${apiPath} response must succeed`).toBe(200);
        expect(await response.finished(), `Required ${apiPath} response must finish`).toBeNull();
        const payload = await response.json();
        expect(
          payload !== null && typeof payload === 'object',
          `Required ${apiPath} response must contain JSON data`,
        ).toBe(true);
      }),
    );
    await Promise.all([loaded, page.goto(path)]);
    await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.locator('header')).toBeVisible();
    expect(await page.locator('body').evaluate((body) => getComputedStyle(body).fontFamily)).not.toBe(
      '"Times New Roman"',
    );
  }
  expect(mutations, 'Read-only smoke must not issue mutating requests.').toEqual([]);
  expect(failures, 'Real dashboard APIs/assets must load without browser or network errors.').toEqual([]);
});

test('anonymous navigation shows sign-in without revoking the existing admin session', async ({ browser, request }) => {
  const anonymous = await browser.newContext({
    baseURL: process.env.DEPLOYMENT_BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const anonymousIdentity = await anonymous.request.get('/api/me', { timeout: 30_000 });
    expect(anonymousIdentity.status(), 'Anonymous API access must require authentication.').toBe(401);
    const page = await anonymous.newPage();
    const unexpectedMutations: string[] = [];
    page.on('request', (sent) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(sent.method())) unexpectedMutations.push(sent.method());
    });
    await page.goto('/accounts', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toHaveCount(0);
    expect(unexpectedMutations, 'Session checks must not log in or log out.').toEqual([]);
  } finally {
    await anonymous.close();
  }
  const stillAuthenticated = await request.get('/api/me', { timeout: 30_000 });
  expect(stillAuthenticated.status(), 'Existing admin session must remain valid.').toBe(200);
});
