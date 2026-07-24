# tweets-2-bsky Enhancement Implementation Plan

**Repository:** `Goldalex98/tweets-2-bsky`  
**Target branch:** `master`  
**Primary runtime:** Bun, TypeScript, Express, React, SQLite  
**Purpose:** Evolve the project from a basic X-to-Bluesky mapping tool into a safer, clearer, aggregate-account-friendly cross-posting platform.

---

## 1. Executive Summary

The repository already supports multiple X usernames in one `AccountMapping`, and the scheduler already iterates through every username in `mapping.twitterUsernames`. The main problems are configuration visibility, unsafe defaults for aggregate destinations, and a UI that still presents a many-to-one mapping as though it were a single account connection.

The first release should solve four immediate issues:

1. Expose the global refresh interval in the web UI and apply changes without restarting the container.
2. Add an explicit profile-management policy so adding a source does not unexpectedly change the Bluesky profile.
3. Replace the unconditional X source prefix with a configurable attribution policy.
4. Make bulk source entry and editing obvious for aggregate Bluesky accounts.

The longer-term enhancement should add per-source controls, better queue management, health monitoring, safer backups, stronger testing, and a gradual frontend/backend split.

### Recommended implementation order

| Phase | Focus | Risk | User value |
|---|---|---:|---:|
| 0 | Baseline tests and behavior capture | Low | Foundation |
| 1 | Versioned config and policy types | Medium | Foundation |
| 2 | Attribution and profile safety | Medium | Very high |
| 3 | Scheduler settings | Low | High |
| 4 | Aggregate destination workflow | Medium | Very high |
| 5 | Per-source configuration | Medium-high | High |
| 6 | Queue, health, and diagnostics | Medium | High |
| 7 | Security and backup improvements | Medium | High |
| 8 | Architecture cleanup | Medium-high | Maintainability |
| 9 | Optional advanced features | Variable | Medium-high |

---

## 2. Current Repository Findings

The following findings drive this plan.

### 2.1 Many-to-one mappings already exist

`AccountMapping` currently stores:

```ts
interface AccountMapping {
  id: string;
  twitterUsernames: string[];
  bskyIdentifier: string;
  bskyPassword: string;
  // ...
}
```

The fetch sweep builds one work item for each username inside each enabled mapping. This means the backend already supports:

```text
X account A ┐
X account B ├──> one Bluesky destination
X account C ┘
```

The primary missing pieces are UI clarity and destination-safe policies.

### 2.2 Source attribution is currently unconditional

The posting pipeline currently adds this prefix to every thread root:

```ts
if (!replyParentInfo) {
  text = `Source: @${twitterUsername} on X\n\n${text}`.trim();
}
```

This is useful for aggregate accounts but unnecessary for one-to-one mirrors. It also consumes Bluesky text capacity and can cause posts to split into additional thread segments.

### 2.3 Profile sync defaults to the first X source

The config normalizer currently resolves `profileSyncSourceUsername` to the first username when the configured value is missing or invalid:

```ts
const resolvedProfileSyncSource =
  profileSyncSourceUsername && usernames.includes(profileSyncSourceUsername)
    ? profileSyncSourceUsername
    : usernames[0];
```

For an aggregate destination, the first source is not a safe default. Adding or editing sources can therefore leave the Bluesky profile tied to an arbitrary X account.

### 2.4 Profile mutation is broader than scheduled profile sync

The profile subsystem includes several different operations:

- Display-name synchronization
- Description synchronization
- Avatar synchronization
- Banner synchronization
- Bot self-label management
- Display-name bot suffix management
- Pinned-post synchronization
- Automatic scheduled profile checks
- Manual profile sync operations

These should not be controlled by one vague “profile sync source” field. Every persistent profile mutation should be governed by an explicit policy.

### 2.5 Refresh interval exists in config but not as a normal setting

`AppConfig` already contains:

```ts
checkIntervalMinutes: number;
```

The default is five minutes. The status API already returns the active interval, and the scheduler reloads configuration during its loop. The missing work is a validated settings endpoint, scheduler recalculation, and a GUI control.

### 2.6 The durable queue is a strong base

The repository already separates the Twitter fetch sweep from Bluesky post workers and persists queued posts in SQLite. This architecture should be preserved. New posting policies should be evaluated by the worker using the current mapping configuration unless deterministic policy snapshots are later required.

### 2.7 Testing is mostly script-based

The package includes targeted pipeline scripts but no standard unit-test command or test framework configuration. Bun already provides `bun:test`, so a useful test suite can be added without introducing Vitest.

---

## 3. Goals

### 3.1 Product goals

1. Make aggregate destinations a first-class use case.
2. Prevent accidental Bluesky profile changes.
3. Make source attribution configurable and previewable.
4. Allow bulk source creation and editing.
5. Expose scheduler controls safely.
6. Provide source-level operational visibility.
7. Improve failure recovery without requiring direct SQLite or JSON editing.
8. Preserve compatibility with existing deployments and persistent Docker volumes.

### 3.2 Engineering goals

1. Add versioned config migrations.
2. Centralize policy normalization and validation.
3. Move text transformation out of `src/index.ts`.
4. Split large route and UI files gradually.
5. Add automated unit and API tests.
6. Make database migrations explicit and repeatable.
7. Avoid large rewrites before behavior is covered by tests.

### 3.3 Non-goals for the first release

The following should not block the initial enhancement release:

- Replacing the Twitter scraper
- Replacing SQLite
- Converting the application into a multi-node distributed service
- Supporting arbitrary workflow scripting
- Building a full social media management suite
- Adding AI rewriting before existing AI behavior is clearly labeled and controlled

---

## 4. Design Principles

### 4.1 One mapping equals one Bluesky destination

Keep this mental model:

```text
Mapping = one Bluesky destination + one or more X sources + destination policies
```

Do not create a separate mapping for every X source when they all post to the same Bluesky account.

### 4.2 New aggregate destinations must be safe by default

For a mapping with multiple sources:

- Profile mutation: off
- Pin synchronization: off
- Attribution: enabled when multiple sources are present
- Bot label: explicit opt-in
- Display-name suffix: explicit opt-in

### 4.3 New one-to-one destinations should be quiet by default

For a mapping with one source:

- Attribution: off
- Profile mutation: off unless selected during onboarding
- Pin synchronization: off unless selected
- Bot label: optional and clearly explained

### 4.4 Existing behavior should not change silently

Migrations should preserve existing behavior where practical. After migration, show an admin review banner identifying mappings that still have automatic profile changes enabled.

### 4.5 Credentials and operational settings should be separated

Editing sources, attribution, filters, or profile behavior should not require re-entering the Bluesky app password.

### 4.6 Basic settings and advanced tuning should remain separate

The GUI should expose the polling interval. Low-level scraper risk settings such as request gap, concurrency, and jitter should remain environment variables initially, with read-only diagnostic display in an Advanced section.

---

## 5. Target Configuration Architecture

## 5.1 Add schema versioning

Extend `AppConfig`:

```ts
export interface AppConfig {
  schemaVersion: number;
  twitter: TwitterConfig;
  mappings: AccountMapping[];
  groups: AccountGroup[];
  users: WebUser[];
  scheduler: SchedulerConfig;
  ai?: AIConfig;
}
```

Recommended initial version:

```ts
export const CURRENT_CONFIG_SCHEMA_VERSION = 2;
```

The legacy `checkIntervalMinutes` field should be migrated into `scheduler.intervalMinutes`.

## 5.2 Scheduler configuration

```ts
export interface SchedulerConfig {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
}
```

Recommended defaults:

```ts
const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  enabled: true,
  intervalMinutes: 5,
  runOnStartup: false,
};
```

Future-compatible fields can be added later:

