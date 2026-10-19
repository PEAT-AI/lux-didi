import { performance } from 'node:perf_hooks';
import type { SQLValue, Transaction } from '../contracts/storage.js';
import {
  CALL_OUTCOMES, COMMAND_KINDS, CONTINUATION_OUTCOMES, EVENT_KINDS, EVENT_SOURCES, PLAYBACK_TERMINATION_REASONS, PROGRESS_REASONS,
  RESPONSE_STATUSES,
  RESPONSE_TERMINAL_REASONS, SKIP_REASONS, STALL_REASONS, TRACE_DAY_MS, TRACE_RETENTION_DAYS, TRACE_SCHEMA_VERSION,
  TURN_CLOSE_REASONS, TURN_ORIGINS, TURN_OUTCOMES, UTTERANCE_ROLES, isOneOf,
  type CallOutcome, type CommandKind, type ContinuationOutcome, type EventSource, type PlaybackTerminationReason, type ProgressReason, type ResponseStatus,
  type ResponseTerminalReason, type SkipReason, type StallReason, type TraceEventKind, type TurnCloseReason,
  type TurnOrigin, type TurnOutcome, type UtteranceRole,
} from './kinds.js';

/** A content-free id: one token, no whitespace, no punctuation that could carry prose. */const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/;
const TRACE_RESULT_MAX_CHARS = 16_384;

export class TraceRecordError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'TraceRecordError'; }
}

export interface TraceEventIds {
  liveSessionId: string;
  source?: EventSource;
  turnId?: string;
  responseKey?: string;
  callKey?: string;
  playbackKey?: string;
  actionId?: string;
  causedByEventId?: number;
  connectionEpoch?: string;
  sourceInstanceId?: string;
  sourceSeq?: number;
  /** Producer wall-clock ms; defaults to host now. */
  at?: number;
  /** Producer monotonic ms; defaults to this host's monotonic clock. Never mixed with another clock. */
  monoMs?: number;
}

export interface TraceDetailMap {
  'turn.opened': { origin: TurnOrigin; turnIndex: number; openedAt: number; monoMs: number; supersedesTurnId?: string; attributionUncertain?: boolean };
  'turn.closed': { closedAt: number; closeReason: TurnCloseReason; outcome?: TurnOutcome; stallReason?: StallReason };
  'turn.summary': { firstAudibleAt?: number; playbackDrainedAt?: number; outcome?: TurnOutcome; stallReason?: StallReason };
  'response.created': { createdAt: number; status?: ResponseStatus; providerResponseId?: string; delegationId?: string; continuationOfResponseKey?: string };
  /** O1b-A (D12-1): one receipt per delegated response, with its provider id and how many calls it carried. */
  'delegation.created': { createdAt: number; providerResponseId?: string; callCount: number };
  'response.observed': { observedAt: number; providerResponseId?: string; delegationId?: string };
  'response.terminal': { terminalAt: number; status: ResponseStatus; terminalReason: ResponseTerminalReason };
  'call.intent': { name: string; argsChars: number; intentAt: number; providerCallId?: string };
  'call.executed': { executedAt: number };
  'call.output_prepared': { outputPreparedAt: number };
  'call.output_written': { outputWrittenAt: number; outcome: CallOutcome; ms: number; resultChars: number };
  /** O1b-A: the single continuation owner's decision, and why a `response.create` was skipped. */
  'continuation.decided': { decidedAt: number; outcome: ContinuationOutcome; skipReason?: SkipReason };
  'playback.received': { segmentSeq: number; receivedAt: number };
  'playback.audible': { audibleAt: number };
  'playback.enqueued': { enqueuedAt: number };
  'playback.started': { startedAt: number };
  'playback.drained': { drainedAt: number };
  'playback.interrupted': { interruptedAt: number; terminationReason: PlaybackTerminationReason };
  'playback.terminated': { terminationReason: PlaybackTerminationReason };
  'progress.commentary': { reason: ProgressReason; sentAt: number; delegationId?: string };
  'progress.thinking': { sentAt: number; chars: number };
  'call.ceiling': { ceilingMs: number; hitAt: number };
  'command.rejected': { rejectedAt: number; code: string; param: string; kind: CommandKind };
  /** O1b-A (D12-3): the turn never became audible, with the age it reached and what the watchdog saw. */
  'live.dead_air_stalled': { stalledAt: number; turnAgeMs: number; anyAudio: boolean; inaudibleMs: number };
}

