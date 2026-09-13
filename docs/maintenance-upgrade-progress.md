# Maintenance upgrade progress

Updated: 2026-09-13. Execution resumed after Portainer login setup. Implementation and independent reviews are complete; release, native arm64 validation, published-image acceptance, and production acceptance remain incomplete.

## Execution identity

- Plan: `docs/maintenance-upgrade-plan.md`.
- Implementation worktree: `C:/Users/Alex/Projects/tweets-2-bsky/.worktrees/maintenance-upgrade`.
- Implementation branch: `codex/maintenance-upgrade`.
- Verified base: `origin/main` at `d824648569450d0dcadc42cf84a8b796195055a3`, published app 3.6.3.
- Original checkout preserved: `codex/fix-long-form-repost-text` at `f81521e`. Original tracked changes had no Git-normalized content diff; no reset/stash/cleanup performed. This progress ledger is deliberately mirrored to both checkouts.
- Base-to-old-HEAD difference: only release metadata in package.json and README.md.
- Implementation committed locally as `76c209cf12d75e2540e775a994959901df25d053` (`fix: harden delivery and upgrade non-AI runtime dependencies`). The reviewed implementation matches the locally tested source; only ledger updates followed. No remote push, release, or application deployment yet. Published-digest acceptance remains open.

## Ownership and current action

| Agent | Owned work | Current action |
| --- | --- | --- |
| Main orchestrator | Integration, deployment discovery, Git/release/deploy, final verification | Updater guards established; push integrated changes, verify release images, then copied-volume rehearsal and production acceptance |
| dependency_plan | Manifest/lockfile, Dockerfile, workflows, runtime checker, image validation | Implementation and local validation complete; native arm64 and published-image evidence pending |
| pipeline_plan | Pipeline/database/services/adapters and related tests | Implementation and independent reviews complete |
| deployment_plan | Frontend/config/browser runner and E2E | Implementation and local browser validation complete |
| portainer_bridge | Private deployment helpers | Portainer bridge and server-side protected snapshot wrapper prepared and offline-checked; no remote invocation |
| cutover_controls | Read-only old-release quiescence review | Reviewed deployed 3.6.3 source at d824648; supported controls and observability limitations recorded below |

Workers must not stage/commit/push. Main performs all remote mutations. Keep incomplete production acceptance open even though implementation and local checks pass.

## Phase ledger

