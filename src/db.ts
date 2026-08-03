import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DB_PATH, PENDING_DB_RESTORE_PATH } from './storage-paths.js';
import { type MigrationDatabase, runDatabaseMigrations } from './db/migrations/index.js';
import { classifyQueueError, sanitizeForDiagnostics, sanitizedErrorMessage } from './observability.js';
import { createIngestionSecrets, hashIngestionToken, type IngestionScope } from './ingestion-security.js';
import { decryptValue, encryptValue, isEncryptedValue, parseEncryptionKey } from './secret-storage.js';
import type { DeliveryFallbackEvent } from './delivery-diagnostics.js';
import type { NormalizedPost } from './normalized-post.js';
import { parseSqliteUtcTimestampMs, toIsoUtcTimestamp } from './sqlite-utc-timestamp.js';

export { parseSqliteUtcTimestampMs, toIsoUtcTimestamp } from './sqlite-utc-timestamp.js';

interface DbStatement {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
}

interface DbLike {
  prepare: (sql: string) => DbStatement;
  exec: (sql: string) => unknown;
  transaction: <T>(fn: () => T) => () => T;
  pragma?: (sql: string) => unknown;
}

function renameSyncWithRetry(from: string, to: string, attempts = 8): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      // Windows often holds a brief exclusive lock after process start; retry
      // with a short busy-wait before declaring the restore unrecoverable.
      const waitUntil = Date.now() + 40 * attempt;
      while (Date.now() < waitUntil) {
        // intentional busy-wait: module load cannot await
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

if (fs.existsSync(PENDING_DB_RESTORE_PATH)) {
  const previousPath = `${DB_PATH}.pre-restore-${Date.now()}.bak`;
  if (fs.existsSync(DB_PATH)) renameSyncWithRetry(DB_PATH, previousPath);
  try {
    renameSyncWithRetry(PENDING_DB_RESTORE_PATH, DB_PATH);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
    console.warn(`♻️ Applied staged database restore. Previous database: ${previousPath}`);
  } catch (error) {
    if (fs.existsSync(previousPath) && !fs.existsSync(DB_PATH)) {
      try {
        renameSyncWithRetry(previousPath, DB_PATH);
      } catch {
        // Keep the original failure; operator must stop the service and swap manually.
      }
    }
    throw new Error(
      `Could not apply staged database restore: ${(error as Error).message}. If the database file is locked (common on Windows), stop every tweets-2-bsky process, then rename ${PENDING_DB_RESTORE_PATH} over ${DB_PATH} and restart.`,
    );
  }
}

const db: DbLike = await (async () => {
  if (typeof process.versions.bun === 'string') {
    const bunSqliteSpecifier = 'bun:sqlite';
    const sqliteModule = (await import(bunSqliteSpecifier)) as {
      Database: new (filename: string) => DbLike;
    };
    return new sqliteModule.Database(DB_PATH) as unknown as DbLike;
  }

  const betterSqliteModule = await import('better-sqlite3');
  return new betterSqliteModule.default(DB_PATH) as unknown as DbLike;
})();

// Enable WAL mode for better concurrency
if (typeof db.pragma === 'function') {
  db.pragma('journal_mode = WAL');
} else {
  db.exec('PRAGMA journal_mode = WAL;');
}

runDatabaseMigrations(db as unknown as MigrationDatabase);

export function createConsistentDatabaseSnapshot(destinationPath: string): void {
  if (fs.existsSync(destinationPath)) fs.rmSync(destinationPath, { force: true });
  const quotedPath = destinationPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${quotedPath}'`);
  if (!fs.existsSync(destinationPath) || fs.statSync(destinationPath).size < 512) {
    throw new Error('SQLite snapshot verification failed.');
  }
}

export function getDatabaseSchemaVersion(): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version?: number }
    | undefined;
  return Number(row?.version) || 0;
}

export function validateDatabaseSnapshot(snapshotPath: string): number {
  const quotedPath = snapshotPath.replaceAll("'", "''");
  db.exec(`ATTACH DATABASE '${quotedPath}' AS restore_candidate`);
  try {
    const integrity = db.prepare('PRAGMA restore_candidate.integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed.');
    const row = db.prepare('SELECT MAX(version) AS version FROM restore_candidate.schema_migrations').get() as
      | { version?: number }
      | undefined;
    const version = Number(row?.version) || 0;
    if (version <= 0) throw new Error('SQLite migration metadata is missing.');
    if (version >= 7) {
      const required = [
        'ingestion_credentials',
        'ingestion_nonces',
        'ingestion_idempotency',
        'ingestion_audit',
        'digest_entries',
        'digest_jobs',
      ];
      const tables = new Set(
        (
          db
            .prepare(
              `SELECT name FROM restore_candidate.sqlite_master
               WHERE type = 'table'`,
            )
            .all() as Array<{ name: string }>
        ).map((entry) => entry.name),
      );
      if (required.some((table) => !tables.has(table))) {
        throw new Error('SQLite snapshot is missing normalized ingestion or digest state.');
      }
    }
    return version;
  } finally {
    db.exec('DETACH DATABASE restore_candidate');
  }
}

export interface ProcessedTweet {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  source_type?: string;
  external_post_id?: string;
  destination_id?: string;
  route_id?: string;
  source_id?: string;
  source_created_at?: number;
  posted_at?: number;
  skip_reason?: string;
  error_category?: string;
  error_message?: string;
  policy_version?: number;
  policy_snapshot?: string;
  decision_version?: number;
  decision_trace?: string;
  retained_candidate_json?: string;
  retained_until?: number;
  override_requeued_at?: number;
  override_requeued_by?: string;
  first_failure_at?: number;
  last_failure_at?: number;
  attempts?: number;
  tweet_text?: string;
  bsky_uri?: string;
  bsky_cid?: string;
  bsky_root_uri?: string;
  bsky_root_cid?: string;
  bsky_tail_uri?: string;
  bsky_tail_cid?: string;
  delivery_diagnostics?: string;
  status: 'migrated' | 'skipped' | 'failed';
  created_at?: string;
}

export interface ProcessedTweetSearchResult extends ProcessedTweet {
  score: number;
}

export interface ProcessedTweetLookupEntry {
  uri?: string;
  cid?: string;
  root?: { uri: string; cid?: string | null };
  tail?: { uri: string; cid: string };
  migrated?: boolean;
  skipped?: boolean;
}

function processedTweetRowToLookupEntry(row: ProcessedTweetRow): ProcessedTweetLookupEntry {
  return {
    uri: row.bsky_uri ?? undefined,
    cid: row.bsky_cid ?? undefined,
    root: row.bsky_root_uri ? { uri: row.bsky_root_uri, cid: row.bsky_root_cid } : undefined,
    tail: row.bsky_tail_uri && row.bsky_tail_cid ? { uri: row.bsky_tail_uri, cid: row.bsky_tail_cid } : undefined,
    migrated: row.status === 'migrated',
    skipped: row.status === 'skipped',
  };
}

interface ProcessedTweetRow {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  source_type?: string;
  external_post_id?: string;
  destination_id?: string;
  route_id?: string | null;
  source_id?: string | null;
  source_created_at?: number | null;
  posted_at?: number | null;
  skip_reason?: string | null;
  error_category?: string | null;
  error_message?: string | null;
  policy_version?: number;
  policy_snapshot?: string | null;
  decision_version?: number;
  decision_trace?: string | null;
  retained_candidate_json?: string | null;
  retained_until?: number | null;
  override_requeued_at?: number | null;
  override_requeued_by?: string | null;
  first_failure_at?: number | null;
  last_failure_at?: number | null;
  attempts?: number | null;
  tweet_text?: string | null;
  bsky_uri?: string | null;
  bsky_cid?: string | null;
  bsky_root_uri?: string | null;
  bsky_root_cid?: string | null;
  bsky_tail_uri?: string | null;
  bsky_tail_cid?: string | null;
  delivery_diagnostics?: string | null;
  status: ProcessedTweet['status'];
  created_at?: string;
}

const rowToProcessedTweet = (row: ProcessedTweetRow): ProcessedTweet => ({
  twitter_id: row.twitter_id,
  twitter_username: row.twitter_username,
  bsky_identifier: row.bsky_identifier,
  source_type: row.source_type,
  external_post_id: row.external_post_id,
  destination_id: row.destination_id,
  route_id: row.route_id ?? undefined,
  source_id: row.source_id ?? undefined,
  source_created_at: row.source_created_at ?? undefined,
  posted_at: row.posted_at ?? undefined,
  skip_reason: row.skip_reason ?? undefined,
  error_category: row.error_category ?? undefined,
  error_message: row.error_message ?? undefined,
  policy_version: row.policy_version,
  policy_snapshot: row.policy_snapshot ?? undefined,
  decision_version: row.decision_version,
  decision_trace: row.decision_trace ?? undefined,
  retained_candidate_json: row.retained_candidate_json ?? undefined,
  retained_until: row.retained_until ?? undefined,
  override_requeued_at: row.override_requeued_at ?? undefined,
  override_requeued_by: row.override_requeued_by ?? undefined,
  first_failure_at: row.first_failure_at ?? undefined,
  last_failure_at: row.last_failure_at ?? undefined,
  attempts: row.attempts ?? undefined,
  tweet_text: row.tweet_text ?? undefined,
  bsky_uri: row.bsky_uri ?? undefined,
  bsky_cid: row.bsky_cid ?? undefined,
  bsky_root_uri: row.bsky_root_uri ?? undefined,
  bsky_root_cid: row.bsky_root_cid ?? undefined,
  bsky_tail_uri: row.bsky_tail_uri ?? undefined,
  bsky_tail_cid: row.bsky_tail_cid ?? undefined,
  delivery_diagnostics: row.delivery_diagnostics ?? undefined,
  status: row.status,
  // Expose UTC with an explicit Z so browsers/toLocale* convert to local time.
  created_at: toIsoUtcTimestamp(row.created_at) ?? row.created_at,
});

function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@#._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchValue(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(' ').filter((token) => token.length > 0);
}

function orderedSubsequenceScore(query: string, candidate: string): number {
  if (!query || !candidate) {
    return 0;
  }

  let matched = 0;
  let searchIndex = 0;
  for (const char of query) {
    const foundIndex = candidate.indexOf(char, searchIndex);
    if (foundIndex === -1) {
      continue;
    }
    matched += 1;
    searchIndex = foundIndex + 1;
  }

  return matched / query.length;
}

function buildBigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length < 2) {
    if (value.length === 1) {
      result.add(value);
    }
    return result;
  }

  for (let i = 0; i < value.length - 1; i += 1) {
    result.add(value.slice(i, i + 2));
  }

  return result;
}

function diceCoefficient(a: string, b: string): number {
  const aBigrams = buildBigrams(a);
  const bBigrams = buildBigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) {
      overlap += 1;
    }
  }

  return (2 * overlap) / (aBigrams.size + bBigrams.size);
}

function scoreCandidateField(query: string, tokens: string[], candidateValue?: string): number {
  const candidate = normalizeSearchValue(candidateValue || '');
  if (!query || !candidate) {
    return 0;
  }

  let score = 0;
  if (candidate === query) {
    score += 170;
  } else if (candidate.startsWith(query)) {
    score += 140;
  } else if (candidate.includes(query)) {
    score += 112;
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) {
      matchedTokens += 1;
      score += token.length >= 4 ? 18 : 12;
    }
  }

  if (tokens.length > 0) {
    score += (matchedTokens / tokens.length) * 48;
  }

  score += orderedSubsequenceScore(query, candidate) * 46;
  score += diceCoefficient(query, candidate) * 55;

  return score;
}

function scoreProcessedTweet(tweet: ProcessedTweet, query: string, tokens: string[]): number {
  const usernameScore = scoreCandidateField(query, tokens, tweet.twitter_username) * 1.25;
  const identifierScore = scoreCandidateField(query, tokens, tweet.bsky_identifier) * 1.18;
  const textScore = scoreCandidateField(query, tokens, tweet.tweet_text) * 0.98;
  const idScore = scoreCandidateField(query, tokens, tweet.twitter_id) * 0.72;

  const maxScore = Math.max(usernameScore, identifierScore, textScore, idScore);
  const blendedScore = maxScore + (usernameScore + identifierScore + textScore + idScore - maxScore) * 0.22;

  const recencyBoost = (() => {
    const timestamp = parseSqliteUtcTimestampMs(tweet.created_at);
    if (typeof timestamp !== 'number') return 0;
    const ageDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
    return Math.max(0, 7 - ageDays);
  })();

  return blendedScore + recencyBoost;
}

