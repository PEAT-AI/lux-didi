// C-LOGS11: one command answers "what happened in that call". Every value here is invented, and the
// fixtures are the two sources the audit joins: a synthetic trace store and a synthetic host log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { record } from '../trace/record.js';
import {
  CALL_AUDIT_SCHEMA_VERSION, buildAuditSummary, buildCallAudit, buildTimeline, renderCallAudit, scanLogs,
  type CallAudit, type LogInput, type TraceRead,
} from '../trace/timeline.js';

const SESSION = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444';
const T0 = 1_792_486_800_000;
const REFUSED = 'call:refused';
const SLOW = 'call:slow';
const OK = 'call:ok';

const readOf = (store: Store): TraceRead => ({
  all: (sql, params) => store.transaction(tx => tx.all(sql, params)),
  get: (sql, params) => store.transaction(tx => tx.get(sql, params)),
});

function withStore(body: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'didi-audit-'));
  const store = new Store(dir, []);
  try { body(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function turn(store: Store, session: string, turnId: string, index: number, openedAt: number): void {
  record(store, 'turn.opened', { liveSessionId: session, turnId }, { origin: 'owner', turnIndex: index, openedAt, monoMs: index * 1_000 });
}

function call(store: Store, session: string, turnId: string, callKey: string, name: string, outcome: 'completed' | 'refused', ms: number, at: number): void {
  record(store, 'call.intent', { liveSessionId: session, turnId, callKey }, { name, argsChars: 24, intentAt: at });
  record(store, 'call.executed', { liveSessionId: session, turnId, callKey }, { executedAt: at + 1 });
  record(store, 'call.output_written', { liveSessionId: session, turnId, callKey }, { outputWrittenAt: at + ms, outcome, ms, resultChars: 8 });
}

function audible(store: Store, session: string, turnId: string, playbackKey: string, at: number): void {
  record(store, 'playback.received', { liveSessionId: session, turnId, playbackKey }, { segmentSeq: 0, receivedAt: at });
  record(store, 'playback.audible', { liveSessionId: session, turnId, playbackKey }, { audibleAt: at + 120 });
}

/** One host.log line in the envelope's shape: ids, closed codes and counts, and nothing an owner said. */
const line = (at: number, event: string, fields: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), monoMs: 0, pid: 1, seq: 1, level: 'info', ...fields, event });

const scanOf = (lines: readonly string[]) => scanLogs([{ file: 'logs/host.log', stream: 'host', text: lines.join('\n') }] as LogInput[]);

/** Session A: three tool calls in one owner turn (refused, slow, ok), one turn with a split owner final, one with none. */
function storeA(store: Store): void {
  turn(store, SESSION, 't1', 1, T0);
  call(store, SESSION, 't1', REFUSED, 'gmail_search_messages', 'refused', 12, T0 + 1_000);
  call(store, SESSION, 't1', SLOW, 'research', 'completed', 6_100, T0 + 2_000);
  call(store, SESSION, 't1', OK, 'calendar_list_events', 'completed', 40, T0 + 9_000);
  bright(store, SESSION, 't1');
  turn(store, SESSION, 't2', 2, T0 + 20_000);
}

function bright(store: Store, session: string, turnId: string): void {
  audible(store, session, turnId, 'play:1', T0 + 3_000);
}