export interface TraceWritePort { transaction<T>(body: (tx: Transaction) => T): T }
export interface TraceExec {
  run(sql: string, params?: readonly SQLValue[]): number;
  all(sql: string, params?: readonly SQLValue[]): ReturnType<Transaction['all']>;
}
export interface RecordResult { seq: number; duplicate: boolean }

type Check = (value: unknown) => boolean;
interface FieldSpec { check: Check; optional?: true }

const isCount: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isFlag: Check = value => value === true || value === false;
const isId: Check = value => typeof value === 'string' && ID_SHAPE.test(value);
const oneOf = (values: readonly string[]): Check => value => isOneOf(values, value);

const ID_FIELDS = ['liveSessionId', 'turnId', 'responseKey', 'callKey', 'playbackKey', 'actionId', 'connectionEpoch', 'sourceInstanceId'] as const;
const COUNT_FIELDS = ['causedByEventId', 'sourceSeq', 'at', 'monoMs'] as const;
const KNOWN_ID_KEYS = new Set<string>([...ID_FIELDS, ...COUNT_FIELDS, 'source']);

// One row per kind: which ids it must carry, and every detail field it may carry.
// Anything else is refused at runtime, so a caller cannot widen a metadata row into prose.
const REQUIRED_IDS: Readonly<Record<TraceEventKind, readonly string[]>> = {
  'turn.opened': ['turnId'], 'turn.closed': ['turnId'], 'turn.summary': ['turnId'],
  'delegation.created': ['responseKey'],
  'response.created': ['responseKey'], 'response.observed': ['responseKey'], 'response.terminal': ['responseKey'],
  'call.intent': ['callKey'], 'call.executed': ['callKey'], 'call.output_prepared': ['callKey'], 'call.output_written': ['callKey'],
  'playback.received': ['playbackKey'], 'playback.audible': ['playbackKey'], 'playback.enqueued': ['playbackKey'],
  'playback.started': ['playbackKey'], 'playback.drained': ['playbackKey'], 'playback.interrupted': ['playbackKey'],
  'playback.terminated': ['playbackKey'],
  'progress.commentary': ['turnId'], 'progress.thinking': ['turnId'], 'call.ceiling': ['callKey'], 'command.rejected': ['turnId'],
  'continuation.decided': ['responseKey'], 'live.dead_air_stalled': ['turnId'],
};

