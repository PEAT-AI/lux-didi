/**
 * C-TOOLTRUTH / C-HOSTFACTS (10.8): the closed refusal facts per code, never a sentence for her to recite.
 * F7: a refusal that names no cause left her to invent one, so every code the host closes carries the cause
 * it actually holds, as typed fields. F6: no entry here reads as work in progress; what ran comes from the
 * host's own record through `runningState`, so a rebuilt session cannot be told anything is happening when
 * nothing is. A code the host cannot explain is reported as unknown and grants nothing: not success, not
 * failure, not a retry.
 */
import type { AdmissionBlockReason, ResearchRefusalReason } from './research.js';

/** What actually ran for the refused call, as the host holds it. */
export type RefusalExecution = 'nothing_ran' | 'nothing_new_ran' | 'unknown';

/** Why the call was refused, in the host's own closed categories. */
export type RefusalCauseKind = 'admission' | 'argument_shape' | 'conflict' | 'replay' | 'unknown';

/** The one action the host supports after this refusal; a refusal never authorizes a retry. */
export type RefusalNextAction =
  | 'nothing_until_owner_speaks'
  | 'read_delivered_result'
  | 'resend_corrected_arguments'
  | 'report_nothing_ran'
  | 'report_unknown_code';

/** The unmet prerequisite, as the host holds it. */
export type RefusalPrerequisite =
  | 'owner_turn'
  | 'new_owner_turn'
  | 'one_object_arguments'
  | 'known_fields_only'
  | 'action_start_continue_stop'
  | 'string_field'
  | 'non_empty_field'
  | 'field_within_host_limit'
  | 'topic_keeps_question_names'
  | 'research_id_from_this_session'
  | 'list_field'
  | 'cursor_from_this_session'
  | 'cursor_with_continue'
  | 'no_cursor_with_lookups'
  | 'no_cursor_with_page_cursor'
  | 'lookups_within_host_limit'
  | 'no_lookups_on_stop'
  | 'lookup_entry_object'
  | 'lookup_known_fields_only'
  | 'lookup_source_known'
  | 'lookup_query_text'
  | 'lookup_query_within_host_limit'
  | 'history_lookup_reads_memory_alone'
  | 'mail_lookup_reads_mail_alone'
  | 'call_id_recorded_for_one_tool'
  | 'recorded_result_in_this_session';

export interface RefusalCause {
  /** The closed code the host refused with. Metadata, never prose. */
  readonly code: string;
  /** What ran for this call. */
  readonly executed: RefusalExecution;
  /** The host's closed cause category. */
  readonly cause: RefusalCauseKind;
  /** The argument or record the cause is about, or nothing when it is the turn itself. */
  readonly field: string | null;
  /** What the call did not satisfy, or nothing when the host holds no prerequisite. */
  readonly prerequisite: RefusalPrerequisite | null;
  /** The one supported next step. */
  readonly nextAction: RefusalNextAction;
  /** A refusal never permits a retry of the same call. */
  readonly retryPermitted: false;
}

/**
 * The live layer's own replay refusals. The host holds the cause for both, so neither may fall to the unknown.
 * Every other code a tool refuses with that is not in this table or the research table is reported as unknown.
 */
export const HOST_REFUSAL_CODES = ['replay_identity_mismatch', 'recorded_result_unavailable'] as const;
export type HostRefusalCode = typeof HOST_REFUSAL_CODES[number];

const NOTHING_RAN: RefusalExecution = 'nothing_ran';

