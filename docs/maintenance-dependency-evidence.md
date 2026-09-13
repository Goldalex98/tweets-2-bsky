# Maintenance dependency and image evidence

Recorded 2026-09-13 in `.worktrees/maintenance-upgrade`, based on origin/main `d824648` (3.6.3). Implementation and independent reviews are complete; no implementation commits, pushes, release, or deployment yet. Final integrated local validation passed. Earlier candidates below are retained as historical checkpoints; native arm64, the published immutable digest, protected production-snapshot rehearsal, and live deployment acceptance remain open.

## Selected versions

| Group | Exact selections |
| --- | --- |
| Runtime | Bun / @types/bun 1.4.2; release/Quality Node 22.22.2; @types/node 22.20.2 |
| Backend | @atproto/api 0.20.44; Axios 1.20.0; better-sqlite3 13.0.3 / types 9.6.0; Commander 15.0.0; Inquirer 14.2.2; Puppeteer Core 25.10.0; Sharp 0.35.4 |
| UI | React / React DOM / their types 19.3.0; Lucide 1.45.0; tailwind-merge 3.7.0 |
| Frontend tooling | Vite 8.3.0 / React plugin 6.1.1; Tailwind and @tailwindcss/postcss 4.3.3; PostCSS 8.5.28 |
| Compiler/test/lint | TypeScript 7.0.2; Biome 2.5.13; Playwright 1.63.0; tsx 4.23.13 |
| Release | semantic-release 25.0.9; Git plugin 11.0.1; GitHub plugin 12.0.9; notes generator 14.1.1; existing analyzer 13.0.1 / exec 7.1.0 |
| Security overrides | brace-expansion 5.0.9; qs 6.16.0; js-yaml 4.3.2; ip-address 10.7.0 |

The latter three compatible transitive overrides dislodge vulnerable versions retained by the original lockfile. The obsolete sigstore override was removed: the resolved release tree now supplies patched npm 11.19.1 / pacote 21.5.1 naturally. No extract-zip remains. Nanoid resolves to 3.3.19. Removed redundant @types/bcryptjs, @types/cheerio, @types/sharp, @types/inquirer after verifying bundled declarations and typechecking. Autoprefixer removed with the coordinated Tailwind PostCSS migration.

AI SDK remains `@google/generative-ai: ^0.24.1`, resolved artifact 0.24.1 with unchanged original sha512 integrity. No AI implementation changes. Other unchanged direct packages retain their original ranges.

## Historical dependency checkpoint checks

| Check | Result |
| --- | --- |
| Baseline `bun install --frozen-lockfile` | Exit 0; UI baseline captured before upgrading packages |
| Bun 1.4.2 `install --frozen-lockfile` after upgrades | Exit 0; no lockfile changes |
| `bun audit --audit-level=high` | Exit 0; **no vulnerabilities**, 724 packages audited |
| `bun run typecheck:server`, `bun run verify:deps` | Exit 0; TypeScript 7 and installed scraper/Bluesky exports compatible |
| `bun test tests/integration/cli-policy-parity.test.ts tests/integration/ai-provider.test.ts tests/integration/backup-restore.test.ts` | 11 pass, 0 fail, 63 assertions |
| `bun run build` under actual Bun 1.4.2 throughout nested scripts | Exit 0; compiled backend and Vite 8 frontend; existing large-chunk advisory remains informational |
| `node scripts/release-toolchain-preflight.mjs` | Exit 0 on local Node 24.18.0; checks Node 22.22.2 against each plugin engine, imports configured plugins, tests patch/minor/no-release commit analysis and notes generation |
| `bun test tests/release/toolchain.test.ts` | 1 pass, 0 fail; same offline release invariant rehearsal |
| `bun scripts/image-runtime-smoke.ts` with Playwright Chromium 1243 | Exit 0 on Windows x64: better-sqlite3 SQL, Sharp encode/resize/decode, Puppeteer launch/screenshot/process exit |
| Local compiled `image-data-smoke.ts` | All 15 stages pass: five v0/v1/v6/v7/v8 config fixtures, database v1 migration, seed/restart/restore |
| Scoped Biome checks for worker scripts/tests | Exit 0 after formatting |

