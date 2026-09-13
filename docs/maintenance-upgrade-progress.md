# Maintenance upgrade progress

Updated: 2026-09-13. Production 3.6.5 is healthy at verified root ea73eb8c with exact migration 12 continuity and live API acceptance, but ordinary browser acceptance still fails Posts thumbnails: video.bsky.app redirects to CSP-blocked video.cdn.bsky.app. Original scheduler/ingress controls are restored and shared Watchtower runs with the app pinned/excluded. A second exact image-origin correction, isolated browser redirect regression, planned 3.6.6 release, and final deployed UI acceptance remain open.

## Execution identity

- Plan: `docs/maintenance-upgrade-plan.md`.
- Implementation worktree: `C:/Users/Alex/Projects/tweets-2-bsky/.worktrees/maintenance-upgrade`.
- Implementation branch: `codex/maintenance-upgrade`.
- Verified base: `origin/main` at `d824648569450d0dcadc42cf84a8b796195055a3`, published app 3.6.3.
- Original checkout preserved: `codex/fix-long-form-repost-text` at `f81521e`. Original tracked changes had no Git-normalized content diff; no reset/stash/cleanup performed. This progress ledger is deliberately mirrored to both checkouts.
- Base-to-old-HEAD difference: only release metadata in package.json and README.md.
- Implementation committed locally as `76c209cf12d75e2540e775a994959901df25d053` (`fix: harden delivery and upgrade non-AI runtime dependencies`). The reviewed implementation matches the locally tested source. Initial main push f257d72368efd648a1807556fe3ea723134bd9de succeeded; semantic-release generated f58e6da1a91c6957cda0fb5c1db0a5d02310e367 for v3.6.4. Main fast-forwarded to that release commit with only package.json and README version differences. Application deployment completed; final UI/post-resume acceptance remains open.

## Ownership and current action

| Agent | Owned work | Current action |
| --- | --- | --- |
| Main orchestrator | Integration, deployment discovery, Git/release/deploy, final verification | 3.6.5 native image/cutover/continuity/API verified; prepare exact CDN-origin correction and 3.6.6 acceptance |
| dependency_plan | Manifest/lockfile, Dockerfile, workflows, runtime checker, image validation | Implementation, native amd64/arm64 CI, and promoted manifest verification complete |
| pipeline_plan | Pipeline/database/services/adapters and related tests | Implementation and independent reviews complete |
| deployment_plan | Frontend/config/browser runner and E2E | Implementation and local browser validation complete |
| portainer_bridge | Corrective CSP fix, regression test, and real UI verification | Add only video.cdn.bsky.app alongside first host; isolated browser redirect regression and final ordinary UI acceptance |
| cutover_controls | Read-only old-release quiescence review | Reviewed deployed 3.6.3 source at d824648; supported controls and observability limitations recorded below |

Workers must not stage/commit/push. Main performs all remote mutations. Keep incomplete production acceptance open even though implementation and local checks pass.

## Phase ledger

