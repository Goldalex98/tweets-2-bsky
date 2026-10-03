# Handoff — tweets-2-bsky

_Update this file before ending a session or near the context limit. Read it first when resuming. Keep it short: current state, next step, open questions. Durable facts belong in docs/memory, not here._

**Last updated:** 2026-10-03 by Claude (status refresh after 3.8.0)

## Current state
- `main` is at `v3.8.0` (2026-10-03). PRs #9–#16 shipped 3.6.9–3.8.0; Docker publish and CodeQL are green.
- Fixed since the last handoff: `deleteAllPosts` now runs under the destination maintenance lease (#12), and login backoff only applies to auth and rate-limit errors (#10).
- Read-only lint (`bun run lint:check`): 0 errors, 2 warnings (`!important` in `public/index.html`), 1 info.
- Agents: `config-integrity`, `pipeline-regression` (both have Codex/Cursor mirrors), `quality-gate`, `release-verifier`.
- Gotcha: `bun run lint` is `biome check --write .` and rewrites files. Use `lint:check` for a read-only check.
- Gotcha: `gh`'s default repo here is upstream `j4ckxyz/tweets-2-bsky`. Pass `-R Goldalex98/tweets-2-bsky`.

## Next step
- Production was last known on v3.6.6, pinned by digest and excluded from Watchtower. Confirm what's running live before planning a digest bump to 3.8.0.
- Optional: `src/bsky.ts:116` still records every login failure on the account as `bsky-auth`. Use the classified `category` there instead.

## Open questions
- None currently.
