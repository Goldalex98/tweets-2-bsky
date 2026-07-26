# Architecture

This document separates the architecture that exists today from the roadmap's target model. The target model is design direction, not a description of implemented APIs or configuration.

## Current architecture

### Runtime shape

The application is a single Bun process with explicit runtime services:

- `src/index.ts` is the application composition and CLI entry point. It wires X-rich transformation callbacks, persistence, runtime controls, and external adapters into services.
- `src/services/scheduler-service.ts` owns daemon command, startup, scheduled, deferred-sweep, pin, and backfill ordering. Clock, sleep, config, runtime commands, and work callbacks are injected.
- `src/services/queue-worker-service.ts` owns destination-locked durable queue claims, concurrency, active-destination safety, settlement, retry/parking metrics, and startup recovery.
- `src/services/digest-worker-service.ts` owns digest arming, restart recovery, destination locking, retry handoff, and checkpoint-resumed execution.
- `src/services/normalized-delivery-service.ts` owns source-neutral normalized post planning, media constraints, thread checkpoints, and finalization.
- `src/services/x-source-sweep-service.ts` owns adaptive X eligibility, canonical sweep execution, source runtime state, housekeeping, and queue-age alerts.
- `src/adapters/bluesky-*.ts` contain the Bluesky RichText/media network adapters used by digest and normalized delivery.
- `src/pipeline/source-sweep.ts` provides destination-independent source discovery and route fan-out.
- `src/server.ts` provides the Express API, authentication, operational controls, and static web serving.
- `web/` contains the React/Vite dashboard. A production build is served from `web/dist/`.

No runtime service imports `src/server.ts`; server-owned scheduler controls are injected by `src/index.ts`, preventing a composition/server import cycle. `src/config-manager.ts` owns schema-v7 JSON configuration, compatibility projection, atomic writes, encryption, and optimistic revision metadata. `src/config/` contains schemas, normalization, migrations, projection, transfer, and domain services. `src/pipeline/` contains fetch/run orchestration. `src/storage-paths.ts` resolves the data directory at module load. `src/db.ts` assembles SQLite-backed services and applies ordered migrations from `src/db/migrations/` (through migration 010 for Bluesky account runtime health).

### Identity model

The persisted canonical model is:

```text
Source -> Route -> Destination -> BlueskyAccount
```

Sources own ingestion/fetch policy, routes own relationship/content/delivery policy, and destinations own destination-wide posting/profile policy plus identity fields (`bskyIdentifier`, `bskyDid`, `storageKey`). Posting credentials live on a managed `BlueskyAccount` linked by `Destination.bskyAccountId` (at most one destination per account). `AccountMapping` remains a runtime/API compatibility projection and is omitted from persisted v7 JSON. A one-source mapping may resolve its sole source, but aggregate profile and pin policies require explicit source selections.

### Daemon data flow

```text
config.json
    |
    v
enabled sources/routes -> X fetch sweep -> post_queue (SQLite)
                                            |
                                            v
                         destination-locked post workers
                                            |
                                            v
                              Bluesky destination
                                            |
                                            v
                         processed_tweets (SQLite)
```

The scheduler service evaluates server commands independently from interval rescheduling: `run-now` requests a sweep, while `reschedule` only wakes the loop to adopt the new due time. Enabled startup runs and due scheduled runs defer behind backfills and resume after that queue drains. Fetching and posting are deliberately separate: the X sweep service discovers posts and writes durable queue rows, while queue workers claim rows and perform Bluesky-side work.

Immediate and digest workers share one active-destination lock set. This serializes all writes to a destination while allowing different destinations to run concurrently. Queue and processed-history keys are destination-scoped, which prevents the same source post from being posted twice to one destination while allowing deliberate posting to different destinations. Queue rows and delivery checkpoints survive restarts; in-flight queue and digest work is re-armed on startup. One-shot and history-import modes still use the same durable queue unless explicitly running a dry-run/legacy inline preview path.
Queue rows contain immutable policy and decision snapshots. Operators may explicitly re-evaluate non-processing rows with permission and confirmation; normal configuration edits never rewrite queued work.

