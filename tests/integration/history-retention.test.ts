import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('history pruning bounds operational tables and leaves delivery history alone', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'retention.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const { Database } = await import('bun:sqlite');
      const { historyRetentionService, dbService } = await import(${moduleUrl('db.ts')});
      const day = 24 * 60 * 60 * 1000;
      const now = Date.parse('2026-10-03T12:00:00.000Z');
      const old = now - 100 * day;
      const recent = now - 10 * day;
      const raw = new Database(${JSON.stringify(path.join(temporary.path, 'database.sqlite'))});
      const exec = (sql, ...params) => raw.prepare(sql).run(...params);
      for (const at of [old, recent]) {
        exec("INSERT INTO ingestion_audit (outcome, status_code, occurred_at) VALUES ('accepted', 202, ?)", at);
        exec("INSERT INTO ai_provider_usage (purpose, provider, status, latency_ms, requested_at) VALUES ('alt-text', 'gemini', 'success', 10, ?)", at);
        exec("INSERT INTO webhook_deliveries (id, event, status, attempts, updated_at) VALUES (?, 'queue-parked', 'delivered', 1, ?)", 'hook-' + at, at);
      }
      exec("INSERT INTO content_fingerprints (id, destination_id, external_post_id, text_url_hash, created_at) VALUES (1, 'd', 'old', 'h1', ?)", now - 400 * day);
      exec("INSERT INTO content_fingerprints (id, destination_id, external_post_id, text_url_hash, created_at) VALUES (2, 'd', 'kept-target', 'h2', ?)", now - 400 * day);
      exec("INSERT INTO content_fingerprints (id, destination_id, external_post_id, text_url_hash, created_at, override_of_id) VALUES (3, 'd', 'override', 'h2', ?, 2)", recent);
      exec("INSERT INTO content_fingerprints (id, destination_id, external_post_id, text_url_hash, created_at) VALUES (4, 'd', 'in-window', 'h3', ?)", old);
      exec("INSERT INTO ingestion_credentials (id, name, source_id, token_hash, scopes_json, created_by, created_at) VALUES ('cred', 'test', 'source', 'redacted-hash', '[]', 'test', ?)", old);
      exec("INSERT INTO ingestion_nonces (credential_id, nonce, expires_at) VALUES ('cred', 'expired', ?), ('cred', 'live', ?)", now - 1, now + day);
      const processedBefore = raw.prepare('SELECT COUNT(*) AS n FROM processed_tweets').get().n;
      raw.close();
      dbService.saveTweet({ twitter_id: 'old-tweet', twitter_username: 'source', bsky_identifier: 'destination.example', status: 'migrated', bsky_uri: 'at://did:plc:redacted/app.bsky.feed.post/3abc', bsky_cid: 'redacted' });

      const pruned = historyRetentionService.prune({ retentionMs: 90 * day, now });
      historyRetentionService.checkpoint();

      const check = new Database(${JSON.stringify(path.join(temporary.path, 'database.sqlite'))});
      const count = (table) => check.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
      const fingerprints = check.prepare('SELECT id FROM content_fingerprints ORDER BY id').all().map((row) => row.id);
      const nonces = check.prepare('SELECT nonce FROM ingestion_nonces').all().map((row) => row.nonce);
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        pruned,
        remaining: { audit: count('ingestion_audit'), ai: count('ai_provider_usage'), hooks: count('webhook_deliveries') },
        fingerprints, nonces, processed: count('processed_tweets') - processedBefore,
      }));
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      pruned: {
        ingestionAudit: 1,
        aiProviderUsage: 1,
        webhookDeliveries: 1,
        contentFingerprints: 1,
        ingestionNonces: 1,
      },
      remaining: { audit: 1, ai: 1, hooks: 1 },
      // Fingerprint 2 is old but an override still points at it; 4 is inside the longest duplicate window.
      fingerprints: [2, 3, 4],
      nonces: ['live'],
      processed: 1,
    });
  } finally {
    temporary.cleanup();
  }
}, 30000);
