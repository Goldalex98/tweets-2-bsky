export interface MigrationStatement {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
}

export interface MigrationDatabase {
  prepare(sql: string): MigrationStatement;
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

export interface DatabaseMigration {
  version: number;
  name: string;
  up(db: MigrationDatabase): void;
}

export interface MigrationClock {
  now(): number;
}
