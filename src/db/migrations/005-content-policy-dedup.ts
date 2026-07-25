import type { DatabaseMigration, MigrationDatabase } from './types.js';

function addColumn(db: MigrationDatabase, table: string, name: string, definition: string): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
}

export const contentPolicyDedupMigration: DatabaseMigration = {
  version: 5,
  name: 'content-policy-dedup',
  up(db) {
    for (const table of ['post_queue', 'processed_tweets']) {
      addColumn(db, table, 'decision_version', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, table, 'decision_trace', 'TEXT');
    }
    addColumn(db, 'post_queue', 'snapshot_updated_at', 'INTEGER');
    addColumn(db, 'post_queue', 'snapshot_updated_by', 'TEXT');
    addColumn(db, 'post_queue', 'snapshot_update_reason', 'TEXT');
    addColumn(db, 'post_queue', 'previous_policy_hash', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS content_fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        destination_id TEXT NOT NULL,
        route_id TEXT,
        external_post_id TEXT NOT NULL,
        text_url_hash TEXT NOT NULL,
        image_hash TEXT,
        created_at INTEGER NOT NULL,
        override_of_id INTEGER,
        FOREIGN KEY (override_of_id) REFERENCES content_fingerprints(id)
      );
      CREATE INDEX IF NOT EXISTS idx_content_fingerprint_destination_hash_time
        ON content_fingerprints(destination_id, text_url_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_content_fingerprint_route_time
        ON content_fingerprints(destination_id, route_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_content_fingerprint_image_time
        ON content_fingerprints(destination_id, image_hash, created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_provider_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        error_category TEXT,
        requested_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_provider_usage_requested
        ON ai_provider_usage(requested_at DESC);
    `);
  },
};
