# Phased maintenance, upgrade, and deployment plan

Updated: 2026-09-13

Status: execution authorized and active. Track implementation and acceptance evidence in `docs/maintenance-upgrade-progress.md`; this plan alone is not evidence of completion.

This is the complete workspace version of the conversation plan. It supersedes the earlier per-phase releases, canary, approval checkpoints, and observation windows. Phases organize implementation work; they do not introduce pauses or separate deployments.

## 1. Objective, scope, and execution contract

Implement all included maintenance and dependency changes, integrate and build the complete application, then push the finished work to GitHub. Verify the resulting release, deploy its exact image through Docker/Portainer, test the actual deployment, and automatically repair and redeploy defects found.

Included:

- Security remediation across the complete resolved dependency graph.
- Thumbnail correctness, retry accounting, SQLite contention handling, cancellation, destination ownership, and graceful shutdown.
- Durable account suspension handling and ten-minute video support.
- Previously deferred runtime, native, CLI, compiler, release, browser, frontend, styling, and icon dependencies.
- Release safeguards, real-backend tests, published-image validation, and production smoke tests.

Excluded:

- AI implementation, SDK migration, model changes, prompts, AI settings, and AI-specific refactoring.
- Upstream account-page redesign and custom-domain handle/DNS migration tooling.
- Unrelated architecture rewrites or wholesale upstream merges.

Execution rules:

1. Complete all implementation phases before the initial integration push and production deployment. Local commits are encouraged; intermediate phase releases are not required.
2. Verification is automated execution, not a request for approval or a waiting period. A failed check immediately creates a repair task.
3. No per-phase approval pauses, canary pauses, fixed observation windows, or multi-hour soak requirements remain.
4. Short bounded waits for tests, readiness, shutdown, CI, and image publication are necessary execution steps, not discretionary pauses.
5. Corrective pushes and releases are allowed after CI or deployed tests find defects. Never rewrite published tags or history.
6. Preserve account/destination identity, destination storage keys, deterministic record keys, checkpoints, route baselines, credentials, and immutable queue policy snapshots.
7. Never run production-capable old/new instances concurrently against the same volume or destination. Do not restore old history automatically after new posts have been published.
8. Ask for input only for genuine missing access, an unavoidable conflict with the AI exclusion, or a destructive recovery not safely covered by the plan. Continue unaffected work meanwhile.
9. Read this saved plan as the execution source of truth. Do not silently omit a dependency group, convert a required test into an optional one, weaken assertions/security gates, or substitute a summary of work for implementation. Record any unavoidable scope conflict as incomplete and resolve it before claiming completion.
10. This document does not start a goal by itself. When the user starts execution, pursue implementation through verified production acceptance and the repair loop; do not stop at a local build, commit, GitHub Release, image publication, or deployment dispatch.

AI exclusion precision: preserve AI-specific implementation, prompts/defaults/settings, and direct AI SDK package/version and artifact integrity. Shared libraries (including Axios), necessary shared transitive security dependencies, compiler/framework/CSS tooling, and non-AI portions of mixed-purpose files may change under this plan. Document their impact and run existing mocked AI regressions without live calls. Do not freeze a vulnerable shared transitive dependency merely because the AI SDK also uses it, and do not edit AI-specific logic to accommodate an upgrade. If those requirements cannot both be met, keep the conflict incomplete rather than silently dropping remediation or crossing the exclusion.

## 2. Main-model orchestration and token-efficient subagents

The main model is the orchestrator. It decomposes work, assigns ownership, resolves cross-component decisions, integrates results, maintains the implementation ledger, runs consolidated verification, and exclusively controls Git, release, deployment, and the repair loop. Delegate substantial implementation and specialist investigation rather than reproducing workers' work in the main context.

Use at most three concurrent subagents alongside the orchestrator:

| Assignment | Responsibility and ownership |
| --- | --- |
| Dependency/release worker | Package manifest and lockfile, dependency compatibility, runtime/CI pins, release workflows, and image-validation harness. |
| Pipeline worker | Retry/cancellation/ownership/account gating/media implementation and its tests; exclusive ownership of shared pipeline/database files during that work. |
| UI/tooling worker or independent reviewer | Disjoint frontend/tooling implementation, then bounded review as capacity allows. |

Delegation rules:

