import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('concurrent config writers are serialized by a persistence-layer compare-and-swap', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'cas-result.json');
  const configManagerUrl = new URL('../../src/config-manager.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const fs = await import('node:fs');
          const {
            getConfig,
            isConfigRevisionConflictError,
            saveConfig,
          } = await import(${JSON.stringify(configManagerUrl)});
          const attempt = (config) => {
            try {
              saveConfig(config);
              return { saved: true, revision: config.revision };
            } catch (error) {
              return {
                saved: false,
                conflict: isConfigRevisionConflictError(error),
                current: error.current,
                expectedRevision: error.expectedRevision,
              };
            }
          };

          // Two requests each read the same revision, mirroring two dashboard
          // tabs saving different sections at the same time.
          const first = getConfig();
          const second = getConfig();
          const baseRevision = first.revision;
          first.scheduler.intervalMinutes = 21;
          second.scheduler.intervalMinutes = 44;
          const firstWrite = attempt(first);
          const secondWrite = attempt(second);
          const afterLostUpdateAttempt = getConfig().scheduler.intervalMinutes;

          // The loser can retry against the revision it just learned about.
          const retry = getConfig();
          retry.scheduler.intervalMinutes = 44;
          const retryWrite = attempt(retry);
          const afterRetry = getConfig().scheduler.intervalMinutes;

          // A writer outside this process advances the document; the cached
          // snapshot must not be allowed to roll it back.
          const configPath = ${JSON.stringify(path.join(temporary.path, 'config.json'))};
          const stale = getConfig();
          const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          onDisk.revision = onDisk.revision + 4;
          fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
          stale.scheduler.intervalMinutes = 99;
          const externalWrite = attempt(stale);
          const finalRevision = JSON.parse(fs.readFileSync(configPath, 'utf8')).revision;

          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            baseRevision,
            firstWrite,
            secondWrite,
            afterLostUpdateAttempt,
            retryWrite,
            afterRetry,
            externalWrite,
            finalRevision,
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    expect(result.firstWrite).toMatchObject({ saved: true, revision: result.baseRevision + 1 });
    expect(result.secondWrite).toMatchObject({
      saved: false,
      conflict: true,
      expectedRevision: result.baseRevision,
    });
    expect(result.secondWrite.current.revision).toBe(result.baseRevision + 1);
    // The rejected writer must not have overwritten the winner's value.
    expect(result.afterLostUpdateAttempt).toBe(21);
    expect(result.retryWrite).toMatchObject({ saved: true, revision: result.baseRevision + 2 });
    expect(result.afterRetry).toBe(44);
    expect(result.externalWrite).toMatchObject({ saved: false, conflict: true });
    expect(result.externalWrite.current.revision).toBe(result.baseRevision + 6);
    // Revisions only ever move forward.
    expect(result.finalRevision).toBe(result.baseRevision + 6);
  } finally {
    temporary.cleanup();
  }
});

test('whole-document replacements must name the revision they replace', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'import-result.json');
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
              body: JSON.stringify({ identifier: 'admin', password: 'initial-password' }),
            });
            const bearer = { authorization: 'Bearer ' + login.body.token };
            const exported = await request('/api/config/export?mode=redacted', { headers: bearer });
            const { revision: _revision, updatedAt: _updatedAt, ...bundle } = exported.body;
            const version = (await request('/api/settings/scheduler', { headers: bearer })).body;

            const missingRevision = await request('/api/config/import', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify(bundle),
            });
            const staleRevision = await request('/api/config/import', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ ...bundle, revision: version.revision - 1 }),
            });
            const accepted = await request('/api/config/import', {
              method: 'POST',
              headers: bearer,
              body: JSON.stringify({ ...bundle, revision: version.revision }),
            });
            const staleScheduler = await request('/api/settings/scheduler', {
              method: 'PATCH',
              headers: bearer,
              body: JSON.stringify({ intervalMinutes: 30, revision: version.revision - 1 }),
            });

            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              revision: version.revision,
              missingRevision: missingRevision.status,
              missingRevisionCode: missingRevision.body?.code,
              staleRevision: staleRevision.status,
              staleRevisionCode: staleRevision.body?.code,
              staleRevisionCurrent: staleRevision.body?.current?.revision,
              accepted: accepted.status,
              staleScheduler: staleScheduler.status,
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
      missingRevision: 428,
      missingRevisionCode: 'CONFIG_REVISION_REQUIRED',
      staleRevision: 409,
      staleRevisionCode: 'CONFIG_REVISION_CONFLICT',
      accepted: 200,
      staleScheduler: 409,
    });
    expect(result.staleRevisionCurrent).toBe(result.revision);
  } finally {
    temporary.cleanup();
  }
});
