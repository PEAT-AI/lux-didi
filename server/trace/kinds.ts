// Closed codes for the trace store. Every string that reaches a metadata table is one
// of these, an id, or a count: no free text ever has a column to land in.

export const EVENT_SOURCES = ['host', 'native', 'provider'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const TURN_ORIGINS = ['owner', 'assistant', 'recovery'] as const;
export type TurnOrigin = (typeof TURN_ORIGINS)[number];

export const TURN_CLOSE_REASONS = ['completed', 'interrupted', 'superseded', 'recovered', 'session_end'] as const;
export type TurnCloseReason = (typeof TURN_CLOSE_REASONS)[number];

export const TURN_OUTCOMES = ['answered', 'silent', 'no_response', 'failed'] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const STALL_REASONS = [
  'no_delegation', 'no_response', 'no_audible_output', 'no_playback_drain', 'no_continuation_decision', 'native_sequence_gap',
] as const;
export type StallReason = (typeof STALL_REASONS)[number];

export const RESPONSE_STATUSES = ['pending', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted', 'superseded'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const RESPONSE_TERMINAL_REASONS = [
  'completed', 'failed', 'cancelled', 'interrupted', 'superseded', 'provider_error', 'timeout',
] as const;
export type ResponseTerminalReason = (typeof RESPONSE_TERMINAL_REASONS)[number];

export const CALL_OUTCOMES = ['completed', 'failed', 'refused', 'cancelled', 'aborted', 'timeout', 'unknown'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const PLAYBACK_TERMINATION_REASONS = ['drained', 'flushed', 'interrupted', 'failed', 'session_end'] as const;
export type PlaybackTerminationReason = (typeof PLAYBACK_TERMINATION_REASONS)[number];

export const UTTERANCE_ROLES = ['owner', 'model'] as const;
export type UtteranceRole = (typeof UTTERANCE_ROLES)[number];

/** S4a: why a progress commentary line was sent, as a closed set (never free text). */
export const PROGRESS_REASONS = ['dead_air', 'stalled', 'lookup'] as const;
export type ProgressReason = (typeof PROGRESS_REASONS)[number];

/** S4a-R4: the command families a rejected provider command can name. */
export const COMMAND_KINDS = ['tool_out', 'cont', 'cmt', 'thk', 'other'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** O1b-A (D12-1): what happened to the continuation the answered calls owed. `sent` is a
 *  `response.create` on the wire, `deferred` an answer held while the gate waits, `failed` nothing written. */
export const CONTINUATION_OUTCOMES = ['sent', 'deferred', 'failed'] as const;
export type ContinuationOutcome = (typeof CONTINUATION_OUTCOMES)[number];

/** O1b-A (D12-2): why the continuation owner skipped a `response.create`, as a closed set. */
export const SKIP_REASONS = ['awaiting_calls', 'draining', 'epoch_stale'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// The immutable causal spine. A kind names one state transition; its fields are fixed below.
export const EVENT_KINDS = [
  'turn.opened', 'turn.closed', 'turn.summary',
  'delegation.created',
  'response.created', 'response.observed', 'response.terminal',
  'call.intent', 'call.executed', 'call.completed', 'call.output_prepared', 'call.output_written',
  'continuation.decided',
  'playback.received', 'playback.audible', 'playback.enqueued', 'playback.started',
  'playback.drained', 'playback.interrupted', 'playback.terminated',
  'progress.commentary', 'progress.thinking', 'call.ceiling', 'command.rejected',
  'live.dead_air_stalled',
] as const;
export type TraceEventKind = (typeof EVENT_KINDS)[number];

export const TRACE_SCHEMA_VERSION = 3;
export const TRACE_RETENTION_DAYS = 30;
export const TRACE_DAY_MS = 86_400_000;

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
