# Repository guidance

Codex reads `AGENTS.md` and discovers repository skills under `.agents/skills/`.
Cursor compatibility files remain under `.cursor/` (`rules/`, `skills/`,
`commands/`, `agents/`, and hooks). This file is the short shared baseline for
Copilot and other tools; keep it aligned with the Codex guidance without
duplicating the full rule set.

## Stack

- Bun only (`bun.lock` only — never add `package-lock.json`). Strict TypeScript, NodeNext (`.js` import suffixes).
- Backend: Express `src/server.ts`; daemon `src/index.ts`. Frontend: React 19 + Vite in `web/` → `web/dist/`.
- Persistence: JSON config + SQLite in the data dir. Biome + `bun:test`.

## Flow

`config → enabled destinations/routes → X sweep → post_queue → Bluesky workers → processed_tweets`

Canonical identity: `Source → Route → Destination → BlueskyAccount`. `AccountMapping` is a runtime/API projection only.

## Invariants

- Credentials on managed `BlueskyAccount` (`Destination.bskyAccountId`); destination keeps identity + `storageKey`. At most one destination per account.
- Fetch/queue split: discovery must not wait on Bluesky upload/post.
- Credential validation is read-only (no profile/label/pin/follow/post).
- Never log/return secrets (`blueskyAccounts[].appPassword`, cookies, AI keys, JWTs, webhook secrets).
- Set `TWEETS2BSKY_DATA_DIR` / `APP_DATA_DIR` before importing config/DB modules.
- Destination-scoped queue/history keys; mutations require explicit intent.

## Commands

`bun install --frozen-lockfile` · `bun run lint:check` · `bun run typecheck` · `bun run test:unit` · `bun run test:integration` · `bun run check` · `bun run build`

Live/manual only (not CI): `test:pipeline`, `test:twitter-*`, `test:ad-tweet`. E2E: `bun run test:e2e` (Node/Playwright — not Bun on Windows).

### Windows agent shells

If `bun` missing: prepend `%USERPROFILE%\.bun\bin` to `Path`. Prefer `bun x` over `bunx`. Do not switch to npm for a stale PATH.

## Sensitive paths

Never commit: `.env`, `config.json*`, `data/`, `*.sqlite*`, `dist/`, `web/dist/`. Fixtures use redacted placeholders.

## Migrations

Config and SQLite migrations must be idempotent/additive and tested against a **temporary** data dir. After schema/pipeline changes run the quality gate (see `.agents/skills/run-quality-gate`, mirrored for Cursor at `.cursor/skills/run-quality-gate`).