- Start with minimal inherited history and a concise task brief containing paths, required behavior, invariants, exclusions, and acceptance tests. Do not fork the entire conversation into every worker.
- Reuse workers for related follow-ups. Pass artifact/file references and compact findings rather than repeated repository dumps.
- Assign exactly one owner to each shared file. In particular, only the dependency worker regenerates the manifest/lockfile; other workers submit dependency requirements to that owner.
- Serialize overlapping changes to `src/index.ts`, `src/db.ts`, migrations, or shared API types. Allow independent frontend and dependency research to proceed in parallel.
- Tell every worker it is not alone, must preserve others' edits, and must not stage, push, or deploy independently.
- Only the orchestrator stages and commits integrated work. Workers return file changes and test evidence; references to local commits in later phases describe orchestrator actions.
- Require concise handoffs: changed files/interfaces, tests and outcomes, unresolved findings, and integration dependencies. Return failure excerpts rather than full successful logs.
- Trust completed specialist exploration unless contradictory evidence appears. The orchestrator must not repeat the same searches merely to obtain its own copy.
- Use `pipeline_regression` for queue/cancellation/media/mutation-gate review, and `config_integrity` for account-state, migration, identity, and OCC review. Pair account/API work with the secrets-regression skill.
- Run focused tests during development. Run the full integrated gate after integration, then repeat broad checks only when repairs or further changes justify it.

At implementation time maintain `docs/maintenance-upgrade-progress.md` with phase status, ownership, selected versions, local commits, concise test results, release/image identifiers, and unresolved limitations. Never put secrets or full production data in the ledger.

The ledger must include every included phase/dependency group and required test family, the implementation worktree/branch, last successful checkpoint, tested commit and image digest, currently deployed digest, pending action, and concrete blockers. Record commands, exit status, workflow/run links, and sanitized artifact references instead of claims such as "looks good." On resumption or context reset, read the ledger, verify the worktree/remote/deployed identifiers, and continue at the first incomplete item. Reuse valid evidence; rerun only checks invalidated by changed inputs. A worker handoff, unavailable test environment, or missing deployment credential is never a passing result.

Execution ordering: Phase 0 baseline precedes changes. The dependency/release worker can proceed through Phases 1 and 6 while the pipeline worker performs Phases 2–5 in order. The UI/tooling worker captures its baseline first and coordinates Phase 7 package batches with the dependency owner. Design Phase 8 tests early and implement them against settled interfaces. Transfer shared-file ownership explicitly before account-panel/test changes. Integrate and run the consolidated gate only after all included phase outputs and reviews are complete.

## 3. Implementation phases

### Phase 0 — Baseline and deployment discovery

- Inspect and preserve existing local work. The earlier review saw many Git status entries but no content diff; establish actual content changes before selecting a clean implementation worktree.
- Reconcile local HEAD and the deployed source with published release history. The reviewed checkout displayed 3.6.2 while the fork had published 3.6.3; the remaining release commit changed version metadata. Do not hand-edit app semver.
- Discover actual Portainer endpoint/stack/service identifiers, host architecture, image digest, volume, update mechanism, and available deployment credentials without printing secret values. Record the existing mechanism and use it; do not create a new stack, migrate the service, or guess a target from Compose examples.
- Record baseline identities, linked accounts, enabled states, queue/history/digest/checkpoint counts, health, and recent delivery diagnostics.
- Capture a repeatable fixture-backed desktop/mobile and light/dark screenshot baseline before frontend changes, including forms, dialogs, navigation, and existing AI settings presentation without invoking providers.
- Record AI-specific source hashes and AI SDK manifest/lockfile resolutions for exclusion checks. Existing shared-library tests may exercise mocked AI behavior, but no live provider calls or AI changes are included.
- Retain the prior image digest, verify encryption-key availability, and establish a protected WAL-consistent backup and recovery procedure.
- Before the final push, pin the actual service to its running digest and disable its automatic updater if present. Branch/latest publication must not deploy an intermediate artifact.
- Correct stale schema descriptions to v8, using code as truth rather than stale skill examples. Update applicable Codex/Cursor guidance mirrors together.

Missing deployment access does not block independent local implementation and tests. It blocks production deployment and completion. It also blocks the release-triggering push unless evidence proves accidental branch/latest deployment is prevented. Record exactly what access is missing, request only that information when necessary, and continue unaffected work; do not publish first and assume production was pinned.

### Phase 1 — Security and release safeguards

The dependency worker returns reviewable change batches and tests; the orchestrator commits them locally without publishing partial remediation.

Security targets:

