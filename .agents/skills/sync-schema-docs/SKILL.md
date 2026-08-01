---
name: sync-schema-docs
description: Keep README, architecture, migration, operations, security, troubleshooting, release, and Copilot guidance aligned after schema or identity-model changes.
---

# Sync schema docs

When config schema or identity changes, update only the documents that drift:

- `README.md`: current schema/version blurb and new API bullets
- `docs/architecture.md`: identity model and schema/config-manager notes
- `docs/config-v3-migration.md`: migration, canonical JSON, and rollback notes
- `docs/operations.md`: operator-facing account/destination behavior
- `docs/security-and-backups.md`: encrypted field paths
- `docs/development-and-release.md`: migration and rollback notes
- `TROUBLESHOOTING.md`: new symptoms and fixes
- `AGENTS.md`: durable Codex guidance when the invariant is recurring
- `.github/copilot-instructions.md`: short shared invariants only

Document implemented behavior only, keep examples sanitized, and avoid
duplicating the architecture document in every runbook.