export const dbService = {
  getPost(externalPostId: string, destinationId: string, sourceType = 'x'): ProcessedTweet | null {
    const row = db
      .prepare(
        'SELECT * FROM processed_tweets WHERE source_type = ? AND external_post_id = ? AND destination_id = ? LIMIT 1',
      )
      .get(sourceType, externalPostId, destinationId) as ProcessedTweetRow | undefined;
    return row ? rowToProcessedTweet(row) : null;
  },

  getPostForSource(
    externalPostId: string,
    destinationId: string,
    sourceType: string,
    sourceId: string,
  ): ProcessedTweet | null {
    const row = db
      .prepare(
        `SELECT * FROM processed_tweets
         WHERE source_type = ? AND source_id = ? AND external_post_id = ? AND destination_id = ?
         LIMIT 1`,
      )
      .get(sourceType, sourceId, externalPostId, destinationId) as ProcessedTweetRow | undefined;
    return row ? rowToProcessedTweet(row) : null;
  },

  getTweet(twitterId: string, bskyIdentifier: string): ProcessedTweet | null {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE twitter_id = ? AND bsky_identifier = ?');
    const row = stmt.get(twitterId, bskyIdentifier) as ProcessedTweetRow | undefined;
    if (!row) return null;
    return rowToProcessedTweet(row);
  },

  findMigratedXPost(externalPostId: string): ProcessedTweet | null {
    const row = db
      .prepare(
        `SELECT * FROM processed_tweets
         WHERE source_type = 'x'
           AND (external_post_id = ? OR twitter_id = ?)
           AND status = 'migrated'
           AND bsky_uri IS NOT NULL
           AND bsky_cid IS NOT NULL
         ORDER BY COALESCE(posted_at, 0) ASC, rowid ASC
         LIMIT 1`,
      )
      .get(externalPostId, externalPostId) as ProcessedTweetRow | undefined;
    return row ? rowToProcessedTweet(row) : null;
  },

  saveTweet(tweet: ProcessedTweet) {
    // Preserve created_at on REPLACE when the caller still has it (e.g. restoring
    // a skip after a colliding override-requeue). Dropping it would stamp
    // CURRENT_TIMESTAMP and make settlement treat the restored skip as fresher
    // than an already-queued item, silently dropping the queue row.
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO processed_tweets 
      (twitter_id, twitter_username, bsky_identifier, source_type, external_post_id,
       destination_id, route_id, source_id, source_created_at, posted_at, skip_reason,
       error_category, error_message, policy_version, policy_snapshot, decision_version, decision_trace,
       retained_candidate_json, retained_until, override_requeued_at, override_requeued_by, first_failure_at,
       last_failure_at, attempts, tweet_text, bsky_uri, bsky_cid, bsky_root_uri,
       bsky_root_cid, bsky_tail_uri, bsky_tail_cid, delivery_diagnostics, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `);
    stmt.run(
      tweet.twitter_id,
      tweet.twitter_username,
      tweet.bsky_identifier,
      tweet.source_type ?? 'x',
      tweet.external_post_id ?? tweet.twitter_id,
      tweet.destination_id ?? tweet.bsky_identifier,
      tweet.route_id ?? null,
      tweet.source_id ?? null,
      tweet.source_created_at ?? null,
      tweet.posted_at ?? (tweet.status === 'migrated' ? Date.now() : null),
      tweet.skip_reason ?? null,
      tweet.error_category ?? null,
      tweet.error_message ?? null,
      tweet.policy_version ?? 1,
      tweet.policy_snapshot ?? null,
      tweet.decision_version ?? 1,
      tweet.decision_trace ?? null,
      tweet.retained_candidate_json ?? null,
      tweet.retained_until ?? null,
      tweet.override_requeued_at ?? null,
      tweet.override_requeued_by ?? null,
      tweet.first_failure_at ?? null,
      tweet.last_failure_at ?? null,
      tweet.attempts ?? 0,
      tweet.tweet_text || null,
      tweet.bsky_uri || null,
      tweet.bsky_cid || null,
      tweet.bsky_root_uri || null,
      tweet.bsky_root_cid || null,
      tweet.bsky_tail_uri || null,
      tweet.bsky_tail_cid || null,
      tweet.delivery_diagnostics ?? null,
      tweet.status,
      tweet.created_at ?? null,
    );
  },

  getTweetsByBskyIdentifier(bskyIdentifier: string): Record<string, ProcessedTweetLookupEntry> {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE bsky_identifier = ?');
    const rows = stmt.all(bskyIdentifier.toLowerCase()) as ProcessedTweetRow[];
    const map: Record<string, ProcessedTweetLookupEntry> = {};
    for (const row of rows) {
      map[row.twitter_id] = processedTweetRowToLookupEntry(row);
    }
    return map;
  },

  getPostsByDestinationId(destinationId: string): ProcessedTweet[] {
    return (
      db
        .prepare('SELECT * FROM processed_tweets WHERE destination_id = ? ORDER BY datetime(created_at) ASC, rowid ASC')
        .all(destinationId) as ProcessedTweetRow[]
    ).map(rowToProcessedTweet);
  },

  getTweetsByUsername(username: string): Record<string, ProcessedTweetLookupEntry> {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE twitter_username = ?');
    const rows = stmt.all(username.toLowerCase()) as ProcessedTweetRow[];
    const map: Record<string, ProcessedTweetLookupEntry> = {};
    for (const row of rows) {
      map[row.twitter_id] = processedTweetRowToLookupEntry(row);
    }
    return map;
  },

  getRecentProcessedTweets(limit = 50): ProcessedTweet[] {
    const stmt = db.prepare('SELECT * FROM processed_tweets ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?');
    return (stmt.all(limit) as ProcessedTweetRow[]).map(rowToProcessedTweet);
  },

  searchMigratedTweets(query: string, limit = 60, scanLimit = 3000): ProcessedTweetSearchResult[] {
    const normalizedQuery = normalizeSearchValue(query || '');
    if (!normalizedQuery) {
      return [];
    }

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 60;
    const safeScanLimit = Number.isFinite(scanLimit) ? Math.max(safeLimit, Math.min(scanLimit, 8000)) : 3000;
    const tokens = tokenizeSearchValue(normalizedQuery);

    const stmt = db.prepare(
      'SELECT * FROM processed_tweets WHERE status = "migrated" ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?',
    );
    const rows = (stmt.all(safeScanLimit) as ProcessedTweetRow[]).map(rowToProcessedTweet);

    return rows
      .map((row) => ({
        ...row,
        score: scoreProcessedTweet(row, normalizedQuery, tokens),
      }))
      .filter((row) => row.score >= 22)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const aTime = parseSqliteUtcTimestampMs(a.created_at) ?? 0;
        const bTime = parseSqliteUtcTimestampMs(b.created_at) ?? 0;
        return bTime - aTime;
      })
      .slice(0, safeLimit);
  },

  deleteTweetsByUsername(username: string) {
    const stmt = db.prepare('DELETE FROM processed_tweets WHERE twitter_username = ?');
    stmt.run(username.toLowerCase());
  },

  countTweetsBySourceForDestination(twitterUsername: string, bskyIdentifier: string): number {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM processed_tweets WHERE twitter_username = ? AND bsky_identifier = ?')
      .get(twitterUsername.toLowerCase(), bskyIdentifier.toLowerCase()) as { count: number } | undefined;
    return row?.count ?? 0;
  },

  deleteTweetsBySourceForDestination(twitterUsername: string, bskyIdentifier: string): number {
    db.prepare('DELETE FROM processed_tweets WHERE twitter_username = ? AND bsky_identifier = ?').run(
      twitterUsername.toLowerCase(),
      bskyIdentifier.toLowerCase(),
    );
    return changesCount();
  },

  deleteTweetsByBskyIdentifier(bskyIdentifier: string) {
    const stmt = db.prepare('DELETE FROM processed_tweets WHERE bsky_identifier = ?');
    stmt.run(bskyIdentifier.toLowerCase());
  },

  repairUnknownIdentifiers(twitterUsername: string, bskyIdentifier: string) {
    const stmt = db.prepare(
      'UPDATE processed_tweets SET bsky_identifier = ? WHERE bsky_identifier = "unknown" AND twitter_username = ?',
    );
    stmt.run(bskyIdentifier.toLowerCase(), twitterUsername.toLowerCase());
  },

  rekeyDestinationIdentity(
    previousIdentifier: string,
    nextIdentifier: string,
  ): {
    processed: number;
    queued: number;
  } {
    const previous = previousIdentifier.toLowerCase();
    const next = nextIdentifier.toLowerCase();
    if (!previous || previous === next) {
      return { processed: 0, queued: 0 };
    }
    let processed = 0;
    let queued = 0;
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO processed_tweets
          (twitter_id, twitter_username, bsky_identifier, tweet_text, bsky_uri, bsky_cid, bsky_root_uri,
           bsky_root_cid, bsky_tail_uri, bsky_tail_cid, status, created_at, source_type,
           external_post_id, destination_id, route_id, source_id, source_created_at, posted_at, skip_reason,
           error_category, error_message, policy_version, policy_snapshot, first_failure_at,
           last_failure_at, attempts)
        SELECT twitter_id, twitter_username, ?, tweet_text, bsky_uri, bsky_cid, bsky_root_uri,
               bsky_root_cid, bsky_tail_uri, bsky_tail_cid, status, created_at, source_type,
               external_post_id, destination_id, route_id, source_id, source_created_at, posted_at, skip_reason,
               error_category, error_message, policy_version, policy_snapshot, first_failure_at,
               last_failure_at, attempts
        FROM processed_tweets
        WHERE bsky_identifier = ?
      `).run(next, previous);
      processed = changesCount();
      db.prepare('DELETE FROM processed_tweets WHERE bsky_identifier = ?').run(previous);

      // The canonical queue key does not include bsky_identifier, so rows move
      // in place and keep their immutable queue_id. `OR IGNORE` skips rows that
      // would collide with an existing row at the new identifier; those are
      // duplicates and get dropped by the follow-up delete.
      db.prepare('UPDATE OR IGNORE post_queue SET bsky_identifier = ?, updated_at = ? WHERE bsky_identifier = ?').run(
        next,
        Date.now(),
        previous,
      );
      queued = changesCount();
      db.prepare('DELETE FROM post_queue WHERE bsky_identifier = ?').run(previous);
    })();
    return { processed, queued };
  },

  markOverrideRequeued(externalPostId: string, destinationId: string, actorId: string, at = Date.now()): void {
    db.prepare(`
      UPDATE processed_tweets
      SET override_requeued_at = ?, override_requeued_by = ?
      WHERE source_type = 'x' AND external_post_id = ? AND destination_id = ? AND status = 'skipped'
    `).run(at, actorId, externalPostId, destinationId);
  },

  consumeSkippedOverride(externalPostId: string, destinationId: string): number {
    db.prepare(`
      DELETE FROM processed_tweets
      WHERE source_type = 'x' AND external_post_id = ? AND destination_id = ?
        AND status = 'skipped' AND override_requeued_at IS NOT NULL
    `).run(externalPostId, destinationId);
    return changesCount();
  },

  // Marks and consumes the retained skip record atomically, and *before* the
  // caller enqueues the override so a worker can never observe the stale
  // skip row and the freshly-enqueued item at the same time (that race let a
  // worker's idempotency check treat the override as already settled and
  // silently drop it without ever posting). Returns 1 when the skip record
  // was consumed, 0 if it was already gone (e.g. a concurrent override).
  finalizeOverrideRequeue(externalPostId: string, destinationId: string, actorId: string, at = Date.now()): number {
    let removed = 0;
    db.transaction(() => {
      dbService.markOverrideRequeued(externalPostId, destinationId, actorId, at);
      removed = dbService.consumeSkippedOverride(externalPostId, destinationId);
    })();
    return removed;
  },

  purgeExpiredRetainedCandidates(now = Date.now()): number {
    db.prepare(`
      UPDATE processed_tweets
      SET retained_candidate_json = NULL, retained_until = NULL
      WHERE retained_until IS NOT NULL AND retained_until <= ?
    `).run(now);
    return changesCount();
  },

  clearAll() {
    db.prepare('DELETE FROM processed_tweets').run();
  },
};

export interface PersistedSourceRuntimeState {
  sourceId: string;
  lastCheckAt?: number;
  lastFetchSuccessAt?: number;
  lastTweetSeenId?: string;
  lastTweetSeenAt?: number;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  consecutiveFailures: number;
  consecutiveQuietChecks: number;
  nextEligibleCheckAt?: number;
}

export interface PersistedDestinationRuntimeState {
  destinationId: string;
  lastBskyLoginAt?: number;
  lastBskyPostAt?: number;
  lastProfileSyncAt?: number;
  lastPinSyncAt?: number;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  consecutiveFailures: number;
}

export type AppliedInitialImportMode = 'recent' | 'new-only';

