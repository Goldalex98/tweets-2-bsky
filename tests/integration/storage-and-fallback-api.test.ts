import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('storage report and prune are admin only, and fallback stats are scoped to visible destinations', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'storage-api.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const { app } = await import(${moduleUrl('server.ts')});
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { aiProviderUsageService, dbService } = await import(${moduleUrl('db.ts')});
      const listener = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => listener.once('listening', resolve));
      const api = 'http://127.0.0.1:' + listener.address().port;
      const json = async (url, options = {}) => {
        const response = await fetch(api + url, {
          ...options,
          headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };
      try {
        await json('/api/register', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
        const login = await json('/api/login', {
          method: 'POST',
          body: JSON.stringify({ includeBearerToken: true, identifier: 'admin', password: 'test-password-123' }),
        });
        const admin = { authorization: 'Bearer ' + login.body.token };
        await json('/api/admin/users', {
          method: 'POST',
          headers: admin,
          body: JSON.stringify({
            username: 'viewer',
            password: 'test-password-456',
            permissions: { viewAllMappings: false, manageOwnMappings: true, manageAllMappings: false, manageGroups: false, queueBackfills: false, runNow: false },
          }),
        });
        const viewerLogin = await json('/api/login', {
          method: 'POST',
          body: JSON.stringify({ includeBearerToken: true, identifier: 'viewer', password: 'test-password-456' }),
        });
        const viewer = { authorization: 'Bearer ' + viewerLogin.body.token };
        const users = configManager.getConfig().users;
        const userId = (name) => users.find((user) => user.username === name).id;
        for (const [source, handle, owner] of [['alpha', 'alpha.example', 'admin'], ['beta', 'beta.example', 'viewer']]) {
          configManager.addMapping({
            twitterUsernames: [source],
            bskyIdentifier: handle,
            bskyPassword: '<redacted-app-password>',
            bskyDid: 'did:plc:' + source,
            createdByUserId: userId(owner),
          });
        }
        const [alpha, beta] = configManager.getConfig().mappings;
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        let id = 1000;
        const post = (mapping, postedAt, diagnostics) => dbService.saveTweet({
          twitter_id: String(id++),
          twitter_username: mapping.twitterUsernames[0],
          bsky_identifier: mapping.bskyIdentifier,
          destination_id: mapping.id,
          posted_at: postedAt,
          bsky_uri: 'at://did:plc:x/app.bsky.feed.post/' + id,
          bsky_cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
          delivery_diagnostics: diagnostics ? JSON.stringify(diagnostics) : undefined,
          status: 'migrated',
        });
        post(alpha, now - day, [{ kind: 'video-link', reason: 'Bluesky daily video upload limit reached' }]);
        post(alpha, now - day, [{ kind: 'quote-card', reason: 'x' }, { kind: 'quote-card', reason: 'y' }]);
        post(alpha, now - day);
        post(alpha, now - 40 * day, [{ kind: 'video-link', reason: 'old' }]);
        post(beta, now - day, [{ kind: 'poll-note', reason: 'z' }]);
        aiProviderUsageService.record({ purpose: 'alt-text', provider: 'mock', status: 'success', latencyMs: 1, requestedAt: now - 10 * day });
        aiProviderUsageService.record({ purpose: 'alt-text', provider: 'mock', status: 'success', latencyMs: 1, requestedAt: now });

        const adminFallbacks = await json('/api/delivery-fallbacks?days=30', { headers: admin });
        const viewerFallbacks = await json('/api/delivery-fallbacks?days=30', { headers: viewer });
        const viewerStorage = await json('/api/admin/storage', { headers: viewer });
        const viewerPrune = await json('/api/admin/storage/prune', {
          method: 'POST', headers: viewer, body: JSON.stringify({ olderThanDays: 5, confirmation: 'PRUNE_HISTORY' }),
        });
        const storage = await json('/api/admin/storage', { headers: admin });
        const unconfirmed = await json('/api/admin/storage/prune', {
          method: 'POST', headers: admin, body: JSON.stringify({ olderThanDays: 5 }),
        });
        const invalidDays = await json('/api/admin/storage/prune', {
          method: 'POST', headers: admin, body: JSON.stringify({ olderThanDays: 0, confirmation: 'PRUNE_HISTORY' }),
        });
        const pruned = await json('/api/admin/storage/prune', {
          method: 'POST', headers: admin, body: JSON.stringify({ olderThanDays: 5, confirmation: 'PRUNE_HISTORY' }),
        });
        const rows = (report, name) => report.tables.find((table) => table.name === name)?.rows;
        await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
          adminFallbacks: adminFallbacks.body,
          viewerFallbacks: viewerFallbacks.body,
          viewerStorage: viewerStorage.status,
          viewerPrune: viewerPrune.status,
          storage: {
            status: storage.status,
            hasDatabaseBytes: storage.body.databaseBytes > 0,
            retention: storage.body.historyRetentionDays,
            processed: rows(storage.body, 'processed_tweets'),
            aiUsage: rows(storage.body, 'ai_provider_usage'),
          },
          unconfirmed: unconfirmed.status,
          invalidDays: invalidDays.status,
          pruned: { status: pruned.status, aiProviderUsage: pruned.body.pruned.aiProviderUsage, aiUsageAfter: rows(pruned.body.report, 'ai_provider_usage'), processedAfter: rows(pruned.body.report, 'processed_tweets') },
          ids: { alpha: alpha.id, beta: beta.id },
        }));
      } finally {
        listener.close();
      }
    `,
      ],
      { env: { ...temporary.env, HISTORY_RETENTION_DAYS: '45' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const { alpha, beta } = result.ids;
    expect(result.adminFallbacks).toEqual({
      days: 30,
      destinations: [
        {
          destinationId: alpha,
          bskyIdentifier: 'alpha.example',
          posted: 3,
          postsWithFallback: 2,
          byKind: { 'video-link': 1, 'quote-card': 1 },
        },
        {
          destinationId: beta,
          bskyIdentifier: 'beta.example',
          posted: 1,
          postsWithFallback: 1,
          byKind: { 'poll-note': 1 },
        },
      ].sort((a, b) => a.destinationId.localeCompare(b.destinationId)),
    });
    expect(result.viewerFallbacks.destinations.map((entry: { destinationId: string }) => entry.destinationId)).toEqual([
      beta,
    ]);
    expect(result.viewerStorage).toBe(403);
    expect(result.viewerPrune).toBe(403);
    expect(result.storage).toEqual({ status: 200, hasDatabaseBytes: true, retention: 45, processed: 5, aiUsage: 2 });
    expect(result.unconfirmed).toBe(403);
    expect(result.invalidDays).toBe(400);
    // Only the 10-day-old AI usage row goes; posting history is never pruned.
    expect(result.pruned).toEqual({ status: 200, aiProviderUsage: 1, aiUsageAfter: 1, processedAfter: 5 });
  } finally {
    temporary.cleanup();
  }
}, 30000);