```ts
interface FutureSchedulerConfig {
  jitterSeconds?: number;
  activeHours?: {
    timezone: string;
    start: string;
    end: string;
  };
}
```

Do not add active hours in the first implementation unless there is a real use case. OSINT feeds tend to ignore office hours with impressive dedication.

## 5.3 Posting policy

```ts
export type AttributionMode = 'never' | 'multiple-sources' | 'always';

export interface AttributionPolicy {
  mode: AttributionMode;
  template: string;
  rootPostsOnly: boolean;
  linkSource: boolean;
}

export interface PostingPolicy {
  attribution: AttributionPolicy;
  appendOriginalPostLink: boolean;
}
```

Recommended defaults:

```ts
export const DEFAULT_ATTRIBUTION_TEMPLATE = 'Source: @{username} on X';

export function defaultPostingPolicy(sourceCount: number): PostingPolicy {
  return {
    attribution: {
      mode: sourceCount > 1 ? 'multiple-sources' : 'never',
      template: DEFAULT_ATTRIBUTION_TEMPLATE,
      rootPostsOnly: true,
      linkSource: true,
    },
    appendOriginalPostLink: false,
  };
}
```

Supported template variables for the first release:

| Variable | Value |
|---|---|
| `{username}` | Normalized X username without `@` |
| `{url}` | `https://x.com/{username}` |
| `{postUrl}` | Original X post URL |
| `{destination}` | Bluesky destination identifier |

Reject unknown template variables instead of silently producing broken text.

## 5.4 Profile management policy

Use one master policy with independent subfeatures:

```ts
export type SyncMode = 'off' | 'manual' | 'scheduled';

export interface ProfileFieldPolicy {
  displayName: boolean;
  description: boolean;
  avatar: boolean;
  banner: boolean;
}

export interface ProfileSyncPolicy {
  mode: SyncMode;
  sourceUsername?: string;
  intervalHours: number;
  fields: ProfileFieldPolicy;
}

export interface PinSyncPolicy {
  mode: SyncMode;
  sourceUsername?: string;
  intervalHours: number;
}

export interface ProfileManagementPolicy {
  allowProfileMutation: boolean;
  ensureBotLabel: boolean;
  ensureDisplayNameBotSuffix: boolean;
  profileSync: ProfileSyncPolicy;
  pinSync: PinSyncPolicy;
}
```

Recommended aggregate defaults:

```ts
export function defaultAggregateProfilePolicy(): ProfileManagementPolicy {
  return {
    allowProfileMutation: false,
    ensureBotLabel: false,
    ensureDisplayNameBotSuffix: false,
    profileSync: {
      mode: 'off',
      intervalHours: 24,
      fields: {
        displayName: false,
        description: false,
        avatar: false,
        banner: false,
      },
    },
    pinSync: {
      mode: 'off',
      intervalHours: 24,
    },
  };
}
```

Recommended one-to-one defaults should be identical unless the user explicitly chooses profile mirroring during onboarding.

### Master safety rule

No operation may call a Bluesky profile mutation function unless:

```ts
mapping.profileManagement.allowProfileMutation === true
```

Then each operation must also check its specific flag.

Examples:

```ts
if (
  mapping.profileManagement.allowProfileMutation &&
  mapping.profileManagement.ensureBotLabel
) {
  await ensureBlueskyBotSelfLabel(...);
}
```

```ts
if (
  mapping.profileManagement.allowProfileMutation &&
  mapping.profileManagement.profileSync.mode === 'scheduled'
) {
  await maybeSyncProfile(...);
}
```

## 5.5 Transitional `AccountMapping` model

Phase 1 should preserve `twitterUsernames` to minimize risk:

```ts
export interface AccountMapping {
  id: string;
  twitterUsernames: string[];

  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;

  enabled: boolean;
  owner?: string;
  groupName?: string;
  groupEmoji?: string;
  createdByUserId?: string;

  postingPolicy: PostingPolicy;
  profileManagement: ProfileManagementPolicy;

  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  lastPinnedTweetId?: string;
  lastPinSyncAt?: string;
  hasBotLabel?: boolean;
}
```

This delivers the immediate functionality without rewriting every loop.

## 5.6 Future canonical source model

After the policy release is stable, migrate to:

```ts
export interface TwitterSourceConfig {
  id: string;
  username: string;
  enabled: boolean;
  filters: SourceFilterPolicy;
  schedule?: SourceScheduleOverride;
}

export interface AccountMapping {
  // ...
  sources: TwitterSourceConfig[];
}
```

During one compatibility release, expose a helper:

```ts
export function getMappingUsernames(mapping: AccountMapping): string[] {
  if (Array.isArray(mapping.sources)) {
    return mapping.sources
      .filter((source) => source.enabled)
      .map((source) => source.username);
  }

  return mapping.twitterUsernames ?? [];
}
```

Do not maintain both serialized forms indefinitely. Migrate to `sources` and remove `twitterUsernames` in a later schema version.

---

## 6. Configuration Migration Plan

## 6.1 Migration framework

Replace implicit shape-only normalization with explicit version steps:

```ts
export function migrateConfig(raw: unknown): AppConfig {
  let working = normalizeRawObject(raw);
  let version = normalizeSchemaVersion(working.schemaVersion);

  if (version < 1) {
    working = migrateV0ToV1(working);
    version = 1;
  }

  if (version < 2) {
    working = migrateV1ToV2(working);
    version = 2;
  }

  return normalizeConfigV2(working);
}
```

Create:

```text
src/config/
  defaults.ts
  migrations.ts
  normalize.ts
  schemas.ts
```

This can be delayed until the initial behavior is covered by tests, but the migration functions should be introduced before adding several new nested settings.

## 6.2 Legacy migration rules

### Scheduler

```ts
scheduler.intervalMinutes =
  legacy.checkIntervalMinutes ?? 5;
```

### Attribution

The current fork prefixes every root post. Existing mappings should preserve that behavior:

```ts
postingPolicy.attribution.mode = 'always';
```

New mappings should use source-count-aware defaults:

```ts
sourceCount > 1 ? 'multiple-sources' : 'never';
```

### Profile synchronization

Because legacy normalization assigns the first source, a migration cannot reliably determine whether profile sync was intentionally enabled. Preserve current behavior but mark the mapping for review:

```ts
profileManagement.allowProfileMutation = true;
profileManagement.profileSync.mode = 'scheduled';
profileManagement.profileSync.sourceUsername =
  legacy.profileSyncSourceUsername ?? legacy.twitterUsernames[0];
```

Add:

```ts
migrationReview?: {
  profilePolicyNeedsReview?: boolean;
}
```

Alternatively, keep migration metadata in a top-level `migrationNotices` array rather than permanent mapping data.

### Pin synchronization

Preserve current source selection but separate it:

```ts
profileManagement.pinSync.sourceUsername =
  legacy.profileSyncSourceUsername ?? legacy.twitterUsernames[0];

profileManagement.pinSync.mode = 'scheduled';
```

### Bot label and display suffix

Preserve known state but do not infer intent from `hasBotLabel`. Add explicit fields and mark them for review if the onboarding flow previously applied them automatically.

## 6.3 Migration safety

Before writing a migrated config:

1. Write `config.json.pre-v2-backup`.
2. Validate the complete migrated shape.
3. Write atomically using the existing temp-file and rename pattern.
4. Log the old and new schema versions.
5. Never log credentials.
6. If migration fails, continue using the untouched legacy file and show a blocking admin error.

## 6.4 Admin migration banner

After upgrading:

```text
Configuration upgraded

3 destinations still allow automatic Bluesky profile changes based on legacy
behavior. Review these settings before adding or removing X sources.

[Review destinations] [Dismiss]
```

