import type { DatabaseMigration } from './types.js';

export const blueskyAccountRuntimeMigration: DatabaseMigration = {
  version: 10,
  name: 'bluesky-account-runtime-state',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bluesky_account_runtime_state (
        account_id TEXT PRIMARY KEY,
        last_validated_at INTEGER,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        last_error_category TEXT,
        last_error_message TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};
