---
name: add-config-migration
description: Add an idempotent JSON config schema migration (migrateVNToVN+1), wire backups/normalize/assertValid, and tests. Use when bumping CURRENT_CONFIG_SCHEMA_VERSION, adding migrateV* functions, or changing persisted config shape.
---

# Add config schema migration

## Checklist

Copy and track:

```
- [ ] Bump CURRENT_CONFIG_SCHEMA_VERSION in src/config/schemas.ts
- [ ] Implement migrateV{N-1}ToV{N} in src/config/migrations.ts
- [ ] Wire applyMigrationsFromV3 + migrateConfigWithMetadata
- [ ] Update ROLLBACK_BACKUP_SUFFIX and ConfigMigrationReport backupSuffix union
- [ ] ensurePreV{N}Backup in src/config-manager.ts (+ recover/getConfig paths)
- [ ] normalize + assertValidAppConfig; projection if mappings affected
- [ ] secret-storage field paths if new secrets
- [ ] Unit test: migrate + idempotent second load
- [ ] Docs via sync-schema-docs skill
- [ ] bun run typecheck:server + focused unit tests
```

## Implementation notes

1. Read the latest `migrateV*ToV*` as the template (currently `migrateV6ToV7`).
2. Start from `normalizeConfigV3({ ...raw, schemaVersion: CURRENT })`, mutate, then `normalizeConfigV3(toCanonicalConfig(config))` for stable ordering.
3. End with `assertValidAppConfig` and refresh `mappings = projectAccountMappings(...)` if destinations/accounts changed.
4. Identity/credential moves must respect identity-model rule (one destination per account; passwords on accounts).

## Do not

- Break byte-stable reload (duplicate accounts on second migrate).
- Point tests at real `data/config.json`.
- Skip docs (`docs/config-v3-migration.md`, `docs/architecture.md`, README schema line).