Dismissal should be stored in config or user preferences, not only local storage.

---

## 7. Posting Attribution Implementation

## 7.1 Extract a post-transformation module

Create:

```text
src/post-transform.ts
```

Suggested types:

```ts
export interface PostTransformContext {
  twitterUsername: string;
  tweetId: string;
  originalPostUrl: string;
  destinationIdentifier: string;
  sourceCount: number;
  isReply: boolean;
  isThreadRoot: boolean;
}

export interface PostTransformResult {
  text: string;
  attributionApplied: boolean;
  originalLinkApplied: boolean;
}
```

Core function:

```ts
export function applyPostingPolicy(
  inputText: string,
  policy: PostingPolicy,
  context: PostTransformContext,
): PostTransformResult
```

## 7.2 Attribution decision helper

```ts
export function shouldApplyAttribution(
  policy: AttributionPolicy,
  sourceCount: number,
  isThreadRoot: boolean,
): boolean {
  if (policy.rootPostsOnly && !isThreadRoot) {
    return false;
  }

  switch (policy.mode) {
    case 'always':
      return true;
    case 'multiple-sources':
      return sourceCount > 1;
    case 'never':
    default:
      return false;
  }
}
```

## 7.3 Pass mapping policy into posting

The current `processTweets` call receives usernames and identifiers but not the complete mapping policy. Change it to accept a context object:

```ts
interface ProcessTweetsContext {
  mapping: AccountMapping;
  twitterUsername: string;
  agent: BskyAgent;
  dryRun: boolean;
  sessionKey: string;
}
```

Preferred signature:

```ts
async function processTweets(
  context: ProcessTweetsContext,
  tweets: Tweet[],
  state?: ProcessTweetsState,
): Promise<void>
```

A smaller first change can add `mapping: AccountMapping` as one parameter. Avoid attempting the complete signature refactor in the same pull request as policy behavior unless tests are already in place.

## 7.4 Policy behavior for queued posts

Recommended first behavior:

- Read the current mapping and policy when the queue item is claimed.
- Apply the latest saved policy at posting time.
- Do not add policy JSON to every queue row yet.

Document this clearly:

> A queued post uses the destination’s current posting policy when it is posted.

A future `policy_snapshot` column can be added if audit-grade reproducibility becomes necessary.

## 7.5 Linkable attribution

When `linkSource` is enabled, the attribution should contain a facet pointing to:

```text
https://x.com/{username}
```

Do not rely only on plain text. Use the existing `RichText` facet detection or manually add a link facet after template rendering.

## 7.6 Text-limit behavior

The preview and posting pipeline must use the same transformation function before `splitText`.

Tests must verify:

- Prefix can push a post into a second chunk.
- No content is lost.
- Unicode grapheme handling remains correct.
- A long custom template cannot create an empty content chunk.
- Attribution is placed only on the first chunk.
- Replies do not receive attribution when `rootPostsOnly` is true.

## 7.7 GUI controls

Under a destination’s **Posting** tab:

```text
Source attribution

( ) Never
( ) Only when this destination has multiple X sources
( ) Always

Template
[ Source: @{username} on X                         ]

[x] Link the source name to the X profile
[x] Add attribution only to thread roots
[ ] Append a link to the original X post
```

Add a live preview using the same frontend-compatible rules:

```text
Source: @Osinttechnical on X

Example post text...
```

The server remains the source of truth. The frontend preview is advisory.

---

## 8. Profile Management Implementation

## 8.1 Gate all profile mutations

Audit every call to:

- `syncBlueskyProfileFromTwitter`
- `ensureBlueskyBotSelfLabel`
- `ensureBlueskyDisplayNameBotSuffix`
- pinned-post synchronization helpers
- direct `upsertProfile`
- direct actor-profile record updates

Each call must be covered by an explicit policy check.

## 8.2 Remove first-source fallback for multi-source mappings

Change source resolution:

```ts
export function resolveProfileSyncSource(
  mapping: AccountMapping,
): string | undefined {
  const configured =
    mapping.profileManagement.profileSync.sourceUsername;

  if (
    configured &&
    mapping.twitterUsernames.includes(configured)
  ) {
    return configured;
  }

  if (mapping.twitterUsernames.length === 1) {
    return mapping.twitterUsernames[0];
  }

  return undefined;
}
```

For multiple sources, no selection means no profile sync.

Apply the same rule to pin sync.

## 8.3 Separate profile and pin schedules

Do not use `profileSyncSourceUsername` for pin synchronization. Profile and pin policies should have independent source fields and modes.

## 8.4 Profile preview endpoint

Add:

```http
POST /api/mappings/:id/profile/preview
```

Response:

```json
{
  "sourceUsername": "example",
  "current": {
    "displayName": "Current destination",
    "description": "Current description",
    "avatarUrl": "...",
    "bannerUrl": "..."
  },
  "proposed": {
    "displayName": "Example [bot]",
    "description": "Unofficial mirror...",
    "avatarUrl": "...",
    "bannerUrl": "..."
  },
  "changes": {
    "displayName": true,
    "description": false,
    "avatar": true,
    "banner": false
  }
}
```

Do not modify the profile during preview.

## 8.5 Manual apply endpoint

```http
POST /api/mappings/:id/profile/apply
```

Request:

```json
{
  "sourceUsername": "example",
  "fields": {
    "displayName": true,
    "description": false,
    "avatar": true,
    "banner": true
  }
}
```

Require:

- Permission to manage the mapping
- `allowProfileMutation === true`
- A valid source in the mapping
- Explicit selected fields

## 8.6 GUI controls

Under **Profile & Identity**:

```text
Allow this application to modify the Bluesky profile
[ off ]

When off, the application will not change the display name, bio, avatar,
banner, bot label, or pinned post.
```

When enabled:

```text
Profile synchronization
Mode: Off / Manual only / Scheduled
Source: @example
Every: 24 hours

Fields
[x] Display name
[ ] Description
[x] Avatar
[x] Banner

Identity markers
[ ] Ensure Bluesky bot self-label
[ ] Add the mirror bot suffix to the display name

Pinned post
Mode: Off / Manual only / Scheduled
Source: @example
Every: 24 hours
```

Show a prominent warning for aggregate destinations:

```text
This destination receives posts from 8 X accounts. Mirroring one source's
profile may make the destination look like that individual account.
```

## 8.7 Onboarding behavior

The creation wizard must never mutate the Bluesky profile simply because credentials were validated.

Credential validation should perform only:

- Login
- Session retrieval
- Handle/DID resolution
- Permission/error checks

Profile changes should occur only after the user reaches the Profile & Identity step and explicitly enables them.

---

## 9. Scheduler Settings Implementation

## 9.1 API

Add:

```http
GET /api/settings/scheduler
PATCH /api/settings/scheduler
```

GET response:

```json
{
  "enabled": true,
  "intervalMinutes": 5,
  "runOnStartup": false,
  "lastCheckTime": 1784900000000,
  "nextCheckTime": 1784900300000,
  "enabledSourceCount": 14,
  "estimatedChecksPerHour": 168
}
```

PATCH request:

```json
{
  "enabled": true,
  "intervalMinutes": 3,
  "runOnStartup": false
}
```

Validation:

```ts
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
```

Return `400` for non-numeric, missing, or out-of-range values. Do not silently turn invalid values into five minutes at the API boundary.

## 9.2 Dynamic scheduler recalculation

When settings are saved:

1. Save config.
2. Recalculate `nextCheckTime`.
3. Signal the scheduler wake mechanism.
4. Do not automatically run a sweep unless the user clicked **Run now**.
5. Return the updated next-run time.

Add a server helper:

