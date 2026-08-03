---
name: add-config-migration
description: Add an idempotent JSON config schema migration and wire backups, normalization, validation, projection, tests, and docs. Use when changing the persisted config shape or CURRENT_CONFIG_SCHEMA_VERSION.
---

# Add config schema migration

## Checklist

- Bump `CURRENT_CONFIG_SCHEMA_VERSION` only for a real migration.
- Implement the next `migrateV{N-1}ToV{N}` and wire
  `applyMigrationsFromV3` and `migrateConfigWithMetadata`.
- Update `ROLLBACK_BACKUP_SUFFIX`, `ConfigMigrationReport`, and
  `ensurePreV{N}Backup` plus recovery/get-config paths.
- Normalize, project affected mappings, and call `assertValidAppConfig`.
- Cover new secret fields in the existing secret-storage paths.
- Add migration and second-load idempotency unit tests using a temporary data
  directory; never use real `data/config.json`.
- Sync `docs/config-v3-migration.md`, `docs/architecture.md`, and other drifted
  docs with `sync-schema-docs`.
- Run `bun run typecheck:server` and focused migration tests.

## Implementation notes

Use the latest migration (currently `migrateV6ToV7`) as the template. Start
from `normalizeConfigV3({ ...raw, schemaVersion: CURRENT })`, mutate, then
re-normalize `normalizeConfigV3(toCanonicalConfig(config))` for stable output.
Respect the identity-model rule: one destination per account and credentials
on accounts.

Never duplicate accounts on the second load, point at the real data directory,
or skip documentation.
