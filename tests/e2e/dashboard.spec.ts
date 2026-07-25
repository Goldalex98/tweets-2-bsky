import { expect, test, type Page, type Route } from '@playwright/test';

const version = { revision: 7, updatedAt: '2026-07-24T20:00:00.000Z' };
const permissions = {
  viewAllMappings: true,
  manageOwnMappings: true,
  manageAllMappings: true,
  manageGroups: true,
  queueBackfills: true,
  runNow: true,
  reevaluateQueuePolicies: true,
};

const postingPolicy = {
  attribution: { mode: 'never', template: 'Source: @{username} on X', rootPostsOnly: true, linkSource: true },
  appendOriginalPostLink: false,
};
const profileManagement = {
  allowProfileMutation: false,
  ensureBotLabel: false,
  ensureDisplayNameBotSuffix: false,
  profileSync: {
    mode: 'off',
    intervalHours: 24,
    fields: { displayName: false, description: false, avatar: false, banner: false },
  },
  pinSync: { mode: 'off', intervalHours: 24 },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockDashboard(page: Page) {
  const mutations: Array<{ path: string; body: unknown; csrf?: string }> = [];
  let destinations: unknown[] = [];

  await page.context().addCookies([
    { name: 't2b_session', value: 'mock-session', domain: '127.0.0.1', path: '/', httpOnly: true },
    { name: 't2b_csrf', value: 'mock-csrf', domain: '127.0.0.1', path: '/' },
  ]);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    if (!['GET', 'HEAD'].includes(method)) {
      mutations.push({ path, body, csrf: request.headers()['x-csrf-token'] });
    }

    if (path === '/api/auth/bootstrap-status') return json(route, { bootstrapOpen: false });
    if (path === '/api/me') {
      return json(route, {
        id: 'admin',
        username: 'admin',
        email: 'admin@example.invalid',
        isAdmin: true,
        permissions,
      });
    }
    if (path === '/api/destinations' && method === 'GET') return json(route, destinations);
    if (path === '/api/destinations' && method === 'POST') {
      const input = body as Record<string, unknown>;
      const sources = input.twitterUsernames as string[];
      const created = {
        ...version,
        id: 'destination-1',
        twitterUsernames: sources,
        pausedTwitterUsernames: [],
        bskyIdentifier: 'destination.bsky.social',
        bskyServiceUrl: 'https://bsky.social',
        enabled: true,
        postingPolicy: sources.length > 1
          ? { ...postingPolicy, attribution: { ...postingPolicy.attribution, mode: 'multiple-sources' } }
          : postingPolicy,
        profileManagement,
        aiOverrides: {
          imageAltText: 'inherit',
          translation: 'inherit',
          summarization: 'inherit',
          cleanup: 'inherit',
          hashtags: 'inherit',
        },
        moderationPolicy: {
          blockKeywords: [],
          blockDomains: [],
          blockSourceUsernames: [],
          sensitiveContent: 'allow',
          dryRun: false,
        },
        duplicateSuppression: { enabled: false, windowHours: 24, perceptualImageHash: false },
      };
      destinations = [created];
      return json(route, created, 201);
    }
    // A fresh install has no managed accounts; tests that need them register
    // their own route so the wizard opens on the account picker instead.
    if (path === '/api/bluesky-accounts' && method === 'GET') return json(route, []);
    if (path === '/api/groups') return json(route, []);
    if (path === '/api/version') return json(route, { version: '3.0.0', startedAt: Date.now() });
    if (path === '/api/twitter-config') {
      return json(route, {
        ...version,
        authToken: '',
        ct0: '',
        hasAuthToken: false,
        hasCt0: false,
      });
    }
    if (path === '/api/ai-config') {
      return json(route, {
        ...version,
        enabled: false,
        purpose: 'image-alt-text',
        provider: 'gemini',
        maxAltTextChars: 1000,
        privacyDescription: 'Mock provider is disabled.',
        textCapabilities: {
          translation: { enabled: false, purpose: 'translation', privacyDescription: '' },
          summarization: { enabled: false, purpose: 'summarization', privacyDescription: '' },
          cleanup: { enabled: false, purpose: 'cleanup', privacyDescription: '' },
          hashtags: { enabled: false, purpose: 'hashtags', privacyDescription: '' },
        },
      });
    }
    if (path === '/api/update-status') return json(route, { running: false });
    if (path === '/api/admin/users') return json(route, []);
    if (path === '/api/settings/scheduler') {
      const scheduler = {
        ...version,
        enabled: true,
        intervalMinutes: 5,
        runOnStartup: false,
        lastCheckTime: null,
        nextCheckTime: Date.now() + 300_000,
        enabledSourceCount: 0,
        estimatedChecksPerHour: 0,
      };
      if (method === 'PATCH') return json(route, { ...scheduler, ...(body as object) });
      return json(route, scheduler);
    }
    if (path === '/api/settings/notifications') {
      return json(route, {
        ...version,
        enabled: false,
        webhookConfigured: false,
        secretConfigured: false,
        allowPrivate: false,
        events: {
          'twitter-auth-failure': true,
          'bsky-auth-failure': true,
          'queue-parked': true,
          'queue-age': false,
          'update-failure': true,
        },
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 10000,
      });
    }
    if (path === '/api/status') {
      return json(route, {
        lastCheckTime: 0,
        nextCheckTime: Date.now() + 300_000,
        nextCheckMinutes: 5,
        checkIntervalMinutes: 5,
        pendingBackfills: [],
        currentStatus: { state: 'idle', message: 'Idle', lastUpdate: Date.now() },
        activeJobs: [],
        queue: { pending: 0, processing: 0, failed: 0, oldestEnqueuedAt: null, perMapping: [] },
      });
    }
    if (path === '/api/recent-activity' || path === '/api/posts/enriched') return json(route, []);
    if (path === '/api/queue') return json(route, { items: [], counts: [] });
    if (path === '/api/onboarding/twitter-profile') {
      const username = String((body as { twitterUsername?: string })?.twitterUsername ?? 'source');
      return json(route, {
        username,
        profileUrl: `https://x.com/${username}`,
        mirroredDisplayName: username,
        mirroredDescription: 'Read-only mocked profile preview.',
      });
    }
    if (path === '/api/onboarding/bsky-credentials') {
      return json(route, {
        did: 'did:plc:mock',
        handle: 'destination.bsky.social',
        emailConfirmed: true,
        serviceUrl: 'https://bsky.social',
        settingsUrl: 'https://bsky.app/settings/account',
      });
    }
    if (path === '/api/run-now') return json(route, { success: true, message: 'Check triggered' });
    if (/^\/api\/mappings\/[^/]+\/posting\/preview$/.test(path)) {
      const input = body as { text?: string; postingPolicy?: typeof postingPolicy };
      const mode = input.postingPolicy?.attribution.mode ?? 'never';
      const text = mode === 'never' ? input.text : `Source: @alpha on X\n\n${input.text ?? ''}`;
      return json(route, { text, chunks: [text], policy: input.postingPolicy });
    }
    if (/^\/api\/destinations\/[^/]+\/sources\/[^/]+\/filter-preview$/.test(path)) {
      return json(route, { allowed: false, reason: 'media-required', trace: [{ policy: 'source-filter' }] });
    }
    if (/^\/api\/destinations\/[^/]+\/sources/.test(path)) {
      return json(route, { ...version, success: true, state: 'paused', added: ['gamma'], removed: 'alpha' });
    }
    if (/^\/api\/queue\/items\/[^/]+\/[^/]+\/retry$/.test(path)) {
      return json(route, { success: true, affected: 1 });
    }
    if (/^\/api\/queue\/items\/[^/]+\/[^/]+$/.test(path) && method === 'DELETE') {
      return json(route, { success: true, affected: 1 });
    }
    if (/^\/api\/(destinations|mappings)\/[^/]+\/migration-review$/.test(path)) {
      const destination = destinations[0] as Record<string, unknown> | undefined;
      if (destination?.migrationReview && typeof destination.migrationReview === 'object') {
        destination.migrationReview = {
          ...(destination.migrationReview as object),
          needsAdminReview: false,
          reviewedAt: '2026-07-25T20:00:00.000Z',
        };
      }
      return json(route, {
        ...version,
        success: true,
        migrationReview: { needsAdminReview: false, reviewedAt: '2026-07-25T20:00:00.000Z' },
        destination,
      });
    }
    if (path === '/api/backup/restore/validate') {
      return json(route, { valid: true, mode: 'redacted', dryRun: true, writesPerformed: 0 });
    }
    if (path === '/api/admin/ingestion-credentials' && method === 'POST') {
      return json(
        route,
        {
          id: 'credential-1',
          token: 'one-time-mocked-secret',
          hmacSecret: 'one-time-mocked-hmac',
          warning: 'Copy these secrets now. They cannot be retrieved again.',
        },
        201,
      );
    }
    if (/^\/api\/admin\/ingestion-credentials\/[^/]+\/sample$/.test(path)) {
      return json(route, {
        endpoint: '/api/ingest/v1/posts',
        headers: { Authorization: 'Bearer <secret-shown-at-creation>', 'Idempotency-Key': '<unique-id>' },
      });
    }
    if (path === '/api/admin/ingestion-audit') {
      return json(route, [{ outcome: 'accepted', statusCode: 202, routeTrace: [{ destinationId: 'destination-1' }] }]);
    }
    if (/^\/api\/admin\/digests\/[^/]+\/preview$/.test(path)) {
      return json(route, { entryCount: 2, chunks: ['Digest preview'], consumed: false });
    }
    if (/^\/api\/admin\/digest-jobs\/[^/]+\/retry$/.test(path)) {
      return json(route, { retried: true });
    }
    if (path === '/api/health/details') {
      return json(route, { status: 'ok', database: 'ok', scheduler: 'running', queue: { depth: 0 } });
    }
    if (path === '/api/metrics') return json(route, { counters: { queueRetried: 0 } });
    return json(route, { ...version, success: true, jobs: [], entries: [] });
  });

  return mutations;
}

