import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('upgrades a representative legacy database twice idempotently', async () => {
  const temporary = createTemporaryDataDir();
  const firstResultPath = path.join(temporary.path, 'migration-first.json');
  const secondResultPath = path.join(temporary.path, 'migration-second.json');
  const databasePath = path.join(temporary.path, 'database.sqlite');
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const firstProcess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { Database } = await import('bun:sqlite');
          const database = new Database(${JSON.stringify(databasePath)});
          database.exec(\`
            CREATE TABLE processed_tweets (
              twitter_id TEXT NOT NULL,
              twitter_username TEXT NOT NULL,
              bsky_identifier TEXT NOT NULL,
              bsky_uri TEXT,
              bsky_cid TEXT,
              bsky_root_uri TEXT,
              bsky_root_cid TEXT,
              status TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (twitter_id, bsky_identifier)
            );
            INSERT INTO processed_tweets (
              twitter_id, twitter_username, bsky_identifier, status
            ) VALUES ('tweet-1', 'source', 'destination.example', 'migrated');

            CREATE TABLE post_queue (
              twitter_id TEXT NOT NULL,
              bsky_identifier TEXT NOT NULL,
              mapping_id TEXT NOT NULL,
              twitter_username TEXT NOT NULL,
              tweet_json TEXT NOT NULL,
              enqueued_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (twitter_id, bsky_identifier)
            );
            INSERT INTO post_queue (
              twitter_id, bsky_identifier, mapping_id, twitter_username, tweet_json,
              enqueued_at, updated_at
            ) VALUES (
              'tweet-2', 'destination.example', 'mapping-1', 'source', '{}', 1, 1
            );
          \`);
          database.close();
          await import(${JSON.stringify(dbModuleUrl)});
          const inspected = new Database(${JSON.stringify(databasePath)}, { readonly: true });
          const result = {
            history: inspected.query(
              'SELECT twitter_id, external_post_id, destination_id, policy_version FROM processed_tweets'
            ).get(),
            queued: inspected.query(
              'SELECT twitter_id, external_post_id, destination_id, route_id, policy_version FROM post_queue'
            ).get(),
            migrations: inspected.query(
              'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
            ).all(),
          };
          inspected.close();
          await Bun.write(${JSON.stringify(firstResultPath)}, JSON.stringify(result));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [firstExitCode, firstStderr] = await Promise.all([
      firstProcess.exited,
      new Response(firstProcess.stderr).text(),
    ]);
    expect(firstExitCode, firstStderr).toBe(0);

    const secondProcess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          await import(${JSON.stringify(dbModuleUrl)});
          const { Database } = await import('bun:sqlite');
          const inspected = new Database(${JSON.stringify(databasePath)}, { readonly: true });
          const migrations = inspected.query(
            'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
          ).all();
          inspected.close();
          await Bun.write(${JSON.stringify(secondResultPath)}, JSON.stringify(migrations));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [secondExitCode, secondStderr] = await Promise.all([
      secondProcess.exited,
      new Response(secondProcess.stderr).text(),
    ]);
    expect(secondExitCode, secondStderr).toBe(0);

    const first = JSON.parse(fs.readFileSync(firstResultPath, 'utf8')) as {
      history: Record<string, unknown>;
      queued: Record<string, unknown>;
      migrations: Array<Record<string, unknown>>;
    };
    const secondMigrations = JSON.parse(fs.readFileSync(secondResultPath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    const migrations = first.migrations;

    expect(migrations).toEqual([
      { version: 1, name: 'legacy-baseline', applied_at: expect.any(Number) },
      { version: 2, name: 'canonical-identities', applied_at: expect.any(Number) },
      { version: 3, name: 'source-destination-runtime-state', applied_at: expect.any(Number) },
      { version: 4, name: 'operations-observability-checkpoints', applied_at: expect.any(Number) },
      { version: 5, name: 'content-policy-dedup', applied_at: expect.any(Number) },
      { version: 6, name: 'retained-policy-candidates', applied_at: expect.any(Number) },
      { version: 7, name: 'normalized-ingestion-digests', applied_at: expect.any(Number) },
      { version: 8, name: 'canonical-queue-identity', applied_at: expect.any(Number) },
      { version: 9, name: 'delivery-diagnostics', applied_at: expect.any(Number) },
    ]);
    expect(secondMigrations).toEqual(migrations);
    expect(first.history).toMatchObject({
      twitter_id: 'tweet-1',
      external_post_id: 'tweet-1',
      destination_id: 'destination.example',
      policy_version: 1,
    });
    expect(first.queued).toMatchObject({
      twitter_id: 'tweet-2',
      external_post_id: 'tweet-2',
      destination_id: 'mapping-1',
      route_id: null,
      policy_version: 1,
    });
  } finally {
    temporary.cleanup();
  }
});

test('migration 008 rekeys a populated legacy queue without orphaning rows', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'canonical-queue.json');
  const databasePath = path.join(temporary.path, 'database.sqlite');
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { Database } = await import('bun:sqlite');
          const legacy = new Database(${JSON.stringify(databasePath)});
          legacy.exec(\`
            CREATE TABLE processed_tweets (
              twitter_id TEXT NOT NULL,
              twitter_username TEXT NOT NULL,
              bsky_identifier TEXT NOT NULL,
              tweet_text TEXT,
              bsky_uri TEXT,
              bsky_cid TEXT,
              bsky_root_uri TEXT,
              bsky_root_cid TEXT,
              bsky_tail_uri TEXT,
              bsky_tail_cid TEXT,
              status TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (twitter_id, bsky_identifier)
            );
            INSERT INTO processed_tweets (twitter_id, twitter_username, bsky_identifier, status)
            VALUES
              ('h1', 'alice', 'dest-one.example', 'migrated'),
              ('h2', 'alice', 'dest-one.example', 'skipped'),
              ('h3', 'bob', 'dest-two.example', 'migrated');

            CREATE TABLE post_queue (
              twitter_id TEXT NOT NULL,
              bsky_identifier TEXT NOT NULL,
              mapping_id TEXT NOT NULL,
              twitter_username TEXT NOT NULL,
              kind TEXT NOT NULL DEFAULT 'scheduled',
              request_id TEXT,
              tweet_json TEXT NOT NULL,
              tweet_text TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              not_before INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              enqueued_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (twitter_id, bsky_identifier)
            );
            INSERT INTO post_queue (
              twitter_id, bsky_identifier, mapping_id, twitter_username, tweet_json,
              status, attempts, last_error, enqueued_at, updated_at
            ) VALUES
              ('q1', 'dest-one.example', 'mapping-one', 'alice', '{"id":"q1"}', 'pending', 0, NULL, 1000, 1000),
              ('q2', 'dest-one.example', 'mapping-one', 'alice', '{"id":"q2"}', 'failed', 3, 'boom', 2000, 2000),
              ('q3', 'dest-two.example', 'mapping-two', 'bob', '{"id":"q3"}', 'pending', 0, NULL, 3000, 3000),
              -- Same canonical identity as q1 (same post, same destination) reached
              -- the legacy queue twice under two storage identifiers.
              ('q1', 'dest-one-alias.example', 'mapping-one', 'alice', '{"id":"q1-dup"}', 'pending', 0, NULL, 4000, 4000);
          \`);
          legacy.close();

          const { postQueueService } = await import(${JSON.stringify(dbModuleUrl)});
          const inspected = new Database(${JSON.stringify(databasePath)}, { readonly: true });
          const queued = inspected.query(
            'SELECT queue_id, twitter_id, bsky_identifier, source_type, source_id, external_post_id, destination_id, status, attempts, last_error, tweet_json, enqueued_at FROM post_queue ORDER BY enqueued_at'
          ).all();
          const result = {
            queued,
            historyCount: inspected.query('SELECT COUNT(*) AS total FROM processed_tweets').get().total,
            orphanedQueue: inspected.query(
              "SELECT COUNT(*) AS total FROM post_queue WHERE queue_id IS NULL OR queue_id = '' OR external_post_id = '' OR destination_id = ''"
            ).get().total,
            orphanedHistory: inspected.query(
              "SELECT COUNT(*) AS total FROM processed_tweets WHERE external_post_id = '' OR destination_id = ''"
            ).get().total,
            newTables: inspected.query(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('destination_leases', 'backfill_jobs') ORDER BY name"
            ).all().map((row) => row.name),
            legacyLookup: postQueueService.getItem({ twitterId: 'q2', bskyIdentifier: 'dest-one.example' }),
            canonicalLookup: postQueueService.hasQueuedPost({
              sourceType: 'x',
              sourceId: '',
              externalPostId: 'q3',
              destinationId: 'mapping-two',
            }),
          };
          inspected.close();
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      queued: Array<Record<string, any>>;
      historyCount: number;
      orphanedQueue: number;
      orphanedHistory: number;
      newTables: string[];
      legacyLookup: Record<string, unknown> | null;
      canonicalLookup: boolean;
    };

    expect(result.historyCount).toBe(3);
    expect(result.orphanedQueue).toBe(0);
    expect(result.orphanedHistory).toBe(0);
    expect(result.newTables).toEqual(['backfill_jobs', 'destination_leases']);

    // The canonical duplicate collapses to the oldest row; every other row survives.
    expect(result.queued.map((row) => row.tweet_json)).toEqual([
      '{"id":"q1"}',
      '{"id":"q2"}',
      '{"id":"q3"}',
    ]);
    expect(new Set(result.queued.map((row) => row.queue_id)).size).toBe(3);
    expect(result.queued[0]).toMatchObject({
      twitter_id: 'q1',
      bsky_identifier: 'dest-one.example',
      source_type: 'x',
      external_post_id: 'q1',
      destination_id: 'mapping-one',
    });
    // Delivery state must survive the table rebuild.
    expect(result.queued[1]).toMatchObject({ status: 'failed', attempts: 3, last_error: 'boom' });
    expect(result.legacyLookup).toMatchObject({ twitter_id: 'q2', status: 'failed' });
    expect(result.canonicalLookup).toBe(true);
  } finally {
    temporary.cleanup();
  }
});

test('queue keeps destination idempotency and destination locking after upgrade', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'queue-result.json');
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { postQueueService } = await import(${JSON.stringify(dbModuleUrl)});
          const base = {
            source_type: 'x',
            destination_id: 'destination-canonical',
            twitter_username: 'source',
            kind: 'scheduled',
            tweet_json: '{}',
            policy_version: 1,
          };
          const firstInsert = postQueueService.enqueue([{
            ...base,
            twitter_id: '100',
            external_post_id: '100',
            bsky_identifier: 'storage-a',
            mapping_id: 'mapping-a',
            route_id: 'route-a',
          }]);
          const duplicateInsert = postQueueService.enqueue([{
            ...base,
            twitter_id: '100',
            external_post_id: '100',
            bsky_identifier: 'storage-a',
            mapping_id: 'mapping-a',
            route_id: 'route-a',
          }]);
          postQueueService.enqueue([{
            ...base,
            twitter_id: '101',
            external_post_id: '101',
            bsky_identifier: 'storage-b',
            mapping_id: 'mapping-b',
            route_id: 'route-b',
          }]);
          const allowed = new Set(['mapping-a', 'mapping-b']);
          const first = postQueueService.claimNextBatch(new Set(), allowed, (id) =>
            id === 'destination-canonical' ? id : 'destination-canonical'
          );
          const blocked = postQueueService.claimNextBatch(
            new Set([first.destination_key]),
            allowed,
            () => 'destination-canonical',
          );
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            firstInsert,
            duplicateInsert,
            firstDestination: first.destination_id,
            blocked,
          }));
        `,
      ],
      {
        env: temporary.env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(result).toEqual({
      firstInsert: 1,
      duplicateInsert: 0,
      firstDestination: 'destination-canonical',
      blocked: null,
    });
  } finally {
    temporary.cleanup();
  }
});