Local nested Bun note: PowerShell PATH prepending alone did not change the PATH seen by nested package scripts. Use the cached native executable `C:/Users/Alex/.bun/install/cache/@oven/bun-windows-x64@1.4.2@@@1/bin/bun.exe` and set `process.env.PATH = require('node:path').dirname(process.execPath) + ';' + process.env.PATH` inside a Bun wrapper before spawning `[process.execPath, 'run', '<script>']`. The exact-version prebuild guard detects incorrect nested runtime use. No global Bun installation was changed.

## Historical candidate image evidence

`docker build --tag tweets-2-bsky:maintenance-validation .` completed on local Linux amd64 Docker 29.6.2.

- Local image index: `sha256:9a02d94505f3d21db12d128f310fc575e88b1a398eb38a517718bfda8040e63d`.
- Platform image manifest: `sha256:c0909f9378c404d6b73139d49d22c3b75a3ec3ad7e13f1260334dd9c84d5d619`.
- Image config: `sha256:f16302667ce0a077b9258f9067d6a35a3a2077992c3b7d77347679a2c750f0d7`.
- `validateImage('tweets-2-bsky:maintenance-validation', false)` exited 0: fresh-container `/readyz` and Docker health; actual Linux native SQLite/Sharp/Chromium rendering and cleanup; all 15 compiled migration/restart/full-backup-restore stages.
- Data stages run separate containers with `--network none`, disposable volumes and fixture-only encryption keys. Assert account/source/destination/route/storage identity; exact queue/history/checkpoint/digest/migration contents; migration idempotency; retained rollback artifacts; pending restore applied on restart.
- `bun scripts/container-backend-tests.ts --image tweets-2-bsky:maintenance-validation` exited 0: **7 tests, 106 assertions** covering real auth/session/CSRF, account linking, source policy, queue health, ingestion and backup under the candidate runtime. This mounts source fixtures read-only and is explicitly distinct from compiled-artifact validation.

Release now depends on reusable Quality. Quality runs an offline release rehearsal under exact Node 22.22.2. Each native amd64/arm64 publishing job validates its pushed digest with compiled/native/browser/data tests and the isolated backend fixture suite **before** exporting the digest to tag promotion. Release-tag publisher dispatch remains intact; no npm publication plugin enabled.

## Final integrated local validation

Existing final logs were inspected without rerunning checks. The main task records exit 0 for both final validation processes and the exact Node rehearsal.

- `test-results/maintenance-final-check.log`: full Bun 1.4.2 `bun run check` passes dependency verification, lint, both typechecks, build, and **369 unit + 59 integration + 13 release = 441 tests**, zero failures (summary lines 915, 1035, 1061).
- `test-results/maintenance-release-validation.log`: frozen install completes without changes; **zero vulnerabilities across 724 audited packages** (line 6). Playwright **21 passed, 4 optional capture tests skipped** (lines 118–119).
- The integrated local candidate is `tweets-2-bsky:release-validation`, local image ID `sha256:e3c8b943586a50cf58e7dbb8b5f1050ac6ef89284d13bb8489dd785747c4152c` (main-task handoff). Linux amd64 native SQLite/Sharp and Chromium render/cleanup pass. All **18 compiled image fixture stages** pass across six seed/restart/restore configurations, including populated v6 and current v8 (lines 120–149).
- Separate real-backend source fixtures pass inside the candidate runtime with **no external network: 11 tests, 160 assertions**, zero failures (lines 182–187). Running-container readiness and release validation pass. The harness wording “Published image readiness” refers here to a local candidate tag; it does not prove a published registry artifact.
- Exact **Node 22.22.2** offline release-toolchain rehearsal also exited 0 locally. The official Windows executable is under ignored `test-results/toolchain`, SHA256-verified against the published nodejs.org SHASUMS. This supersedes the earlier Node 24.18.0 local checkpoint; global Node was not changed.
- These results apply to the integrated working tree/local image. Record the eventual release-bearing commit and published manifest digest separately. Recheck affected validation if subsequent code changes warrant it.