| Requirement | State | Evidence / next action |
| --- | --- | --- |
| 0: isolated source baseline | PASS | Fetch and worktree creation exited 0; base d824648 |
| 0: original work preservation | PASS | Original Git-normalized diff empty; original AI blob equals HEAD; no destructive checkout cleanup |
| 0: fixture screenshots | PASS | Frozen baseline: 4 Playwright tests, 16 desktop/mobile light/dark captures under test-results/maintenance-baseline |
| 0: production target/digest/data/key/backups | PASS | Target/published digest and same volume/env verified; protected copied-volume rehearsal and final stopped-writer recovery 20260913T160955Z-1204b84a2f2d41899b83f4391a5e7ad2 passed |
| 0: prevent accidental updater deployment | PINNED / SHARED UPDATER RESTORED | Production pins 3.6.5 root digest/release ref with app Watchtower enable=false; Portainer polling remains guarded and shared Watchtower is running again |
| 0: schema documentation alignment | IMPLEMENTED | AGENTS/README/architecture/Cursor identity mirror corrected to v8; historical v7 migration section retained |
| 1: all original security advisories | LOCAL PASS | Frozen install completed without changes; audit reports zero vulnerabilities across 724 packages |
| 1: release prerequisites and exact-image/native smoke | THROUGH 3.6.5 PASS / 3.6.6 OPEN | 3.6.5 native provenance, exact published-image smoke, and server copy passed; second exact CSP origin correction requires final release/image acceptance |
| 2: retry/deferred semantics and SQLite busy wait | IMPLEMENTED / LOCAL PASS | Implementation and reviews complete; included in full 441-test gate |
| 3: cancellation/leases/recovery/shutdown/scraper deadlines | IMPLEMENTED / LOCAL PASS | Implementation and reviews complete; included in full gate and isolated runtime fixtures |
| 4: account block migration/API/resume/mutation gates | IMPLEMENTED / LOCAL PASS | Migration012 and block/resume persistence, API, and mutation gates pass full gate and network-isolated real-backend checks |
| 5: thumbnail limit and ten-minute video | IMPLEMENTED / LOCAL PASS | Implementation and reviews complete; full gate passes |
| 6: clients/Bun/native database/CLI | IMPLEMENTED / LOCAL PASS | Full Bun 1.4.2 gate; Linux amd64/arm64 native SQLite/sharp/Chromium, 18 migration stages, and backend fixtures pass in published-image CI |
| 7: compiler/lint/frontend/CSS/icons | IMPLEMENTED / LOCAL PASS | Both typechecks/build and browser workflows pass; AI exclusion retained |
| 8: real-backend, published-image, production smoke | PARTIAL | Published image, production copy, healthy 3.6.4, exact continuity, deployed API/assets, and startup logs pass; corrected real UI and post-resume checks remain open |
| Independent pipeline/config/secrets reviews | COMPLETE | Main-task handoff confirms implementation findings repaired and reviews complete |
| Full frozen-install/check/audit gate | LOCAL PASS | Original install/audit evidence retained; corrective pinned maintenance-csp-check-pinned.log passed lint/typechecks/build and 369 unit + 59 integration + 13 release = 441 tests |
| Mocked UI + real-backend integration | LOCAL PASS | Playwright 21 passed, 4 optional capture tests skipped; separate network-none backend run: 11 tests, 160 assertions, zero failures |
| Fresh/current/legacy migration/restore/restart | FIXTURE + PRODUCTION COPY PASS | 18 fixture stages and actual protected server snapshot copy/migrate/restart pass against published digest; source/app unchanged and all five helper resources removed |
| amd64/arm64 native/container/Chromium | THROUGH 3.6.5 PASS | GHCR 34768653297 succeeded: both native architectures passed 18 migration stages and 11 backend tests/162 assertions; final planned 3.6.6 image checks remain open |
| Exact published digest validation | THROUGH 3.6.5 PASS / 3.6.6 OPEN | 3.6.5 root ea73eb8c native provenance and exact-image session 26093 exited 0; maintenance-csp-published-image.log; final correction not released yet |
| Git push/release/registry manifests | THROUGH 3.6.5 PASS / 3.6.6 OPEN | Corrective 7ce81eca/5d37d755 and Release 34768543332/GHCR 34768653297 succeeded; next exact CDN CSP correction planned for 3.6.6 |
| Production cutover/readiness/authenticated smoke | PARTIAL / SECOND CORRECTION REQUIRED | 3.6.5 cutover/API/12-to-12 continuity passed; Posts images still fail due video.cdn.bsky.app redirect CSP omission; planned 3.6.6 and final live UI acceptance open |
| Repair loop and completion audit | OPEN | First origin correction deployed; second exact redirected image-origin fix/browser regression, final release/image/cutover/UI/post-resume acceptance and evidence audit remain |

## Verified local validation evidence

Existing logs were inspected without rerunning the checks. Main-task handoff records exit 0 for each process.

- `test-results/maintenance-final-check.log`: dependency compatibility, lint, both typechecks, unit/integration/release tests, and build. Lines 915–918: 369 unit tests pass; lines 1035–1038: 59 integration tests pass; lines 1061–1064: 13 release tests pass. Total: 441, zero failures. Vite build completes at the end of the log.
- `test-results/maintenance-release-validation.log`: frozen install checked 606 installs across 819 packages without changes; line 6 reports zero vulnerabilities across 724 audited packages. Lines 118–119: 4 optional capture tests skipped, 21 Playwright tests passed. Line 120: Linux x64 native modules and Chromium render/cleanup pass. Lines 122–149: 18 compiled migration/backup continuity stages, including populated v6 and current v8 fixtures. Lines 182–185: 11 backend tests, zero failures, 160 assertions. Lines 186–187 confirm no external network, running-container readiness, and completed release validation.
- Local candidate image ID: `sha256:e3c8b943586a50cf58e7dbb8b5f1050ac6ef89284d13bb8489dd785747c4152c` (main-task handoff). This local image ID does not establish a registry manifest digest.
- The local release harness prints “Published image readiness” for its supplied local image tag. This older log is candidate-image validation only; later exact registry-digest evidence is recorded separately below.