export const REFUSAL_CAUSES: Readonly<Record<AdmissionBlockReason | ResearchRefusalReason | HostRefusalCode, RefusalCause>> = Object.freeze({
  // The admission blocks (C-RESEARCH-CONTRACT T-03 codes, unchanged): one research operation per owner turn.
  no_owner_turn: {
    code: 'no_owner_turn', executed: NOTHING_RAN, cause: 'admission', field: null,
    prerequisite: 'owner_turn', nextAction: 'nothing_until_owner_speaks', retryPermitted: false,
  },
  turn_spent: {
    code: 'turn_spent', executed: 'nothing_new_ran', cause: 'admission', field: null,
    prerequisite: 'new_owner_turn', nextAction: 'nothing_until_owner_speaks', retryPermitted: false,
  },
  no_turn_since_result: {
    code: 'no_turn_since_result', executed: NOTHING_RAN, cause: 'admission', field: null,
    prerequisite: 'new_owner_turn', nextAction: 'read_delivered_result', retryPermitted: false,
  },
  answer_already_given: {
    code: 'answer_already_given', executed: NOTHING_RAN, cause: 'admission', field: null,
    prerequisite: 'new_owner_turn', nextAction: 'nothing_until_owner_speaks', retryPermitted: false,
  },
  // The argument-shape refusals: the call never reached a source, so the cause is the shape itself.
  root_type: {
    code: 'root_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'arguments',
    prerequisite: 'one_object_arguments', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  unknown_fields: {
    code: 'unknown_fields', executed: NOTHING_RAN, cause: 'argument_shape', field: 'arguments',
    prerequisite: 'known_fields_only', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  action_missing: {
    code: 'action_missing', executed: NOTHING_RAN, cause: 'argument_shape', field: 'action',
    prerequisite: 'action_start_continue_stop', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  action_invalid: {
    code: 'action_invalid', executed: NOTHING_RAN, cause: 'argument_shape', field: 'action',
    prerequisite: 'action_start_continue_stop', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  question_type: {
    code: 'question_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'question',
    prerequisite: 'string_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  question_required: {
    code: 'question_required', executed: NOTHING_RAN, cause: 'argument_shape', field: 'question',
    prerequisite: 'non_empty_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  question_length: {
    code: 'question_length', executed: NOTHING_RAN, cause: 'argument_shape', field: 'question',
    prerequisite: 'field_within_host_limit', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  topic_type: {
    code: 'topic_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'topic',
    prerequisite: 'string_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  topic_required: {
    code: 'topic_required', executed: NOTHING_RAN, cause: 'argument_shape', field: 'topic',
    prerequisite: 'non_empty_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  topic_length: {
    code: 'topic_length', executed: NOTHING_RAN, cause: 'argument_shape', field: 'topic',
    prerequisite: 'field_within_host_limit', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  entity_rewrite: {
    code: 'entity_rewrite', executed: NOTHING_RAN, cause: 'conflict', field: 'topic',
    prerequisite: 'topic_keeps_question_names', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  research_id_type: {
    code: 'research_id_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'researchId',
    prerequisite: 'string_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  research_id_required: {
    code: 'research_id_required', executed: NOTHING_RAN, cause: 'argument_shape', field: 'researchId',
    prerequisite: 'research_id_from_this_session', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  sources_type: {
    code: 'sources_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'sources',
    prerequisite: 'list_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  direction_type: {
    code: 'direction_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'direction',
    prerequisite: 'string_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  cursor_type: {
    code: 'cursor_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'cursor',
    prerequisite: 'cursor_from_this_session', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  cursor_action: {
    code: 'cursor_action', executed: NOTHING_RAN, cause: 'conflict', field: 'cursor',
    prerequisite: 'cursor_with_continue', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  cursor_lookups_conflict: {
    code: 'cursor_lookups_conflict', executed: NOTHING_RAN, cause: 'conflict', field: 'cursor',
    prerequisite: 'no_cursor_with_lookups', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  cursor_page_conflict: {
    code: 'cursor_page_conflict', executed: NOTHING_RAN, cause: 'conflict', field: 'cursor',
    prerequisite: 'no_cursor_with_page_cursor', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookups_type: {
    code: 'lookups_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'list_field', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookups_count: {
    code: 'lookups_count', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'lookups_within_host_limit', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookups_stop: {
    code: 'lookups_stop', executed: NOTHING_RAN, cause: 'conflict', field: 'lookups',
    prerequisite: 'no_lookups_on_stop', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_type: {
    code: 'lookup_type', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'lookup_entry_object', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_unknown_fields: {
    code: 'lookup_unknown_fields', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'lookup_known_fields_only', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_source: {
    code: 'lookup_source', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'lookup_source_known', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_query_required: {
    code: 'lookup_query_required', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'lookup_query_text', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_query_length: {
    code: 'lookup_query_length', executed: NOTHING_RAN, cause: 'argument_shape', field: 'lookups',
    prerequisite: 'lookup_query_within_host_limit', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_history: {
    code: 'lookup_history', executed: NOTHING_RAN, cause: 'conflict', field: 'lookups',
    prerequisite: 'history_lookup_reads_memory_alone', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  lookup_mail: {
    code: 'lookup_mail', executed: NOTHING_RAN, cause: 'conflict', field: 'lookups',
    prerequisite: 'mail_lookup_reads_mail_alone', nextAction: 'resend_corrected_arguments', retryPermitted: false,
  },
  no_owner_input: {
    code: 'no_owner_input', executed: NOTHING_RAN, cause: 'admission', field: null,
    prerequisite: 'owner_turn', nextAction: 'nothing_until_owner_speaks', retryPermitted: false,
  },
  // The host's own replay refusals, so a result replayed into a rebuilt session never hides its cause.
  replay_identity_mismatch: {
    code: 'replay_identity_mismatch', executed: NOTHING_RAN, cause: 'replay', field: 'callId',
    prerequisite: 'call_id_recorded_for_one_tool', nextAction: 'report_nothing_ran', retryPermitted: false,
  },
  recorded_result_unavailable: {
    code: 'recorded_result_unavailable', executed: NOTHING_RAN, cause: 'replay', field: 'callId',
    prerequisite: 'recorded_result_in_this_session', nextAction: 'report_nothing_ran', retryPermitted: false,
  },
});

/** The unknown-code fact: the host holds no cause, so it grants nothing, not even that nothing ran. */
export const UNKNOWN_REFUSAL: RefusalCause = Object.freeze({
  code: 'unnamed_code', executed: 'unknown', cause: 'unknown', field: null,
  prerequisite: null, nextAction: 'report_unknown_code', retryPermitted: false,
});

/** The closed facts for a known code, or the honest unknown for a code this host cannot explain. */
export function refusalCauseOf(code: string): RefusalCause {
  const known = (REFUSAL_CAUSES as Readonly<Record<string, RefusalCause | undefined>>)[code];
  if (known !== undefined) return known;
  // The code is metadata, never arbitrary prose: only a closed-shape token is repeated to the model.
  const named = /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : UNKNOWN_REFUSAL.code;
  return { ...UNKNOWN_REFUSAL, code: named };
}

/** What the host's own record says is running, so a refusal never implies work that does not exist. */
export interface RunningState {
  readonly anyRunning: boolean;
  readonly running: readonly string[];
}

export function runningState(running: readonly string[]): RunningState {
  return { anyRunning: running.length > 0, running };
}