```ts
export function recalculateNextCheckTime(
  intervalMinutes: number,
): number {
  nextCheckTime = Date.now() + intervalMinutes * 60_000;
  signalSchedulerWake();
  return nextCheckTime;
}
```

The scheduler already reloads config and watches a wake signal, so no process restart should be required.

## 9.3 Disabled scheduler behavior

When `scheduler.enabled === false`:

- Scheduled sweeps do not run.
- Manual **Run now** remains available.
- Backfills and manual pin/profile actions remain available.
- Post workers continue draining already queued items unless the destination is disabled.

## 9.4 Settings UI

Add **Settings → Scheduler**:

```text
Automatic checks
[x] Enable scheduled checks

Check every
[ 3 ] minutes

Presets: [1] [2] [5] [10] [15] [30]

Last completed check: 11:34:22 AM
Next scheduled check: 11:37:22 AM
Enabled sources: 14
Estimated source checks per hour: 280
```

Add explanatory text:

> This interval controls how often the app begins a sweep. Twitter requests are still paced by the global scraper gap and concurrency limits.

## 9.5 Advanced read-only diagnostics

Display current environment-derived values:

- `SCRAPER_MIN_GAP_MS`
- `SCRAPER_JITTER_MS`
- `FETCH_CONCURRENCY`
- `POST_WORKER_CONCURRENCY`
- `POST_PACING_MIN_MS`
- `POST_PACING_MAX_MS`
- `QUEUE_MAX_ATTEMPTS`
- `SWEEP_FETCH_TIMEOUT_MS`

Do not make these editable in the first GUI version. Show where they can be changed in Docker/Portainer.

---

## 10. Aggregate Destination Workflow

## 10.1 Rename the concept in the UI

Replace **Add Account** with:

```text
Add Bluesky destination
```

A destination contains one or more X sources.

## 10.2 New wizard structure

### Step 1: Bluesky destination

Fields:

- Bluesky handle or identifier
- App password
- Service URL under Advanced
- Test credentials button

Do not modify the profile.

### Step 2: X sources

Use a multiline input:

```text
Paste usernames separated by commas, spaces, or new lines.

Osinttechnical
IntelCrab
GeoConfirmed
```

Normalize:

- Remove leading `@`
- Lowercase for identity comparisons
- Preserve a display form only if needed
- Split on commas, spaces, tabs, and new lines
- Remove duplicates
- Reject empty values
- Validate allowed username characters
- Show chips after parsing

Summary:

```text
3 X sources will post to @osintmirror.bsky.social
```

### Step 3: Posting behavior

Choose attribution, original-link handling, and future filters.

Recommended default:

- One source: attribution off
- Multiple sources: attribution only for multiple sources

### Step 4: Profile & identity

Master profile mutation off by default.

### Step 5: Review

Show:

- Bluesky destination
- Number and names of X sources
- Attribution preview
- Profile changes that will be allowed
- Scheduler state
- Backfill selection

Create only after confirmation.

## 10.3 Add sources to an existing destination

Add a mapping action:

```text
Add X sources
```

Endpoint:

```http
POST /api/mappings/:id/sources
```

Request:

```json
{
  "usernames": [
    "osinttechnical",
    "intelcrab"
  ]
}
```

Response:

```json
{
  "added": ["osinttechnical", "intelcrab"],
  "duplicates": [],
  "invalid": [],
  "sourceCount": 8
}
```

This endpoint must not:

- Revalidate or overwrite the Bluesky password
- Change profile settings
- Run profile synchronization
- Change pin synchronization
- Automatically queue a backfill

Offer a separate checkbox:

```text
[ ] Queue a backfill for newly added sources
```

## 10.4 Remove sources safely

Endpoint:

```http
DELETE /api/mappings/:id/sources/:username
```

Before removal, return or display:

- Pending queue item count for that source
- Processed-history count
- Whether it is selected as profile or pin source

Required behavior:

- Block removal if it is an active profile/pin source until a replacement or off mode is selected.
- Offer to cancel pending queue items for the removed source.
- Do not delete processed history by default.
- Offer a separate destructive history deletion option.

## 10.5 Bulk import

Add a simple paste import first. CSV can follow.

### Paste import

```text
One source per line, or comma-separated.
```

### CSV import, later phase

```csv
x_username,bsky_destination,group
Osinttechnical,osintmirror.bsky.social,OSINT
IntelCrab,osintmirror.bsky.social,OSINT
NWSNewYorkNY,weather.bsky.social,Weather
```

The CSV importer should group rows by destination and show a dry-run preview before saving.

---

## 11. Per-Source Configuration

This phase requires the `sources: TwitterSourceConfig[]` model.

## 11.1 Source filter policy

```ts
export interface SourceFilterPolicy {
  includeOriginalPosts: boolean;
  includeSelfReplies: boolean;
  includeExternalReplies: boolean;
  includeQuotePosts: boolean;
  includeReposts: boolean;
  mediaOnly: boolean;
  includeKeywords: string[];
  excludeKeywords: string[];
  languages: string[];
  sensitiveContent: 'mirror' | 'skip';
}
```

Recommended defaults matching current behavior as closely as possible:

```ts
export const DEFAULT_SOURCE_FILTERS: SourceFilterPolicy = {
  includeOriginalPosts: true,
  includeSelfReplies: true,
  includeExternalReplies: false,
  includeQuotePosts: true,
  includeReposts: false,
  mediaOnly: false,
  includeKeywords: [],
  excludeKeywords: [],
  languages: [],
  sensitiveContent: 'mirror',
};
```

## 11.2 Filter evaluation order

Create:

```text
src/source-filter.ts
```

Recommended order:

1. Verify tweet belongs to configured source.
2. Detect repost.
3. Detect reply type.
4. Detect quote post.
5. Apply sensitive-content policy.
6. Apply media-only rule.
7. Apply language rule.
8. Apply include keywords.
9. Apply exclude keywords.
10. Return structured decision.

```ts
export interface SourceFilterDecision {
  allowed: boolean;
  reason?:
    | 'repost-disabled'
    | 'external-reply-disabled'
    | 'self-reply-disabled'
    | 'quote-disabled'
    | 'media-required'
    | 'language-filtered'
    | 'missing-include-keyword'
    | 'excluded-keyword'
    | 'sensitive-content';
}
```

Store the skip reason in processed history.

## 11.3 Source-level enable/disable

Allow pausing one source without disabling the whole destination.

GUI:

```text
@ExampleSource
Status: Enabled
Last checked: 2 minutes ago
Last post mirrored: 8 minutes ago
[Pause source]
```

Paused sources:

- Are not fetched
- Do not receive scheduled backfills
- Leave existing processed history intact
- Leave already queued posts intact by default
- Can optionally cancel their pending queue items

## 11.4 Optional source schedule override

Later enhancement:

```ts
export interface SourceScheduleOverride {
  intervalMinutes?: number;
}
```

Use a minimum interval model rather than creating one timer per source. Each source gets `nextEligibleCheckAt`. The global sweep checks only eligible sources.

Do not implement until global scheduler controls and source runtime state are stable.

---

## 12. AI Functionality and Usability

## 12.1 Rename the settings section

The current implemented AI use is image alt-text generation. Rename:

```text
AI Provider
```

to:

```text
Image Alt Text
```

Description:

> Generates accessibility descriptions for images that do not already include alt text. It does not rewrite, summarize, or translate posts.

## 12.2 Add explicit enable state

```ts
export interface AIConfig {
  enabled: boolean;
  purpose: 'image-alt-text';
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxAltTextCharacters: number;
}
```

## 12.3 Add a provider test

Endpoint:

```http
POST /api/settings/ai/test
```

Use a bundled tiny test image or provider metadata call. Do not upload user content during a settings test unless clearly disclosed.

