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
}, { owner: 'live', version: 13, statements: [
  'ALTER TABLE vault_writes ADD COLUMN external_context_present INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE vault_writes ADD COLUMN candidate_digest TEXT',
] }, { owner: 'live', version: 14, statements: [
  'ALTER TABLE vault_writes ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0',
] }, { owner: 'live', version: 16, statements: [
  `CREATE TABLE vault_writes_v16 (
    op_id TEXT PRIMARY KEY, live_session_id TEXT NOT NULL, utterance_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create_insight','update_insight','create_insight_link','record_search_feedback')),
    content TEXT NOT NULL, content_key TEXT NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('authorized','dispatched','confirmed','failed','uncertain')),
    insight_id TEXT, code TEXT, latency_ms INTEGER, created_at INTEGER NOT NULL, settled_at INTEGER,
    external_context_present INTEGER NOT NULL DEFAULT 0, candidate_digest TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (live_session_id, utterance_id)
  )`,
  `INSERT INTO vault_writes_v16 SELECT op_id,live_session_id,utterance_id,'create_insight',content,content_key,title,state,insight_id,code,latency_ms,created_at,settled_at,external_context_present,candidate_digest,retry_count FROM vault_writes`,
  'DROP TABLE vault_writes',
  'ALTER TABLE vault_writes_v16 RENAME TO vault_writes',
  'CREATE INDEX vault_writes_current ON vault_writes(live_session_id, created_at)',
] }];
