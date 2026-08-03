import type { DatabaseMigration } from './types.js';

export const routeInitialImportMigration: DatabaseMigration = {
  version: 11,
  name: 'route-initial-import-state',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS route_initial_import_state (
        route_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('initialized')),
        applied_mode TEXT NOT NULL CHECK (applied_mode IN ('recent', 'new-only')),
        baseline_post_id TEXT,
        baseline_post_created_at INTEGER,
        initialized_at INTEGER NOT NULL
      );
    `);
  },
};
