# Operations and dashboard guide

This document describes implemented behavior in schema v8. Items under **Future ideas** are not available in the current release.

## Destinations, aggregate sources, and routes

A destination is one Bluesky identity linked to a managed Bluesky account for posting credentials. A route connects one canonical X, webhook, or API source to that destination. One-to-one destinations default to no attribution; aggregate destinations default to source attribution when multiple sources are present. The default first-scan policy is **Start with new posts only**: the first successful fetch records a route baseline and queues nothing. Operators may change the global default or override a new route with **Import recent existing posts**. Credential validation never changes a profile.

App passwords are managed only under Settings → Bluesky accounts. The destination editor's Overview tab shows a read-only linked-account card (handle, DID, service URL, credential status, health) and never accepts or displays a password.

The same card can repoint the destination at another managed account. Choose an account under **Posting account** and confirm; only accounts that are not linked to another destination are offered. Switching keeps the destination's queue and processed history, so already-mirrored posts are never delivered again and the newly linked account receives future posts only. Use this to move a destination onto a replacement identity, or to adopt a legacy inline-credential destination into a managed account.

The create-destination wizard's Bluesky step offers the same choice: link an existing unlinked account, or enter credentials once. New credentials are validated and saved as a managed account under Settings → Bluesky accounts before the destination is linked, so the wizard never leaves an unmanaged inline password behind. If the entered credentials match an account that already exists, the request returns `409 ACCOUNT_EXISTS` with the account id so the existing account can be selected instead.

Dashboard destination, source, route, account, and settings edits carry the `revision` and `updatedAt` last read from the API. A stale edit returns `409 CONFIG_REVISION_CONFLICT`; refresh, review the newer values, and reapply the change. The server never merges a stale form over newer configuration.

Bulk X input accepts commas, whitespace, and newlines, normalizes `@name`, and reports invalid or duplicate entries. The selected initial-import mode applies to each route created by that add operation. Changing it after initialization does not import history; use Backfill for older posts. Source removal preserves history and pending work unless the operator explicitly selects a destructive option.

## Managed Bluesky accounts

Settings → Bluesky accounts owns posting identities (`loginIdentifier`, `appPassword`, DID/handle). Create, validate, rotate, and delete through the dashboard or `/api/bluesky-accounts`. Validation authenticates read-only against Bluesky and never updates a profile, label, pin, follow, or post.

Rotating an app password updates the encrypted account secret, evicts the cached Bluesky agent for that credential, and lets in-flight posts retry with the new password on the next attempt. After rotation, re-validate from Settings if posting fails with an auth error.

Deleting an account that is still linked to a destination returns `409` — reassign that destination to another account (destination editor → Overview → Posting account) or delete the destination first.

## Bulk destination actions

From the destinations list, select up to 50 destinations and apply pause/resume (`/api/destinations/bulk/state`), folder moves (`/api/destinations/bulk/folder`), or backfill (`/api/destinations/bulk/backfill`). Backfill requires typing `BACKFILL <n>` where `<n>` is the selected count. Bulk mutations use the same config revision OCC as single edits.

## Posting, profile, and content policy

Posting attribution is `never`, `multiple-sources`, or `always`. Preview uses the same transformer as delivery. Existing queue entries retain their policy snapshot; changing a policy does not silently rewrite queued work.

X polls are not Bluesky polls: the mirror appends a text note with choices and the original X link, and attaches an external URL card when the post has no other embed. Quote, video, and repost-wrapper fallbacks are recorded in `delivery_diagnostics` on queue/history rows and shown in the Activity dashboard. Reposts retain the wrapper status identity and always keep an X status link; when nested original content is unavailable, wrapper text is retained instead of silently dropping the repost.

Quoted X posts use the most native representation available. A quoted status already mirrored anywhere by this installation is embedded as its Bluesky record, including across destinations. Otherwise, when the quote is the only embed, the scraper's retained quoted-post author, complete text, canonical X URL, and safe thumbnail produce an external card without a secondary X fetch. Open Graph metadata, a screenshot, and finally a plain `QT:` link are attempted in that order when richer data is unavailable. Existing published records are not rewritten automatically.

Profile mutations require both `allowProfileMutation` and the specific profile, label, suffix, or pin policy. Preview and credential validation are read-only. Aggregate destinations do not infer a profile source.

Routing filters run before moderation and duplicate suppression. Destination and route moderation support keywords, domains, source blocks, sensitive-content behavior, and dry-run traces. AI image alt text and each text capability are independent opt-ins; previews disclose what is sent.

## Scheduler, adaptive polling, and rate limits

The scheduler can be enabled, disabled, or rescheduled without triggering an immediate run. `runOnStartup` is independent. Source schedules inherit, use a fixed interval, or adapt between configured bounds. Configure a source under **Destinations → Edit → Sources & routes → X source polling**, or manage all canonical sources under **Settings → Scheduler → Per-source polling**. The latter also shows each source's last check, last successful fetch, last observed post, next eligible check, backoff failures, and latest error.

