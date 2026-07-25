import type { DatabaseMigration, MigrationDatabase } from './types.js';

interface ColumnDefinition {
  name: string;
  sql: string;
}

const CANONICAL_COLUMNS: ColumnDefinition[] = [
  { name: 'source_type', sql: "TEXT NOT NULL DEFAULT 'x'" },
  { name: 'external_post_id', sql: "TEXT NOT NULL DEFAULT ''" },
  { name: 'destination_id', sql: "TEXT NOT NULL DEFAULT ''" },
  { name: 'route_id', sql: 'TEXT' },
  { name: 'source_created_at', sql: 'INTEGER' },
  { name: 'posted_at', sql: 'INTEGER' },
  { name: 'skip_reason', sql: 'TEXT' },
  { name: 'error_category', sql: 'TEXT' },
  { name: 'error_message', sql: 'TEXT' },
  { name: 'policy_version', sql: 'INTEGER NOT NULL DEFAULT 1' },
];

function addMissingColumns(db: MigrationDatabase, table: 'processed_tweets' | 'post_queue'): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of CANONICAL_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.sql};`);
    }
  }
}

export const canonicalIdentitiesMigration: DatabaseMigration = {
  version: 2,
  name: 'canonical-identities',
  up(db) {
    addMissingColumns(db, 'processed_tweets');
    addMissingColumns(db, 'post_queue');
    db.exec(`
      UPDATE processed_tweets
      SET external_post_id = twitter_id
      WHERE external_post_id = '';
      UPDATE processed_tweets
      SET destination_id = bsky_identifier
      WHERE destination_id = '';
      UPDATE processed_tweets
      SET posted_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000
      WHERE posted_at IS NULL AND status = 'migrated' AND created_at IS NOT NULL;
      UPDATE processed_tweets
      SET skip_reason = 'legacy-skip'
      WHERE skip_reason IS NULL AND status = 'skipped';

      UPDATE post_queue
      SET external_post_id = twitter_id
      WHERE external_post_id = '';
      UPDATE post_queue
      SET destination_id = mapping_id
      WHERE destination_id = '';
      UPDATE post_queue
      SET error_category = 'legacy-delivery', error_message = last_error
      WHERE last_error IS NOT NULL AND error_message IS NULL;

      CREATE INDEX IF NOT EXISTS idx_processed_destination_id
        ON processed_tweets(destination_id);
      CREATE INDEX IF NOT EXISTS idx_processed_route_id
        ON processed_tweets(route_id);
      CREATE INDEX IF NOT EXISTS idx_queue_destination_status
        ON post_queue(destination_id, status);
      CREATE INDEX IF NOT EXISTS idx_queue_route_status
        ON post_queue(route_id, status);
    `);
  },
};