export interface PersistedRouteInitialImportState {
  routeId: string;
  status: 'initialized';
  appliedMode: AppliedInitialImportMode;
  baselinePostId?: string;
  baselinePostCreatedAt?: number;
  initializedAt: number;
}

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const runtimeStateService = {
  getSource(sourceId: string): PersistedSourceRuntimeState | null {
    const row = db.prepare('SELECT * FROM source_runtime_state WHERE source_id = ?').get(sourceId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          sourceId: String(row.source_id),
          lastCheckAt: optionalNumber(row.last_check_at),
          lastFetchSuccessAt: optionalNumber(row.last_fetch_success_at),
          lastTweetSeenId: optionalText(row.last_tweet_seen_id),
          lastTweetSeenAt: optionalNumber(row.last_tweet_seen_at),
          lastErrorCategory: optionalText(row.last_error_category),
          lastErrorMessage: optionalText(row.last_error_message),
          lastErrorAt: optionalNumber(row.last_error_at),
          consecutiveFailures: Number(row.consecutive_failures) || 0,
          consecutiveQuietChecks: Number(row.consecutive_quiet_checks) || 0,
          nextEligibleCheckAt: optionalNumber(row.next_eligible_check_at),
        }
      : null;
  },

  listSources(): PersistedSourceRuntimeState[] {
    const rows = db.prepare('SELECT source_id FROM source_runtime_state ORDER BY source_id').all() as Array<{
      source_id: string;
    }>;
    return rows
      .map((row) => this.getSource(row.source_id))
      .filter((state): state is PersistedSourceRuntimeState => state !== null);
  },

  saveSource(state: PersistedSourceRuntimeState): void {
    db.prepare(`
      INSERT INTO source_runtime_state (
        source_id, last_check_at, last_fetch_success_at, last_tweet_seen_id,
        last_tweet_seen_at, last_error_category, last_error_message, last_error_at,
        consecutive_failures, consecutive_quiet_checks, next_eligible_check_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        last_check_at = excluded.last_check_at,
        last_fetch_success_at = excluded.last_fetch_success_at,
        last_tweet_seen_id = excluded.last_tweet_seen_id,
        last_tweet_seen_at = excluded.last_tweet_seen_at,
        last_error_category = excluded.last_error_category,
        last_error_message = excluded.last_error_message,
        last_error_at = excluded.last_error_at,
        consecutive_failures = excluded.consecutive_failures,
        consecutive_quiet_checks = excluded.consecutive_quiet_checks,
        next_eligible_check_at = excluded.next_eligible_check_at
    `).run(
      state.sourceId,
      state.lastCheckAt ?? null,
      state.lastFetchSuccessAt ?? null,
      state.lastTweetSeenId ?? null,
      state.lastTweetSeenAt ?? null,
      state.lastErrorCategory ?? null,
      state.lastErrorMessage?.slice(0, 500) ?? null,
      state.lastErrorAt ?? null,
      state.consecutiveFailures,
      state.consecutiveQuietChecks,
      state.nextEligibleCheckAt ?? null,
    );
  },

  recordSourceSuccess(input: {
    sourceId: string;
    checkedAt: number;
    nextEligibleCheckAt: number;
    lastTweetSeenId?: string;
    lastTweetSeenAt?: number;
    quiet: boolean;
  }): PersistedSourceRuntimeState {
    const previous = this.getSource(input.sourceId);
    const state: PersistedSourceRuntimeState = {
      sourceId: input.sourceId,
      lastCheckAt: input.checkedAt,
      lastFetchSuccessAt: input.checkedAt,
      lastTweetSeenId: input.lastTweetSeenId ?? previous?.lastTweetSeenId,
      lastTweetSeenAt: input.lastTweetSeenAt ?? previous?.lastTweetSeenAt,
      consecutiveFailures: 0,
      consecutiveQuietChecks: input.quiet ? (previous?.consecutiveQuietChecks ?? 0) + 1 : 0,
      nextEligibleCheckAt: input.nextEligibleCheckAt,
    };
    this.saveSource(state);
    return state;
  },

  recordSourceFailure(input: {
    sourceId: string;
    checkedAt: number;
    nextEligibleCheckAt: number;
    category: string;
    message: string;
  }): PersistedSourceRuntimeState {
    const previous = this.getSource(input.sourceId);
    const state: PersistedSourceRuntimeState = {
      sourceId: input.sourceId,
      lastCheckAt: input.checkedAt,
      lastFetchSuccessAt: previous?.lastFetchSuccessAt,
      lastTweetSeenId: previous?.lastTweetSeenId,
      lastTweetSeenAt: previous?.lastTweetSeenAt,
      lastErrorCategory: input.category,
      lastErrorMessage: input.message.slice(0, 500),
      lastErrorAt: input.checkedAt,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      consecutiveQuietChecks: previous?.consecutiveQuietChecks ?? 0,
      nextEligibleCheckAt: input.nextEligibleCheckAt,
    };
    this.saveSource(state);
    return state;
  },

  getDestination(destinationId: string): PersistedDestinationRuntimeState | null {
    const row = db.prepare('SELECT * FROM destination_runtime_state WHERE destination_id = ?').get(destinationId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          destinationId: String(row.destination_id),
          lastBskyLoginAt: optionalNumber(row.last_bsky_login_at),
          lastBskyPostAt: optionalNumber(row.last_bsky_post_at),
          lastProfileSyncAt: optionalNumber(row.last_profile_sync_at),
          lastPinSyncAt: optionalNumber(row.last_pin_sync_at),
          lastErrorCategory: optionalText(row.last_error_category),
          lastErrorMessage: optionalText(row.last_error_message),
          lastErrorAt: optionalNumber(row.last_error_at),
          consecutiveFailures: Number(row.consecutive_failures) || 0,
        }
      : null;
  },

  recordDestinationEvent(destinationId: string, event: 'login' | 'post' | 'profile' | 'pin', at = Date.now()): void {
    const column = {
      login: 'last_bsky_login_at',
      post: 'last_bsky_post_at',
      profile: 'last_profile_sync_at',
      pin: 'last_pin_sync_at',
    }[event];
    db.prepare(`
      INSERT INTO destination_runtime_state (destination_id, ${column}, consecutive_failures)
      VALUES (?, ?, 0)
      ON CONFLICT(destination_id) DO UPDATE SET
        ${column} = excluded.${column},
        consecutive_failures = 0
    `).run(destinationId, at);
  },

  recordDestinationFailure(destinationId: string, category: string, message: string, at = Date.now()): void {
    db.prepare(`
      INSERT INTO destination_runtime_state (
        destination_id, last_error_category, last_error_message, last_error_at, consecutive_failures
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(destination_id) DO UPDATE SET
        last_error_category = excluded.last_error_category,
        last_error_message = excluded.last_error_message,
        last_error_at = excluded.last_error_at,
        consecutive_failures = destination_runtime_state.consecutive_failures + 1
    `).run(destinationId, category, message.slice(0, 500), at);
  },
};

/**
 * Route-scoped because delivery history is destination-scoped even when one
 * canonical X source fans out to multiple destinations.
 */
