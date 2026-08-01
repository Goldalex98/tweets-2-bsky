# Agent guide (tweets-2-bsky)

This file is the Codex-authoritative project guidance. Codex loads `AGENTS.md`
before working in the repository. Keep it concise and put repeatable workflows
in `.agents/skills/`.

## Editor and agent surfaces

- Codex guidance: this file, nested `AGENTS.md` files, `.agents/skills/`,
  `.codex/agents/`, and (when trusted) `.codex/hooks.json`.
- On first use, review and trust the project hooks with Codex `/hooks`; Codex
  re-prompts when a hook definition changes. Hooks are guardrails, not a
  substitute for `.gitignore`, explicit staging, or review.
- Cursor compatibility: `.cursor/rules/`, `.cursor/skills/`,
  `.cursor/commands/`, `.cursor/agents/`, and `.cursor/hooks.json` remain in
  the repository for Cursor users. They are mirrors, not Codex discovery
  surfaces. When a workflow changes, update the Codex copy and the Cursor
  mirror in the same change.
- Human reference: use `docs/architecture.md`, `docs/operations.md`, and the
  other focused documents under `docs/` for deeper behavior and runbooks.

## Identity (schema v7)

The canonical persisted model is:

```text
Source -> Route -> Destination -> BlueskyAccount
```

- Credentials belong to `BlueskyAccount`; a destination links with
  `bskyAccountId` and retains public identity plus its destination-scoped
  `storageKey`.
- At most one destination may reference a `bskyAccountId`.
- `AccountMapping` is a runtime/API projection, not canonical persisted JSON.
- Queue and processed-history identity stays destination-scoped.
- Dashboard mutations use revision/OCC checks; stale writes return
  `409 CONFIG_REVISION_CONFLICT` and must not be silently merged.

## Runtime and security invariants

- Use Bun only. Keep `bun.lock`; never add `package-lock.json`. Prefer `bun x`
  over `bunx` on Windows.
- The backend is Express/Bun in `src/`; the frontend is React 19/Vite in
  `web/`; persistence is JSON plus SQLite under the configured data directory.
- Keep `.js` suffixes on relative TypeScript imports (NodeNext).
- Prefer explicit null checks over new non-null assertions and match existing
  Biome formatting.
- Set `TWEETS2BSKY_DATA_DIR` or `APP_DATA_DIR` to a temporary path before
  importing database/config modules; module paths resolve at import time.
- Never log, commit, or return X cookies, Bluesky passwords/app passwords,
  AI keys, JWTs, auth headers, or webhook secrets. Fixtures use obvious
  redacted placeholders.
- Never stage or commit `.env`, `config.json*`, `data/`, `*.sqlite*`,
  `dist/`, or `web/dist/`.
- If `bun` is missing in a Windows agent shell, prepend
  `%USERPROFILE%\.bun\bin` to `Path`; do not switch package managers because
  of a stale PATH.

## Pipeline invariants

- X discovery fetches and enqueues work; it must not wait for Bluesky uploads or
  posts during the sweep.
- Serialize writes per destination while allowing independent destinations to
  run concurrently. Keep duplicate suppression keys destination-scoped.
- Credential validation is read-only. Profile, label, pin, follow, and post
  operations require explicit mutation intent and must not hide in preview or
  validate paths.
- Evict cached Bluesky agents after auth failures or password rotation, and
  record health without exposing credentials.
- Queue rows retain immutable policy snapshots; re-evaluate them only through
  an explicit operator action.

## Migrations and API/UI changes

- Config migrations require a real, sequential schema version, an idempotent
  migration path, backup handling, normalization, `assertValidAppConfig`,
  redacted tests, and synchronized docs. Do not rewrite queue snapshots during
  ordinary config edits.
- SQLite migrations are additive, strictly numbered, registered in
  `src/db/migrations/index.ts`, and tested with a temporary data directory.
  Never open the developer/production database in tests.
- New account/destination fields must flow through schema, normalize/defaults,
  projection, secret storage, services/cache eviction, routes/OCC, sanitized
  API types, UI, fixtures, and tests.
- Extend existing dashboard panels and UI primitives incrementally; avoid
  behavior-changing rewrites of `DashboardApp.tsx`.

## Quality gate

Use the repository skill `.agents/skills/run-quality-gate/SKILL.md` for the
Windows-safe sequence. The normal full gate is:

```powershell
bun run check
```

It runs dependency verification, lint, both typechecks, unit/integration and
release tests, and the build. E2E is `bun run test:e2e` under Node/Playwright
(not Bun on Windows). These scripts are live/manual smoke tests and must not
run in offline CI unless explicitly requested: `test:pipeline`,
`test:twitter-*`, and `test:ad-tweet`.

## Release and versioning

- `package.json` owns app semver; `README.md`'s `Current release` line is
  updated by `scripts/sync-release-version.ts` during semantic-release. Do not
  hand-edit either version as part of an ordinary feature fix.
- A push to `main` starts `.github/workflows/release.yml`, but a push is not
  automatically a release. Semantic-release analyzes Conventional Commits
  since the previous `v*` tag: use `fix:` for a patch, `feat:` for a minor,
  and `!`/`BREAKING CHANGE:` for a major. `docs:`, `chore:`, `ci:`, and
  untyped subjects intentionally do not bump the app version.
- For behavior changes, choose a release-bearing commit subject before pushing.
  After a push, verify the Release workflow, the new `vX.Y.Z` tag/GitHub
  Release, and that `package.json` and README agree. If the version is still
  unchanged, inspect the workflow result and commit subjects before changing
  any version file.
- Keep release commits generated by semantic-release (`chore(release): ...
  [skip ci]`) intact; do not rewrite published history to repair a missed
  release.

## Working style

- Prefer the smallest change that addresses the request; avoid drive-by
  refactors.
- Read the relevant focused rule/skill and docs before editing schema,
  pipeline, credentials, or release automation.
- Report validation commands and failures with file/line evidence.