function sourcesField(page: Page) {
  return page.getByRole('textbox', { name: 'X Sources', exact: true });
}

const managedAccounts = [
  {
    ...version,
    id: 'account-1',
    serviceUrl: 'https://bsky.social',
    loginIdentifier: 'osint-mirrors.bsky.social',
    canonicalHandle: 'osint-mirrors.bsky.social',
    did: 'did:plc:mock',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updatedAtConfig: version.updatedAt,
    credentialConfigured: true,
    linkedDestinationId: 'destination-1',
    health: { consecutiveFailures: 0 },
  },
  {
    ...version,
    id: 'account-2',
    label: 'Spare mirror',
    serviceUrl: 'https://bsky.social',
    loginIdentifier: 'spare-mirror.bsky.social',
    canonicalHandle: 'spare-mirror.bsky.social',
    did: 'did:plc:spare',
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    updatedAtConfig: version.updatedAt,
    credentialConfigured: true,
    linkedDestinationId: null,
    health: null,
  },
];

async function mockManagedAccounts(page: Page) {
  await page.route('**/api/bluesky-accounts', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, managedAccounts);
  });
}

function linkedDestination(accountId: 'account-1' | 'account-2') {
  const account = managedAccounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error(`Unknown mock account ${accountId}`);
  return {
    ...version,
    id: 'destination-1',
    twitterUsernames: ['alpha'],
    pausedTwitterUsernames: [],
    bskyIdentifier: account.loginIdentifier,
    bskyCanonicalHandle: account.canonicalHandle,
    bskyDid: account.did,
    bskyServiceUrl: account.serviceUrl,
    bskyAccountId: account.id,
    credentialConfigured: true,
    blueskyAccount: {
      id: account.id,
      loginIdentifier: account.loginIdentifier,
      canonicalHandle: account.canonicalHandle,
      did: account.did,
      serviceUrl: account.serviceUrl,
      credentialConfigured: true,
      health: { consecutiveFailures: 0 },
    },
    enabled: true,
    destinationState: 'enabled',
    postingPolicy,
    profileManagement,
    aiOverrides: {
      imageAltText: 'inherit',
      textCapabilities: {
        translation: 'inherit',
        summarization: 'inherit',
        cleanup: 'inherit',
        hashtags: 'inherit',
      },
    },
    moderationPolicy: {
      blockKeywords: [],
      blockDomains: [],
      blockSourceUsernames: [],
      sensitiveContent: 'allow',
      dryRun: false,
    },
    duplicateSuppression: { enabled: false, windowHours: 24, perceptualImageHash: false },
    sources: [{ username: 'alpha', routeId: 'route_alpha', state: 'enabled', delivery: { mode: 'immediate' } }],
    queue: null,
    runtime: null,
  };
}

