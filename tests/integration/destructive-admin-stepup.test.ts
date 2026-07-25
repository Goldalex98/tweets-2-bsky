import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('destructive admin actions require typed confirmation and current password', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'destructive-stepup-result.json');
  const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
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
              body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'initial-password' }),
            });
            const bearer = { authorization: 'Bearer ' + login.body.token };
            const version = (await request('/api/settings/scheduler', { headers: bearer })).body;
            const createdUser = await request('/api/admin/users', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ username: 'operator', password: 'operator-password' }),
            });
            const mapping = await request('/api/mappings', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({
                twitterUsernames: ['source_user'],
                bskyIdentifier: 'dest.example',
                bskyPassword: 'app-password-placeholder',
                revision: version.revision,
                updatedAt: version.updatedAt,
              }),
            });
            const destinationId = mapping.body?.id || mapping.body?.destination?.id || 'missing';

            const deleteNoConfirm = await request('/api/mappings/' + destinationId + '/delete-all-posts', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ password: 'initial-password' }),
            });
            const deleteNoPassword = await request('/api/mappings/' + destinationId + '/delete-all-posts', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ confirmation: 'DELETE_ALL_POSTS' }),
            });
            const deleteOk = await request('/api/mappings/does-not-exist/delete-all-posts', {
              method: 'POST',
              headers: {
                ...bearer,
                'x-destructive-confirmation': 'DELETE_ALL_POSTS',
                'x-reauth-password': 'initial-password',
              },
              body: JSON.stringify({ confirmation: 'DELETE_ALL_POSTS', password: 'initial-password' }),
            });

            const updateNoConfirm = await request('/api/update', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ password: 'initial-password' }),
            });
            const updateNoPassword = await request('/api/update', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ confirmation: 'RUN_UPDATE' }),
            });
            const updateOk = await request('/api/update', {
              method: 'POST',
              headers: {
                ...bearer,
                'x-destructive-confirmation': 'RUN_UPDATE',
                'x-reauth-password': 'initial-password',
              },
              body: JSON.stringify({ confirmation: 'RUN_UPDATE', password: 'initial-password' }),
            });

            const resetNoConfirm = await request('/api/admin/users/' + createdUser.body.id + '/reset-password', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ password: 'initial-password', newPassword: 'replacement-password-1' }),
            });
            const resetNoPassword = await request('/api/admin/users/' + createdUser.body.id + '/reset-password', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ confirmation: 'RESET_USER_PASSWORD', newPassword: 'replacement-password-1' }),
            });
            const resetOk = await request('/api/admin/users/' + createdUser.body.id + '/reset-password', {
              method: 'POST',
              headers: {
                ...bearer,
                'x-destructive-confirmation': 'RESET_USER_PASSWORD',
                'x-reauth-password': 'initial-password',
              },
              body: JSON.stringify({
                confirmation: 'RESET_USER_PASSWORD',
                password: 'initial-password',
                newPassword: 'replacement-password-1',
              }),
            });

            const clearNoConfirm = await request('/api/backfill/clear-all', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ password: 'initial-password' }),
            });
            const clearOk = await request('/api/backfill/clear-all', {
              method: 'POST',
              headers: {
                ...bearer,
                'x-destructive-confirmation': 'CLEAR_ALL_BACKFILLS',
                'x-reauth-password': 'initial-password',
              },
              body: JSON.stringify({ confirmation: 'CLEAR_ALL_BACKFILLS', password: 'initial-password' }),
            });

            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              mappingStatus: mapping.status,
              deleteNoConfirm: deleteNoConfirm.status,
              deleteNoConfirmCode: deleteNoConfirm.body?.error?.code,
              deleteNoPassword: deleteNoPassword.status,
              deleteNoPasswordCode: deleteNoPassword.body?.error?.code,
              deleteOk: deleteOk.status,
              updateNoConfirm: updateNoConfirm.status,
              updateNoConfirmCode: updateNoConfirm.body?.error?.code,
              updateNoPassword: updateNoPassword.status,
              updateNoPasswordCode: updateNoPassword.body?.error?.code,
              updateAuthPassed: ![401, 403].includes(updateOk.status),
              updateStatus: updateOk.status,
              resetNoConfirm: resetNoConfirm.status,
              resetNoConfirmCode: resetNoConfirm.body?.error?.code,
              resetNoPassword: resetNoPassword.status,
              resetNoPasswordCode: resetNoPassword.body?.error?.code,
              resetOk: resetOk.status,
              clearNoConfirm: clearNoConfirm.status,
              clearOk: clearOk.status,
            }));
          } finally {
            await new Promise((resolve) => listener.close(resolve));
          }
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.deleteNoConfirm).toBe(403);
    expect(result.deleteNoConfirmCode).toBe('CONFIRMATION_REQUIRED');
    expect(result.deleteNoPassword).toBe(401);
    expect(result.deleteNoPasswordCode).toBe('REAUTHENTICATION_FAILED');
    expect(result.deleteOk).toBe(404);
    expect(result.updateNoConfirm).toBe(403);
    expect(result.updateNoConfirmCode).toBe('CONFIRMATION_REQUIRED');
    expect(result.updateNoPassword).toBe(401);
    expect(result.updateNoPasswordCode).toBe('REAUTHENTICATION_FAILED');
    expect(result.updateAuthPassed).toBe(true);
    expect(result.resetNoConfirm).toBe(403);
    expect(result.resetNoConfirmCode).toBe('CONFIRMATION_REQUIRED');
    expect(result.resetNoPassword).toBe(401);
    expect(result.resetNoPasswordCode).toBe('REAUTHENTICATION_FAILED');
    expect(result.resetOk).toBe(200);
    expect(result.clearNoConfirm).toBe(403);
    expect(result.clearOk).toBe(200);
  } finally {
    temporary.cleanup();
  }
});
