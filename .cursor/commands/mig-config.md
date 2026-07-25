---
description: Add an idempotent config schema migration
---

Follow `.cursor/skills/add-config-migration/SKILL.md`, then `.cursor/skills/sync-schema-docs/SKILL.md`.

Implement the next `migrateV{N-1}ToV{N}` for the change I describe (or infer from the open diff). Keep migration idempotent and add unit tests. Do not touch real `data/config.json`.
