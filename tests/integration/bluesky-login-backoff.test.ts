import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('a failed Bluesky login is not retried on the next call, and a password change retries at once', async () => {
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
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'bsky.social') throw new Error('Unexpected fixture outbound request');
        if (url.pathname.endsWith('com.atproto.server.createSession')) {
          logins++;
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
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        first: first === null, second: second === null, rotated: rotated === null, afterBackoff, afterRotation, afterClear: logins,
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
    });
  } finally {
    temporary.cleanup();
  }
}, 30000);