## Release and exact published-image evidence

The main task supplied the completed evidence below. This ledger update performs no Git/remote commands and reruns no checks.

- Initial main push: `f257d72368efd648a1807556fe3ea723134bd9de` succeeded.
- Release workflow `34765700058`: quality and release succeeded. Generated commit `f58e6da1a91c6957cda0fb5c1db0a5d02310e367`, tag/GitHub Release `v3.6.4`, package.json and README agree. Main fast-forward completed with only package/README version differences.
- GHCR workflow `34765838301`: succeeded. Native arm64 job `103746731882` and amd64 job `103746731886` each passed native SQLite/sharp/Chromium, 18 migration stages, and 11 backend tests with 160 assertions before merge job `103747283359`.
- Promoted root digest: `sha256:40f1cc5ee4e52c55913630faf257044c038d1b984c041b0a1a8a6763d4628dea`.
- Tested arm64 index: `sha256:24c8f703d2498066ca25be26d13ba9a0136d113209f303b8661a3fed04a37a17`; image manifest `sha256:7d4eac286ab7dc0041c6b412d90807e228d769c6d20b0a5c738c7e7d314561ef`; attestation `sha256:af33baa0b360387c1790de202dbd6d1fec7daea551dabc7b03eef47bef075980`.
- Tested amd64 index: `sha256:f743fb0bfd11b03cfd3f8c5c39f1a48cc5ef81811c45de0b94bf7fb3f18f22dc`; image manifest `sha256:b2e26ec90291d8b87857109359c77fc063bbe0641e14911222573d8205598799`; attestation `sha256:1832fd169dc731ecb2e5e7cd702faa9e51cecf1756aa96964e6a949f5a151679`.
- Delegated manifest verification confirmed that the exact tested architecture/attestation children match the published root.
- Main local exact published-image session `67390` completed exit 0, native smoke and all 18 fixture stages. Log: `test-results/maintenance-published-image.log`. This is published-image acceptance, not live upgraded-production acceptance.

## AI exclusion baseline

- `src/ai-manager.ts` Git blob: `ccdd0b9b906e92219b1f4caacf28f61827e6b70b`.
- Implementation worktree file SHA256: `49A9354146492DE261E825F36D39A257F019E492228A63BFFF09A3BDB8579B57`.
- Direct SDK manifest: `@google/generative-ai` `^0.24.1`; resolved artifact/integrity unchanged.
- Main-task handoff confirms AI implementation remains unchanged and no live AI calls were made. Prior preservation checks found 4 AI UI screenshot pairs pixel-identical and the shared mocked AI regression batch passing.
- Raw parent AI hash differs because of checkout line endings; use Git-normalized content for preservation alongside the implementation byte hash.

## Production evidence and remaining deployment work

Production facts below are from the main task's verified remote investigation; this ledger update performs no remote commands.

