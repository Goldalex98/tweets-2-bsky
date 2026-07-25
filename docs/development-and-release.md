# Development, testing, upgrade, and rollback

## Toolchain

Bun is the canonical runtime and package manager. The pinned release toolchain is declared by `packageManager` in `package.json`, used by CI, and used by both Docker stages. `bun.lock` is the only lockfile. Never add `package-lock.json`: Bun silently migrates from it when `bun.lock` is absent, which pins stale transitive versions.

```bash
bun install --frozen-lockfile
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

Every push to `main` runs `.github/workflows/release.yml` (`bun run release` / semantic-release). It analyzes Conventional Commits since the previous `v*` tag:

- `fix:` → patch
- `feat:` → minor
- `BREAKING CHANGE:` footer or `feat!:` / `fix!:` → major
- `chore:`, `docs:`, `ci:`, and similar → no release

A releasable merge bumps `package.json` and the README, commits with `chore(release): X.Y.Z [skip ci]`, creates tag `vX.Y.Z` and a GitHub Release. Existing Docker publish workflows then build multi-arch images for that tag.

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

## Upgrade

1. Stop writers or take a full backup.
2. Copy the production volume and `CONFIG_ENCRYPTION_KEY` to a test host.
3. Run release validation against fixtures and exercise one one-to-one and one aggregate destination.
4. Pull the immutable image tag or source revision.
5. Start with the same persistent volume and encryption key.
6. Check `/readyz`, queue depth, migration review notices, and a read-only credential/profile preview.

Config and database migrations are automatic and idempotent. Config upgrades retain `.pre-vN-backup` files; database migrations are additive and recorded in `schema_migrations`.

## Rollback

1. Stop the service.
2. Preserve the failed-upgrade volume.
3. Restore the prior image/source revision.
4. Restore the matching `config.json.pre-vN-backup` when the old version cannot read the new schema.
5. Restore the pre-upgrade database backup only when required; do not copy a live SQLite file without its WAL/SHM or a backup snapshot.
6. Start and verify `/readyz`, destination count, queue depth, and checkpoints.

Never solve a rollback by deleting `database.sqlite`, `config.json`, encryption keys, or generated migration backups.

## Docker and Portainer

Both Compose examples persist `/app/data`, carry encryption/proxy environment values, and probe `/readyz`. Portainer deployments should use stack secrets or protected environment values for `JWT_SECRET` and `CONFIG_ENCRYPTION_KEY`, an externally managed TLS proxy network, and an immutable image tag for controlled releases.

### Image publish platforms

GHCR and Docker Hub publish share `.github/workflows/docker-build-push.yml`:

- **Branch pushes** (`master` / `main`): `linux/amd64` only, on `ubuntu-latest`.
- **Version tags (`v*`) and `workflow_dispatch`**: `linux/amd64` and `linux/arm64` on native runners (`ubuntu-latest` + `ubuntu-24.04-arm`), then a manifest-list merge. QEMU is not used.

Prefer a release tag (or a manual workflow run) when you need an ARM/Raspberry Pi image. Day-to-day `latest` from branch pushes is amd64-oriented and publishes much faster.
