---
name: add-sqlite-migration
description: Add the next additive SQLite migration, register it, and cover it with an isolated integration test. Use when changing SQLite schema or DATABASE_MIGRATIONS.
---

# Add SQLite migration

## Checklist

- Set the next version to the last `DATABASE_MIGRATIONS` version plus one.
- Create `src/db/migrations/0NN-name.ts` exporting `DatabaseMigration`.
- Register the import and entry in `src/db/migrations/index.ts`.
- Use additive SQL (`IF NOT EXISTS` or safe `ALTER`).
- Add integration coverage with `TWEETS2BSKY_DATA_DIR` set before importing the
  database module.
- Mention operator-visible changes in `docs/development-and-release.md`.
- Run `bun test tests/integration/database-migrations.test.ts`.

Never open `data/database.sqlite*`, renumber an existing migration, or remove
tables on config rollback. Document when new tables intentionally remain.
