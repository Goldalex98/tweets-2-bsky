import type { DatabaseMigration } from './types.js';

export const runtimeStateMigration: DatabaseMigration = {
  version: 3,
  name: 'source-destination-runtime-state',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_runtime_state (
        source_id TEXT PRIMARY KEY,
        last_check_at INTEGER,
        last_fetch_success_at INTEGER,
        last_tweet_seen_id TEXT,
        last_tweet_seen_at INTEGER,
        last_error_category TEXT,
        last_error_message TEXT,
        last_error_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_quiet_checks INTEGER NOT NULL DEFAULT 0,
        next_eligible_check_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS destination_runtime_state (
        destination_id TEXT PRIMARY KEY,
        last_bsky_login_at INTEGER,
        last_bsky_post_at INTEGER,
        last_profile_sync_at INTEGER,
        last_pin_sync_at INTEGER,
        last_error_category TEXT,
        last_error_message TEXT,
        last_error_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_source_runtime_eligibility
        ON source_runtime_state(next_eligible_check_at, last_check_at);
    `);
  },
};
