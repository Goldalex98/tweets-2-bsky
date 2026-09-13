import { expect, test } from '@playwright/test';

test('deployed authenticated dashboard serves real APIs and navigates without mutations', async ({
  context,
  request,
}) => {
  // Never log provider responses, cookie contents, console text, or query strings.
  const failures: string[] = [];
  const mutations: string[] = [];
  const networkCode = (text: string | undefined) => text?.match(/\bnet::ERR_[A-Z0-9_]{1,64}\b/)?.[0] ?? 'unknown';
  const hostname = (url: string) => {
    try {
      return new URL(url).hostname || 'unknown';
    } catch {
      return 'unknown';
    }
  };
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
    const page = await context.newPage();
    let closing = false;
    const recordFailure = (detail: string) => failures.push(`route=${path} closing=${closing} ${detail}`);
    await page.exposeFunction('recordDeploymentCspViolation', (directive: unknown, blockedHost: unknown) => {
      const safeDirective = typeof directive === 'string' && /^[a-z-]{1,48}$/.test(directive) ? directive : 'unknown';
      const safeHost =
        typeof blockedHost === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(blockedHost) ? blockedHost : 'unknown';
      recordFailure(`CSP directive=${safeDirective} host=${safeHost}`);
    });
    await page.addInitScript(() => {
      window.addEventListener('securitypolicyviolation', (event) => {
        let blockedHost = 'unknown';
        try {
          blockedHost = new URL(event.blockedURI).hostname || 'unknown';
        } catch {
          // Inline/eval violations have no hostname; never retain the raw URI.
        }
        const report = (
          window as Window & {
            recordDeploymentCspViolation?: (directive: string, blockedHost: string) => Promise<void>;
          }
        ).recordDeploymentCspViolation;
        if (!report) throw new Error('CSP reporting binding is unavailable');
        void report(event.effectiveDirective, blockedHost);
      });
    });
    page.on('pageerror', () => recordFailure('uncaught browser exception'));
    page.on('console', (message) => {
      if (message.type() === 'error')
        recordFailure(`console error code=${networkCode(message.text())} host=${hostname(message.location().url)}`);
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
      // Only our page.close() can waive an aborted background API poll.
      // Image/CSP failures and every failure during acceptance remain visible.
      if (closing && sent.failure()?.errorText === 'net::ERR_ABORTED' && ['fetch', 'xhr'].includes(sent.resourceType()))
        return;
      recordFailure(
        `failed ${sent.resourceType()} request code=${networkCode(sent.failure()?.errorText)} host=${hostname(sent.url())}`,
      );
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        recordFailure(
          `HTTP ${response.status()} ${response.request().resourceType()} response host=${hostname(response.url())}`,
        );
    });
    try {
      // A fresh page cannot match polling responses from the previous route.
      // Consume every required response body before closing this page.
      const loaded = requiredApis.map(async (apiPath) => {
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
      });
      const outcomes = await Promise.allSettled([...loaded, page.goto(path)]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
      await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(page.locator('header')).toBeVisible();
      expect(await page.locator('body').evaluate((body) => getComputedStyle(body).fontFamily)).not.toBe(
        '"Times New Roman"',
      );
      const imagesLoaded = await page.locator('img:visible').evaluateAll((images) =>
        Promise.all(
          images.map(
            (image) =>
              new Promise<boolean>((resolve) => {
                if (!(image instanceof HTMLImageElement)) return resolve(false);
                if (image.complete) return resolve(image.naturalWidth > 0);
                const settled = () => {
                  clearTimeout(timer);
                  image.removeEventListener('load', settled);
                  image.removeEventListener('error', settled);
                  resolve(image.complete && image.naturalWidth > 0);
                };
                const timer = setTimeout(settled, 10_000);
                image.addEventListener('load', settled, { once: true });
                image.addEventListener('error', settled, { once: true });
              }),
          ),
        ),
      );
      expect(imagesLoaded.every(Boolean), `Visible images on ${path} must finish loading successfully.`).toBe(true);
    } finally {
      closing = true;
      await page.close();
    }
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