test('cookie session, CSRF, and aggregate onboarding stay mutation-safe', async ({ page }) => {
  const mutations = await mockDashboard(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Run now' }).click();
  await expect.poll(() => mutations.find((entry) => entry.path === '/api/run-now')?.csrf).toBe('mock-csrf');

  await page.getByRole('button', { name: 'Add Bluesky destination' }).click();
  await expect(page.getByRole('dialog', { name: 'Create Bluesky Destination' })).toBeVisible();
  await sourcesField(page).fill('@alpha\nbeta, alpha');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bluesky Identifier').fill('destination.bsky.social');
  await page.getByLabel('Bluesky App Password').fill('xxxx-xxxx-xxxx-xxxx');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create Destination' }).click();

  await expect.poll(() => mutations.some((entry) => entry.path === '/api/destinations')).toBe(true);
  expect(mutations.some((entry) => entry.path.includes('/profile/apply'))).toBe(false);
  expect(mutations.some((entry) => entry.path.includes('/sync-profile'))).toBe(false);
});

test('aggregate onboarding sends the attribution and profile policy chosen in the wizard', async ({ page }) => {
  const mutations = await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Bluesky destination' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create Bluesky Destination' });
  await expect(dialog).toBeVisible();
  await expect(sourcesField(page)).toBeFocused();

  await sourcesField(page).fill('alpha beta gamma');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bluesky Identifier').fill('destination.bsky.social');
  await page.getByLabel('Bluesky App Password').fill('xxxx-xxxx-xxxx-xxxx');
  await page.getByRole('button', { name: 'Next' }).click();

  // Three sources: attribution defaults on, profile mutation stays opt-in.
  await expect(page.getByLabel('Prepend the X username')).toHaveValue('multiple-sources');
  await expect(page.getByLabel('Allow Bluesky profile mutation')).not.toBeChecked();

  await page.getByLabel('Attribution template').fill('Via @{handle}');
  await expect(dialog.getByRole('alert')).toContainText('unsupported variable: {handle}');
  await expect(page.getByRole('button', { name: 'Create Destination' })).toBeDisabled();

  await page.getByLabel('Attribution template').fill('Via @{username}');
  await page.getByRole('button', { name: 'Create Destination' }).click();

  await expect
    .poll(() => mutations.find((entry) => entry.path === '/api/destinations')?.body)
    .toMatchObject({
      twitterUsernames: ['alpha', 'beta', 'gamma'],
      postingPolicy: { attribution: { mode: 'multiple-sources', template: 'Via @{username}' } },
      profileManagement: { allowProfileMutation: false },
    });
});