- Historical pre-cutover production 3.6.3 was healthy. Earlier public checks returned `/healthz` 200 with database OK, scheduler running, and restartRequired false; `/readyz` 200 ready. Authenticated production UI showed AI off. Old-version health does not satisfy upgraded-deployment acceptance.
- SSH access now works through the ignored owner-only helper with Windows-user DPAPI credentials, six-hour freshness enforcement, and existing verified known_hosts. Do not print credential contents or invoke askpass independently. Main owns credential lifecycle and all remote actions.
- Portainer is version 2.39.5. Its installed public TLS certificate is trusted explicitly over verified SSH; no browser security bypass is required. The Portainer credential handoff is complete and authenticated inspection succeeded.
- Existing Git-managed Compose stack: ID 2, name `tweets2bsky`, endpoint ID 3, project path `/data/compose/2`, entry point `docker-compose.portainer.yml`. Container: `tweets-2-bsky`. Existing persistent volume: `tweets2bsky_data`.
- Preserved previous working image digest: `sha256:7755e700137b1bdb7fdd69a924f7f18f148f73a4d5e147ba6ecce97c71e9de88`.
- Discovered two automatic deployment mechanisms: Portainer Git polling every 15 minutes and Watchtower polling every 3600 seconds. Both are now guarded as recorded below; neither guard redeployed the old app.
- Protected WAL-consistent live baseline snapshot: `/home/ubuntu/.local/state/tweets2bsky-maintenance/baseline-20260913T134653Z/snapshot`. Baseline config schema 8; database version 11. Counts: queue 0, processed 8930, checkpoints 12705, digest entries 0, jobs 0.
- Baseline identity fingerprint: `8c723dac2bfa545e553d7b455aea046cfcd209b6fd77c3b6469ccc959744bea0`. No secret values belong in this ledger.
- Automatic approval review rejected transfer of production config, database, and encryption-key material to a local owner-only ignored folder because specific authorization for that sensitive transfer was absent. No transfer happened. The main task validated the protected snapshot on the server against the published digest, keeping production data and secrets there; copy/migrate/restart passed as recorded below.
- SSH and Portainer authentication work. Production has now moved to the exact verified 3.6.4 digest; only the recorded scheduler/ingress/updater controls were changed for cutover, and their original scheduler/ingress/shared-updater states have since been restored.
- The live baseline snapshot is distinct from the final cutover backup. Actual protected copied-volume rehearsal and the final stopped-writer recovery backup both passed; retain both server-side recovery references.
- The earlier d824648 remote-history check preceded the completed main push and generated 3.6.4 release. Current release and manifest evidence is recorded above; production now runs the verified 3.6.4 digest.
- Historical pre-push history check found main d824648 with zero upstream-only commits and one local implementation commit; the AI source diff was empty. This is superseded for release state by the completed push and generated release above.
- Application-session setup and authenticated read-only 3.6.3 baseline passed; deployed 3.6.4 API/assets also passed. Real post-upgrade UI acceptance remains open after a test-only navigation race.
- Private `test-results/deployment-access/server-copy-test.py` is prepared for the verified published digest. It initializes ownership only on its disposable labeled volume, then runs the image's existing copy/migrate/restart entrypoints as the snapshot owner with network disabled, no ports, read-only root, and all capabilities dropped. Only copy receives the read-only snapshot mount; all disposable-volume mounts use volume-nocopy. The encryption key stays in the server process environment. It verifies source fingerprints and app ID/image preservation, and reports cleanup failures explicitly. Python syntax and mocked isolation, timeout, ownership, hex/base64 key, optional `.jwt-secret`, and unknown-file checks pass. The initial attempts failed before migration, but the final actual server run passed copy/migrate/restart as recorded below. This establishes protected production-copy acceptance, not cutover or live upgraded acceptance.
- Historical blocked audit (superseded by user handoff): three consecutive earlier turns found no Portainer credential file and ended blocked at implementation/evidence commits 76c209c and 7986a97. That access block is resolved, both updater guards were established, and release/push/image acceptance completed. Current open work is the confirmed CSP corrective release and its validation/cutover/live acceptance, not missing access or first-cutover recovery.

## Latest production preflight and completed protected copy test

- Initial actual server attempts `cc9d33b05bff4d58b86664ccc1b5d0dd` and `8564548ebf744098a4d48b4e7c7b04b6` failed during copy, before migration. Source data and the live app ID/image remained unchanged and helper cleanup completed. The initial attempt's exact cause was not proven; do not infer it from later diagnostics.
- Refined diagnostic run with prefix `f99e` identified `copy_files`, exception `Error`, code `EACCES`, after source readability checks passed. Initialization passed; source/app preservation and all five cleanup removals were verified. No raw error messages, production data, or key contents were emitted.
- A local replica using the exact published image demonstrated the helper isolation issue: after successful initialization changed the empty disposable volume to UID/GID 1000, its next default Docker mount reset `/app/data` to UID/GID 0 with mode 0755. Adding `volume-nocopy` to all disposable-volume mounts preserved UID/GID 1000 and passed the local write check. Copy/migrate/restart remain capability-free and execute as the verified snapshot owner; source permissions were not relaxed.
- **PRODUCTION COPY PASS:** actual server run `906a0d3f673342f1948658de6e297474` completed the published image's compiled copy/migrate/restart stages against the protected production baseline snapshot and root digest `sha256:40f1cc5ee4e52c55913630faf257044c038d1b984c041b0a1a8a6763d4628dea`. Source fingerprints and live app ID/image remained unchanged. All five uniquely labeled resources (init, copy, migrate, restart containers and disposable volume) were removed successfully. The repair was confined to private helper isolation; no application-code change or release patch was needed.
- Application-session setup is ready. Public authenticated read-only baseline passed at `2026-09-13 15:46:53 UTC`: app 3.6.3, database version 11, all queue counts 0, assets 2, identity fingerprint `b9d12b2a657ff10373247a5d39ef7f9ac2e99c967ba480e227dc2a774d9ac5f1`. This is a separate later fingerprint from the protected snapshot baseline; preserve each with its recorded context.
- Historical initial ReadScheduler: enabled=true, intervalMinutes=3, runOnStartup=true, revision=22, restartRequired=false. Initial ReadDrain: idle, all counts 0, **quiescenceProven=false**. The later disabled-scheduler/log-reconciled drain and cutover below supersede this preflight state.
- Historical Proxy Inspect succeeded read-only: original config SHA `7bee499a982c52f732f02dd244b8bec8f4814f752a9ab7a2b69a4762507c3167`, gateActive=false, one application-host matcher. The gate was subsequently enabled for cutover; retain this original SHA for exact restore verification.
- Application-helper ownership precheck initially failed. The folder owner was corrected to the current Windows user with `icacls /setowner`, leaving the DACL unchanged; user application-session readiness then succeeded.
- Automatic approval review rejected a risky ACL-descriptor approach and an opaque helper invocation. Main resolved these using the documented owner-only command and complete inline code. No sensitive production configuration/database/key material was transferred locally.
- During the first cutover both updaters were guarded and the old writer exited before replacement. Production 3.6.4 is now healthy, original scheduler/ingress controls restored, shared Watchtower running, and the app remains explicitly pinned/excluded while the corrective release is prepared.
- First corrective 3.6.5 native/image/copy/cutover/continuity/API checks passed. Still open: second exact CDN CSP-origin correction and isolated browser redirect regression, planned 3.6.6 release/image/cutover, final ordinary UI and post-resume acceptance, cleanup/evidence audit. Original controls were restored again; capture fresh handles before another cutover.

