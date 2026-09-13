import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('real account API validates without resuming, protects resume CAS and gates provider mutations', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'block-result.json');
  const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { mock } from 'bun:test';
      const profile = await import(${moduleUrl('profile-mirror.ts')});
      const validateCredentials = profile.validateBlueskyCredentials;
      let validationHook = () => {};
      let reads = 0;
      let validationMutations = 0;
      const networkFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith('http://127.0.0.1:')) return networkFetch(input, init);
        if (!url.startsWith('https://bsky.social/xrpc/')) throw new Error('Unexpected fixture outbound request');
        const lexicon = new URL(url).pathname.split('/').pop();
        if (!['com.atproto.server.createSession', 'com.atproto.server.refreshSession', 'com.atproto.server.getSession'].includes(lexicon)) validationMutations++;
        const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' +
          Buffer.from(JSON.stringify({ sub: 'did:plc:redacted', exp: 9999999999 })).toString('base64url') + '.redacted';
        return new Response(JSON.stringify({ did: 'did:plc:redacted', handle: 'redacted.bsky.social', accessJwt: token, refreshJwt: token, emailConfirmed: true }), { headers: { 'content-type': 'application/json' } });
      };
      let restartRequired = false;
      const backup = await import(${moduleUrl('backup-service.ts')});
      mock.module(${moduleUrl('backup-service.ts')}, () => ({ ...backup, isRestoreRestartRequired: () => restartRequired }));
      mock.module(${moduleUrl('profile-mirror.ts')}, () => ({ ...profile, validateBlueskyCredentials: async (args) => {
        reads++; await validationHook();
        return validateCredentials(args);
      } }));
      const { app } = await import(${moduleUrl('server.ts')});
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { blueskyAccountRuntimeService: health } = await import(${moduleUrl('db.ts')});
      const { managedBlueskyFetch, providerAccountBlock } = await import(${moduleUrl('services/bluesky-mutation-guard.ts')});
      const listener = app.listen(0, '127.0.0.1');
      await new Promise(resolve => listener.once('listening', resolve));
      const api = 'http://127.0.0.1:' + listener.address().port;
      const json = async (url, body, auth) => {
        const response = await fetch(api + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth || {}) }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      try {
        await json('/api/register', { username: 'admin', password: 'redacted-test-password' });
        const login = await json('/api/login', { includeBearerToken: true, identifier: 'admin', password: 'redacted-test-password' });
        const auth = { authorization: 'Bearer ' + login.body.token };
        const revision = () => configManager.getConfigVersion(configManager.getConfig()).revision;
        const created = await json('/api/bluesky-accounts', { revision: revision(), loginIdentifier: 'redacted.bsky.social', appPassword: '<redacted-app-password>' }, auth);
        if (created.status !== 201) throw new Error('Create failed: ' + JSON.stringify(created));
        const id = created.body.id;
        configManager.addMapping({ twitterUsernames: ['redactedsource'], bskyIdentifier: 'preview.bsky.social',
          bskyPassword: '<redacted-app-password>', createdByUserId: configManager.getConfig().users[0].id });
        const previewMapping = configManager.getConfig().mappings.find(mapping => mapping.bskyIdentifier === 'preview.bsky.social');
        const preview = await json('/api/mappings/' + previewMapping.id + '/posting/preview', { text: 'Fixture preview', twitterUsername: 'redactedsource', tweetId: '123' }, auth);
        health.block(id, 'AccountTakedown');
        const validate = await json('/api/bluesky-accounts/' + id + '/validate', { revision: revision() }, auth);
        const retained = health.getBlock(id);
        const unauth = await json('/api/bluesky-accounts/' + id + '/resume', { revision: revision(), runtimeRevision: retained.runtimeRevision });
        validationHook = async () => health.block(id, 'AccountDeactivated');
        const staleRuntime = await json('/api/bluesky-accounts/' + id + '/resume', { revision: revision(), runtimeRevision: retained.runtimeRevision }, auth);
        validationHook = async () => { const config = configManager.getConfig(); configManager.saveCanonicalConfig(config); };
        const staleConfig = await json('/api/bluesky-accounts/' + id + '/resume', { revision: revision(), runtimeRevision: health.getBlock(id).runtimeRevision }, auth);
        validationHook = async () => { throw new Error('Provider unavailable'); };
        const failedValidation = await json('/api/bluesky-accounts/' + id + '/resume', { revision: revision(), runtimeRevision: health.getBlock(id).runtimeRevision }, auth);
        const stillBlocked = !!health.getBlock(id).blockedReason;
        validationHook = async () => { restartRequired = true; };
        const restoreRace = await json('/api/bluesky-accounts/' + id + '/resume', { revision: revision(), runtimeRevision: health.getBlock(id).runtimeRevision }, auth);
        restartRequired = false;
        validationHook = async () => {};
        const resumed = await json('/api/bluesky-accounts/' + id + '/resume', { revision: revision(), runtimeRevision: health.getBlock(id).runtimeRevision }, auth);
        health.block(id, 'AccountTakedown');
        const managed = managedBlueskyFetch({ bskyAccountId: id, bskyIdentifier: 'redacted.bsky.social' });
        const originalFetch = globalThis.fetch;
        let providerMutations = 0;
        globalThis.fetch = async () => { providerMutations++; return new Response('{}', { status: 200 }); };
        let denied = 0;
        try {
          for (const method of ['com.atproto.repo.createRecord', 'com.atproto.repo.putRecord', 'com.atproto.repo.deleteRecord', 'app.bsky.graph.muteActor']) {
            try { await managed('https://bsky.social/xrpc/' + method, { method: 'POST' }); } catch { denied++; }
          }
        } finally { globalThis.fetch = originalFetch; }
        const transient = providerAccountBlock({ error: 'AuthenticationRequired', message: 'AccountTakedown', status: 403 });
        await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ created: created.status, validate, retained, unauth: unauth.status,
          staleRuntime, staleConfig, failedValidation: failedValidation.status, stillBlocked, resumed, denied, providerMutations,
          transient: transient ?? null, restoreRace: restoreRace.status, preview, validationMutations, reads, secretLeaked: JSON.stringify([created,validate,resumed]).includes('<redacted-app-password>') }));
      } finally { globalThis.fetch = networkFetch; await new Promise(resolve => listener.close(resolve)); }
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.created).toBe(201);
    expect(result.validate.status).toBe(200);
    expect(result.retained.blockedReason).toBe('AccountTakedown');
    expect(result.unauth).toBe(401);
    expect(result.staleRuntime.status).toBe(409);
    expect(result.staleRuntime.body.code).toBe('BSKY_ACCOUNT_RUNTIME_CONFLICT');
    expect(result.staleConfig.status).toBe(409);
    expect(result.failedValidation).toBe(400);
    expect(result.stillBlocked).toBe(true);
    expect(result.restoreRace).toBe(503);
    expect(result.resumed.status).toBe(200);
    expect(result.resumed.body.account.health.blockedReason).toBeUndefined();
    expect(result.denied).toBe(4);
    expect(result.providerMutations).toBe(0);
    expect(result.validationMutations).toBe(0);
    expect(result.preview.status).toBe(200);
    expect(result.preview.body.text).toContain('Fixture preview');
    expect(result.transient).toBeNull();
    expect(result.secretLeaked).toBe(false);
  } finally {
    temporary.cleanup();
  }
}, 30000);
