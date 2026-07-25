# tweets-2-bsky

A powerful tool to crosspost Tweets to Bluesky, supporting threads, videos, and high-quality images.

## Troubleshooting

### Update Failures / Git Conflicts
If `./update.sh` fails with "Pulling is not possible because you have unmerged files" or similar git errors:

1. Reset your local repository to match the remote (Warning: this discards local changes to tracked files):
   ```bash
   git reset --hard origin/master
   ```
2. Run the update script again:
   ```bash
   ./update.sh
   ```

### PM2 interpreter mismatch
If PM2 logs show command/runtime errors after an update (for example stale interpreter paths):

Common error signature:

```text
TypeError: require() async module ".../dist/index.js" is unsupported. use "await import()" instead.
```

1. Run the repair script:
   ```bash
   chmod +x repair_pm2.sh
   ./repair_pm2.sh
   ```
2. If needed, manually recreate PM2 with Bun as the process command:
   ```bash
   pm2 delete tweets-2-bsky || true
   pm2 delete twitter-mirror || true
   pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
   pm2 save
   ```
3. Old crash lines remain in PM2 logs until log rotation/flush. Clear them if needed:
   ```bash
   pm2 flush
   ```

### `bun: command not found`
If Bun is missing on a source install host:

1. Run either installer/updater once (they auto-install and auto-upgrade Bun to latest stable):
   ```bash
   ./install.sh --no-start
   # or
   ./update.sh --no-restart
   ```

On Windows, Bun is often already installed under `%USERPROFILE%\.bun\bin` and listed in the user `Path`, but Cursor/agent shells started before that install (or with a stale process environment) will not see it. Fix the current shell, then restart Cursor if new terminals still fail:

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;" + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
bun --version
```

### Native module load failure (`ERR_DLOPEN_FAILED`)
If startup fails while loading native dependencies:

1. Reinstall/rebuild native dependencies with Bun:
   ```bash
   bun run rebuild:native
   ```
2. Rebuild and start:
   ```bash
   bun run build
   bun run start
   ```

### Dashboard appears unstyled / plain text UI
If the app loads but looks mostly unstyled:

1. Rebuild web assets:
   ```bash
   bun run build
   ```
2. Restart server:
   ```bash
   bun run start
   ```
3. Hard refresh browser cache (`Cmd+Shift+R` on macOS).

### CLI command not recognized
When using Bun scripts, pass CLI args after `--`:

```bash
bun run cli -- status
```

### Dashboard says configuration changed

Destination, source, route, scheduler, notification, X-cookie, and AI forms use
optimistic `revision`/`updatedAt` tokens. A `409 CONFIG_REVISION_CONFLICT` means
another tab, CLI process, or administrator saved newer configuration. Keep any
text you need, refresh the dashboard, review the newer values, and reapply the
change. The stale request was rejected and did not overwrite the newer config.

### Scheduler appears stuck on one account
If a single source account hangs for a long time (media fetch/processing), scheduled checks now skip that account after a timeout and continue with the next one.

- Default timeout: `1200000` ms (20 minutes) for scheduled checks, `900000` ms (15 minutes) per account for backfills
- Override with env vars: `SCHEDULED_ACCOUNT_TIMEOUT_MS` / `BACKFILL_ACCOUNT_TIMEOUT_MS`
- Note: the pipeline intentionally paces 5–15s between posts, so don't set these too low — a 15-tweet backfill normally takes a few minutes. A watchdog that fires while an account is still posting abandons that run, and the next cycle can overlap it.
- The Docker image ships the defaults above and no longer overrides them.

Examples:

```bash
# Docker
docker run -d --name tweets-2-bsky -e SCHEDULED_ACCOUNT_TIMEOUT_MS=900000 -p 3000:3000 -v tweets2bsky_data:/app/data j4ckxyz/tweets-2-bsky:latest

# Source install (.env)
echo 'SCHEDULED_ACCOUNT_TIMEOUT_MS=900000' >> .env
./update.sh
```

To watch logs while debugging on Raspberry Pi:

```bash
docker logs -f tweets-2-bsky
# or for source/PM2
pm2 logs tweets-2-bsky
```

### Queue failures and partial threads

Open Activity to inspect queue age, normalized failure category, policy behavior, and redacted diagnostics.
Retry only the failed item or its route/source/destination/request scope. Pending bulk cancellation requires
explicit confirmation, and active processing rows cannot be deleted. Successfully posted thread chunks are
checkpointed; a retry resumes at the first missing chunk.

Useful probes:

```bash
curl -f http://127.0.0.1:3000/healthz
curl -f http://127.0.0.1:3000/readyz
bun run cli -- queue-list
```

Detailed health and metrics require dashboard authentication. Public probes intentionally contain no source,
destination, cookie, or webhook identifiers. Cookie diagnostics report only configured/active/last-success/
last-auth-failure state, never cookie values.

### Docker: permissions writing `/app/data`
If the container fails to write `config.json` or `database.sqlite`, ensure `/app/data` is writable by the container process.

For easiest portability, use a named Docker volume:

```bash
docker volume create tweets2bsky_data
docker run -d --name tweets-2-bsky -p 3000:3000 -v tweets2bsky_data:/app/data ghcr.io/j4ckxyz/tweets-2-bsky:latest
```

The container stores persistent state under `TWEETS2BSKY_DATA_DIR` (default `/app/data`). If you mount a different path, set that env var to match:

```bash
docker run -d --name tweets-2-bsky -p 3000:3000 -v /host/path:/persist -e TWEETS2BSKY_DATA_DIR=/persist ghcr.io/j4ckxyz/tweets-2-bsky:latest
```

### Inbound API returns 400/401/409

- `401`: the one-time token is incorrect, expired, rotated, or revoked.
- `400`: normalized content or URL/media metadata exceeded a limit, or an HMAC
  timestamp/signature was invalid. Sign the exact raw JSON bytes sent.
- `409`: the nonce was replayed, or the idempotency key/external post identity
  was already used with different input.

For HMAC credentials, `CONFIG_ENCRYPTION_KEY` must remain identical across
restarts. Never log Authorization/signature headers. If production requests
are rejected as insecure, terminate TLS at the proxy and enable `TRUST_PROXY`
only after configuring it to overwrite `X-Forwarded-*` headers.

### Digest job is failed or appears stuck

Use the dashboard/API or `bun run cli -- digest-list` to inspect the sanitized
failure. Retry failed jobs explicitly. Restart recovery re-arms processing jobs
and preserves entries; do not delete `database.sqlite`, its WAL, or its SHM
file while the process is running.

### Playwright browser is missing

The E2E suite uses only mocked integrations but still needs a local Chromium:

```bash
bun install --frozen-lockfile
bun run playwright:install
bun run test:e2e
```

CI uses `playwright install chromium --with-deps`. Browser traces and
screenshots appear only after failures under ignored test artifact paths.

### Docker: updating image
In Docker mode, update by pulling a newer image and recreating the container with the same volume.
`/api/update` / `update.sh` are source-install workflows.
