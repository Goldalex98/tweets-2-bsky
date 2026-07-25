import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
const configManagerModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;
const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;

test('a destination can be repointed at another managed Bluesky account without losing mirror history', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'account-link-result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { app } = await import(${JSON.stringify(serverModuleUrl)});
          const configManager = await import(${JSON.stringify(configManagerModuleUrl)});
          const { dbService } = await import(${JSON.stringify(dbModuleUrl)});
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
          const now = '2026-07-25T00:00:00.000Z';
          const account = (id, handle) => ({
            id,
            serviceUrl: 'https://bsky.social',
            loginIdentifier: handle,
            appPassword: '<redacted-app-password>',
            did: 'did:plc:' + id,
            canonicalHandle: handle,
            createdAt: now,
            updatedAt: now
          });
          const policies = {
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
            const adminId = configManager.getConfig().users[0].id;

            configManager.addMapping({
              twitterUsernames: ['one'],
              pausedTwitterUsernames: [],
              bskyIdentifier: 'alpha.example',
              bskyPassword: '<redacted-app-password>',
              bskyServiceUrl: 'https://bsky.social',
              bskyDid: 'did:plc:account-alpha',
              bskyCanonicalHandle: 'alpha.example',
              createdByUserId: adminId,
              ...policies
            });
            configManager.addMapping({
              twitterUsernames: ['two'],
              pausedTwitterUsernames: [],
              bskyIdentifier: 'claimed.example',
              bskyPassword: '<redacted-app-password>',
              bskyServiceUrl: 'https://bsky.social',
              bskyDid: 'did:plc:account-claimed',
              bskyCanonicalHandle: 'claimed.example',
              createdByUserId: adminId,
              ...policies
            });

            // Link both seeded destinations to managed accounts, leaving
            // account-beta free for the switch under test.
            const seed = configManager.getConfig();
            seed.blueskyAccounts.push(
              account('account-alpha', 'alpha.example'),
              account('account-beta', 'beta.example'),
              account('account-claimed', 'claimed.example')
            );
            const primary = seed.destinations.find((entry) => entry.bskyIdentifier === 'alpha.example');
            const claimedDestination = seed.destinations.find((entry) => entry.bskyIdentifier === 'claimed.example');
            primary.bskyAccountId = 'account-alpha';
            claimedDestination.bskyAccountId = 'account-claimed';
            configManager.saveCanonicalConfig(seed);

            let live = configManager.getConfig();
            const destinationId = primary.id;
            const storageKeyBefore = live.destinations.find((entry) => entry.id === destinationId).storageKey;
            dbService.saveTweet({
              twitter_id: '1',
              twitter_username: 'one',
              bsky_identifier: storageKeyBefore,
              destination_id: destinationId,
              tweet_text: 'already mirrored',
              status: 'migrated'
            });
            const historyBefore = dbService.countTweetsBySourceForDestination('one', storageKeyBefore);

            const stale = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                bskyAccountId: 'account-beta',
                revision: live.revision,
                updatedAt: '2000-01-01T00:00:00.000Z'
              })
            });

            live = configManager.getConfig();
            const missingAccount = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({ revision: live.revision, updatedAt: live.updatedAt })
            });
            const unknownAccount = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                bskyAccountId: 'account-nope',
                revision: live.revision,
                updatedAt: live.updatedAt
              })
            });
            const claimed = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                bskyAccountId: 'account-claimed',
                revision: live.revision,
                updatedAt: live.updatedAt
              })
            });

            const switched = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                bskyAccountId: 'account-beta',
                revision: live.revision,
                updatedAt: live.updatedAt
              })
            });
            const afterSwitch = configManager.getConfig();
            const persisted = afterSwitch.destinations.find((entry) => entry.id === destinationId);
            const repeat = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                bskyAccountId: 'account-beta',
                revision: afterSwitch.revision,
                updatedAt: afterSwitch.updatedAt
              })
            });

            live = configManager.getConfig();
            const alias = await json('/api/mappings/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: auth,
              body: JSON.stringify({
                bskyAccountId: 'account-alpha',
                revision: live.revision,
                updatedAt: live.updatedAt
              })
            });

            const historyAfter = dbService.countTweetsBySourceForDestination('one', storageKeyBefore);
            const storageKeyAfter = configManager.getConfig().destinations.find(
              (entry) => entry.id === destinationId
            ).storageKey;

            // account-beta is free again after the alias switch back to alpha.
            const createdFromAccount = await json('/api/destinations', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ twitterUsernames: ['three'], bskyAccountId: 'account-beta' })
            });
            const createdWithLinkedAccount = await json('/api/destinations', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ twitterUsernames: ['four'], bskyAccountId: 'account-beta' })
            });
            const createdWithoutCredentials = await json('/api/destinations', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ twitterUsernames: ['five'] })
            });

            await json('/api/admin/users', {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({
                username: 'member',
                password: 'test-password-123',
                isAdmin: false,
                permissions: { manageOwnMappings: true }
              })
            });
            const memberLogin = await json('/api/login', {
              method: 'POST',
              body: JSON.stringify({ identifier: 'member', password: 'test-password-123' })
            });
            live = configManager.getConfig();
            const forbidden = await json('/api/destinations/' + destinationId + '/bluesky-account', {
              method: 'PATCH',
              headers: { authorization: 'Bearer ' + memberLogin.body.token },
              body: JSON.stringify({
                bskyAccountId: 'account-beta',
                revision: live.revision,
                updatedAt: live.updatedAt
              })
            });

            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              stale,
              missingAccount,
              unknownAccount,
              claimed,
              switched,
              repeat,
              alias,
              persistedAccountId: persisted?.bskyAccountId,
              persistedIdentifier: persisted?.bskyIdentifier,
              persistedHasInlinePassword: Object.hasOwn(persisted ?? {}, 'bskyPassword'),
              storageKeyStable: storageKeyBefore === storageKeyAfter,
              historyBefore,
              historyAfter,
              switchedHasPassword:
                JSON.stringify(switched.body).includes('<redacted-app-password>') ||
                JSON.stringify(switched.body).includes('"appPassword"') ||
                JSON.stringify(switched.body).includes('"bskyPassword"'),
              createdFromAccount,
              createdWithLinkedAccount,
              createdWithoutCredentials,
              forbidden
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
      stale: { status: number; body: { code?: string } };
      missingAccount: { status: number };
      unknownAccount: { status: number };
      claimed: { status: number; body: { code?: string; destinationId?: string } };
      switched: {
        status: number;
        body: {
          changed?: boolean;
          previousAccountId?: string | null;
          destination?: {
            bskyAccountId?: string;
            bskyIdentifier?: string;
            blueskyAccount?: { loginIdentifier?: string; credentialConfigured?: boolean };
          };
        };
      };
      repeat: { status: number; body: { changed?: boolean } };
      alias: { status: number; body: { changed?: boolean; destination?: { bskyAccountId?: string } } };
      persistedAccountId?: string;
      persistedIdentifier?: string;
      persistedHasInlinePassword: boolean;
      storageKeyStable: boolean;
      historyBefore: number;
      historyAfter: number;
      switchedHasPassword: boolean;
      createdFromAccount: {
        status: number;
        body: { bskyAccountId?: string; accountCreated?: boolean; blueskyAccount?: { loginIdentifier?: string } };
      };
      createdWithLinkedAccount: { status: number; body: { code?: string } };
      createdWithoutCredentials: { status: number };
      forbidden: { status: number };
    };

    expect(result.stale).toMatchObject({ status: 409, body: { code: 'CONFIG_REVISION_CONFLICT' } });
    expect(result.missingAccount.status).toBe(400);
    expect(result.unknownAccount.status).toBe(404);
    expect(result.claimed.status).toBe(409);
    expect(result.claimed.body.code).toBe('ACCOUNT_ALREADY_LINKED');
    expect(result.claimed.body.destinationId).toBeTruthy();

    expect(result.switched.status).toBe(200);
    expect(result.switched.body.changed).toBe(true);
    expect(result.switched.body.previousAccountId).toBe('account-alpha');
    expect(result.switched.body.destination?.bskyAccountId).toBe('account-beta');
    expect(result.switched.body.destination?.bskyIdentifier).toBe('beta.example');
    expect(result.switched.body.destination?.blueskyAccount?.loginIdentifier).toBe('beta.example');
    expect(result.switchedHasPassword).toBe(false);
    expect(result.persistedAccountId).toBe('account-beta');
    expect(result.persistedIdentifier).toBe('beta.example');
    expect(result.persistedHasInlinePassword).toBe(false);

    // Re-linking the same account is a no-op rather than a spurious write.
    expect(result.repeat.status).toBe(200);
    expect(result.repeat.body.changed).toBe(false);

    expect(result.alias.status).toBe(200);
    expect(result.alias.body.destination?.bskyAccountId).toBe('account-alpha');

    // Switching accounts keeps queue/history identity, so nothing re-mirrors.
    expect(result.storageKeyStable).toBe(true);
    expect(result.historyBefore).toBe(1);
    expect(result.historyAfter).toBe(1);

    expect(result.createdFromAccount.status).toBe(200);
    expect(result.createdFromAccount.body.bskyAccountId).toBe('account-beta');
    expect(result.createdFromAccount.body.accountCreated).toBe(false);
    expect(result.createdFromAccount.body.blueskyAccount?.loginIdentifier).toBe('beta.example');
    expect(result.createdWithLinkedAccount.status).toBe(409);
    expect(result.createdWithLinkedAccount.body.code).toBe('ACCOUNT_ALREADY_LINKED');
    expect(result.createdWithoutCredentials.status).toBe(400);

    expect(result.forbidden.status).toBe(403);
  } finally {
    temporary.cleanup();
  }
});