function logsA(): string[] {
  const session = { liveSessionId: SESSION };
  return [
    line(T0, 'clock_sync', { ...session, turnId: null, reason: 'call_open' }),
    // A split utterance: two finals, one finalized turn, and the last fragment is the anchor.
    line(T0 + 500, 'owner_final', { ...session, turnId: 't1', ownerFinalAt: T0 + 500 }),
    line(T0 + 800, 'owner_final', { ...session, turnId: 't1', ownerFinalAt: T0 + 800 }),
    line(T0 + 2_500, 'live_first_audio', { ...session, turnId: 't1', msSinceReady: 10, msSinceOpen: 20, finalToProviderFirstAudioMs: 1_700, missingReason: null }),
    line(T0 + 1_000, 'tool_call_admitted', { ...session, turnId: 't1', callKey: REFUSED, tool: 'gmail_search_messages' }),
    line(T0 + 1_000, 'tool_call_dispatched', { ...session, turnId: 't1', callKey: REFUSED, tool: 'gmail_search_messages' }),
    line(T0 + 1_012, 'tool_call_outcome', { ...session, turnId: 't1', callKey: REFUSED, tool: 'gmail_search_messages', outcome: 'refused', ms: 12, refusalCode: 'grant_not_permitted' }),
    line(T0 + 8_100, 'tool_call_outcome', { ...session, turnId: 't1', callKey: SLOW, tool: 'research', outcome: 'completed', ms: 6_100 }),
    line(T0 + 9_040, 'tool_call_outcome', { ...session, turnId: 't1', callKey: OK, tool: 'calendar_list_events', outcome: 'completed', ms: 40 }),
    line(T0 + 9_500, 'live_claim_without_call', { ...session, sequence: 3, ms: 900 }),
    line(T0 + 10_000, 'live_dead_air', { ...session, turnId: 't1', deadAirMs: 4_200 }),
    line(T0 + 21_000, 'live_dead_air', { ...session, turnId: 't2', deadAirMs: 4_600 }),
    // Session B sits in the same file and must never join session A's rows.
    line(T0 + 1_000, 'owner_final', { liveSessionId: OTHER, turnId: 'b1', ownerFinalAt: T0 + 1_000 }),
  ];
}

function auditA(store: Store): CallAudit {
  return buildCallAudit(buildTimeline(readOf(store), SESSION), scanOf(logsA()));
}

test('C-LOGS11: the audit names every tool call and every owner turn of one call', () => {
  withStore(store => {
    storeA(store);
    const audit = auditA(store);
    assert.equal(audit.version, CALL_AUDIT_SCHEMA_VERSION);
    assert.deepEqual(audit.calls.map(row => [row.turnId, row.callKey, row.name, row.totalMs, row.outcome, row.refusalCode]), [
      ['t1', REFUSED, 'gmail_search_messages', 12, 'refused', 'grant_not_permitted'],
      ['t1', SLOW, 'research', 6_100, 'completed', null],
      ['t1', OK, 'calendar_list_events', 40, 'completed', null],
    ]);
    // One row per owner turn: the split utterance still yields one ownerFinalAt, the last fragment.
    assert.deepEqual(audit.turns.map(row => [row.turnId, row.ownerFinalAt, row.providerFirstAudioAt, row.nativeFirstAudibleAt]), [
      ['t1', T0 + 800, T0 + 2_500, T0 + 3_120],
      ['t2', null, null, null],
    ]);
    assert.equal(audit.turns[0]!.finalToProviderMs, 1_700);
    assert.equal(audit.turns[0]!.finalToAudibleMs, T0 + 3_120 - (T0 + 800));
    assert.equal(audit.turns[1]!.missingReason, 'no_owner_final');
    assert.equal(audit.turns[1]!.finalToAudibleMs, null, 'a missing measurement is null, never zero');
  });
});

test('C-LOGS11: the audit aggregates name the slowest calls, the refusals and the waits', () => {
  withStore(store => {
    storeA(store);
    const audit = auditA(store);
    assert.deepEqual(audit.aggregates.slowestCalls.map(row => row.callKey), [SLOW, OK, REFUSED]);
    assert.deepEqual(audit.aggregates.refusalsByCode, { grant_not_permitted: 1 });
    assert.equal(audit.aggregates.claimsWithoutCall, 1);
    assert.equal(audit.aggregates.deadAirEvents, 2);
    // The fixture's own line is the only clock stamp in the scan, so a spread is not invented.
    assert.equal(audit.clock.syncs, 1);
    assert.equal(audit.clock.offsetSpreadMs, 0);
  });
});

test('C-LOGS11: a turn with no native receipt says so, and never prints a zero', () => {
  withStore(store => {
    turn(store, SESSION, 't1', 1, T0);
    const scan = scanOf([
      line(T0 + 400, 'owner_final', { liveSessionId: SESSION, turnId: 't1', ownerFinalAt: T0 + 400 }),
      line(T0 + 2_400, 'live_first_audio', { liveSessionId: SESSION, turnId: 't1', msSinceReady: 10, msSinceOpen: 20, finalToProviderFirstAudioMs: 2_000, missingReason: null }),
    ]);
    const audit = buildCallAudit(buildTimeline(readOf(store), SESSION), scan);
    const row = audit.turns[0]!;
    assert.equal(row.finalToProviderMs, 1_600);
    assert.equal(row.finalToAudibleMs, null);
    assert.equal(row.missingReason, 'no_native_receipt');
    const text = renderCallAudit(audit);
    assert.match(text, /finalToProvider finalToAudible missing/);
    assert.match(text, /t1 1792486800400 1792486802400 missing 2000ms missing no_native_receipt/);
  });
});

