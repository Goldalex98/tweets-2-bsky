import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { MigrationDatabase } from '../dist/db/migrations/index.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type RecordValue = Record<string, unknown>;
interface TableSnapshot {
  columns: string[];
  hashes: string[];
}
export type DatabaseSnapshot = Record<string, TableSnapshot>;

// Bun's statements accept SQLite bindings rather than arbitrary unknown values.
// Keep that boundary explicit instead of casting the entire database interface.
function migrationBinding(value: unknown) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  )
    return value;
  throw new Error('Unsupported migration parameter');
}

export function migrationDatabase(database: Database): MigrationDatabase {
  return {
    exec: (sql) => database.exec(sql),
    transaction: (callback) => database.transaction(callback),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        get: (...params) => statement.get(...params.map(migrationBinding)),
        all: (...params) => statement.all(...params.map(migrationBinding)),
        run: (...params) => statement.run(...params.map(migrationBinding)),
      };
    },
  };
}

// Snapshot original columns before importing db/config modules. Added columns
// may change, but every original value/row must survive; diagnostics reveal no data.
export function captureDatabase(filename: string): DatabaseSnapshot {
  const database = new Database(filename, { readonly: true });
  try {
    const tables = database
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => {
        const columns = (database.query(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(
          (column) => column.name,
        );
        const rows = database.query(`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)}`).all();
        return [name, { columns, hashes: rows.map(hash).sort() }];
      }),
    );
  } finally {
    database.close();
  }
}

export function verifyDatabase(filename: string, expected: DatabaseSnapshot): void {
  const database = new Database(filename, { readonly: true });
  try {
    const integrity = database.query('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error('Copied database integrity check failed');
    for (const [table, before] of Object.entries(expected)) {
      const rows = database.query(`SELECT ${before.columns.map(quote).join(',')} FROM ${quote(table)}`).all();
      const actual = rows.map(hash).sort();
      const preserved =
        table === 'schema_migrations'
          ? before.hashes.every((entry) => actual.includes(entry))
          : hash(actual) === hash(before.hashes);
      if (!preserved) throw new Error(`Pre-upgrade row preservation failed for ${table}; values withheld`);
    }
  } finally {
    database.close();
  }
}

const records = (value: unknown) => (Array.isArray(value) ? (value as RecordValue[]) : []);
const pick = (items: unknown, keys: string[]) =>
  records(items).map((item) => Object.fromEntries(keys.map((key) => [key, item[key]])));
type IdentityShape = 'accounts' | 'destinations' | 'mappings';
export function captureConfigIdentity(value: unknown, previousShape?: IdentityShape) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid config identity');
  const config = value as RecordValue;
  const version = Number(config.schemaVersion);
  const shape = previousShape ?? (version >= 7 ? 'accounts' : version >= 3 ? 'destinations' : 'mappings');
  if (shape === 'accounts')
    return {
      shape,
      digest: hash({
        sources: pick(config.sources, ['id', 'type', 'username']),
        destinations: pick(config.destinations, ['id', 'storageKey', 'bskyAccountId', 'bskyIdentifier', 'enabled']),
        routes: pick(config.routes, ['id', 'sourceId', 'destinationId', 'enabled']),
        accounts: pick(config.blueskyAccounts, ['id', 'loginIdentifier', 'serviceUrl', 'appPassword']),
      }),
    };
  if (shape === 'destinations') {
    const accounts = records(config.blueskyAccounts);
    return {
      shape,
      digest: hash({
        sources: pick(config.sources, ['id', 'type', 'username', 'enabled']),
        destinations: records(config.destinations).map((destination) => {
          const account = accounts.find((entry) => entry.id === destination.bskyAccountId);
          return {
            id: destination.id,
            storageKey: destination.storageKey,
            identifier: destination.bskyIdentifier,
            enabled: destination.enabled,
            serviceUrl: account?.serviceUrl ?? destination.bskyServiceUrl,
            password: account?.appPassword ?? destination.bskyPassword,
          };
        }),
        routes: pick(config.routes, ['id', 'sourceId', 'destinationId', 'enabled']),
      }),
    };
  }
  return {
    shape,
    digest: hash(
      records(config.mappings).map((mapping) => ({
        id: mapping.id,
        enabled: mapping.enabled !== false,
        identifier: String(mapping.bskyIdentifier).trim().toLowerCase(),
        sources: [
          ...new Set(
            (Array.isArray(mapping.twitterUsernames) ? mapping.twitterUsernames : [mapping.twitterUsername]).map(
              (username) => String(username).trim().replace(/^@/, '').toLowerCase(),
            ),
          ),
        ].sort(),
        password: mapping.bskyPassword,
      })),
    ),
  };
}