- `sharp` 0.35.4.
- Exact `brace-expansion` override 5.0.9.
- Every affected `qs` copy at least 6.16.0, `js-yaml` at least 4.3.2, `nanoid` at least 3.3.18, and reviewed `ip-address` 10.7.0.
- `puppeteer-core` 25.10.0; verify that the new browser-management dependency removes every vulnerable `extract-zip` path. Preserve explicit system-Chromium selection and validate actual launch, screenshots, and cleanup.
- `semantic-release` 25.0.9, Git plugin 11.0.1, GitHub plugin 12.0.9, and release-notes generator 14.1.1.
- Resolve every `pacote` copy to a patched version, at least 21.5.1, through compatible parent updates. Do not force a new pacote major into the old npm dependency tree.
- Reassess the existing sigstore/other overrides against the final graph; remove only when proven unnecessary.

Release safeguards:

- Use one reviewed patched Node 22 version at least 22.22.2 for release/E2E tooling; the reviewed Git plugin requires `^22.22.2 || >=24.15`. Bun remains the application runtime/package manager.
- Make semantic-release depend on successful reusable Quality. Keep Quality independent of release/deployment to avoid a workflow cycle.
- Preserve explicit release-tag image dispatch because tags pushed by `GITHUB_TOKEN` do not start the downstream workflows automatically.
- Do not create shared concurrency locks that deadlock a release waiting for dispatched publishers.
- Preserve GitHub/container release behavior; do not enable npm package publication.
- Fix Docker release validation to supply an obvious test-only encryption key as well as its fixture JWT secret.
- Extend the harness with `--image <digest>` to test a published artifact without rebuilding local source.
- Add per-platform fresh-container smoke on native amd64/arm64 runners after image build and before digest promotion: verify native modules, actual Chromium launch/render/cleanup, and `/readyz`. A successful image build or manifest inspection alone is not runtime validation.

Acceptance: all 11 original advisories across eight packages resolved throughout the lockfile graph; no disabled audit gate; failing Quality prevents release creation; compatible release dry-run and Chromium/container checks pass.

### Phase 2 — Retry accounting and SQLite contention

- Extend delivery context with `markAttempted(queueId)` and retain that state in the worker even when the batch throws.
- Authenticate before marking individual items attempted. Mark payload parsing as an attempt so malformed rows can eventually park.
- Defer unresolved unattempted items for five minutes without increasing attempts or altering snapshots/checkpoints.
- Preserve existing settlement/history precedence and exponential backoff/parking for attempted failures.
- Add a distinct `deferred` count to settlement/API summaries where exposed; do not inflate retry/failure counters.
- Set `PRAGMA busy_timeout = 5000` during database connection initialization.

Tests: pre-login outage, partial success plus attempted failure plus untouched tail, corrupt payload parking, stale skip-history semantics, unchanged immutable queue identity, and real two-connection contention including timeout expiry.

### Phase 3 — Cancellation, scraper deadlines, ownership, and shutdown

- Carry `AbortSignal`, attempt tracking, and ownership assertions through X/normalized/digest delivery, scraper fetches, downloads/uploads, polling, pacing, and publication without modifying AI internals.
- Replace timeout races that release destination ownership while work continues. On timeout cancel, await settlement, and only then release ownership.
- Retain ownership while an uncancellable operation settles; report a stalled operation instead of falsely declaring cancellation complete.
- Cancel on failed lease renewal and prevent later external mutations. Check ownership immediately before mutation.
- Ensure cancellation propagates through generic media-error handlers rather than turning into a fallback post.
- Preserve deterministic record recovery/checkpoints after ambiguous remote success. Local cancellation cannot undo a request already accepted remotely and is not absolute cross-process fencing.
- Inject bounded per-request scraper fetch; preserve caller signals, timeout classification, rate limits, and retry behavior.
- Respect live leases during crash recovery. Do not reset all processing rows while another owner is active or introduce a global live unjam action.
- Stop new claims during shutdown and drain/cancel active work before replacing a container.

Tests: delayed completion after timeout, lease loss, cancellation during upload/polling/pacing, shutdown/restart, ambiguous success recovery, no overlapping same-destination writes, independent-destination concurrency, and discovery still fetching/enqueuing independently of uploads.

### Phase 4 — Durable account suspension handling

