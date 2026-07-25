# Operations and dashboard guide

This document describes implemented behavior in schema v6. Items under **Future ideas** are not available in the current release.

## Destinations, aggregate sources, and routes

A destination is one Bluesky identity. A route connects one canonical X, webhook, or API source to that destination. One-to-one destinations default to no attribution; aggregate destinations default to source attribution when multiple sources are present. Adding a source never backfills automatically, and credential validation never changes a profile.

Dashboard destination, source, route, and settings edits carry the `revision` and `updatedAt` last read from the API. A stale edit returns `409 CONFIG_REVISION_CONFLICT`; refresh, review the newer values, and reapply the change. The server never merges a stale form over newer configuration.

Bulk X input accepts commas, whitespace, and newlines, normalizes `@name`, and reports invalid or duplicate entries. Source removal preserves history and pending work unless the operator explicitly selects a destructive option.

## Posting, profile, and content policy

Posting attribution is `never`, `multiple-sources`, or `always`. Preview uses the same transformer as delivery. Existing queue entries retain their policy snapshot; changing a policy does not silently rewrite queued work.

Profile mutations require both `allowProfileMutation` and the specific profile, label, suffix, or pin policy. Preview and credential validation are read-only. Aggregate destinations do not infer a profile source.

Routing filters run before moderation and duplicate suppression. Destination and route moderation support keywords, domains, source blocks, sensitive-content behavior, and dry-run traces. AI image alt text and each text capability are independent opt-ins; previews disclose what is sent.

## Scheduler, adaptive polling, and rate limits

The scheduler can be enabled, disabled, or rescheduled without triggering an immediate run. `runOnStartup` is independent. Source schedules inherit, use a fixed interval, or adapt between configured bounds.

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

## Security and encryption status

Browser sessions use `HttpOnly` cookies and CSRF tokens. CLI automation may use bearer authentication. Stored X cookies, Bluesky app passwords, provider keys, webhook secrets, ingestion secrets, and JWT material are never returned by normal settings APIs.

`CONFIG_ENCRYPTION_KEY` enables AES-256-GCM protected configuration fields. Keep the same key across restarts and copied-volume validation. See [security and backups](security-and-backups.md).

## Backup and restore

Redacted backups preserve the current deployment's users and credentials during restore. Full backups contain encrypted credentials and require current-admin reauthentication plus typed confirmation. Validation is dry-run and no-write. Restore stages SQLite for startup replacement and retains pre-restore rollback artifacts.

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