Return:

- Provider reachable
- Model accepted
- Authentication valid
- Response time
- Friendly error

## 12.4 Per-destination override

Later:

```ts
aiAltText: {
  mode: 'inherit' | 'enabled' | 'disabled';
}
```

This allows disabling third-party AI calls for sensitive destinations while leaving global alt text enabled.

## 12.5 Usage tracking

Record counts only, not image contents:

- Requests
- Successes
- Failures
- Average latency
- Provider
- Estimated token/image usage when available

Do not claim precise cost unless the provider returns billing data.

## 12.6 Future AI features

Treat these as separate opt-in capabilities, not implied by the current AI toggle:

- Translation
- Summarization
- Text cleanup
- Hashtag generation
- Content classification
- Duplicate/near-duplicate detection

Each requires a separate purpose, privacy description, preview, and per-destination setting.

---

## 13. Queue and Posting Operations

## 13.1 Per-item actions

Add endpoints:

```http
POST   /api/queue/items/:destination/:tweetId/retry
DELETE /api/queue/items/:destination/:tweetId
```

Use an encoded stable identifier or internal queue ID if composite URL parameters become awkward.

GUI actions:

- Retry
- Cancel pending item
- View source tweet
- View error
- Copy diagnostic details

Do not allow deleting an actively processing item without a cancellation mechanism.

## 13.2 Per-destination queue actions

```http
POST   /api/mappings/:id/queue/retry-failed
DELETE /api/mappings/:id/queue/failed
DELETE /api/mappings/:id/queue/pending
```

Require explicit confirmation for clearing pending posts.

## 13.3 Better failure classification

Normalize errors into categories:

```ts
type QueueErrorCategory =
  | 'twitter-auth'
  | 'twitter-rate-limit'
  | 'twitter-fetch'
  | 'bsky-auth'
  | 'bsky-rate-limit'
  | 'media-download'
  | 'media-upload'
  | 'text-processing'
  | 'unsupported-content'
  | 'timeout'
  | 'unknown';
```

Store:

- Category
- Sanitized message
- First failure time
- Last failure time
- Attempts

Never store credentials or complete request headers.

## 13.4 Skip reasons in processed history

Expand processed status:

```ts
type ProcessedStatus =
  | 'migrated'
  | 'skipped'
  | 'failed';
```

Add:

```ts
skip_reason?: string;
error_category?: string;
error_message?: string;
source_created_at?: string;
posted_at?: string;
mapping_id?: string;
```

This makes the Activity page explain why something was skipped.

## 13.5 Queue policy visibility

Show:

```text
Queued under source @Example
Will use current destination posting settings
```

If policy snapshots are added later, show the snapshot version.

---

## 14. Health, Monitoring, and Diagnostics

## 14.1 Source runtime state

Create a SQLite table:

```sql
CREATE TABLE source_runtime_state (
  mapping_id TEXT NOT NULL,
  twitter_username TEXT NOT NULL,
  last_check_at INTEGER,
  last_success_at INTEGER,
  last_tweet_seen_at INTEGER,
  last_tweet_id TEXT,
  last_error_at INTEGER,
  last_error_category TEXT,
  last_error_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mapping_id, twitter_username)
);
```

Update after each fetch attempt.

## 14.2 Destination runtime state

Track:

- Last Bluesky login success
- Last successful post
- Last profile sync
- Last pin sync
- Consecutive posting failures
- Queue depth
- Oldest queue age

## 14.3 Health dashboard

Add a destination summary:

```text
OSINT Aggregate
8 sources
Last successful sweep: 2m ago
Last post: 4m ago
Queue: 3 pending, 0 failed
Profile mutation: Off
Attribution: Multiple sources only
```

Source table:

| Source | State | Last check | Last success | Last post seen | Error |
|---|---|---:|---:|---:|---|
| @source1 | Healthy | 2m | 2m | 8m | |
| @source2 | Warning | 2m | 1h | 3h | Authentication failed |

## 14.4 Health endpoints

Authenticated detailed endpoint:

```http
GET /api/health/details
```

Minimal Docker endpoint:

```http
GET /healthz
```

`/healthz` should not expose identifiers or credentials. Return:

```json
{
  "status": "ok",
  "uptimeSeconds": 12345,
  "database": "ok",
  "scheduler": "running"
}
```

Add a Docker healthcheck.

## 14.5 Cookie diagnostics

Show:

- Primary cookie configured
- Backup cookie configured
- Last successful primary use
- Last successful backup use
- Current active set
- Last authentication failure

Do not display cookie values after saving.

## 14.6 Notifications

Optional later phase:

```ts
export interface NotificationConfig {
  enabled: boolean;
  webhookUrl?: string;
  events: {
    twitterAuthenticationFailed: boolean;
    bskyAuthenticationFailed: boolean;
    queueItemParked: boolean;
    queueAgeExceeded: boolean;
    updateFailed: boolean;
  };
}
```

Start with generic webhooks. Discord and Slack can use webhook-compatible payload adapters.

---

## 15. Security and Backup Improvements

## 15.1 Redacted export

The current export omits users but can still include service credentials. Add two explicit options.

### Safe export

```http
GET /api/config/export?mode=redacted
```

Remove:

- Bluesky app passwords
- X cookies
- AI API keys
- JWT secrets
- Webhook secrets

Replace with:

```json
{
  "bskyPassword": "__REDACTED__"
}
```

### Full backup

```http
GET /api/config/export?mode=full
```

Require:

- Admin permission
- Confirmation dialog
- Warning that the file contains credentials
- No browser caching
- Optional reauthentication in a later release

## 15.2 Database backup

Add:

```http
GET /api/backup/database
```

For SQLite WAL mode, create a consistent backup using SQLite backup functionality or a safe checkpoint/copy procedure. Do not simply copy the main file while writes are active without handling WAL.

## 15.3 Combined backup bundle

Later:

```text
tweets-2-bsky-backup-YYYYMMDD-HHMM.zip
  config.json
  database.sqlite
  metadata.json
```

`metadata.json` should include app version and schema versions, not secrets beyond those already present in the full config.

## 15.4 Credential update UX

Allow updating only the app password:

```http
PATCH /api/mappings/:id/credentials
```

Request:

```json
{
  "bskyPassword": "xxxx-xxxx-xxxx-xxxx"
}
```

Do not return the saved password.

## 15.5 Secret storage

Longer-term option:

- Add `CONFIG_ENCRYPTION_KEY` as a required environment variable for encrypted credentials.
- Encrypt app passwords, cookies, AI keys, and webhook URLs using AES-256-GCM.
- Store nonce, ciphertext, and auth tag.
- Support a migration command and key rotation.

This is valuable but should not be combined with the initial policy release. A broken secret migration would be a very efficient way to turn a mirror into modern art.

## 15.6 API hardening

Review:

- CORS behavior
- JWT storage and expiration
- Rate limits on authentication and credential validation
- Request body limits
- CSRF risk if authentication moves to cookies
- Error responses for accidental secret leakage
- Cache headers on sensitive endpoints

Add `zod` or a comparable schema validator for request bodies and config policies.

---

## 16. Database Migration Architecture

## 16.1 Add migration tracking

Create:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

Move future schema changes into ordered functions:

```text
src/db/
  connection.ts
  migrations/
    001_initial.ts
    002_queue.ts
    003_runtime_state.ts
    004_processed_metadata.ts
  processed-tweets.ts
  post-queue.ts
  runtime-state.ts
```

Do not rewrite all DB code immediately. Introduce the migration table first, then extract services gradually.

## 16.2 Migration rules

Each migration must be:

- Transactional where SQLite allows
- Safe to run once
- Covered by a test using a temporary database
- Able to upgrade a representative legacy schema
- Logged without sensitive data

