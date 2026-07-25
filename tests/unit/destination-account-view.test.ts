import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;

test('destination list account views expose credentialConfigured without appPassword', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'destination-account-view-result.json');
  fs.writeFileSync(
    path.join(temporary.path, 'config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        users: [],
        mappings: [
          {
            id: 'legacy-linked-1',
            twitterUsername: 'linked_source',
            bskyIdentifier: 'linked.example',
            bskyPassword: '<redacted-app-password>',
            bskyServiceUrl: 'https://bsky.social',
            bskyDid: 'did:plc:linked',
            enabled: true,
          },
        ],
        groups: [],
        twitter: {},
        ai: {},
        scheduler: { enabled: false, intervalMinutes: 10, runOnStartup: false },
        notifications: { enabled: false },
      },
      null,
      2,
    ),
  );
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { app } = await import(${JSON.stringify(serverModuleUrl)});
          const listener = app.listen(0, '127.0.0.1');
          await new Promise((resolve) => listener.once('listening', resolve));
          const port = listener.address().port;
          const api = 'http://127.0.0.1:' + port;
          const json = async (url, options = {}) => {
            const response = await fetch(api + url, {
              ...options,
              headers: { 'content-type': 'application/json', ...(options.headers || {}) }
            });
            const text = await response.text();
            try {
              return { status: response.status, body: JSON.parse(text) };
            } catch {
              return { status: response.status, body: text };
            }
          };
          try {
            await json('/api/register', {
              method: 'POST',
              body: JSON.stringify({ username: 'admin', password: 'test-password-123' })
            });
            const login = await json('/api/login', {
              method: 'POST',
              body: JSON.stringify({ identifier: 'admin', password: 'test-password-123' })
            });
            const auth = { authorization: 'Bearer ' + login.body.token };
            const list = await json('/api/destinations', { headers: auth });
            const destination = Array.isArray(list.body) ? list.body[0] : null;
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              status: list.status,
              credentialConfigured: destination?.credentialConfigured ?? null,
              blueskyAccount: destination?.blueskyAccount ?? null,
              hasBskyAccountId: Boolean(destination?.bskyAccountId),
              accountKeys: destination?.blueskyAccount ? Object.keys(destination.blueskyAccount).sort() : null,
              serialized: JSON.stringify(list.body),
            }));
          } finally {
            listener.close();
          }
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      status: number;
      credentialConfigured: boolean | null;
      blueskyAccount: Record<string, unknown> | null;
      hasBskyAccountId: boolean;
      accountKeys: string[] | null;
      serialized: string;
    };
    expect(result.status).toBe(200);
    expect(result.credentialConfigured).toBe(true);
    expect(result.hasBskyAccountId).toBe(true);
    expect(result.blueskyAccount).toBeTruthy();
    expect(result.accountKeys).not.toContain('appPassword');
    expect(result.accountKeys).toContain('credentialConfigured');
    expect(result.accountKeys).toContain('id');
    expect(result.accountKeys).toContain('loginIdentifier');
    expect(result.accountKeys).toContain('serviceUrl');
    expect(result.accountKeys).toContain('health');
    expect(result.blueskyAccount?.credentialConfigured).toBe(true);
    expect(result.serialized).not.toContain('<redacted-app-password>');
    expect(result.serialized).not.toContain('appPassword');
  } finally {
    temporary.cleanup();
  }
});
