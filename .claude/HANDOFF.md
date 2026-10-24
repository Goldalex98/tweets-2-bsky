# Handoff — tweets-2-bsky

_Update this file before ending a session or near the context limit. Read it first when resuming. Keep it short: current state, next step, open questions. Durable facts belong in docs/memory, not here._

**Last updated:** 2026-10-24 by Claude (3.8.5 audit fix released; PR #17 merged)

## Done 2026-10-24
- v3.8.5 (PR #18, merge `ff69988`, release commit `3c8c034`): body-parser 2.4.0 (GHSA-27r3-jxmh-p828), undici 7.30.1 / 6.29.1 (GHSA-xjj6-f33q-929c), `ip-address` override 10.7.4. GHCR manifest list `sha256:c3fee5ed6af2ec3ba199d6519835767e8b8eba14989c222541dcf618fe2387da` (tags 3.8.5, 3.8, latest).
- zod GHSA-mrhx-c7xc-m3w5 is a documented exception: the CI prod audit step in `.github/workflows/quality.yml` passes `--ignore=GHSA-mrhx-c7xc-m3w5`. The fix exists only in zod 4.6.6, and every `@atproto/*` release (api through 0.29.4) plus chromium-bidi requires `zod@^3`. The only untrusted runtime parse is the DID doc in the account's own PDS session response (`isValidDidDoc`); chromium-bidi is unused (CDP). Remove the ignore once @atproto ships zod 4.
- PR #17 merged (`54a96ce`): `.claude/settings.json` deny rules for real env-file variants.
- Unverified: prod pickup. At 22:20Z prod still ran the 3.8.4 image (`sha256:6165bc00…`, started 2026-10-22); Watchtower runs at :44 each hour.
- Docker Hub publish jobs skip ("registry credentials are not set"); same on v3.8.4, so not a regression. Prod uses GHCR.

## Current state
- `v3.8.3` (2026-10-21): follow-redirects 1.16.1, handlebars 4.7.10 and vite 8.3.5 for open advisories. The Docker publish now uses `pull: true` and `no-cache-filters: runtime`, so the image gets Debian security updates; the 3.8.3 image has ca-certificates `20250419+deb13u1` (DSA-6572-1, eMudhra).
- Done 2026-10-22: Bun 1.4.4 (includes oven-sh/bun#46300: NSS 3.131.1 roots plus the blocked-key check for the eMudhra compromise) in `Dockerfile`, `packageManager` and the CI `bun-version` pins; CI Node 24.22.1 (Node.js 2026-10-21 security release). `@types/bun` stays 1.4.2 until a 1.4.4 types package is published.
- Open: `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm) has no patched release; it is only reached through semantic-release at release time.
- CI stays on GitHub-hosted runners (owner decision 2026-10-21): the repo is public, so minutes are free, and a self-hosted runner would run fork PRs on OVH. The OVH runner `ovh-1` serves weather-desk-web only.
- No PHP anywhere in this repo or image (CVE-2026-109618/109619 not applicable).
- Fixed since the last handoff: `deleteAllPosts` now runs under the destination maintenance lease (#12), and login backoff only applies to auth and rate-limit errors (#10).
- Read-only lint (`bun run lint:check`): 0 errors, 2 warnings (`!important` in `public/index.html`), 1 info.
- Agents: `config-integrity`, `pipeline-regression`, `quality-gate`, `release-verifier`.
- Gotcha: `bun run lint` is `biome check --write .` and rewrites files. Use `lint:check` for a read-only check.
- Gotcha: `gh`'s default repo here is upstream `j4ckxyz/tweets-2-bsky`. Pass `-R Goldalex98/tweets-2-bsky`.

## Production access (2026-10-03)
- Portainer is live at `portainer.agoldberg.net` behind Cloudflare Access (tunnel `ovh-t2b`, Portainer stack `cloudflared`). Unauthenticated requests 302 to the Access login, and the connector received the route.
- SSH alias `ovh-t2b` works with key `~/.ssh/ovh-t2b`.
- Portainer was upgraded 2.39.5 → 2.45.1 on 2026-10-03 (plain `docker run`). Backup: `~/backups/portainer_data-20261003T160617Z.tar.gz`. Rollback image: `portainer/portainer-ce:2.39.5-rollback`. The owner ran the apt upgrade (52 packages) and rebooted at 12:25 EDT: kernel 7.0.0-38, Docker 29.8.2.
- The app is now UNPINNED. Stack `tweets2bsky` runs `:latest` with Watchtower label true (hourly updates). Its ref is `refs/tags/v3.6.6` (the compose file is identical to main). Portainer 2.45 refuses git clones that contain symlinks, and `.claude/skills` (added in 3bb5cb0) is one, so the stack can't track `main`/`v3.7+` unless that symlink is replaced. On 2026-10-03 16:43 UTC it was running 3.8.0 (main build sha256:14a8ec13…). The entrypoint chowned the data to uid 1000 and the app runs as `bun`. The owner confirmed 3.8.0 works correctly in production. Pre-upgrade data backup: `~/backups/tweets2bsky_data-20261003T163724Z.tar.gz`. Rollback: set `TWEETS2BSKY_IMAGE=…@sha256:e500a9a7…` and `TWEETS2BSKY_AUTO_UPDATE=false`, then restore the backup (the data is now bun-owned; that's fine for 3.6.6, which runs as root).
- Caddy (2.11.6) and Watchtower (1.22.3) were updated on 2026-10-03, and both now carry the Watchtower label. `WATCHTOWER_CLEANUP=true`. Watchtower now auto-updates caddy, cloudflared, tweets-2-bsky and itself (Portainer is not labeled; it is a plain docker run). Stale images were pruned on 2026-10-03 (disk 77% → 28%). Kept for rollback: `portainer/portainer-ce:2.39.5-rollback` and `ghcr.io/goldalex98/tweets-2-bsky:3.6.6-rollback` (digest e500a9a7…).
- `docs/operations.md` "Production host access" documents this setup.
- The owner declined both hardening steps (sshd password auth stays on; Caddy is not restricted to Cloudflare IPs). Logging in through the Portainer hostname works (owner confirmed 2026-10-03).

## Next step
- Optional: `src/bsky.ts:116` still records every login failure on the account as `bsky-auth`. Use the classified `category` there instead.

## Open questions
- None currently.