## Verified production cutover and pre-resume acceptance

Evidence below is from the main task's actual execution; this ledger update makes no remote or Git calls.

- At `2026-09-13 16:07:18 UTC`, Caddy gate run `e343e6576b0a4b78a5301e59463d58f1` enabled successfully. Gated config SHA: `90c5a9b5d45a2ce8fea912970704120ed370abf1bbbdb8947d2f2202158bd7ba`. Public mutation probe returned 503 and read probe returned 200. Restore must match this exact gated config and recover original SHA `7bee499a982c52f732f02dd244b8bec8f4814f752a9ab7a2b69a4762507c3167`.
- Scheduler disable advanced revision 22 to 23 using retained handle `728bb81e5a2247e99dea920215ec0ca4`; enabled=false, intervalMinutes=3 and runOnStartup=true preserved. This disable was subsequently restored at revision 24 as recorded below.
- Drain evidence at `16:08:35 UTC`: four sweep starts and four matched finishes, last finish `16:06:45 UTC`; one post start and matching success at `16:00:47 UTC`; no failure, retry, timeout, or unmatched work. API and durable queue/digest/backfill counts were all 0. The old writer then stopped with exit 143 and verified PID 0 before backup/replacement.
- Final stopped-writer backup recovery ID: `20260913T160955Z-1204b84a2f2d41899b83f4391a5e7ad2`, under `/home/ubuntu/.local/state/tweets2bsky-maintenance/cutover-20260913T160955Z-1204b84a2f2d41899b83f4391a5e7ad2/`. Database migration 11; processed_tweets 8947, delivery_checkpoints 12738, route_initial_import_state 4; post_queue/digest_entries/digest_jobs/backfill_jobs all 0. Snapshot, key, and original container inspect remain protected on the server.
- Portainer deployment succeeded: app 3.6.4 at root digest `sha256:40f1cc5ee4e52c55913630faf257044c038d1b984c041b0a1a8a6763d4628dea`; release tag and generated commit `f58e6da1a91c6957cda0fb5c1db0a5d02310e367` verified. Existing data volume and four Portainer environment entries preserved; application updater flag=false. New container `5cdbc082c5b0d02a6dd5c3e1d078cecc09f68eeeead706b12baadbf98149467b` is healthy.
- Final-backup continuity Verify passed before resume: database migration 12, exact configuration/canonical identity, critical environment/encryption key, JWT file, and all core rows preserved; only additive migration 12 accepted. No rollback/data restoration was needed.
- Deployed API report `api-deployed-3.6.4.json` passed authenticated live checks with two assets and identity fingerprint unchanged at `b9d12b2a657ff10373247a5d39ef7f9ac2e99c967ba480e227dc2a774d9ac5f1`.
- Sanitized startup logs: five lines, stderr 0, all inspected error categories 0.
- First real UI attempt: anonymous-access checks passed; dashboard check failed because a prior polling response body became unavailable during Playwright navigation. That test synchronization was repaired. The subsequent actual UI attempt consumed all required APIs/headings and anonymous checks passed, but four failed-image/console pairs remain unresolved. Private image-wait and immediate-close diagnostics yielded zero errors; these diagnostics do not waive the actual failure. The worker is adding precise sanitized network diagnostics and image settlement before the final rerun. Later diagnostics established the CSP image-host omission below; actual UI acceptance remains **OPEN** until the corrective image passes.
- Runtime recheck at `2026-09-13 16:16:18 UTC`: still five log lines, stderr 0, inspected error categories 0, scheduler disabled at revision 23, all queue counts 0. This does not substitute for unresolved UI or post-resume acceptance.
- First-cutover gate/scheduler/shared Watchtower restoration subsequently completed. Corrective release validation/cutover and final live acceptance remain **OPEN**; the earlier pre-resume successes do not waive the confirmed CSP defect.