- Preserve structured provider takedown/deactivation errors through login wrappers; ordinary 401/403 or arbitrary error text must not imply permanent suspension.
- Store blocked reason/time and runtime concurrency state separately from destination `enabled` using the next additive SQLite migration. The reviewed migration registry ends at 011; verify the next number at implementation time.
- Block new queue/digest claims and all scheduled/manual profile, pin, follow, and post mutations for the linked account.
- Preserve source ingestion, pending work, enabled settings, identity links, and immutable policy snapshots.
- Extend sanitized account health/API types and existing panels with blocked status and an explicit resume action.
- Resume performs read-only health validation and atomically checks runtime state, configuration revision, authorization, and restore/restart mutation restrictions before clearing the block.
- Ordinary successful credential validation must not automatically resume posting. Do not change canonical JSON solely to store operational health.

Tests: restart persistence, every mutation entrypoint, transient auth failure, retained ingestion/queue, successful/failed explicit resume, OCC/runtime stale-state rejection, permissions, migration idempotency, and unchanged destination/account/storage identity.

### Phase 5 — Thumbnail correctness and ten-minute videos

- Add thumbnail purpose/size handling to the uploader with an exact 1,000,000-byte ceiling after transformation.
- Apply to external and quoted-post cards, validate actual image content, and omit invalid/uncompressible thumbnails while keeping the card/post.
- Preserve the ordinary-image ceiling and quality behavior.
- Raise video duration support to 600,000 ms while retaining the conservative 280 MiB upload ceiling.
- Rank MP4 variants by quality and estimated size, stepping down after bounded download failures or oversize results; keep link fallback if no variant works.
- Use a real 20-minute elapsed processing deadline, not an attempt count that ignores time spent in requests.
- Align enclosing batch budgets with supported download, upload, processing, and pacing budgets. Integrate Phase 3 cancellation rather than simply lengthening the old race timeout.

Tests: exact thumbnail boundary, 1–1.9 MB thumbnail transformation, invalid content, unchanged regular images, three-/ten-minute boundaries, missing duration, lower-bitrate success, all variants oversized, processing timeout/cancellation, and unchanged short-video behavior. Use mocked lengths instead of huge fixtures.

### Phase 6 — Remaining backend and runtime dependencies

Upgrade in separate local commits with focused validation:

| Dependency group | Reviewed target |
| --- | --- |
| Bluesky/HTTP clients | `@atproto/api` 0.20.44; Axios 1.20.0 |
| Application runtime | Bun and Bun types 1.4.2 |
| Native database | `better-sqlite3` 13.0.3; types 9.6.0 |
| CLI | Commander 15.0.0; Inquirer 14.2.2 |

- Synchronize Bun in the package-manager declaration, both Docker stages, CI, runtime checks, and documentation.
- Verify native loading/install on Linux amd64/arm64 and the actual Bun SQLite path. Package updates alone do not require a database schema migration.
- Preserve CLI defaults, prompt selections, cancellation, and confirmation semantics; remove obsolete type stubs only after bundled declarations are verified.
- Keep the X scraper at reviewed current 0.22.3 unless a newly verified incompatibility requires a separately justified correction.

Tests: auth/session refresh, deterministic record recovery, media requests, rate limits, native loading, database backup/restart, Chromium compatibility, CLI flows, and existing mocked shared-library/AI regressions without AI edits.

### Phase 7 — Compiler, lint, test, frontend, and styling upgrades

Coordinate dependency edits through the single manifest/lockfile owner.

| Group | Reviewed target |
| --- | --- |
| Compiler and lint | TypeScript 7.0.2; Biome 2.5.13 |
| Test tooling | Playwright 1.63.0; tsx 4.23.13 |
| Node types | Compatible Node 22 line; reviewed 22.20.2 |
| Frontend runtime | React, React DOM, and types 19.3.0 together |
| Bundler | Vite 8.3.0 and React plugin 6.1.1 together |
| CSS tooling | Tailwind 4.3.3; tailwind-merge 3.7.0; PostCSS 8.5.28 |
| Icons | lucide-react 1.45.0 |

- Upgrade directly to the reviewed TypeScript target; the previous mandatory TypeScript 6 bridge was unsupported and is removed. Verify Windows/Linux compiler binaries and emitted backend behavior.
- Preserve strict checks, NodeNext `.js` imports, declarations/source maps, routing, sessions, polling, forms, and dialogs.
- Migrate Biome configuration without broad style rewrites. Do not weaken whole-project checks or edit AI code merely to satisfy tool upgrades.
- Retain the PostCSS architecture for Tailwind 4: use its matching PostCSS package, explicitly load the existing JavaScript theme config, update CSS entry directives, and preserve class-based dark mode/design tokens/custom applies.
- Remove Autoprefixer if redundant with that integration; otherwise use reviewed 10.6.0. Do not simultaneously redesign the theme or switch to a second Tailwind/Vite integration.
- Adapt icon imports without visual redesign. Extend existing UI panels incrementally.

