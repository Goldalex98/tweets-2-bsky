import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
const configManagerModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;

test('migration review dismissal persists and destination aliases stay secret-safe', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'migration-review-result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { app } = await import(${JSON.stringify(serverModuleUrl)});
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
          const seedReview = (needsAdminReview = true) => {
            const current = configManager.getConfig();
            const destination = current.destinations[0];
            destination.migrationReview = {
              needsAdminReview,
              migratedFromSchemaVersion: 1,
              notices: ['This destination was migrated from legacy configuration and requires administrator review.'],
              ...(needsAdminReview ? {} : { reviewedAt: '2026-07-24T12:00:00.000Z' }),
            };
            configManager.saveCanonicalConfig(current);
            return configManager.getConfig();
          };
          const clearReview = () => {
            const current = configManager.getConfig();
            const destination = current.destinations[0];
            delete destination.migrationReview;
            configManager.saveCanonicalConfig(current);
            return configManager.getConfig();
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
              twitterUsernames: ['one'],
              pausedTwitterUsernames: [],
              bskyIdentifier: 'destination.example',
              bskyPassword: '<redacted-app-password>',
              bskyServiceUrl: 'https://bsky.social',
              bskyDid: 'did:plc:destination',
              bskyCanonicalHandle: 'destination.example',
              createdByUserId: config.users[0].id,
              postingPolicy: {
                attribution: {
                  mode: 'never',
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
                  mode: 'off',
                  intervalHours: 24,
                  fields: { displayName: false, description: false, avatar: false, banner: false }
                },
                pinSync: { mode: 'off', intervalHours: 24 }
              }
            });
            let live = seedReview(true);
            const mappingId = live.mappings[0].id;
            const auth = { authorization: 'Bearer ' + login.body.token };
            const listBefore = await json('/api/destinations', { headers: auth });
            const stale = await json('/api/destinations/' + mappingId + '/migration-review', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ revision: live.revision, updatedAt: '2000-01-01T00:00:00.000Z' })
            });
            live = configManager.getConfig();
            const dismissed = await json('/api/destinations/' + mappingId + '/migration-review', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ revision: live.revision, updatedAt: live.updatedAt })
            });
            const afterDismiss = configManager.getConfig();
            const persisted = afterDismiss.destinations.find((entry) => entry.id === mappingId);
            const second = await json('/api/destinations/' + mappingId + '/migration-review', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ revision: afterDismiss.revision, updatedAt: afterDismiss.updatedAt })
            });
            clearReview();
            live = configManager.getConfig();
            const missing = await json('/api/destinations/' + mappingId + '/migration-review', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ revision: live.revision, updatedAt: live.updatedAt })
            });
            await json('/api/admin/users', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ username: 'member', password: 'test-password-123', isAdmin: false }),
            });
            const memberLogin = await json('/api/login', {
              method: 'POST',
              body: JSON.stringify({ identifier: 'member', password: 'test-password-123' })
            });
            live = seedReview(true);
            const forbidden = await json('/api/destinations/' + mappingId + '/migration-review', {
              method: 'PATCH',
              headers: { authorization: 'Bearer ' + memberLogin.body.token },
              body: JSON.stringify({ revision: live.revision, updatedAt: live.updatedAt })
            });
            live = configManager.getConfig();
            const alias = await json('/api/mappings/' + mappingId + '/migration-review', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ revision: live.revision, updatedAt: live.updatedAt })
            });
            live = configManager.getConfig();
            const contentPolicies = await json('/api/destinations/' + mappingId + '/content-policies', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                revision: live.revision,
                updatedAt: live.updatedAt,
                aiOverrides: { imageAltText: 'disabled' }
              })
            });
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              listBefore,
              stale,
              dismissed,
              persistedNeedsAdminReview: persisted?.migrationReview?.needsAdminReview,
              persistedReviewedAt: Boolean(persisted?.migrationReview?.reviewedAt),
              second,
              missing,
              memberLoginStatus: memberLogin.status,
              forbidden,
              alias,
              contentPolicies,
              listHasPassword: JSON.stringify(listBefore.body).includes('<redacted-app-password>') || JSON.stringify(listBefore.body).includes('appPassword'),
              dismissedHasPassword: JSON.stringify(dismissed.body).includes('<redacted-app-password>') || JSON.stringify(dismissed.body).includes('appPassword'),
              contentPoliciesHasPassword: JSON.stringify(contentPolicies.body).includes('<redacted-app-password>') || JSON.stringify(contentPolicies.body).includes('bskyPassword'),
              listCredentialConfigured: Array.isArray(listBefore.body) ? listBefore.body[0]?.credentialConfigured : null,
              listBlueskyAccountKeys: Array.isArray(listBefore.body) && listBefore.body[0]?.blueskyAccount
                ? Object.keys(listBefore.body[0].blueskyAccount).sort()
                : null,
              listBodyHasAppPasswordKey: JSON.stringify(listBefore.body).includes('"appPassword"'),
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
      listBefore: { status: number; body: unknown };
      stale: { status: number; body: { code?: string } };
      dismissed: {
        status: number;
        body: { migrationReview: { needsAdminReview: boolean; reviewedAt?: string }; destination: { migrationReview: { needsAdminReview: boolean } } };
      };
      persistedNeedsAdminReview: boolean;
      persistedReviewedAt: boolean;
      second: { status: number; body: { migrationReview: { needsAdminReview: boolean } } };
      missing: { status: number };
      memberLoginStatus: number;
      forbidden: { status: number };
      alias: { status: number; body: { migrationReview: { needsAdminReview: boolean } } };
      contentPolicies: {
        status: number;
        body: { destination?: { aiOverrides?: { imageAltText?: string } } };
      };
      listHasPassword: boolean;
      dismissedHasPassword: boolean;
      contentPoliciesHasPassword: boolean;
      listCredentialConfigured: boolean | null;
      listBlueskyAccountKeys: string[] | null;
      listBodyHasAppPasswordKey: boolean;
    };
    expect(result.listBefore.status).toBe(200);
    expect(result.listCredentialConfigured).toBe(true);
    expect(result.listHasPassword).toBe(false);
    expect(result.listBodyHasAppPasswordKey).toBe(false);
    // addMapping may create a legacy-inline destination without a nested account summary;
    // when the nested object is present it must never include appPassword.
    if (result.listBlueskyAccountKeys) {
      expect(result.listBlueskyAccountKeys).not.toContain('appPassword');
      expect(result.listBlueskyAccountKeys).toContain('credentialConfigured');
      expect(result.listBlueskyAccountKeys).toContain('health');
    }
    expect(result.stale).toMatchObject({ status: 409, body: { code: 'CONFIG_REVISION_CONFLICT' } });
    expect(result.dismissed.status).toBe(200);
    expect(result.dismissed.body.migrationReview.needsAdminReview).toBe(false);
    expect(result.dismissed.body.migrationReview.reviewedAt).toBeTruthy();
    expect(result.dismissed.body.destination.migrationReview.needsAdminReview).toBe(false);
    expect(result.dismissedHasPassword).toBe(false);
    expect(result.persistedNeedsAdminReview).toBe(false);
    expect(result.persistedReviewedAt).toBe(true);
    expect(result.second.status).toBe(200);
    expect(result.second.body.migrationReview.needsAdminReview).toBe(false);
    expect(result.missing.status).toBe(400);
    expect(result.memberLoginStatus).toBe(200);
    expect(result.forbidden.status).toBe(403);
    expect(result.alias.status).toBe(200);
    expect(result.alias.body.migrationReview.needsAdminReview).toBe(false);
    expect(result.contentPolicies.status).toBe(200);
    expect(result.contentPolicies.body.destination?.aiOverrides?.imageAltText).toBe('disabled');
    expect(result.contentPoliciesHasPassword).toBe(false);
  } finally {
    temporary.cleanup();
  }
});