test('persists source runtime state and resets failures on success', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'runtime-state.json');
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { runtimeStateService } = await import(${JSON.stringify(dbModuleUrl)});
          runtimeStateService.recordSourceFailure({
            sourceId: 'source-1',
            checkedAt: 100,
            nextEligibleCheckAt: 200,
            category: 'rate-limit',
            message: 'redacted test error',
          });
          const failed = runtimeStateService.getSource('source-1');
          runtimeStateService.recordSourceSuccess({
            sourceId: 'source-1',
            checkedAt: 300,
            nextEligibleCheckAt: 400,
            lastTweetSeenId: 'tweet-1',
            lastTweetSeenAt: 250,
            quiet: false,
          });
          const recovered = runtimeStateService.getSource('source-1');
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ failed, recovered }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      failed: Record<string, unknown>;
      recovered: Record<string, unknown>;
    };
    expect(result.failed).toMatchObject({ consecutiveFailures: 1, lastErrorCategory: 'rate-limit' });
    expect(result.recovered).toMatchObject({
      consecutiveFailures: 0,
      lastTweetSeenId: 'tweet-1',
      nextEligibleCheckAt: 400,
    });
    expect(result.recovered.lastErrorMessage).toBeUndefined();
  } finally {
    temporary.cleanup();
  }
});