test('a one-to-one destination keeps attribution off unless the operator opts in', async ({ page }) => {
  const mutations = await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Bluesky destination' }).click();

  await sourcesField(page).fill('alpha');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bluesky Identifier').fill('solo.bsky.social');
  await page.getByLabel('Bluesky App Password').fill('xxxx-xxxx-xxxx-xxxx');
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByLabel('Prepend the X username')).toHaveValue('never');
  await page.getByLabel('Prepend the X username').selectOption('always');
  await page.getByRole('button', { name: 'Create Destination' }).click();

  await expect
    .poll(() => mutations.find((entry) => entry.path === '/api/destinations')?.body)
    .toMatchObject({ postingPolicy: { attribution: { mode: 'always' } } });
});

test('scheduler interval refuses an empty value instead of posting NaN', async ({ page }) => {
  const mutations = await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Dashboard navigation' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Scheduler' }).click();

  const interval = page.getByLabel('Check every (minutes)');
  await expect(interval).toHaveValue('5');
  await interval.fill('');
  await expect(page.locator('#scheduler-interval-hint')).toContainText('Enter a check interval');
  await expect(page.getByRole('button', { name: 'Save scheduler' })).toBeDisabled();

  await interval.fill('15');
  await page.getByRole('button', { name: 'Save scheduler' }).click();

  await expect
    .poll(() => mutations.find((entry) => entry.path === '/api/settings/scheduler')?.body)
    .toMatchObject({ intervalMinutes: 15 });
});

