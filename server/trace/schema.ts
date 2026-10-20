import type { SchemaMigration } from '../contracts/storage.js';

// Trace-owned additive migrations on the SAME Store connection as everything else: one
// state.sqlite, never a second database. Five metadata tables carry ids, closed codes,
// counts and durations only; the two content tables are the only place owner text lives.
export const traceMigrations: readonly SchemaMigration[] = [{
  owner: 'trace',
  version: 1,
  statements: [
    `CREATE TABLE trace_turn (
       turn_id TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL,
       turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
       origin TEXT NOT NULL CHECK (origin IN ('owner','assistant','recovery')),
       supersedes_turn_id TEXT,
       opened_at INTEGER NOT NULL,
       mono_ms INTEGER NOT NULL,
       closed_at INTEGER,
       close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('completed','interrupted','superseded','recovered','session_end')),
       first_audible_at INTEGER,
       playback_drained_at INTEGER,
       outcome TEXT CHECK (outcome IS NULL OR outcome IN ('answered','silent','no_response','failed')),
       stall_reason TEXT CHECK (stall_reason IS NULL OR stall_reason IN ('no_delegation','no_response','no_audible_output','no_playback_drain','no_continuation_decision','native_sequence_gap')),
       attribution_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (attribution_uncertain IN (0,1))
     )`,
    `CREATE UNIQUE INDEX trace_turn_order ON trace_turn(live_session_id, turn_index)`,

    `CREATE TABLE trace_response (
       response_key TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL,
       connection_epoch TEXT NOT NULL,
       provider_response_id TEXT,
       delegation_id TEXT,
       turn_id TEXT,
       status TEXT NOT NULL CHECK (status IN ('pending','streaming','completed','failed','cancelled','interrupted','superseded')),
       created_at INTEGER NOT NULL,
       terminal_at INTEGER,
       terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('completed','failed','cancelled','interrupted','superseded','provider_error','timeout')),
       continuation_of_response_key TEXT
     )`,
    `CREATE UNIQUE INDEX trace_response_provider ON trace_response(live_session_id, connection_epoch, provider_response_id) WHERE provider_response_id IS NOT NULL`,
    `CREATE UNIQUE INDEX trace_response_delegation ON trace_response(live_session_id, connection_epoch, delegation_id) WHERE delegation_id IS NOT NULL`,
    `CREATE INDEX trace_response_turn ON trace_response(live_session_id, turn_id)`,

    `CREATE TABLE trace_call (
       call_key TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL,
       connection_epoch TEXT NOT NULL,
       provider_call_id TEXT,
       response_key TEXT,
       turn_id TEXT,
       name TEXT NOT NULL,
       args_chars INTEGER NOT NULL CHECK (args_chars >= 0),
       intent_at INTEGER NOT NULL,
       executed_at INTEGER,
       output_prepared_at INTEGER,
       output_written_at INTEGER,
       outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed','refused','cancelled','aborted','timeout','unknown')),
       ms INTEGER,
       result_chars INTEGER CHECK (result_chars IS NULL OR result_chars >= 0)
     )`,
    `CREATE UNIQUE INDEX trace_call_provider ON trace_call(live_session_id, connection_epoch, provider_call_id) WHERE provider_call_id IS NOT NULL`,
    `CREATE INDEX trace_call_response ON trace_call(live_session_id, response_key)`,

    `CREATE TABLE trace_playback (
       playback_key TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL,
       source_instance_id TEXT NOT NULL,
       segment_seq INTEGER NOT NULL CHECK (segment_seq >= 0),
       response_key TEXT,
       turn_id TEXT,
       received_at INTEGER NOT NULL,
       audible_at INTEGER,
       enqueued_at INTEGER,
       started_at INTEGER,
       drained_at INTEGER,
       interrupted_at INTEGER,
       termination_reason TEXT CHECK (termination_reason IS NULL OR termination_reason IN ('drained','flushed','interrupted','failed','session_end'))
     )`,
    `CREATE INDEX trace_playback_turn ON trace_playback(live_session_id, turn_id)`,

    `CREATE TABLE trace_event (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       live_session_id TEXT NOT NULL,
       turn_id TEXT,
       response_key TEXT,
       call_key TEXT,
       playback_key TEXT,
       action_id TEXT,
       caused_by_event_id INTEGER,
       kind TEXT NOT NULL,
       source TEXT NOT NULL CHECK (source IN ('host','native','provider')),
       source_instance_id TEXT,
       source_seq INTEGER,
       at INTEGER NOT NULL,
       mono_ms INTEGER NOT NULL,
       received_at INTEGER NOT NULL,
       connection_epoch TEXT,
       schema_version INTEGER NOT NULL,
       detail TEXT NOT NULL
     )`,
    `CREATE UNIQUE INDEX trace_event_native ON trace_event(source_instance_id, source_seq)`,
    `CREATE INDEX trace_event_session ON trace_event(live_session_id, seq)`,
    `CREATE INDEX trace_event_turn ON trace_event(live_session_id, turn_id, seq)`,

    `CREATE TABLE trace_utterance (
       turn_id TEXT NOT NULL REFERENCES trace_turn(turn_id) ON DELETE CASCADE,
       role TEXT NOT NULL CHECK (role IN ('owner','model')),
       at INTEGER NOT NULL,
       final INTEGER NOT NULL CHECK (final IN (0,1)),
       text TEXT NOT NULL
     )`,
    `CREATE INDEX trace_utterance_turn ON trace_utterance(turn_id, at)`,

    `CREATE TABLE trace_call_result (
       call_key TEXT PRIMARY KEY REFERENCES trace_call(call_key) ON DELETE CASCADE,
       text TEXT NOT NULL,
       text_truncated INTEGER NOT NULL CHECK (text_truncated IN (0,1))
     )`,
  ],
}, {
  owner: 'trace',
  // Release 3x / call 1019: the native player restarts its source sequence with every session, so a
  // replay is the same sequence in the same session, never the same sequence on one instance for ever.
  // The old index read a later session's receipts as replays and dropped them, which the timeline
  // reported as a false NATIVE-GAP on the session that lost them.
  version: 2,
  statements: [
    `DROP INDEX IF EXISTS trace_event_native`,
    `CREATE UNIQUE INDEX trace_event_native ON trace_event(live_session_id, source_instance_id, source_seq)`,
  ],
}, {
  owner: 'trace', version: 3, statements: [
    `ALTER TABLE trace_event ADD COLUMN clock_domain TEXT`,
    `ALTER TABLE trace_turn ADD COLUMN clock_domain TEXT`,
    `ALTER TABLE trace_call ADD COLUMN execution_completed_at INTEGER`,
    `ALTER TABLE trace_call ADD COLUMN canonical_owner_id TEXT`,
    `ALTER TABLE trace_call ADD COLUMN canonical_run_id TEXT`,
    `ALTER TABLE trace_call ADD COLUMN canonical_execution_id TEXT`,
    `ALTER TABLE trace_call ADD COLUMN canonical_result_id TEXT`,
    `ALTER TABLE trace_call ADD COLUMN canonical_result_sha256 TEXT`,
    `ALTER TABLE trace_utterance ADD COLUMN journal_id INTEGER`,
  ],
}, {
  owner: 'trace', version: 4, statements: [
    // The boot retention prune deletes by age (H16): without these two indexes it full-scanned both
    // content tables inside the start-up transaction, and the scan grows with every turn ever recorded.
    `CREATE INDEX trace_utterance_at ON trace_utterance(at)`,
    `CREATE INDEX trace_call_intent_at ON trace_call(intent_at)`,
  ],
}];
