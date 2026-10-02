# Handoff — tweets-2-bsky

_Update this file before ending a session or near the context limit. Read it first when resuming. Keep it short: current state, next step, open questions. Durable facts belong in docs/memory, not here._

**Last updated:** 2026-10-01 by Claude (agent rollout session)

## Current state
- Agents: `config-integrity`, `pipeline-regression` (both have Codex/Cursor mirrors), `quality-gate`, `release-verifier`.
- The focused gate passes: lint has 0 errors and 20 warnings; server typecheck is clean.

## Next step
- `deleteAllPosts` (`src/bsky.ts:125-144`) bypasses the per-destination write lane. Take the destination's write lock or pause it during a wipe, cap concurrency, and add a test.
- Optional: record auth and non-auth login failures under separate categories (`bsky.ts:86`).

## Open questions
- Should the 20 Biome warnings be cleaned up (mostly optional chaining and regex escapes)?
