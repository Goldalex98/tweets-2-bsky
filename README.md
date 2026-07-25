# tweets-2-bsky

Cross-post from Twitter/X to Bluesky with thread support, media handling, account mapping, and a web dashboard.

Current release: app `3.3.0`, schema v7 with canonical sources, destinations, routes, managed
Bluesky accounts, durable queue/checkpoints, content routing/moderation/dedup, webhook/API
ingestion, digests, encrypted configuration, and WAL-consistent backup/restore. Bun is the
canonical runtime and package manager; `bun.lock` is the only lockfile (never add `package-lock.json`).

This repo is also mirrored on Tangled: [j4ck.xyz/tweets2bsky](https://tangled.org/j4ck.xyz/tweets2bsky)

## How It Works (Simple)

1. You connect one or more Twitter/X source accounts to a Bluesky account.
2. The app reads tweets from X using `@the-convocation/twitter-scraper` with your cookies (`auth_token` + `ct0`).
3. It posts to Bluesky using the official AT Protocol client (`@atproto/api`).
4. It tracks what was already posted in SQLite so it does not repost duplicates.
5. A scheduler runs automatically, and you can also trigger `Run now` from the dashboard or CLI.

## Installation (Pick One Path)

Use either:

- Docker (recommended)
- Source install (PM2 or manual runtime)

Do not do both on the same machine unless you intentionally want two separate deployments.

### Option A: Docker (Recommended)

Prerequisite: Docker Desktop (macOS/Windows) or Docker Engine (Linux).

Start with the included compose file:

```bash
docker compose up -d
```

Open `http://localhost:3000`.

If you prefer `docker run`:

```bash
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  j4ckxyz/tweets-2-bsky:latest
```

Important: keep a persistent volume (`-v tweets2bsky_data:/app/data`) so mappings/history survive container recreation.

Useful Docker commands:

```bash
docker logs -f tweets-2-bsky
docker exec -it tweets-2-bsky bun dist/cli.js status
docker stop tweets-2-bsky
docker start tweets-2-bsky
```

Update Docker deployment:

```bash
docker pull j4ckxyz/tweets-2-bsky:latest
docker stop tweets-2-bsky
docker rm tweets-2-bsky
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  j4ckxyz/tweets-2-bsky:latest
```

Alternative image: `ghcr.io/j4ckxyz/tweets-2-bsky:latest`.

Branch pushes publish **amd64** images quickly. Multi-arch (`amd64` + `arm64`) images are built on version tags (`v*`) or a manual “Publish Docker Image” workflow run — use those for Raspberry Pi / ARM hosts.

### Option B: Source Install (PM2 or Manual)

Prerequisites:

- `git`
- Bun 1.x+ (the installer auto-installs/upgrades Bun when needed)
- PM2 (optional, but recommended for background runtime)

Clone and install:

```bash
git clone https://github.com/j4ckxyz/tweets-2-bsky
cd tweets-2-bsky
chmod +x install.sh
./install.sh
```

`install.sh` does install/build/start and uses:

- PM2 when PM2 is available
- `nohup` when PM2 is not installed

Useful installer commands:

```bash
./install.sh --status
./install.sh --stop
./install.sh --start-only
./install.sh --no-start
./install.sh --port 3100
```

#### PM2 Manual Runtime (if you want direct PM2 control)

```bash
bun install
bun run build
pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
pm2 logs tweets-2-bsky
pm2 save
```

#### Manual Foreground Runtime (no PM2)

```bash
bun install
bun run build
bun run start
```

#### Manual Nohup Runtime (no PM2)

```bash
mkdir -p data/runtime
nohup bun run start > data/runtime/tweets-2-bsky.log 2>&1 &
echo $! > data/runtime/tweets-2-bsky.pid
```

Stop nohup process:

```bash
kill "$(cat data/runtime/tweets-2-bsky.pid)"
```

## First-Time Setup (After Install)

1. Open `http://localhost:3000`.
2. Register the first user (this account becomes admin).
3. In Settings, add Twitter cookies (`auth_token`, `ct0`; backup pair optional).
4. Add a mapping (Twitter source usernames -> Bluesky account).
5. Click `Run now`.

## Security and Disaster Recovery

The dashboard uses `HttpOnly` session cookies with CSRF protection; bearer tokens remain supported
for CLI/automation. Optional `CONFIG_ENCRYPTION_KEY` encryption protects persisted provider
credentials (including managed Bluesky account `appPassword` values and legacy destination
passwords) with AES-256-GCM. Settings → Data Management can create redacted or full
WAL-consistent backup bundles and validate/restore them; full browser backups and restore apply
require current-admin reauthentication and typed confirmation.

See [Security, encryption, backups, and restore](docs/security-and-backups.md) for key generation,
Docker environment settings, key-loss recovery, CLI migration/rotation, backup, and restore steps.

## Twitter/X Integration Notes

- This project does not use Twitter's paid official API.
- It uses `@the-convocation/twitter-scraper` and authenticated browser cookies to read account/tweet data.
- Required cookies: `auth_token` and `ct0`.
- If cookies expire, update them in Settings.
- Keep cookies private; they are sensitive credentials.

For some quote-tweet screenshot fallbacks, Chromium is used (bundled in Docker, optional dependency for source installs).

## Crossposting Pipeline (Fetch Sweep + Post Queue)

The daemon splits each cycle into two independent halves so posting never delays detection:

1. **Fetch sweep** (Twitter side): every enabled source account's timeline is checked on the configured interval. All Twitter calls go through one global rate limiter, so the request rate to Twitter is the same no matter how many accounts post at once. New tweets are written to a durable queue (`post_queue` table in `data/database.sqlite`).
2. **Post workers** (Bluesky side): several accounts post from the queue in parallel (one worker per mapping, so threads stay in order). A slow video upload or long thread on one account never blocks the others.

The queue survives restarts: anything mid-flight when the process dies is re-armed on boot, and duplicates are impossible because the queue and the processed-history table share the same tweet-id key. Tweets that repeatedly fail to post are parked as `failed` (visible in the dashboard, with admin Retry/Clear buttons) instead of retrying forever.

The dashboard's queue numbers read straight from SQLite, so what you see queued is exactly what will post.

Queue operations are scoped by item, route/source, destination, or request. Failed items can be inspected,
retried, or cleared; pending items can be cancelled (bulk cancellation requires explicit confirmation).
Items already being processed are protected from deletion. Long posts save a checkpoint after every
successful Bluesky thread chunk and resume from the first missing chunk after a crash or retry.

Operational endpoints:

- `GET /healthz` and `GET /readyz` are minimal unauthenticated probes with no account identifiers.
- `GET /api/health/details` and `GET /api/metrics` require dashboard authentication.
- `GET /api/metrics/prometheus` is admin-only and available when `ENABLE_PROMETHEUS_METRICS=true`.
- `GET/POST /api/bluesky-accounts` manages posting identities (list/create); validate, rotate, and delete use `/api/bluesky-accounts/:id/*`.
- `POST /api/destinations` links an existing account with `bskyAccountId`, or validates `bskyIdentifier` + `bskyPassword` and saves them as a new managed account before linking.
- `PATCH /api/destinations/:id/bluesky-account` repoints a destination at another unlinked managed account, keeping its queue and mirror history.
- `POST /api/destinations/bulk/state`, `/api/destinations/bulk/folder`, and `/api/destinations/bulk/backfill` apply multi-destination actions (max 50).

Generic webhook notifications can be configured under Settings or with `bun run cli -- notifications`.
Webhooks support event filters, HMAC signatures, retry/backoff, HTTPS enforcement, and private-network
blocking. The URL and signing secret are never returned by the settings API. Selectable events:
`twitter-auth-failure`, `bsky-auth-failure`, `queue-parked`, `queue-age` (off by default; threshold
`QUEUE_AGE_ALERT_MS`), and `update-failure`.

Tuning (optional `.env` values, sensible defaults built in):

| Variable | Default | Meaning |
|---|---|---|
| `SCRAPER_MIN_GAP_MS` / `SCRAPER_JITTER_MS` | `800` / `400` | Global minimum gap (+ random jitter) between Twitter API calls. The one knob that controls scraper-account risk. |
| `FETCH_CONCURRENCY` | `4` | Parallel timeline fetches during a sweep (rate still bounded by the gap above). |
| `POST_WORKER_CONCURRENCY` | `5` | How many Bluesky accounts post from the queue at once. |
| `POST_PACING_MIN_MS` / `POST_PACING_MAX_MS` | `3000` / `8000` | Pause between posts within one account (cosmetic pacing; per-account only). |
| `QUEUE_MAX_ATTEMPTS` | `8` | Retries (with exponential backoff) before a tweet is parked as failed. |
| `SWEEP_FETCH_TIMEOUT_MS` | `180000` | Watchdog for a single account's timeline fetch. |

Upgrading from an older version needs no manual steps: the queue table is created automatically on first boot and existing history is untouched (Docker users keep the same `data` volume; source installs just run `./update.sh`).

## CLI Quick Commands

Always run CLI commands as:

```bash
bun run cli -- <command>
```

Common commands:

```bash
bun run cli -- status
bun run cli -- list
bun run cli -- run-now
bun run cli -- run-now --dry-run
bun run cli -- add-mapping
bun run cli -- backfill <mapping-id-or-handle> --limit 50
bun run cli -- queue-list --destination <destination-id>
bun run cli -- queue-item <destination-storage-key> <tweet-id> --action retry
bun run cli -- queue-scope cancel-pending --route <route-id> --confirm-clear-pending
bun run cli -- notifications
```

## Updating

Source installs:

```bash
./update.sh
```

Useful flags:

```bash
./update.sh --no-restart
./update.sh --skip-install --skip-build
```

## Data and Security

Important files:

- `config.json` (mappings, credentials, users)
- `data/database.sqlite` (processed history)
- `data/.jwt-secret` (generated signing key when `JWT_SECRET` is unset)
- `.env` (runtime env values)

Security basics:

- First registered user becomes admin.
- Prefer Bluesky app passwords instead of your full Bluesky password.
- Set an explicit `JWT_SECRET` in `.env` for predictable secret management.
- Keep `config.json`, cookie values, and `.env` private.

## Webhook/API ingestion and digests

Admins can create canonical `webhook` or `api` sources, connect them to one or
more destinations, and create source-bound credentials. Tokens and optional
HMAC secrets are displayed once; only a token hash and an encrypted HMAC secret
are retained. Send normalized posts to `POST /api/ingest/v1/posts` with
`Authorization: Bearer ...` and a unique `Idempotency-Key`. HMAC credentials
also require `X-T2B-Timestamp`, `X-T2B-Nonce`, and `X-T2B-Signature`.

Inbound traffic must terminate HTTPS at a trusted reverse proxy. Set
`TRUST_PROXY=true` only when that proxy overwrites forwarding headers. Docker
and Portainer deployments should persist the data directory (SQLite contains
credentials, replay state, digest entries, and checkpoints) and provide the
same `CONFIG_ENCRYPTION_KEY` after every restart.

Routes independently select immediate or digest delivery. Digest routes have a
timezone/cadence, grouping template, and size limits; preview and manual
publish operations never remove entries. Failed digest jobs retry separately
from the immediate queue and resume from durable chunk checkpoints.

## Documentation

- [Architecture and current compatibility model](docs/architecture.md)
- [Configuration migration and schema](docs/config-v3-migration.md)
- [Aggregate destinations, profile policy, scheduler, sources, queue, notifications, ingestion, and digests](docs/operations.md)
- [AI, routing, moderation, and deduplication](docs/content-routing-and-ai.md)
- [X and Bluesky rate limits, and how the app stays inside them](docs/rate-limits.md)
- [Security, encryption, backup, and restore](docs/security-and-backups.md)
- [Development, release validation, upgrade, and rollback](docs/development-and-release.md)

Sections labeled **Future ideas** describe roadmap concepts only; all other behavior above is implemented
and covered by unit, integration, copied-volume release, or mocked browser tests.

## Development

```bash
bun install --frozen-lockfile
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

See `TROUBLESHOOTING.md`.

Common native module recovery:

```bash
bun run rebuild:native
bun run build
bun run start
```

## License

MIT