test('responsive keyboard and operational redaction smoke', async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  // Headless Chromium ignores Tab until the document has been focused.
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();

  const health = await page.evaluate(async () => (await fetch('/api/health/details')).json());
  const metrics = await page.evaluate(async () => (await fetch('/api/metrics')).json());
  expect(JSON.stringify({ health, metrics })).not.toContain('secret');
  expect(JSON.stringify({ health, metrics })).not.toContain('auth_token');

  await page.getByRole('button', { name: 'Add Bluesky destination' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Bluesky destination' })).toBeFocused();
});

test('the wizard links an existing managed account instead of collecting a password', async ({ page }) => {
  const mutations = await mockDashboard(page);
  await mockManagedAccounts(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Bluesky destination' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create Bluesky Destination' });
  await sourcesField(page).fill('delta');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  // Reusing a managed account is the default and no password is requested.
  await expect(dialog.getByLabel('Use an existing Bluesky account')).toBeChecked();
  await expect(dialog.getByLabel('Bluesky App Password')).toHaveCount(0);
  await expect(dialog.getByText('managed in Settings → Bluesky accounts')).toBeVisible();

  // Only the unlinked account is offered, alongside the placeholder option.
  const picker = dialog.getByLabel('Bluesky account', { exact: true });
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.selectOption('account-2');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByText('Existing managed account from Settings')).toBeVisible();
  await page.getByRole('button', { name: 'Create Destination' }).click();

  const created = () => mutations.find((entry) => entry.path === '/api/destinations');
  await expect.poll(() => created()?.body).toMatchObject({ bskyAccountId: 'account-2' });
  expect(created()?.body).not.toHaveProperty('bskyPassword');
  // An already-validated account does not need the onboarding credential check.
  expect(mutations.some((entry) => entry.path === '/api/onboarding/bsky-credentials')).toBe(false);

  // The new-credentials path is still available and states where it is saved.
  await page.getByRole('button', { name: 'Add Bluesky destination' }).click();
  await sourcesField(page).fill('epsilon');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await dialog.getByLabel('Connect a new Bluesky account').check();
  await expect(dialog.getByLabel('Bluesky App Password')).toBeVisible();
  await expect(
    dialog.getByText('stored as a managed account in Settings → Bluesky accounts'),
  ).toBeVisible();
});

test('the destination editor repoints a destination at another managed account', async ({ page }) => {
  await mockDashboard(page);
  await mockManagedAccounts(page);
  await page.route('**/api/destinations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, [linkedDestination('account-1')]);
  });
  // Registered after mockDashboard, so this handler wins and records the body.
  let switchRequest: unknown;
  await page.route('**/api/destinations/destination-1/bluesky-account', async (route) => {
    switchRequest = route.request().postDataJSON?.() ?? null;
    return json(route, {
      ...version,
      success: true,
      changed: true,
      previousAccountId: 'account-1',
      destination: linkedDestination('account-2'),
    });
  });

  await page.goto('/accounts?destinationId=destination-1&section=overview');
  const dialog = page.getByRole('dialog', { name: 'Edit Bluesky Destination' });
  await expect(dialog.getByText('Linked Bluesky account')).toBeVisible();
  await expect(dialog.getByRole('definition').filter({ hasText: '@osint-mirrors.bsky.social' })).toBeVisible();

  // The picker offers unlinked accounts plus the current link, never a password.
  const picker = dialog.getByLabel('Posting account');
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await picker.selectOption('account-2');
  await dialog.getByRole('button', { name: 'Switch account' }).click();

  const confirm = page.getByRole('dialog', { name: 'Switch Bluesky account?' });
  await expect(confirm).toContainText('not posted again');
  await confirm.getByRole('button', { name: 'Switch account' }).click();

  await expect.poll(() => switchRequest).toMatchObject({ bskyAccountId: 'account-2' });
  await expect(page.getByText('Destination now posts to @spare-mirror.bsky.social')).toBeVisible();
});

