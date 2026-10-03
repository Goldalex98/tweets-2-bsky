import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('profile record writes are conditional on the record that was read', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'profile-swap.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const profile = await import(${moduleUrl('profile-mirror.ts')});
      const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ sub: 'did:plc:redacted', exp: 9999999999 })).toString('base64url') + '.redacted';
      const cid = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
      let profileExists = true;
      const writes = [];
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(request.url);
        if (url.hostname !== 'bsky.social') throw new Error('Unexpected fixture outbound request ' + url.hostname);
        const lexicon = url.pathname.split('/').pop();
        if (lexicon === 'com.atproto.server.createSession') {
          return Response.json({ did: 'did:plc:redacted', handle: 'redacted.example', accessJwt: token, refreshJwt: token });
        }
        if (lexicon === 'com.atproto.server.getSession') return Response.json({ did: 'did:plc:redacted', handle: 'redacted.example' });
        if (lexicon === 'com.atproto.repo.getRecord') {
          if (!profileExists) return Response.json({ error: 'RecordNotFound', message: 'Could not locate record' }, { status: 400 });
          return Response.json({ uri: 'at://did:plc:redacted/app.bsky.actor.profile/self', cid,
            value: { $type: 'app.bsky.actor.profile', displayName: 'Old' } });
        }
        if (lexicon === 'com.atproto.repo.putRecord') {
          writes.push(await request.json());
          return Response.json({ uri: 'at://did:plc:redacted/app.bsky.actor.profile/self', cid });
        }
        throw new Error('Unexpected fixture lexicon ' + lexicon);
      };
      const login = { bskyIdentifier: 'redacted.example', bskyPassword: '<redacted-app-password>', bskyServiceUrl: 'https://bsky.social' };
      await profile.ensureBlueskyBotSelfLabel({ ...login, authorization: { allowed: true, action: 'bot-label' } });
      await profile.ensureBlueskyDisplayNameBotSuffix({ ...login, authorization: { allowed: true, action: 'display-name-suffix' } });
      profileExists = false;
      await profile.ensureBlueskyBotSelfLabel({ ...login, authorization: { allowed: true, action: 'bot-label' } });
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(writes.map((write) => write.swapRecord ?? null)));
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    // An existing profile is swapped against its CID; a missing one is created unconditionally.
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual([
      'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      null,
    ]);
  } finally {
    temporary.cleanup();
  }
}, 30000);
