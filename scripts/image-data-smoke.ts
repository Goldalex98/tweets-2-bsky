import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { captureConfigIdentity, captureDatabase, migrationDatabase, verifyDatabase } from './image-data-invariants.js';

// Deliberately imports compiled modules, never source, and never the scheduler.
// The host runs each stage in a separate container with --network none.
const [stage, fixture] = process.argv.slice(2);
const dataDir = process.env.TWEETS2BSKY_DATA_DIR;
if (!dataDir || !fixture || !['seed', 'restart', 'restored'].includes(stage ?? '')) {
  throw new Error('Expected fixture data directory, stage and fixture filename');
}
const configPath = path.join(dataDir, 'config.json');
const databasePath = path.join(dataDir, 'database.sqlite');
const expectedPath = path.join(dataDir, 'smoke-expected.json');
const bundlePath = path.join(dataDir, 'smoke-backup.json');
const beforePath = path.join(dataDir, 'smoke-preupgrade.json');
if (stage === 'seed') {
  assert.equal(fs.existsSync(configPath), false, 'Fixture volume must start empty');
  const bundledFixture = new URL(`./fixtures/${fixture}`, import.meta.url);
  fs.copyFileSync(
    fs.existsSync(bundledFixture) ? bundledFixture : new URL(`../tests/fixtures/${fixture}`, import.meta.url),
    configPath,
  );
  // v7 contains queues, history, checkpoints and digests but predates the v8
  // queue-table rebuild. Populate it before importing current config/db code.
  const migrations = await import('../dist/db/migrations/index.js');
  const legacy = new Database(databasePath);
  migrations.runDatabaseMigrations(migrationDatabase(legacy), {
    migrations: migrations.DATABASE_MIGRATIONS.filter((migration) => migration.version <= 7),
  });
  legacy.exec(`
    INSERT INTO processed_tweets (twitter_id, twitter_username, bsky_identifier, status, bsky_uri)
      VALUES ('pre-upgrade-history', 'fixture', 'fixture.example', 'migrated', 'at://fixture/history');
    INSERT INTO post_queue (twitter_id, bsky_identifier, mapping_id, twitter_username, tweet_json,
      source_type, source_id, external_post_id, destination_id, route_id, attempts, policy_snapshot, enqueued_at, updated_at)
      VALUES ('pre-upgrade-queue', 'fixture.example', 'fixture-destination', 'fixture', '{}',
      'x', 'fixture-source', 'pre-upgrade-queue', 'fixture-destination', 'fixture-route', 2, '{"immutable":true}', 1000, 1000);
    INSERT INTO delivery_checkpoints (destination_id, external_post_id, chunk_index, chunk_count, content_hash, created_at,
      uri, cid, root_uri, root_cid, tail_uri, tail_cid, completed_at)
      VALUES ('fixture-destination', 'pre-upgrade-thread', 0, 2, 'fixture-hash', '2026-01-01T00:00:00.000Z',
      'at://fixture/thread', 'fixture-cid', 'at://fixture/thread', 'fixture-cid', 'at://fixture/thread', 'fixture-cid', 1000);
    INSERT INTO digest_entries (destination_id, route_id, source_id, source_type, external_post_id, normalized_post_json, policy_snapshot, created_at)
      VALUES ('fixture-destination', 'fixture-route', 'fixture-source', 'x', 'pre-upgrade-digest', '{}', '{"immutable":true}', 1000);
    INSERT INTO digest_jobs (id, destination_id, route_id, next_run_at, checkpoint, entry_ids_json, created_at, updated_at)
      VALUES ('pre-upgrade-digest-job', 'fixture-destination', 'fixture-route', 2000, 1, '[1]', 1000, 1000);
  `);
  legacy.close();
  fs.writeFileSync(
    beforePath,
    JSON.stringify({
      database: captureDatabase(databasePath),
      identity: captureConfigIdentity(JSON.parse(fs.readFileSync(configPath, 'utf8'))),
    }),
  );
}
const manager = await import('../dist/config-manager.js');
const database = await import('../dist/db.js');
const backup = await import('../dist/backup-service.js');
const migrations = await import('../dist/db/migrations/index.js');
const config = manager.getConfig();
if (stage === 'seed') {
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  verifyDatabase(databasePath, before.database);
  if (captureConfigIdentity(config, before.identity.shape).digest !== before.identity.digest) {
    throw new Error('Pre-upgrade config identity or credentials changed; values withheld');
  }
}
const firstBytes = fs.readFileSync(configPath, 'utf8');
manager.getConfig();
assert.equal(fs.readFileSync(configPath, 'utf8'), firstBytes, 'Repeated migration must preserve config bytes');
assert.equal(database.getDatabaseSchemaVersion(), migrations.DATABASE_MIGRATIONS.at(-1)?.version);
const identity = {
  sources: config.sources,
  destinations: config.destinations,
  routes: config.routes,
  accounts: config.blueskyAccounts.map(({ id, loginIdentifier, serviceUrl }) => ({ id, loginIdentifier, serviceUrl })),
};
const snapshot = () => {
  const reader = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(reader.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
    return Object.fromEntries(
      ['post_queue', 'processed_tweets', 'delivery_checkpoints', 'digest_entries', 'schema_migrations'].map((table) => [
        table,
        reader.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    reader.close();
  }
};
if (stage === 'seed') {
  if (fixture !== 'config-v8-current.json') {
    assert.ok(
      fs.readdirSync(dataDir).some((name) => name.startsWith('config.json.pre-v')),
      'Migration backup required',
    );
  }
  const destinationId = config.destinations[0]?.id ?? 'smoke-destination';
  const routeId = config.routes[0]?.id ?? 'smoke-route';
  const sourceId = config.sources[0]?.id ?? 'smoke-source';
  database.dbService.saveTweet({
    twitter_id: 'smoke-history',
    twitter_username: 'fixture',
    bsky_identifier: 'fixture.example',
    status: 'migrated',
  });
  database.postQueueService.enqueue([
    {
      source_type: 'x',
      twitter_username: 'fixture',
      kind: 'scheduled',
      tweet_json: '{}',
      policy_version: 7,
      policy_snapshot: '{"fixture":"immutable"}',
      twitter_id: 'smoke-queue',
      external_post_id: 'smoke-queue',
      bsky_identifier: 'fixture.example',
      mapping_id: destinationId,
      destination_id: destinationId,
      route_id: routeId,
      source_id: sourceId,
    },
  ]);
  database.deliveryCheckpointService.initialize(destinationId, 'smoke-thread', [
    { contentHash: 'fixture', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  database.digestEntryService.enqueue({
    destinationId,
    routeId,
    policySnapshot: '{"fixture":"immutable"}',
    post: {
      sourceType: 'x',
      sourceId,
      externalId: 'smoke-digest',
      text: 'Fixture',
      createdAt: '2026-01-01T00:00:00.000Z',
      urls: [],
      sensitive: false,
      media: [],
    },
  });
  fs.writeFileSync(expectedPath, JSON.stringify({ identity, data: snapshot(), configBytes: firstBytes }));
  const bundle = backup.createBackupBundle('full');
  assert.equal(backup.validateBackupBundle(bundle).report.valid, true);
  fs.writeFileSync(bundlePath, bundle);
} else {
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(identity)),
    expected.identity,
    'Account/destination/storage identity changed',
  );
  assert.deepEqual(snapshot(), expected.data, 'Queue/history/checkpoint/digest/migration continuity failed');
  if (stage === 'restart') {
    assert.equal(firstBytes, expected.configBytes, 'Restart changed persisted config');
    database.dbService.saveTweet({
      twitter_id: 'after-backup',
      twitter_username: 'fixture',
      bsky_identifier: 'fixture.example',
      status: 'migrated',
    });
    const report = backup.applyRestoreBundle(fs.readFileSync(bundlePath), { confirmation: 'RESTORE' });
    assert.equal(report.restartRequired, true);
    assert.ok(fs.existsSync(report.preRestoreBackup));
    assert.ok(fs.existsSync(report.pendingDatabase));
  } else {
    assert.equal(database.dbService.getTweet('after-backup', 'fixture.example'), null);
    assert.equal(fs.existsSync(path.join(dataDir, 'database.restore-pending.sqlite')), false);
    assert.ok(fs.readdirSync(dataDir).some((name) => name.startsWith('database.sqlite.pre-restore-')));
  }
}
console.log(`Compiled image migration/backup continuity passed: ${fixture} ${stage}`);
