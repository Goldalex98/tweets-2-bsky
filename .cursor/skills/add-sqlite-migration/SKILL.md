---
name: add-sqlite-migration
description: Add the next additive SQLite migration under src/db/migrations, register it, and cover it with integration tests using a temp data dir. Use when changing SQLite schema, adding tables/columns, or editing DATABASE_MIGRATIONS.
---

# Add SQLite migration

## Checklist

```
- [ ] Next version = last in DATABASE_MIGRATIONS + 1
- [ ] Create src/db/migrations/0NN-name.ts exporting DatabaseMigration
- [ ] Register import + entry in src/db/migrations/index.ts
- [ ] Additive SQL (IF NOT EXISTS / safe ALTER)
- [ ] Integration test with temp TWEETS2BSKY_DATA_DIR before importing db
- [ ] Mention in docs/development-and-release.md if operator-visible
- [ ] bun test tests/integration/database-migrations.test.ts
```

## Template

```typescript
import type { DatabaseMigration } from './types.js';

export const exampleMigration: DatabaseMigration = {
  version: 11,
  name: 'example-name',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS example (
        id TEXT PRIMARY KEY
      );
    `);
  },
};
```

## Hard rules

- Never open developer/production `data/database.sqlite*`.
- Do not renumber existing migrations.
- Prefer leaving new tables in place on config rollback (document that).
