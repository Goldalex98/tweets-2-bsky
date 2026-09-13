# Development, testing, upgrade, and rollback

## Toolchain

Bun is the canonical runtime and package manager. The pinned release toolchain is declared by `packageManager` in `package.json`, used by CI, and used by both Docker stages. `bun.lock` is the only lockfile. Never add `package-lock.json`: Bun silently migrates from it when `bun.lock` is absent, which pins stale transitive versions.

```bash
bun install --frozen-lockfile
bun run verify:deps
bun run lint:check
bun run typecheck:server
bun run typecheck:web
bun run test:unit
bun run test:integration
bun run test:release
bun run playwright:install
bun run test:e2e
bun run build
```

E2E tests build and serve the dashboard locally, use an isolated browser context, and intercept every application API. X, Bluesky, AI/provider, webhook, and media calls are mocked; no real credentials or Internet access are required. Playwright traces, screenshots, and videos are retained only on failure and are ignored by Git.

On Windows, `bun run test:e2e` launches Playwright under Node (not Bun) because Bun cannot complete the browser CDP pipe handshake. Install Node, or set `PLAYWRIGHT_NODE` to a `node.exe` path — see `TROUBLESHOOTING.md`.

## Versioning

App semver lives in `package.json`. The README “Current release” line is kept in sync by release CI via `scripts/sync-release-version.ts`. Config/database schema versions are independent of app semver.

Every push to `main` starts `.github/workflows/release.yml` (`bun run release` / semantic-release), but a code push is not necessarily a release. Release creation first requires the reusable Quality workflow to pass. The job analyzes Conventional Commits since the previous `v*` tag:

- `fix:` → patch
- `feat:` → minor
- `BREAKING CHANGE:` footer or `feat!:` / `fix!:` → major
- `chore:`, `docs:`, `ci:`, and similar → no release

A releasable merge bumps `package.json` and the README, commits with `chore(release): X.Y.Z [skip ci]`, creates tag `vX.Y.Z` and a GitHub Release. Because tag pushes authenticated with `GITHUB_TOKEN` do not start other workflows, the release job then dispatches the GHCR and Docker Hub publishers for that tag (multi-arch).

### When a pushed change does not bump the version

This is expected when all commits since the last tag are `docs:`, `chore:`,
`ci:`, or untyped subjects. For a behavior change, use a Conventional Commit
subject such as `fix: preserve repost provenance` or `feat: add ...`; do not
manually edit the version files to compensate. Semantic-release will include
all unreleased commits in the next release-bearing run.

When the version still looks stale after a release-bearing push:

1. Check the Release workflow run on `main` for a failure or a skipped release.
2. Compare `git log <latest-v-tag>..HEAD --format="%h %s"` with the commit rules above.
3. Confirm the generated `vX.Y.Z` tag/GitHub Release and that `package.json` and
   the README `Current release` line agree.
4. Inspect release permissions and the semantic-release log before touching
   `package.json` or `README.md`.

Dry-run locally (needs full history, tags, and `GITHUB_TOKEN` or `GH_TOKEN`):

```bash
bun run release -- --dry-run
```

## Release validation

`bun run release:validate` runs the copied-volume migration matrix, database migration/checkpoint tests, backup/restore tests, health/queue tests, and mocked E2E suite. Add `--docker` where Docker is available:

```bash
bun run release:validate -- --docker
```

The persistent-volume matrix copies legacy one-to-one and aggregate fixtures to a temporary data directory, starts migration twice, checks byte/idempotency stability, and verifies rollback artifacts. Separate integration coverage validates current schema, fresh one-to-one/aggregate projection, fanout, duplicate destination rejection, queue identity/checkpoint restart, plaintext/encrypted configuration, WAL-consistent backup/restore, and pending-database startup replacement.

Three additional modes cover different environments:

- `bun scripts/container-backend-tests.ts --image <candidate-or-digest>` runs real Express/SQLite source integration fixtures in the image's runtime with read-only source/test mounts and `--network=none`. It has no production data, published port, host credentials, or production authentication bypass. This is source integration evidence, separate from compiled-image acceptance.
- `bun run release:validate -- --image <repository@sha256:digest>` checks the exact published compiled artifact without rebuilding. The image harness exercises native SQLite/sharp, actual system Chromium rendering and process cleanup, fresh readiness, copied fixture migrations, restart, backup/restore, and durable-state continuity.
- `bun scripts/deployment-smoke.ts` and `bun run test:deployment-ui` inspect the actual HTTPS deployment using real API responses and an existing admin session. Set `DEPLOYMENT_BASE_URL` to its HTTPS origin, `DEPLOYMENT_STORAGE_STATE` to a protected Playwright session file, and `DEPLOYMENT_EXPECTED_VERSION` to the release version. The API script also requires a new `DEPLOYMENT_REPORT_PATH`; set `DEPLOYMENT_BASELINE_PATH` to the earlier report for identity/state comparison. Keep session files/reports outside Git (for example in ignored `secrets/` and `test-results/`). Never paste cookies/tokens into command arguments or logs.