const DETAIL_SPECS: Readonly<Record<TraceEventKind, Readonly<Record<string, FieldSpec>>>> = {
  'turn.opened': {
    origin: { check: oneOf(TURN_ORIGINS) }, turnIndex: { check: isCount }, openedAt: { check: isCount }, monoMs: { check: isCount },
    supersedesTurnId: { check: isId, optional: true }, attributionUncertain: { check: isFlag, optional: true },
  },
  'turn.closed': {
    closedAt: { check: isCount }, closeReason: { check: oneOf(TURN_CLOSE_REASONS) },
    outcome: { check: oneOf(TURN_OUTCOMES), optional: true }, stallReason: { check: oneOf(STALL_REASONS), optional: true },
  },
  'turn.summary': {
    firstAudibleAt: { check: isCount, optional: true }, playbackDrainedAt: { check: isCount, optional: true },
    outcome: { check: oneOf(TURN_OUTCOMES), optional: true }, stallReason: { check: oneOf(STALL_REASONS), optional: true },
  },
  'response.created': {
    createdAt: { check: isCount }, status: { check: oneOf(RESPONSE_STATUSES), optional: true },
    providerResponseId: { check: isId, optional: true }, delegationId: { check: isId, optional: true },
    continuationOfResponseKey: { check: isId, optional: true },
  },
  'delegation.created': {
    createdAt: { check: isCount }, providerResponseId: { check: isId, optional: true }, callCount: { check: isCount },
  },
  'response.observed': {
    observedAt: { check: isCount }, providerResponseId: { check: isId, optional: true }, delegationId: { check: isId, optional: true },
  },
  'response.terminal': {
    terminalAt: { check: isCount }, status: { check: oneOf(RESPONSE_STATUSES) }, terminalReason: { check: oneOf(RESPONSE_TERMINAL_REASONS) },
  },
  'call.intent': { name: { check: isId }, argsChars: { check: isCount }, intentAt: { check: isCount }, providerCallId: { check: isId, optional: true } },
  'call.executed': { executedAt: { check: isCount } },
  'call.output_prepared': { outputPreparedAt: { check: isCount } },
  'call.output_written': { outputWrittenAt: { check: isCount }, outcome: { check: oneOf(CALL_OUTCOMES) }, ms: { check: isCount }, resultChars: { check: isCount } },
  'playback.received': { segmentSeq: { check: isCount }, receivedAt: { check: isCount } },
  'playback.audible': { audibleAt: { check: isCount } },
  'playback.enqueued': { enqueuedAt: { check: isCount } },
  'playback.started': { startedAt: { check: isCount } },
  'playback.drained': { drainedAt: { check: isCount } },
  'playback.interrupted': { interruptedAt: { check: isCount }, terminationReason: { check: oneOf(PLAYBACK_TERMINATION_REASONS) } },
  'playback.terminated': { terminationReason: { check: oneOf(PLAYBACK_TERMINATION_REASONS) } },
  'progress.commentary': { reason: { check: oneOf(PROGRESS_REASONS) }, sentAt: { check: isCount }, delegationId: { check: isId, optional: true } },
  'progress.thinking': { sentAt: { check: isCount }, chars: { check: isCount } },
  'call.ceiling': { ceilingMs: { check: isCount }, hitAt: { check: isCount } },
  'command.rejected': { rejectedAt: { check: isCount }, code: { check: isId }, param: { check: isId }, kind: { check: oneOf(COMMAND_KINDS) } },
  'continuation.decided': {
    decidedAt: { check: isCount }, outcome: { check: oneOf(CONTINUATION_OUTCOMES) }, skipReason: { check: oneOf(SKIP_REASONS), optional: true },
  },
  'live.dead_air_stalled': {
    stalledAt: { check: isCount }, turnAgeMs: { check: isCount }, anyAudio: { check: isFlag }, inaudibleMs: { check: isCount },
  },
};

function validateEvent(kind: TraceEventKind, ids: TraceEventIds, detail: unknown): void {
  if (typeof ids !== 'object' || ids === null) throw new TraceRecordError('INVALID_IDS', `${kind}: ids must be an object`);
  for (const key of Object.keys(ids)) if (!KNOWN_ID_KEYS.has(key)) throw new TraceRecordError('UNKNOWN_FIELD', `${kind}: unknown id field ${key}`);
  if (!isId(ids.liveSessionId)) throw new TraceRecordError('INVALID_ID', `${kind}: liveSessionId is not an id`);
  for (const field of ID_FIELDS) {
    const value = ids[field];
    if (value !== undefined && !isId(value)) throw new TraceRecordError('INVALID_ID', `${kind}: ${field} is not an id`);
  }
  for (const field of COUNT_FIELDS) {
    const value = ids[field];
    if (value !== undefined && !isCount(value)) throw new TraceRecordError('INVALID_COUNT', `${kind}: ${field} is not a count`);
  }
  const source = ids.source ?? 'host';
  if (!isOneOf(EVENT_SOURCES, source)) throw new TraceRecordError('INVALID_SOURCE', `${kind}: unknown event source`);
  if (source === 'native' && (ids.sourceInstanceId === undefined || ids.sourceSeq === undefined)) {
    throw new TraceRecordError('MISSING_FIELD', `${kind}: a native receipt needs sourceInstanceId and sourceSeq`);
  }
  // A native receipt carries its own clock. Defaulting it to this host's monotonic value would
  // silently put two clock domains in one column, which the timeline must never subtract.
  if (source === 'native' && (ids.at === undefined || ids.monoMs === undefined)) {
    throw new TraceRecordError('MISSING_FIELD', `${kind}: a native receipt needs the producer's wall ms and monotonic ms`);
  }
  for (const field of REQUIRED_IDS[kind]) if (ids[field as keyof TraceEventIds] === undefined) throw new TraceRecordError('MISSING_FIELD', `${kind}: ${field} is required`);

  const spec = DETAIL_SPECS[kind];
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail) || Object.getPrototypeOf(detail) !== Object.prototype) {
    throw new TraceRecordError('INVALID_DETAIL', `${kind}: detail must be a plain object`);
  }
  const fields = detail as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (!(key in spec)) throw new TraceRecordError('UNKNOWN_FIELD', `${kind}: unknown detail field ${key}`);
  for (const [key, field] of Object.entries(spec)) {
    const value = fields[key];
    if (value === undefined) {
      if (field.optional !== true) throw new TraceRecordError('MISSING_FIELD', `${kind}: detail.${key} is required`);
      continue;
    }
    if (!field.check(value)) throw new TraceRecordError('INVALID_VALUE', `${kind}: detail.${key} is outside its closed allowlist`);
  }
}

