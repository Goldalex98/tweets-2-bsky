import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('inbound credentials, HMAC replay, idempotency, and one-time secrets work together', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'ingestion-result.json');
  const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { createHmac } = await import('node:crypto');
          const { app } = await import(${JSON.stringify(serverModuleUrl)});
          const listener = app.listen(0, '127.0.0.1');
          await new Promise((resolve) => listener.once('listening', resolve));
          const api = 'http://127.0.0.1:' + listener.address().port;
          const request = async (url, options = {}) => {
            const response = await fetch(api + url, {
              ...options,
              headers: { 'content-type': 'application/json', ...(options.headers || {}) },
            });
            const text = await response.text();
            let body = text;
            try { body = text ? JSON.parse(text) : null; } catch {}
            return { status: response.status, body };
          };
          try {
            await request('/api/register', {
              method: 'POST',
              body: JSON.stringify({ username: 'admin', password: 'initial-password' }),
            });
            const login = await request('/api/login', {
              method: 'POST',
              body: JSON.stringify({ identifier: 'admin', password: 'initial-password' }),
            });
            const admin = { authorization: 'Bearer ' + login.body.token };
            const source = await request('/api/sources', {
              method: 'POST',
              headers: admin,
              body: JSON.stringify({ type: 'webhook', name: 'Release feed' }),
            });
            const created = await request('/api/admin/ingestion-credentials', {
              method: 'POST',
              headers: admin,
              body: JSON.stringify({
                sourceId: source.body.id,
                name: 'publisher',
                scopes: ['posts:write'],
                includeHmac: true,
              }),
            });
            const listed = await request('/api/admin/ingestion-credentials', { headers: admin });
            const raw = JSON.stringify({
              sourceType: 'webhook',
              sourceId: source.body.id,
              externalId: 'release-1',
              text: 'Release one',
              createdAt: '2026-07-24T12:00:00Z',
              urls: ['https://example.com/release-1'],
              sensitive: false,
              media: [],
            });
            const send = async (nonce, key) => {
              const timestamp = String(Math.floor(Date.now() / 1000));
              const signature = createHmac('sha256', created.body.hmacSecret)
                .update(timestamp + '.' + nonce + '.' + raw)
                .digest('hex');
              return request('/api/ingest/v1/posts', {
                method: 'POST',
                headers: {
                  authorization: 'Bearer ' + created.body.token,
                  'idempotency-key': key,
                  'x-t2b-timestamp': timestamp,
                  'x-t2b-nonce': nonce,
                  'x-t2b-signature': 'sha256=' + signature,
                },
                body: raw,
              });
            };
            const accepted = await send('nonce_1234567890', 'release-key-1');
            const replay = await send('nonce_1234567890', 'release-key-1');
            const idempotent = await send('nonce_abcdefghijk', 'release-key-1');
            const revoke = await request('/api/admin/ingestion-credentials/' + created.body.credential.id, {
              method: 'DELETE',
              headers: admin,
              body: JSON.stringify({ confirmation: 'REVOKE ' + created.body.credential.id }),
            });
            const revoked = await send('nonce_revoked_1234', 'release-key-2');
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              source,
              created,
              listed,
              accepted,
              replay,
              idempotent,
              revoke,
              revoked,
            }));
          } finally {
            await new Promise((resolve) => listener.close(resolve));
          }
        `,
      ],
      {
        env: {
          ...temporary.env,
          NODE_ENV: 'test',
          CONFIG_ENCRYPTION_KEY: '11'.repeat(32),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, any>;
    expect(result.created.status).toBe(201);
    expect(result.created.body.token).toStartWith('t2b_');
    expect(result.created.body.hmacSecret).toStartWith('t2b_hmac_');
    expect(JSON.stringify(result.listed.body)).not.toContain(result.created.body.token);
    expect(JSON.stringify(result.listed.body)).not.toContain(result.created.body.hmacSecret);
    expect(result.accepted.status).toBe(202);
    expect(result.replay.status).toBe(409);
    expect(result.idempotent.status).toBe(200);
    expect(result.revoke.body.revoked).toBe(true);
    expect(result.revoked.status).toBe(401);
  } finally {
    temporary.cleanup();
  }
});