The global interval is the scheduler wake frequency. A source cannot achieve a one-minute minimum while the global scheduler wakes every five minutes. For a small set of breaking-news sources, use a one-minute global interval with adaptive `1–15` source policies; quiet sources back off automatically. Settings shows the resulting worst-case timeline-check estimate and the effective read-only X request guardrails. Low-level request budgets, spacing, cooldowns, and concurrency remain environment controls and require a restart.

Relevant environment controls:

```dotenv
SCRAPER_MIN_GAP_MS=800
SCRAPER_JITTER_MS=400
SCRAPER_MAX_REQUESTS_PER_WINDOW=150
SCRAPER_WINDOW_MS=900000
SCRAPER_COOLDOWN_BASE_MS=30000
SCRAPER_COOLDOWN_MAX_MS=900000
SCHEDULER_MAX_SOURCES_PER_SWEEP=25
FETCH_CONCURRENCY=4
POST_WORKER_CONCURRENCY=5
QUEUE_MAX_ATTEMPTS=8
SWEEP_FETCH_TIMEOUT_MS=180000
```

See [platform rate limits](rate-limits.md) for what these defaults are sized against and how to tune them for your account count.

## Queue, checkpoints, and health

Discovery writes durable SQLite queue entries before Bluesky delivery. Thread checkpoints resume at the first missing chunk after restart. Pending items can be cancelled, failed items retried or cleared, and processing items are immutable.

`GET /healthz` and `GET /readyz` are redacted public probes. Authenticated `/api/health/details` includes queue, scheduler, source, destination, cookie-slot, and digest state without secret values. Admin metrics are available at `/api/metrics`; Prometheus output requires `ENABLE_PROMETHEUS_METRICS=true`.

## Notifications

Operations webhooks support selected events, timeout, retry, exponential backoff, optional HMAC signing, and private-address blocking. The settings API returns only configured/not-configured flags. A test notification is queued asynchronously.

Selectable events (dashboard toggles or CLI):

- `twitter-auth-failure` — X cookie/scraper authentication failed
- `bsky-auth-failure` — Bluesky destination login failed
- `queue-parked` — a queue item exhausted retries and was parked
- `queue-age` — oldest pending item exceeded `QUEUE_AGE_ALERT_MS` (default off)
- `update-failure` — in-app update process failed

## Security and encryption status

Browser sessions use `HttpOnly` cookies and CSRF tokens. CLI automation may use bearer authentication. Stored X cookies, managed Bluesky `appPassword` values, provider keys, webhook secrets, ingestion secrets, and JWT material are never returned by normal settings APIs.

`CONFIG_ENCRYPTION_KEY` enables AES-256-GCM protected configuration fields. When `NODE_ENV=production`,
the key is required at startup. Keep the same key across restarts and copied-volume validation. See
[security and backups](security-and-backups.md).

## Backup and restore

Redacted backups preserve the current deployment's users and credentials during restore. Full backups contain encrypted credentials and require current-admin reauthentication plus typed confirmation. Validation is dry-run and no-write. Restore stages SQLite for startup replacement, enters restart-required mode (mutating APIs blocked, `/readyz` not ready) until restart, and retains pre-restore rollback artifacts. On Windows, stop the service before retrying if pending-database rename fails because the file is locked.

Destructive dashboard operations (service update, config import, delete-all-posts, admin password reset, clear-all backfills) require the same style of current-admin password reauthentication and a typed confirmation token. See [security and backups](security-and-backups.md).

## Webhook/API ingestion

Create a `webhook` or `api` source, connect routes, then create a source-bound credential. The token and optional HMAC secret are shown once.

```bash
curl -X POST https://tweets.example.com/api/ingest/v1/posts \
  -H "Authorization: Bearer <one-time-secret>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: source-42-post-1001" \
  --data '{
    "sourceId": "00000000-0000-4000-8000-000000000001",
    "sourceType": "api",
    "externalId": "post-1001",
    "author": {"id": "author-42", "username": "example"},
    "text": "Sanitized release example",
    "createdAt": "2026-07-24T20:00:00.000Z",
    "urls": ["https://example.invalid/article"],
    "media": []
  }'
```

Production ingestion requires HTTPS unless the explicit development override is enabled. HMAC signing covers `timestamp.nonce.raw-body`; nonces and idempotency keys are durable and replay-safe. Audit records hash network and idempotency identifiers and retain route decision traces.

## Digests

Route delivery is immediate or digest. Digest policy defines cadence, timezone, grouping, template, limits, and attribution. Preview does not consume entries. Manual publish only makes a durable job eligible; retry and cancellation are explicit, and chunk checkpoints survive restart.

## Future ideas

The current release does not provide distributed scheduler leadership, arbitrary route expressions,
automatic secret escrow, external moderation-list synchronization, or removal of the compatibility
`AccountMapping` projection. These are roadmap ideas, not documented behavior.