| Requirement | State | Evidence / next action |
| --- | --- | --- |
| 0: isolated source baseline | PASS | Fetch and worktree creation exited 0; base d824648 |
| 0: original work preservation | PASS | Original Git-normalized diff empty; original AI blob equals HEAD; no destructive checkout cleanup |
| 0: fixture screenshots | PASS | Frozen baseline: 4 Playwright tests, 16 desktop/mobile light/dark captures under test-results/maintenance-baseline |
| 0: production target/digest/data/key/backups | PARTIAL | Target, stack, image digest, volume, identity fingerprint, and protected WAL-consistent baseline snapshot verified by main; copied-volume rehearsal and final quiesced backup remain pending |
| 0: prevent accidental updater deployment | GUARDED | Portainer stack2 Git auto-update disabled with metadata-only API; verified same healthy app ID/image. Watchtower stopped and original running state recorded. Old container still names latest but cannot be changed by either updater; exact Compose digest reference will be set during cutover |
| 0: schema documentation alignment | IMPLEMENTED | AGENTS/README/architecture/Cursor identity mirror corrected to v8; historical v7 migration section retained |
| 1: all original security advisories | LOCAL PASS | Frozen install completed without changes; audit reports zero vulnerabilities across 724 packages |
| 1: release prerequisites and exact-image/native smoke | PARTIAL | Local release validation passed; native arm64 and exact published image remain open |
| 2: retry/deferred semantics and SQLite busy wait | IMPLEMENTED / LOCAL PASS | Implementation and reviews complete; included in full 441-test gate |
| 3: cancellation/leases/recovery/shutdown/scraper deadlines | IMPLEMENTED / LOCAL PASS | Implementation and reviews complete; included in full gate and isolated runtime fixtures |
| 4: account block migration/API/resume/mutation gates | IMPLEMENTED / LOCAL PASS | Migration012 and block/resume persistence, API, and mutation gates pass full gate and network-isolated real-backend checks |
| 5: thumbnail limit and ten-minute video | IMPLEMENTED / LOCAL PASS | Implementation and reviews complete; full gate passes |
| 6: clients/Bun/native database/CLI | IMPLEMENTED / LOCAL PASS | Full Bun 1.4.2 gate; Linux amd64 SQLite/sharp/Chromium smoke and fixture stages pass; native arm64 remains open |
| 7: compiler/lint/frontend/CSS/icons | IMPLEMENTED / LOCAL PASS | Both typechecks/build and browser workflows pass; AI exclusion retained |
| 8: real-backend, published-image, production smoke | PARTIAL | Local candidate readiness and network-isolated backend fixtures pass; published digest and live upgraded deployment untested |
| Independent pipeline/config/secrets reviews | COMPLETE | Main-task handoff confirms implementation findings repaired and reviews complete |
| Full frozen-install/check/audit gate | LOCAL PASS | Recorded exit 0 for both logs below; 369 unit + 59 integration + 13 release = 441 tests, zero failures; implementation committed as 76c209c |
| Mocked UI + real-backend integration | LOCAL PASS | Playwright 21 passed, 4 optional capture tests skipped; separate network-none backend run: 11 tests, 160 assertions, zero failures |
| Fresh/current/legacy migration/restore/restart | FIXTURE PASS / LIVE COPY OPEN | 18 compiled image fixture stages cover six fixture configurations through seed/restart/restore; actual production copied-volume rehearsal remains pending |
| amd64/arm64 native/container/Chromium | PARTIAL | Linux amd64 native SQLite/sharp and Chromium render/cleanup pass locally; native arm64 pending |
| Exact published digest validation | OPEN | No release generated; local image tag tweets-2-bsky:release-validation is not published-image evidence |
| Git push/release/registry manifests | OPEN | Local commit 76c209c created with 90 explicitly reviewed paths, no secrets/artifacts staged, clean implementation worktree afterward; no push. Establish both updater guards before release-triggering push |
| Production cutover/readiness/authenticated smoke | OPEN | Old production 3.6.3 healthy; upgraded application has not been deployed |
| Repair loop and completion audit | OPEN | Required after published-image validation and actual deployment |

## Verified local validation evidence

Existing logs were inspected without rerunning the checks. Main-task handoff records exit 0 for each process.

- `test-results/maintenance-final-check.log`: dependency compatibility, lint, both typechecks, unit/integration/release tests, and build. Lines 915–918: 369 unit tests pass; lines 1035–1038: 59 integration tests pass; lines 1061–1064: 13 release tests pass. Total: 441, zero failures. Vite build completes at the end of the log.
- `test-results/maintenance-release-validation.log`: frozen install checked 606 installs across 819 packages without changes; line 6 reports zero vulnerabilities across 724 audited packages. Lines 118–119: 4 optional capture tests skipped, 21 Playwright tests passed. Line 120: Linux x64 native modules and Chromium render/cleanup pass. Lines 122–149: 18 compiled migration/backup continuity stages, including populated v6 and current v8 fixtures. Lines 182–185: 11 backend tests, zero failures, 160 assertions. Lines 186–187 confirm no external network, running-container readiness, and completed release validation.
- Local candidate image ID: `sha256:e3c8b943586a50cf58e7dbb8b5f1050ac6ef89284d13bb8489dd785747c4152c` (main-task handoff). This local image ID does not establish a registry manifest digest.
- The local release harness prints “Published image readiness” for its supplied local image tag. This is candidate-image validation only; the exact registry digest is still an open acceptance requirement.

## AI exclusion baseline

- `src/ai-manager.ts` Git blob: `ccdd0b9b906e92219b1f4caacf28f61827e6b70b`.
- Implementation worktree file SHA256: `49A9354146492DE261E825F36D39A257F019E492228A63BFFF09A3BDB8579B57`.
- Direct SDK manifest: `@google/generative-ai` `^0.24.1`; resolved artifact/integrity unchanged.
- Main-task handoff confirms AI implementation remains unchanged and no live AI calls were made. Prior preservation checks found 4 AI UI screenshot pairs pixel-identical and the shared mocked AI regression batch passing.
- Raw parent AI hash differs because of checkout line endings; use Git-normalized content for preservation alongside the implementation byte hash.