function monoNow(): number { return Math.round(performance.now()); }

function assertEpoch(tx: Transaction, table: 'trace_response' | 'trace_call' | 'trace_playback', idColumn: string, key: string, epoch: string): void {
  const row = tx.get(`SELECT connection_epoch AS epoch FROM ${table} WHERE ${idColumn}=?`, [key]);
  if (row === undefined) throw new TraceRecordError('UNKNOWN_ID', `${table}:${key} is not recorded`);
  if (String(row.epoch) !== epoch) throw new TraceRecordError('STALE_EPOCH', `${table}:${key} belongs to another connection epoch`);
}

function requireChanged(changes: number, what: string): void {
  if (changes !== 1) throw new TraceRecordError('UNKNOWN_ID', `${what} is not recorded`);
}

/**
 * Write one event and its denormalised summary in one transaction. A native receipt whose
 * (live_session_id, source_instance_id, source_seq) is already present is a replay: nothing is
 * written twice and the existing seq is returned.
 */
export function record<K extends TraceEventKind>(port: TraceWritePort, kind: K, ids: TraceEventIds, detail: TraceDetailMap[K]): RecordResult {
  validateEvent(kind, ids, detail);
  const epoch = ids.connectionEpoch ?? '0';
  const source = ids.source ?? 'host';
  const receivedAt = Date.now();
  const at = ids.at ?? receivedAt;
  const monoMs = ids.monoMs ?? monoNow();
  return port.transaction(tx => {
    const changes = tx.run(
      `INSERT INTO trace_event(live_session_id, turn_id, response_key, call_key, playback_key, action_id, caused_by_event_id, kind, source, source_instance_id, source_seq, at, mono_ms, received_at, connection_epoch, schema_version, detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(live_session_id, source_instance_id, source_seq) DO NOTHING`,
      [ids.liveSessionId, ids.turnId ?? null, ids.responseKey ?? null, ids.callKey ?? null, ids.playbackKey ?? null,
        ids.actionId ?? null, ids.causedByEventId ?? null, kind, source, ids.sourceInstanceId ?? null, ids.sourceSeq ?? null,
        at, monoMs, receivedAt, epoch, TRACE_SCHEMA_VERSION, JSON.stringify(detail)]);
    if (changes === 0) {
      // A replay is the same sequence in the same session: another session's sequence is not this one's.
      const row = tx.get('SELECT seq FROM trace_event WHERE live_session_id=? AND source_instance_id=? AND source_seq=?',
        [ids.liveSessionId, ids.sourceInstanceId ?? null, ids.sourceSeq ?? null]);
      return { seq: Number(row!.seq), duplicate: true };
    }
    const seq = Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq);
    applySummary(tx, kind, ids, detail, epoch, seq);
    return { seq, duplicate: false };
  });
}

