---
name: run-quality-gate
description: Run the Windows-safe Bun PATH fix and project quality commands (lint, typecheck, tests, optional full check). Use before finishing schema/pipeline/API work, when verifying a fix, or when the user asks to run checks/tests.
---

# Run quality gate

## Windows Bun PATH (do first if bun missing)

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;" + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
where.exe bun
bun --version
```

Do not switch to npm because of a stale agent PATH.

## Default (focused)

Run in order unless user scoped narrower:

1. `bun run lint:check`
2. `bun run typecheck:server` and/or `bun run typecheck:web` (both if both sides touched)
3. Focused tests, e.g. `bun test tests/unit/config-v7-migration.test.ts` or `bun run test:unit` / `test:integration`

## Full gate (schema, pipeline, release-risk)

```powershell
bun run check
```

(`lint:check` + typecheck + unit + integration + release + build)

## Never in offline CI / default gate

- `bun run test:pipeline`
- `bun run test:twitter-*`
- `bun run test:ad-tweet`

E2E only when asked: `bun run test:e2e`.
