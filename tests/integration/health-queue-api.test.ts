import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('health is redacted and queue operations are permission scoped with active safety', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'health-api-result.json');
  const serverModuleUrl = new URL('../../src/server.ts', import.meta.url).href;
  const configModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { app } = await import(${JSON.stringify(serverModuleUrl)});
          const configManager = await import(${JSON.stringify(configModuleUrl)});
          const { dbService, postQueueService } = await import(${JSON.stringify(dbModuleUrl)});
          const listener = app.listen(0, '127.0.0.1');
          await new Promise((resolve) => listener.once('listening', resolve));
          const api = 'http://127.0.0.1:' + listener.address().port;
          const json = async (url, options = {}) => {
            const response = await fetch(api + url, {
              ...options,
              headers: { 'content-type': 'application/json', ...(options.headers || {}) },
            });
            const text = await response.text();
            return { status: response.status, body: text ? JSON.parse(text) : null, text };
          };
          try {
            const config = configManager.getConfig();
            config.twitter.authToken = 'primary-cookie-secret';
            config.twitter.ct0 = 'csrf-cookie-secret';
            config.notifications.webhookUrl = 'https://secret-webhook.example/path';
            config.notifications.webhookSecret = 'webhook-signing-secret';
            configManager.saveConfig(config);
            const health = await json('/healthz');
            const ready = await json('/readyz');
            await json('/api/register', {
              method: 'POST',
              body: JSON.stringify({ username: 'admin', password: 'test-password-123' }),
            });
            const login = await json('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'test-password-123' }),
            });
            const adminAuth = { authorization: 'Bearer ' + login.body.token };
            const createdUser = await json('/api/admin/users', {
              method: 'POST',
              headers: adminAuth,
              body: JSON.stringify({
                username: 'viewer',
                password: 'test-password-456',
                permissions: {
                  viewAllMappings: false,
                  manageOwnMappings: true,
                  manageAllMappings: false,
                  manageGroups: false,
                  queueBackfills: false,
                  runNow: false,
                },
              }),
            });
            const viewerLogin = await json('/api/login', {
              method: 'POST',
              body: JSON.stringify({ includeBearerToken: true, identifier: 'viewer', password: 'test-password-456' }),
            });
            const viewerAuth = { authorization: 'Bearer ' + viewerLogin.body.token };
            const current = configManager.getConfig();
            configManager.addMapping({
              twitterUsernames: ['source'],
              bskyIdentifier: 'destination.example',
              bskyPassword: '<redacted-test-password>',
              bskyDid: 'did:plc:test-destination',
              createdByUserId: current.users.find((user) => user.username === 'admin').id,
            });
            const mapping = configManager.getConfig().mappings[0];
            const route = configManager.getConfig().routes[0];
            postQueueService.enqueue([{
              twitter_id: '500',
              bsky_identifier: 'did:plc:test-destination',
              mapping_id: mapping.id,
              twitter_username: 'source',
              destination_id: mapping.id,
              route_id: route.id,
              kind: 'scheduled',
              tweet_json: '{}',
            }]);
            postQueueService.enqueue([{
              twitter_id: '501',
              bsky_identifier: 'did:plc:test-destination',
              mapping_id: mapping.id,
              twitter_username: 'source',
              destination_id: mapping.id,
              route_id: route.id,
              kind: 'scheduled',
              tweet_json: JSON.stringify({ id_str: '501', full_text: 'allowed sample', lang: 'en' }),
            }]);
            const denied = await json('/api/queue/scopes/destination/' + mapping.id, {
              headers: viewerAuth,
            });
            const missingConfirmation = await json('/api/destinations/' + mapping.id + '/queue/pending', {
              method: 'DELETE',
              headers: adminAuth,
            });
            const deniedReevaluation = await json('/api/queue/items/did%3Aplc%3Atest-destination/501/reevaluate-policy', {
              method: 'POST',
              headers: viewerAuth,
              body: '{}',
            });
            const missingPolicyConfirmation = await json('/api/queue/items/did%3Aplc%3Atest-destination/501/reevaluate-policy', {
              method: 'POST',
              headers: adminAuth,
              body: '{}',
            });
            const allowedReevaluation = await json('/api/queue/items/did%3Aplc%3Atest-destination/501/reevaluate-policy', {
              method: 'POST',
              headers: { ...adminAuth, 'x-queue-confirmation': 'REEVALUATE_POLICY' },
              body: JSON.stringify({ reason: 'integration test' }),
            });
            dbService.saveTweet({
              twitter_id: '502',
              twitter_username: 'source',
              bsky_identifier: 'did:plc:test-destination',
              source_type: 'x',
              external_post_id: '502',
              destination_id: mapping.id,
              route_id: route.id,
              source_id: route.sourceId,
              skip_reason: 'moderation-blocked-keyword',
              retained_until: Date.now() + 60000,
              retained_candidate_json: JSON.stringify({
                version: 1,
                retainedAt: Date.now(),
                expiresAt: Date.now() + 60000,
                normalized: {
                  externalPostId: '502',
                  text: 'retained sample',
                  urls: [],
                  mediaUrls: [],
                  sourceUsername: 'source',
                  contentType: 'original',
                  mediaTypes: ['none'],
                },
                sourcePayload: { id_str: '502', full_text: 'retained sample', user: { screen_name: 'source' } },
                degraded: false,
              }),
              status: 'skipped',
            });
            const deniedOverride = await json('/api/activity/' + mapping.id + '/502/override-requeue', {
              method: 'POST',
              headers: viewerAuth,
              body: JSON.stringify({ override: true }),
            });
            const allowedOverride = await json('/api/activity/' + mapping.id + '/502/override-requeue', {
              method: 'POST',
              headers: { ...adminAuth, 'x-queue-confirmation': 'OVERRIDE_POLICY_SKIP' },
              body: JSON.stringify({ override: true }),
            });
            // The retained skip record must be fully consumed (not merely
            // marked) once the override succeeds: a worker's idempotency
            // check reads the same history row, so a leftover skip row would
            // make the worker treat the override as already settled and
            // silently drop it without ever posting.
            const skipRecordAfterOverride = dbService.getPost('502', mapping.id);
            const queuedAfterOverride = postQueueService.inspect({ twitterId: '502' })[0];

            // A second retained candidate whose enqueue collides (simulating
            // an already-queued duplicate) must not lose its retained skip
            // record: the handler consumes the skip before enqueueing, so a
            // failed enqueue has to restore it for a later retry instead of
            // leaving the candidate stranded with nothing in the queue and
            // no history row.
            dbService.saveTweet({
              twitter_id: '503',
              twitter_username: 'source',
              bsky_identifier: 'did:plc:test-destination',
              source_type: 'x',
              external_post_id: '503',
              destination_id: mapping.id,
              route_id: route.id,
              source_id: route.sourceId,
              skip_reason: 'moderation-blocked-keyword',
              retained_until: Date.now() + 60000,
              retained_candidate_json: JSON.stringify({
                version: 1,
                retainedAt: Date.now(),
                expiresAt: Date.now() + 60000,
                normalized: {
                  externalPostId: '503',
                  text: 'retained sample two',
                  urls: [],
                  mediaUrls: [],
                  sourceUsername: 'source',
                  contentType: 'original',
                  mediaTypes: ['none'],
                },
                sourcePayload: { id_str: '503', full_text: 'retained sample two', user: { screen_name: 'source' } },
                degraded: false,
              }),
              status: 'skipped',
            });
            postQueueService.enqueue([{
              twitter_id: '503',
              bsky_identifier: 'did:plc:test-destination',
              mapping_id: mapping.id,
              twitter_username: 'source',
              destination_id: mapping.id,
              route_id: route.id,
              kind: 'scheduled',
              tweet_json: '{}',
            }]);
            const collidingOverride = await json('/api/activity/' + mapping.id + '/503/override-requeue', {
              method: 'POST',
              headers: { ...adminAuth, 'x-queue-confirmation': 'OVERRIDE_POLICY_SKIP' },
              body: JSON.stringify({ override: true }),
            });
            const skipRecordAfterFailedOverride = dbService.getPost('503', mapping.id);
            postQueueService.claimNextBatch(new Set(), new Set([mapping.id]), undefined, 1);
            const activeDelete = await json('/api/queue/items/did%3Aplc%3Atest-destination/500', {
              method: 'DELETE',
              headers: adminAuth,
            });
            const details = await json('/api/health/details', { headers: adminAuth });
            const metrics = await json('/api/metrics', { headers: adminAuth });
            const publicText = health.text + ready.text;
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              healthStatus: health.status,
              readyStatus: ready.status,
              publicRedacted:
                !publicText.includes('primary-cookie-secret') &&
                !publicText.includes('csrf-cookie-secret') &&
                !publicText.includes('secret-webhook') &&
                !publicText.includes('destination.example') &&
                !publicText.includes('source'),
              deniedStatus: denied.status,
              missingConfirmationStatus: missingConfirmation.status,
              activeDeleteStatus: activeDelete.status,
              activeDeleteError: activeDelete.body.error,
              cookieDiagnostics: details.body.cookies,
              detailsRedacted: !details.text.includes('primary-cookie-secret') &&
                !details.text.includes('csrf-cookie-secret') &&
                !details.text.includes('webhook-signing-secret'),
              metricsStatus: metrics.status,
              metricsHasCounters: typeof metrics.body.counters.sweeps === 'number',
              userCreated: createdUser.status,
              deniedReevaluationStatus: deniedReevaluation.status,
              missingPolicyConfirmationStatus: missingPolicyConfirmation.status,
              allowedReevaluationStatus: allowedReevaluation.status,
              allowedDecision: allowedReevaluation.body.decision,
              deniedOverrideStatus: deniedOverride.status,
              allowedOverrideStatus: allowedOverride.status,
              overrideDecision: allowedOverride.body.decision,
              skipRecordConsumedAfterOverride: skipRecordAfterOverride === null,
              queuedAfterOverrideStatus: queuedAfterOverride && queuedAfterOverride.status,
              collidingOverrideStatus: collidingOverride.status,
              skipRecordRestoredAfterFailedOverride:
                skipRecordAfterFailedOverride !== null &&
                skipRecordAfterFailedOverride.status === 'skipped' &&
                !skipRecordAfterFailedOverride.override_requeued_at,
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
      healthStatus: 200,
      readyStatus: 200,
      publicRedacted: true,
      deniedStatus: 403,
      missingConfirmationStatus: 400,
      activeDeleteStatus: 409,
      detailsRedacted: true,
      metricsStatus: 200,
      metricsHasCounters: true,
      userCreated: 200,
      deniedReevaluationStatus: 403,
      missingPolicyConfirmationStatus: 400,
      allowedReevaluationStatus: 200,
      allowedDecision: { allowed: true, reason: 'allowed' },
      deniedOverrideStatus: 403,
      allowedOverrideStatus: 200,
      overrideDecision: { allowed: true, reason: 'authorized-policy-override' },
      skipRecordConsumedAfterOverride: true,
      queuedAfterOverrideStatus: 'pending',
      collidingOverrideStatus: 409,
      skipRecordRestoredAfterFailedOverride: true,
    });
    expect(result.cookieDiagnostics).toMatchObject({
      primaryConfigured: true,
      backupConfigured: false,
    });
    expect(result.activeDeleteError).toContain('Active queue items cannot be deleted');
  } finally {
    temporary.cleanup();
  }
});