export const routeInitialImportStateService = {
  get(routeId: string): PersistedRouteInitialImportState | null {
    const row = db.prepare('SELECT * FROM route_initial_import_state WHERE route_id = ?').get(routeId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          routeId: String(row.route_id),
          status: 'initialized',
          appliedMode: row.applied_mode === 'new-only' ? 'new-only' : 'recent',
          baselinePostId: optionalText(row.baseline_post_id),
          baselinePostCreatedAt: optionalNumber(row.baseline_post_created_at),
          initializedAt: Number(row.initialized_at),
        }
      : null;
  },

  initialize(input: {
    routeId: string;
    appliedMode: AppliedInitialImportMode;
    baselinePostId?: string;
    baselinePostCreatedAt?: number;
    initializedAt?: number;
  }): PersistedRouteInitialImportState {
    const initializedAt = input.initializedAt ?? Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO route_initial_import_state (
        route_id, status, applied_mode, baseline_post_id, baseline_post_created_at, initialized_at
      ) VALUES (?, 'initialized', ?, ?, ?, ?)
    `).run(
      input.routeId,
      input.appliedMode,
      input.baselinePostId ?? null,
      input.baselinePostCreatedAt ?? null,
      initializedAt,
    );
    const state = this.get(input.routeId);
    if (!state) throw new Error(`Failed to persist initial-import state for route ${input.routeId}.`);
    return state;
  },
};

// ============================================================================
// Post Queue Service
// ============================================================================

export type QueueItemKind = 'scheduled' | 'backfill';
export type QueueItemStatus = 'pending' | 'processing' | 'failed';

export interface QueueItem {
  /** Immutable row identity; stable across destination rekeys and re-enqueues. */
  queue_id: string;
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  source_type: string;
  external_post_id: string;
  destination_id: string;
  route_id?: string;
  source_id?: string;
  source_created_at?: number;
  posted_at?: number;
  skip_reason?: string;
  error_category?: string;
  error_message?: string;
  policy_version: number;
  policy_snapshot?: string;
  decision_version: number;
  decision_trace?: string;
  snapshot_updated_at?: number;
  snapshot_updated_by?: string;
  snapshot_update_reason?: string;
  previous_policy_hash?: string;
  kind: QueueItemKind;
  request_id?: string;
  tweet_json: string;
  tweet_text?: string;
  status: QueueItemStatus;
  attempts: number;
  not_before: number;
  last_error?: string;
  first_failure_at?: number;
  last_failure_at?: number;
  enqueued_at: number;
  updated_at: number;
  delivery_diagnostics?: string;
}

export interface QueueEnqueueInput {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  source_type?: string;
  external_post_id?: string;
  destination_id?: string;
  route_id?: string;
  source_id?: string;
  source_created_at?: number;
  policy_version?: number;
  policy_snapshot?: string;
  decision_version?: number;
  decision_trace?: string;
  kind: QueueItemKind;
  request_id?: string;
  tweet_json: string;
  tweet_text?: string;
}

export interface QueueBatch {
  mapping_id: string;
  bsky_identifier: string;
  destination_id: string;
  route_id?: string;
  destination_key: string;
  twitter_username: string;
  items: QueueItem[];
}

export interface QueueMappingCounts {
  mapping_id: string;
  bsky_identifier: string;
  destination_id: string;
  pending: number;
  processing: number;
  failed: number;
  oldest_enqueued_at: number | null;
}

export interface QueueCounts {
  pending: number;
  processing: number;
  failed: number;
  perMapping: QueueMappingCounts[];
}

// Twitter ids are numeric snowflakes, so shorter strings are always older.
// Ordering by (length, value) yields chronological order without BigInt casts.
const TWEET_ID_ORDER = 'LENGTH(twitter_id) ASC, twitter_id ASC';

const changesCount = (): number => {
  const row = db.prepare('SELECT changes() AS c').get() as { c: number } | undefined;
  return row?.c ?? 0;
};

export const databaseHealthService = {
  check(): { status: 'ok' | 'error'; latestMigration: number } {
    try {
      db.prepare('SELECT 1 AS ok').get();
      const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
        | { version?: number }
        | undefined;
      return { status: 'ok', latestMigration: Number(row?.version) || 0 };
    } catch {
      return { status: 'error', latestMigration: 0 };
    }
  },
};

interface PostQueueRow {
  queue_id?: string;
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  source_type: string;
  external_post_id: string;
  destination_id: string;
  route_id?: string | null;
  source_id?: string | null;
  source_created_at?: number | null;
  posted_at?: number | null;
  skip_reason?: string | null;
  error_category?: string | null;
  error_message?: string | null;
  policy_version: number;
  policy_snapshot?: string | null;
  decision_version?: number;
  decision_trace?: string | null;
  snapshot_updated_at?: number | null;
  snapshot_updated_by?: string | null;
  snapshot_update_reason?: string | null;
  previous_policy_hash?: string | null;
  kind: QueueItemKind;
  request_id?: string | null;
  tweet_json?: string;
  tweet_text?: string | null;
  status: QueueItemStatus;
  attempts: number;
  not_before: number;
  last_error?: string | null;
  first_failure_at?: number | null;
  last_failure_at?: number | null;
  enqueued_at: number;
  updated_at: number;
  delivery_diagnostics?: string | null;
}

const rowToQueueItem = (row: PostQueueRow): QueueItem => ({
  queue_id: row.queue_id ?? '',
  twitter_id: row.twitter_id,
  bsky_identifier: row.bsky_identifier,
  mapping_id: row.mapping_id,
  twitter_username: row.twitter_username,
  source_type: row.source_type,
  external_post_id: row.external_post_id,
  destination_id: row.destination_id,
  route_id: row.route_id ?? undefined,
  source_id: row.source_id || undefined,
  source_created_at: row.source_created_at ?? undefined,
  posted_at: row.posted_at ?? undefined,
  skip_reason: row.skip_reason ?? undefined,
  error_category: row.error_category ?? undefined,
  error_message: row.error_message ?? undefined,
  policy_version: row.policy_version,
  policy_snapshot: row.policy_snapshot ?? undefined,
  decision_version: Number(row.decision_version) || 1,
  decision_trace: row.decision_trace ?? undefined,
  snapshot_updated_at: row.snapshot_updated_at ?? undefined,
  snapshot_updated_by: row.snapshot_updated_by ?? undefined,
  snapshot_update_reason: row.snapshot_update_reason ?? undefined,
  previous_policy_hash: row.previous_policy_hash ?? undefined,
  kind: row.kind,
  request_id: row.request_id ?? undefined,
  tweet_json: row.tweet_json ?? '',
  tweet_text: row.tweet_text ?? undefined,
  status: row.status,
  attempts: row.attempts,
  not_before: row.not_before,
  last_error: row.last_error ?? undefined,
  first_failure_at: row.first_failure_at ?? undefined,
  last_failure_at: row.last_failure_at ?? undefined,
  enqueued_at: row.enqueued_at,
  updated_at: row.updated_at,
  delivery_diagnostics: row.delivery_diagnostics ?? undefined,
});

export interface QueueScope {
  queueId?: string;
  twitterId?: string;
  bskyIdentifier?: string;
  mappingId?: string;
  destinationId?: string;
  routeId?: string;
  sourceId?: string;
  twitterUsername?: string;
  requestId?: string;
}

function queueScopeClause(scope: QueueScope): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: string | undefined, normalize = false): void => {
    if (!value) return;
    clauses.push(`${column} = ?`);
    params.push(normalize ? value.toLowerCase() : value);
  };
  add('queue_id', scope.queueId);
  add('twitter_id', scope.twitterId);
  add('bsky_identifier', scope.bskyIdentifier, true);
  add('mapping_id', scope.mappingId);
  add('destination_id', scope.destinationId);
  add('route_id', scope.routeId);
  add('source_id', scope.sourceId);
  add('twitter_username', scope.twitterUsername, true);
  add('request_id', scope.requestId);
  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1', params };
}

export interface QueueDiagnostic extends Omit<QueueItem, 'tweet_json'> {
  queue_age_ms: number;
  source_tweet_url: string;
  policy_behavior: 'snapshotted' | 'current';
  redacted_diagnostic: string;
}

export const postQueueService = {
  // INSERT OR IGNORE dedupes against both the legacy (twitter_id,
  // bsky_identifier) key and the canonical (source_type, source_id,
  // external_post_id, destination_id) key, so generic posts that share a
  // twitter_id placeholder still dedupe correctly; callers additionally
  // pre-filter against processed_tweets. Returns how many rows were inserted.
  enqueue(items: QueueEnqueueInput[]): number {
    if (items.length === 0) return 0;
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO post_queue
        (queue_id, twitter_id, bsky_identifier, mapping_id, twitter_username, source_type,
         external_post_id, destination_id, route_id, source_id, source_created_at, policy_version,
         policy_snapshot, decision_version, decision_trace, kind, request_id, tweet_json, tweet_text, status, attempts, not_before,
         enqueued_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
    `);
    let inserted = 0;
    const runAll = db.transaction(() => {
      for (const item of items) {
        stmt.run(
          randomUUID(),
          item.twitter_id,
          item.bsky_identifier.toLowerCase(),
          item.mapping_id,
          item.twitter_username.toLowerCase(),
          item.source_type ?? 'x',
          item.external_post_id ?? item.twitter_id,
          item.destination_id ?? item.mapping_id,
          item.route_id ?? null,
          item.source_id ?? '',
          item.source_created_at ?? null,
          item.policy_version ?? 1,
          item.policy_snapshot ?? null,
          item.decision_version ?? 1,
          item.decision_trace ?? null,
          item.kind,
          item.request_id ?? null,
          item.tweet_json,
          item.tweet_text ?? null,
          now,
          now,
        );
        inserted += changesCount();
      }
    });
    runAll();
    return inserted;
  },

  getItem(scope: QueueScope): QueueItem | null {
    const clause = queueScopeClause(scope);
    const row = db.prepare(`SELECT * FROM post_queue WHERE ${clause.sql} LIMIT 1`).get(...clause.params) as
      | PostQueueRow
      | undefined;
    return row ? rowToQueueItem(row) : null;
  },

  // Every queued twitter_id for a Bluesky target regardless of status, so the
  // sweep treats queued-but-not-yet-posted tweets as already seen.
  getQueuedIdSet(bskyIdentifier: string): Set<string> {
    const rows = db
      .prepare('SELECT twitter_id FROM post_queue WHERE bsky_identifier = ?')
      .all(bskyIdentifier.toLowerCase()) as { twitter_id: string }[];
    return new Set(rows.map((row) => row.twitter_id));
  },

  getQueueIds(scope: QueueScope): string[] {
    const clause = queueScopeClause(scope);
    return (
      db
        .prepare(`SELECT queue_id FROM post_queue WHERE ${clause.sql} ORDER BY enqueued_at ASC`)
        .all(...clause.params) as Array<{ queue_id: string }>
    ).map((row) => row.queue_id);
  },

  getQueuedExternalPostIdSet(destinationId: string): Set<string> {
    const rows = db.prepare('SELECT external_post_id FROM post_queue WHERE destination_id = ?').all(destinationId) as {
      external_post_id: string;
    }[];
    return new Set(rows.map((row) => row.external_post_id));
  },

  hasQueuedPost(input: {
    sourceType: string;
    sourceId: string;
    externalPostId: string;
    destinationId: string;
  }): boolean {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS found FROM post_queue
           WHERE source_type = ? AND source_id = ? AND external_post_id = ? AND destination_id = ?
           LIMIT 1`,
        )
        .get(input.sourceType, input.sourceId, input.externalPostId, input.destinationId),
    );
  },

  // Claims the oldest eligible (mapping, source account) group and marks its
  // pending rows as processing. The scheduler supplies a canonical destination
  // key so two compatibility mappings for the same DID can never post in
  // parallel.
  claimNextBatch(
    excludedDestinationKeys: Set<string>,
    allowedMappingIds: Set<string>,
    resolveDestinationKey: (mappingId: string) => string = (mappingId) => mappingId,
    maxItems = 50,
    // Runs inside the claim transaction, so acquiring the cross-process
    // destination lease and marking items 'processing' either both happen or
    // neither does.
    acquireLease?: (destinationKey: string) => boolean,
  ): QueueBatch | null {
    const now = Date.now();
    const groups = db
      .prepare(`
        SELECT mapping_id, twitter_username, bsky_identifier, destination_id, route_id, policy_snapshot,
               MIN(enqueued_at) AS oldest
        FROM post_queue
        WHERE status = 'pending' AND not_before <= ?
        GROUP BY mapping_id, twitter_username, bsky_identifier, destination_id, route_id, policy_snapshot
        ORDER BY oldest ASC
      `)
      .all(now) as {
      mapping_id: string;
      twitter_username: string;
      bsky_identifier: string;
      destination_id: string;
      route_id?: string;
      policy_snapshot?: string;
    }[];

    const group = groups.find(
      (candidate) =>
        allowedMappingIds.has(candidate.mapping_id) &&
        !excludedDestinationKeys.has(resolveDestinationKey(candidate.destination_id || candidate.mapping_id)),
    );
    if (!group) return null;
    const destinationKey = resolveDestinationKey(group.destination_id || group.mapping_id);

    let items: QueueItem[] = [];
    const claim = db.transaction(() => {
      if (acquireLease && !acquireLease(destinationKey)) return;
      const rows = db
        .prepare(`
          SELECT * FROM post_queue
          WHERE status = 'pending' AND not_before <= ?
            AND mapping_id = ? AND twitter_username = ? AND bsky_identifier = ?
            AND destination_id = ? AND route_id IS ? AND policy_snapshot IS ?
          ORDER BY ${TWEET_ID_ORDER}
          LIMIT ?
        `)
        .all(
          now,
          group.mapping_id,
          group.twitter_username,
          group.bsky_identifier,
          group.destination_id,
          group.route_id ?? null,
          group.policy_snapshot ?? null,
          maxItems,
        ) as PostQueueRow[];
      items = rows.map(rowToQueueItem);
      const mark = db.prepare("UPDATE post_queue SET status = 'processing', updated_at = ? WHERE queue_id = ?");
      for (const item of items) {
        mark.run(now, item.queue_id);
      }
    });
    claim();

    if (items.length === 0) return null;
    return {
      mapping_id: group.mapping_id,
      bsky_identifier: group.bsky_identifier,
      destination_id: group.destination_id,
      route_id: group.route_id,
      destination_key: destinationKey,
      twitter_username: group.twitter_username,
      items,
    };
  },

  setDeliveryDiagnostics(twitterId: string, bskyIdentifier: string, diagnosticsJson: string): void {
    db.prepare(
      'UPDATE post_queue SET delivery_diagnostics = ?, updated_at = ? WHERE twitter_id = ? AND bsky_identifier = ?',
    ).run(diagnosticsJson, Date.now(), twitterId, bskyIdentifier.toLowerCase());
  },

  markDone(twitterId: string, bskyIdentifier: string): void {
    db.prepare('DELETE FROM post_queue WHERE twitter_id = ? AND bsky_identifier = ?').run(
      twitterId,
      bskyIdentifier.toLowerCase(),
    );
  },

  // Preferred over markDone: identity is the immutable queue id, so a generic
  // post that shares a twitter_id placeholder with another row is unaffected.
  markDoneById(queueId: string): number {
    if (!queueId) return 0;
    db.prepare('DELETE FROM post_queue WHERE queue_id = ?').run(queueId);
    return changesCount();
  },

  // Failed attempt: exponential backoff (5 min doubling, capped at 6h), then
  // terminal 'failed' after maxAttempts so a poison tweet can't retry forever.
  releaseForRetry(item: QueueItem, error: unknown, maxAttempts: number): void {
    const attempts = item.attempts + 1;
    const now = Date.now();
    const errorMessage = sanitizedErrorMessage(error);
    const category = classifyQueueError(error);
    const identity = item.queue_id
      ? { clause: 'queue_id = ?', params: [item.queue_id] }
      : { clause: 'twitter_id = ? AND bsky_identifier = ?', params: [item.twitter_id, item.bsky_identifier] };
    if (attempts >= maxAttempts) {
      db.prepare(
        `UPDATE post_queue SET status = 'failed', attempts = ?, last_error = ?, error_category = ?, error_message = ?, first_failure_at = COALESCE(first_failure_at, ?), last_failure_at = ?, updated_at = ? WHERE ${identity.clause}`,
      ).run(attempts, errorMessage, category, errorMessage, now, now, now, ...identity.params);
      return;
    }
    const backoffMs = Math.min(5 * 60 * 1000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);
    db.prepare(
      `UPDATE post_queue SET status = 'pending', attempts = ?, not_before = ?, last_error = ?, error_category = ?, error_message = ?, first_failure_at = COALESCE(first_failure_at, ?), last_failure_at = ?, updated_at = ? WHERE ${identity.clause}`,
    ).run(attempts, now + backoffMs, errorMessage, category, errorMessage, now, now, now, ...identity.params);
  },

  // Crash recovery: anything left 'processing' by a previous run goes back to
  // pending. processed_tweets checks make re-runs idempotent.
  resetProcessing(): number {
    db.prepare("UPDATE post_queue SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(Date.now());
    return changesCount();
  },

  getCounts(): QueueCounts {
    const totals = db.prepare('SELECT status, COUNT(*) AS count FROM post_queue GROUP BY status').all() as {
      status: QueueItemStatus;
      count: number;
    }[];
    const perMapping = db
      .prepare(`
        SELECT mapping_id, bsky_identifier, destination_id,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          MIN(CASE WHEN status IN ('pending', 'processing') THEN enqueued_at ELSE NULL END) AS oldest_enqueued_at
        FROM post_queue
        GROUP BY mapping_id, bsky_identifier, destination_id
        ORDER BY oldest_enqueued_at ASC
      `)
      .all() as QueueMappingCounts[];
    const byStatus = new Map(totals.map((row) => [row.status, row.count]));
    return {
      pending: byStatus.get('pending') ?? 0,
      processing: byStatus.get('processing') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      perMapping,
    };
  },

  // Item listing for the dashboard; tweet_json is omitted to keep payloads small.
  listItems(options: { mappingIds?: Set<string>; limit?: number } = {}): Omit<QueueItem, 'tweet_json'>[] {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const rows = db
      .prepare(`
        SELECT queue_id, twitter_id, bsky_identifier, mapping_id, twitter_username, source_type,
               external_post_id, destination_id, route_id, source_id, source_created_at, posted_at,
               skip_reason, error_category, error_message, policy_version, policy_snapshot,
               decision_version, decision_trace, snapshot_updated_at, snapshot_updated_by,
               snapshot_update_reason, previous_policy_hash, kind, request_id,
               tweet_text, status, attempts, not_before, last_error, first_failure_at,
               last_failure_at, enqueued_at, updated_at
        FROM post_queue
        ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, enqueued_at ASC, ${TWEET_ID_ORDER}
        LIMIT ?
      `)
      .all(limit * 4) as PostQueueRow[];
    const filtered = options.mappingIds ? rows.filter((row) => options.mappingIds?.has(row.mapping_id)) : rows;
    return filtered.slice(0, limit).map((row) => {
      const item = rowToQueueItem({ ...row, tweet_json: '' });
      const { tweet_json: _omit, ...rest } = item;
      return rest;
    });
  },

  cancelPendingByRequestId(requestId: string): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'pending' AND request_id = ?").run(requestId);
    return changesCount();
  },

  getSourceCounts(
    mappingId: string,
    twitterUsername: string,
  ): {
    pending: number;
    processing: number;
    failed: number;
  } {
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM post_queue
         WHERE mapping_id = ? AND twitter_username = ?
         GROUP BY status`,
      )
      .all(mappingId, twitterUsername.toLowerCase()) as { status: QueueItemStatus; count: number }[];
    const byStatus = new Map(rows.map((row) => [row.status, row.count]));
    return {
      pending: byStatus.get('pending') ?? 0,
      processing: byStatus.get('processing') ?? 0,
      failed: byStatus.get('failed') ?? 0,
    };
  },

  cancelPendingByMappingAndSource(mappingId: string, twitterUsername: string): number {
    db.prepare("DELETE FROM post_queue WHERE mapping_id = ? AND twitter_username = ? AND status = 'pending'").run(
      mappingId,
      twitterUsername.toLowerCase(),
    );
    return changesCount();
  },

  cancelPendingByRouteId(routeId: string): number {
    db.prepare("DELETE FROM post_queue WHERE route_id = ? AND status = 'pending'").run(routeId);
    return changesCount();
  },

  cancelPendingBackfills(mappingId?: string): number {
    if (mappingId) {
      db.prepare("DELETE FROM post_queue WHERE status = 'pending' AND kind = 'backfill' AND mapping_id = ?").run(
        mappingId,
      );
    } else {
      db.prepare("DELETE FROM post_queue WHERE status = 'pending' AND kind = 'backfill'").run();
    }
    return changesCount();
  },

  deleteByMappingId(mappingId: string): number {
    db.prepare("DELETE FROM post_queue WHERE mapping_id = ? AND status != 'processing'").run(mappingId);
    return changesCount();
  },

  deleteByBskyIdentifier(bskyIdentifier: string): number {
    db.prepare("DELETE FROM post_queue WHERE bsky_identifier = ? AND status != 'processing'").run(
      bskyIdentifier.toLowerCase(),
    );
    return changesCount();
  },

  inspect(scope: QueueScope): QueueDiagnostic[] {
    const clause = queueScopeClause(scope);
    const rows = db
      .prepare(`SELECT * FROM post_queue WHERE ${clause.sql} ORDER BY enqueued_at ASC`)
      .all(...clause.params) as PostQueueRow[];
    const now = Date.now();
    return rows.map((row) => {
      const item = rowToQueueItem(row);
      const { tweet_json: _payload, ...safeItem } = item;
      const diagnostic = sanitizeForDiagnostics({
        ...safeItem,
        last_error: safeItem.last_error,
        error_message: safeItem.error_message,
      });
      return {
        ...safeItem,
        queue_age_ms: Math.max(0, now - item.enqueued_at),
        source_tweet_url: `https://x.com/${encodeURIComponent(item.twitter_username)}/status/${encodeURIComponent(item.twitter_id)}`,
        policy_behavior: item.policy_snapshot ? ('snapshotted' as const) : ('current' as const),
        redacted_diagnostic: JSON.stringify(diagnostic, null, 2),
      };
    });
  },

  cancelPending(scope: QueueScope): number {
    const clause = queueScopeClause(scope);
    db.prepare(`DELETE FROM post_queue WHERE status = 'pending' AND ${clause.sql}`).run(...clause.params);
    return changesCount();
  },

  clearFailed(scope: QueueScope = {}): number {
    const clause = queueScopeClause(scope);
    db.prepare(`DELETE FROM post_queue WHERE status = 'failed' AND ${clause.sql}`).run(...clause.params);
    return changesCount();
  },

  retryFailed(scope: QueueScope = {}): number {
    const clause = queueScopeClause(scope);
    db.prepare(
      `UPDATE post_queue
       SET status = 'pending', attempts = 0, not_before = 0, updated_at = ?
       WHERE status = 'failed' AND ${clause.sql}`,
    ).run(Date.now(), ...clause.params);
    return changesCount();
  },

  rewritePolicySnapshots(
    scope: QueueScope,
    actorId: string,
    reason: string,
    resolve: (item: QueueItem) => {
      policyVersion: number;
      policySnapshot: string;
      decisionVersion: number;
      decisionTrace: string;
    },
  ): number {
    const clause = queueScopeClause(scope);
    const rows = db
      .prepare(`SELECT * FROM post_queue WHERE status != 'processing' AND ${clause.sql}`)
      .all(...clause.params) as PostQueueRow[];
    const now = Date.now();
    let affected = 0;
    db.transaction(() => {
      const update = db.prepare(`
        UPDATE post_queue SET
          policy_version = ?, policy_snapshot = ?, snapshot_updated_at = ?,
          snapshot_updated_by = ?, snapshot_update_reason = ?, previous_policy_hash = ?,
          decision_version = ?, decision_trace = ?,
          status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
          not_before = CASE WHEN status = 'failed' THEN 0 ELSE not_before END,
          attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
          updated_at = ?
        WHERE queue_id = ? AND status != 'processing'
      `);
      for (const row of rows) {
        const item = rowToQueueItem(row);
        const next = resolve(item);
        let previousHash: string | undefined;
        try {
          previousHash = item.policy_snapshot
            ? String((JSON.parse(item.policy_snapshot) as { hash?: unknown }).hash || '')
            : undefined;
        } catch {
          previousHash = undefined;
        }
        update.run(
          next.policyVersion,
          next.policySnapshot,
          now,
          actorId,
          reason.slice(0, 200),
          previousHash || null,
          next.decisionVersion,
          next.decisionTrace,
          now,
          item.queue_id,
        );
        affected += changesCount();
      }
    })();
    return affected;
  },

  purgeFailedOlderThan(maxAgeMs: number): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'failed' AND updated_at < ?").run(Date.now() - maxAgeMs);
    return changesCount();
  },
};

