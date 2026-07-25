import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

/**
 * Re-evaluating a queued webhook/API item used to parse its payload as an X
 * tweet, which produced empty text and an `original` content type — so keyword,
 * domain and content-type predicates all silently passed. The blocked keyword
 * below exists only in the normalized payload, so the endpoint can only reject
 * this item if it normalized by source type.
 */
test('re-evaluating a generic queue item applies policy to its normalized payload', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'generic-reevaluation-result.json');
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
          const { postQueueService } = await import(${JSON.stringify(dbModuleUrl)});
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
            await json('/api/register', {
              method: 'POST',
              body: JSON.stringify({ username: 'admin', password: 'test-password-123' }),
            });
            const login = await json('/api/login', {
              method: 'POST',
              body: JSON.stringify({ identifier: 'admin', password: 'test-password-123' }),
            });
            const adminAuth = { authorization: 'Bearer ' + login.body.token };

            const current = configManager.getConfig();
            configManager.addMapping({
              twitterUsernames: ['source'],
              bskyIdentifier: 'destination.example',
              bskyPassword: '<redacted-test-password>',
              bskyDid: 'did:plc:generic-destination',
              createdByUserId: current.users.find((user) => user.username === 'admin').id,
            });
            const withMapping = configManager.getConfig();
            const mapping = withMapping.mappings[0];
            const route = withMapping.routes[0];
            route.moderationPolicy.blockKeywords = ['embargoed'];
            configManager.saveConfig(withMapping);

            const normalized = {
              sourceType: 'webhook',
              sourceId: route.sourceId,
              externalId: 'hook-1',
              text: 'an embargoed announcement',
              createdAt: '2026-07-24T12:00:00.000Z',
              urls: [],
              sensitive: false,
              media: [],
            };
            postQueueService.enqueue([{
              twitter_id: 'hook-1',
              bsky_identifier: 'did:plc:generic-destination',
              mapping_id: mapping.id,
              twitter_username: 'source',
              destination_id: mapping.id,
              route_id: route.id,
              source_id: route.sourceId,
              source_type: 'webhook',
              external_post_id: 'hook-1',
              kind: 'scheduled',
              tweet_json: JSON.stringify(normalized),
            }]);

            const reevaluated = await json(
              '/api/queue/items/did%3Aplc%3Ageneric-destination/hook-1/reevaluate-policy',
              {
                method: 'POST',
                headers: { ...adminAuth, 'x-queue-confirmation': 'REEVALUATE_POLICY' },
                body: JSON.stringify({ reason: 'integration test' }),
              },
            );

            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ reevaluated }));
          } finally {
            listener.close();
          }
        `,
      ],
      {
        env: { ...process.env, TWEETS2BSKY_DATA_DIR: temporary.path, JWT_SECRET: 'test-jwt-secret-value' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const exitCode = await subprocess.exited;
    if (exitCode !== 0) {
      throw new Error(`Harness failed (${exitCode}): ${await new Response(subprocess.stderr).text()}`);
    }

    const { reevaluated } = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(reevaluated.status).toBe(409);
    expect(reevaluated.body.decision.allowed).toBe(false);
    expect(String(reevaluated.body.decision.reason)).toContain('moderation');
  } finally {
    temporary.cleanup();
  }
}, 60_000);