## Corrective CSP release and restored original controls

- Confirmed production UI defect: `src/http-security.ts` CSP `img-src` excludes `video.bsky.app`, blocking live Posts video thumbnails. The earlier navigation synchronization issue was test-only; the remaining image failures now have an application cause. The `portainer_bridge` worker owns the minimal CSP allowlist addition, regression test, and real UI validation. Main owns the corrective 3.6.5 release and deployment. No broad CSP relaxation or unrelated application changes are authorized by this correction.
- Main restored the original scheduler: revision 24, enabled=true, intervalMinutes=3, runOnStartup=true. The original Caddy runtime config SHA `7bee499a982c52f732f02dd244b8bec8f4814f752a9ab7a2b69a4762507c3167` was restored exactly and gateActive=false. Shared Watchtower is running again; the app remains pinned to 3.6.4 root `sha256:40f1cc5ee4e52c55913630faf257044c038d1b984c041b0a1a8a6763d4628dea` with `com.centurylinklabs.watchtower.enable=false`.
- Public normal-access probe after restoration: GET `/readyz` returned 200; harmless unauthenticated POST `/__maintenance_nonexistent_probe__` returned 200 through the SPA fallback, confirming the maintenance 503 is gone. No mutative application route was targeted. The initially guessed 404 expectation is not an application defect.
- Private `final-backup.py` now accepts only complete migrations 1–11 or 1–12 for Snapshot. Verify retains the existing 11-to-12 additive path and adds exact 12-to-12 migration history/table/core/account-block continuity for the corrective release; no extra schema allowances. `app-control.py` explicitly accepts only versions 3.6.3/3.6.4/3.6.5 in both the API and saved scheduler-record guards.
- Focused offline helper fixtures passed real WAL-inclusive backup, 11-to-12 and exact 12-to-12 continuity (including an existing block row), and rejection of extra migrations/history/table/core/block/config/env/JWT changes. Both helpers compile and exactly two explicit scheduler-version guards include 3.6.5. No remote helper invocation or business-code edit was performed in this preparation.
- First corrective 3.6.5 release/image/copy/cutover/continuity/API checks completed. The ordinary UI exposed the second exact redirected CDN origin omission below. Its correction, planned 3.6.6 release and full final acceptance remain required; the overall goal remains incomplete.

## Corrective 3.6.5 release checkpoint

This is supplied completed evidence from the main task; no remote or Git calls or test reruns occur in this ledger update.

- Corrective commit `7ce81eca196bf8a308ffec727971acafd973358b` was pushed. The correction addresses the confirmed video-thumbnail CSP host omission; no dependency changes were made.
- `test-results/maintenance-csp-check-pinned.log`: full gate passed with the intended Bun 1.4.2, all lint/typechecks/build successful, 369 unit + 59 integration + 13 release tests = 441 passed. An earlier untrusted attempt inherited Bun 1.3.14 and encountered EPERM; it is not passing evidence. The successful invocation passes an explicit environment to `Bun.spawn`: `env: {...process.env, PATH: dirname(process.execPath) + ';' + process.env.PATH}`. Merely mutating process.env did not reliably propagate the pinned runtime to the child.
- Corrective Release workflow `34768543332` succeeded and generated `v3.6.5` at commit `5d37d75550b91cafec2cc225e50c8007605337dd`. Tag/GitHub Release/package.json/README agree; main reported clean release state before this ledger update. AI Git blob remains `ccdd0b9b906e92219b1f4caacf28f61827e6b70b`, with no dependency changes.
- Release-tag GHCR run `34768653297` completed successfully. Native arm64 job `103754415740` and amd64 job `103754415774` each passed 18 migration stages plus 11 backend tests with 162 assertions; exact native provenance for the promoted 3.6.5 root was verified. Subsequent image/server/cutover evidence is recorded below.
- At that release checkpoint production remained pinned 3.6.4 with original controls restored. The subsequent second cutover below deployed 3.6.5 and then restored controls again after its ordinary UI failure.
- Automatic approval review rejected an optional standalone diagnostic that would extract video-thumbnail URLs from authenticated app data and fetch them directly from video.bsky.app because that sensitive-data egress was not specifically authorized. It did not execute; no retry or workaround was attempted, and the optional probe was abandoned. Main explained this rejection to the user. Required ordinary deployed-browser acceptance, including normal authorized UI image loading, remains planned and has not been waived.

