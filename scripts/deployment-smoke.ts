import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type JsonObject = Record<string, unknown>;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const object = (value: unknown): JsonObject => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected JSON object');
  return value as JsonObject;
};
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function deploymentOrigin(value: string): URL {
  const url = new URL(value);
  assert(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'DEPLOYMENT_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment',
  );
  return url;
}

// Consume only the existing session cookie. Never create/revoke sessions or read localStorage tokens.
export function deploymentCookie(state: unknown, origin: URL): string {
  const cookies = object(state).cookies;
  assert(Array.isArray(cookies), 'Storage state must contain cookies');
  const matches = cookies.map(object).filter((cookie) => {
    if (cookie.name !== 't2b_session' || typeof cookie.domain !== 'string') return false;
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const domainMatches =
      origin.hostname === domain || (cookie.domain.startsWith('.') && origin.hostname.endsWith(`.${domain}`));
    return (
      domainMatches &&
      cookie.path === '/' &&
      cookie.secure === true &&
      cookie.httpOnly === true &&
      typeof cookie.expires === 'number' &&
      (cookie.expires === -1 || cookie.expires * 1000 > Date.now())
    );
  });
  assert(matches.length === 1, 'Exactly one valid secure session cookie must match the deployment origin');
  const value = matches[0]?.value;
  assert(typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value), 'Invalid session cookie');
  return `t2b_session=${value}`;
}

export function identityFingerprint(destinationsValue: unknown, accountsValue: unknown): string {
  assert(Array.isArray(destinationsValue) && Array.isArray(accountsValue), 'Identity endpoints must return arrays');
  const accounts = accountsValue.map(object);
  const destinations = destinationsValue.map(object);
  const accountIds = new Set(accounts.map((account) => account.id));
  assert(accountIds.size === accounts.length, 'Duplicate account identity');
  assert(
    new Set(destinations.map((destination) => destination.id)).size === destinations.length,
    'Duplicate destination identity',
  );
  const linked = new Set<unknown>();
  const destinationIdentity = destinations.map((destination) => {
    assert(
      typeof destination.id === 'string' &&
        typeof destination.storageKey === 'string' &&
        typeof destination.enabled === 'boolean',
      'Missing destination identity/state',
    );
    if (destination.bskyAccountId) {
      assert(
        accountIds.has(destination.bskyAccountId) && !linked.has(destination.bskyAccountId),
        'Invalid account linkage',
      );
      linked.add(destination.bskyAccountId);
      assert(
        accounts.find((account) => account.id === destination.bskyAccountId)?.linkedDestinationId === destination.id,
        'Account and destination linkage disagree',
      );
    }
    const sources = Array.isArray(destination.sources)
      ? destination.sources
          .map(object)
          .map((source) => [source.routeId, source.username, source.state])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : [];
    return [
      destination.id,
      destination.bskyAccountId ?? null,
      destination.storageKey,
      destination.bskyDid ?? null,
      destination.enabled,
      sources,
    ];
  });
  const accountIdentity = accounts.map((account) => {
    assert(typeof account.id === 'string', 'Missing account identity');
    return [account.id, account.did ?? null, account.loginIdentifier, account.serviceUrl, account.linkedDestinationId];
  });
  const sort = (a: unknown[], b: unknown[]) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  return fingerprint([destinationIdentity.sort(sort), accountIdentity.sort(sort)]);
}

export function queueCounts(value: unknown): Record<string, number> {
  const queue = object(value);
  const result: Record<string, number> = {};
  for (const key of ['pending', 'processing', 'failed']) {
    const count = queue[key];
    assert(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0, 'Invalid queue counters');
    result[key] = count;
  }
  return result;
}

