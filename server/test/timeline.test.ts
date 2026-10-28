// The two log-backed views (call, doctor) and the list row, over logs in today's shape.
// Fixture: server/test/fixtures/timeline-call.json. Every value in it is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { record } from '../trace/record.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CALL_AUDIT_SCHEMA_VERSION, buildAuditSummary, buildCallAudit, buildCallStory, buildTimeline, listCalls, logHealth,
  renderCallAudit, renderCallList, renderCallStory, renderLogHealth, scanLogs,
  type CallAudit, type LogInput, type LogStream, type TimelineReport, type TraceRead,
} from '../trace/timeline.js';

interface FixtureFile { file: string; stream: LogStream; text: string[] }
interface TimelineFixture { liveSessionId: string; otherSessionId: string; pid: number; files: FixtureFile[] }
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/timeline-call.json', import.meta.url), 'utf8')) as TimelineFixture;
// The fixture keeps one array per file so a torn line is visible in the diff; the reader takes file text.
const scan = () => scanLogs(fixture.files.map((file): LogInput => ({ file: file.file, stream: file.stream, text: file.text.join('\n') })));

/** The store half of one call: one owner turn, one tool call of that turn, one answered response. */
function report(): TimelineReport {
  return {
    liveSessionId: fixture.liveSessionId,
    capturedAt: 1792486800000,
    callFailures: { count: 0, kinds: {} },
    blockedCalls: 0,
    contentAccess: { state: 'allowed', dataClass: 'ordinary', revision: 1 },
    gaps: [], nativeGaps: [], unattributedPlayback: [], unattributedCalls: [], unattributedResponses: [],
    turns: [{
      turn: {
        turnId: 'turn_1', turnIndex: 1, origin: 'owner', supersedesTurnId: null, openedAt: 1792486799800, monoMs: 100,
        closedAt: 1792486809500, closeReason: 'completed', firstAudibleAt: 1792486800900, playbackDrainedAt: null,
        outcome: 'answered', stallReason: null, attributionUncertain: false,
      },
      responses: [{
        responseKey: 'resp_1', providerResponseId: null, delegationId: null, turnId: 'turn_1', status: 'completed',
        createdAt: 1792486801200, terminalAt: 1792486809000, terminalReason: 'completed', continuationOfResponseKey: null,
      }],
      calls: [{
        callKey: 'call_1', responseKey: 'resp_1', turnId: 'turn_1', name: 'calendar', argsChars: 12,
        intentAt: 1792486802050, executedAt: null, outputPreparedAt: null, outputWrittenAt: null,
        outcome: 'completed', ms: 412, resultChars: 30, continuationAt: null, continuationOutcome: null,
      }],
      playback: [],
      utterances: [{ role: 'owner', at: 1792486800500, final: true, text: 'move my two oclock' }],
    }],
  };
}

test('scan counts every line and every torn line (#1026)', () => {
  const scanned = scan();
  assert.deepEqual(scanned.files.map(f => [f.file, f.lines, f.torn]), [
    ['logs/host.log.1', 1, 0], ['logs/host.log', 11, 1], ['logs/native-live.log', 4, 0], ['logs/audio.log', 3, 1],
  ]);
  assert.equal(scanned.torn, 2);
  assert.equal(scanned.lines.length, 19);
});

test('call view orders the four streams and marks what joined by window (#1026)', () => {
  const story = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId });
  // The pid guard: a foreign pid inside the window, and this pid outside it, are both absent.
  assert.equal(story.entries.some(e => e.text.includes('99000')), false);
  assert.equal(story.entries.some(e => e.text.includes('42000')), false);
  assert.deepEqual(story.entries.map(e => e.text), [
    'turn 1 opened origin=owner',
    'live_state state=listening from=speaking cause=silence',
    'audio_owned',
    'owner utterance at=1792486800500 final',
    'first model audio',
    'live_first_audio msSinceReady=812 msSinceOpen=1904',
    'response resp_1 status=completed',
    'live_interrupted reason=owner_spoke',
    'tool calendar ms=412',
    'tool calendar outcome=completed ms=412',
    'tool_output_sent outcome=sent tools=1 msSinceArrived=418',
    'live_dead_air deadAirMs=1744',
    'research_joined researchId=res_7f sources=3',
    'playback_underrun queuedMs=180',
    'playback_underrun queuedMs=90',
    'connector_failure connector=calendar reason=token_expired endpointId=calendar',
    'live_terminal state=closed code=voice_stop',
    'live_end state=closed',
  ]);
  assert.deepEqual(story.entries.map(e => e.joinedBy), [
    'store', 'session', 'session', 'store', 'store', 'session', 'store', 'session', 'window', 'store',
    'session', 'window', 'window', 'window', 'window', 'session', 'window', 'window',
  ]);
  assert.equal(story.joinedByWindow, 7);
  assert.equal(story.skipped, 3); // live_idle_arm, orb_occlusion, playback_level
  assert.equal(story.torn, 2);
});

