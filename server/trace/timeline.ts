import type { SQLRow, SQLValue } from '../contracts/storage.js';
import type {
  CallOutcome, PlaybackTerminationReason, ResponseStatus, ResponseTerminalReason, StallReason,
  TurnCloseReason, TurnOrigin, TurnOutcome, UtteranceRole,
} from './kinds.js';

export interface TraceRead {
  all(sql: string, params?: readonly SQLValue[]): SQLRow[];
  get(sql: string, params?: readonly SQLValue[]): SQLRow | undefined;
}

export interface TurnView {
  turnId: string; turnIndex: number; origin: TurnOrigin; supersedesTurnId: string | null;
  openedAt: number; monoMs: number; closedAt: number | null; closeReason: TurnCloseReason | null;
  firstAudibleAt: number | null; playbackDrainedAt: number | null;
  outcome: TurnOutcome | null; stallReason: StallReason | null; attributionUncertain: boolean;
}
export interface ResponseView {
  responseKey: string; providerResponseId: string | null; delegationId: string | null; turnId: string | null;
  status: ResponseStatus; createdAt: number; terminalAt: number | null; terminalReason: ResponseTerminalReason | null;
  continuationOfResponseKey: string | null;
}
export interface CallView {
  callKey: string; responseKey: string | null; turnId: string | null; name: string; argsChars: number;
  intentAt: number; executedAt: number | null; outputPreparedAt: number | null; outputWrittenAt: number | null;
  outcome: CallOutcome; ms: number | null; resultChars: number | null;
}
export interface PlaybackView {
  playbackKey: string; sourceInstanceId: string; segmentSeq: number; responseKey: string | null; turnId: string | null;
  receivedAt: number; audibleAt: number | null; enqueuedAt: number | null; startedAt: number | null;
  drainedAt: number | null; interruptedAt: number | null; terminationReason: PlaybackTerminationReason | null;
}
export interface UtteranceView { role: UtteranceRole; at: number; final: boolean; text: string }
export interface TurnTrack {
  turn: TurnView; responses: ResponseView[]; calls: CallView[]; playback: PlaybackView[]; utterances?: UtteranceView[];
}
/** A typed obligation, never a long interval: what the record still owes and which receipt would close it. */
export interface TraceGap {
  turnId: string; turnIndex: number; obligation: StallReason; expectedReceipt: string; detail: string;
  responseKey: string | null; callKey: string | null; playbackKey: string | null;
}
export interface NativeGap { sourceInstanceId: string; fromSeq: number; toSeq: number }
export interface TimelineReport {
  liveSessionId: string; capturedAt: number; turns: TurnTrack[]; gaps: TraceGap[]; nativeGaps: NativeGap[];
}

const num = (value: SQLValue | undefined): number | null => value === null || value === undefined ? null : Number(value);
const numOr = (value: SQLValue | undefined, fallback: number): number => num(value) ?? fallback;
const str = (value: SQLValue | undefined): string | null => value === null || value === undefined ? null : String(value);

function turnView(row: SQLRow): TurnView {
  return {
    turnId: String(row.turn_id), turnIndex: numOr(row.turn_index, 0), origin: String(row.origin) as TurnOrigin,
    supersedesTurnId: str(row.supersedes_turn_id), openedAt: numOr(row.opened_at, 0), monoMs: numOr(row.mono_ms, 0),
    closedAt: num(row.closed_at), closeReason: str(row.close_reason) as TurnCloseReason | null,
    firstAudibleAt: num(row.first_audible_at), playbackDrainedAt: num(row.playback_drained_at),
    outcome: str(row.outcome) as TurnOutcome | null, stallReason: str(row.stall_reason) as StallReason | null,
    attributionUncertain: Number(row.attribution_uncertain) === 1,
  };
}
function responseView(row: SQLRow): ResponseView {
  return {
    responseKey: String(row.response_key), providerResponseId: str(row.provider_response_id), delegationId: str(row.delegation_id),
    turnId: str(row.turn_id), status: String(row.status) as ResponseStatus, createdAt: numOr(row.created_at, 0),
    terminalAt: num(row.terminal_at), terminalReason: str(row.terminal_reason) as ResponseTerminalReason | null,
    continuationOfResponseKey: str(row.continuation_of_response_key),
  };
}
function callView(row: SQLRow): CallView {
  return {
    callKey: String(row.call_key), responseKey: str(row.response_key), turnId: str(row.turn_id), name: String(row.name),
    argsChars: numOr(row.args_chars, 0), intentAt: numOr(row.intent_at, 0), executedAt: num(row.executed_at),
    outputPreparedAt: num(row.output_prepared_at), outputWrittenAt: num(row.output_written_at),
    outcome: String(row.outcome) as CallOutcome, ms: num(row.ms), resultChars: num(row.result_chars),
  };
}
function playbackView(row: SQLRow): PlaybackView {
  return {
    playbackKey: String(row.playback_key), sourceInstanceId: String(row.source_instance_id), segmentSeq: numOr(row.segment_seq, 0),
    responseKey: str(row.response_key), turnId: str(row.turn_id), receivedAt: numOr(row.received_at, 0),
    audibleAt: num(row.audible_at), enqueuedAt: num(row.enqueued_at), startedAt: num(row.started_at),
    drainedAt: num(row.drained_at), interruptedAt: num(row.interrupted_at),
    terminationReason: str(row.termination_reason) as PlaybackTerminationReason | null,
  };
}

