import type { DatabaseMigration, MigrationDatabase } from './types.js';

function addColumn(db: MigrationDatabase, table: string, name: string, definition: string): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
}

export const retainedPolicyCandidatesMigration: DatabaseMigration = {
  version: 6,
  name: 'retained-policy-candidates',
  up(db) {
    addColumn(db, 'processed_tweets', 'retained_candidate_json', 'TEXT');
    addColumn(db, 'processed_tweets', 'retained_until', 'INTEGER');
    addColumn(db, 'processed_tweets', 'override_requeued_at', 'INTEGER');
    addColumn(db, 'processed_tweets', 'override_requeued_by', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_processed_retained_until
        ON processed_tweets(status, retained_until);

      CREATE TABLE IF NOT EXISTS policy_override_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        destination_id TEXT NOT NULL,
        route_id TEXT,
        external_post_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        prior_reason TEXT,
        decision_version INTEGER NOT NULL,
        decision_trace TEXT NOT NULL,
        policy_hash TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_policy_override_audit_destination
        ON policy_override_audit(destination_id, occurred_at DESC);
    `);
  },
};
