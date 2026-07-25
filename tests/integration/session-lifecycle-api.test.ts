import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('token subjects are bound to the account id and logout retires issued tokens', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'session-result.json');
  const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const fs = await import('node:fs');
          const jwt = (await import('jsonwebtoken')).default;
          const { app, getLegacyIdentifierSessionCount } = await import(${JSON.stringify(serverModuleUrl)});
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
          const login = async (identifier, password) => {
            const response = await request('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier, password }),
            });
            return response.body.token;
          };
          try {
            await request('/api/register', {
              method: 'POST',
              body: JSON.stringify({ username: 'admin', password: 'initial-password' }),
            });
            const adminToken = await login('admin', 'initial-password');
            const adminBearer = { authorization: 'Bearer ' + adminToken };

            const created = await request('/api/admin/users', {
              method: 'POST',
              headers: adminBearer,
              body: JSON.stringify({ username: 'analyst', password: 'analyst-password', isAdmin: false }),
            });
            const analystToken = await login('analyst', 'analyst-password');
            const analystWorks = await request('/api/me', {
              headers: { authorization: 'Bearer ' + analystToken },
            });
            await request('/api/admin/users/' + created.body.id, {
              method: 'DELETE',
              headers: adminBearer,
            });
            // A brand new account reuses the identifier of the deleted one.
            const replacement = await request('/api/admin/users', {
              method: 'POST',
              headers: adminBearer,
              body: JSON.stringify({ username: 'analyst', password: 'replacement-password', isAdmin: false }),
            });
            const deletedUserToken = await request('/api/me', {
              headers: { authorization: 'Bearer ' + analystToken },
            });

            // A token minted before userId claims existed still resolves, and the
            // fallback is recorded rather than being silent.
            const jwtSecret = fs.readFileSync(${JSON.stringify(path.join(temporary.path, '.jwt-secret'))}, 'utf8').trim();
            const legacyBefore = getLegacyIdentifierSessionCount();
            const legacyToken = jwt.sign({ username: 'admin', tokenVersion: 0 }, jwtSecret, { expiresIn: '5m' });
            const legacySession = await request('/api/me', {
              headers: { authorization: 'Bearer ' + legacyToken },
            });
            const legacyAfter = getLegacyIdentifierSessionCount();

            const logout = await request('/api/logout', { method: 'POST', headers: adminBearer });
            const afterLogout = await request('/api/me', { headers: adminBearer });
            const legacyAfterLogout = await request('/api/me', {
              headers: { authorization: 'Bearer ' + legacyToken },
            });
            const reLogin = await request('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'initial-password' }),
            });
            const afterReLogin = await request('/api/me', {
              headers: { authorization: 'Bearer ' + reLogin.body.token },
            });

            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              analystWorks: analystWorks.status,
              sameUsername: replacement.body.username,
              differentId: replacement.body.id !== created.body.id,
              deletedUserToken: deletedUserToken.status,
              deletedUserCode: deletedUserToken.body?.error?.code,
              legacySession: legacySession.status,
              legacyRecorded: legacyAfter - legacyBefore,
              logout: logout.status,
              allSessionsRevoked: logout.body?.allSessionsRevoked,
              logoutMessage: logout.body?.message,
              afterLogout: afterLogout.status,
              afterLogoutCode: afterLogout.body?.error?.code,
              legacyAfterLogout: legacyAfterLogout.status,
              afterReLogin: afterReLogin.status,
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
    expect(result).toMatchObject({
      analystWorks: 200,
      sameUsername: 'analyst',
      differentId: true,
      // The replacement account must not inherit the deleted user's session.
      deletedUserToken: 401,
      deletedUserCode: 'INVALID_SESSION',
      legacySession: 200,
      legacyRecorded: 1,
      logout: 200,
      allSessionsRevoked: true,
      afterLogout: 401,
      afterLogoutCode: 'SESSION_REVOKED',
      legacyAfterLogout: 401,
      afterReLogin: 200,
    });
    expect(result.logoutMessage).toContain('every active session');
    // The audit warning must not leak the identifier itself.
    expect(stderr).toContain('legacy-session-token-accepted');
    expect(stderr).not.toContain('identity=admin');
  } finally {
    temporary.cleanup();
  }
});
