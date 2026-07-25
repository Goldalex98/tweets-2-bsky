import type { DatabaseMigration, MigrationDatabase } from './types.js';

function columnNames(db: MigrationDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function selectColumn(columns: ReadonlySet<string>, name: string, fallback: string): string {
  return columns.has(name) ? name : fallback;
}

function ensureProcessedTweets(db: MigrationDatabase): void {
  const columns = columnNames(db, 'processed_tweets');
  if (columns.size === 0) {
    db.exec(`
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
    `);
    return;
  }

  const required = [
    'twitter_id',
    'twitter_username',
    'bsky_identifier',
    'tweet_text',
    'bsky_uri',
    'bsky_cid',
    'bsky_root_uri',
    'bsky_root_cid',
    'bsky_tail_uri',
    'bsky_tail_cid',
    'status',
    'created_at',
  ];
  if (required.every((name) => columns.has(name))) {
    return;
  }

  db.exec('ALTER TABLE processed_tweets RENAME TO processed_tweets_legacy_v1;');
  db.exec(`
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
  `);
  db.exec(`
    INSERT OR IGNORE INTO processed_tweets (
      twitter_id, twitter_username, bsky_identifier, tweet_text, bsky_uri,
      bsky_cid, bsky_root_uri, bsky_root_cid, bsky_tail_uri, bsky_tail_cid,
      status, created_at
    )
    SELECT
      ${selectColumn(columns, 'twitter_id', "''")},
      ${selectColumn(columns, 'twitter_username', "'unknown'")},
      ${selectColumn(columns, 'bsky_identifier', "'unknown'")},
      ${selectColumn(columns, 'tweet_text', 'NULL')},
      ${selectColumn(columns, 'bsky_uri', 'NULL')},
      ${selectColumn(columns, 'bsky_cid', 'NULL')},
      ${selectColumn(columns, 'bsky_root_uri', 'NULL')},
      ${selectColumn(columns, 'bsky_root_cid', 'NULL')},
      ${selectColumn(columns, 'bsky_tail_uri', 'NULL')},
      ${selectColumn(columns, 'bsky_tail_cid', 'NULL')},
      ${selectColumn(columns, 'status', "'migrated'")},
      ${selectColumn(columns, 'created_at', 'CURRENT_TIMESTAMP')}
    FROM processed_tweets_legacy_v1;
  `);
  db.exec('DROP TABLE processed_tweets_legacy_v1;');
}

function ensurePostQueueColumns(db: MigrationDatabase): void {
  const columns = columnNames(db, 'post_queue');
  if (columns.size === 0) {
    return;
  }
  const additions: Array<[string, string]> = [
    ['kind', "TEXT NOT NULL DEFAULT 'scheduled'"],
    ['request_id', 'TEXT'],
    ['tweet_text', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['not_before', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_error', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE post_queue ADD COLUMN ${name} ${definition};`);
    }
  }
}

export const legacyBaselineMigration: DatabaseMigration = {
  version: 1,
  name: 'legacy-baseline',
  up(db) {
    ensureProcessedTweets(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_twitter_username ON processed_tweets(twitter_username);
      CREATE INDEX IF NOT EXISTS idx_bsky_identifier ON processed_tweets(bsky_identifier);

      CREATE TABLE IF NOT EXISTS post_queue (
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
    `);
    ensurePostQueueColumns(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_queue_claim ON post_queue(status, not_before, enqueued_at);
      CREATE INDEX IF NOT EXISTS idx_queue_target ON post_queue(bsky_identifier, status);
      CREATE INDEX IF NOT EXISTS idx_queue_mapping ON post_queue(mapping_id, status);
    `);
  },
};
