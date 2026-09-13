import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('cached managed clients and profile/video entrypoints cannot mutate after an account block', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'mutation-gates.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { mock } from 'bun:test';
      mock.module('@the-convocation/twitter-scraper', () => ({ Scraper: class {
        async setCookies() {}
        async getProfile(username) { return { username, name: 'Redacted source', biography: 'Redacted biography' }; }
      } }));
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { getDefaultConfig } = await import(${moduleUrl('config/defaults.ts')});
      const { getAgent } = await import(${moduleUrl('bsky.ts')});
      const { blueskyAccountRuntimeService: health } = await import(${moduleUrl('db.ts')});
      const profile = await import(${moduleUrl('profile-mirror.ts')});
      const { fetchBlueskyVideoUpload } = await import(${moduleUrl('adapters/bluesky-video-request.ts')});
      const config = getDefaultConfig();
      config.twitter = { authToken: '<redacted-auth-token>', ct0: '<redacted-ct0>' };
      config.blueskyAccounts.push({ id: 'account', loginIdentifier: 'redacted.example', serviceUrl: 'https://bsky.social',
        appPassword: '<redacted-app-password>', did: 'did:plc:redacted',
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
      configManager.saveCanonicalConfig(config);
      const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ sub: 'did:plc:redacted', exp: 9999999999 })).toString('base64url') + '.redacted';
      const cid = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
      let mutations = 0;
      let authReads = 0;
      let suspendOnServiceAuth = false;
      let videoError = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!['bsky.social', 'video.bsky.app'].includes(url.hostname)) throw new Error('Unexpected fixture outbound request');
        const lexicon = url.pathname.split('/').pop();
        if (['com.atproto.server.createSession', 'com.atproto.server.refreshSession', 'com.atproto.server.getSession'].includes(lexicon)) {
          authReads++;
          return Response.json({ did: 'did:plc:redacted', handle: 'redacted.example', accessJwt: token, refreshJwt: token, emailConfirmed: true });
        }
        if (lexicon === 'com.atproto.server.getServiceAuth') {
          if (suspendOnServiceAuth) health.block('account', 'AccountTakedown');
          return Response.json({ token: '<redacted-service-token>' });
        }
        if (lexicon === 'com.atproto.repo.getRecord') return Response.json({ uri: 'at://did:plc:redacted/app.bsky.actor.profile/self', cid,
          value: { $type: 'app.bsky.actor.profile', displayName: 'Redacted' } });
        mutations++;
        if (videoError && lexicon === 'app.bsky.video.uploadVideo') return Response.json({ error: 'AccountDeactivated', message: 'Redacted provider message' }, { status: 403 });
        throw new Error('Provider mutation escaped the account guard');
      };
      const credentials = { bskyIdentifier: 'redacted.example', bskyPassword: '<redacted-app-password>', bskyServiceUrl: 'https://bsky.social' };
      const agent = await getAgent({ ...credentials, bskyAccountId: 'account', bskyDid: 'did:plc:redacted' });
      if (!agent) throw new Error('Fixture login failed');
      // The account becomes blocked after the cached agent obtained service authorization.
      suspendOnServiceAuth = true;
      await agent.com.atproto.server.getServiceAuth({ aud: 'did:web:bsky.social', lxm: 'com.atproto.repo.uploadBlob' });
      const failures = {};
      const attempt = async (name, operation) => {
        try { await operation(); failures[name] = 'unexpected-success'; }
        catch (error) { failures[name] = String(error).includes('blocked') ? 'blocked' : String(error); }
      };
      await attempt('cached-post', () => agent.post({ text: 'Redacted post', createdAt: new Date().toISOString() }));
      await attempt('cached-follow', () => agent.follow('did:plc:another'));
      await attempt('cached-delete', () => agent.deletePost('at://did:plc:redacted/app.bsky.feed.post/redacted'));
      await attempt('cached-upload', () => agent.uploadBlob(new Uint8Array([1, 2, 3]), { encoding: 'image/png' }));
      await attempt('pin-profile-record', () => agent.upsertProfile(existing => ({ ...existing, pinnedPost: { uri: 'at://did:plc:redacted/app.bsky.feed.post/redacted', cid } })));
      await attempt('bot-label', () => profile.ensureBlueskyBotSelfLabel({ ...credentials, authorization: { allowed: true, action: 'bot-label' } }));
      await attempt('display-name', () => profile.ensureBlueskyDisplayNameBotSuffix({ ...credentials, authorization: { allowed: true, action: 'display-name-suffix' } }));
      for (const action of ['profile-apply', 'profile-sync-scheduled']) await attempt(action, () => profile.syncBlueskyProfileFromTwitter({
        ...credentials, twitterUsername: 'source', authorization: { allowed: true, action, fields: { displayName: true, description: false, avatar: false, banner: false } },
      }));
      const videoUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo');
      const videoIdentity = { did: 'did:plc:redacted', serviceUrl: 'https://bsky.social' };
      await attempt('video-after-service-auth', () => fetchBlueskyVideoUpload(videoIdentity, videoUrl, { method: 'POST', body: new Uint8Array([1]), headers: { authorization: 'Bearer <redacted-service-token>' } }));
      const blockedMutations = mutations;
      const state = health.getBlock('account');
      if (!health.resume('account', state.runtimeRevision)) throw new Error('Fixture could not clear block for provider-response test');
      videoError = true;
      const response = await fetchBlueskyVideoUpload(videoIdentity, videoUrl, { method: 'POST', body: new Uint8Array([1]) });
      const result = { failures, blockedMutations, authReads, videoStatus: response.status, videoBlock: health.getBlock('account') };
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.failures).toEqual(
      Object.fromEntries(
        [
          'cached-post',
          'cached-follow',
          'cached-delete',
          'cached-upload',
          'pin-profile-record',
          'bot-label',
          'display-name',
          'profile-apply',
          'profile-sync-scheduled',
          'video-after-service-auth',
        ].map((name) => [name, 'blocked']),
      ),
    );
    expect(result.blockedMutations).toBe(0);
    expect(result.authReads).toBeGreaterThan(1);
    expect(result.videoStatus).toBe(403);
    expect(result.videoBlock.blockedReason).toBe('AccountDeactivated');
  } finally {
    temporary.cleanup();
  }
}, 30000);
