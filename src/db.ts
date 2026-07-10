import { DB_PATH } from './storage-paths.js';

interface DbStatement {
  get: (...params: any[]) => unknown;
  all: (...params: any[]) => unknown[];
  run: (...params: any[]) => unknown;
}

interface DbLike {
  prepare: (sql: string) => DbStatement;
  exec: (sql: string) => unknown;
  transaction: <T extends (...args: any[]) => any>(fn: T) => T;
  pragma?: (sql: string) => unknown;
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

// --- Migration Support ---
const tableInfo = db.prepare('PRAGMA table_info(processed_tweets)').all() as any[];

if (tableInfo.length > 0) {
  const schemaChanged = false;
  const hasBskyIdentifier = tableInfo.some((col) => col.name === 'bsky_identifier');
  const hasTweetText = tableInfo.some((col) => col.name === 'tweet_text');
  const hasTailUri = tableInfo.some((col) => col.name === 'bsky_tail_uri');

  if (!hasBskyIdentifier || !hasTweetText || !hasTailUri) {
    console.log('🔄 Upgrading database schema...');

    // SQLite doesn't support easy PK changes, so we recreate the table if identifier is missing
    // Or if we just need to add a column, we can do ALTER TABLE if it's not the PK.
    // However, since we might need to do both or one, let's just do the full migration pattern
    // to be safe and consistent.

    db.transaction(() => {
      // 1. Rename existing table
      db.exec('ALTER TABLE processed_tweets RENAME TO processed_tweets_old;');

      // 2. Create new table with all columns
      db.exec(`
        CREATE TABLE processed_tweets (
          twitter_id TEXT NOT NULL,
          twitter_username TEXT NOT NULL,
          bsky_identifier TEXT NOT NULL,
          tweet_text TEXT,
          bsky_uri TEXT,
          bsky_cid TEXT,
          bsky_root_uri TEXT,
          bsky_root_cid TEXT,
          bsky_tail_uri TEXT,
          bsky_tail_cid TEXT,
          status TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (twitter_id, bsky_identifier)
        );
      `);

      // 3. Migrate data
      // Handle the case where the old table might not have had bsky_identifier
      const oldColumns = tableInfo.map((c) => c.name);

      // Construct the SELECT part based on available old columns
      // If old table didn't have bsky_identifier, we default to 'unknown'
      const identifierSelect = oldColumns.includes('bsky_identifier') ? 'bsky_identifier' : "'unknown'";

      // If old table didn't have tweet_text, we default to NULL
      const textSelect = oldColumns.includes('tweet_text') ? 'tweet_text' : 'NULL';

      const tailUriSelect = oldColumns.includes('bsky_tail_uri') ? 'bsky_tail_uri' : 'NULL';
      const tailCidSelect = oldColumns.includes('bsky_tail_cid') ? 'bsky_tail_cid' : 'NULL';

      db.exec(`
        INSERT INTO processed_tweets (
          twitter_id, 
          twitter_username, 
          bsky_identifier, 
          tweet_text,
          bsky_uri, 
          bsky_cid, 
          bsky_root_uri, 
          bsky_root_cid,
          bsky_tail_uri,
          bsky_tail_cid, 
          status, 
          created_at
        )
        SELECT 
          twitter_id, 
          twitter_username, 
          ${identifierSelect}, 
          ${textSelect},
          bsky_uri, 
          bsky_cid, 
          bsky_root_uri, 
          bsky_root_cid,
          ${tailUriSelect},
          ${tailCidSelect}, 
          status, 
          created_at
        FROM processed_tweets_old;
      `);

      // 4. Drop old table
      db.exec('DROP TABLE processed_tweets_old;');
    })();
    console.log('✅ Database upgraded successfully.');
  }
} else {
  // Initialize fresh schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_tweets (
      twitter_id TEXT NOT NULL,
      twitter_username TEXT NOT NULL,
      bsky_identifier TEXT NOT NULL,
      tweet_text TEXT,
      bsky_uri TEXT,
      bsky_cid TEXT,
      bsky_root_uri TEXT,
      bsky_root_cid TEXT,
      bsky_tail_uri TEXT,
      bsky_tail_cid TEXT,
      status TEXT NOT NULL, -- 'migrated', 'skipped', 'failed'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (twitter_id, bsky_identifier)
    );
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_twitter_username ON processed_tweets(twitter_username);
  CREATE INDEX IF NOT EXISTS idx_bsky_identifier ON processed_tweets(bsky_identifier);
`);

// --- Post queue ---
// Durable buffer between the Twitter fetch sweep and the Bluesky post workers.
// Rows are deleted once the tweet lands in processed_tweets (that table stays
// the permanent record); failed rows are kept visible until pruned or cleared.
// Created with IF NOT EXISTS so existing databases upgrade in place on boot.
db.exec(`
  CREATE TABLE IF NOT EXISTS post_queue (
    twitter_id TEXT NOT NULL,
    bsky_identifier TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    twitter_username TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'scheduled',
    request_id TEXT,
    tweet_json TEXT NOT NULL,
    tweet_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    enqueued_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (twitter_id, bsky_identifier)
  );
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_queue_claim ON post_queue(status, not_before, enqueued_at);
  CREATE INDEX IF NOT EXISTS idx_queue_target ON post_queue(bsky_identifier, status);
  CREATE INDEX IF NOT EXISTS idx_queue_mapping ON post_queue(mapping_id, status);
`);

export interface ProcessedTweet {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  tweet_text?: string;
  bsky_uri?: string;
  bsky_cid?: string;
  bsky_root_uri?: string;
  bsky_root_cid?: string;
  bsky_tail_uri?: string;
  bsky_tail_cid?: string;
  status: 'migrated' | 'skipped' | 'failed';
  created_at?: string;
}

export interface ProcessedTweetSearchResult extends ProcessedTweet {
  score: number;
}

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
    if (!tweet.created_at) return 0;
    const timestamp = Date.parse(tweet.created_at);
    if (!Number.isFinite(timestamp)) return 0;
    const ageDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
    return Math.max(0, 7 - ageDays);
  })();

  return blendedScore + recencyBoost;
}

export const dbService = {
  getTweet(twitterId: string, bskyIdentifier: string): ProcessedTweet | null {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE twitter_id = ? AND bsky_identifier = ?');
    const row = stmt.get(twitterId, bskyIdentifier) as any;
    if (!row) return null;
    return {
      twitter_id: row.twitter_id,
      twitter_username: row.twitter_username,
      bsky_identifier: row.bsky_identifier,
      tweet_text: row.tweet_text,
      bsky_uri: row.bsky_uri,
      bsky_cid: row.bsky_cid,
      bsky_root_uri: row.bsky_root_uri,
      bsky_root_cid: row.bsky_root_cid,
      bsky_tail_uri: row.bsky_tail_uri,
      bsky_tail_cid: row.bsky_tail_cid,
      status: row.status,
      created_at: row.created_at,
    };
  },

  saveTweet(tweet: ProcessedTweet) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO processed_tweets 
      (twitter_id, twitter_username, bsky_identifier, tweet_text, bsky_uri, bsky_cid, bsky_root_uri, bsky_root_cid, bsky_tail_uri, bsky_tail_cid, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      tweet.twitter_id,
      tweet.twitter_username,
      tweet.bsky_identifier,
      tweet.tweet_text || null,
      tweet.bsky_uri || null,
      tweet.bsky_cid || null,
      tweet.bsky_root_uri || null,
      tweet.bsky_root_cid || null,
      tweet.bsky_tail_uri || null,
      tweet.bsky_tail_cid || null,
      tweet.status,
    );
  },

  getTweetsByBskyIdentifier(bskyIdentifier: string): Record<string, any> {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE bsky_identifier = ?');
    const rows = stmt.all(bskyIdentifier.toLowerCase()) as any[];
    const map: Record<string, any> = {};
    for (const row of rows) {
      map[row.twitter_id] = {
        uri: row.bsky_uri,
        cid: row.bsky_cid,
        root: row.bsky_root_uri ? { uri: row.bsky_root_uri, cid: row.bsky_root_cid } : undefined,
        tail: row.bsky_tail_uri && row.bsky_tail_cid ? { uri: row.bsky_tail_uri, cid: row.bsky_tail_cid } : undefined,
        migrated: row.status === 'migrated',
        skipped: row.status === 'skipped',
      };
    }
    return map;
  },

  getTweetsByUsername(username: string): Record<string, any> {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE twitter_username = ?');
    const rows = stmt.all(username.toLowerCase()) as any[];
    const map: Record<string, any> = {};
    for (const row of rows) {
      map[row.twitter_id] = {
        uri: row.bsky_uri,
        cid: row.bsky_cid,
        root: row.bsky_root_uri ? { uri: row.bsky_root_uri, cid: row.bsky_root_cid } : undefined,
        tail: row.bsky_tail_uri && row.bsky_tail_cid ? { uri: row.bsky_tail_uri, cid: row.bsky_tail_cid } : undefined,
        migrated: row.status === 'migrated',
        skipped: row.status === 'skipped',
      };
    }
    return map;
  },

  getRecentProcessedTweets(limit = 50): ProcessedTweet[] {
    const stmt = db.prepare('SELECT * FROM processed_tweets ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?');
    return stmt.all(limit) as ProcessedTweet[];
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
    const rows = stmt.all(safeScanLimit) as ProcessedTweet[];

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
        const aTime = a.created_at ? Date.parse(a.created_at) : 0;
        const bTime = b.created_at ? Date.parse(b.created_at) : 0;
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      })
      .slice(0, safeLimit);
  },

  deleteTweetsByUsername(username: string) {
    const stmt = db.prepare('DELETE FROM processed_tweets WHERE twitter_username = ?');
    stmt.run(username.toLowerCase());
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

  clearAll() {
    db.prepare('DELETE FROM processed_tweets').run();
  },
};

// ============================================================================
// Post Queue Service
// ============================================================================

export type QueueItemKind = 'scheduled' | 'backfill';
export type QueueItemStatus = 'pending' | 'processing' | 'failed';

export interface QueueItem {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  kind: QueueItemKind;
  request_id?: string;
  tweet_json: string;
  tweet_text?: string;
  status: QueueItemStatus;
  attempts: number;
  not_before: number;
  last_error?: string;
  enqueued_at: number;
  updated_at: number;
}

export interface QueueEnqueueInput {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  kind: QueueItemKind;
  request_id?: string;
  tweet_json: string;
  tweet_text?: string;
}

export interface QueueBatch {
  mapping_id: string;
  bsky_identifier: string;
  twitter_username: string;
  items: QueueItem[];
}

export interface QueueMappingCounts {
  mapping_id: string;
  bsky_identifier: string;
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

const rowToQueueItem = (row: any): QueueItem => ({
  twitter_id: row.twitter_id,
  bsky_identifier: row.bsky_identifier,
  mapping_id: row.mapping_id,
  twitter_username: row.twitter_username,
  kind: row.kind,
  request_id: row.request_id ?? undefined,
  tweet_json: row.tweet_json,
  tweet_text: row.tweet_text ?? undefined,
  status: row.status,
  attempts: row.attempts,
  not_before: row.not_before,
  last_error: row.last_error ?? undefined,
  enqueued_at: row.enqueued_at,
  updated_at: row.updated_at,
});

export const postQueueService = {
  // INSERT OR IGNORE dedupes against everything already queued (any status)
  // for the same Bluesky target; callers additionally pre-filter against
  // processed_tweets. Returns how many rows were actually inserted.
  enqueue(items: QueueEnqueueInput[]): number {
    if (items.length === 0) return 0;
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO post_queue
        (twitter_id, bsky_identifier, mapping_id, twitter_username, kind, request_id, tweet_json, tweet_text, status, attempts, not_before, enqueued_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
    `);
    let inserted = 0;
    const runAll = db.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.twitter_id,
          item.bsky_identifier.toLowerCase(),
          item.mapping_id,
          item.twitter_username.toLowerCase(),
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

  // Every queued twitter_id for a Bluesky target regardless of status, so the
  // sweep treats queued-but-not-yet-posted tweets as already seen.
  getQueuedIdSet(bskyIdentifier: string): Set<string> {
    const rows = db
      .prepare('SELECT twitter_id FROM post_queue WHERE bsky_identifier = ?')
      .all(bskyIdentifier.toLowerCase()) as { twitter_id: string }[];
    return new Set(rows.map((row) => row.twitter_id));
  },

  // Claims the oldest eligible (mapping, source account) group and marks its
  // pending rows as processing. Groups whose mapping is locked by another
  // worker (excluded) or no longer enabled (not in allowed) are passed over.
  claimNextBatch(excludedMappingIds: Set<string>, allowedMappingIds: Set<string>, maxItems = 50): QueueBatch | null {
    const now = Date.now();
    const groups = db
      .prepare(`
        SELECT mapping_id, twitter_username, bsky_identifier, MIN(enqueued_at) AS oldest
        FROM post_queue
        WHERE status = 'pending' AND not_before <= ?
        GROUP BY mapping_id, twitter_username, bsky_identifier
        ORDER BY oldest ASC
      `)
      .all(now) as { mapping_id: string; twitter_username: string; bsky_identifier: string }[];

    const group = groups.find((g) => !excludedMappingIds.has(g.mapping_id) && allowedMappingIds.has(g.mapping_id));
    if (!group) return null;

    let items: QueueItem[] = [];
    const claim = db.transaction(() => {
      const rows = db
        .prepare(`
          SELECT * FROM post_queue
          WHERE status = 'pending' AND not_before <= ?
            AND mapping_id = ? AND twitter_username = ? AND bsky_identifier = ?
          ORDER BY ${TWEET_ID_ORDER}
          LIMIT ?
        `)
        .all(now, group.mapping_id, group.twitter_username, group.bsky_identifier, maxItems) as any[];
      items = rows.map(rowToQueueItem);
      const mark = db.prepare(
        "UPDATE post_queue SET status = 'processing', updated_at = ? WHERE twitter_id = ? AND bsky_identifier = ?",
      );
      for (const item of items) {
        mark.run(now, item.twitter_id, item.bsky_identifier);
      }
    });
    claim();

    if (items.length === 0) return null;
    return {
      mapping_id: group.mapping_id,
      bsky_identifier: group.bsky_identifier,
      twitter_username: group.twitter_username,
      items,
    };
  },

  markDone(twitterId: string, bskyIdentifier: string): void {
    db.prepare('DELETE FROM post_queue WHERE twitter_id = ? AND bsky_identifier = ?').run(
      twitterId,
      bskyIdentifier.toLowerCase(),
    );
  },

  // Failed attempt: exponential backoff (5 min doubling, capped at 6h), then
  // terminal 'failed' after maxAttempts so a poison tweet can't retry forever.
  releaseForRetry(item: QueueItem, errorMessage: string, maxAttempts: number): void {
    const attempts = item.attempts + 1;
    const now = Date.now();
    if (attempts >= maxAttempts) {
      db.prepare(
        "UPDATE post_queue SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE twitter_id = ? AND bsky_identifier = ?",
      ).run(attempts, errorMessage.slice(0, 500), now, item.twitter_id, item.bsky_identifier);
      return;
    }
    const backoffMs = Math.min(5 * 60 * 1000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);
    db.prepare(
      "UPDATE post_queue SET status = 'pending', attempts = ?, not_before = ?, last_error = ?, updated_at = ? WHERE twitter_id = ? AND bsky_identifier = ?",
    ).run(attempts, now + backoffMs, errorMessage.slice(0, 500), now, item.twitter_id, item.bsky_identifier);
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
        SELECT mapping_id, bsky_identifier,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          MIN(CASE WHEN status IN ('pending', 'processing') THEN enqueued_at ELSE NULL END) AS oldest_enqueued_at
        FROM post_queue
        GROUP BY mapping_id, bsky_identifier
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
        SELECT twitter_id, bsky_identifier, mapping_id, twitter_username, kind, request_id, tweet_text,
               status, attempts, not_before, last_error, enqueued_at, updated_at
        FROM post_queue
        ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, enqueued_at ASC, ${TWEET_ID_ORDER}
        LIMIT ?
      `)
      .all(limit * 4) as any[];
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
    db.prepare('DELETE FROM post_queue WHERE mapping_id = ?').run(mappingId);
    return changesCount();
  },

  deleteByBskyIdentifier(bskyIdentifier: string): number {
    db.prepare('DELETE FROM post_queue WHERE bsky_identifier = ?').run(bskyIdentifier.toLowerCase());
    return changesCount();
  },

  clearFailed(): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'failed'").run();
    return changesCount();
  },

  retryFailed(): number {
    db.prepare(
      "UPDATE post_queue SET status = 'pending', attempts = 0, not_before = 0, updated_at = ? WHERE status = 'failed'",
    ).run(Date.now());
    return changesCount();
  },

  purgeFailedOlderThan(maxAgeMs: number): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'failed' AND updated_at < ?").run(Date.now() - maxAgeMs);
    return changesCount();
  },
};