## Outstanding release and production evidence

- No commit or push yet. First guard the existing stack's 15-minute Portainer Git updater and 3600-second Watchtower updater; both remain enabled. Portainer credentials are pending, while verified SSH access works.
- Actual semantic-release remote `--dry-run`, GitHub workflow outcomes, generated release tag/version, and registry publication remain orchestrator-owned. Local offline rehearsal does not prove a remote release occurred.
- Native arm64 runtime tests remain required on the configured CI runner; no local arm64 pass is claimed.
- Validate the final published `repository@sha256:digest` using `bun run release:validate -- --image <digest>`; this mode pulls and tests the artifact without rebuilding local code.
- Validate the protected WAL-consistent production snapshot **on the server** against the published digest. Automatic approval review rejected a proposed local transfer of config/database/encryption-key material because specific sensitive-transfer authorization was absent; no transfer occurred. Production data and secrets remain on the server. Fixture copied-volume checks are not actual production-snapshot evidence.
- Final quiesced rollback backup, existing-stack cutover, and actual deployed authenticated API/UI acceptance remain open. Production 3.6.3 is healthy, but the upgraded application has not been deployed.

## Review follow-up: independent pre-upgrade state and protected copied volumes

The original empty-v1-database fixture check above is superseded. The image matrix now builds a **populated v7 database before importing current config/database modules**: retried queue row and immutable policy, accepted history URI, partially completed thread checkpoint, digest entry and digest job. It captures original-column row fingerprints and original legacy/canonical config identity/credential fingerprints before migration. After upgrade it verifies every original row/value survives (allowing additive columns and new migration records), then performs the existing restart/full-backup-restore checks. This covers the v8 queue-table rebuild instead of accepting an already-migrated database as its own baseline.

New invocation for an independently protected, frozen, WAL-consistent production snapshot directory:

```text
bun run release:validate -- --image repository@sha256:digest --copied-volume <protected-snapshot-directory>
```

Supply the matching `CONFIG_ENCRYPTION_KEY` through the protected execution environment, never a command-line value. The directory must contain config.json and database.sqlite plus any matching WAL/SHM companions; pending restores and nonregular/symlink inputs are rejected. This mode returns before the ordinary fresh-app smoke starts. It mounts the snapshot read-only only while copying selected files into a disposable volume, checks files did not change during copying, and runs separate copy/migrate/restart entrypoints with **network disabled, no exposed ports, read-only root filesystem, all capabilities dropped and no scheduler/server/provider imports**. Every pre-existing database table is compared using fingerprints of original columns; canonical account/storage/route identity and credentials are hashed. It validates a full backup without applying a restore to the production copy. Source files are never changed; the clone is removed afterward. Imported-module logs and raw error causes are suppressed. Console output contains only stage results.

Historical focused verification (superseded by the final integrated local validation above):

- `bun test tests/release/image-data-invariants.test.ts`: **2 pass, 7 assertions**, including negative tests for lost rows, changed retry state, changed storage identity/credentials, and absence of raw policy values from evidence.
- Updated compiled local matrix: **15/15 stages pass**.
- Rebuilt `tweets-2-bsky:maintenance-validation-review`, image index `sha256:3ce8b0fa73075bf2772582884669e91fa3756ec009bd59f17c7453c2961f2627`: native/browser/readiness plus **15/15 populated pre-upgrade stages pass** on Linux amd64.
- Protected-copy mode against two independently cloned redacted fixture snapshots (one with populated account/source/destination identities): **copy/migrate/restart all pass**, no application process or external network.
- Scoped Biome formatting/checks passed at this checkpoint. The final integrated rebuild and 18-stage matrix subsequently passed as recorded above. Real production-snapshot and final published-digest acceptance remain open.
