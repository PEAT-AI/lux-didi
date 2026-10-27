import { diagnosticContentAccess, type DiagnosticContentAuthority, type DiagnosticContentAccess } from './content.js';
import { readToolDiagnostics, type ToolDiagnostics } from '../tools/diagnostics.js';
import type { SQLRow, SQLValue } from '../contracts/storage.js';
import type {
  CallOutcome, ContinuationOutcome, PlaybackTerminationReason, ResponseStatus, ResponseTerminalReason, StallReason,
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
  stages?: { kind: string; at: number; monoMs: number; clockDomain: string | null }[];
  executionCompletedAt?: number | null;
  executionMs?: number | null;
  callKey: string; responseKey: string | null; turnId: string | null; name: string; argsChars: number;
  intentAt: number; executedAt: number | null; outputPreparedAt: number | null; outputWrittenAt: number | null;
  outcome: CallOutcome; ms: number | null; resultChars: number | null;
  /** O1b-A: when the continuation this call's answer owed was decided, and how. Owed by the response, so
   *  every call of one answered batch carries the same decision. */
  continuationAt: number | null; continuationOutcome: ContinuationOutcome | null;
}
export interface PlaybackView {
  playbackKey: string; sourceInstanceId: string; segmentSeq: number; responseKey: string | null; turnId: string | null;
  receivedAt: number; audibleAt: number | null; enqueuedAt: number | null; startedAt: number | null;
  drainedAt: number | null; interruptedAt: number | null; terminationReason: PlaybackTerminationReason | null;
}
export interface UtteranceView { role: UtteranceRole; at: number; final: boolean; text: string; source?: 'canonical_journal' | 'legacy_preview' }
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
  tools?: ToolDiagnostics;
  /** L8-Q04: what went wrong in the call as its receipts record it, a lower bound by kind. */
  callFailures: { count: number; kinds: Record<string, number> };
  /** C-RESEARCH-CONTRACT T-04: calls the admission refused. Not a failure: they reached no source. */
  blockedCalls: number;
  coverage?: { metadata: string; content: string; native: string; failureCountLowerBound: number | null; lastReason: string | null; unassociatedTranscriptRows: number | null };
  contentAccess?: DiagnosticContentAccess;
  transcript?: { journalId: number; role: UtteranceRole; text: string; final: boolean; finalOrigin: string | null; providerStartMs: number | null; providerEndMs: number | null }[];
  liveSessionId: string; capturedAt: number; turns: TurnTrack[]; gaps: TraceGap[]; nativeGaps: NativeGap[];
  /** Playback the host could not tie to a turn. Printed outside every turn, never guessed into one. */
  unattributedPlayback: PlaybackView[];
  unattributedCalls: CallView[];
  unattributedResponses: ResponseView[];
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
    executionCompletedAt: num(row.execution_completed_at),outputPreparedAt: num(row.output_prepared_at), outputWrittenAt: num(row.output_written_at),
    outcome: String(row.outcome) as CallOutcome, ms: num(row.ms), resultChars: num(row.result_chars),
    continuationAt: null, continuationOutcome: null,
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

/**
 * O1b-A: the continuation owner's last decision per answered response. A batch answers one response, so the
 * decision is read once and every call of that batch reports the same time.
 */
function continuationDecisions(read: TraceRead, liveSessionId: string): Map<string, { at: number; outcome: ContinuationOutcome }> {
  const decisions = new Map<string, { at: number; outcome: ContinuationOutcome }>();
  for (const row of read.all("SELECT response_key, at, detail FROM trace_event WHERE live_session_id=? AND kind='continuation.decided' ORDER BY at, seq", [liveSessionId])) {
    const responseKey = str(row.response_key);
    if (responseKey === null) continue;
    let outcome: ContinuationOutcome = 'deferred';
    let at = numOr(row.at, 0);
    try {
      const detail = JSON.parse(String(row.detail)) as { outcome?: unknown; decidedAt?: unknown };
      if (detail.outcome === 'sent' || detail.outcome === 'failed' || detail.outcome === 'deferred') outcome = detail.outcome;
      // The producer's own decision time, not the store's write time: a receipt is stamped where the decision was.
      if (typeof detail.decidedAt === 'number') at = detail.decidedAt;
    } catch { /* a row we cannot read tells no decision; the last readable one stands */ }
    decisions.set(responseKey, { at, outcome });
  }
  return decisions;
}

