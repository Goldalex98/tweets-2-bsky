# Security, encryption, backups, and restore

## Browser and API authentication

The dashboard uses an `HttpOnly`, `SameSite=Lax` session cookie. HTTPS requests also receive the
`Secure` flag. Mutating cookie-authenticated requests require the matching `t2b_csrf` cookie value
in `X-CSRF-Token`; the React client adds this automatically. CLI and automation clients can keep
using `Authorization: Bearer <token>` and do not use CSRF protection.

`JWT_SECRET` must be at least 32 characters. A shorter value warns in development and is rejected at
startup when `NODE_ENV=production`, because a guessable signing key lets an attacker mint sessions
for any account. When `JWT_SECRET` is unset, a 96-character secret is generated once and persisted
in the data directory as `.jwt-secret`; losing that file signs every existing session out.

Set `TRUST_PROXY=true` only when the application is behind a trusted proxy which removes and
recreates forwarding headers. Configure `CORS_ALLOWED_ORIGINS` explicitly for credentialed
cross-origin dashboard access. With no origin list, cross-origin browser access is disabled.

Password changes, admin password resets, and role/permission changes increment the user's token
version and immediately invalidate previously issued sessions and bearer tokens.

Destructive admin dashboard actions also require **step-up authentication**: the caller must supply
the current admin password (`password` body field or `x-reauth-password`) and a typed confirmation
string (`confirmation` body field or `x-destructive-confirmation`). The confirmation tokens are:

| Action | Confirmation |
|--------|--------------|
| Delete all Bluesky posts for a destination | `DELETE_ALL_POSTS` |
| Run in-app service update | `RUN_UPDATE` |
| Import configuration | `IMPORT_CONFIG` |
| Reset another user's password | `RESET_USER_PASSWORD` |
| Clear all queued backfills | `CLEAR_ALL_BACKFILLS` |
| Full config export / full backup create & restore | existing `EXPORT_WITH_SECRETS` / backup confirmations |

Bulk destination backfill additionally requires the `queueBackfills` permission (admins always pass)
and rejects unknown destination ids with HTTP 404 instead of treating them as managed.

Signing out does the same: `POST /api/logout` clears the browser cookies **and** increments the token
version, so it is an all-sessions logout. Every other browser session and every bearer token issued
for that account stops working, because clearing a cookie cannot retire a token an attacker already
captured. The response reports this in `allSessionsRevoked`; when it is `false` the cookie was
cleared but the token version could not be persisted, and the logout should be retried.

Tokens identify their subject by account id. A token whose account has been deleted is rejected even
if a new account later reuses the same username or email. Tokens issued before subject-bound claims
existed still work, and each acceptance is logged as `legacy-session-token-accepted` with a hashed
identifier so operators can see who still needs to re-authenticate.

New passwords (bootstrap register, change-password, and admin reset) must be at least 12 characters.
Existing shorter password hashes continue to work until the user sets a new password.

Login and register share an in-process rate limit (10 attempts per 15 minutes per client address).
Each process has its own counter; put a reverse-proxy limit in front when running multiple replicas.

## Configuration concurrency

Configuration writes are compare-and-swap: the persisted revision must still match the one the
caller read, and revisions only ever increase. A conflicting write is rejected with HTTP 409 and the
current `revision`/`updatedAt`, and the client re-reads before retrying. Whole-document replacements
(config import and restore apply) must name the revision they replace and return HTTP 428 if it is
missing.

## Encrypting configuration secrets

`CONFIG_ENCRYPTION_KEY` optionally encrypts X cookies, managed Bluesky account passwords at
`blueskyAccounts[].appPassword`, legacy destination passwords if present, AI keys, notification
URLs/secrets, and future token-shaped fields before `config.json` is written. Values use
AES-256-GCM with a unique 96-bit nonce and field-path authenticated data.

When `NODE_ENV=production`, the key is **required**: the process refuses to start (and refuses to
persist plaintext secrets) if `CONFIG_ENCRYPTION_KEY` is unset. Migrate an existing plaintext
deployment before enabling production fail-closed: backup the volume, run
`encryption-migrate --confirm ENCRYPT_CONFIG`, verify with `encryption-status`, then deploy the
fail-closed build with the same key.

The key must be exactly 32 bytes, encoded as either 64 hexadecimal characters or standard base64:

```bash
openssl rand -hex 32
```

Outside production, plaintext configuration remains compatible when the key is absent, but the
application prints an admin warning. If encrypted data exists and the key is missing, wrong, or the
ciphertext was modified, startup fails closed and does not rewrite the configuration with defaults.

