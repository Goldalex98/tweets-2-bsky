import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir, type TemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

async function runFixture(temporary: TemporaryDataDir, name: string, script: string) {
  const resultPath = path.join(temporary.path, `${name}.json`);
  const child = Bun.spawn(
    [process.execPath, '--eval', `${script}\nawait Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));`],
    {
      env: { ...temporary.env, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}

test('structured login suspension survives restart without changing canonical account identity', async () => {
  const temporary = createTemporaryDataDir();
  try {
    const first = await runFixture(
      temporary,
      'before-restart',
      `
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { getDefaultConfig } = await import(${moduleUrl('config/defaults.ts')});
      const { getAgent } = await import(${moduleUrl('bsky.ts')});
      const { blueskyAccountRuntimeService: health } = await import(${moduleUrl('db.ts')});
      const { ACTIVE_CONFIG_FILE } = await import(${moduleUrl('storage-paths.ts')});
      const config = getDefaultConfig();
      config.blueskyAccounts = ['takedown', 'deactivated', 'transient'].map(id => ({
        id, loginIdentifier: id + '.example', serviceUrl: 'https://bsky.social',
        appPassword: '<redacted-app-password>', did: 'did:plc:' + id,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }));
      configManager.saveCanonicalConfig(config);
      const before = await Bun.file(ACTIVE_CONFIG_FILE).text();
      const calls = [];
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).pathname !== '/xrpc/com.atproto.server.createSession') throw new Error('Unexpected fixture request');
        const identifier = (await new Response(init.body).json()).identifier;
        calls.push(identifier);
        const error = identifier.startsWith('takedown') ? 'AccountTakedown' : identifier.startsWith('deactivated') ? 'AccountDeactivated' : 'AuthenticationRequired';
        return Response.json({ error, message: 'AccountTakedown text alone is not a suspension' }, { status: 403 });
      };
      const loginResults = [];
      for (const account of config.blueskyAccounts) loginResults.push(await getAgent({
        bskyAccountId: account.id, bskyIdentifier: account.loginIdentifier,
        bskyPassword: account.appPassword, bskyDid: account.did, bskyServiceUrl: account.serviceUrl,
      }));
      const result = { calls, loginResults, states: config.blueskyAccounts.map(account => health.getBlock(account.id)),
        canonicalUnchanged: before === await Bun.file(ACTIVE_CONFIG_FILE).text() };
    `,
    );
    expect(first.loginResults).toEqual([null, null, null]);
    expect(first.calls).toHaveLength(3);
    expect(first.states[0]).toMatchObject({ blockedReason: 'AccountTakedown', runtimeRevision: 1 });
    expect(first.states[1]).toMatchObject({ blockedReason: 'AccountDeactivated', runtimeRevision: 1 });
    expect(first.states[0].blockedAt).toBeGreaterThan(0);
    expect(first.states[2]).toEqual({ runtimeRevision: 0 });
    expect(first.canonicalUnchanged).toBe(true);

    const restarted = await runFixture(
      temporary,
      'after-restart',
      `
      const { blueskyAccountRuntimeService: health } = await import(${moduleUrl('db.ts')});
      const { getConfig } = await import(${moduleUrl('config-manager.ts')});
      const { getAgent } = await import(${moduleUrl('bsky.ts')});
      let outbound = 0;
      globalThis.fetch = async () => { outbound++; throw new Error('Blocked account must not contact provider'); };
      const denied = [];
      for (const account of getConfig().blueskyAccounts.slice(0, 2)) {
        try { await getAgent({ bskyAccountId: account.id, bskyIdentifier: account.loginIdentifier, bskyPassword: account.appPassword }); }
        catch (error) { denied.push(String(error).includes('blocked')); }
      }
      const result = { states: ['takedown', 'deactivated', 'transient'].map(id => health.getBlock(id)), denied, outbound };
    `,
    );
    expect(restarted.states).toEqual(first.states);
    expect(restarted.denied).toEqual([true, true]);
    expect(restarted.outbound).toBe(0);
  } finally {
    temporary.cleanup();
  }
});

test('resume rejects nonowners and an administrator whose authority is revoked during validation', async () => {
  const temporary = createTemporaryDataDir();
  try {
    const result = await runFixture(
      temporary,
      'authorization',
      `
      import { mock } from 'bun:test';
      const profile = await import(${moduleUrl('profile-mirror.ts')});
      let validationHook = () => {};
      let validations = 0;
      mock.module(${moduleUrl('profile-mirror.ts')}, () => ({ ...profile, validateBlueskyCredentials: async () => {
        validations++; await validationHook();
        return { did: 'did:plc:redacted', handle: 'redacted.example', serviceUrl: 'https://bsky.social', emailConfirmed: true };
      } }));
      const { app } = await import(${moduleUrl('server.ts')});
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { getDefaultUserPermissions } = await import(${moduleUrl('config/defaults.ts')});
      const { blueskyAccountRuntimeService: health } = await import(${moduleUrl('db.ts')});
      const listener = app.listen(0, '127.0.0.1');
      await new Promise(resolve => listener.once('listening', resolve));
      const api = 'http://127.0.0.1:' + listener.address().port;
      const networkFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (!String(input).startsWith(api + '/')) throw new Error('Unexpected fixture outbound request');
        return networkFetch(input, init);
      };
      const json = async (url, body, auth = {}) => {
        const response = await fetch(api + url, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      let result;
      try {
        await json('/api/register', { username: 'admin', password: 'redacted-test-password' });
        const admin = await json('/api/login', { identifier: 'admin', password: 'redacted-test-password', includeBearerToken: true });
        const adminAuth = { authorization: 'Bearer ' + admin.body.token };
        // Keep a separate administrator so config normalization can retain the demotion.
        await json('/api/admin/users', { username: 'backup-admin', password: 'redacted-test-password', isAdmin: true }, adminAuth);
        const createdMember = await json('/api/admin/users', { username: 'member', password: 'redacted-test-password', isAdmin: false, permissions: { manageOwnMappings: true } }, adminAuth);
        if (createdMember.status !== 200) throw new Error('Fixture member creation failed: ' + JSON.stringify(createdMember));
        const member = await json('/api/login', { identifier: 'member', password: 'redacted-test-password', includeBearerToken: true });
        const memberAuth = { authorization: 'Bearer ' + member.body.token };
        const seed = configManager.getConfig();
        seed.blueskyAccounts.push({ id: 'account', loginIdentifier: 'redacted.example', serviceUrl: 'https://bsky.social',
          appPassword: '<redacted-app-password>', did: 'did:plc:redacted', createdByUserId: 'different-owner',
          createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
        configManager.saveCanonicalConfig(seed);
        health.block('account', 'AccountTakedown');
        const before = health.getBlock('account');
        const body = () => ({ revision: configManager.getConfig().revision, runtimeRevision: health.getBlock('account').runtimeRevision });
        const nonowner = await json('/api/bluesky-accounts/account/resume', body(), memberAuth);
        const readsAfterNonowner = validations;
        validationHook = () => {
          const current = configManager.getConfig();
          const actor = current.users.find(user => user.username === 'admin');
          actor.role = 'user'; actor.permissions = getDefaultUserPermissions('user');
          configManager.saveCanonicalConfig(current);
        };
        const revoked = await json('/api/bluesky-accounts/account/resume', body(), adminAuth);
        result = { nonowner, readsAfterNonowner, revoked, validations, before, after: health.getBlock('account') };
      } finally { await new Promise(resolve => listener.close(resolve)); }
    `,
    );
    expect(result.nonowner.status).toBe(403);
    expect(result.readsAfterNonowner).toBe(0);
    expect(result.revoked.status).toBe(403);
    expect(result.validations).toBe(1);
    expect(result.after).toEqual(result.before);
  } finally {
    temporary.cleanup();
  }
}, 30000);

test('blocked destinations retain new ingestion and immutable queue/digest identity until resumed', async () => {
  const temporary = createTemporaryDataDir();
  try {
    const result = await runFixture(
      temporary,
      'retained-work',
      `
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { routeNormalizedPost } = await import(${moduleUrl('ingestion.ts')});
      const { blueskyAccountRuntimeService: health, postQueueService, digestEntryService, digestJobService } = await import(${moduleUrl('db.ts')});
      const { blockedBlueskyDestinationIds } = await import(${moduleUrl('services/bluesky-mutation-guard.ts')});
      globalThis.fetch = async () => { throw new Error('Ingestion fixture must not contact a provider'); };
      for (const name of ['immediate', 'digest']) configManager.addMapping({
        twitterUsernames: ['source'], pausedTwitterUsernames: [], bskyIdentifier: name + '.example',
        bskyPassword: '<redacted-app-password>', bskyDid: 'did:plc:' + name,
      });
      const seed = configManager.getConfig();
      for (const destination of seed.destinations) {
        if (!destination.bskyAccountId) {
          destination.bskyAccountId = 'account-' + destination.id;
          seed.blueskyAccounts.push({ id: destination.bskyAccountId, loginIdentifier: destination.bskyIdentifier,
            did: destination.bskyDid, serviceUrl: 'https://bsky.social', appPassword: '<redacted-app-password>',
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
        }
      }
      const digestDestination = seed.destinations.find(destination => destination.bskyIdentifier === 'digest.example');
      const digestRoute = seed.routes.find(route => route.destinationId === digestDestination.id);
      digestRoute.delivery.mode = 'digest'; digestRoute.delivery.digest.enabled = true;
      configManager.saveCanonicalConfig(seed);
      const config = configManager.getConfig();
      const identity = value => ({
        sources: value.sources.map(source => ({ id: source.id, enabled: source.enabled })),
        routes: value.routes.map(route => ({ id: route.id, sourceId: route.sourceId, destinationId: route.destinationId, enabled: route.enabled })),
        destinations: value.destinations.map(destination => ({ id: destination.id, bskyAccountId: destination.bskyAccountId, storageKey: destination.storageKey, enabled: destination.enabled })),
        accounts: value.blueskyAccounts.map(account => ({ id: account.id, did: account.did })),
      });
      const beforeIdentity = identity(config);
      for (const account of config.blueskyAccounts) health.block(account.id, 'AccountTakedown');
      const post = id => ({ sourceType: 'x', sourceId: config.sources[0].id, externalId: id, text: 'Retained post ' + id,
        authorUsername: 'source', createdAt: new Date().toISOString(), urls: [], media: [], sensitive: false });
      const firstIngestion = routeNormalizedPost(config, post('first'));
      const queueBefore = postQueueService.inspect({});
      const digestBefore = digestEntryService.list();
      digestJobService.arm(digestDestination.id, digestRoute.id, 1);
      const excluded = new Set(blockedBlueskyDestinationIds(config.destinations));
      const allowed = new Set(config.destinations.map(destination => destination.id));
      const blockedQueue = postQueueService.claimNextBatch(excluded, allowed);
      const blockedDigest = digestJobService.claimNext(excluded);
      const secondIngestion = routeNormalizedPost(config, post('second'));
      const changed = configManager.getConfig();
      // An ordinary config save must not rewrite work captured before the edit.
      changed.destinations[0].postingPolicy.appendOriginalPostLink = !changed.destinations[0].postingPolicy.appendOriginalPostLink;
      configManager.saveCanonicalConfig(changed);
      const queueAfter = postQueueService.inspect({});
      const digestAfter = digestEntryService.list();
      const retainedQueue = queueAfter.find(item => item.queue_id === queueBefore[0].queue_id);
      const retainedDigest = digestAfter.find(item => item.id === digestBefore[0].id);
      for (const account of config.blueskyAccounts) health.resume(account.id, health.getBlock(account.id).runtimeRevision);
      const afterExcluded = new Set(blockedBlueskyDestinationIds(configManager.getConfig().destinations));
      const resumedQueue = postQueueService.claimNextBatch(afterExcluded, allowed);
      const resumedDigest = digestJobService.claimNext(afterExcluded);
      const result = { firstIngestion, secondIngestion, excluded: [...excluded], blockedQueue, blockedDigest,
        queueBefore: queueBefore[0], retainedQueue, digestBefore: digestBefore[0], retainedDigest,
        queued: queueAfter.length, digested: digestAfter.length, beforeIdentity, afterIdentity: identity(configManager.getConfig()),
        resumedQueue: !!resumedQueue, resumedDigest: !!resumedDigest, afterExcluded: [...afterExcluded] };
    `,
    );
    expect(result.firstIngestion.accepted).toBe(2);
    expect(result.secondIngestion.accepted).toBe(2);
    expect(result.excluded).toHaveLength(2);
    expect(result.blockedQueue).toBeNull();
    expect(result.blockedDigest).toBeNull();
    expect(result.queued).toBe(2);
    expect(result.digested).toBe(2);
    expect(result.retainedQueue).toEqual({ ...result.queueBefore, queue_age_ms: expect.any(Number) });
    expect(result.retainedDigest).toEqual(result.digestBefore);
    expect(result.queueBefore.policy_snapshot).toBeTruthy();
    expect(result.digestBefore.policySnapshot).toBeTruthy();
    expect(result.afterIdentity).toEqual(result.beforeIdentity);
    expect(result.resumedQueue).toBe(true);
    expect(result.resumedDigest).toBe(true);
    expect(result.afterExcluded).toEqual([]);
  } finally {
    temporary.cleanup();
  }
});