export interface TimelineOptions { turn?: number; content?: boolean; capturedAt?: number }

export function buildTimeline(read: TraceRead, liveSessionId: string, options: TimelineOptions = {}): TimelineReport {
  const turnRows = read.all('SELECT * FROM trace_turn WHERE live_session_id=? ORDER BY turn_index, opened_at', [liveSessionId]);
  const responses = read.all('SELECT * FROM trace_response WHERE live_session_id=? ORDER BY created_at, response_key', [liveSessionId]).map(responseView);
  const calls = read.all('SELECT * FROM trace_call WHERE live_session_id=? ORDER BY intent_at, call_key', [liveSessionId]).map(callView);
  const playback = read.all('SELECT * FROM trace_playback WHERE live_session_id=? ORDER BY segment_seq, received_at, playback_key', [liveSessionId]).map(playbackView);
  const utterances = options.content === true
    ? read.all(`SELECT u.turn_id AS turn_id, u.role AS role, u.at AS at, u.final AS final, u.text AS text
                FROM trace_utterance u JOIN trace_turn t ON t.turn_id=u.turn_id
                WHERE t.live_session_id=? ORDER BY t.turn_index, u.at`, [liveSessionId])
    : [];

  const turns: TurnTrack[] = turnRows.map(turnView)
    .filter(turn => options.turn === undefined || turn.turnIndex === options.turn)
    .map(turn => {
      const track: TurnTrack = {
        turn,
        responses: responses.filter(response => response.turnId === turn.turnId),
        calls: calls.filter(call => call.turnId === turn.turnId),
        playback: playback.filter(segment => segment.turnId === turn.turnId),
      };
      if (options.content === true) {
        track.utterances = utterances.filter(row => String(row.turn_id) === turn.turnId)
          .map(row => ({ role: String(row.role) as UtteranceRole, at: numOr(row.at, 0), final: Number(row.final) === 1, text: String(row.text) }));
      }
      return track;
    });

  const gaps = turns.flatMap(gapsFor).sort((a, b) => a.turnIndex - b.turnIndex || a.obligation.localeCompare(b.obligation) || a.turnId.localeCompare(b.turnId));
  return {
    liveSessionId,
    capturedAt: options.capturedAt ?? Date.now(),
    turns,
    gaps,
    nativeGaps: missingNativeRanges(read, liveSessionId),
  };
}

/**
 * Obligations, not stalls. A turn interrupted, superseded or intentionally silent owes
 * nothing, so it never produces a gap.
 */
