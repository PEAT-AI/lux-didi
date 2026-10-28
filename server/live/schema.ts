import type { SchemaMigration } from '../contracts/storage.js';
import { vaultMigrations } from '../tools/vault-schema.js';
import { luxNoteMigrations } from '../tools/lux-note.js';

// Historical shipped export ledger: preserve owner, version and statement bytes. No runtime exporter remains.
export const notesExportMigrations: readonly SchemaMigration[] = [{
  owner: 'notes-export',
  version: 1,
  statements: [
    `CREATE TABLE note_exports (
       export_key TEXT PRIMARY KEY,
       entry_id TEXT NOT NULL,
       live_session_id TEXT NOT NULL,
       body_sha256 TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('dispatching','inserted','duplicate','failed','unknown')),
       attempted_at INTEGER NOT NULL,
       settled_at INTEGER,
       insight_id TEXT,
       code TEXT
     )`,
    `CREATE INDEX note_exports_attempted ON note_exports(attempted_at)`,
  ],
}];

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
]}, {
  owner: 'live', version: 3, statements: [
    `CREATE TABLE live_journal_extended (
       journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
       live_session_id TEXT NOT NULL REFERENCES live_sessions(live_session_id),
       provider_sequence INTEGER,
       kind TEXT NOT NULL CHECK (kind IN ('inputTranscription','outputTranscription','ready','interrupted','generationComplete','turnComplete','waitingForInput','terminal','toolCall','toolResult')),
       text TEXT,
       tool_json TEXT,
       finished INTEGER CHECK (finished IS NULL OR finished IN (0,1)),
       value INTEGER CHECK (value IS NULL OR value IN (0,1)),
       terminal_outcome TEXT,
       rejected_kind TEXT,
       rejected_sequence INTEGER,
       payload_bytes INTEGER NOT NULL,
       arrived_at INTEGER NOT NULL
     )`,
    `INSERT INTO live_journal_extended(journal_id,live_session_id,provider_sequence,kind,text,finished,value,terminal_outcome,rejected_kind,rejected_sequence,payload_bytes,arrived_at) SELECT journal_id,live_session_id,provider_sequence,kind,text,finished,value,terminal_outcome,rejected_kind,rejected_sequence,payload_bytes,arrived_at FROM live_journal`,
    `DROP TABLE live_journal`,
    `ALTER TABLE live_journal_extended RENAME TO live_journal`,
    `CREATE INDEX live_journal_session ON live_journal(live_session_id, journal_id)`,
    `CREATE TABLE live_tool_acceptances (live_session_id TEXT PRIMARY KEY REFERENCES live_sessions(live_session_id), acceptance_json TEXT NOT NULL, accepted_run_hash TEXT NOT NULL)`,
  ],
}, { owner: 'live', version: 4, statements: [
  `ALTER TABLE live_sessions ADD COLUMN memory_provenance TEXT`
]}, { owner: 'live', version: 5, statements: [
  `ALTER TABLE live_sessions ADD COLUMN resumption_handle TEXT`,
  `ALTER TABLE live_sessions ADD COLUMN connection_generation INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE live_journal_resumable (
       journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
       live_session_id TEXT NOT NULL REFERENCES live_sessions(live_session_id),
       provider_sequence INTEGER,
       kind TEXT NOT NULL CHECK (kind IN ('inputTranscription','outputTranscription','ready','interrupted','generationComplete','turnComplete','waitingForInput','terminal','toolCall','toolResult','continuity')),
       text TEXT,
       tool_json TEXT,
       finished INTEGER CHECK (finished IS NULL OR finished IN (0,1)),
       value INTEGER CHECK (value IS NULL OR value IN (0,1)),
       terminal_outcome TEXT,
       rejected_kind TEXT,
       rejected_sequence INTEGER,
       payload_bytes INTEGER NOT NULL,
       arrived_at INTEGER NOT NULL
     )`,
  `INSERT INTO live_journal_resumable SELECT * FROM live_journal`,
  `DROP TABLE live_journal`,
  `ALTER TABLE live_journal_resumable RENAME TO live_journal`,
  `CREATE INDEX live_journal_session ON live_journal(live_session_id, journal_id)`
]}, { owner: 'live', version: 6, statements: [
    `CREATE TABLE live_journal_remember (
       journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
       live_session_id TEXT NOT NULL REFERENCES live_sessions(live_session_id),
       provider_sequence INTEGER,
       kind TEXT NOT NULL CHECK (kind IN ('inputTranscription','outputTranscription','ready','interrupted','generationComplete','turnComplete','waitingForInput','terminal','toolCall','toolResult','continuity','remember_deferred')),
       text TEXT,
       tool_json TEXT,
       finished INTEGER CHECK (finished IS NULL OR finished IN (0,1)),
       value INTEGER CHECK (value IS NULL OR value IN (0,1)),
       terminal_outcome TEXT,
       rejected_kind TEXT,
       rejected_sequence INTEGER,
       payload_bytes INTEGER NOT NULL,
       arrived_at INTEGER NOT NULL
     )`,
  `INSERT INTO live_journal_remember SELECT * FROM live_journal`,
  `DROP TABLE live_journal`,
  `ALTER TABLE live_journal_remember RENAME TO live_journal`,
  `CREATE INDEX live_journal_session ON live_journal(live_session_id, journal_id)`
]}, { owner: 'live', version: 7, statements: [
    `CREATE TABLE live_journal_progress (
       journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
       live_session_id TEXT NOT NULL REFERENCES live_sessions(live_session_id),
       provider_sequence INTEGER,
       kind TEXT NOT NULL CHECK (kind IN ('inputTranscription','outputTranscription','ready','interrupted','generationComplete','turnComplete','waitingForInput','terminal','toolCall','toolResult','continuity','remember_deferred','researchProgress')),
       text TEXT,
       tool_json TEXT,
       finished INTEGER CHECK (finished IS NULL OR finished IN (0,1)),
       value INTEGER CHECK (value IS NULL OR value IN (0,1)),
       terminal_outcome TEXT,
       rejected_kind TEXT,
       rejected_sequence INTEGER,
       payload_bytes INTEGER NOT NULL,
       arrived_at INTEGER NOT NULL
     )`,
  `INSERT INTO live_journal_progress SELECT * FROM live_journal`,
  `DROP TABLE live_journal`,
  `ALTER TABLE live_journal_progress RENAME TO live_journal`,
  `CREATE INDEX live_journal_session ON live_journal(live_session_id, journal_id)`
]}, { owner: 'live', version: 8, statements: [
    `ALTER TABLE live_journal ADD COLUMN connection_epoch TEXT`,
    `ALTER TABLE live_journal ADD COLUMN provider_event_id TEXT`,
    `ALTER TABLE live_journal ADD COLUMN provider_start_ms REAL`,
    `ALTER TABLE live_journal ADD COLUMN provider_end_ms REAL`,
    `ALTER TABLE live_journal ADD COLUMN received_mono_ms INTEGER`,
    `ALTER TABLE live_journal ADD COLUMN clock_domain TEXT`,
    `ALTER TABLE live_journal ADD COLUMN final_origin TEXT`,
    `ALTER TABLE live_journal ADD COLUMN finalized_at INTEGER`,
    `ALTER TABLE live_journal ADD COLUMN finalized_mono_ms INTEGER`,
]}, { owner: 'live', version: 9, statements: [
    `ALTER TABLE live_sessions ADD COLUMN diagnostic_metadata_state TEXT`,
    `ALTER TABLE live_sessions ADD COLUMN diagnostic_content_state TEXT`,
    `ALTER TABLE live_sessions ADD COLUMN native_receipt_state TEXT`,
    `ALTER TABLE live_sessions ADD COLUMN diagnostic_failures INTEGER`,
    `ALTER TABLE live_sessions ADD COLUMN diagnostic_last_reason TEXT`,
    `ALTER TABLE live_sessions ADD COLUMN diagnostic_unattributed_transcripts INTEGER`,
    `ALTER TABLE live_sessions ADD COLUMN diagnostic_clock_domain TEXT`,
]}, { owner: 'live', version: 10, statements: [
    // The boot retention prune walks the sessions that ended before the cutoff and then the journal
    // rows that still carry content (H16): without these two indexes that is a full scan of both
    // tables inside the start-up transaction, and both grow with every session the owner speaks.
    `CREATE INDEX live_sessions_terminal_at ON live_sessions(terminal_at) WHERE terminal_at IS NOT NULL`,
    `CREATE INDEX live_journal_content ON live_journal(live_session_id) WHERE text IS NOT NULL OR tool_json IS NOT NULL`,
]}, { owner: 'live', version: 11, statements: [
    // The conversation outlives every provider connection: mute, expiry, restart and midnight keep it.
    // A separate table, so no existing session row is rewritten and every pre-existing value stays byte-identical.
    `CREATE TABLE live_conversations (owner_assistant_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, started_at TEXT NOT NULL)`,
    `CREATE TABLE live_session_conversations (live_session_id TEXT PRIMARY KEY REFERENCES live_sessions(live_session_id), conversation_id TEXT NOT NULL)`,
]}, ...vaultMigrations, ...luxNoteMigrations, ...notesExportMigrations];