function applySummary(tx: Transaction, kind: TraceEventKind, ids: TraceEventIds, detail: unknown, epoch: string, seq: number): void {
  const turnId = ids.turnId ?? null;
  switch (kind) {
    case 'turn.opened': {
      const d = detail as TraceDetailMap['turn.opened'];
      tx.run(
        `INSERT INTO trace_turn(turn_id, live_session_id, turn_index, origin, supersedes_turn_id, opened_at, mono_ms, attribution_uncertain)
         VALUES (?,?,?,?,?,?,?,?)`,
        [ids.turnId!, ids.liveSessionId, d.turnIndex, d.origin, d.supersedesTurnId ?? null, d.openedAt, d.monoMs, d.attributionUncertain === true ? 1 : 0]);
      return;
    }
    case 'turn.closed': {
      const d = detail as TraceDetailMap['turn.closed'];
      requireChanged(tx.run(
        `UPDATE trace_turn SET closed_at=?, close_reason=?, outcome=COALESCE(?, outcome), stall_reason=COALESCE(?, stall_reason) WHERE turn_id=? AND live_session_id=?`,
        [d.closedAt, d.closeReason, d.outcome ?? null, d.stallReason ?? null, ids.turnId!, ids.liveSessionId]), `trace_turn:${ids.turnId}`);
      return;
    }
    case 'turn.summary': {
      const d = detail as TraceDetailMap['turn.summary'];
      requireChanged(tx.run(
        `UPDATE trace_turn SET first_audible_at=COALESCE(?, first_audible_at), playback_drained_at=COALESCE(?, playback_drained_at), outcome=COALESCE(?, outcome), stall_reason=COALESCE(?, stall_reason) WHERE turn_id=? AND live_session_id=?`,
        [d.firstAudibleAt ?? null, d.playbackDrainedAt ?? null, d.outcome ?? null, d.stallReason ?? null, ids.turnId!, ids.liveSessionId]), `trace_turn:${ids.turnId}`);
      return;
    }
    case 'response.created': {
      const d = detail as TraceDetailMap['response.created'];
      tx.run(
        `INSERT INTO trace_response(response_key, live_session_id, connection_epoch, provider_response_id, delegation_id, turn_id, status, created_at, continuation_of_response_key)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [ids.responseKey!, ids.liveSessionId, epoch, d.providerResponseId ?? null, d.delegationId ?? null, turnId,
          d.status ?? 'pending', d.createdAt, d.continuationOfResponseKey ?? null]);
      return;
    }
    case 'delegation.created': {
      // The delegation is a spine row: the response it answers may not have its own row yet, so nothing here
      // writes a projection that a later receipt would have to repair.
      return;
    }
    case 'response.observed': {
      const d = detail as TraceDetailMap['response.observed'];
      assertEpoch(tx, 'trace_response', 'response_key', ids.responseKey!, epoch);
      tx.run('UPDATE trace_response SET provider_response_id=COALESCE(?, provider_response_id), delegation_id=COALESCE(?, delegation_id) WHERE response_key=?',
        [d.providerResponseId ?? null, d.delegationId ?? null, ids.responseKey!]);
      return;
    }
    case 'response.terminal': {
      const d = detail as TraceDetailMap['response.terminal'];
      assertEpoch(tx, 'trace_response', 'response_key', ids.responseKey!, epoch);
      tx.run('UPDATE trace_response SET status=?, terminal_at=?, terminal_reason=? WHERE response_key=?',
        [d.status, d.terminalAt, d.terminalReason, ids.responseKey!]);
      return;
    }
    case 'call.intent': {
      const d = detail as TraceDetailMap['call.intent'];
      tx.run(
        `INSERT INTO trace_call(call_key, live_session_id, connection_epoch, provider_call_id, response_key, turn_id, name, args_chars, intent_at, outcome)
         VALUES (?,?,?,?,?,?,?,?,?,'unknown')`,
        [ids.callKey!, ids.liveSessionId, epoch, d.providerCallId ?? null, ids.responseKey ?? null, turnId, d.name, d.argsChars, d.intentAt]);
      return;
    }
    case 'call.executed': {
      const d = detail as TraceDetailMap['call.executed'];
      assertEpoch(tx, 'trace_call', 'call_key', ids.callKey!, epoch);
      tx.run('UPDATE trace_call SET executed_at=? WHERE call_key=?', [d.executedAt, ids.callKey!]);
      return;
    }
    case 'call.output_prepared': {
      const d = detail as TraceDetailMap['call.output_prepared'];
      assertEpoch(tx, 'trace_call', 'call_key', ids.callKey!, epoch);
      tx.run('UPDATE trace_call SET output_prepared_at=? WHERE call_key=?', [d.outputPreparedAt, ids.callKey!]);
      return;
    }
    case 'call.output_written': {
      const d = detail as TraceDetailMap['call.output_written'];
      assertEpoch(tx, 'trace_call', 'call_key', ids.callKey!, epoch);
      tx.run('UPDATE trace_call SET output_written_at=?, outcome=?, ms=?, result_chars=? WHERE call_key=?',
        [d.outputWrittenAt, d.outcome, d.ms, d.resultChars, ids.callKey!]);
      return;
    }
    case 'playback.received': {
      const d = detail as TraceDetailMap['playback.received'];
      tx.run(
        `INSERT INTO trace_playback(playback_key, live_session_id, source_instance_id, segment_seq, response_key, turn_id, received_at)
         VALUES (?,?,?,?,?,?,?)`,
        [ids.playbackKey!, ids.liveSessionId, ids.sourceInstanceId ?? 'host', d.segmentSeq, ids.responseKey ?? null, turnId, d.receivedAt]);
      return;
    }
    case 'playback.audible': {
      const d = detail as TraceDetailMap['playback.audible'];
      requireChanged(tx.run('UPDATE trace_playback SET audible_at=? WHERE playback_key=?', [d.audibleAt, ids.playbackKey!]), `trace_playback:${ids.playbackKey}`);
      tx.run(`UPDATE trace_turn SET first_audible_at=? WHERE live_session_id=? AND turn_id=(SELECT turn_id FROM trace_playback WHERE playback_key=?) AND (first_audible_at IS NULL OR first_audible_at>?)`,
        [d.audibleAt, ids.liveSessionId, ids.playbackKey!, d.audibleAt]);
      return;
    }
    case 'playback.enqueued': {
      const d = detail as TraceDetailMap['playback.enqueued'];
      requireChanged(tx.run('UPDATE trace_playback SET enqueued_at=? WHERE playback_key=?', [d.enqueuedAt, ids.playbackKey!]), `trace_playback:${ids.playbackKey}`);
      return;
    }
    case 'playback.started': {
      const d = detail as TraceDetailMap['playback.started'];
      requireChanged(tx.run('UPDATE trace_playback SET started_at=? WHERE playback_key=?', [d.startedAt, ids.playbackKey!]), `trace_playback:${ids.playbackKey}`);
      return;
    }
    case 'playback.drained': {
      const d = detail as TraceDetailMap['playback.drained'];
      requireChanged(tx.run('UPDATE trace_playback SET drained_at=?, termination_reason=? WHERE playback_key=?', [d.drainedAt, 'drained', ids.playbackKey!]), `trace_playback:${ids.playbackKey}`);
      tx.run(`UPDATE trace_turn SET playback_drained_at=? WHERE live_session_id=? AND turn_id=(SELECT turn_id FROM trace_playback WHERE playback_key=?) AND (playback_drained_at IS NULL OR playback_drained_at>?)`,
        [d.drainedAt, ids.liveSessionId, ids.playbackKey!, d.drainedAt]);
      return;
    }
    case 'playback.interrupted': {
      const d = detail as TraceDetailMap['playback.interrupted'];
      requireChanged(tx.run('UPDATE trace_playback SET interrupted_at=?, termination_reason=? WHERE playback_key=?', [d.interruptedAt, d.terminationReason, ids.playbackKey!]), `trace_playback:${ids.playbackKey}`);
      return;
    }
    case 'playback.terminated': {
      const d = detail as TraceDetailMap['playback.terminated'];
      requireChanged(tx.run('UPDATE trace_playback SET termination_reason=? WHERE playback_key=?', [d.terminationReason, ids.playbackKey!]), `trace_playback:${ids.playbackKey}`);
      return;
    }
    // S4a progress and command receipts: the causal spine row is the whole record; no projection holds them.
    case 'progress.commentary': case 'progress.thinking': case 'call.ceiling': case 'command.rejected': return;
    // O1b-A: the decision and the stall are spine rows; their epoch and their turn are already told by the
    // response and turn rows they name, so the projection they touch is the stall reason on the turn.
    case 'continuation.decided': {
      assertEpoch(tx, 'trace_response', 'response_key', ids.responseKey!, epoch);
      return;
    }
    case 'live.dead_air_stalled': {
      tx.run("UPDATE trace_turn SET stall_reason=COALESCE(stall_reason, 'no_audible_output') WHERE turn_id=? AND closed_at IS NULL", [ids.turnId!]);
      return;
    }
    default: {
      const unreachable: never = kind;
      throw new TraceRecordError('UNKNOWN_KIND', `unknown event kind ${String(unreachable)} event ${seq}`);
    }
  }
}

/** The only writer for owner transcript text. Metadata entry points reject text by shape. */
export function recordUtterance(port: TraceWritePort, utterance: { turnId: string; role: UtteranceRole; at: number; final: boolean; text: string }): void {
  if (!isOneOf(UTTERANCE_ROLES, utterance.role) || !isId(utterance.turnId) || !isCount(utterance.at) || typeof utterance.text !== 'string') {
    throw new TraceRecordError('INVALID_VALUE', 'utterance: role, turnId, at or text is outside its allowlist');
  }
  port.transaction(tx => {
    tx.run('INSERT INTO trace_utterance(turn_id, role, at, final, text) VALUES (?,?,?,?,?)',
      [utterance.turnId, utterance.role, utterance.at, utterance.final ? 1 : 0, utterance.text]);
  });
}

/** The only writer for tool result text, capped so one result cannot unbounded the database. */
export function recordCallResult(port: TraceWritePort, result: { callKey: string; text: string; truncated?: boolean }): void {
  if (!isId(result.callKey) || typeof result.text !== 'string') throw new TraceRecordError('INVALID_VALUE', 'call result: callKey or text is outside its allowlist');
  const over = result.text.length > TRACE_RESULT_MAX_CHARS;
  const text = over ? result.text.slice(0, TRACE_RESULT_MAX_CHARS) : result.text;
  port.transaction(tx => {
    tx.run('INSERT INTO trace_call_result(call_key, text, text_truncated) VALUES (?,?,?)', [result.callKey, text, over || result.truncated === true ? 1 : 0]);
  });
}

/**
 * Retention for the two trace content tables only, called at host start. Metadata rows keep
 * their place; a 30-day-old transcript or tool result is deleted logically, and WAL frames or
 * free pages are not forensically erased.
 */
export function pruneTraceContent(exec: TraceExec, now: number): { utterances: number; callResults: number } {
  const cutoff = now - TRACE_RETENTION_DAYS * TRACE_DAY_MS;
  const utterances = exec.run('DELETE FROM trace_utterance WHERE at < ?', [cutoff]);
  const callResults = exec.run('DELETE FROM trace_call_result WHERE call_key IN (SELECT call_key FROM trace_call WHERE intent_at < ?)', [cutoff]);
  return { utterances, callResults };
}

export { EVENT_KINDS };

/**
 * O1b-A: the receipt door an adapter is handed. The host binds the session id, the connection epoch and the
 * turn, so an adapter names only what it did and can never write another session's row or another epoch's.
 */
export interface LiveTracePort {
  receipt<K extends TraceEventKind>(kind: K, ids: Omit<TraceEventIds, 'liveSessionId' | 'connectionEpoch'>, detail: TraceDetailMap[K]): void;
}

export interface LiveTraceBinding {
  port: TraceWritePort;
  liveSessionId: string;
  connectionEpoch: string;
  /** The turn the host has open, read per receipt: a receipt that lands after the turn closed still names it. */
  turnId?: () => string | undefined;
  /** A refused receipt is counted where the caller can see it and never thrown into the adapter's turn. */
  onReject?: (code: string, kind: TraceEventKind) => void;
}

export function liveTracePort(binding: LiveTraceBinding): LiveTracePort {
  return {
    receipt<K extends TraceEventKind>(kind: K, ids: Omit<TraceEventIds, 'liveSessionId' | 'connectionEpoch'>, detail: TraceDetailMap[K]): void {
      try {
        const turnId = ids.turnId ?? binding.turnId?.();
        record(binding.port, kind, {
          ...ids, ...(turnId === undefined ? {} : { turnId }),
          liveSessionId: binding.liveSessionId, connectionEpoch: binding.connectionEpoch,
        }, detail);
      } catch (error) {
        binding.onReject?.(error instanceof TraceRecordError ? error.code : 'record_failed', kind);
      }
    },
  };
}
