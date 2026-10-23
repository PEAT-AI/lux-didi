import type { SchemaMigration } from '../contracts/storage.js';

/** The voice-only vault write ledger: one row per owner authorization, keyed by the utterance it came from. */
export const vaultMigrations: readonly SchemaMigration[] = [{
  owner: 'live',
  version: 12,
  statements: [
    `CREATE TABLE vault_writes (
       op_id TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL,
       utterance_id TEXT NOT NULL,
       operation TEXT NOT NULL CHECK (operation IN ('save_insight')),
       content TEXT NOT NULL,
       content_key TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('authorized','dispatched','confirmed','failed','uncertain')),
       insight_id TEXT,
       code TEXT,
       latency_ms INTEGER,
       created_at INTEGER NOT NULL,
       settled_at INTEGER,
       UNIQUE (live_session_id, utterance_id)
     )`,
    `CREATE INDEX vault_writes_current ON vault_writes(live_session_id, created_at)`,
  ],
}];
