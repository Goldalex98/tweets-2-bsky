# tweets-2-bsky

Cross-post from Twitter/X to Bluesky with threads, media, durable queues, and a web dashboard.

Current release: app `3.4.0`, schema **v7** (`Source → Route → Destination → BlueskyAccount`), managed Bluesky
accounts, content routing/moderation/dedup, webhook/API ingestion, digests, encrypted configuration, and
WAL-consistent backup/restore. **Bun** is the only supported runtime and package manager (`bun.lock` only —
never add `package-lock.json`). This repo pins Bun **1.3.14** via `packageManager`.

Forked from [`j4ckxyz/tweets-2-bsky`](https://github.com/j4ckxyz/tweets-2-bsky) (also mirrored on Tangled as
[j4ck.xyz/tweets2bsky](https://tangled.org/j4ck.xyz/tweets2bsky)). **Install and deploy from this repository**
(`Goldalex98/tweets-2-bsky`) and its GHCR images.

## How it works

1. Create a managed **Bluesky account** (credentials) and a **destination** (identity + posting/profile policy).
2. Attach one or more **sources** (X usernames, or webhook/API) via **routes** to that destination.
3. The app reads X with `@the-convocation/twitter-scraper` using browser cookies (`auth_token` + `ct0`).
4. Discovery **enqueues** work in SQLite; separate workers post to Bluesky with `@atproto/api`.
5. Processed history is destination-scoped (`storageKey`) so the same tweet is not mirrored twice to one destination.
6. A scheduler runs on an interval; you can also **Run now** from the dashboard or CLI.

## Installation (pick one path)

Use either Docker **or** a source install. Do not run both against the same data directory unless you intend two deployments.

### Option A: Docker (recommended)

Prerequisite: Docker Desktop (macOS/Windows) or Docker Engine (Linux).

Image published by this repo: `ghcr.io/goldalex98/tweets-2-bsky:latest`.

1. Copy [`.env.example`](.env.example) to `.env` and set at least:
   - `CONFIG_ENCRYPTION_KEY` — **required** when `NODE_ENV=production` (32 bytes as 64 hex chars or standard base64; `openssl rand -hex 32`)
   - `JWT_SECRET` — recommended (≥32 characters); if unset, a secret is generated under the data directory
2. Start with the included compose file ([docker-compose.yml](docker-compose.yml)):

```bash
docker compose up -d
```

Open `http://localhost:3000`.

Keep the named volume (`tweets2bsky_data` → `/app/data`) so config and history survive container recreation.

Useful commands:

```bash
docker logs -f tweets-2-bsky
docker exec -it tweets-2-bsky bun dist/cli.js status
docker compose pull && docker compose up -d
```

Or `docker run`:

```bash
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e CONFIG_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  ghcr.io/goldalex98/tweets-2-bsky:latest
```

Branch pushes publish **amd64** images quickly. Multi-arch (`amd64` + `arm64`) images are built on version tags (`v*`) or a manual “Publish Docker Image” workflow run — use those for Raspberry Pi / ARM hosts.

#### Portainer / reverse proxy

For Traefik (or similar) behind a trusted proxy, use [docker-compose.portainer.yml](docker-compose.portainer.yml):
`TRUST_PROXY=true`, port exposed (not published), Watchtower label, and the same GHCR image. Set
`CORS_ALLOWED_ORIGINS`, `JWT_SECRET`, and `CONFIG_ENCRYPTION_KEY` in the stack environment.

### Option B: Source install (PM2 or manual)

Prerequisites:

- `git`
- Bun **1.3.14** (or compatible 1.3.x; the installer can install/upgrade Bun)
- PM2 (optional, recommended for background runtime)

```bash
git clone https://github.com/Goldalex98/tweets-2-bsky
cd tweets-2-bsky
chmod +x install.sh
./install.sh
```

`install.sh` builds and starts via PM2 when available, otherwise `nohup`.

Useful installer flags: `--status`, `--stop`, `--start-only`, `--no-start`, `--port 3100`.

#### Direct PM2

```bash
bun install --frozen-lockfile
bun run build
pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
pm2 save
```

#### Foreground

```bash
bun install --frozen-lockfile
bun run build
bun run start
```

For production source installs, set `NODE_ENV=production` and `CONFIG_ENCRYPTION_KEY` in the environment (see [`.env.example`](.env.example)).

## First-time setup

1. Open `http://localhost:3000`.
2. Register the first user (becomes admin).
3. In **Settings → X / Twitter cookies**, add `auth_token` and `ct0` (backup pair optional).
4. In **Settings → Bluesky accounts**, create a managed account (app password).
5. In **Destinations**, create a destination linked to that account and add X sources (or webhook/API sources).
6. Click **Run now** (or wait for the scheduler).

Credential validation is read-only (login/session metadata only). Profile, pin, label, and follow mutations require explicit policy gates.

## Security and disaster recovery

- Dashboard sessions use `HttpOnly` cookies with CSRF protection; bearer tokens remain available for CLI/automation.
- When `NODE_ENV=production`, `CONFIG_ENCRYPTION_KEY` is **required** (fail-closed). It encrypts X cookies, Bluesky `appPassword` values, AI keys, and notification secrets at rest (AES-256-GCM).
- Destructive admin actions require step-up reauthentication and a typed confirmation string.
- Settings → Data Management can create redacted or full WAL-consistent backups and validate/restore them.

See [Security, encryption, backups, and restore](docs/security-and-backups.md).

## Twitter/X notes

- Uses `@the-convocation/twitter-scraper` with browser cookies — not Twitter’s paid official API.
- Required cookies: `auth_token` and `ct0`. Rotate them in Settings when they expire.
- Treat cookies as secrets. Chromium is used for some quote-tweet screenshot fallbacks (bundled in Docker).
- Reposts retain the wrapper status identity. If the scraper cannot provide the nested original status,
  the wrapper text and X status link are preserved and recorded as a delivery diagnostic.

## Pipeline (fetch sweep + post queue)

Each cycle splits discovery from delivery so posting never delays detection:

1. **Fetch sweep** — enabled sources become eligible according to inherited, fixed, or adaptive polling policies and are checked on scheduler wakes through a global X rate limiter. Per-source policies and runtime backoff state are managed from the destination editor or Settings → Scheduler. New posts are written to `post_queue` in SQLite under the data directory.
2. **Post workers** — destination-locked workers drain the queue in parallel. A slow upload on one destination does not block others.

The queue and processed history survive restarts. Repeated failures are parked (dashboard Retry/Clear) instead of retrying forever. Long threads checkpoint after each Bluesky chunk and resume after crash or retry.

Operational endpoints:

- `GET /healthz` and `GET /readyz` — unauthenticated, redacted probes
- `GET /api/health/details` and `GET /api/metrics` — authenticated
- `GET /api/metrics/prometheus` — admin-only when `ENABLE_PROMETHEUS_METRICS=true`
- `GET/POST /api/bluesky-accounts` and `/api/bluesky-accounts/:id/*` — managed posting identities
- `POST /api/destinations` / `PATCH /api/destinations/:id/bluesky-account` — destinations and account linking
- Bulk destination actions under `/api/destinations/bulk/*` (max 50)

Tuning knobs (`SCRAPER_*`, `FETCH_CONCURRENCY`, `POST_WORKER_CONCURRENCY`, queue pacing) are documented in [`.env.example`](.env.example) and [docs/operations.md](docs/operations.md).

## CLI quick commands

```bash
bun run cli -- status
bun run cli -- list
bun run cli -- run-now
bun run cli -- run-now --dry-run
bun run cli -- backfill <destination-id-or-handle> --limit 50
bun run cli -- queue-list --destination <destination-id>
bun run cli -- notifications
bun run cli -- encryption-status
```

In Docker: `docker exec -it tweets-2-bsky bun dist/cli.js status` (same subcommands after `dist/cli.js`).

## Updating

Source installs:

```bash
./update.sh
```

Flags: `--no-restart`, `--skip-install`, `--skip-build`.

Docker: `docker compose pull && docker compose up -d` (or recreate with the same volume).

## Data directory

With `TWEETS2BSKY_DATA_DIR` (Docker default `/app/data`):

- `config.json` — sources, routes, destinations, Bluesky accounts, users, scheduler
- `database.sqlite` — queue, history, digests, ingestion state
- `.jwt-secret` — generated signing key when `JWT_SECRET` is unset

Keep the data directory, `.env`, cookies, and app passwords private.

## Webhook/API ingestion and digests

Admins can create canonical `webhook` or `api` sources, attach credentials (token shown once; optional HMAC), and send normalized posts to `POST /api/ingest/v1/posts` with `Authorization: Bearer …` and an `Idempotency-Key`. HMAC credentials also require `X-T2B-Timestamp`, `X-T2B-Nonce`, and `X-T2B-Signature`.

Terminate TLS at a trusted reverse proxy. Set `TRUST_PROXY=true` only when that proxy overwrites forwarding headers. Persist the data directory and keep the same `CONFIG_ENCRYPTION_KEY` across restarts.

Routes choose immediate or digest delivery; digest preview/publish does not consume entries. Failed digest jobs retry separately from the immediate queue.

## Documentation

- [Architecture and identity model](docs/architecture.md)
- [Configuration migration and schema](docs/config-v3-migration.md)
- [Operations: destinations, accounts, scheduler, queue, notifications, ingestion](docs/operations.md)
- [AI, routing, moderation, and deduplication](docs/content-routing-and-ai.md)
- [X and Bluesky rate limits](docs/rate-limits.md)
- [Security, encryption, backup, and restore](docs/security-and-backups.md)
- [Development, release validation, upgrade, and rollback](docs/development-and-release.md)

Sections labeled **Future ideas** in those docs are roadmap only.

## Development

```bash
bun install --frozen-lockfile
bun run verify:deps
bun run dev
bun run dev:web
bun run build
bun run lint:check
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:release
bun run playwright:install
bun run test:e2e
bun run release:validate
```

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Native module recovery:

```bash
bun run rebuild:native
bun run build
bun run start
```

## License

MIT