### Text and profile behavior

Posting policy supports never, aggregate-only, and always attribution modes, validated templates, optional source links, root-only behavior, and an optional original-post link. Preview and delivery use the same transformer before grapheme-aware Bluesky text splitting.

Credential validation logs in and returns session metadata only. It does not write a Bluesky profile. Profile, bot-label, display-suffix, and pin paths require the mapping's master mutation gate plus their action-specific mode, flag, source, and fields. The Fediverse bridge is a separate confirmed follow/post action.

### Persistence and startup

The effective data directory is selected by `TWEETS2BSKY_DATA_DIR`, then `APP_DATA_DIR`, then the repository `data/` directory. In external-data-dir deployments, configuration is `data/config.json`; legacy source installs may still use root `config.json`.

Path selection happens during module evaluation, and importing `src/db.ts` opens and migrates the database immediately. Tests and tools must therefore set a temporary data directory before importing database-dependent modules.

Configuration saves are normalized and use a temporary file plus backup before rename. SQLite stores processed history, the durable queue, and per-account Bluesky auth health (`bluesky_account_runtime_state`). Both stores can contain operationally sensitive information and must be treated as private runtime data.

Every successful config write increments top-level `revision` and changes `updatedAt`. Dashboard mutations send the version they read. Stale destination, source, route, account, and settings edits fail with `409 CONFIG_REVISION_CONFLICT` and refresh guidance.

### Frontend boundaries

`web/src/api/client.ts` owns cookie/CSRF behavior, conflict types, and API error normalization. `web/src/components/ui/` contains keyboard-accessible primitives including focus-trapped dialogs. `DashboardApp.tsx` is the dashboard orchestrator; Settings includes a Bluesky accounts section for credentials. The destination editor is a six-section sheet (Overview, Sources & routes, Delivery, Moderation, Automation, Operations) with a read-only linked-account summary and deep links such as `/accounts?destinationId=…&section=moderation`. Feature extraction should continue incrementally instead of risking a behavior-changing rewrite.

## Current Source/Destination/Route architecture

Schema v7 separates concerns that were historically combined in `AccountMapping`:

```text
Source (X identity and source settings)
    |
    v
Route (source -> destination delivery and transform policy)
    |
    v
Destination (one Bluesky identity, storage key, and profile/posting policy)
    |
    v
BlueskyAccount (login identifier, app password, DID/handle)
```

### Source

A Source represents one normalized X, webhook, or API identity and its source-specific fetch/filter settings. It does not own Bluesky credentials or profile mutation policy.

### Destination

A Destination represents exactly one Bluesky identity and queue/history key. Credentials are resolved from the linked `BlueskyAccount`. Credential validation remains read-only against Bluesky.

A destination may be repointed at a different managed account with `PATCH /api/destinations/:id/bluesky-account`. The target account must not already be linked elsewhere, identity fields are copied from the account, any legacy inline password is dropped, and `storageKey` is deliberately left untouched so queue and processed-history rows stay with the destination: the newly linked account receives future posts only. Destination creation (`POST /api/destinations`) accepts either `bskyAccountId` for an existing unlinked account or `bskyIdentifier` + `bskyPassword`, which is validated and saved as a new managed account before linking. Destinations are therefore never created with an unmanaged inline credential.

### Route

A Route connects one Source to one Destination and holds relationship-specific controls such as enabled state, routing, moderation, duplicate suppression, and immediate/digest delivery. Multiple routes feed an aggregate destination without duplicating destination credentials.

### Compatibility constraints

1. Each legacy mapping remains one destination identity.
2. Normalized legacy usernames project to canonical source/route records without changing effective posting behavior.
3. Destination-scoped queue/history identity is stable across handle changes.
4. Credentials never enter route/source records or normal API responses.
5. Profile mutations remain explicitly gated.
6. Migrations stay versioned, idempotent, rollback-backed, and tested with temporary copied volumes.

## Future ideas

Distributed scheduler leadership, arbitrary route expressions, automatic secret escrow, external
moderation-list synchronization, and removal of the compatibility `AccountMapping` projection are
not implemented in the current release.