## Production evidence and remaining access work

Production facts below are from the main task's verified remote investigation; this ledger update performs no remote commands.

- Production app 3.6.3 is healthy. Earlier public checks returned `/healthz` 200 with database OK, scheduler running, and restartRequired false; `/readyz` 200 ready. Authenticated production UI showed AI off. Old-version health does not satisfy upgraded-deployment acceptance.
- SSH access now works through the ignored owner-only helper with Windows-user DPAPI credentials, six-hour freshness enforcement, and existing verified known_hosts. Do not print credential contents or invoke askpass independently. Main owns credential lifecycle and all remote actions.
- Portainer is version 2.39.5. Its installed public TLS certificate is trusted explicitly over verified SSH; no browser security bypass is required. The Portainer credential handoff is complete and authenticated inspection succeeded.
- Existing Git-managed Compose stack: ID 2, name `tweets2bsky`, endpoint ID 3, project path `/data/compose/2`, entry point `docker-compose.portainer.yml`. Container: `tweets-2-bsky`. Existing persistent volume: `tweets2bsky_data`.
- Running old image digest: `sha256:7755e700137b1bdb7fdd69a924f7f18f148f73a4d5e147ba6ecce97c71e9de88`.
- Discovered two automatic deployment mechanisms: Portainer Git polling every 15 minutes and Watchtower polling every 3600 seconds. Both are now guarded as recorded below; neither guard redeployed the old app.
- Protected WAL-consistent live baseline snapshot: `/home/ubuntu/.local/state/tweets2bsky-maintenance/baseline-20260913T134653Z/snapshot`. Baseline config schema 8; database version 11. Counts: queue 0, processed 8930, checkpoints 12705, digest entries 0, jobs 0.
- Baseline identity fingerprint: `8c723dac2bfa545e553d7b455aea046cfcd209b6fd77c3b6469ccc959744bea0`. No secret values belong in this ledger.
- Automatic approval review rejected transfer of production config, database, and encryption-key material to a local owner-only ignored folder because specific authorization for that sensitive transfer was absent. No transfer happened. The main task will validate the protected snapshot on the server against the published digest, keeping production data and secrets there; this validation remains open.
- SSH and Portainer authentication work. Only updater controls have changed; the production application remains on its original image and configuration.
- The live baseline snapshot is not a final cutover backup. Actual copied-volume rehearsal and a final quiesced, rollback-ready backup are still pending.
- GitHub main was verified at d824648 with no remote mutation. Release-bearing local commit 76c209c is ready; push, workflow success, generated tag/release, matching package/README version, and registry manifests remain pending.
- Remote history refreshed after local commit: main still d824648, zero upstream-only commits, one local implementation commit. AI source diff against main remains empty.
- The earlier browser tab is no longer available. A replacement production tab currently shows Sign in and is retained for handoff; authenticated post-upgrade acceptance still requires a valid user-provided session.
- Private `test-results/deployment-access/server-copy-test.py` is prepared for the verified published digest. It runs only the image's existing copy/migrate/restart entrypoints with network disabled, no ports, read-only root, disposable labeled resources, and the snapshot mounted read-only. The encryption key stays in the server process environment. It verifies source fingerprints and app ID/image preservation, and reports cleanup failures explicitly. Python syntax and mocked isolation, timeout, ownership, hex/base64 key, optional `.jwt-secret`, and unknown-file checks pass. This is helper preparation, not actual production-copy acceptance.
- Access revalidation across three consecutive goal turns found no Portainer credential file, including the final existence-only check. All delegated work is terminal; the implementation and latest committed evidence are 76c209c and 7986a97. Independent local work and helper preparation are finished. The goal is blocked until user-supplied Portainer authentication is available; no release-triggering push is permitted until both updaters are controlled. Completion remains unproven. Resume the full release/deployment/acceptance scope after access is supplied; do not repeat completed suites without a relevant change or failure.

