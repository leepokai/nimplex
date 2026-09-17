import type { DatabaseSync } from "node:sqlite";

/** Dedicated tables for the opt-in composition qualification; no default-engine cutover. */
export function initializePiStorage(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pi_store_sessions (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, format TEXT NOT NULL,
      next_seq INTEGER NOT NULL, stats TEXT NOT NULL,
      PRIMARY KEY(tenant_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS pi_store_entries (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
      parent_id TEXT, seq INTEGER NOT NULL, timestamp INTEGER NOT NULL,
      type TEXT NOT NULL, custom_type TEXT, data TEXT NOT NULL,
      PRIMARY KEY(tenant_id, session_id, id), UNIQUE(tenant_id, session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS pi_store_commits (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, commit_id TEXT NOT NULL,
      first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
      digest TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant_id, session_id, commit_id),
      UNIQUE(tenant_id, session_id, first_seq)
    );
    CREATE INDEX IF NOT EXISTS pi_store_entry_type ON pi_store_entries(tenant_id, session_id, type, seq);
    CREATE TABLE IF NOT EXISTS pi_store_usage (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
      seq INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant_id, session_id, id), UNIQUE(tenant_id, session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS pi_store_values (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
      namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant_id, session_id, namespace, key)
    );
    CREATE TABLE IF NOT EXISTS pi_store_lists (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
      namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant_id, session_id, namespace, key, seq)
    );
  `);
}