test('destination editor uses section navigation and dismisses migration review', async ({ page }) => {
  const mutations = await mockDashboard(page);
  await page.route('**/api/destinations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, [
      {
        ...version,
        id: 'destination-1',
        twitterUsernames: ['alpha', 'beta'],
        pausedTwitterUsernames: [],
        bskyIdentifier: 'osint-mirrors.bsky.social',
        bskyCanonicalHandle: 'osint-mirrors.bsky.social',
        bskyDid: 'did:plc:mock',
        bskyServiceUrl: 'https://bsky.social',
        bskyAccountId: 'account-1',
        credentialConfigured: true,
        blueskyAccount: {
          id: 'account-1',
          loginIdentifier: 'osint-mirrors.bsky.social',
          canonicalHandle: 'osint-mirrors.bsky.social',
          did: 'did:plc:mock',
          serviceUrl: 'https://bsky.social',
          credentialConfigured: true,
          health: { consecutiveFailures: 0 },
        },
        enabled: true,
        destinationState: 'enabled',
        postingPolicy,
        profileManagement,
        aiOverrides: {
          imageAltText: 'inherit',
          textCapabilities: {
            translation: 'inherit',
            summarization: 'inherit',
            cleanup: 'inherit',
            hashtags: 'inherit',
          },
        },
        moderationPolicy: {
          blockKeywords: [],
          blockDomains: [],
          blockSourceUsernames: [],
          sensitiveContent: 'allow',
          dryRun: false,
        },
        duplicateSuppression: { enabled: false, windowHours: 24, perceptualImageHash: false },
        migrationReview: {
          needsAdminReview: true,
          migratedFromSchemaVersion: 1,
          notices: ['Legacy migration notice.'],
        },
        sources: [
          {
            username: 'alpha',
            routeId: 'route_alpha',
            state: 'enabled',
            delivery: { mode: 'immediate' },
          },
          {
            username: 'beta',
            routeId: 'route_beta',
            state: 'enabled',
            delivery: { mode: 'immediate' },
          },
        ],
        queue: null,
        runtime: null,
      },
    ]);
  });

  await page.goto('/accounts');
  await expect(page.getByText('Migrated — review').first()).toBeVisible();

  await page.goto('/accounts?destinationId=destination-1&section=moderation');
  const dialog = page.getByRole('dialog', { name: 'Edit Bluesky Destination' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Moderation, routing, and dedup' })).toBeVisible();
  await expect(page).toHaveURL(/section=moderation/);

  const sections = dialog.getByRole('navigation', { name: 'Destination sections' });
  const sectionChecks: Array<{ label: string; assertion: () => Promise<void> }> = [
    {
      label: 'Overview',
      assertion: async () => {
        await expect(dialog.getByText('Linked Bluesky account')).toBeVisible();
        await expect(dialog.getByText('Credential saved')).toBeVisible();
        await expect(dialog.getByText('did:plc:mock')).toBeVisible();
      },
    },
    {
      label: 'Sources & routes',
      assertion: async () => {
        await expect(dialog.getByText('Source filters')).toBeVisible();
      },
    },
    {
      label: 'Delivery',
      assertion: async () => {
        await expect(dialog.getByLabel('Prepend the X username')).toBeVisible();
      },
    },
    {
      label: 'Moderation',
      assertion: async () => {
        await expect(dialog.getByRole('heading', { name: 'Moderation, routing, and dedup' })).toBeVisible();
      },
    },
    {
      label: 'Automation',
      assertion: async () => {
        await expect(dialog.locator('#edit-destination-allow-profile-mutation')).toBeVisible();
      },
    },
    {
      label: 'Operations',
      assertion: async () => {
        await expect(dialog.getByText('Legacy migration notice.')).toBeVisible();
      },
    },
  ];

  for (const { label, assertion } of sectionChecks) {
    await expect(sections.getByRole('button', { name: label })).toBeVisible();
    await sections.getByRole('button', { name: label }).click();
    await assertion();
  }

  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);

  await sections.getByRole('button', { name: 'Overview' }).click();
  await expect(dialog.getByText('Linked Bluesky account')).toBeVisible();
  await expect.poll(() => page.url()).toContain('section=overview');

  await sections.getByRole('button', { name: 'Delivery' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Prepend the X username')).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Destination sections' })).toBeVisible();
  await expect.poll(() => page.url()).toContain('section=delivery');

  await sections.getByRole('button', { name: 'Operations' }).click();
  await expect(dialog.getByText('Legacy migration notice.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Mark as reviewed' }).click();
  await expect
    .poll(() =>
      mutations.some((entry) => entry.path === '/api/destinations/destination-1/migration-review'),
    )
    .toBe(true);

  await page.goto('/accounts?destinationId=destination-1&section=nonsense');
  await expect(page.getByRole('dialog', { name: 'Edit Bluesky Destination' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Linked Bluesky account')).toBeVisible();
});
