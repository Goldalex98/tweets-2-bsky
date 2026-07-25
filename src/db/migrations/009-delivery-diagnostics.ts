import type { DatabaseMigration, MigrationDatabase } from './types.js';

function addColumn(db: MigrationDatabase, table: string, name: string, definition: string): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
}

export const deliveryDiagnosticsMigration: DatabaseMigration = {
  version: 9,
  name: 'delivery-diagnostics',
  up(db) {
    for (const table of ['post_queue', 'processed_tweets'] as const) {
      addColumn(db, table, 'delivery_diagnostics', 'TEXT');
    }
  },
};
