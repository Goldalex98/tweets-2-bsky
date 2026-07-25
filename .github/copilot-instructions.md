# Repository guidance

## Stack and layout

- Runtime/package manager: Bun; language: strict TypeScript with NodeNext server modules.
- `bun.lock` is the only lockfile. Never add `package-lock.json`: Bun silently migrates from it when `bun.lock` is absent, which pins stale transitive versions.
- Backend: Express in `src/server.ts`; daemon and posting pipeline in `src/index.ts`.
- Frontend: React 19 + Vite in `web/`; production assets are emitted to `web/dist/`.
- Persistence: JSON configuration plus SQLite (`processed_tweets` and durable `post_queue`) in the configured data directory.
- Integrations: `@the-convocation/twitter-scraper` for X reads and `@atproto/api` for Bluesky writes.
- Formatting/linting: Biome. Tests use `bun:test`.
- Keep `.js` suffixes on relative TypeScript imports; NodeNext resolves them to emitted JavaScript.

## Current flow

`config -> enabled AccountMapping -> each X username -> fetch sweep -> SQLite post_queue -> per-mapping Bluesky worker -> processed_tweets`

The web server exposes authenticated configuration/operations APIs and serves the Vite build. One-shot CLI modes may use the older inline fetch/post path; the long-running daemon uses the durable queue split.

## Invariants

- One `AccountMapping` represents exactly one Bluesky destination identity and one or more X source usernames.
- Preserve the fetch/queue split: X discovery must not wait for Bluesky media upload or posting.
- Credential validation is read-only. `validateBlueskyCredentials` may authenticate and read session metadata but must never update a profile, label, pin, follow, or post.
- Never log or return secrets: X cookies, Bluesky app passwords, AI keys, JWTs, authorization headers, or webhook secrets. API mapping responses must pass through sanitization.
- Set `TWEETS2BSKY_DATA_DIR` (or `APP_DATA_DIR`) before importing config/database modules. `src/storage-paths.ts` resolves paths at module load, and `src/db.ts` opens and migrates SQLite at import time.
- Queue identity and processed-history identity prevent duplicate destination posts; preserve their destination-scoped keys.
- Treat profile, label, pin, follow, and post operations as mutations requiring explicit intent. Do not hide mutations in validation or preview paths.

## Commands

- `bun install --frozen-lockfile`
- `bun audit --audit-level=high` — advisories against the resolved tree
- `bun run verify:deps` — after upgrading the X scraper or Bluesky SDK
- `bun run lint:check` — non-mutating lint verification
- `bun run typecheck:server`
- `bun run typecheck:web`
- `bun run test:unit`
- `bun run test:integration`
- `bun run test` — all Bun tests
- `bun run check` — local quality suite
- `bun run build`

Keep `bun run lint` and `bun run format` as mutating developer commands. `test:pipeline`, `test:twitter-*`, and `test:ad-tweet` are live/manual smoke scripts and must not run in offline CI.

### Windows agent shells

Cursor agent shells on Windows sometimes omit the user `Path` even when Bun is installed at `%USERPROFILE%\.bun\bin\bun.exe`. Before treating Bun as missing:

1. Prefer `where.exe bun` / `bun --version`.
2. If missing, prepend the install dir for the session, then retry:
   ```powershell
   $env:Path = "$env:USERPROFILE\.bun\bin;" + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
   ```
3. Do not switch the project to npm/Node because of a stale agent `PATH`.
4. Windows Bun installs often ship only `bun.exe` (no `bunx` shim). Prefer `bun x <pkg>` over `bunx`. If `bunx` is missing, use `bun x`, or create `%USERPROFILE%\.bun\bin\bunx.exe` as a hardlink/copy of `bun.exe` (Bun switches to bunx mode from argv0).
5. Do not run Playwright under Bun on Windows (`TimeoutError: launch ... remote-debugging-pipe`). Use `bun run test:e2e`, which delegates to Node via `scripts/run-playwright.ts`.

## Generated and sensitive paths

- Generated: `dist/`, `web/dist/`, SQLite WAL/SHM files, runtime logs, and legacy `processed/` backups.
- Sensitive/runtime: `.env`, `config.json*`, `data/`, `database.sqlite*`, `.jwt-secret`, X cookies, Bluesky app passwords, and AI keys.
- Never commit generated output or real configuration. Test fixtures must use conspicuous redacted placeholders.

## Migration and test discipline

- Preserve legacy config behavior until a versioned migration explicitly changes it.
- Config writes remain normalized and atomic; migration code must be idempotent and must not overwrite an unreadable config.
- SQLite schema changes must be repeatable, transactional where possible, and tested against a temporary data directory.
- Configure the temporary data directory before importing `src/db.ts`; do not point tests at developer or production data.
- Unit-test pure normalization/transformation helpers. Integration tests must isolate storage and mock or avoid X/Bluesky network calls.
- Run lint check, both typechecks, unit/integration tests, and build for every schema or pipeline change.