export async function runDeploymentSmoke(env = process.env): Promise<void> {
  assert(
    env.DEPLOYMENT_BASE_URL &&
      env.DEPLOYMENT_STORAGE_STATE &&
      env.DEPLOYMENT_EXPECTED_VERSION &&
      env.DEPLOYMENT_REPORT_PATH,
    'Set DEPLOYMENT_BASE_URL, DEPLOYMENT_STORAGE_STATE, DEPLOYMENT_EXPECTED_VERSION, and DEPLOYMENT_REPORT_PATH',
  );
  const origin = deploymentOrigin(env.DEPLOYMENT_BASE_URL);
  const cookie = deploymentCookie(JSON.parse(await fs.readFile(env.DEPLOYMENT_STORAGE_STATE, 'utf8')), origin);
  const get = async (route: string, authenticated = true, expectedStatus = 200): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(new URL(route, origin), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: authenticated ? { cookie, accept: 'application/json' } : {},
      });
    } catch {
      throw new Error(`Deployment GET ${route} transport failure`);
    }
    assert(response.status === expectedStatus, `Deployment GET ${route} unexpected HTTP status ${response.status}`);
    return response;
  };
  const json = async (route: string, authenticated = true) => {
    const response = await get(route, authenticated);
    assert(response.headers.get('content-type')?.includes('application/json'), `Deployment GET ${route} is not JSON`);
    return response.json();
  };
  await get('/api/me', false, 401);
  const me = object(await json('/api/me'));
  assert(me.isAdmin === true, 'An existing admin session is required for complete identity coverage');
  const health = object(await json('/healthz', false));
  const ready = object(await json('/readyz', false));
  assert(
    health.status === 'ok' && health.database === 'ok' && ready.status === 'ready' && ready.restartRequired === false,
    'Deployment is not healthy and ready',
  );
  const version = object(await json('/api/version'));
  assert(
    version.version === env.DEPLOYMENT_EXPECTED_VERSION,
    'Deployed application version differs from expected release',
  );
  const details = object(await json('/api/health/details'));
  assert(details.status === 'ok' && details.restartRequired === false, 'Authenticated health failed');
  const status = object(await json('/api/status'));
  const destinations = await json('/api/destinations');
  const accounts = await json('/api/bluesky-accounts');
  const identity = identityFingerprint(destinations, accounts);
  const queue = queueCounts(status.queue);
  const htmlResponse = await get('/', false);
  assert(htmlResponse.headers.get('content-type')?.includes('text/html'), 'Dashboard response is not HTML');
  assert(htmlResponse.headers.get('x-content-type-options') === 'nosniff', 'Missing nosniff response header');
  const html = await htmlResponse.text();
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))(?:["'])/g)].map((match) => match[1]);
  assert(assets.length > 0, 'No dashboard JavaScript/CSS assets found');
  for (const asset of assets) {
    assert(asset, 'Invalid asset reference');
    const url = new URL(asset, origin);
    assert(url.origin === origin.origin, 'Unexpected external dashboard asset');
    const response = await get(`${url.pathname}${url.search}`, false);
    const type = response.headers.get('content-type') ?? '';
    assert(
      url.pathname.endsWith('.js') ? /javascript/.test(type) : /text\/css/.test(type),
      'Incorrect dashboard asset content type',
    );
  }
  if (env.DEPLOYMENT_BASELINE_PATH) {
    const baseline = object(JSON.parse(await fs.readFile(env.DEPLOYMENT_BASELINE_PATH, 'utf8')));
    assert(
      baseline.originFingerprint === fingerprint(origin.origin) && baseline.identityFingerprint === identity,
      'Deployment identity/state differs from baseline; investigate without rewriting baseline',
    );
  }
  const report = {
    recordedAt: new Date().toISOString(),
    version: version.version,
    originFingerprint: fingerprint(origin.origin),
    identityFingerprint: identity,
    databaseMigration: details.databaseMigration,
    queue,
    identityBaselineCompared: Boolean(env.DEPLOYMENT_BASELINE_PATH),
    assetsChecked: assets.length,
    apiAndAssets: 'passed',
    remainingEvidence: [
      'running image digest',
      'host schema and queue/history/checkpoint reconciliation',
      'production browser suite',
      'sanitized container logs',
      'natural delivery diagnostics (report unexercised when absent)',
    ],
  };
  const reportPath = path.resolve(env.DEPLOYMENT_REPORT_PATH);
  assert(
    reportPath !== path.resolve(env.DEPLOYMENT_STORAGE_STATE) &&
      (!env.DEPLOYMENT_BASELINE_PATH || reportPath !== path.resolve(env.DEPLOYMENT_BASELINE_PATH)),
    'Report must not overwrite authentication or baseline',
  );
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Deployment read-only API/assets checks passed; remaining evidence is listed in the protected report.');
}

if (import.meta.main) {
  runDeploymentSmoke().catch((error: unknown) => {
    // Never print arbitrary provider bodies, storage-state parsing context, or fetch internals.
    console.error(
      error instanceof Error && error.message.startsWith('Deployment ')
        ? error.message
        : 'Deployment smoke failed; inspect locally without exposing credentials.',
    );
    process.exitCode = 1;
  });
}
