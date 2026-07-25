import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('cookie auth, CSRF, bearer compatibility, revocation, and HTTP hardening work together', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'security-result.json');
  const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const fs = await import('node:fs');
          const jwt = (await import('jsonwebtoken')).default;
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
            return {
              status: response.status,
              body,
              text,
              headers: Object.fromEntries(response.headers.entries()),
              setCookies: response.headers.getSetCookie(),
            };
          };
          try {
            await request('/api/register', {
              method: 'POST',
              body: JSON.stringify({ username: 'admin', password: 'initial-password' }),
            });
            const login = await request('/api/login', {
              method: 'POST',
              headers: { 'x-forwarded-proto': 'https' },
              body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'initial-password' }),
            });
            const cookieOnlyLogin = await request('/api/login', {
              method: 'POST',
              headers: { 'x-forwarded-proto': 'https' },
              body: JSON.stringify({ identifier: 'admin', password: 'initial-password' }),
            });
            const cookieHeader = login.setCookies.map((value) => value.split(';')[0]).join('; ');
            const csrf = login.body.csrfToken;
            const cookieMe = await request('/api/me', { headers: { cookie: cookieHeader } });
            const csrfRejected = await request('/api/settings/scheduler', {
              method: 'PATCH',
              headers: { cookie: cookieHeader },
              body: JSON.stringify({ intervalMinutes: 10 }),
            });
            const csrfAccepted = await request('/api/settings/scheduler', {
              method: 'PATCH',
              headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
              body: JSON.stringify({ intervalMinutes: 10 }),
            });
            const bearer = { authorization: 'Bearer ' + login.body.token };
            const bearerMutation = await request('/api/settings/scheduler', {
              method: 'PATCH',
              headers: bearer,
              body: JSON.stringify({ intervalMinutes: 11 }),
            });
            const passwordChange = await request('/api/me/change-password', {
              method: 'POST',
              headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
              body: JSON.stringify({ currentPassword: 'initial-password', newPassword: 'replacement-password' }),
            });
            const revokedBearer = await request('/api/me', { headers: bearer });
            const newLogin = await request('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'replacement-password' }),
            });
            const newBearer = { authorization: 'Bearer ' + newLogin.body.token };
            const newMe = await request('/api/me', { headers: newBearer });
            const decoded = jwt.decode(newLogin.body.token);
            const { exp: _exp, iat: _iat, ...tokenIdentity } = decoded;
            const jwtSecret = fs.readFileSync(${JSON.stringify(path.join(temporary.path, '.jwt-secret'))}, 'utf8').trim();
            const expiredToken = jwt.sign(tokenIdentity, jwtSecret, { expiresIn: -1 });
            const expiredBearer = await request('/api/me', {
              headers: { authorization: 'Bearer ' + expiredToken },
            });
            const createdViewer = await request('/api/admin/users', {
              method: 'POST',
              headers: newBearer,
              body: JSON.stringify({ username: 'viewer', password: 'viewer-password' }),
            });
            const viewerLogin = await request('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier: 'viewer', password: 'viewer-password' }),
            });
            const viewerBearer = { authorization: 'Bearer ' + viewerLogin.body.token };
            const permissionChange = await request('/api/admin/users/' + createdViewer.body.id, {
              method: 'PUT',
              headers: newBearer,
              body: JSON.stringify({
                username: 'viewer',
                isAdmin: false,
                permissions: { runNow: false, queueBackfills: false },
              }),
            });
            const revokedByPermissionChange = await request('/api/me', { headers: viewerBearer });
            const noStore = await request('/api/twitter-config', {
              headers: newBearer,
            });
            const corsDenied = await request('/healthz', { headers: { origin: 'https://evil.example' } });
            const tooLarge = await request('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'x'.repeat(140000) }),
            });
            let rateLimited = null;
            for (let index = 0; index < 35; index += 1) {
              rateLimited = await request('/api/login', {
                method: 'POST',
                body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'wrong-password' }),
              });
              if (rateLimited.status === 429) break;
            }
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              loginStatus: login.status,
              loginHasToken: typeof login.body?.token === 'string',
              cookieOnlyHasToken: typeof cookieOnlyLogin.body?.token === 'string',
              cookieFlags: login.setCookies,
              cookieMe: cookieMe.status,
              csrfRejected: csrfRejected.status,
              csrfAccepted: csrfAccepted.status,
              bearerMutation: bearerMutation.status,
              passwordChange: passwordChange.status,
              revokedBearer: revokedBearer.status,
              newLogin: newLogin.status,
              expiredBearer: expiredBearer.status,
              permissionChange: permissionChange.status,
              revokedByPermissionChange: revokedByPermissionChange.status,
              csp: cookieMe.headers['content-security-policy'],
              noStore: noStore.headers['cache-control'],
              corsHeader: corsDenied.headers['access-control-allow-origin'],
              tooLarge: tooLarge.status,
              tooLargeCode: tooLarge.body?.error?.code,
              rateLimited: rateLimited?.status,
            }));
          } finally {
            await new Promise((resolve) => listener.close(resolve));
          }
        `,
      ],
      {
        env: { ...temporary.env, TRUST_PROXY: 'true', CORS_ALLOWED_ORIGINS: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result).toMatchObject({
      loginStatus: 200,
      loginHasToken: true,
      cookieOnlyHasToken: false,
      cookieMe: 200,
      csrfRejected: 403,
      csrfAccepted: 200,
      bearerMutation: 200,
      passwordChange: 200,
      revokedBearer: 401,
      newLogin: 200,
      expiredBearer: 401,
      permissionChange: 200,
      revokedByPermissionChange: 401,
      tooLarge: 413,
      tooLargeCode: 'BODY_TOO_LARGE',
      rateLimited: 429,
    });
    expect(result.corsHeader).toBeUndefined();
    const sessionCookie = result.cookieFlags.find((value: string) => value.startsWith('t2b_session='));
    const csrfCookie = result.cookieFlags.find((value: string) => value.startsWith('t2b_csrf='));
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Secure');
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(csrfCookie).toContain('SameSite=Lax');
    expect(csrfCookie).toContain('Secure');
    expect(result.csp).toContain("script-src 'self'");
    expect(result.noStore).toContain('no-store');
  } finally {
    temporary.cleanup();
  }
});
