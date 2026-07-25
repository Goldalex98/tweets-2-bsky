import { legacyBaselineMigration } from './001-legacy-baseline.js';
import { canonicalIdentitiesMigration } from './002-canonical-identities.js';
import { runtimeStateMigration } from './003-runtime-state.js';
import { operationsObservabilityMigration } from './004-operations-observability.js';
import { contentPolicyDedupMigration } from './005-content-policy-dedup.js';
import { retainedPolicyCandidatesMigration } from './006-retained-policy-candidates.js';
import { normalizedIngestionDigestsMigration } from './007-normalized-ingestion-digests.js';
import { canonicalQueueIdentityMigration } from './008-canonical-queue-identity.js';
import { deliveryDiagnosticsMigration } from './009-delivery-diagnostics.js';
import { blueskyAccountRuntimeMigration } from './010-bluesky-account-runtime.js';
import type { DatabaseMigration, MigrationClock, MigrationDatabase } from './types.js';

export type {
  DatabaseMigration,
  MigrationClock,
  MigrationDatabase,
} from './types.js';

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  legacyBaselineMigration,
  canonicalIdentitiesMigration,
  runtimeStateMigration,
  operationsObservabilityMigration,
  contentPolicyDedupMigration,
  retainedPolicyCandidatesMigration,
  normalizedIngestionDigestsMigration,
  canonicalQueueIdentityMigration,
  deliveryDiagnosticsMigration,
  blueskyAccountRuntimeMigration,
];

const systemMigrationClock: MigrationClock = {
  now: () => Date.now(),
};

function validateMigrationOrder(migrations: readonly DatabaseMigration[]): void {
  let previous = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error('Database migrations must have unique, ascending positive versions.');
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate database migration name: ${migration.name}.`);
    }
    previous = migration.version;
    names.add(migration.name);
  }
}

export function runDatabaseMigrations(
  db: MigrationDatabase,
  options: {
    clock?: MigrationClock;
    migrations?: readonly DatabaseMigration[];
  } = {},
): number[] {
  const migrations = options.migrations ?? DATABASE_MIGRATIONS;
  const clock = options.clock ?? systemMigrationClock;
  validateMigrationOrder(migrations);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  const newlyApplied: number[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        clock.now(),
      );
    })();
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}