## Old-release cutover constraints

### Access and updater guard after user handoff

- Portainer Inspect succeeded using the supplied login; existing stack/environment/volume/source match the discovered target.
- `DisableAutoUpdate` succeeded; stack state fingerprint `703d728faea304c2aff9882684c8c611019f1d3e87bf211aa79addfd2d10d781`. API verification confirmed the existing app ID/image unchanged and healthy, with AutoUpdate null.
- Verified Watchtower belongs to `container-updater`, image `nickfedor/watchtower:latest`, and was running. Stopped only that updater; confirmed it exited and the app remained healthy on the original image. Restore the shared updater after the deployed app has its explicit false Watchtower label.
- The previous access-blocked audit is historical. Authenticated application-session setup, release/published-image tests, proxy quiescence, final backup, and actual deployment remain open.

The cutover reviewer inspected deployed ref `d824648569450d0dcadc42cf84a8b796195055a3`, not the new implementation. Application scheduler/destination/ingestion controls have not been changed.

- The old release has no global maintenance/drain API or signal-driven graceful drain handler. A 60-second Docker stop timeout alone does not establish that publishing drained.
- Gate external mutations and inbound ingestion at the existing reverse proxy, retain a private operator path, and verify no direct-port bypass. Inspect the actual proxy configuration before selecting its concrete gate; this remains open.
- Capture original scheduler settings and top-level `revision`/`updatedAt` with `GET /api/settings/scheduler`. Update with `PATCH /api/settings/scheduler`, preserving `intervalMinutes` and supplying `enabled:false` plus the current revision; the response supplies the next revision. It prevents new scheduled sweeps but not an active sweep, accepted manual work, pending backfills, or pins.
- Drain within the plan's ten-minute bound. Use fresh status/health/digest API results, durable queue/digest/backfill state, and sanitized sweep/task completion logs together. The earlier empty baseline is not proof of current quiescence.
- Avoid destination state changes if unnecessary. `PATCH /api/destinations/:id/state` with current `revision` and `state:"paused"` preserves queue rows and prevents new queue claims, but it can cancel waiting backfills and discard pending pin work. Require those to be settled first and preserve each original state if this control is needed.
- Destination pause does not stop armed digest jobs in the old release. Do not use digest deletion/cancellation or policy edits as a reversible pause.
- Old post requests can outlive their 120-second Promise.race timeout; zero queue/active-job counters do not establish settled external work. Profile/follow HTTP operations and pending pins are not fully represented in status. Reconcile any timeout or ambiguous acceptance using deterministic record identities/checkpoints before delivery resumes.
- Confirm the old container exited before the authoritative backup and replacement start. Preserve the latest queue/history/checkpoints; never restore the earlier baseline merely to make tests pass. Restore only operator settings actually changed, using current revisions, and reopen ingress after acceptance.
- Authenticated old-version admin access is still required for supported scheduler controls. SSH-only reads of empty tables do not substitute for that access or prove a drain.

## Toolchain notes for resume

- Docker Desktop 29.6.2 is available; local candidate container tests passed.
- Official Node 22.22.2 Windows executable is in ignored test artifacts, verified against nodejs.org SHASUMS. Exact release-toolchain rehearsal exited 0; global Node unchanged.
- Bun 1.4.2 is available at `C:/Users/Alex/.bun/install/cache/@oven/bun-windows-x64@1.4.2@@@1/bin/bun.exe`. Prepend its directory to process.env.PATH inside Bun before Bun.spawn for package scripts; PowerShell PATH alone previously selected global 1.3.14 in nested commands.

## Resume instruction

Read this ledger and the saved plan; inspect current worktree and main-task status. Continue open acceptance work without repeating completed local exploration or tests unless code changes or new failures justify it. Establish both updater guards before push. Record final commit and exact image digest, prove native arm64, rehearse the protected production snapshot on the server against the published digest, take the final quiesced backup, deploy through the existing stack, and verify live readiness, authenticated behavior, data/identity preservation, and rollback artifacts. Do not mark the goal complete until every required release and production acceptance item is proven.