function gapsFor(track: TurnTrack): TraceGap[] {
  const { turn, responses, calls, playback } = track;
  if (turn.closeReason === 'interrupted' || turn.closeReason === 'superseded') return [];
  if (turn.outcome === 'silent') return [];
  const gaps: TraceGap[] = [];
  const add = (obligation: StallReason, expectedReceipt: string, detail: string, ids: Partial<Pick<TraceGap, 'responseKey' | 'callKey' | 'playbackKey'>>): void => {
    gaps.push({
      turnId: turn.turnId, turnIndex: turn.turnIndex, obligation, expectedReceipt, detail,
      responseKey: ids.responseKey ?? null, callKey: ids.callKey ?? null, playbackKey: ids.playbackKey ?? null,
    });
  };
  const closedCleanly = turn.closedAt !== null && turn.closeReason !== 'session_end';

  for (const response of responses) {
    const observed = response.providerResponseId !== null || response.delegationId !== null;
    const settled = response.terminalAt !== null;
    if (closedCleanly || observed || settled) continue;
    if (response.continuationOfResponseKey !== null) {
      add('no_response', 'provider.response_id for the continuation',
        `continuation ${response.responseKey} of ${response.continuationOfResponseKey} has no provider receipt`, { responseKey: response.responseKey });
    } else {
      add('no_delegation', 'provider.response_id or delegation_id',
        `response ${response.responseKey} was created at ${response.createdAt} and no delegation was observed`, { responseKey: response.responseKey });
    }
  }

  for (const response of responses) {
    const batch = calls.filter(call => call.responseKey === response.responseKey);
    if (batch.length === 0 || closedCleanly) continue;
    const settledBatch = batch.every(call => call.outputWrittenAt !== null || call.outcome !== 'unknown');
    const continued = responses.some(other => other.continuationOfResponseKey === response.responseKey);
    if (settledBatch && !continued) {
      add('no_continuation_decision', 'continuation response or turn close',
        `${batch.length} call(s) of ${response.responseKey} settled with no continuation decision`, { responseKey: response.responseKey });
    }
  }

  const answered = responses.some(response => response.status === 'completed');
  const audible = playback.some(segment => segment.audibleAt !== null);
  const silent = turn.outcome === 'no_response' || turn.outcome === 'failed';
  if (answered && !audible && !silent) {
    add('no_audible_output', 'playback.audible_at or turn outcome silent/no_response',
      'a completed answer never became audible', {});
  }

  for (const segment of playback) {
    if (segment.startedAt === null && segment.audibleAt === null) continue;
    if (segment.drainedAt !== null || segment.interruptedAt !== null || segment.terminationReason !== null) continue;
    add('no_playback_drain', 'playback.drained_at, interrupted_at or termination_reason',
      `playback ${segment.playbackKey} segment ${segment.segmentSeq} started and never ended`, { playbackKey: segment.playbackKey });
  }
  return gaps;
}

/** Interior holes in a native instance's own sequence: the reader reports, it never fills. */
export function missingNativeRanges(read: TraceRead, liveSessionId: string): NativeGap[] {
  const rows = read.all(
    `SELECT source_instance_id AS instance, source_seq AS seq FROM trace_event
     WHERE live_session_id=? AND source='native' AND source_seq IS NOT NULL
     ORDER BY source_instance_id, source_seq`, [liveSessionId]);
  const gaps: NativeGap[] = [];
  let instance: string | null = null;
  let previous = 0;
  for (const row of rows) {
    const current = String(row.instance);
    const seq = Number(row.seq);
    if (current !== instance) { instance = current; previous = seq; continue; }
    if (seq > previous + 1) gaps.push({ sourceInstanceId: current, fromSeq: previous + 1, toSeq: seq - 1 });
    previous = seq;
  }
  return gaps;
}

export function resolveSession(read: TraceRead, spec: string): string | undefined {
  if (spec !== 'latest') return spec;
  const turn = read.get('SELECT live_session_id AS id FROM trace_turn GROUP BY live_session_id ORDER BY MAX(opened_at) DESC, MAX(rowid) DESC LIMIT 1');
  if (turn !== undefined) return String(turn.id);
  const event = read.get('SELECT live_session_id AS id FROM trace_event ORDER BY seq DESC LIMIT 1');
  return event === undefined ? undefined : String(event.id);
}

const METADATA_EXPORT = [
  { table: 'trace_turn', columns: 'turn_id, live_session_id, turn_index, origin, supersedes_turn_id, opened_at, mono_ms, closed_at, close_reason, first_audible_at, playback_drained_at, outcome, stall_reason, attribution_uncertain', order: 'live_session_id, turn_index, opened_at' },
  { table: 'trace_response', columns: 'response_key, live_session_id, connection_epoch, provider_response_id, delegation_id, turn_id, status, created_at, terminal_at, terminal_reason, continuation_of_response_key', order: 'live_session_id, created_at, response_key' },
  { table: 'trace_call', columns: 'call_key, live_session_id, connection_epoch, provider_call_id, response_key, turn_id, name, args_chars, intent_at, executed_at, output_prepared_at, output_written_at, outcome, ms, result_chars', order: 'live_session_id, intent_at, call_key' },
  { table: 'trace_playback', columns: 'playback_key, live_session_id, source_instance_id, segment_seq, response_key, turn_id, received_at, audible_at, enqueued_at, started_at, drained_at, interrupted_at, termination_reason', order: 'live_session_id, segment_seq, playback_key' },
  { table: 'trace_event', columns: 'seq, live_session_id, turn_id, response_key, call_key, playback_key, action_id, caused_by_event_id, kind, source, source_instance_id, source_seq, at, mono_ms, received_at, connection_epoch, schema_version, detail', order: 'seq' },
] as const;

