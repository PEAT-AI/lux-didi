import type { SchemaMigration } from '../contracts/storage.js';

// Live-owned additive migrations on the SAME Store. No CHAT table is altered and no
// second SQLite connection or database is created.
export const liveMigrations: readonly SchemaMigration[] = [{
  owner: 'live',
  version: 1,
  statements: [
    `CREATE TABLE live_sessions (
       live_session_id TEXT PRIMARY KEY,
       owner_assistant_id TEXT NOT NULL,
       authority_epoch TEXT NOT NULL,
       idempotency_key TEXT NOT NULL,
       fingerprint TEXT NOT NULL,
       client_id TEXT NOT NULL,
       audit_id TEXT NOT NULL,
       profile_identity TEXT NOT NULL,
       prompt_identity TEXT NOT NULL,
       lifecycle TEXT NOT NULL CHECK (lifecycle IN ('accepted','opening','active','terminal')),
       dispatch_intent INTEGER NOT NULL CHECK (dispatch_intent IN (0,1)),
       ready INTEGER NOT NULL CHECK (ready IN (0,1)),
       journal_events INTEGER NOT NULL,
       journal_bytes INTEGER NOT NULL,
       journal_complete INTEGER NOT NULL CHECK (journal_complete IN (0,1)),
       consumer_state TEXT NOT NULL CHECK (consumer_state IN ('detached','attached','ended','backpressure')),
       terminal_outcome TEXT,
       terminal_at INTEGER,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       UNIQUE (owner_assistant_id, idempotency_key)
     )`,
    `CREATE TABLE live_grants (
       grant_id TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL REFERENCES live_sessions(live_session_id),
       provider TEXT NOT NULL,
       model TEXT NOT NULL,
       voice TEXT NOT NULL,
       key_reference TEXT NOT NULL,
       permitted_classes TEXT NOT NULL,
       chosen_input_class TEXT NOT NULL,
       revision INTEGER NOT NULL,
       granted_at INTEGER NOT NULL
     )`,
    `CREATE TABLE live_journal (
       journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
       live_session_id TEXT NOT NULL REFERENCES live_sessions(live_session_id),
       provider_sequence INTEGER,
       kind TEXT NOT NULL CHECK (kind IN ('inputTranscription','outputTranscription','ready','interrupted','generationComplete','turnComplete','waitingForInput','terminal')),
       text TEXT,
       finished INTEGER CHECK (finished IS NULL OR finished IN (0,1)),
       value INTEGER CHECK (value IS NULL OR value IN (0,1)),
       terminal_outcome TEXT,
       rejected_kind TEXT,
       rejected_sequence INTEGER,
       payload_bytes INTEGER NOT NULL,
       arrived_at INTEGER NOT NULL
     )`,
    `CREATE INDEX live_journal_order ON live_journal(live_session_id, journal_id)`,
  ],
}, { owner: 'live', version: 2, statements: [
  `ALTER TABLE live_sessions ADD COLUMN accepted_prompt_snapshot TEXT`
]}];