/** L8-Q04: the failure receipts of one call: rejected commands, stalls, failed responses and failed calls. */
const FAILED_RESPONSE_REASONS = new Set(['failed', 'provider_error', 'timeout']);
const FAILED_CALL_OUTCOMES = new Set(['failed', 'timeout', 'aborted']);
function callFailuresOf(read: TraceRead, liveSessionId: string, responses: readonly ResponseView[], calls: readonly CallView[]): { count: number; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {};
  const add = (kind: string): void => { kinds[kind] = (kinds[kind] ?? 0) + 1; };
  for (const row of read.all("SELECT kind FROM trace_event WHERE live_session_id=? AND kind IN ('command.rejected','live.dead_air_stalled') ORDER BY seq", [liveSessionId])) add(String(row.kind));
  for (const response of responses) if (response.terminalReason !== null && FAILED_RESPONSE_REASONS.has(response.terminalReason)) add(`response.${response.terminalReason}`);
  for (const call of calls) if (FAILED_CALL_OUTCOMES.has(call.outcome)) add(`call.${call.outcome}`);
  return { count: Object.values(kinds).reduce((sum, n) => sum + n, 0), kinds };
}

export interface TimelineOptions { turn?: number; content?: boolean; contentAuthority?: DiagnosticContentAuthority; capturedAt?: number }

export function buildTimeline(read: TraceRead, liveSessionId: string, options: TimelineOptions = {}): TimelineReport {
  const turnRows = read.all('SELECT * FROM trace_turn WHERE live_session_id=? ORDER BY turn_index, opened_at', [liveSessionId]);
  const responses = read.all('SELECT * FROM trace_response WHERE live_session_id=? ORDER BY created_at, response_key', [liveSessionId]).map(responseView);
  const continuations = continuationDecisions(read, liveSessionId);
  const stageRows = read.all("SELECT call_key,kind,at,mono_ms,clock_domain FROM trace_event WHERE live_session_id=? AND kind IN ('call.intent','call.executed','call.output_prepared','call.output_written') ORDER BY seq",[liveSessionId]);
  const coverageRow = read.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='live_sessions'")
    ? read.get('SELECT diagnostic_metadata_state,diagnostic_content_state,native_receipt_state,diagnostic_failures,diagnostic_last_reason,diagnostic_unattributed_transcripts FROM live_sessions WHERE live_session_id=?',[liveSessionId]) : undefined;
  const coverage = coverageRow ? { metadata: str(coverageRow.diagnostic_metadata_state) ?? 'unknown',content: str(coverageRow.diagnostic_content_state) ?? 'unknown',native: str(coverageRow.native_receipt_state) ?? 'unknown',failureCountLowerBound: num(coverageRow.diagnostic_failures),lastReason: str(coverageRow.diagnostic_last_reason),unassociatedTranscriptRows: num(coverageRow.diagnostic_unattributed_transcripts) } : undefined;
  const calls = read.all('SELECT * FROM trace_call WHERE live_session_id=? ORDER BY intent_at, call_key', [liveSessionId]).map(callView)
    .map(call => {
      const decided = call.responseKey === null ? undefined : continuations.get(call.responseKey);
      const stages = stageRows.filter(row => row.call_key === call.callKey).map(row => ({ kind: String(row.kind),at: Number(row.at),monoMs: Number(row.mono_ms),clockDomain: str(row.clock_domain) }));
      const start = stages.find(row => row.kind === 'call.executed'),end = stages.find(row => row.kind === 'call.output_written');
      const executionMs = start?.clockDomain && start.clockDomain === end?.clockDomain && end.monoMs >= start.monoMs ? end.monoMs-start.monoMs : null;
      return { ...call,stages,executionMs,continuationAt: decided?.at ?? null,continuationOutcome: decided?.outcome ?? null };
    });
  const playback = read.all('SELECT * FROM trace_playback WHERE live_session_id=? ORDER BY segment_seq, received_at, playback_key', [liveSessionId]).map(playbackView);
  const contentAccess = options.content === true ? diagnosticContentAccess(read,liveSessionId,options.contentAuthority) : undefined;
  const contentAllowed = contentAccess?.state === 'allowed';
  const utterances = contentAllowed
    ? read.all(`SELECT u.turn_id,u.role,u.at,CASE WHEN u.journal_id IS NULL THEN u.final ELSE j.finished END AS final,u.journal_id,
                CASE WHEN u.journal_id IS NULL THEN u.text ELSE j.text END AS text
                FROM trace_utterance u JOIN trace_turn t ON t.turn_id=u.turn_id
                LEFT JOIN live_journal j ON j.journal_id=u.journal_id AND j.live_session_id=t.live_session_id
                WHERE t.live_session_id=? ORDER BY t.turn_index,u.at,u.rowid`, [liveSessionId]) : [];
  const transcript = contentAllowed ? read.all("SELECT journal_id,kind,text,finished,final_origin,provider_start_ms,provider_end_ms FROM live_journal WHERE live_session_id=? AND kind IN ('inputTranscription','outputTranscription') ORDER BY journal_id",[liveSessionId])
    .map(row => ({ journalId: Number(row.journal_id),role: (row.kind === 'inputTranscription' ? 'owner' : 'model') as UtteranceRole,text: String(row.text ?? ''),final: row.finished === 1,finalOrigin: str(row.final_origin),providerStartMs: num(row.provider_start_ms),providerEndMs: num(row.provider_end_ms) })) : undefined;

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
          .filter(row => row.text !== null).map(row => ({ role: String(row.role) as UtteranceRole,at: numOr(row.at,0),final: Number(row.final) === 1,text: String(row.text),source: row.journal_id === null ? 'legacy_preview' as const : 'canonical_journal' as const }));
      }
      return track;
    });

  const audibilityReported = playback.some(segment => segment.audibleAt !== null);
  const callFailures = callFailuresOf(read, liveSessionId, responses, calls);
  // C-RESEARCH-CONTRACT T-04: a blocked call is counted on its own line, never inside the failure count.
  const blockedCalls = calls.filter(call => call.outcome === 'blocked').length;
  const gaps = turns.flatMap(track => gapsFor(track, audibilityReported)).sort((a, b) => a.turnIndex - b.turnIndex || a.obligation.localeCompare(b.obligation) || a.turnId.localeCompare(b.turnId));
  return {
    tools: readToolDiagnostics(read,liveSessionId,{content: options.content === true,...(options.contentAuthority ? {authority: options.contentAuthority} : {})}),
    liveSessionId,unattributedCalls: calls.filter(call => call.turnId === null),unattributedResponses: responses.filter(response => response.turnId === null),...(coverage ? { coverage } : {}),...(contentAccess ? { contentAccess } : {}),...(transcript ? { transcript } : {}),
    capturedAt: options.capturedAt ?? Date.now(),
    callFailures,
    blockedCalls,
    turns,
    gaps,
    nativeGaps: missingNativeRanges(read, liveSessionId),
    // Selected before the turn filter, so `--turn N` never turns another turn's playback into an orphan.
    unattributedPlayback: playback.filter(segment => segment.turnId === null),
  };
}