test('C-LOGS11: the audit JSON is a stable, versioned shape', () => {
  withStore(store => {
    storeA(store);
    const audit = auditA(store);
    const json = JSON.parse(JSON.stringify(audit)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ['aggregates', 'calls', 'clock', 'coverage', 'liveSessionId', 'turns', 'version']);
    assert.deepEqual(Object.keys(json['clock'] as object).sort(), ['firstAt', 'lastAt', 'offsetSpreadMs', 'syncs']);
    assert.deepEqual(Object.keys((json['calls'] as Record<string, unknown>[])[0]!).sort(),
      ['callKey', 'executionMs', 'name', 'outcome', 'refusalCode', 'totalMs', 'turnId']);
    assert.deepEqual(Object.keys((json['turns'] as Record<string, unknown>[])[0]!).sort(),
      ['finalToAudibleMs', 'finalToProviderMs', 'missingReason', 'nativeFirstAudibleAt', 'ownerFinalAt', 'providerFirstAudioAt', 'turnId']);
    assert.deepEqual(Object.keys(json['aggregates'] as object).sort(),
      ['claimsWithoutCall', 'deadAirEvents', 'refusalsByCode', 'slowestCalls', 'turnsOver4s']);
    assert.equal(json['version'], 1);
  });
});

test('C-LOGS11: no owner words, arguments or results reach an audit field', () => {
  withStore(store => {
    storeA(store);
    const text = JSON.stringify(auditA(store));
    for (const forbidden of ['bridge', 'Clifton', 'password', 'lunch', '@', 'synthetic system']) assert.equal(text.includes(forbidden), false, `audit carries ${forbidden}`);
  });
});

/** Session B in the same store, so the summary's p50/p90 spans two calls of the same tool. */
function storeB(store: Store): void {
  turn(store, OTHER, 'b1', 1, T0 + 60_000);
  call(store, OTHER, 'b1', 'call:b-ok', 'gmail_search_messages', 'completed', 60, T0 + 61_000);
  call(store, OTHER, 'b1', 'call:b-slow', 'gmail_search_messages', 'completed', 80, T0 + 62_000);
}

test('C-LOGS11: the across-sessions summary reports counts per tool and p50/p90 latency', () => {
  withStore(store => {
    storeA(store);
    storeB(store);
    const scan = scanOf([
      ...logsA(),
      line(T0 + 61_000, 'owner_final', { liveSessionId: OTHER, turnId: 'b1', ownerFinalAt: T0 + 61_000 }),
      line(T0 + 66_000, 'live_first_audio', { liveSessionId: OTHER, turnId: 'b1', msSinceReady: 10, msSinceOpen: 20, finalToProviderFirstAudioMs: 5_000, missingReason: null }),
    ]);
    const summary = buildAuditSummary(readOf(store), scan, T0 - 1);
    assert.equal(summary.version, CALL_AUDIT_SCHEMA_VERSION);
    assert.equal(summary.sessions, 2);
    assert.deepEqual(summary.callsPerTool, { 'calendar_list_events': 1, 'gmail_search_messages': 3, research: 1 });
    // Nearest rank over [12, 40, 60, 80, 6100]: p50 is the third value, p90 the fifth.
    assert.deepEqual(summary.latencyPerTool['gmail_search_messages'], { count: 3, p50: 60, p90: 6100 });
    assert.deepEqual(summary.latencyPerTool['research'], { count: 1, p50: 6100, p90: 6100 });
    assert.deepEqual(summary.refusalsByCode, { grant_not_permitted: 1 });
    // Both sessions' owner-final-to-audio waits: 1700 in session A, 5000 in session B.
    assert.deepEqual(summary.finalToAudio, { count: 2, p50: 1700, p90: 5000 });
  });
});

test('C-LOGS11: a summary with no session since the date is empty, not a zeroed average', () => {
  withStore(store => {
    storeA(store);
    const summary = buildAuditSummary(readOf(store), scanOf([]), T0 + 10_000_000);
    assert.equal(summary.sessions, 0);
    assert.deepEqual(summary.callsPerTool, {});
    assert.deepEqual(summary.finalToAudio, { count: 0, p50: null, p90: null });
  });
});