## 16.3 Suggested new columns

`processed_tweets`:

```sql
ALTER TABLE processed_tweets ADD COLUMN mapping_id TEXT;
ALTER TABLE processed_tweets ADD COLUMN source_created_at TEXT;
ALTER TABLE processed_tweets ADD COLUMN posted_at TEXT;
ALTER TABLE processed_tweets ADD COLUMN skip_reason TEXT;
ALTER TABLE processed_tweets ADD COLUMN error_category TEXT;
ALTER TABLE processed_tweets ADD COLUMN error_message TEXT;
```

Add only what is used by the UI. Avoid collecting metadata merely because SQLite is nearby and looks lonely.

---

## 17. Backend API Design

## 17.1 Route modules

Target structure:

```text
src/routes/
  auth-routes.ts
  mapping-routes.ts
  scheduler-routes.ts
  profile-routes.ts
  queue-routes.ts
  settings-routes.ts
  health-routes.ts
  backup-routes.ts
```

Shared middleware:

```text
src/middleware/
  authenticate.ts
  authorize.ts
  validate.ts
  errors.ts
```

Services:

```text
src/services/
  mapping-service.ts
  scheduler-service.ts
  profile-service.ts
  queue-service.ts
  health-service.ts
  backup-service.ts
```

Do this incrementally. New routes should be created in modules even if legacy routes remain in `src/server.ts`.

## 17.2 Mapping endpoints

```http
GET    /api/mappings
POST   /api/mappings
GET    /api/mappings/:id
PATCH  /api/mappings/:id
DELETE /api/mappings/:id
```

Separate credentials:

```http
PATCH /api/mappings/:id/credentials
POST  /api/mappings/:id/credentials/test
```

Sources:

```http
POST   /api/mappings/:id/sources
PATCH  /api/mappings/:id/sources/:sourceId
DELETE /api/mappings/:id/sources/:sourceId
```

Posting:

```http
PATCH /api/mappings/:id/posting-policy
POST  /api/mappings/:id/posting-preview
```

Profile:

```http
PATCH /api/mappings/:id/profile-policy
POST  /api/mappings/:id/profile/preview
POST  /api/mappings/:id/profile/apply
POST  /api/mappings/:id/pin-sync
```

## 17.3 Error shape

Standardize:

```json
{
  "error": {
    "code": "INVALID_INTERVAL",
    "message": "Interval must be between 1 and 1440 minutes.",
    "details": {
      "field": "intervalMinutes"
    }
  }
}
```

Do not expose raw Axios or AT Protocol response bodies to normal users.

## 17.4 Optimistic concurrency

Optional but useful after the UI is split:

```ts
updatedAt: string;
revision: number;
```

PATCH requests include `revision`. Reject stale writes with `409 Conflict`.

This prevents two browser tabs from silently overwriting mapping policies.

---

## 18. Frontend Architecture and UX

## 18.1 Target folder structure

```text
web/src/
  api/
    client.ts
    mappings.ts
    scheduler.ts
    profile.ts
    queue.ts
    settings.ts

  components/
    common/
      ConfirmDialog.tsx
      FieldHelp.tsx
      StatusBadge.tsx
      SecretInput.tsx
    mappings/
      DestinationCard.tsx
      DestinationWizard.tsx
      SourceListEditor.tsx
      PostingPolicyEditor.tsx
      ProfilePolicyEditor.tsx
      DestinationReview.tsx
    scheduler/
      SchedulerSettings.tsx
    queue/
      QueueTable.tsx
      QueueItemActions.tsx
    health/
      SourceHealthTable.tsx

  hooks/
    useMappings.ts
    useScheduler.ts
    useQueue.ts
    useHealth.ts

  pages/
    DashboardPage.tsx
    DestinationsPage.tsx
    ActivityPage.tsx
    QueuePage.tsx
    SettingsPage.tsx

  types/
    api.ts
    config.ts
```

## 18.2 UI terminology

Use consistently:

| Old wording | New wording |
|---|---|
| Account | Destination or mapping, depending on context |
| Add Account | Add Bluesky destination |
| Twitter usernames | X sources |
| Profile Sync Source | Profile mirror source |
| AI Provider | Image Alt Text |
| Check interval | Refresh interval or automatic check interval |

## 18.3 Destination card

Show:

- Bluesky avatar and handle
- Enabled/paused state
- Aggregate badge when source count > 1
- Source count
- Attribution mode
- Profile mutation state
- Queue state
- Last successful check
- Actions menu

Example:

```text
OSINT Mirror
@osintmirror.bsky.social
Aggregate · 12 sources

Attribution: Multiple sources only
Profile changes: Off
Queue: 2 pending
Last successful check: 2 minutes ago
```

## 18.4 Settings save behavior

- Disable Save until values change.
- Show field-specific validation.
- Show a success toast only after the server returns the normalized saved value.
- Re-fetch status after scheduler changes.
- Never display saved secrets back to the browser.
- Use “Configured” rather than fake password dots for secrets.

## 18.5 Destructive actions

Require typed confirmation only for:

- Delete destination and queue
- Delete destination history
- Clear all history
- Full credential-containing export
- Delete all Bluesky posts

Normal source removal can use a standard confirmation dialog with a queue/history summary.

## 18.6 Accessibility

- Labels tied to controls
- Keyboard-accessible source chips
- No color-only health indicators
- Accessible confirmation dialogs
- Clear focus states
- Live-region updates for long actions
- Alt text for destination avatars

---

## 19. Testing Strategy

## 19.1 Add standard scripts

`package.json`:

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "test:watch": "bun test --watch",
    "check": "bun run typecheck && bun test && bun run build"
  }
}
```

Keep existing targeted scripts.

## 19.2 Test structure

```text
tests/
  fixtures/
    config-v0.json
    config-v1.json
    tweets/
  unit/
    config-migrations.test.ts
    config-normalize.test.ts
    attribution-policy.test.ts
    post-transform.test.ts
    profile-policy.test.ts
    source-parser.test.ts
    source-filter.test.ts
    scheduler-settings.test.ts
  integration/
    mapping-routes.test.ts
    scheduler-routes.test.ts
    profile-routes.test.ts
    queue-routes.test.ts
    db-migrations.test.ts