## Verified 3.6.5 cutover and second exact CSP-origin correction

- 3.6.5 promoted root `sha256:ea73eb8c7c5c55a1a81b4d76d88c05728b31c103fa245fa7e103184cc410927a` passed exact native provenance verification. GHCR run `34768653297` succeeded with both architecture smoke/migration/backend jobs.
- Main local exact-image session `26093` exited 0; log `test-results/maintenance-csp-published-image.log`. Actual server copied-volume run `e178a5b63da248588ffc0e92a15a2853` passed copy/migrate/restart against this root; source/app unchanged and all five disposable resources cleaned up.
- Second Caddy gate run `85c90f357fd948a0ac15ca029a1a9572` enabled at `2026-09-13 16:36:51 UTC`. Scheduler disabled from revision 24 to 25 with handle `b7bfb97fb68f411daaf6fd54f6d23e83`, retaining original three-minute interval and runOnStartup=true.
- Drain reconciled three matched sweeps, last finish `16:32:05 UTC`, latest empty result `16:34:55 UTC`; no active counters, ambiguous work, or errors. The 3.6.4 writer stopped gracefully with exit 0 before final backup/replacement.
- Fresh recovery `20260913T163809Z-503f2a2e2b5d42b1b16a3ea357493852`, protected server-side under the maintenance directory: migration 12, processed_tweets 8947, delivery_checkpoints 12738, route_initial_import_state 4; other core counts 0. This is the new authoritative pre-second-cutover backup, alongside retained prior recovery artifacts.
- Portainer deployed 3.6.5 release commit `5d37d75550b91cafec2cc225e50c8007605337dd` at the above immutable root. New container `87ee1028f482b089d85dce1e525f5753b691b987d505e3affd29e0c14151e48c` is healthy, with the same environment/volume, explicit digest pin, and updater exclusion.
- Exact 12-to-12 continuity passed. Live 3.6.5 API checks passed with the original baseline identity fingerprint unchanged. Ordinary UI anonymous checks passed; Posts images still failed.
- Ordinary authorized browser diagnostics established that video.bsky.app redirects thumbnails to video.cdn.bsky.app, which is also absent from CSP img-src. The worker is adding that second exact image origin and an isolated browser redirect regression. Planned corrective 3.6.6 and final ordinary deployed UI acceptance remain **OPEN**; no wildcard CSP allowance or waiver is appropriate.
- The saved original proxy security headers were verified: `X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: strict-origin-when-cross-origin`. The private probe had incorrectly required stricter application defaults; its expectation was corrected to the original proxy behavior. This mismatch is not an application regression.
- Main restored scheduler revision 25 to 26, enabled=true, intervalMinutes=3, runOnStartup=true. Original Caddy SHA `7bee499a982c52f732f02dd244b8bec8f4814f752a9ab7a2b69a4762507c3167` restored exactly, gateActive=false. Shared Watchtower remains running with app enable=false; production 3.6.5 stays pinned.
- Private app-control.py adds 3.6.6 only to its two explicit API/saved-scheduler-record version guards. Syntax/AST checks confirm exactly those two allowlists; no remote helper execution. Existing 12-to-12 backup continuity needs no change.
- Overall acceptance remains incomplete until the redirected-origin correction passes its final release/image/cutover/live UI and post-resume checks.

## Old-release cutover constraints

### Access and updater guard after user handoff

- Portainer Inspect succeeded using the supplied login; existing stack/environment/volume/source match the discovered target.
- `DisableAutoUpdate` succeeded; stack state fingerprint `703d728faea304c2aff9882684c8c611019f1d3e87bf211aa79addfd2d10d781`. API verification confirmed the existing app ID/image unchanged and healthy, with AutoUpdate null.
- Verified Watchtower belongs to `container-updater`, image `nickfedor/watchtower:latest`, and was running. Stopped only that updater; confirmed it exited and the app remained healthy on the original image. Restore the shared updater after the deployed app has its explicit false Watchtower label.
- The previous access-blocked audit is historical. Application-session setup, release/image tests, gate activation, drain reconciliation, final backup, deployment, and pre-resume API/continuity/log checks completed. The original controls were restored; the confirmed CSP correction and final corrected-release acceptance remain open.

