---
name: run-quality-gate
description: Run the Windows-safe Bun quality commands for this project. Use before finishing schema, pipeline, API, or release-risk work, when verifying a fix, or when the user asks to run checks or tests.
---

# Run quality gate

## Windows Bun PATH

If `bun` is missing, repair the PATH before changing package managers:

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;" + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
where.exe bun
bun --version
```

## Focused gate

Run the applicable commands in this order:

1. `bun run lint:check`
2. `bun run typecheck:server` and/or `bun run typecheck:web`
3. Focused unit/integration tests, or `bun run test:unit` / `bun run test:integration`

## Full gate

For schema, pipeline, API, or release-risk changes, run:

```powershell
bun run check
```

This includes dependency verification, lint, both typechecks, unit,
integration, release tests, and the build.

## Live-test boundary

Do not run these in offline CI or the default gate:

- `bun run test:pipeline`
- `bun run test:twitter-*`
- `bun run test:ad-tweet`

Run E2E only when requested: `bun run test:e2e`. It uses Node/Playwright on
Windows, not Bun.
