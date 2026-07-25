import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
const configManagerModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;

test('aggregate source APIs enforce permissions and preserve credentials, policy, queue, and history defaults', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'api-result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { app, getPendingBackfills } = await import(${JSON.stringify(serverModuleUrl)});
          const configManager = await import(${JSON.stringify(configManagerModuleUrl)});
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
            const config = configManager.getConfig();
            configManager.addMapping({
              twitterUsernames: ['one', 'two'],
              pausedTwitterUsernames: [],
              bskyIdentifier: 'destination.example',
              bskyPassword: '<redacted-app-password>',
              bskyServiceUrl: 'https://bsky.social',
              bskyDid: 'did:plc:destination',
              bskyCanonicalHandle: 'destination.example',
              createdByUserId: config.users[0].id,
              postingPolicy: {
                attribution: {
                  mode: 'multiple-sources',
                  template: 'Source: @{username} on X',
                  rootPostsOnly: true,
                  linkSource: true
                },
                appendOriginalPostLink: false
              },
              profileManagement: {
                allowProfileMutation: false,
                ensureBotLabel: false,
                ensureDisplayNameBotSuffix: false,
                profileSync: {
                  mode: 'scheduled',
                  sourceUsername: 'one',
                  intervalHours: 24,
                  fields: { displayName: false, description: false, avatar: false, banner: false }
                },
                pinSync: { mode: 'off', intervalHours: 24 }
              }
            });
            const configBefore = configManager.getConfig();
            const mappingBefore = configBefore.mappings[0];
            const staleVersion = { revision: configBefore.revision, updatedAt: configBefore.updatedAt };
            const auth = { authorization: 'Bearer ' + login.body.token };
            const unauthorized = await json('/api/destinations/' + mappingBefore.id + '/sources', {
              method: 'POST',
              body: JSON.stringify({ sources: ['three'] })
            });
            const invalid = await json('/api/destinations/' + mappingBefore.id + '/sources', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ sources: 'three, bad-name, @ONE' })
            });
            const stalePolicyUpdate = await json('/api/destinations/' + mappingBefore.id, {
              method: 'PUT',
              headers: auth,
              body: JSON.stringify({ owner: 'stale-owner', ...staleVersion })
            });
            const policyOnlyUpdate = await json('/api/destinations/' + mappingBefore.id, {
              method: 'PUT',
              headers: auth,
              body: JSON.stringify({ owner: 'updated-owner' })
            });
            const protectedCredentialUpdate = await json('/api/destinations/' + mappingBefore.id, {
              method: 'PUT',
              headers: auth,
              body: JSON.stringify({ bskyPassword: 'must-not-be-written' })
            });
            const blockedRemoval = await json('/api/destinations/' + mappingBefore.id + '/sources/one', {
              method: 'DELETE',
              headers: auth,
              body: JSON.stringify({ cancelPendingQueue: false, deleteHistory: false })
            });
            const unauthorizedSourcePolicy = await json('/api/destinations/' + mappingBefore.id + '/sources/two', {
              method: 'PATCH',
              body: JSON.stringify({ filters: { reposts: true } })
            });
            const invalidSourcePolicy = await json('/api/destinations/' + mappingBefore.id + '/sources/two', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ filters: { originalPosts: 'yes' } })
            });
            const validSourcePolicy = await json('/api/destinations/' + mappingBefore.id + '/sources/two', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                state: 'paused',
                cancelPendingQueue: false,
                filters: { mediaOnly: true, sensitiveContent: 'skip' },
                schedule: { mode: 'fixed', minIntervalMinutes: 2, maxIntervalMinutes: 30, fixedIntervalMinutes: 7 }
              })
            });
            const filterPreview = await json(
              '/api/destinations/' + mappingBefore.id + '/sources/two/filter-preview',
              {
                method: 'POST',
                headers: auth,
                body: JSON.stringify({ metadata: { text: 'sample', hasMedia: false } })
              }
            );
            const mappingAfter = configManager.getConfig().mappings[0];
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              unauthorized,
              invalid,
              stalePolicyUpdate,
              policyOnlyUpdate,
              protectedCredentialUpdate,
              blockedRemoval,
              unauthorizedSourcePolicy,
              invalidSourcePolicy,
              validSourcePolicy,
              filterPreview,
              sources: mappingAfter.twitterUsernames,
              passwordUnchanged: mappingAfter.bskyPassword === mappingBefore.bskyPassword,
              postingPolicyUnchanged: JSON.stringify(mappingAfter.postingPolicy) === JSON.stringify(mappingBefore.postingPolicy),
              profilePolicyUnchanged: JSON.stringify(mappingAfter.profileManagement) === JSON.stringify(mappingBefore.profileManagement),
              pendingBackfills: getPendingBackfills().length,
              canonicalDestinationCount: configManager.getConfig().destinations.length
            }));
          } finally {
            listener.close();
          }
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(result.unauthorized.status).toBe(401);
    expect(result.invalid.status).toBe(200);
    expect(result.invalid.body).toMatchObject({
      added: ['three'],
      duplicates: [{ username: 'one', reason: 'existing' }],
      invalid: [{ input: 'bad-name' }],
      automaticBackfill: false,
    });
    expect(result.stalePolicyUpdate).toMatchObject({
      status: 409,
      body: {
        code: 'CONFIG_REVISION_CONFLICT',
        guidance: expect.stringContaining('Refresh'),
      },
    });
    expect(result.policyOnlyUpdate.status).toBe(200);
    expect(result.protectedCredentialUpdate.status).toBe(400);
    expect(result.blockedRemoval.status).toBe(409);
    expect(result.unauthorizedSourcePolicy.status).toBe(401);
    expect(result.invalidSourcePolicy.status).toBe(400);
    expect(result.validSourcePolicy).toMatchObject({
      status: 200,
      body: {
        state: 'paused',
        queuedItemsPreserved: true,
        filters: { mediaOnly: true, sensitiveContent: 'skip' },
        schedule: { mode: 'fixed', fixedIntervalMinutes: 7 },
      },
    });
    expect(result.filterPreview).toMatchObject({
      status: 200,
      body: { allowed: false, reason: 'media-required' },
    });
    expect(result.sources).toHaveLength(3);
    expect(result.sources).toEqual(expect.arrayContaining(['one', 'two', 'three']));
    expect(result.passwordUnchanged).toBe(true);
    expect(result.postingPolicyUnchanged).toBe(true);
    expect(result.profilePolicyUnchanged).toBe(true);
    expect(result.pendingBackfills).toBe(0);
    expect(result.canonicalDestinationCount).toBe(1);
  } finally {
    temporary.cleanup();
  }
});
