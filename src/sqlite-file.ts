/**
 * Opens a SQLite file that is not the live application database: staged restore
 * candidates and offline key-rotation targets. Keeping this separate from
 * `src/db.ts` avoids running migrations or reusing the live connection against
 * a file that is not yet (or no longer) the active database.
 */

export interface SqliteFileStatement {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
}

export interface SqliteFileHandle {
  prepare: (sql: string) => SqliteFileStatement;
  exec: (sql: string) => unknown;
  close: () => void;
}

interface RawSqliteHandle {
  prepare: (sql: string) => SqliteFileStatement & { finalize?: () => void };
  exec: (sql: string) => unknown;
  close?: (throwOnError?: boolean) => void;
}

type SqliteConstructor = new (filename: string) => RawSqliteHandle;

const SqliteDatabase: SqliteConstructor = await (async () => {
  if (typeof process.versions.bun === 'string') {
    const bunSqliteSpecifier = 'bun:sqlite';
    const sqliteModule = (await import(bunSqliteSpecifier)) as { Database: SqliteConstructor };
    return sqliteModule.Database;
  }
  const betterSqliteModule = await import('better-sqlite3');
  return betterSqliteModule.default as unknown as SqliteConstructor;
})();

/**
 * Statements are tracked so they can be finalized before the handle closes.
 * Without that, the underlying file stays locked on Windows and the caller
 * cannot rename or delete it.
 */
export function openSqliteFile(filePath: string): SqliteFileHandle {
  const raw = new SqliteDatabase(filePath);
  const statements: Array<{ finalize?: () => void }> = [];
  let closed = false;
  return {
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      statements.push(statement);
      return statement;
    },
    exec: (sql) => raw.exec(sql),
    close: () => {
      if (closed) return;
      closed = true;
      for (const statement of statements) {
        try {
          statement.finalize?.();
        } catch {
          // A statement that never executed may already be released.
        }
      }
      statements.length = 0;
      raw.close?.(true);
    },
  };
}

export function withSqliteFile<T>(filePath: string, action: (handle: SqliteFileHandle) => T): T {
  const handle = openSqliteFile(filePath);
  try {
    return action(handle);
  } finally {
    handle.close();
  }
}

export function sqliteTableExists(handle: SqliteFileHandle, table: string): boolean {
  const row = handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { name?: string } | undefined;
  return typeof row?.name === 'string';
}