test('call view carries owner content only when asked (#1026)', () => {
  const quiet = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId });
  assert.equal(quiet.entries.some(e => e.text.includes('two oclock')), false);
  const loud = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId, content: true });
  assert.ok(loud.content);
  assert.ok(loud.entries.some(e => e.text === 'owner utterance at=1792486800500 final text="move my two oclock"'));
});

/** The store as `buildTimeline` leaves it: the research text is the one content table the view reads. */
const researchRead: TraceRead = {
  all: sql => sql.includes('trace_research_text')
    ? [{ at: 1792486804300, kind: 'question', research_id: 'res_7f', text: 'calendar next week' }]
    : [],
  get: () => undefined,
};

test('call --content prints the researched question, and only then (#1026)', () => {
  const quiet = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId, read: researchRead });
  assert.equal(quiet.entries.some(e => e.text.includes('calendar next week')), false);
  const loud = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId, content: true, read: researchRead });
  assert.ok(loud.entries.some(e => e.text === 'research question at=1792486804300 text="calendar next week"'));
  // The store's own gate decides, not the flag: a denied read stays denied even with --content.
  const denied = buildCallStory(scan(), { ...report(), contentAccess: { state: 'denied', reason: 'class_denied' } },
    { liveSessionId: fixture.liveSessionId, content: true, read: researchRead });
  assert.equal(denied.entries.some(e => e.text.includes('calendar next week')), false);
});

test('call view prefers callId when the envelope is there (#1026)', () => {
  const scanned = scanLogs([{
    file: 'logs/host.log', stream: 'host',
    text: [
      '{"timestamp":"2026-10-20T09:00:02.500Z","monoMs":2512,"pid":5010,"seq":42,"event":"live_tool_turn","callId":"call_9","liveSessionId":"sess-1","toolLatencyMs":[{"tool":"notes","ms":77}]}',
      '{"timestamp":"2026-10-20T09:00:03.000Z","monoMs":3012,"pid":5010,"seq":43,"event":"live_first_audio","callId":"call_9","liveSessionId":"sess-1"}',
      '{"timestamp":"2026-10-20T09:00:04.000Z","monoMs":4012,"pid":5010,"seq":44,"event":"live_first_audio","callId":"call_other","liveSessionId":"sess-1"}',
    ].join('\n'),
  }]);
  const story = buildCallStory(scanned, undefined, { callId: 'call_9' });
  assert.deepEqual(story.entries.map(e => [e.text, e.joinedBy]), [
    ['tool notes ms=77', 'call'],
    ['live_first_audio', 'call'],
  ]);
  assert.equal(story.callId, 'call_9');
});

test('a foreign callId never joins this call by window (L3-F4, #1026)', () => {
  const scanned = scanLogs([{
    file: 'logs/host.log', stream: 'host',
    text: [
      '{"timestamp":"2026-10-20T09:00:00.000Z","pid":5010,"event":"live_state","state":"listening","liveSessionId":"sess-1"}',
      '{"timestamp":"2026-10-20T09:00:02.000Z","pid":5010,"event":"live_dead_air","deadAirMs":55000,"callId":"call_foreign"}',
      '{"timestamp":"2026-10-20T09:00:03.000Z","pid":5010,"event":"live_dead_air","deadAirMs":1744,"callId":"call_mine","liveSessionId":"sess-1"}',
      '{"timestamp":"2026-10-20T09:00:04.000Z","pid":5010,"event":"live_dead_air","deadAirMs":33,"callId":"call_mine"}',
    ].join('\n'),
  }]);
  const story = buildCallStory(scanned, undefined, { liveSessionId: 'sess-1' });
  assert.deepEqual(story.entries.map(e => [e.text, e.joinedBy]), [
    ['live_state state=listening', 'session'],
    ['live_dead_air deadAirMs=1744', 'session'],
    ['live_dead_air deadAirMs=33', 'window'],
  ]);
});