export interface DuplicateFingerprint {
  id: number;
  destinationId: string;
  routeId?: string;
  externalPostId: string;
  textUrlHash: string;
  imageHash?: string;
  createdAt: number;
}

const rowToFingerprint = (row: Record<string, unknown>): DuplicateFingerprint => ({
  id: Number(row.id),
  destinationId: String(row.destination_id),
  routeId: optionalText(row.route_id),
  externalPostId: String(row.external_post_id),
  textUrlHash: String(row.text_url_hash),
  imageHash: optionalText(row.image_hash),
  createdAt: Number(row.created_at),
});

export const duplicateFingerprintService = {
  findRecent(input: {
    destinationId: string;
    routeId?: string;
    textUrlHash: string;
    imageHash?: string;
    since: number;
    routeScoped?: boolean;
    excludeExternalPostId?: string;
  }): DuplicateFingerprint | null {
    const routeClause = input.routeScoped ? 'AND route_id IS ?' : '';
    const excludeClause = input.excludeExternalPostId ? 'AND external_post_id != ?' : '';
    const row = db
      .prepare(`
        SELECT * FROM content_fingerprints
        WHERE destination_id = ?
          AND (text_url_hash = ? OR (? IS NOT NULL AND image_hash = ?))
          AND created_at >= ?
          ${routeClause}
          ${excludeClause}
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(
        input.destinationId,
        input.textUrlHash,
        input.imageHash ?? null,
        input.imageHash ?? null,
        input.since,
        ...(input.routeScoped ? [input.routeId ?? null] : []),
        ...(input.excludeExternalPostId ? [input.excludeExternalPostId] : []),
      ) as Record<string, unknown> | undefined;
    return row ? rowToFingerprint(row) : null;
  },

  record(input: {
    destinationId: string;
    routeId?: string;
    externalPostId: string;
    textUrlHash: string;
    imageHash?: string;
    createdAt?: number;
    overrideOfId?: number;
  }): number {
    db.prepare(`
      INSERT INTO content_fingerprints (
        destination_id, route_id, external_post_id, text_url_hash, image_hash, created_at, override_of_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.destinationId,
      input.routeId ?? null,
      input.externalPostId,
      input.textUrlHash,
      input.imageHash ?? null,
      input.createdAt ?? Date.now(),
      input.overrideOfId ?? null,
    );
    const row = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    return Number(row.id);
  },

  /**
   * Atomically looks for a recent duplicate and, when none exists, records the
   * caller's fingerprint in the same transaction. Two concurrent workers can
   * therefore never both conclude "not a duplicate" for the same content, and a
   * caller that finds no duplicate does not have to remember to record one
   * afterwards (which is how identical content used to be reprocessed forever).
   */
  reserve(input: {
    destinationId: string;
    routeId?: string;
    externalPostId: string;
    textUrlHash: string;
    imageHash?: string;
    since: number;
    routeScoped?: boolean;
    createdAt?: number;
  }): { duplicate: DuplicateFingerprint | null; fingerprintId?: number } {
    let result: { duplicate: DuplicateFingerprint | null; fingerprintId?: number } = { duplicate: null };
    db.transaction(() => {
      const duplicate = this.findRecent({
        destinationId: input.destinationId,
        routeId: input.routeId,
        textUrlHash: input.textUrlHash,
        imageHash: input.imageHash,
        since: input.since,
        routeScoped: input.routeScoped,
        excludeExternalPostId: input.externalPostId,
      });
      if (duplicate) {
        result = { duplicate };
        return;
      }
      result = {
        duplicate: null,
        fingerprintId: this.record({
          destinationId: input.destinationId,
          routeId: input.routeId,
          externalPostId: input.externalPostId,
          textUrlHash: input.textUrlHash,
          imageHash: input.imageHash,
          createdAt: input.createdAt,
        }),
      };
    })();
    return result;
  },

  /** Undoes a reservation when the post it was taken for never shipped. */
  release(fingerprintId?: number): boolean {
    if (!fingerprintId) return false;
    db.prepare('DELETE FROM content_fingerprints WHERE id = ? AND override_of_id IS NULL').run(fingerprintId);
    return changesCount() === 1;
  },

  clearDestination(destinationId: string): number {
    db.prepare('DELETE FROM content_fingerprints WHERE destination_id = ?').run(destinationId);
    return changesCount();
  },
};

// ============================================================================
// Destination Leases
// ============================================================================

export interface DestinationLease {
  destinationKey: string;
  ownerId: string;
  purpose: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

const rowToDestinationLease = (row: Record<string, unknown>): DestinationLease => ({
  destinationKey: String(row.destination_key),
  ownerId: String(row.owner_id),
  purpose: String(row.purpose),
  acquiredAt: Number(row.acquired_at),
  renewedAt: Number(row.renewed_at),
  expiresAt: Number(row.expires_at),
});

/**
 * Cross-process destination locking. The in-memory active-destination set only
 * serialises workers inside one process, so a second replica could post to the
 * same destination concurrently. Leases are keyed on the canonical destination
 * key, carry an owner token, and expire so a crashed replica cannot deadlock a
 * destination forever.
 */
export const destinationLeaseService = {
  acquire(input: {
    destinationKey: string;
    ownerId: string;
    ttlMs: number;
    purpose?: string;
    now?: number;
  }): DestinationLease | null {
    const now = input.now ?? Date.now();
    const expiresAt = now + Math.max(1_000, input.ttlMs);
    const purpose = input.purpose ?? 'delivery';
    let lease: DestinationLease | null = null;
    db.transaction(() => {
      db.prepare('DELETE FROM destination_leases WHERE expires_at <= ?').run(now);
      db.prepare(`
        INSERT INTO destination_leases (destination_key, owner_id, purpose, acquired_at, renewed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(destination_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          purpose = excluded.purpose,
          renewed_at = excluded.renewed_at,
          expires_at = excluded.expires_at
        WHERE destination_leases.owner_id = excluded.owner_id OR destination_leases.expires_at <= excluded.renewed_at
      `).run(input.destinationKey, input.ownerId, purpose, now, now, expiresAt);
      if (changesCount() !== 1) return;
      lease = this.get(input.destinationKey);
      if (lease && lease.ownerId !== input.ownerId) lease = null;
    })();
    return lease;
  },

  renew(destinationKey: string, ownerId: string, ttlMs: number, now = Date.now()): boolean {
    db.prepare(
      'UPDATE destination_leases SET renewed_at = ?, expires_at = ? WHERE destination_key = ? AND owner_id = ?',
    ).run(now, now + Math.max(1_000, ttlMs), destinationKey, ownerId);
    return changesCount() === 1;
  },

  release(destinationKey: string, ownerId: string): boolean {
    db.prepare('DELETE FROM destination_leases WHERE destination_key = ? AND owner_id = ?').run(
      destinationKey,
      ownerId,
    );
    return changesCount() === 1;
  },

  releaseOwner(ownerId: string): number {
    db.prepare('DELETE FROM destination_leases WHERE owner_id = ?').run(ownerId);
    return changesCount();
  },

  get(destinationKey: string): DestinationLease | null {
    const row = db.prepare('SELECT * FROM destination_leases WHERE destination_key = ?').get(destinationKey) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToDestinationLease(row) : null;
  },

  listHeldByOthers(ownerId: string, now = Date.now()): string[] {
    return (
      db
        .prepare('SELECT destination_key FROM destination_leases WHERE owner_id != ? AND expires_at > ?')
        .all(ownerId, now) as Array<{ destination_key: string }>
    ).map((row) => row.destination_key);
  },

  purgeExpired(now = Date.now()): number {
    db.prepare('DELETE FROM destination_leases WHERE expires_at <= ?').run(now);
    return changesCount();
  },
};

// ============================================================================
// Durable Backfill Jobs
// ============================================================================

export interface BackfillJob {
  id: string;
  destinationId: string;
  sourceUsernames?: string[];
  limit: number;
  status: 'pending' | 'processing' | 'failed';
  attempts: number;
  notBefore: number;
  lastError?: string;
  lastErrorCategory?: string;
  queuedAt: number;
  sequence: number;
  claimToken?: string;
  updatedAt: number;
}

const rowToBackfillJob = (row: Record<string, unknown>): BackfillJob => ({
  id: String(row.id),
  destinationId: String(row.destination_id),
  sourceUsernames: row.source_usernames_json ? (JSON.parse(String(row.source_usernames_json)) as string[]) : undefined,
  limit: Number(row.limit_count) || 15,
  status: String(row.status) as BackfillJob['status'],
  attempts: Number(row.attempts) || 0,
  notBefore: Number(row.not_before) || 0,
  lastError: optionalText(row.last_error),
  lastErrorCategory: optionalText(row.last_error_category),
  queuedAt: Number(row.queued_at),
  sequence: Number(row.sequence),
  claimToken: optionalText(row.claim_token),
  updatedAt: Number(row.updated_at),
});

/**
 * Backfill requests used to live only in the web process's memory, so a restart
 * or a single transient X/Bluesky error silently dropped them. They are now
 * durable rows with attempt tracking, and callers distinguish retryable
 * failures (which reschedule) from terminal ones.
 */
export const backfillJobService = {
  upsert(input: {
    id: string;
    destinationId: string;
    sourceUsernames?: readonly string[];
    limit?: number;
    queuedAt?: number;
  }): BackfillJob {
    const now = input.queuedAt ?? Date.now();
    const sequenceRow = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM backfill_jobs').get() as
      | { value?: number }
      | undefined;
    db.prepare(`
      INSERT INTO backfill_jobs (
        id, destination_id, source_usernames_json, limit_count, status, attempts,
        not_before, queued_at, sequence, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        destination_id = excluded.destination_id,
        source_usernames_json = excluded.source_usernames_json,
        limit_count = excluded.limit_count,
        status = CASE WHEN backfill_jobs.status = 'processing' THEN backfill_jobs.status ELSE 'pending' END,
        not_before = 0,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.destinationId,
      input.sourceUsernames && input.sourceUsernames.length > 0 ? JSON.stringify([...input.sourceUsernames]) : null,
      Math.max(1, Math.min(input.limit ?? 15, 500)),
      now,
      (Number(sequenceRow?.value) || 0) + 1,
      now,
    );
    const job = this.get(input.id);
    if (!job) {
      throw new Error(`Backfill job not found after upsert: ${input.id}`);
    }
    return job;
  },

  get(id: string): BackfillJob | null {
    const row = db.prepare('SELECT * FROM backfill_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToBackfillJob(row) : null;
  },

  list(options: { destinationId?: string; status?: BackfillJob['status']; limit?: number } = {}): BackfillJob[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.destinationId) {
      clauses.push('destination_id = ?');
      params.push(options.destinationId);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 200, 1000)));
    return (
      db
        .prepare(
          `SELECT * FROM backfill_jobs WHERE ${clauses.length ? clauses.join(' AND ') : '1 = 1'}
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[]
    ).map(rowToBackfillJob);
  },

  /** Takes exclusive ownership of one due job. */
  claim(id: string, now = Date.now()): BackfillJob | null {
    db.prepare(
      `UPDATE backfill_jobs SET status = 'processing', claim_token = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'pending' AND not_before <= ?`,
    ).run(randomUUID(), now, id, now);
    return changesCount() === 1 ? this.get(id) : null;
  },

  /** Lists due jobs in submission order, oldest first. */
  listDue(now = Date.now(), limit = 200): BackfillJob[] {
    return (
      db
        .prepare(
          `SELECT * FROM backfill_jobs WHERE status = 'pending' AND not_before <= ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(now, Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[]
    ).map(rowToBackfillJob);
  },

  complete(id: string, claimToken: string): boolean {
    db.prepare('DELETE FROM backfill_jobs WHERE id = ? AND claim_token = ?').run(id, claimToken);
    return changesCount() === 1;
  },

  /**
   * Reschedules a claimed job. `retryable` is false only for terminal problems;
   * an authentication blip or a transient X error keeps the job alive so the
   * request is not silently lost.
   */
  reschedule(input: {
    id: string;
    claimToken: string;
    error: unknown;
    category?: string;
    retryable?: boolean;
    maxAttempts?: number;
    now?: number;
  }): BackfillJob | null {
    const now = input.now ?? Date.now();
    const job = this.get(input.id);
    if (!job || job.status !== 'processing' || job.claimToken !== input.claimToken) return null;
    const maxAttempts = input.maxAttempts ?? 8;
    const terminal = input.retryable === false || job.attempts >= maxAttempts;
    const backoff = Math.min(60_000 * 2 ** Math.max(0, job.attempts - 1), 6 * 60 * 60_000);
    db.prepare(`
      UPDATE backfill_jobs SET status = ?, not_before = ?, last_error = ?, last_error_category = ?,
        claim_token = NULL, updated_at = ?
      WHERE id = ? AND claim_token = ?
    `).run(
      terminal ? 'failed' : 'pending',
      terminal ? 0 : now + backoff,
      sanitizedErrorMessage(input.error),
      input.category ?? null,
      now,
      input.id,
      input.claimToken,
    );
    return this.get(input.id);
  },

  retry(id: string, now = Date.now()): boolean {
    db.prepare(
      `UPDATE backfill_jobs SET status = 'pending', attempts = 0, not_before = 0, last_error = NULL,
         last_error_category = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'`,
    ).run(now, id);
    return changesCount() === 1;
  },

  cancel(options: { id?: string; destinationId?: string } = {}): number {
    if (options.id) {
      db.prepare("DELETE FROM backfill_jobs WHERE id = ? AND status != 'processing'").run(options.id);
    } else if (options.destinationId) {
      db.prepare("DELETE FROM backfill_jobs WHERE destination_id = ? AND status != 'processing'").run(
        options.destinationId,
      );
    } else {
      db.prepare("DELETE FROM backfill_jobs WHERE status != 'processing'").run();
    }
    return changesCount();
  },

  /** Crash recovery: anything left mid-flight becomes due again. */
  resetProcessing(now = Date.now()): number {
    db.prepare(
      `UPDATE backfill_jobs SET status = 'pending', claim_token = NULL, not_before = 0, updated_at = ?
       WHERE status = 'processing'`,
    ).run(now);
    return changesCount();
  },
};

export const aiProviderUsageService = {
  record(input: {
    purpose: string;
    provider: string;
    model?: string;
    status: 'request' | 'success' | 'failure';
    latencyMs: number;
    errorCategory?: string;
    requestedAt?: number;
  }): void {
    db.prepare(`
      INSERT INTO ai_provider_usage (
        purpose, provider, model, status, latency_ms, error_category, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.purpose,
      input.provider,
      input.model ?? null,
      input.status,
      Math.max(0, Math.round(input.latencyMs)),
      input.errorCategory?.slice(0, 80) ?? null,
      input.requestedAt ?? Date.now(),
    );
  },
};

export const policyOverrideAuditService = {
  record(input: {
    destinationId: string;
    routeId?: string;
    externalPostId: string;
    actorId: string;
    action: 'override-requeue' | 'current-policy-requeue';
    priorReason?: string;
    decisionVersion: number;
    decisionTrace: string;
    policyHash?: string;
    occurredAt?: number;
  }): void {
    db.prepare(`
      INSERT INTO policy_override_audit (
        destination_id, route_id, external_post_id, actor_id, action, prior_reason,
        decision_version, decision_trace, policy_hash, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.destinationId,
      input.routeId ?? null,
      input.externalPostId,
      input.actorId,
      input.action,
      input.priorReason?.slice(0, 120) ?? null,
      input.decisionVersion,
      input.decisionTrace.slice(0, 16_384),
      input.policyHash ?? null,
      input.occurredAt ?? Date.now(),
    );
  },
};

export interface DeliveryCheckpoint {
  destinationId: string;
  externalPostId: string;
  chunkIndex: number;
  chunkCount: number;
  contentHash: string;
  createdAt: string;
  uri?: string;
  cid?: string;
  root?: { uri: string; cid: string };
  parent?: { uri: string; cid: string };
  tail?: { uri: string; cid: string };
  completedAt?: number;
}

const rowToDeliveryCheckpoint = (row: Record<string, unknown>): DeliveryCheckpoint => ({
  destinationId: String(row.destination_id),
  externalPostId: String(row.external_post_id),
  chunkIndex: Number(row.chunk_index),
  chunkCount: Number(row.chunk_count),
  contentHash: String(row.content_hash),
  createdAt: String(row.created_at),
  uri: optionalText(row.uri),
  cid: optionalText(row.cid),
  root: row.root_uri && row.root_cid ? { uri: String(row.root_uri), cid: String(row.root_cid) } : undefined,
  parent: row.parent_uri && row.parent_cid ? { uri: String(row.parent_uri), cid: String(row.parent_cid) } : undefined,
  tail: row.tail_uri && row.tail_cid ? { uri: String(row.tail_uri), cid: String(row.tail_cid) } : undefined,
  completedAt: optionalNumber(row.completed_at),
});

export const deliveryCheckpointService = {
  initialize(
    destinationId: string,
    externalPostId: string,
    chunks: Array<{ contentHash: string; createdAt: string }>,
  ): DeliveryCheckpoint[] {
    db.transaction(() => {
      const existing = this.list(destinationId, externalPostId);
      if (
        existing.some(
          (entry) => entry.chunkCount !== chunks.length || chunks[entry.chunkIndex]?.contentHash !== entry.contentHash,
        )
      ) {
        if (existing.some((entry) => entry.completedAt !== undefined)) {
          throw new Error('Saved delivery checkpoint does not match the current thread content.');
        }
        db.prepare('DELETE FROM delivery_checkpoints WHERE destination_id = ? AND external_post_id = ?').run(
          destinationId,
          externalPostId,
        );
      }
      const insert = db.prepare(`
        INSERT OR IGNORE INTO delivery_checkpoints (
          destination_id, external_post_id, chunk_index, chunk_count, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        insert.run(destinationId, externalPostId, chunkIndex, chunks.length, chunk.contentHash, chunk.createdAt);
      }
    })();
    return this.list(destinationId, externalPostId);
  },

  list(destinationId: string, externalPostId: string): DeliveryCheckpoint[] {
    return (
      db
        .prepare(
          `SELECT * FROM delivery_checkpoints
           WHERE destination_id = ? AND external_post_id = ?
           ORDER BY chunk_index ASC`,
        )
        .all(destinationId, externalPostId) as Record<string, unknown>[]
    ).map(rowToDeliveryCheckpoint);
  },

  firstMissing(destinationId: string, externalPostId: string): number {
    const checkpoints = this.list(destinationId, externalPostId);
    const missing = checkpoints.find((entry) => !entry.uri || !entry.cid || !entry.completedAt);
    return missing?.chunkIndex ?? checkpoints.length;
  },

  recordSuccess(input: {
    destinationId: string;
    externalPostId: string;
    chunkIndex: number;
    uri: string;
    cid: string;
    root: { uri: string; cid: string };
    parent?: { uri: string; cid: string };
    tail: { uri: string; cid: string };
    completedAt?: number;
  }): void {
    if (input.chunkIndex > 0) {
      const previous = this.list(input.destinationId, input.externalPostId)[input.chunkIndex - 1];
      if (!previous?.completedAt) throw new Error('Delivery checkpoints must be completed in order.');
    }
    db.prepare(`
      UPDATE delivery_checkpoints SET
        uri = ?, cid = ?, root_uri = ?, root_cid = ?, parent_uri = ?, parent_cid = ?,
        tail_uri = ?, tail_cid = ?, completed_at = ?
      WHERE destination_id = ? AND external_post_id = ? AND chunk_index = ?
    `).run(
      input.uri,
      input.cid,
      input.root.uri,
      input.root.cid,
      input.parent?.uri ?? null,
      input.parent?.cid ?? null,
      input.tail.uri,
      input.tail.cid,
      input.completedAt ?? Date.now(),
      input.destinationId,
      input.externalPostId,
      input.chunkIndex,
    );
    if (changesCount() !== 1) throw new Error('Delivery checkpoint plan is missing.');
  },

  finalize(tweet: ProcessedTweet, checkpointExternalPostId = tweet.external_post_id ?? tweet.twitter_id): void {
    db.transaction(() => {
      const checkpoints = this.list(tweet.destination_id ?? tweet.bsky_identifier, checkpointExternalPostId);
      if (checkpoints.length === 0 || checkpoints.some((entry) => !entry.completedAt)) {
        throw new Error('Cannot finalize delivery with incomplete thread checkpoints.');
      }
      dbService.saveTweet(tweet);
      postQueueService.markDone(tweet.twitter_id, tweet.bsky_identifier);
    })();
  },
};

export interface AuthRuntimeDiagnostic {
  provider: string;
  configured: boolean;
  activeSlot?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorCategory?: string;
}

export interface BlueskyAccountRuntimeState {
  accountId: string;
  lastValidatedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  consecutiveFailures: number;
}

export const blueskyAccountRuntimeService = {
  get(accountId: string): BlueskyAccountRuntimeState | null {
    const row = db.prepare('SELECT * FROM bluesky_account_runtime_state WHERE account_id = ?').get(accountId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          accountId: String(row.account_id),
          lastValidatedAt: optionalNumber(row.last_validated_at),
          lastSuccessAt: optionalNumber(row.last_success_at),
          lastFailureAt: optionalNumber(row.last_failure_at),
          lastErrorCategory: optionalText(row.last_error_category),
          lastErrorMessage: optionalText(row.last_error_message),
          consecutiveFailures: Number(row.consecutive_failures) || 0,
        }
      : null;
  },

  list(): BlueskyAccountRuntimeState[] {
    const rows = db.prepare('SELECT account_id FROM bluesky_account_runtime_state ORDER BY account_id').all() as Array<{
      account_id: string;
    }>;
    return rows
      .map((row) => this.get(row.account_id))
      .filter((state): state is BlueskyAccountRuntimeState => state !== null);
  },

  recordSuccess(accountId: string, _kind: 'validate' | 'login' = 'validate'): BlueskyAccountRuntimeState {
    const now = Date.now();
    const state: BlueskyAccountRuntimeState = {
      accountId,
      lastValidatedAt: now,
      lastSuccessAt: now,
      lastFailureAt: this.get(accountId)?.lastFailureAt,
      consecutiveFailures: 0,
    };
    db.prepare(`
      INSERT INTO bluesky_account_runtime_state (
        account_id, last_validated_at, last_success_at, last_failure_at,
        last_error_category, last_error_message, consecutive_failures
      ) VALUES (?, ?, ?, ?, NULL, NULL, 0)
      ON CONFLICT(account_id) DO UPDATE SET
        last_validated_at = excluded.last_validated_at,
        last_success_at = excluded.last_success_at,
        last_error_category = NULL,
        last_error_message = NULL,
        consecutive_failures = 0
    `).run(accountId, now, now, state.lastFailureAt ?? null);
    return state;
  },

  recordFailure(accountId: string, category: string, message: string): BlueskyAccountRuntimeState {
    const previous = this.get(accountId);
    const now = Date.now();
    const state: BlueskyAccountRuntimeState = {
      accountId,
      lastValidatedAt: now,
      lastSuccessAt: previous?.lastSuccessAt,
      lastFailureAt: now,
      lastErrorCategory: category,
      lastErrorMessage: sanitizedErrorMessage(message).slice(0, 500),
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    };
    db.prepare(`
      INSERT INTO bluesky_account_runtime_state (
        account_id, last_validated_at, last_success_at, last_failure_at,
        last_error_category, last_error_message, consecutive_failures
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        last_validated_at = excluded.last_validated_at,
        last_failure_at = excluded.last_failure_at,
        last_error_category = excluded.last_error_category,
        last_error_message = excluded.last_error_message,
        consecutive_failures = excluded.consecutive_failures
    `).run(
      accountId,
      now,
      state.lastSuccessAt ?? null,
      now,
      state.lastErrorCategory ?? null,
      state.lastErrorMessage ?? null,
      state.consecutiveFailures,
    );
    return state;
  },
};

export const authRuntimeStateService = {
  get(provider: string): AuthRuntimeDiagnostic | null {
    const row = db.prepare('SELECT * FROM auth_runtime_state WHERE provider = ?').get(provider) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          provider: String(row.provider),
          configured: Boolean(row.configured),
          activeSlot: optionalText(row.active_slot),
          lastSuccessAt: optionalNumber(row.last_success_at),
          lastFailureAt: optionalNumber(row.last_failure_at),
          lastErrorCategory: optionalText(row.last_error_category),
        }
      : null;
  },

  save(state: AuthRuntimeDiagnostic): void {
    db.prepare(`
      INSERT INTO auth_runtime_state (
        provider, configured, active_slot, last_success_at, last_failure_at, last_error_category
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        configured = excluded.configured,
        active_slot = excluded.active_slot,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        last_error_category = excluded.last_error_category
    `).run(
      state.provider,
      state.configured ? 1 : 0,
      state.activeSlot ?? null,
      state.lastSuccessAt ?? null,
      state.lastFailureAt ?? null,
      state.lastErrorCategory ?? null,
    );
  },
};

export const webhookDeliveryService = {
  save(result: {
    id: string;
    event: string;
    status: string;
    attempts: number;
    statusCode?: number;
    lastError?: string;
    deliveredAt?: number;
  }): void {
    db.prepare(`
      INSERT OR REPLACE INTO webhook_deliveries (
        id, event, status, attempts, status_code, last_error, delivered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      result.event,
      result.status,
      result.attempts,
      result.statusCode ?? null,
      result.lastError ? sanitizedErrorMessage(result.lastError) : null,
      result.deliveredAt ?? null,
      Date.now(),
    );
  },

  list(limit = 50): Array<Record<string, unknown>> {
    return db
      .prepare(
        `SELECT id, event, status, attempts, status_code, last_error, delivered_at, updated_at
         FROM webhook_deliveries ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
  },
};

export interface IngestionCredential {
  id: string;
  name: string;
  sourceId: string;
  scopes: IngestionScope[];
  createdBy: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  hmacEnabled: boolean;
}

function rowToIngestionCredential(row: Record<string, unknown>): IngestionCredential {
  let scopes: IngestionScope[] = [];
  try {
    scopes = JSON.parse(String(row.scopes_json)) as IngestionScope[];
  } catch {
    scopes = [];
  }
  return {
    id: String(row.id),
    name: String(row.name),
    sourceId: String(row.source_id),
    scopes,
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    lastUsedAt: optionalNumber(row.last_used_at),
    expiresAt: optionalNumber(row.expires_at),
    revokedAt: optionalNumber(row.revoked_at),
    hmacEnabled: typeof row.hmac_secret_encrypted === 'string',
  };
}

export const ingestionCredentialService = {
  create(input: {
    name: string;
    sourceId: string;
    scopes: IngestionScope[];
    createdBy: string;
    expiresAt?: number;
    includeHmac?: boolean;
  }): { credential: IngestionCredential; token: string; hmacSecret?: string } {
    const id = randomUUID();
    const secrets = createIngestionSecrets(input.includeHmac);
    let encryptedHmac: string | null = null;
    if (secrets.hmacSecret) {
      const key = parseEncryptionKey();
      if (!key) {
        throw new Error('CONFIG_ENCRYPTION_KEY is required before creating HMAC ingestion credentials.');
      }
      encryptedHmac = JSON.stringify(encryptValue(secrets.hmacSecret, `ingestion-credential:${id}`, key));
    }
    const now = Date.now();
    db.prepare(`
      INSERT INTO ingestion_credentials (
        id, name, source_id, token_hash, hmac_secret_encrypted, scopes_json,
        created_by, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name.trim().slice(0, 120),
      input.sourceId,
      secrets.tokenHash,
      encryptedHmac,
      JSON.stringify([...new Set(input.scopes)]),
      input.createdBy,
      now,
      input.expiresAt ?? null,
    );
    return {
      credential: {
        id,
        name: input.name.trim().slice(0, 120),
        sourceId: input.sourceId,
        scopes: [...new Set(input.scopes)],
        createdBy: input.createdBy,
        createdAt: now,
        expiresAt: input.expiresAt,
        hmacEnabled: Boolean(encryptedHmac),
      },
      token: secrets.token,
      hmacSecret: secrets.hmacSecret,
    };
  },

  list(): IngestionCredential[] {
    return (
      db.prepare('SELECT * FROM ingestion_credentials ORDER BY created_at DESC').all() as Record<string, unknown>[]
    ).map(rowToIngestionCredential);
  },

  authenticate(token: string, now = Date.now()): IngestionCredential | null {
    const row = db
      .prepare(
        `SELECT * FROM ingestion_credentials
         WHERE token_hash = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(hashIngestionToken(token), now) as Record<string, unknown> | undefined;
    if (!row) return null;
    db.prepare('UPDATE ingestion_credentials SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return rowToIngestionCredential({ ...row, last_used_at: now });
  },

  getHmacSecret(id: string): string | undefined {
    const row = db
      .prepare('SELECT hmac_secret_encrypted FROM ingestion_credentials WHERE id = ? AND revoked_at IS NULL')
      .get(id) as { hmac_secret_encrypted?: string } | undefined;
    if (!row?.hmac_secret_encrypted) return undefined;
    const parsed = JSON.parse(row.hmac_secret_encrypted) as unknown;
    const key = parseEncryptionKey();
    if (!key || !isEncryptedValue(parsed)) throw new Error('Stored HMAC credential cannot be decrypted.');
    return decryptValue(parsed, `ingestion-credential:${id}`, key);
  },

  revoke(id: string, now = Date.now()): boolean {
    db.prepare('UPDATE ingestion_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    return changesCount() === 1;
  },

  rotate(id: string, actorId: string): { credential: IngestionCredential; token: string; hmacSecret?: string } {
    const current = this.list().find((credential) => credential.id === id && !credential.revokedAt);
    if (!current) throw new Error('Ingestion credential not found.');
    return db.transaction(() => {
      this.revoke(id);
      return this.create({
        name: current.name,
        sourceId: current.sourceId,
        scopes: current.scopes,
        createdBy: actorId,
        expiresAt: current.expiresAt,
        includeHmac: current.hmacEnabled,
      });
    })();
  },
};

export const ingestionReplayService = {
  consumeNonce(credentialId: string, nonce: string, expiresAt: number, now = Date.now()): boolean {
    let inserted = false;
    db.transaction(() => {
      db.prepare('DELETE FROM ingestion_nonces WHERE expires_at <= ?').run(now);
      db.prepare('INSERT OR IGNORE INTO ingestion_nonces (credential_id, nonce, expires_at) VALUES (?, ?, ?)').run(
        credentialId,
        nonce,
        expiresAt,
      );
      inserted = changesCount() === 1;
    })();
    return inserted;
  },

  claimIdempotency(input: {
    sourceId: string;
    idempotencyKey: string;
    externalPostId: string;
    now?: number;
  }): { accepted: boolean; response?: unknown; conflict?: boolean } {
    db.prepare(`
      INSERT OR IGNORE INTO ingestion_idempotency (
        source_id, idempotency_key, external_post_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(input.sourceId, input.idempotencyKey, input.externalPostId, input.now ?? Date.now());
    if (changesCount() === 1) return { accepted: true };
    const byKey = db
      .prepare(
        'SELECT external_post_id, response_json FROM ingestion_idempotency WHERE source_id = ? AND idempotency_key = ?',
      )
      .get(input.sourceId, input.idempotencyKey) as { external_post_id: string; response_json?: string } | undefined;
    if (!byKey || byKey.external_post_id !== input.externalPostId) return { accepted: false, conflict: true };
    let response: unknown;
    try {
      response = byKey.response_json ? JSON.parse(byKey.response_json) : undefined;
    } catch {
      response = undefined;
    }
    return { accepted: false, response };
  },

  saveResponse(sourceId: string, idempotencyKey: string, response: unknown): void {
    db.prepare('UPDATE ingestion_idempotency SET response_json = ? WHERE source_id = ? AND idempotency_key = ?').run(
      JSON.stringify(response),
      sourceId,
      idempotencyKey,
    );
  },

  releasePending(sourceId: string, idempotencyKey: string, externalPostId: string): boolean {
    db.prepare(
      `DELETE FROM ingestion_idempotency
       WHERE source_id = ? AND idempotency_key = ? AND external_post_id = ? AND response_json IS NULL`,
    ).run(sourceId, idempotencyKey, externalPostId);
    return changesCount() === 1;
  },
};

export const ingestionAuditService = {
  record(input: {
    credentialId?: string;
    sourceId?: string;
    externalPostId?: string;
    idempotencyKeyHash?: string;
    outcome: string;
    statusCode: number;
    routeTrace?: unknown;
    remoteAddressHash?: string;
    occurredAt?: number;
  }): void {
    db.prepare(`
      INSERT INTO ingestion_audit (
        credential_id, source_id, external_post_id, idempotency_key_hash,
        outcome, status_code, route_trace_json, remote_address_hash, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.credentialId ?? null,
      input.sourceId ?? null,
      input.externalPostId?.slice(0, 512) ?? null,
      input.idempotencyKeyHash ?? null,
      input.outcome.slice(0, 80),
      input.statusCode,
      input.routeTrace ? JSON.stringify(sanitizeForDiagnostics(input.routeTrace)).slice(0, 32_768) : null,
      input.remoteAddressHash ?? null,
      input.occurredAt ?? Date.now(),
    );
  },

  list(limit = 100): Record<string, unknown>[] {
    return db
      .prepare(
        `SELECT id, credential_id, source_id, external_post_id, idempotency_key_hash,
                outcome, status_code, route_trace_json, remote_address_hash, occurred_at
         FROM ingestion_audit ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[];
  },
};

export interface DigestEntry {
  id: number;
  destinationId: string;
  routeId: string;
  sourceId: string;
  sourceType: string;
  externalPostId: string;
  post: NormalizedPost;
  deliveryDiagnostics: DeliveryFallbackEvent[];
  policySnapshot?: string;
  status: 'pending' | 'claimed' | 'delivered' | 'cancelled';
  jobId?: string;
  createdAt: number;
  deliveredAt?: number;
}

const rowToDigestEntry = (row: Record<string, unknown>): DigestEntry => {
  const post = JSON.parse(String(row.normalized_post_json)) as NormalizedPost;
  return {
    id: Number(row.id),
    destinationId: String(row.destination_id),
    routeId: String(row.route_id),
    sourceId: String(row.source_id),
    sourceType: String(row.source_type),
    externalPostId: String(row.external_post_id),
    post,
    deliveryDiagnostics:
      post.repostContentSource === 'wrapper'
        ? [
            {
              kind: 'repost-wrapper-fallback',
              reason:
                'The scraper did not provide nested repost content; wrapper text and the X status link were retained.',
            },
          ]
        : [],
    policySnapshot: optionalText(row.policy_snapshot),
    status: String(row.status) as DigestEntry['status'],
    jobId: optionalText(row.job_id),
    createdAt: Number(row.created_at),
    deliveredAt: optionalNumber(row.delivered_at),
  };
};

export const digestEntryService = {
  enqueue(input: {
    destinationId: string;
    routeId: string;
    post: NormalizedPost;
    policySnapshot?: string;
    createdAt?: number;
  }): boolean {
    db.prepare(`
      INSERT OR IGNORE INTO digest_entries (
        destination_id, route_id, source_id, source_type, external_post_id,
        normalized_post_json, policy_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.destinationId,
      input.routeId,
      input.post.sourceId,
      input.post.sourceType,
      input.post.externalId,
      JSON.stringify(input.post),
      input.policySnapshot ?? null,
      input.createdAt ?? Date.now(),
    );
    return changesCount() === 1;
  },

  list(
    options: {
      destinationId?: string;
      routeId?: string;
      status?: DigestEntry['status'];
      jobId?: string;
      limit?: number;
    } = {},
  ): DigestEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.destinationId) {
      clauses.push('destination_id = ?');
      params.push(options.destinationId);
    }
    if (options.routeId) {
      clauses.push('route_id = ?');
      params.push(options.routeId);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.jobId) {
      clauses.push('job_id = ?');
      params.push(options.jobId);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 200, 1000)));
    return (
      db
        .prepare(
          `SELECT * FROM digest_entries
           WHERE ${clauses.length ? clauses.join(' AND ') : '1 = 1'}
           ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[]
    ).map(rowToDigestEntry);
  },

  cancelPending(routeId: string): number {
    db.prepare("UPDATE digest_entries SET status = 'cancelled' WHERE route_id = ? AND status = 'pending'").run(routeId);
    return changesCount();
  },
};

export interface DigestJob {
  id: string;
  destinationId: string;
  routeId: string;
  status: 'scheduled' | 'processing' | 'failed';
  nextRunAt: number;
  claimedAt?: number;
  claimToken?: string;
  attempts: number;
  notBefore: number;
  lastError?: string;
  contentHash?: string;
  checkpoint: number;
  entryIds: number[];
}

const rowToDigestJob = (row: Record<string, unknown>): DigestJob => ({
  id: String(row.id),
  destinationId: String(row.destination_id),
  routeId: String(row.route_id),
  status: String(row.status) as DigestJob['status'],
  nextRunAt: Number(row.next_run_at),
  claimedAt: optionalNumber(row.claimed_at),
  claimToken: optionalText(row.claim_token),
  attempts: Number(row.attempts) || 0,
  notBefore: Number(row.not_before) || 0,
  lastError: optionalText(row.last_error),
  contentHash: optionalText(row.content_hash),
  checkpoint: Number(row.checkpoint) || 0,
  entryIds: row.entry_ids_json ? (JSON.parse(String(row.entry_ids_json)) as number[]) : [],
});

export const digestJobService = {
  arm(destinationId: string, routeId: string, nextRunAt: number): DigestJob {
    const now = Date.now();
    const id = `digest:${destinationId}:${routeId}`;
    db.prepare(`
      INSERT INTO digest_jobs (
        id, destination_id, route_id, status, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'scheduled', ?, ?, ?)
      ON CONFLICT(destination_id, route_id) DO UPDATE SET
        next_run_at = excluded.next_run_at,
        status = CASE WHEN digest_jobs.status = 'processing' THEN digest_jobs.status ELSE 'scheduled' END,
        updated_at = excluded.updated_at
    `).run(id, destinationId, routeId, nextRunAt, now, now);
    const job = this.get(id);
    if (!job) {
      throw new Error(`Digest job not found after arm: ${id}`);
    }
    return job;
  },

  get(id: string): DigestJob | null {
    const row = db.prepare('SELECT * FROM digest_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToDigestJob(row) : null;
  },

  list(limit = 200): DigestJob[] {
    return (
      db
        .prepare('SELECT * FROM digest_jobs ORDER BY next_run_at ASC LIMIT ?')
        .all(Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[]
    ).map(rowToDigestJob);
  },

  /**
   * `resolveMaxEntries` lets the caller cap the claim at the route's configured
   * digest size. Claiming more entries than a run can render used to lose the
   * remainder, because completion marked every claimed entry delivered.
   */
  claimNext(
    excludedDestinationIds: ReadonlySet<string>,
    now = Date.now(),
    maxEntries = 200,
    resolveMaxEntries?: (job: DigestJob) => number,
    // Runs inside the claim transaction so acquiring the cross-process
    // destination lease and claiming the job either both happen or neither
    // does (mirrors postQueueService.claimNextBatch's acquireLease).
    acquireLease?: (destinationId: string) => boolean,
  ): DigestJob | null {
    const rows = db
      .prepare(
        `SELECT * FROM digest_jobs
         WHERE status = 'scheduled' AND next_run_at <= ? AND not_before <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now, now) as Record<string, unknown>[];
    const candidate = rows.map(rowToDigestJob).find((job) => !excludedDestinationIds.has(job.destinationId));
    if (!candidate) return null;
    const requested = resolveMaxEntries?.(candidate) ?? maxEntries;
    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : maxEntries, maxEntries));
    const token = randomUUID();
    let claimed: DigestJob | null = null;
    db.transaction(() => {
      if (acquireLease && !acquireLease(candidate.destinationId)) return;
      db.prepare(`
        UPDATE digest_jobs SET status = 'processing', claimed_at = ?, claim_token = ?, updated_at = ?
        WHERE id = ? AND status = 'scheduled' AND next_run_at <= ? AND not_before <= ?
      `).run(now, token, now, candidate.id, now, now);
      if (changesCount() !== 1) return;
      const entries = db
        .prepare(
          `SELECT id FROM digest_entries
           WHERE destination_id = ? AND route_id = ? AND status = 'pending'
           ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(candidate.destinationId, candidate.routeId, limit) as Array<{ id: number }>;
      const entryIds = entries.map((entry) => Number(entry.id));
      if (entryIds.length > 0) {
        const marks = entryIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE digest_entries SET status = 'claimed', job_id = ? WHERE id IN (${marks}) AND status = 'pending'`,
        ).run(candidate.id, ...entryIds);
      }
      db.prepare('UPDATE digest_jobs SET entry_ids_json = ?, checkpoint = 0 WHERE id = ?').run(
        JSON.stringify(entryIds),
        candidate.id,
      );
      claimed = this.get(candidate.id);
    })();
    return claimed;
  },

  checkpoint(id: string, claimToken: string, checkpoint: number, contentHash: string): boolean {
    db.prepare(`
      UPDATE digest_jobs SET checkpoint = ?, content_hash = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND claim_token = ?
    `).run(checkpoint, contentHash, Date.now(), id, claimToken);
    return changesCount() === 1;
  },

  releaseEntries(id: string, claimToken: string, entryIds: readonly number[]): boolean {
    const job = this.get(id);
    if (!job || job.status !== 'processing' || job.claimToken !== claimToken) return false;
    if (entryIds.length > 0) {
      const marks = entryIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE digest_entries SET status = 'pending', job_id = NULL
         WHERE job_id = ? AND status = 'claimed' AND id IN (${marks})`,
      ).run(id, ...entryIds);
    }
    const retained = job.entryIds.filter((entryId) => !entryIds.includes(entryId));
    db.prepare('UPDATE digest_jobs SET entry_ids_json = ?, updated_at = ? WHERE id = ? AND claim_token = ?').run(
      JSON.stringify(retained),
      Date.now(),
      id,
      claimToken,
    );
    return changesCount() === 1;
  },

  /**
   * `deliveredEntryIds` names the entries the run actually rendered. Anything
   * else still claimed by the job goes back to pending instead of being marked
   * delivered, so an entry can never be dropped without appearing in a digest.
   */
  complete(
    id: string,
    claimToken: string,
    nextRunAt: number,
    deliveredAt = Date.now(),
    deliveredEntryIds?: readonly number[],
  ): boolean {
    let completed = false;
    db.transaction(() => {
      const job = this.get(id);
      if (!job || job.status !== 'processing' || job.claimToken !== claimToken) return;
      if (deliveredEntryIds) {
        if (deliveredEntryIds.length > 0) {
          const marks = deliveredEntryIds.map(() => '?').join(',');
          db.prepare(
            `UPDATE digest_entries SET status = 'delivered', delivered_at = ?
             WHERE job_id = ? AND status = 'claimed' AND id IN (${marks})`,
          ).run(deliveredAt, id, ...deliveredEntryIds);
        }
        db.prepare(
          "UPDATE digest_entries SET status = 'pending', job_id = NULL WHERE job_id = ? AND status = 'claimed'",
        ).run(id);
      } else {
        db.prepare(
          "UPDATE digest_entries SET status = 'delivered', delivered_at = ? WHERE job_id = ? AND status = 'claimed'",
        ).run(deliveredAt, id);
      }
      db.prepare(`
        UPDATE digest_jobs SET status = 'scheduled', next_run_at = ?, claimed_at = NULL,
          claim_token = NULL, attempts = 0, not_before = 0, last_error = NULL,
          checkpoint = 0, entry_ids_json = NULL, content_hash = NULL, updated_at = ?
        WHERE id = ? AND claim_token = ?
      `).run(nextRunAt, deliveredAt, id, claimToken);
      completed = changesCount() === 1;
    })();
    return completed;
  },

  fail(id: string, claimToken: string, error: unknown, maxAttempts = 5, now = Date.now()): boolean {
    const job = this.get(id);
    if (!job || job.status !== 'processing' || job.claimToken !== claimToken) return false;
    const attempts = job.attempts + 1;
    const terminal = attempts >= maxAttempts;
    const backoff = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
    let changed = false;
    db.transaction(() => {
      db.prepare(
        "UPDATE digest_entries SET status = 'pending', job_id = NULL WHERE job_id = ? AND status = 'claimed'",
      ).run(id);
      db.prepare(`
        UPDATE digest_jobs SET status = ?, attempts = ?, not_before = ?, last_error = ?,
          claimed_at = NULL, claim_token = NULL, updated_at = ?
        WHERE id = ? AND claim_token = ?
      `).run(
        terminal ? 'failed' : 'scheduled',
        attempts,
        terminal ? 0 : now + backoff,
        sanitizedErrorMessage(error),
        now,
        id,
        claimToken,
      );
      changed = changesCount() === 1;
    })();
    return changed;
  },

  retry(id: string): boolean {
    db.prepare(
      "UPDATE digest_jobs SET status = 'scheduled', not_before = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
    ).run(Date.now(), id);
    return changesCount() === 1;
  },

  cancel(id: string): boolean {
    let cancelled = false;
    db.transaction(() => {
      db.prepare(
        "UPDATE digest_entries SET status = 'pending', job_id = NULL WHERE job_id = ? AND status = 'claimed'",
      ).run(id);
      db.prepare("DELETE FROM digest_jobs WHERE id = ? AND status != 'processing'").run(id);
      cancelled = changesCount() === 1;
    })();
    return cancelled;
  },

  resetProcessing(now = Date.now()): number {
    db.transaction(() => {
      db.prepare("UPDATE digest_entries SET status = 'pending', job_id = NULL WHERE status = 'claimed'").run();
      db.prepare(
        "UPDATE digest_jobs SET status = 'scheduled', claimed_at = NULL, claim_token = NULL, updated_at = ? WHERE status = 'processing'",
      ).run(now);
    })();
    return changesCount();
  },
};
