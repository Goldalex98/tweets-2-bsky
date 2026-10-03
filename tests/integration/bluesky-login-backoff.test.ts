import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('a rejected Bluesky login backs off; password changes, operator actions and outages do not', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'login-backoff.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const { getAgent, clearCachedAgent } = await import(${moduleUrl('bsky.ts')});
      let logins = 0;
      let networkDown = false;
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'bsky.social') throw new Error('Unexpected fixture outbound request');
        if (url.pathname.endsWith('com.atproto.server.createSession')) {
          logins++;
          if (networkDown) throw new TypeError('fetch failed');
          return Response.json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, { status: 401 });
        }
        throw new Error('Unexpected fixture lexicon ' + url.pathname);
      };
      const mapping = { id: 'destination', bskyIdentifier: 'redacted.example', bskyPassword: '<redacted-old>', bskyServiceUrl: 'https://bsky.social' };
      const first = await getAgent(mapping);
      const second = await getAgent(mapping);
      const afterBackoff = logins;
      const rotated = await getAgent({ ...mapping, bskyPassword: '<redacted-new>' });
      const afterRotation = logins;
      clearCachedAgent({ ...mapping, bskyPassword: '<redacted-new>' });
      await getAgent({ ...mapping, bskyPassword: '<redacted-new>' });
      const afterClear = logins;
      await getAgent({ ...mapping, bskyPassword: '<redacted-new>' }, { bypassLoginBackoff: true });
      const afterBypass = logins;
      networkDown = true;
      const outage = { ...mapping, bskyIdentifier: 'outage.example' };
      await getAgent(outage);
      await getAgent(outage);
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        first: first === null, second: second === null, rotated: rotated === null,
        afterBackoff, afterRotation, afterClear, afterBypass, afterOutage: logins,
      }));
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      first: true,
      second: true,
      rotated: true,
      afterBackoff: 1,
      afterRotation: 2,
      afterClear: 3,
      afterBypass: 4,
      // A network failure is not a rejected credential and does not back off.
      afterOutage: 6,
    });
  } finally {
    temporary.cleanup();
  }
}, 30000);