test('doctor reports files, torn lines, days, top events and unattributed lines (#1026)', () => {
  const health = logHealth(scan());
  assert.equal(health.files.length, 4);
  assert.equal(health.lines, 19);
  assert.equal(health.torn, 2);
  assert.ok(health.bytes > 1000);
  assert.equal(health.oldestDay, '2026-10-19');
  assert.equal(health.newestDay, '2026-10-20');
  assert.deepEqual(health.topEvents.slice(0, 3).map(e => [e.event, e.lines]), [
    ['live_dead_air', 3], ['live_state', 2], ['playback_underrun', 2],
  ]);
  assert.equal(health.unattributed.lines, 10);
  assert.equal(health.unattributed.streams.host, 7);
  assert.equal(health.unattributed.streams.native, 2);
  assert.equal(health.unattributed.streams.audio, 1);
  const [loosest] = health.unattributed.topEvents;
  assert.ok(loosest);
  assert.equal(loosest.event, 'live_dead_air');
});

test('list view shows start, duration, tools, max silence and terminal (#1026)', () => {
  const rows = listCalls(scan());
  assert.equal(rows.length, 2);
  const [newest, older] = rows;
  assert.ok(newest && older);
  assert.deepEqual(newest, {
    liveSessionId: fixture.liveSessionId, start: 1792486800000, durationMs: 10400, tools: 1,
    maxSilenceMs: 1744, terminal: 'closed/voice_stop', lines: 16,
  });
  assert.equal(older.liveSessionId, fixture.otherSessionId);
  assert.equal(older.durationMs, 0);
  assert.equal(older.terminal, null);
});

test('the CLI discovers host.log, its rotated file and audio.log, and nothing else (L3-F3, #1026)', () => {
  const cli = fileURLToPath(new URL('../../../scripts/didi-timeline', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'didi-timeline-'));
  try {
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'host.log'), [
      '{"timestamp":"2026-10-20T09:00:00.000Z","pid":5010,"event":"live_state","state":"listening","liveSessionId":"sess-cli-1"}',
      '{"timestamp":"2026-10-20T09:00:09.000Z","pid":5010,"event":"live_terminal","state":"closed","code":"voice_stop","liveSessionId":"sess-cli-1"}',
    ].join('\n'));
    writeFileSync(join(dir, 'logs', 'host.log.1'), '{"timestamp":"2026-10-19T09:00:00.000Z","pid":4999,"event":"live_state","state":"listening","liveSessionId":"sess-cli-2"}');
    writeFileSync(join(dir, 'logs', 'audio.log'), '{"event":"audio_owned","timestamp":"2026-10-20T09:00:01.000Z","mono_ms":1,"source_instance_id":"orb","source_seq":2,"wall_ms":1792486801000,"liveSessionId":"sess-cli-1"}');
    writeFileSync(join(dir, 'logs', 'notes.txt'), '{"timestamp":"2026-10-20T09:00:02.000Z","pid":1,"event":"not_a_log"}');
    const doctor = execFileSync(process.execPath, [cli, 'doctor', '--data-dir', dir], { encoding: 'utf8' });
    assert.match(doctor, /^logs files=3 lines=4 torn=0 /);
    assert.match(doctor, /logs\/host\.log\.1 host 1 lines 0 torn/);
    assert.doesNotMatch(doctor, /notes\.txt/);
    const list = execFileSync(process.execPath, [cli, 'list', '--data-dir', dir], { encoding: 'utf8' });
    assert.match(list, /sess-cli-1 2026-10-20T09:00:00\.000Z 9\.000s/);
    assert.match(list, /sess-cli-2 2026-10-19T09:00:00\.000Z 0\.000s/);
    const call = execFileSync(process.execPath, [cli, 'call', 'sess-cli-1', '--data-dir', dir], { encoding: 'utf8' });
    assert.match(call, /^call sess-cli-1 start=2026-10-20T09:00:00\.000Z dur=9000ms entries=3/);
    const store = spawnSync(process.execPath, [cli, 'latest', '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(store.status, 2);
    assert.match(store.stderr, /no state\.sqlite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the three renders are metadata only and greppable (#1026)', () => {
  const story = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId });
  const text = renderCallStory(story);
  assert.match(text, /^call 3f2c8a10-0000-4a1a-9d1e-0000000000a1 /);
  assert.match(text, /joined-by-window=7/);
  assert.match(text, /\n\+\d+ms connector connector_failure connector=calendar reason=token_expired endpointId=calendar/);
  assert.equal(text.includes('two oclock'), false);
  const health = renderLogHealth(logHealth(scan()));
  assert.match(health, /torn=2/);
  assert.match(health, /logs\/audio\.log audio 3 lines 1 torn/);
  assert.match(renderCallList(listCalls(scan())), /closed\/voice_stop/);
});

//
// C-LOGS11: one command answers "what happened in that call". The audit joins the store's calls and turns to
// the host log's turn and call keys. Every value below is invented.

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
