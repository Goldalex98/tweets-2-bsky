import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('a profile sync logs in to Bluesky once and writes with that session', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'profile-single-login.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { mock } from 'bun:test';
      mock.module('@the-convocation/twitter-scraper', () => ({ Scraper: class {
        async setCookies() {}
        async getProfile(username) { return { username, name: 'Redacted source', biography: '' }; }
      } }));
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { getDefaultConfig } = await import(${moduleUrl('config/defaults.ts')});
      const profile = await import(${moduleUrl('profile-mirror.ts')});
      const config = getDefaultConfig();
      config.twitter = { authToken: '<redacted-auth-token>', ct0: '<redacted-ct0>' };
      configManager.saveCanonicalConfig(config);
      const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ sub: 'did:plc:redacted', exp: 9999999999 })).toString('base64url') + '.redacted';
      const cid = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
      const calls = { createSession: 0, putRecord: 0 };
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'bsky.social') throw new Error('Unexpected fixture outbound request ' + url.hostname);
        const lexicon = url.pathname.split('/').pop();
        if (lexicon === 'com.atproto.server.createSession') {
          calls.createSession++;
          return Response.json({ did: 'did:plc:redacted', handle: 'redacted.example', accessJwt: token, refreshJwt: token });
        }
        if (lexicon === 'com.atproto.server.getSession') return Response.json({ did: 'did:plc:redacted', handle: 'redacted.example' });
        if (lexicon === 'com.atproto.repo.getRecord') return Response.json({ uri: 'at://did:plc:redacted/app.bsky.actor.profile/self', cid,
          value: { $type: 'app.bsky.actor.profile', displayName: 'Old' } });
        if (lexicon === 'com.atproto.repo.putRecord') {
          calls.putRecord++;
          return Response.json({ uri: 'at://did:plc:redacted/app.bsky.actor.profile/self', cid });
        }
        throw new Error('Unexpected fixture lexicon ' + lexicon);
      };
      const result = await profile.syncBlueskyProfileFromTwitter({
        twitterUsername: 'source', bskyIdentifier: 'redacted.example', bskyPassword: '<redacted-app-password>',
        bskyServiceUrl: 'https://bsky.social',
        authorization: { allowed: true, action: 'profile-sync-scheduled', fields: { displayName: true, description: false, avatar: false, banner: false } },
      });
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ calls, skipped: result.skipped }));
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      calls: { createSession: 1, putRecord: 1 },
      skipped: false,
    });
  } finally {
    temporary.cleanup();
  }
}, 30000);
