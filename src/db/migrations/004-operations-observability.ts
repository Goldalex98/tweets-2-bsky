import type { DatabaseMigration, MigrationDatabase } from './types.js';

function addColumn(db: MigrationDatabase, table: string, name: string, definition: string): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
}

export const operationsObservabilityMigration: DatabaseMigration = {
  version: 4,
  name: 'operations-observability-checkpoints',
  up(db) {
    addColumn(db, 'post_queue', 'source_id', 'TEXT');
    addColumn(db, 'post_queue', 'policy_snapshot', 'TEXT');
    addColumn(db, 'post_queue', 'first_failure_at', 'INTEGER');
    addColumn(db, 'post_queue', 'last_failure_at', 'INTEGER');
    addColumn(db, 'processed_tweets', 'source_id', 'TEXT');
    addColumn(db, 'processed_tweets', 'policy_snapshot', 'TEXT');
    addColumn(db, 'processed_tweets', 'first_failure_at', 'INTEGER');
    addColumn(db, 'processed_tweets', 'last_failure_at', 'INTEGER');
    addColumn(db, 'processed_tweets', 'attempts', 'INTEGER NOT NULL DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_checkpoints (
        destination_id TEXT NOT NULL,
        external_post_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        uri TEXT,
        cid TEXT,
        root_uri TEXT,
        root_cid TEXT,
        parent_uri TEXT,
        parent_cid TEXT,
        tail_uri TEXT,
        tail_cid TEXT,
        completed_at INTEGER,
        PRIMARY KEY (destination_id, external_post_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_checkpoint_incomplete
        ON delivery_checkpoints(destination_id, external_post_id, completed_at);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        status_code INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_delivery_updated
        ON webhook_deliveries(updated_at DESC);

      CREATE TABLE IF NOT EXISTS auth_runtime_state (
        provider TEXT PRIMARY KEY,
        configured INTEGER NOT NULL DEFAULT 0,
        active_slot TEXT,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        last_error_category TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_queue_request_status
        ON post_queue(request_id, status);
      CREATE INDEX IF NOT EXISTS idx_queue_source_status
        ON post_queue(source_id, status);
    `);
  },
};