/**
 * Obligations, not stalls. A turn interrupted, superseded or intentionally silent owes
 * nothing, so it never produces a gap.
 */
function gapsFor(track: TurnTrack, audibilityReported: boolean): TraceGap[] {
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
  // #451 H13 (W6-3): until the app reports playback.audible, a segment that started is unknown
  // audibility, not absent, so the gap does not fire on every answered turn. Once any segment in the
  // session reports audibility, silence is absence again and a real inaudible answer keeps its gap.
  const audibilityUnknown = !audibilityReported && playback.some(segment => segment.startedAt !== null);
  const silent = turn.outcome === 'no_response' || turn.outcome === 'failed';
  if (answered && !audible && !audibilityUnknown && !silent) {
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
  if (read.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='live_sessions'")) {
    const latest = read.get('SELECT live_session_id AS id FROM live_sessions ORDER BY created_at DESC,rowid DESC LIMIT 1');
    if (latest) return String(latest.id);
  }
  const turn = read.get('SELECT live_session_id AS id FROM trace_turn GROUP BY live_session_id ORDER BY MAX(opened_at) DESC, MAX(rowid) DESC LIMIT 1');
  if (turn !== undefined) return String(turn.id);
  const event = read.get('SELECT live_session_id AS id FROM trace_event ORDER BY seq DESC LIMIT 1');
  return event === undefined ? undefined : String(event.id);
}

const METADATA_EXPORT = [
  { table: 'trace_turn', columns: 'turn_id, live_session_id, turn_index, origin, supersedes_turn_id, opened_at, mono_ms, closed_at, close_reason, first_audible_at, playback_drained_at, outcome, stall_reason, attribution_uncertain, clock_domain', order: 'live_session_id, turn_index, opened_at' },
  { table: 'trace_response', columns: 'response_key, live_session_id, connection_epoch, provider_response_id, delegation_id, turn_id, status, created_at, terminal_at, terminal_reason, continuation_of_response_key', order: 'live_session_id, created_at, response_key' },
  { table: 'trace_call', columns: 'call_key, live_session_id, connection_epoch, provider_call_id, response_key, turn_id, name, args_chars, intent_at, executed_at, output_prepared_at, output_written_at, outcome, ms, result_chars, execution_completed_at, canonical_owner_id, canonical_run_id, canonical_execution_id, canonical_result_id, canonical_result_sha256', order: 'live_session_id, intent_at, call_key' },
  { table: 'trace_playback', columns: 'playback_key, live_session_id, source_instance_id, segment_seq, response_key, turn_id, received_at, audible_at, enqueued_at, started_at, drained_at, interrupted_at, termination_reason', order: 'live_session_id, segment_seq, playback_key' },
  { table: 'trace_event', columns: 'seq, live_session_id, turn_id, response_key, call_key, playback_key, action_id, caused_by_event_id, kind, source, source_instance_id, source_seq, at, mono_ms, received_at, connection_epoch, schema_version, detail, clock_domain', order: 'seq' },
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

/**
 * One playback segment. Its times are the app's wall clock, a different domain from the host's
 * turn clock, so the label says approximate and no cross-domain interval is ever subtracted.
 */
const playbackLine = (p: PlaybackView, label = '  playback', suffix = ''): string =>
  `${label} ${p.playbackKey} segment=${p.segmentSeq} instance=${p.sourceInstanceId} response=${orDash(p.responseKey)}`
  + ` received=${wall(p.receivedAt)} audible=${wall(p.audibleAt)} enqueued=${wall(p.enqueuedAt)}`
  + ` started=${wall(p.startedAt)} drained=${wall(p.drainedAt)} interrupted=${wall(p.interruptedAt)}`
  + ` termination=${orDash(p.terminationReason)} clock=approx${suffix}`;

export function renderTimeline(report: TimelineReport): string {
  const lines: string[] = [`session ${report.liveSessionId} captured ${wall(report.capturedAt)}`];
  for (const track of report.turns) {
    const t = track.turn;
    lines.push(`turn ${t.turnIndex} (${t.turnId}) origin=${t.origin} mono=${mono(t.monoMs)} opened=${wall(t.openedAt)}`
      + ` closed=${wall(t.closedAt)} reason=${orDash(t.closeReason)} outcome=${orDash(t.outcome)}${t.attributionUncertain ? ' attribution=uncertain' : ''}`);
    for (const u of track.utterances ?? []) lines.push(`  utterance ${u.role}${u.final ? ' final' : ''} at=${wall(u.at)} ${JSON.stringify(u.text)}`);
    for (const r of track.responses) {
      lines.push(`  response ${r.responseKey} provider=${orDash(r.providerResponseId)} delegation=${orDash(r.delegationId)}`
        + ` status=${r.status} created=${wall(r.createdAt)} terminal=${wall(r.terminalAt)} terminalReason=${orDash(r.terminalReason)}`
        + `${r.continuationOfResponseKey === null ? '' : ` continues=${r.continuationOfResponseKey}`}`);
    }
    for (const c of track.calls) {
      lines.push(`  call ${c.callKey} ${c.name} response=${orDash(c.responseKey)} intent=${wall(c.intentAt)} executed=${wall(c.executedAt)}`
        + ` prepared=${wall(c.outputPreparedAt)} written=${wall(c.outputWrittenAt)} outcome=${c.outcome}`
        + ` ms=${c.ms ?? '-'} executionMs=${c.executionMs ?? '-'} argsChars=${c.argsChars} resultChars=${c.resultChars ?? '-'}`
        + ` continuation=${wall(c.continuationAt)}${c.continuationOutcome === null ? '' : `:${c.continuationOutcome}`}`);
    }
    for (const p of track.playback) lines.push(playbackLine(p));
  }
  for (const p of report.unattributedPlayback) lines.push(playbackLine(p, 'playback', ' turn=none'));
  if (report.gaps.length === 0) lines.push('gaps: none');
  for (const gap of report.gaps) {
    lines.push(`GAP turn ${gap.turnIndex} obligation=${gap.obligation} expected=${gap.expectedReceipt}`
      + `${gap.responseKey === null ? '' : ` response=${gap.responseKey}`}`
      + `${gap.callKey === null ? '' : ` call=${gap.callKey}`}`
      + `${gap.playbackKey === null ? '' : ` playback=${gap.playbackKey}`} ${gap.detail}`);
  }
  for (const call of report.unattributedCalls) lines.push(`unattributed call ${call.name} key=${call.callKey} outcome=${call.outcome} execution_ms=${call.executionMs ?? 'unknown'}`);
  for (const response of report.unattributedResponses) lines.push(`unattributed response ${response.responseKey} status=${response.status}`);
  lines.push(`call_failures_at_least=${report.callFailures.count}${Object.entries(report.callFailures.kinds).map(([kind, n]) => ` ${kind}=${n}`).join('')}`);
  if (report.blockedCalls > 0) lines.push(`blocked_calls=${report.blockedCalls}`);
  if (report.coverage) lines.push(`coverage metadata=${report.coverage.metadata} content=${report.coverage.content} native=${report.coverage.native} failures_at_least=${report.coverage.failureCountLowerBound ?? 'unknown'}`);
  if (report.contentAccess) lines.push(`content: ${report.contentAccess.state}${report.contentAccess.state === 'denied' ? ` reason=${report.contentAccess.reason}` : ''}`);
  for (const row of report.transcript ?? []) lines.push(`transcript journal=${row.journalId} role=${row.role} source=automatic_transcription final_origin=${row.finalOrigin ?? 'unknown'} ${JSON.stringify(row.text)}`);
  if(report.tools){
    lines.push(`tools coverage=${JSON.stringify(report.tools.coverage)}`);
    for(const call of report.tools.calls){
      lines.push(`tool execution=${call.execution_id} name=${call.tool_name} state=${call.state} requested_fidelity=${call.input_fidelity??'legacy_unknown'} result=${call.result_id??'unknown'} result_sha256=${call.result_sha256??'unknown'}`);
      if(call.input_json!==undefined)lines.push(`  requested ${call.input_json??'unavailable'}`);
      if(call.result_json!==undefined)lines.push(`  bounded_model_result ${call.result_json}`);
    }
    for(const source of report.tools.dispatches){
      lines.push(`source dispatch=${source.dispatch_id} execution=${source.execution_id} ordinal=${source.ordinal} destination=${source.connector}/${source.endpoint_id} tool=${source.tool_name} generation=${source.generation} state=${source.state} wire=${source.wire_state??'unknown'} reason=${source.reason??'pending'} binding=${source.binding_digest} schema=${source.schema_digest} accepted_run=${source.run_snapshot_sha256} received_body_sha256=${source.source_sha256??'unavailable'}`);
      if(source.arguments_json!==undefined)lines.push(`  effective ${source.arguments_json??'unavailable'}`);
      if(source.source_json!==undefined)lines.push(`  normalized_source ${source.source_json??'unavailable'}`);
    }
    for(const reuse of report.tools.reuse)lines.push(`source reuse=${reuse.id} execution=${reuse.execution_id} origin=${reuse.origin_dispatch_id??'unavailable'} state=${reuse.state} read=${reuse.read_state??'content_not_requested'}${reuse.source_json?` normalized_source=${reuse.source_json}`:''}`);
    for(const capture of report.tools.capture)lines.push(`source coverage execution=${capture.execution_id??'unattributed'} kind=${capture.kind} reason=${capture.reason}`);
  }
  for (const nativeGap of report.nativeGaps) {
    lines.push(`NATIVE-GAP instance=${nativeGap.sourceInstanceId} missing=${nativeGap.fromSeq}..${nativeGap.toSeq}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// #1026: the log-backed views. One call's whole story across host.log (and its rotated files),
// native-live.log and audio.log, plus the log health doctor. Reading is line tolerant: a torn or
// non-JSON line is counted, never fatal, because one truncated write used to abort a whole file.
// A line joins a call by its callId (the envelope L2 writes), else by its liveSessionId, else by
// the pid and time window of the session's own lines. The third case is always reported as such.

export type LogStream = 'host' | 'native' | 'audio';
export interface LogInput { file: string; stream: LogStream; text: string }
export interface LogLine {
  file: string; stream: LogStream; line: number;
  at: number | null; monoMs: number | null; seq: number | null; pid: number | null;
  event: string; callId: string | null; liveSessionId: string | null;
  record: Record<string, unknown>;
}
export interface LogFileHealth { file: string; stream: LogStream; bytes: number; lines: number; torn: number; oldestDay: string | null; newestDay: string | null }
export interface LogScan { lines: LogLine[]; files: LogFileHealth[]; torn: number }

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const name = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;
const day = (value: number | null): string | null => value === null ? null : new Date(value).toISOString().slice(0, 10);

/** One parsed record. `at` is wall clock (epoch ms), `monoMs` and `seq` are the positional fields. */
function logLine(record: Record<string, unknown>, file: string, stream: LogStream, line: number): LogLine {
  const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  const at = Number.isFinite(stamp) ? stamp : count(record.wall_ms) ?? count(record.at);
  return {
    file, stream, line, at, monoMs: count(record.monoMs) ?? count(record.mono_ms),
    seq: count(record.seq) ?? count(record.source_seq), pid: count(record.pid),
    event: String(record.event), callId: name(record.callId), liveSessionId: name(record.liveSessionId), record,
  };
}

export function scanLogs(inputs: readonly LogInput[]): LogScan {
  const lines: LogLine[] = [];
  const files: LogFileHealth[] = [];
  let torn = 0;
  for (const input of inputs) {
    let fileLines = 0, fileTorn = 0;
    const stamps: number[] = [];
    for (const [index, raw] of input.text.split('\n').entries()) {
      if (raw.trim() === '') continue;
      let record: unknown;
      try { record = JSON.parse(raw); } catch { fileTorn += 1; continue; }
      if (record === null || typeof record !== 'object' || typeof (record as Record<string, unknown>).event !== 'string') { fileTorn += 1; continue; }
      const line = logLine(record as Record<string, unknown>, input.file, input.stream, index + 1);
      lines.push(line);
      if (line.at !== null) stamps.push(line.at);
      fileLines += 1;
    }
    torn += fileTorn;
    files.push({
      file: input.file, stream: input.stream, bytes: Buffer.byteLength(input.text, 'utf8'), lines: fileLines, torn: fileTorn,
      oldestDay: stamps.length ? day(Math.min(...stamps)) : null, newestDay: stamps.length ? day(Math.max(...stamps)) : null,
    });
  }
  return { lines, files, torn };
}

export type CallEntryKind = 'state' | 'owner' | 'model' | 'tool' | 'research' | 'silence' | 'connector' | 'terminal';
export interface CallEntry { at: number | null; monoMs: number | null; kind: CallEntryKind; text: string; joinedBy: 'store' | 'call' | 'session' | 'window' }
export interface CallStory {
  liveSessionId: string | null; callId: string | null; startedAt: number | null; durationMs: number | null;
  entries: CallEntry[]; joinedByWindow: number; skipped: number; torn: number; files: number; content: boolean;
}

/** The event families a call is debugged by. Everything else is noise in this view, so it is counted. */
const LOG_EVENT_KIND: Record<string, CallEntryKind> = {
  live_state: 'state', audio_owned: 'state', audio_released: 'state', audio_started: 'state', live_interrupted: 'state',
  live_first_audio: 'model', live_answer_audio: 'model', gptlive_turn_complete: 'model', live_turn_script: 'model',
  live_voice_profile: 'model', live_voice_shift: 'model',
  live_handshake: 'model', live_provider_open: 'model', live_provider_ready: 'model',
  live_tool_turn: 'tool', tool_output_sent: 'tool', gptlive_tool_output: 'tool',
  live_dead_air: 'silence', live_heard_silence: 'silence', live_watchdog: 'silence', playback_underrun: 'silence',
  connector_identity: 'connector', connector_failure: 'connector', connector_connected: 'connector',
  research_run: 'research', research_joined: 'research', research_call_arrived: 'research', research_source: 'research',
  research_first_answer: 'research', research_late_findings: 'research', research_progress: 'research',
  live_terminal: 'terminal', live_end: 'terminal', live_session_diagnostics: 'terminal',
};
/** Metadata only, in reading order: no message, no text, no argument or result body. */
const LOG_DETAIL_KEYS = [
  'state', 'from', 'cause', 'connector', 'reason', 'phase', 'outcome', 'code', 'endpointId', 'proven', 'match',
  'researchId', 'sources', 'tools', 'calls', 'ms', 'msSinceReady', 'msSinceOpen', 'msSinceArrived', 'deadAirMs',
  'queuedMs', 'toolPending', 'failureClass', 'closeReason', 'terminalReason',
  // C-PITCH: the voice column, so one call's responses read as a pitch line and a shift stands out.
  'f0Hz', 'f0P10Hz', 'f0P90Hz', 'voicedRatio', 'responseId',
] as const;

function logEntryText(line: LogLine): string[] {
  const latency = line.event === 'live_tool_turn' ? line.record.toolLatencyMs : undefined;
  if (Array.isArray(latency) && latency.length > 0) {
    return latency.map(item => {
      const tool = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return `tool ${String(tool.tool)} ms=${count(tool.ms) ?? '?'}`;
    });
  }
  const parts: string[] = [line.event];
  for (const key of LOG_DETAIL_KEYS) {
    const value = line.record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${String(value)}`);
  }
  return [parts.join(' ')];
}

/** A session's own lines bound its window; a pidless line inside it, or one of its pids, joins by that window. */
const WINDOW_MARGIN_MS = 2000;
interface Attribution { lines: { line: LogLine; joinedBy: 'call' | 'session' | 'window' }[]; start: number | null; end: number | null }

function attributeLines(scan: LogScan, spec: { liveSessionId?: string; callId?: string }): Attribution {
  const span = (lines: readonly LogLine[]): [number | null, number | null] => {
    const stamps = lines.map(line => line.at).filter((value): value is number => value !== null);
    return stamps.length === 0 ? [null, null] : [Math.min(...stamps), Math.max(...stamps)];
  };
  if (spec.callId !== undefined) {
    const own = scan.lines.filter(line => line.callId === spec.callId);
    const [start, end] = span(own);
    return { lines: own.map(line => ({ line, joinedBy: 'call' as const })), start, end };
  }
  const session = scan.lines.filter(line => line.liveSessionId === spec.liveSessionId);
  const [start, end] = span(session);
  const matched: Attribution['lines'] = session.map(line => ({ line, joinedBy: 'session' as const }));
  if (start === null || end === null) return { lines: matched, start, end };
  const pids = new Set(session.map(line => line.pid).filter((pid): pid is number => pid !== null));
  // The envelope's callIds the session's own lines name. A window candidate that carries another call's
  // callId belongs to that call, whatever the pid and the clock say.
  const callIds = new Set(session.map(line => line.callId).filter((callId): callId is string => callId !== null));
  for (const line of scan.lines) {
    if (line.liveSessionId === spec.liveSessionId) continue;
    if (line.liveSessionId !== null || line.at === null) continue;
    if (line.callId !== null && !callIds.has(line.callId)) continue;
    if (line.at < start - WINDOW_MARGIN_MS || line.at > end + WINDOW_MARGIN_MS) continue;
    if (line.pid !== null && !pids.has(line.pid)) continue;
    matched.push({ line, joinedBy: 'window' });
  }
  const [from, to] = span(matched.map(item => item.line));
  return { lines: matched, start: from, end: to };
}

const timeOf = (value: number | null | undefined): number => value ?? Number.POSITIVE_INFINITY;

function storeEntries(report: TimelineReport, content: boolean, read: TraceRead | undefined): CallEntry[] {
  const entries: CallEntry[] = [];
  const push = (at: number | null, monoMs: number | null, kind: CallEntryKind, text: string): void => {
    entries.push({ at, monoMs, kind, text, joinedBy: 'store' });
  };
  for (const track of report.turns) {
    push(track.turn.openedAt, track.turn.monoMs, 'state', `turn ${track.turn.turnIndex} opened origin=${track.turn.origin}`);
    for (const utterance of track.utterances ?? []) {
      push(utterance.at, null, utterance.role === 'owner' ? 'owner' : 'model',
        `${utterance.role} utterance at=${utterance.at} ${utterance.final ? 'final' : 'partial'}${content ? ` text=${JSON.stringify(utterance.text)}` : ''}`);
    }
    if (track.turn.firstAudibleAt !== null) push(track.turn.firstAudibleAt, null, 'model', 'first model audio');
    for (const response of track.responses) push(response.createdAt, null, 'model', `response ${response.responseKey} status=${response.status}`);
    for (const call of track.calls) push(call.intentAt, null, 'tool', `tool ${call.name} outcome=${call.outcome} ms=${call.ms ?? '-'}`);
    for (const playback of track.playback) {
      push(playback.audibleAt ?? playback.receivedAt, null, 'model', `playback ${playback.playbackKey} ${playback.terminationReason ?? 'open'}`);
    }
  }
  for (const call of report.unattributedCalls) push(call.intentAt, null, 'tool', `unattributed tool ${call.name} outcome=${call.outcome} ms=${call.ms ?? '-'}`);
  // The researched question and web query are content class C, so they are read only when the flag asks and
  // the store's own gate for this session allowed it: a denied read stays denied here too.
  if (content && read !== undefined && report.contentAccess?.state === 'allowed') {
    const rows = read.all(
      'SELECT x.at,x.kind,x.research_id,x.text FROM trace_research_text x WHERE x.research_id IN' +
      ' (SELECT research_id FROM trace_call WHERE live_session_id=? AND research_id IS NOT NULL) ORDER BY x.at, x.rowid',
      [report.liveSessionId]);
    for (const row of rows) {
      push(num(row.at), null, 'research', `research ${String(row.kind)} at=${num(row.at)} text=${JSON.stringify(String(row.text))}`);
    }
  }
  return entries;
}

export interface CallStoryOptions { liveSessionId?: string; callId?: string; content?: boolean; read?: TraceRead }

/** The whole story of one call: the store's turns, tool calls and responses merged into the ordered log. */
export function buildCallStory(scan: LogScan, report: TimelineReport | undefined, options: CallStoryOptions = {}): CallStory {
  const matched = attributeLines(scan, {
    ...(options.liveSessionId === undefined ? {} : { liveSessionId: options.liveSessionId }),
    ...(options.callId === undefined ? {} : { callId: options.callId }),
  });
  const entries: CallEntry[] = report === undefined ? [] : storeEntries(report, options.content === true, options.read);
  let skipped = 0;
  let joinedByWindow = 0;
  for (const { line, joinedBy } of matched.lines) {
    const kind = LOG_EVENT_KIND[line.event];
    if (kind === undefined) { skipped += 1; continue; }
    if (joinedBy === 'window') joinedByWindow += 1;
    for (const text of logEntryText(line)) entries.push({ at: line.at, monoMs: line.monoMs, kind, text, joinedBy });
  }
  entries.sort((left, right) => timeOf(left.at) - timeOf(right.at) || (left.monoMs ?? 0) - (right.monoMs ?? 0));
  const stamps = entries.map(entry => entry.at).filter((value): value is number => value !== null);
  const startedAt = stamps.length ? Math.min(...stamps) : matched.start;
  const endedAt = stamps.length ? Math.max(...stamps) : matched.end;
  return {
    liveSessionId: options.liveSessionId ?? null,
    callId: options.callId ?? null,
    startedAt,
    durationMs: startedAt === null || endedAt === null ? null : endedAt - startedAt,
    entries, joinedByWindow, skipped, torn: scan.torn, files: scan.files.length,
    content: options.content === true,
  };
}

export interface LogHealth {
  files: LogFileHealth[]; lines: number; torn: number; bytes: number;
  oldestDay: string | null; newestDay: string | null;
  topEvents: { event: string; lines: number; share: number }[];
  unattributed: { lines: number; streams: Record<string, number>; topEvents: { event: string; lines: number }[] };
}

function tally<T extends string>(values: Iterable<T>): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function logHealth(scan: LogScan, top = 10): LogHealth {
  const stamps = scan.lines.map(line => line.at).filter((value): value is number => value !== null);
  const events = tally(scan.lines.map(line => line.event));
  const topEvents = [...events.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, top)
    .map(([event, lines]) => ({ event, lines, share: scan.lines.length === 0 ? 0 : Math.round((lines / scan.lines.length) * 1000) / 1000 }));
  const loose = scan.lines.filter(line => line.liveSessionId === null && line.callId === null);
  return {
    files: scan.files, lines: scan.lines.length, torn: scan.torn,
    bytes: scan.files.reduce((total, file) => total + file.bytes, 0),
    oldestDay: stamps.length ? day(Math.min(...stamps)) : null,
    newestDay: stamps.length ? day(Math.max(...stamps)) : null,
    topEvents,
    unattributed: {
      lines: loose.length,
      streams: Object.fromEntries(tally(loose.map(line => line.stream))),
      topEvents: [...tally(loose.map(line => line.event)).entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 5)
        .map(([event, lines]) => ({ event, lines })),
    },
  };
}

export interface CallRow { liveSessionId: string; start: number; durationMs: number; tools: number; maxSilenceMs: number | null; terminal: string | null; lines: number }

/** One row per session the logs name, newest first, with the window-joined lines counted in. */
export function listCalls(scan: LogScan): CallRow[] {
  const sessions = new Set(scan.lines.map(line => line.liveSessionId).filter((value): value is string => value !== null));
  const rows: CallRow[] = [];
  for (const liveSessionId of sessions) {
    const { lines, start, end } = attributeLines(scan, { liveSessionId });
    if (start === null || end === null) continue;
    let tools = 0, maxSilenceMs: number | null = null, terminal: string | null = null;
    for (const { line } of lines) {
      const latency = line.record.toolLatencyMs;
      if (Array.isArray(latency)) tools += latency.length;
      else if (line.event === 'live_tool_turn') tools += count(line.record.toolCallsThisTurn) ?? 0;
      const silence = count(line.record.deadAirMs) ?? (line.event === 'live_heard_silence' ? count(line.record.ms) : null);
      if (silence !== null && (maxSilenceMs === null || silence > maxSilenceMs)) maxSilenceMs = silence;
      if (line.event === 'live_terminal') terminal = `${name(line.record.state) ?? 'unknown'}/${name(line.record.code) ?? 'unknown'}`;
    }
    rows.push({ liveSessionId, start, durationMs: end - start, tools, maxSilenceMs, terminal, lines: lines.length });
  }
  return rows.sort((left, right) => right.start - left.start || left.liveSessionId.localeCompare(right.liveSessionId));
}

const seconds = (ms: number | null): string => ms === null ? '-' : `${(ms / 1000).toFixed(3)}s`;

export function renderCallStory(story: CallStory): string {
  const id = story.liveSessionId ?? story.callId ?? 'unknown';
  const head = `call ${id} start=${wall(story.startedAt)} dur=${story.durationMs ?? '-'}ms entries=${story.entries.length}` +
    ` joined-by-window=${story.joinedByWindow} skipped=${story.skipped} torn=${story.torn} files=${story.files} content=${story.content ? 'on' : 'off'}`;
  const body = story.entries.map(entry => `+${entry.at === null || story.startedAt === null ? '-' : entry.at - story.startedAt}ms ${entry.kind} ${entry.text}`);
  return `${[head, ...body].join('\n')}\n`;
}

export function renderLogHealth(health: LogHealth): string {
  const lines = [
    `logs files=${health.files.length} lines=${health.lines} torn=${health.torn} bytes=${health.bytes}` +
      ` oldest-day=${orDash(health.oldestDay)} newest-day=${orDash(health.newestDay)}`,
    ...health.files.map(file => `  ${file.file} ${file.stream} ${file.lines} lines ${file.torn} torn ${file.bytes} bytes ${orDash(file.oldestDay)}..${orDash(file.newestDay)}`),
    'top events:',
    ...health.topEvents.map(event => `  ${event.event} ${event.lines} ${(event.share * 100).toFixed(1)}%`),
    `unattributed ${health.unattributed.lines} of ${health.lines} lines (no liveSessionId, no callId)`,
    ...Object.entries(health.unattributed.streams).map(([stream, count]) => `  ${stream} ${count}`),
    ...health.unattributed.topEvents.map(event => `  ${event.event} ${event.lines}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderCallList(rows: readonly CallRow[]): string {
  const lines = ['session start dur tools silence terminal'];
  for (const row of rows) {
    lines.push(`${row.liveSessionId} ${wall(row.start)} ${seconds(row.durationMs)} ${row.tools} ${row.maxSilenceMs === null ? '-' : `${row.maxSilenceMs}ms`} ${row.terminal ?? '-'}`);
  }
  return `${lines.join('\n')}\n`;
}
