---
name: sync-schema-docs
description: Keep README, architecture, migration, operations, security, troubleshooting, and copilot-instructions aligned after schema or identity-model changes. Use when CURRENT_CONFIG_SCHEMA_VERSION changes, migrations are added, or account/destination docs drift.
---

# Sync schema docs

When config schema or identity model changes, update only what drifted:

| Doc | Update |
|-----|--------|
| `README.md` | Current schema version blurb; new API bullets if any |
| `docs/architecture.md` | Identity model diagram; config-manager schema version; frontend notes |
| `docs/config-v3-migration.md` | New migrate section, canonical JSON shape, rollback suffix |
| `docs/operations.md` | Operator-facing account/destination behavior |
| `docs/security-and-backups.md` | New encrypted field paths |
| `docs/development-and-release.md` | Migration/rollback notes |
| `TROUBLESHOOTING.md` | New failure symptoms/fixes |
| `.github/copilot-instructions.md` | Short invariants only (details live in `.cursor/rules/`) |

## Rules

- Do not invent features — document implemented behavior only.
- Prefer concise diffs; no duplicate essays already covered by architecture.
- Keep examples sanitized (`<encrypted-or-redacted>`).