/** Named columns from the five metadata tables. Never a database dump, never a content table. */
export function exportMetadata(read: TraceRead, liveSessionId?: string): Record<string, SQLRow[]> {
  const out: Record<string, SQLRow[]> = {};
  for (const spec of METADATA_EXPORT) {
    out[spec.table] = liveSessionId === undefined
      ? read.all(`SELECT ${spec.columns} FROM ${spec.table} ORDER BY ${spec.order}`)
      : read.all(`SELECT ${spec.columns} FROM ${spec.table} WHERE live_session_id=? ORDER BY ${spec.order}`, [liveSessionId]);
  }
  return out;
}

const wall = (value: number | null): string => value === null ? '-' : new Date(value).toISOString();
const mono = (value: number | null): string => value === null ? '-' : `+${value}ms`;
const orDash = (value: string | null): string => value ?? '-';

export function renderTimeline(report: TimelineReport): string {
  const lines: string[] = [`session ${report.liveSessionId} captured ${wall(report.capturedAt)}`];
  for (const track of report.turns) {
    const t = track.turn;
    lines.push(`turn ${t.turnIndex} (${t.turnId}) origin=${t.origin} mono=${mono(t.monoMs)} opened=${wall(t.openedAt)}`
      + ` closed=${wall(t.closedAt)} reason=${orDash(t.closeReason)} outcome=${orDash(t.outcome)}${t.attributionUncertain ? ' attribution=uncertain' : ''}`);
    for (const u of track.utterances ?? []) lines.push(`  utterance ${u.role}${u.final ? ' final' : ''} at=${wall(u.at)} ${JSON.stringify(u.text)}`);
    for (const r of track.responses) {
      lines.push(`  response ${r.responseKey} provider=${orDash(r.providerResponseId)} delegation=${orDash(r.delegationId)}`
        + ` status=${r.status} created=${wall(r.createdAt)} terminal=${wall(r.terminalAt)} reason=${orDash(r.terminalReason)}`
        + `${r.continuationOfResponseKey === null ? '' : ` continues=${r.continuationOfResponseKey}`}`);
    }
    for (const c of track.calls) {
      lines.push(`  call ${c.callKey} ${c.name} response=${orDash(c.responseKey)} intent=${wall(c.intentAt)} executed=${wall(c.executedAt)}`
        + ` prepared=${wall(c.outputPreparedAt)} written=${wall(c.outputWrittenAt)} outcome=${c.outcome}`
        + ` ms=${c.ms ?? '-'} argsChars=${c.argsChars} resultChars=${c.resultChars ?? '-'}`);
    }
    for (const p of track.playback) {
      lines.push(`  playback ${p.playbackKey} segment=${p.segmentSeq} instance=${p.sourceInstanceId} response=${orDash(p.responseKey)}`
        + ` received=${wall(p.receivedAt)} audible=${wall(p.audibleAt)} enqueued=${wall(p.enqueuedAt)}`
        + ` started=${wall(p.startedAt)} drained=${wall(p.drainedAt)} interrupted=${wall(p.interruptedAt)}`
        + ` termination=${orDash(p.terminationReason)}`);
    }
  }
  if (report.gaps.length === 0) lines.push('gaps: none');
  for (const gap of report.gaps) {
    lines.push(`GAP turn ${gap.turnIndex} obligation=${gap.obligation} expected=${gap.expectedReceipt}`
      + `${gap.responseKey === null ? '' : ` response=${gap.responseKey}`}`
      + `${gap.callKey === null ? '' : ` call=${gap.callKey}`}`
      + `${gap.playbackKey === null ? '' : ` playback=${gap.playbackKey}`} ${gap.detail}`);
  }
  for (const nativeGap of report.nativeGaps) {
    lines.push(`NATIVE-GAP instance=${nativeGap.sourceInstanceId} missing=${nativeGap.fromSeq}..${nativeGap.toSeq}`);
  }
  return `${lines.join('\n')}\n`;
}