```

## 19.3 Required policy tests

### Attribution

- One source plus `multiple-sources` produces no prefix.
- Two sources plus `multiple-sources` produces a prefix.
- `always` produces a prefix.
- `never` does not.
- Reply plus `rootPostsOnly` does not.
- Thread root does.
- Custom template variables render.
- Unknown variables fail validation.
- Long attribution causes safe thread splitting.
- Source URL facet points to the correct profile.

### Profile

- Master mutation off blocks every profile operation.
- Bot label requires its explicit flag.
- Display suffix requires its explicit flag.
- Scheduled mode runs only when due.
- Manual mode never runs automatically.
- Multi-source mapping with no source skips.
- Removing selected source is blocked.
- Pin and profile sources are independent.
- Field-level options are respected.

### Scheduler

- Minimum one minute accepted.
- Zero rejected.
- Values above 1440 rejected.
- Decimal values follow documented normalization or are rejected.
- Saving recalculates next run.
- Saving does not trigger an immediate sweep.
- Disabled scheduler still allows manual run.
- Config migration preserves legacy interval.

### Bulk sources

- Newline, comma, space, and tab parsing.
- Leading `@` removal.
- Duplicate removal.
- Case-insensitive identity.
- Invalid username reporting.
- Adding sources does not modify profile policy.
- Adding sources does not modify credentials.
- Adding sources does not automatically backfill.

## 19.4 Integration test isolation

Use:

- Temporary config directory
- Temporary SQLite database
- Mock Twitter scraper
- Mock Bluesky agent
- Mock profile and media downloads
- Deterministic clock where scheduler behavior is tested

Add dependency injection around external clients rather than monkey-patching global imports.

## 19.5 Frontend tests

After component extraction, add:

- React Testing Library
- User-event
- Optional Playwright smoke tests

Critical workflows:

1. Create one-to-one destination.
2. Create aggregate destination with pasted usernames.
3. Edit attribution.
4. Disable all profile mutation.
5. Change scheduler interval.
6. Add and remove a source.
7. Retry a failed queue item.

---

## 20. Observability and Logging

## 20.1 Structured logging

Introduce a small logger wrapper:

```ts
logger.info('source.fetch.completed', {
  mappingId,
  twitterUsername,
  durationMs,
  tweetCount,
});
```

Do not require a large logging dependency initially. JSON output can be optional via an environment variable.

## 20.2 Correlation IDs

Use:

- Sweep ID
- Backfill request ID
- Queue item identity
- Mapping ID

This makes it possible to trace:

```text
fetch -> enqueue -> claim -> transform -> upload -> post -> history
```

## 20.3 Log sanitization

Create a sanitizer that removes:

- App passwords
- X cookies
- API keys
- Authorization headers
- JWTs
- Webhook secrets

Add tests for common secret patterns.

## 20.4 Metrics

Expose authenticated metrics in JSON first:

- Sweeps completed
- Source fetch successes/failures
- Tweets discovered
- Posts queued
- Posts migrated
- Posts skipped
- Queue failures
- Average queue delay
- Average posting time
- AI alt-text success/failure

Prometheus output can be added later.

---

## 21. Documentation Updates

Update `README.md` with:

1. One destination can contain multiple X sources.
2. How aggregate attribution works.
3. Profile mutation defaults.
4. Refresh interval GUI.
5. Environment-based advanced tuning.
6. Safe versus full exports.
7. Queue semantics.
8. AI alt-text description.
9. Migration notes.
10. Screenshots for the new destination wizard.

Add:

```text
docs/
  aggregate-destinations.md
  profile-management.md
  scheduler-and-rate-limits.md
  backups-and-restore.md
  configuration-schema.md
  development.md
```

`configuration-schema.md` should include complete JSON examples.

---

## 22. Recommended Pull Request Sequence

Each pull request should build, typecheck, and include tests. Avoid one giant Cursor-generated commit.

## PR 0: Baseline behavior tests

**Branch:** `feature/baseline-policy-tests`

Tasks:

- Add `bun test` scripts.
- Add fixtures for current config.
- Add tests capturing current username parsing.
- Add tests capturing unconditional attribution.
- Add tests capturing current profile-source fallback.
- Add a test helper for temporary config/database paths.

Acceptance criteria:

- Existing behavior is documented by tests.
- `bun run typecheck`, `bun test`, and `bun run build` pass.

## PR 1: Versioned config and policy schemas

**Branch:** `feature/config-v2-policies`

Tasks:

- Add `schemaVersion`.
- Add scheduler, posting, and profile policy types.
- Add migration functions.
- Preserve legacy behavior.
- Write a pre-migration backup.
- Add migration review metadata or notices.
- Add config migration tests.

Acceptance criteria:

- Existing config loads without manual changes.
- Migrated config is valid and stable after a second load.
- Credentials are unchanged.
- New mappings receive safe defaults.

## PR 2: Posting attribution policy

**Branch:** `feature/attribution-policy`

Tasks:

- Create `src/post-transform.ts`.
- Pass mapping policy into posting.
- Replace unconditional prefix.
- Add templates and source links.
- Add unit tests.
- Preserve current behavior for migrated mappings.

Acceptance criteria:

- One-to-one new mapping has no source prefix.
- Aggregate new mapping has source attribution.
- Existing mappings retain current prefix behavior until edited.
- Preview and posting produce matching text.

## PR 3: Profile mutation safety

**Branch:** `feature/profile-policy`

Tasks:

- Gate every profile mutation.
- Separate profile and pin policies.
- Remove multi-source first-account fallback.
- Add preview and manual apply endpoints.
- Add tests for bot label and suffix gating.
- Add migration review warning.

Acceptance criteria:

- Adding a source cannot modify the Bluesky profile.
- Credential testing cannot modify the profile.
- Master off blocks all profile and pin mutations.
- Manual preview makes no changes.

## PR 4: Scheduler settings

**Branch:** `feature/scheduler-settings`

Tasks:

- Add scheduler API.
- Add strict validation.
- Recalculate next check on save.
- Add Settings UI.
- Add advanced read-only tuning values.
- Add tests.

Acceptance criteria:

- Interval can be changed from GUI.
- No restart required.
- Next-run time updates immediately.
- Manual run remains independent.

## PR 5: Aggregate destination wizard

**Branch:** `feature/aggregate-destination-wizard`

Tasks:

- Rename Add Account.
- Build multiline source parser and chips.
- Add source-count-aware defaults.
- Add review step.
- Do not mutate profile during setup.
- Add source addition endpoint.

Acceptance criteria:

- User can paste multiple X usernames and create one mapping.
- The Bluesky app password is entered once.
- Profile changes remain off unless selected.
- Duplicate and invalid usernames are clearly reported.

## PR 6: Existing destination source editor

**Branch:** `feature/source-management`

Tasks:

- Add/remove sources without credential changes.
- Add dependency checks for profile/pin source.
- Add optional backfill checkbox.
- Add queue/history removal choices.
- Add aggregate badge and source count.

Acceptance criteria:

- Sources can be managed independently.
- Removing a source does not delete history by default.
- Active policy references cannot become invalid.

## PR 7: Per-source object model and filters

**Branch:** `feature/per-source-policies`

Tasks:

- Add `sources: TwitterSourceConfig[]`.
- Migrate `twitterUsernames`.
- Add compatibility helper during transition.
- Add source enable/disable.
- Add filter module.
- Store skip reasons.
- Add source-level backfill.

Acceptance criteria:

- Existing mappings migrate correctly.
- Pausing one source does not pause the destination.
- Filter behavior is deterministic and visible in Activity.

## PR 8: Health and diagnostics

**Branch:** `feature/source-health`

Tasks:

- Add source runtime state table.
- Add health endpoints.
- Add dashboard source-health table.
- Add cookie state diagnostics.
- Add Docker healthcheck.
- Add error categories.

Acceptance criteria:

- Admin can identify stale or failing sources without reading container logs.
- `/healthz` reveals no sensitive data.
- Consecutive failures reset after success.

## PR 9: Queue operations

**Branch:** `feature/queue-controls`

Tasks:

- Retry/cancel single items.
- Add per-destination queue actions.
- Show failure categories.
- Show queue age and current-policy behavior.
- Add tests.

Acceptance criteria:

- A poison item can be managed without clearing the entire queue.
- Queue actions are correctly permission-scoped.

## PR 10: Safe backup and export

**Branch:** `feature/safe-backups`

Tasks:

- Redacted export.
- Full export confirmation.
- Consistent SQLite backup.
- Restore validation and dry run.
- Documentation.

Acceptance criteria:

- Safe export contains no credentials.
- Full backup can restore a test deployment.
- Invalid backup cannot overwrite the active config.

## PR 11: Frontend/backend extraction

**Branch:** `refactor/modularize-app`

Tasks:

- Move new routes into modules.
- Extract mapping and settings components.
- Add API client and hooks.
- Keep behavior unchanged.
- Add frontend tests.

Acceptance criteria:

- `App.tsx` is primarily routing/layout.
- `server.ts` is primarily application assembly.
- No user-visible behavior changes.

---

## 23. File-by-File Change Matrix

| File | Immediate work |
|---|---|
| `src/config-manager.ts` | Add schema version, nested policies, migrations, defaults, validation |
| `src/index.ts` | Pass mapping policy into posting, gate profile/pin automation, respect scheduler enabled state |
| `src/profile-mirror.ts` | Keep low-level operations, add no implicit policy decisions, support preview cleanly |
| `src/server.ts` | Add scheduler, policy, source, profile preview, and safe export endpoints |
| `src/db.ts` | Add migration tracking, runtime state, processed skip/error metadata |
| `src/ai-manager.ts` | Add explicit enabled state, purpose naming, test helper, usage result metadata |
| `web/src/App.tsx` | Add initial controls, then extract into pages/components |
| `README.md` | Document aggregate destinations, policy defaults, scheduler, AI alt text |
| `package.json` | Add standard test/check scripts and validation dependencies |
| `docker-compose.yml` | Add healthcheck and document advanced environment settings |
| `docker-compose.portainer.yml` | Mirror healthcheck and environment documentation |
| `.env.example` | Explain advanced scheduler/scraper/posting values |
| `TROUBLESHOOTING.md` | Add source health, profile policy, interval, and queue recovery sections |

---

## 24. API Validation Schemas

Adding `zod` is recommended.

Example:

```ts
import { z } from 'zod';

