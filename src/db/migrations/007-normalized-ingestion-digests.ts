import type { DatabaseMigration } from './types.js';

export const normalizedIngestionDigestsMigration: DatabaseMigration = {
  version: 7,
  name: 'normalized-ingestion-digests',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        hmac_secret_encrypted TEXT,
        scopes_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ingestion_credentials_source
        ON ingestion_credentials(source_id, revoked_at);

      CREATE TABLE IF NOT EXISTS ingestion_nonces (
        credential_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (credential_id, nonce),
        FOREIGN KEY (credential_id) REFERENCES ingestion_credentials(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ingestion_nonces_expiry
        ON ingestion_nonces(expires_at);

      CREATE TABLE IF NOT EXISTS ingestion_idempotency (
        source_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        external_post_id TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, idempotency_key),
        UNIQUE (source_id, external_post_id)
      );

      CREATE TABLE IF NOT EXISTS ingestion_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id TEXT,
        source_id TEXT,
        external_post_id TEXT,
        idempotency_key_hash TEXT,
        outcome TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        route_trace_json TEXT,
        remote_address_hash TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ingestion_audit_time
        ON ingestion_audit(occurred_at DESC);

      CREATE TABLE IF NOT EXISTS digest_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        destination_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        external_post_id TEXT NOT NULL,
        normalized_post_json TEXT NOT NULL,
        policy_snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        job_id TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE (destination_id, route_id, source_type, source_id, external_post_id)
      );
      CREATE INDEX IF NOT EXISTS idx_digest_entries_pending
        ON digest_entries(destination_id, route_id, status, created_at);

      CREATE TABLE IF NOT EXISTS digest_jobs (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        next_run_at INTEGER NOT NULL,
        claimed_at INTEGER,
        claim_token TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        content_hash TEXT,
        checkpoint INTEGER NOT NULL DEFAULT 0,
        entry_ids_json TEXT,
        root_uri TEXT,
        root_cid TEXT,
        tail_uri TEXT,
        tail_cid TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (destination_id, route_id)
      );
      CREATE INDEX IF NOT EXISTS idx_digest_jobs_due
        ON digest_jobs(status, next_run_at, not_before);
    `);
  },
};
