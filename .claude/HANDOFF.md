# Handoff — tweets-2-bsky

_Update this file before ending a session or near the context limit. Read it first when resuming. Keep it short: current state, next step, open questions. Durable facts belong in docs/memory, not here._

**Last updated:** 2026-10-03 by Claude (production access, server updates, app unpinned)

## Current state
- `main` is at `v3.8.0` (2026-10-03). PRs #9–#16 shipped 3.6.9–3.8.0; Docker publish and CodeQL are green.
- Fixed since the last handoff: `deleteAllPosts` now runs under the destination maintenance lease (#12), and login backoff only applies to auth and rate-limit errors (#10).
- Read-only lint (`bun run lint:check`): 0 errors, 2 warnings (`!important` in `public/index.html`), 1 info.
- Agents: `config-integrity`, `pipeline-regression` (both have Codex/Cursor mirrors), `quality-gate`, `release-verifier`.
- Gotcha: `bun run lint` is `biome check --write .` and rewrites files. Use `lint:check` for a read-only check.
- Gotcha: `gh`'s default repo here is upstream `j4ckxyz/tweets-2-bsky`. Pass `-R Goldalex98/tweets-2-bsky`.

## Production access (2026-10-03)
- Portainer is live at `portainer.agoldberg.net` behind Cloudflare Access (tunnel `ovh-t2b`, Portainer stack `cloudflared`). Unauthenticated requests 302 to the Access login, and the connector received the route.
- SSH alias `ovh-t2b` works with key `~/.ssh/ovh-t2b`.
- Portainer was upgraded 2.39.5 → 2.45.1 on 2026-10-03 (plain `docker run`). Backup: `~/backups/portainer_data-20261003T160617Z.tar.gz`. Rollback image: `portainer/portainer-ce:2.39.5-rollback`. The owner ran the apt upgrade (52 packages) and rebooted at 12:25 EDT: kernel 7.0.0-38, Docker 29.8.2.
- The app is now UNPINNED. Stack `tweets2bsky` runs `:latest` with Watchtower label true (hourly updates). Its ref is `refs/tags/v3.6.6` (the compose file is identical to main). Portainer 2.45 refuses git clones that contain symlinks, and `.claude/skills` (added in 3bb5cb0) is one, so the stack can't track `main`/`v3.7+` unless that symlink is replaced. On 2026-10-03 16:43 UTC it was running 3.8.0 (main build sha256:14a8ec13…). The entrypoint chowned the data to uid 1000 and the app runs as `bun`. Pre-upgrade data backup: `~/backups/tweets2bsky_data-20261003T163724Z.tar.gz`. Rollback: set `TWEETS2BSKY_IMAGE=…@sha256:e500a9a7…` and `TWEETS2BSKY_AUTO_UPDATE=false`, then restore the backup (the data is now bun-owned; that's fine for 3.6.6, which runs as root).
- Caddy (2.11.6) and Watchtower (1.22.3) were updated on 2026-10-03, and both now carry the Watchtower label. `WATCHTOWER_CLEANUP=true`. Watchtower now auto-updates caddy, cloudflared, tweets-2-bsky and itself (Portainer is not labeled; it is a plain docker run). Stale images were pruned on 2026-10-03 (disk 77% → 28%). Kept for rollback: `portainer/portainer-ce:2.39.5-rollback` and `ghcr.io/goldalex98/tweets-2-bsky:3.6.6-rollback` (digest e500a9a7…).
- `docs/operations.md` "Production host access" documents this setup.
- The owner declined both hardening steps (sshd password auth stays on; Caddy is not restricted to Cloudflare IPs). Logging in through the Portainer hostname works (owner confirmed 2026-10-03).

## Next step
- Optional: `src/bsky.ts:116` still records every login failure on the account as `bsky-auth`. Use the classified `category` there instead.

## Open questions
- None currently.