Production smoke does not log in, log out, modify settings, invoke AI, or create public test posts. Browser traces/screenshots/video are disabled. The API report contains hashed identities and numeric queue counts; host-side digest, schema, history/checkpoint reconciliation, and sanitized logs remain separate required evidence. A passing API report alone is not full deployment acceptance. If no natural delivery occurs during the bounded run, record that coverage limitation explicitly.

## Upgrade

1. Record the running digest, volume, original operator states, and protected key/backup references. Pin the deployment and disable automatic image replacement before publishing a candidate.
2. Run release validation against disposable fixtures. Any copied-production-volume tests must deny outbound network and inbound ingestion; disabling only the scheduler does not prevent external writes.
3. Verify the exact published image digest and both required native architectures before cutover.
4. Stop new work using controls supported by the old version, drain within ten minutes, then stop the old container with a 60-second grace if necessary. Confirm the old writer has exited and preserve a WAL-consistent full backup. Reconcile any ambiguous remote requests before resuming delivery.
5. Replace the single service through its existing deployment mechanism, using the verified digest, same volume, encryption key, and original operator states. Never run old and new writers simultaneously.
6. Check `/readyz`, version/digest, identity/linkage, queue/history/checkpoints, initial-import state, logs, and actual authenticated API/UI smoke. Repair defects with forward commits and verified replacement images.

Config and database migrations are automatic and idempotent. Config upgrades retain `.pre-vN-backup` files; database migrations are additive and recorded in `schema_migrations` (through `012-bluesky-account-blocks`). Migration 012 stores the operational account block and its concurrency revision in SQLite; canonical JSON remains schema v8. The additional runtime tables remain on configuration rollback. An older image will not enforce the new account block, so establish provider/account safety before choosing it for rollback.

## Rollback

1. Stop the service.
2. Preserve the failed-upgrade volume.
3. Restore the prior image/source revision.
4. Restore the matching `config.json.pre-vN-backup` when the old version cannot read the new schema.
5. Prefer the previous compatible image with current data. Never automatically restore an older database after new external posts were accepted: reconcile published records and newer checkpoints first. When a database restore is required and safe, use a WAL-consistent backup; do not copy a live SQLite file by itself.
6. Start and verify `/readyz`, destination count, queue depth, and checkpoints.

Never solve a rollback by deleting `database.sqlite`, `config.json`, encryption keys, or generated migration backups.

## Docker and Portainer

Both Compose examples persist `/app/data`, carry encryption/proxy environment values, and probe `/readyz`. Portainer deployments should use stack secrets or protected environment values for `JWT_SECRET` and `CONFIG_ENCRYPTION_KEY`, an externally managed TLS proxy network, and an immutable image tag for controlled releases.

Set the stack's `TWEETS2BSKY_IMAGE` variable to the verified `ghcr.io/goldalex98/tweets-2-bsky@sha256:...` digest for an immutable deployment. The Portainer template also accepts `TWEETS2BSKY_AUTO_UPDATE=false` to exclude this container from label-enabled Watchtower. These are Compose interpolation values, not application credentials. Existing installations that omit them retain the original `latest`/Watchtower behavior. Disable Portainer Git auto-update separately during release preparation; it is independent of Watchtower. For a controlled release, select the verified release tag in the existing Git stack and preserve its environment/volume/network configuration.

### Image publish platforms

GHCR and Docker Hub publish share `.github/workflows/docker-build-push.yml`:

- **Branch pushes** (`master` / `main`): `linux/amd64` only, on `ubuntu-latest`.
- **Version tags (`v*`) and `workflow_dispatch`**: `linux/amd64` and `linux/arm64` on native runners (`ubuntu-latest` + `ubuntu-24.04-arm`), then a manifest-list merge. QEMU is not used.

Prefer a release tag (or a manual workflow run) when you need an ARM/Raspberry Pi image. Day-to-day `latest` from branch pushes is amd64-oriented and publishes much faster.

Each native publisher now runs the built image's native-module/Chromium/readiness and data-continuity checks plus isolated real-backend fixtures before promoting its digest. Image build success alone does not establish runtime compatibility.
