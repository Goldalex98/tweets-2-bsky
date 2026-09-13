import type { DatabaseMigration } from './types.js';

export const blueskyAccountBlocksMigration: DatabaseMigration = {
  version: 12,
  name: 'bluesky-account-blocks',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS bluesky_account_blocks (
      account_id TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 0
    );`);
  },
};
