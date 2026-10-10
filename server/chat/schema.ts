import type { SchemaMigration } from '../contracts/storage.js';
export const chatMigrations: readonly SchemaMigration[] = [{ owner: 'chat', version: 1, statements: [
  `CREATE TABLE chat_runs (
    run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_entry_id TEXT NOT NULL,
    owner_assistant_id TEXT NOT NULL, accepting_client_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    authority_epoch TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    prompt_version TEXT NOT NULL, manifest_hash TEXT, trace TEXT,
    state TEXT NOT NULL CHECK(state IN ('accepted','dispatch_intent','terminal')),
    outcome TEXT, final_entry_id TEXT, retry_of TEXT REFERENCES chat_runs(run_id),
    sequence INTEGER NOT NULL DEFAULT 1, partial_text TEXT NOT NULL DEFAULT '',
    partial_truncated INTEGER NOT NULL DEFAULT 0,
    accepted_at TEXT NOT NULL, intent_at TEXT, terminal_at TEXT, terminal_epoch TEXT,
    UNIQUE(owner_assistant_id,idempotency_key),
    CHECK((state='terminal' AND outcome IS NOT NULL) OR (state!='terminal' AND outcome IS NULL)),
    CHECK((outcome='complete' AND final_entry_id IS NOT NULL) OR (outcome IS NULL OR outcome!='complete'))
  )`,
  `CREATE UNIQUE INDEX chat_one_active_session ON chat_runs(session_id) WHERE state!='terminal'`,
] }];