Tests: server build/startup; desktop/mobile and light/dark screenshots; navigation, sessions, forms, dialogs, focus, polling, API/OCC errors, CSS states, and unchanged AI settings UI behavior.

### Phase 8 — Add actual deployment acceptance tests

The existing Playwright suite serves Vite preview and intercepts API requests. The existing Docker harness builds local source and checks readiness. Neither proves the full deployed application works.

Add three distinct test modes:

1. Real-backend container tests with disposable data and controlled provider stubs for login/CSRF, authorization/OCC, account/destination flows, preview mutation guards, queue controls, and backup validation.
2. Exact-image tests accepting a published digest for fresh startup, copied-volume migrations, restart/idempotency, queue/checkpoint continuity, and real system-Chromium behavior.
3. Authenticated production smoke against the actual HTTPS endpoint with real API responses and no interception: version/status/health, navigation/assets, console/network failures, identity/linkage checks, and queue continuity.

Keep copied-production tests denied outbound network and inbound ingestion; disabling only the scheduler is insufficient. Provider-stub tests use separate fixture data. Production smoke must not modify settings, tokens, history, profiles, or account identity, and must not expose credentials.

Implement fixture providers through test-only dependency injection or isolated test entrypoints. Do not add production authentication bypasses, relax public-fetch/SSRF protections, or ship a remotely accessible test mode to make acceptance tests pass.

## 4. Consolidated build, push, release, and deployment

### Integrate and test continuously

Workers run focused tests and fix failures before handoff. The orchestrator resolves integration conflicts, requests bounded independent reviews, and ensures every actionable finding is fixed or demonstrated inapplicable.

After all phases are integrated, run:

- `bun install --frozen-lockfile` in the isolated implementation environment.
- `bun run check` for compatibility, lint, both typechecks, unit/integration/release tests, and build.
- `bun audit --audit-level=high` plus confirmation all original advisories are gone.
- Browser E2E using real Node on Windows, and real-backend tests against disposable containers.
- `bun run release:validate -- --docker` after the harness repair, without redundantly repeating suites already run by that command unless changes/failures justify it.
- Fresh/current/legacy copied-volume migration, backup/restore, restart, and shutdown cases.
- Candidate image build and native/browser startup checks; verify both supported architectures on native runners where available. If an architecture is only available in CI, verify its release-image checks before production deployment and do not claim local coverage.
- AI-exclusion and secrets-regression checks.

Set a temporary data directory before importing database/config modules. Do not run live `test:pipeline`, `test:twitter-*`, or `test:ad-tweet` scripts against production. Fixed elapsed time and an idle queue do not count as functional tests.

### Push the finished integration

1. Explicitly review/stage intended files and create Conventional Commits. Include release-bearing subjects for behavior changes.
2. Refresh remote history and integrate intervening changes without rewriting published commits; rerun checks affected by the integration.
3. Confirm production is pinned against accidental branch/latest updates.
4. Push the completed work to `main` once initially; current semantic-release configuration releases only `main`. If branch protections require a PR, push the finished branch and merge it into `main` through the permitted PR path; do not bypass protection.
5. Verify Quality, semantic-release, generated release commit/tag, and GitHub Release.
6. Await release-tag GHCR publisher completion; inspect manifests/digests and version agreement. Optional Docker Hub publishing may legitimately skip without credentials; verify the registry actually used by production.
7. Test the exact published digest using the new image-validation mode. Semantic-release changes version metadata after the initial push, so pre-push candidate tests alone are insufficient.

### Deploy once after all work is complete

- Quiesce the current writer using controls supported by the currently deployed version, including new inbound work and scheduled/manual mutation entrypoints. The old image cannot be assumed to have the new graceful-shutdown implementation. Capture original control states and wait within the bounded drain deadline below.
- Confirm the old container/process has exited before the replacement starts. Capture the consistent pre-deployment backup and previous digest; preserve all completed history/checkpoints. If requests were interrupted, establish deterministic recovery/reconciliation for their ambiguous remote outcomes before resuming delivery.
- Replace the single production container through Portainer with the verified digest, same volume, encryption key, and environment.
- Restore/preserve original destination states. Do not perform a phased canary or wait through an observation window.
- Verify container readiness and immediately run actual deployed acceptance tests.

### Operational deadlines and failure classification