export const attributionPolicySchema = z.object({
  mode: z.enum(['never', 'multiple-sources', 'always']),
  template: z
    .string()
    .min(1)
    .max(160)
    .refine(validateTemplateVariables, {
      message: 'Template contains an unsupported variable.',
    }),
  rootPostsOnly: z.boolean(),
  linkSource: z.boolean(),
});

export const schedulerPatchSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(1440),
  runOnStartup: z.boolean(),
});
```

Use the same schemas for:

- API request validation
- Config normalization where practical
- Shared frontend types through inferred TypeScript types, if build boundaries allow

Do not send secret-bearing config schemas to the frontend.

---

## 25. Definition of Done

A feature is complete only when:

1. The behavior is covered by unit or integration tests.
2. Existing config migration is tested.
3. API validation rejects invalid values.
4. Permissions are enforced.
5. No credentials appear in API responses or logs.
6. UI loading, success, empty, and error states exist.
7. `bun run typecheck` passes.
8. `bun test` passes.
9. `bun run build` passes.
10. README or docs are updated.
11. Docker persistent-volume upgrade is tested.
12. Rollback instructions are documented for schema-changing releases.

---

## 26. Release and Rollback Plan

## 26.1 Pre-release

- Create a tagged backup of the current working branch.
- Export config.
- Back up the SQLite database.
- Test upgrade using a copy of the production data volume.
- Test both a one-to-one and aggregate mapping.
- Verify no profile changes occur when profile mutation is off.

## 26.2 Release candidate checklist

- New one-to-one mapping
- New aggregate mapping
- Legacy mapping migration
- Source add/remove
- Profile preview
- Profile master off
- Attribution preview
- Refresh interval change
- Manual run
- Backfill
- Queue retry
- Container restart
- Database recovery
- Redacted export

## 26.3 Rollback

Before config schema v2 is written:

```text
config.json.pre-v2-backup
```

Rollback procedure:

1. Stop the container.
2. Restore the previous image/tag.
3. Restore the pre-v2 config.
4. Restore the pre-upgrade database only if the old build cannot tolerate new columns or migrations.
5. Start the container.
6. Verify mappings and queue.

New database migrations should be additive whenever possible so database rollback is rarely required.

---

## 27. Cursor Execution Guidance

Use this document as a sequence of scoped tasks, not as one prompt asking Cursor to “implement everything.”

### Recommended Cursor instruction for each PR

```text
Review the current repository before editing. Implement only PR N from
IMPLEMENTATION_PLAN.md. Preserve existing behavior unless the PR explicitly
changes it. Add tests first or alongside the change. Do not modify generated
build output. Do not expose credentials in logs or API responses.

Before finishing:
1. Run bun run typecheck
2. Run bun test
3. Run bun run build
4. Summarize files changed, migration behavior, and any remaining risks
```

### Cursor rules worth adding

```text
- Treat one AccountMapping as one Bluesky destination.
- Never mutate a Bluesky profile during credential validation.
- Every profile mutation requires the master allowProfileMutation flag and a
  specific feature flag.
- Aggregate mappings never infer a profile or pin source from the first source.
- New one-to-one mappings default attribution to never.
- New multi-source mappings default attribution to multiple-sources.
- Existing mappings preserve behavior through migration and are flagged for review.
- Do not return stored secrets to the frontend.
- Use atomic config writes and temporary-database tests.
```

### Branching

Use one branch per PR. Avoid asking Cursor to refactor unrelated files while implementing a feature. Large opportunistic cleanup makes review much harder and provides excellent camouflage for bugs.

---

## 28. Optional Advanced Roadmap

These features are useful after the core work is stable.

## 28.1 Adaptive polling

Check active sources more often based on recent post frequency while maintaining a global scraper request budget.

Requirements:

- Per-source next eligible time
- Global request budget
- Minimum and maximum intervals
- Clear UI explanation
- No starvation of quiet sources

## 28.2 Duplicate content detection

Some aggregate sources repost the same text or media. Add optional near-duplicate suppression using:

- Normalized text hash
- URL canonicalization
- Optional perceptual image hash
- Time window

Do not use AI as the first duplicate detector.

## 28.3 Destination routing rules

Allow one source to route to different destinations based on keywords or content type. This changes the simple mapping model and should be treated as a major feature.

## 28.4 Scheduled digest mode

Collect posts and publish periodic summaries instead of immediate mirrors. This is separate from normal mirroring and should use a distinct queue type.

## 28.5 Moderation and block-list integration

Allow destination-level keyword, domain, and source block lists. Provide dry-run testing before enforcement.

## 28.6 Webhook/API ingestion

Support non-X sources through a normalized inbound post model. This should happen only after source policies and post transformations are abstracted away from Twitter-specific types.

---

## 29. Recommended Minimum Viable Enhancement Release

The first production-ready enhancement release should include only:

1. Config schema versioning.
2. Scheduler settings in the GUI.
3. Attribution modes and preview.
4. Profile mutation master switch.
5. Independent profile and pin controls.
6. Safe multi-source defaults.
7. Bulk source creation.
8. Add/remove sources on an existing destination.
9. Unit tests for migration and policy behavior.
10. Updated README and upgrade warning.

This release directly solves the current usability problems without forcing the full per-source model or architectural refactor.

---

## 30. Final Recommended Defaults

| Setting | New one-to-one destination | New aggregate destination | Migrated destination |
|---|---|---|---|
| Attribution | Never | Multiple sources only | Preserve current behavior |
| Profile mutation | On | Off | Preserve, show review warning |
| Scheduled profile sync | On | Off | Preserve |
| Pin sync | On | Off | Preserve |
| Bot self-label | On | Off | Preserve known behavior |
| Display-name suffix | On | Off | Preserve known behavior |
| Refresh interval | Global 5 minutes | Global 5 minutes | Existing value |
| Backfill on source add | Off | Off | N/A |
| AI alt text | Inherit global | Inherit global | Existing configuration |
| Source filters | Current-compatible defaults | Current-compatible defaults | Current behavior |

---

## 31. Repository References Reviewed

- `README.md`
- `src/config-manager.ts`
- `src/index.ts`
- `src/server.ts`
- `src/profile-mirror.ts`
- `src/db.ts`
- `src/ai-manager.ts`
- `web/src/App.tsx`
- `package.json`
- Docker Compose and Portainer deployment files

Repository:

```text
https://github.com/Goldalex98/tweets-2-bsky
```
