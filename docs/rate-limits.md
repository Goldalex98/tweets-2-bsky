# Platform rate limits

How this app stays inside X and Bluesky limits, and what to change when you scale up.

## Bluesky (AT Protocol)

Published limits for the Bluesky-hosted PDS (`bsky.social`). Self-hosted PDS operators set their own.

| Limit | Value | Scope |
| --- | --- | --- |
| Write operations | 5,000 points/hour, 35,000 points/day | Per account (DID) |
| Cost of one post | 3 points (create) | Per record |
| Effective post ceiling | ~1,666/hour, ~11,666/day | Per account |
| All HTTP API requests | 3,000 per 5 minutes | **Per IP** |
| `com.atproto.server.createSession` | 30 per 5 min, 300 per day | Per account |
| `com.atproto.identity.updateHandle` | 10 per 5 min, 50 per day | Per account |
| Blob upload size | 50 MB | Per blob |

Two of these matter at 20-30 destinations:

- **The 3,000-per-5-minutes cap is per IP, not per account.** Every destination shares your server's
  IP, so the per-account write budget is never the binding constraint — the IP budget is. Posting a
  thread costs one `uploadBlob` per image plus one `createRecord` per chunk, so a burst across many
  destinations at once is what gets close to the ceiling. `POST_WORKER_CONCURRENCY` (default 5) and
  `POST_PACING_MIN_MS`/`POST_PACING_MAX_MS` bound that burst.
- **`createSession` is capped per account per day.** The app caches one authenticated agent per
  destination for the process lifetime and lets `@atproto/api` refresh the session, so steady-state
  operation costs one session per destination per restart. A crash loop is the realistic way to
  exhaust this: 300 restarts in a day would lock out logins for every destination. Watch container
  restart counts, not post volume.

Cached agents are dropped automatically when the PDS rejects the session (`bsky-auth`), so a rotated
app password recovers on the next attempt rather than requiring a restart.

## X (Twitter)

X publishes no limits for the web/frontend endpoints this app reads through
`@the-convocation/twitter-scraper`. The limits are dynamic and change without notice. Observed
behaviour that shapes the defaults:

- Authenticated session cookies are far more permissive than guest tokens, but any account used for
  automated reads can be suspended at any time. This is inherent to the approach, not a bug.
- Datacenter IPs are flagged quickly and aggressively. If you run this on a VPS and see failures that
  look nothing like rate limiting, the IP is the likely cause.
- **Retrying through a 429 is what escalates throttling into suspension.** Hitting a limit and backing
  off cleanly is treated as a throttle; ignoring the response code is treated as abuse.

### How the app protects the scraping account

All X requests — timeline sweeps, thread lookups, media and pinned-tweet fetches — pass through a
single process-wide governor (`src/x-rate-limit.ts`):

1. **Spacing.** `SCRAPER_MIN_GAP_MS` plus up to `SCRAPER_JITTER_MS` of jitter between requests, so
   traffic is neither bursty nor metronomic.
2. **A sustained ceiling.** At most `SCRAPER_MAX_REQUESTS_PER_WINDOW` requests per `SCRAPER_WINDOW_MS`.
   Spacing alone only bounds the burst rate; without a window budget a backfill of many accounts can
   run hot for hours. The default (150 per 15 minutes) matches the window shape X measures over.
3. **A global cooldown on 429.** When X reports a limit, *every* X request pauses — not just the one
   that saw it. The pause uses the `x-rate-limit-reset` header when X sends one, otherwise it backs
   off 30s, 60s, 120s, … capped at `SCRAPER_COOLDOWN_MAX_MS`.
4. **No credential switching on 429.** Rotating to the backup cookie slot during a rate limit just
   spends the second account's budget from the same IP. Credentials are only switched when X rejects
   them outright (401/403).
5. **A per-sweep source cap.** `SCHEDULER_MAX_SOURCES_PER_SWEEP` (default 25) bounds how many source
   accounts are fetched in one pass; the rest roll into the next sweep, ordered by how overdue they
   are, so no source starves.

### Sizing for 20-30 source accounts

With 30 sources on the default 15-minute interval, a sweep costs roughly 30 timeline requests plus
thread and media lookups for whatever is new — comfortably inside the 150-per-15-minute budget. The
defaults need no change at this scale.

Adaptive scheduling widens the interval for quiet accounts, so real request volume is usually well
below the worst case. Raise `SCRAPER_MAX_REQUESTS_PER_WINDOW` only if you see sources being deferred
for `budget` reasons in sweep logs while X reports no limits. If you add accounts well beyond 30,
raise the polling interval before raising the request budget.

Backfills are the one operation that can saturate the budget: importing history for many accounts at
once will be throttled to the window ceiling. That is intended — it slows the import instead of
risking the account. Stagger large backfills.

### Keeping the scraper working

X rotates the GraphQL query IDs and feature flags the scraper depends on. When they change, fetches
fail with 404s or parse errors that are not rate limiting. The fix is upgrading
`@the-convocation/twitter-scraper`, which tracks these changes; pinning an old version is the most
common cause of a mirror that silently stops finding posts. Check the package's releases before
assuming an account problem.