- CI/release/publisher runs: a 60-minute deadline for each required workflow. Inspect failures or timeout diagnostics; retry a clearly transient infrastructure failure at most twice. Do not endlessly redispatch identical runs.
- Registry/API reads: 30-second request deadline and at most two retries with short backoff. Container readiness: 180 seconds with bounded health polling. Deployed HTTP assertions use the same 30-second request bound; real test assertions must not be retried until a regression happens to disappear.
- Old-writer drain: at most ten minutes after stopping new work. At expiry capture diagnostics, stop the old container with a 60-second termination grace, and confirm it exited. Preserve queue/history/checkpoints. Start the replacement only when recovery of interrupted/ambiguous publication is established; otherwise retain a clear recovery blocker without resetting data to force progress.
- These deadlines apply to operational waits. Existing longer bounded media deadlines remain valid in the application. Test long timeout behavior with controllable clocks/stubs rather than waiting for the entire production timeout.
- An uncancellable operation may keep its destination unavailable while it settles, but the orchestrator must follow the bounded diagnosis/recovery path rather than waiting indefinitely. Never release a live owner's lock or start a second writer merely to satisfy a timeout.
- Separate code defects from missing access, provider outages, exhausted CI capacity, and registry/network failures. Assign code repairs only with supporting evidence; exhausted infrastructure retries produce an explicit incomplete blocker, not speculative commits or repeated deployments.

## 5. Deployed verification, automatic fixes, and recovery

Immediately verify:

- Running image digest, application version, schema/migration state, `/healthz`, and `/readyz`.
- Existing authenticated version/status/health endpoints, real dashboard/navigation/assets, authentication redirects, and applicable proxy/security headers.
- Account/destination identity and linkage continuity.
- Queue/history/digest/checkpoint continuity against baseline, accounting for legitimate work completed during cutover.
- Sanitized startup/runtime logs for migration, database, auth, worker, and browser errors.
- Normal scheduler/delivery activity occurring during the smoke run, checking error/duplicate diagnostics and expected queue progress.

Do not generate public posts, follow/profile/pin changes, handle changes, or AI calls to manufacture coverage. If no natural delivery occurs during the test pass, report live posting as unexercised; do not wait through a fixed soak or falsely claim success. Edge cases remain tested in isolated provider fixtures.

For every CI, image, or production-test defect, continue automatically:

1. Capture bounded sanitized diagnostics and reproduce off production.
2. Assign a narrowly scoped repair to the relevant subagent.
3. Implement the smallest fix and a regression test where warranted.
4. Run focused checks plus the affected/full integrated gate.
5. Create a forward corrective commit, push, verify the new release/image, and redeploy.
6. Repeat deployed acceptance until the defined checks pass or a concrete external/access limitation prevents further execution.

Prefer forward fixes. If immediate rollback is required, stop the candidate and use the previous image with current data only when compatibility is established. Preserve failed data and logs. Never automatically restore an older database after new external posts have been accepted: reconcile published records and newer checkpoints first. App-level restore can revoke sessions/ingestion credentials; account for those consequences if restore is actually necessary. Never run old/new production writers simultaneously.

## 6. Completion and evidence

Complete when all included implementation work is integrated, automated suites and exact-image tests pass, the final production digest is verified, deployed smoke passes, no known regression or high/critical dependency advisory remains, and AI-specific source/SDK/models/settings remain unchanged.

Before declaring completion, the orchestrator checks the ledger against this entire plan: every required implementation item has a reviewed disposition, every required test has passing evidence tied to the final relevant commit/digest, and production acceptance is recorded for the digest actually running. Missing production access, failed/unrun required tests, an unavailable required architecture, or an unresolved included dependency upgrade means the goal is incomplete. Follow the available goal-status rules for a genuine blocker; never mark complete merely because local work is finished or an execution budget is nearly exhausted.

The only predefined nonblocking coverage limitation is absence of naturally occurring live publication during the bounded production smoke pass. Record it explicitly while requiring isolated delivery scenarios and the real deployed API/UI checks to pass. This exception does not waive any other required test or permit live AI/public mutation tests.

Deliver a concise final report with commit/release/image identifiers, tests and results, any corrective releases, recovery references, and explicitly unexercised external scenarios. Retain the ledger, previous working digest, and protected backup references for resumption/recovery.

Dependency targets above are the verified starting inventory from this review, not an instruction to trust stale versions indefinitely. Recheck availability, advisories, and compatibility at implementation start, document selected exact versions, and avoid unreviewed latest-version substitutions. Resolving a new incompatibility must not silently broaden scope or cross the AI exclusion.