Migration and rotation cover both stores that hold secrets: the configuration document and the
ingestion HMAC secrets in SQLite. They always create a timestamped backup, re-encrypt both under the
new key, read each value back and verify it decrypts to the original, and only then commit. If any
step fails, the SQLite transaction rolls back and the previous configuration is restored, so the two
stores are never left on different keys:

```bash
bun run cli -- encryption-status
bun run cli -- encryption-migrate --confirm ENCRYPT_CONFIG
OLD_CONFIG_KEY='old-value' NEW_CONFIG_KEY='new-value' \
  bun run cli -- encryption-rotate --old-key-env OLD_CONFIG_KEY \
  --new-key-env NEW_CONFIG_KEY --confirm ROTATE_CONFIG_KEY
```

After rotation, update the deployment environment before restarting. Keep the key in a password
manager independent of the Docker volume. Key loss is not recoverable cryptographically: stop the
service, restore a pre-encryption backup or provide the original key, and only then start it.

## Backups

Backups are JSON bundles with a `.t2b-backup` extension. They contain `config.json`, a
WAL-consistent SQLite snapshot made with `VACUUM INTO`, and `metadata.json`. Every entry has a byte
count and SHA-256 checksum.

- Redacted mode omits users and credentials. Restoring it preserves the deployment's current users
  and matching secrets.
- Full mode includes users and credentials. The browser requires typed confirmation plus the
  current admin password. If config encryption is enabled, its config entry remains encrypted.

```bash
bun run cli -- backup safe.t2b-backup
bun run cli -- backup full.t2b-backup --mode full --confirm-full-backup
```

Protect full bundles like production credentials. HTTP backup, restore, metrics, notification, and
secret endpoints use `Cache-Control: no-store`.

On Linux and macOS, `config.json`, the temporary files used for its atomic writes, migration
backups, and backup artifacts are created with mode `0o600` and the backup directory with `0o700`.
Windows has no equivalent POSIX mode, so the enforcement is skipped there and never fails a write.

## Restore

Restore validation checks total and entry sizes, the fixed allowlist of archive paths, duplicate or
traversal-style names, checksums, JSON structure, config/database schema versions, encryption
requirements, and the SQLite header before writing active state.

CLI restore is dry-run by default:

```bash
bun run cli -- restore backup.t2b-backup
bun run cli -- restore backup.t2b-backup --apply --confirm RESTORE
```

Apply creates a full pre-restore bundle, atomically replaces the normalized config, and stages the
SQLite database as `database.restore-pending.sqlite`. Until the process restarts, the dashboard
reports **Restart required**, `/readyz` is not ready, mutating `/api/*` requests return HTTP 503
`RESTART_REQUIRED`, and the scheduler/queue workers skip delivery so new config cannot run against
the old database. Restart the service to swap the database before SQLite opens; the prior database
is retained as a timestamped `.bak`. Never copy `database.sqlite` over a running WAL database
manually.

On Windows, a locked database handle can prevent the pending rename. Stop every tweets-2-bsky
process, remove leftover `database.restore-pending.sqlite*` temporary files if a failed attempt left
them behind, then restart so the staged file can replace `database.sqlite`. If rename still fails,
manually rename the pending file over `database.sqlite` while the service is stopped.

The document written by a restore is the validated and migrated one, not the raw bundle contents, and
the bundle metadata is re-checked immediately before anything is applied.

A restore also revokes credentials the bundle carried, because a backup contains whatever was valid
when it was taken, including credentials revoked afterwards:

- Every ingestion credential in the staged database is marked revoked and stored replay nonces are
  cleared. Mint new ingestion tokens after the restart; the restore report gives the revoked count.
- Every user's token version is incremented, so sessions and bearer tokens issued before the restore
  are rejected and all users must sign in again.

## Outbound request protection

Operations webhooks, normalized media downloads, link-card fetches, and t.co-style URL expansion
must use HTTPS, may not carry credentials in the URL, and are refused when the hostname is
`.local` / `.localhost` or resolves into a private, loopback, link-local, or multicast range unless
private webhook targets are explicitly allowed. The request is then made against the exact address
that passed validation, with the original hostname kept for the `Host` header and TLS SNI, so a DNS
answer that changes between validation and connection cannot redirect the request. Webhook and
media downloads never follow redirects; link-card and URL-expansion helpers re-validate each
`Location` hop before following it.
