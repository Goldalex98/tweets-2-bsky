import type { DatabaseMigration, MigrationDatabase } from './types.js';

function columnNames(db: MigrationDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Legacy databases may lack columns from any earlier migration, so every copied value is guarded. */
function source(columns: ReadonlySet<string>, name: string, fallback: string): string {
  return columns.has(name) ? name : fallback;
}

const POST_QUEUE_TABLE = `
  CREATE TABLE post_queue_v8 (
    queue_id TEXT PRIMARY KEY,
    twitter_id TEXT NOT NULL,
    bsky_identifier TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    twitter_username TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'x',
    source_id TEXT NOT NULL DEFAULT '',
    external_post_id TEXT NOT NULL DEFAULT '',
    destination_id TEXT NOT NULL DEFAULT '',
    route_id TEXT,
    kind TEXT NOT NULL DEFAULT 'scheduled',
    request_id TEXT,
    tweet_json TEXT NOT NULL,
    tweet_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    source_created_at INTEGER,
    posted_at INTEGER,
    skip_reason TEXT,
    error_category TEXT,
    error_message TEXT,
    policy_version INTEGER NOT NULL DEFAULT 1,
    policy_snapshot TEXT,
    decision_version INTEGER NOT NULL DEFAULT 1,
    decision_trace TEXT,
    snapshot_updated_at INTEGER,
    snapshot_updated_by TEXT,
    snapshot_update_reason TEXT,
    previous_policy_hash TEXT,
    first_failure_at INTEGER,
    last_failure_at INTEGER,
    enqueued_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (twitter_id, bsky_identifier),
    UNIQUE (source_type, source_id, external_post_id, destination_id)
  );
`;

const POST_QUEUE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_queue_claim ON post_queue(status, not_before, enqueued_at);
  CREATE INDEX IF NOT EXISTS idx_queue_target ON post_queue(bsky_identifier, status);
  CREATE INDEX IF NOT EXISTS idx_queue_mapping ON post_queue(mapping_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_destination_status ON post_queue(destination_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_route_status ON post_queue(route_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_request_status ON post_queue(request_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_source_status ON post_queue(source_id, status);
`;

/**
 * Rebuilds `post_queue` around an immutable queue id. The legacy
 * `(twitter_id, bsky_identifier)` pair is kept as a secondary unique key so
 * existing dedup semantics and accessors keep working, and the canonical
 * `(source_type, source_id, external_post_id, destination_id)` key makes
 * generic (non-X) posts representable without collisions.
 *
 * Rows are copied oldest-first with `INSERT OR IGNORE`, so when legacy data
 * already contains two rows for one canonical identity the earliest queued row
 * survives and the newer duplicate is dropped rather than failing the upgrade.
 */
function rebuildPostQueue(db: MigrationDatabase): void {
  const columns = columnNames(db, 'post_queue');
  if (columns.size === 0 || columns.has('queue_id')) return;

  db.exec(POST_QUEUE_TABLE);
  db.exec(`
    INSERT OR IGNORE INTO post_queue_v8 (
      queue_id, twitter_id, bsky_identifier, mapping_id, twitter_username,
      source_type, source_id, external_post_id, destination_id, route_id,
      kind, request_id, tweet_json, tweet_text, status, attempts, not_before, last_error,
      source_created_at, posted_at, skip_reason, error_category, error_message,
      policy_version, policy_snapshot, decision_version, decision_trace,
      snapshot_updated_at, snapshot_updated_by, snapshot_update_reason, previous_policy_hash,
      first_failure_at, last_failure_at, enqueued_at, updated_at
    )
    SELECT
      lower(hex(randomblob(16))),
      twitter_id,
      bsky_identifier,
      mapping_id,
      twitter_username,
      COALESCE(NULLIF(${source(columns, 'source_type', "'x'")}, ''), 'x'),
      COALESCE(${source(columns, 'source_id', "''")}, ''),
      COALESCE(NULLIF(${source(columns, 'external_post_id', 'twitter_id')}, ''), twitter_id),
      COALESCE(NULLIF(${source(columns, 'destination_id', 'mapping_id')}, ''), mapping_id),
      ${source(columns, 'route_id', 'NULL')},
      COALESCE(${source(columns, 'kind', "'scheduled'")}, 'scheduled'),
      ${source(columns, 'request_id', 'NULL')},
      tweet_json,
      ${source(columns, 'tweet_text', 'NULL')},
      COALESCE(${source(columns, 'status', "'pending'")}, 'pending'),
      COALESCE(${source(columns, 'attempts', '0')}, 0),
      COALESCE(${source(columns, 'not_before', '0')}, 0),
      ${source(columns, 'last_error', 'NULL')},
      ${source(columns, 'source_created_at', 'NULL')},
      ${source(columns, 'posted_at', 'NULL')},
      ${source(columns, 'skip_reason', 'NULL')},
      ${source(columns, 'error_category', 'NULL')},
      ${source(columns, 'error_message', 'NULL')},
      COALESCE(${source(columns, 'policy_version', '1')}, 1),
      ${source(columns, 'policy_snapshot', 'NULL')},
      COALESCE(${source(columns, 'decision_version', '1')}, 1),
      ${source(columns, 'decision_trace', 'NULL')},
      ${source(columns, 'snapshot_updated_at', 'NULL')},
      ${source(columns, 'snapshot_updated_by', 'NULL')},
      ${source(columns, 'snapshot_update_reason', 'NULL')},
      ${source(columns, 'previous_policy_hash', 'NULL')},
      ${source(columns, 'first_failure_at', 'NULL')},
      ${source(columns, 'last_failure_at', 'NULL')},
      enqueued_at,
      updated_at
    FROM post_queue
    ORDER BY enqueued_at ASC, rowid ASC;
  `);
  db.exec('DROP TABLE post_queue;');
  db.exec('ALTER TABLE post_queue_v8 RENAME TO post_queue;');
  db.exec(POST_QUEUE_INDEXES);
}

export const canonicalQueueIdentityMigration: DatabaseMigration = {
  version: 8,
  name: 'canonical-queue-identity',
  up(db) {
    rebuildPostQueue(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS destination_leases (
        destination_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'delivery',
        acquired_at INTEGER NOT NULL,
        renewed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_destination_leases_expiry
        ON destination_leases(expires_at);

      CREATE TABLE IF NOT EXISTS backfill_jobs (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL,
        source_usernames_json TEXT,
        limit_count INTEGER NOT NULL DEFAULT 15,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_category TEXT,
        queued_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        claim_token TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backfill_jobs_due
        ON backfill_jobs(status, not_before, sequence);
      CREATE INDEX IF NOT EXISTS idx_backfill_jobs_destination
        ON backfill_jobs(destination_id, status);
    `);
  },
};