These historical cutover constraints were reviewed against old deployed ref `d824648569450d0dcadc42cf84a8b796195055a3`. Main subsequently disabled only the scheduler and gated external mutations for cutover; original destination/ingestion configuration was preserved.

- The old release has no global maintenance/drain API or signal-driven graceful drain handler. A 60-second Docker stop timeout alone does not establish that publishing drained.
- Gate external mutations and inbound ingestion at the existing reverse proxy, retain a private operator path, and verify no direct-port bypass. The concrete Caddy gate and public deny/read probes passed during cutover. The gate was exactly restored after the confirmed UI defect required a corrective release; re-establish it for the next bounded cutover.
- Capture original scheduler settings and top-level `revision`/`updatedAt` with `GET /api/settings/scheduler`. Update with `PATCH /api/settings/scheduler`, preserving `intervalMinutes` and supplying `enabled:false` plus the current revision; the response supplies the next revision. It prevents new scheduled sweeps but not an active sweep, accepted manual work, pending backfills, or pins.
- Drain within the plan's ten-minute bound. Use fresh status/health/digest API results, durable queue/digest/backfill state, and sanitized sweep/task completion logs together. The earlier empty baseline is not proof of current quiescence.
- Avoid destination state changes if unnecessary. `PATCH /api/destinations/:id/state` with current `revision` and `state:"paused"` preserves queue rows and prevents new queue claims, but it can cancel waiting backfills and discard pending pin work. Require those to be settled first and preserve each original state if this control is needed.
- Destination pause does not stop armed digest jobs in the old release. Do not use digest deletion/cancellation or policy edits as a reversible pause.
- Old post requests can outlive their 120-second Promise.race timeout; zero queue/active-job counters do not establish settled external work. Profile/follow HTTP operations and pending pins are not fully represented in status. Reconcile any timeout or ambiguous acceptance using deterministic record identities/checkpoints before delivery resumes.
- Confirm the old container exited before the authoritative backup and replacement start. Preserve the latest queue/history/checkpoints; never restore the earlier baseline merely to make tests pass. Restore only operator settings actually changed, using current revisions, and reopen ingress after acceptance.
- Original authenticated scheduler capture was enabled=true, intervalMinutes=3, runOnStartup=true, revision=22, restartRequired=false. Scheduler disable advanced revision to 23 while preserving interval/runOnStartup. Later API/durable counts were reconciled with matched sweep/post completion logs before the old writer exited; the earlier idle-only preflight did not establish that evidence.

## Toolchain notes for resume

- Docker Desktop 29.6.2 is available; local candidate container tests passed.
- Official Node 22.22.2 Windows executable is in ignored test artifacts, verified against nodejs.org SHASUMS. Exact release-toolchain rehearsal exited 0; global Node unchanged.
- Bun 1.4.2 is available at `C:/Users/Alex/.bun/install/cache/@oven/bun-windows-x64@1.4.2@@@1/bin/bun.exe`. For package-script children pass `env: {...process.env, PATH: dirname(process.execPath) + ';' + process.env.PATH}` directly to `Bun.spawn`. Neither PowerShell PATH alone nor merely mutating process.env reliably selected the intended runtime; the explicit environment produced the trusted corrective gate.

## Resume instruction

Read this ledger and the saved plan; verify current worktree/main-task state. Preserve passing 3.6.4 and 3.6.5 release/image/production-copy/backup/continuity evidence. Production currently runs healthy pinned 3.6.5 with original scheduler/ingress controls restored, shared Watchtower running, and app updater exclusion retained. Finish only the confirmed video.cdn.bsky.app image-origin addition and isolated browser redirect regression, release planned 3.6.6, validate its native provenance/exact published image, then capture fresh controls and repeat the bounded drain/stopped-writer backup/cutover. Require actual ordinary API/UI/image/security-header/log/data continuity and restored post-resume acceptance for that final digest. Compare proxy headers to the verified original proxy baseline. The optional rejected standalone URL-extraction/fetch probe remains abandoned; normal authorized UI loading and its mandatory acceptance remain required. Retain protected recovery references, complete cleanup/final evidence audit, and report live posting unexercised if no natural delivery occurs during bounded smoke. No manufactured posts, observation soak, or completion claim before final acceptance.