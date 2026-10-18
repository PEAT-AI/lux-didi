import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';
import { TraceRecordError, pruneTraceContent, record, recordCallResult, recordUtterance, type RecordResult } from '../trace/record.js';
import { IngestReject, PLAYBACK_RECEIPT_MAX_BYTES, parsePlaybackReceipt, recordPlaybackReceipt } from '../trace/ingest.js';
import { buildTimeline, exportMetadata, missingNativeRanges, renderTimeline, resolveSession, type TraceRead } from '../trace/timeline.js';

const SESSION = 'ls-fixture-1';
const T0 = 1_700_000_000_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readOf = (store: Store): TraceRead => ({
  all: (sql, params) => store.transaction(tx => tx.all(sql, params)),
  get: (sql, params) => store.transaction(tx => tx.get(sql, params)),
});

function withStore(body: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  const store = new Store(dir, []);
  try { body(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function counts(store: Store): Record<string, number> {
  const out: Record<string, number> = {};
  return store.transaction(tx => {
    for (const table of ['trace_turn', 'trace_response', 'trace_call', 'trace_playback', 'trace_event', 'trace_utterance', 'trace_call_result']) {
      out[table] = Number(tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    }
    return out;
  });
}

function openTurn(store: Store, turnId: string, turnIndex: number, at: number): void {
  record(store, 'turn.opened', { liveSessionId: SESSION, turnId }, { origin: 'owner', turnIndex, openedAt: at, monoMs: turnIndex * 1_000 });
}

function completedResponse(store: Store, responseKey: string, turnId: string, at: number): void {
  record(store, 'response.created', { liveSessionId: SESSION, turnId, responseKey },
    { createdAt: at, status: 'completed', providerResponseId: `resp-${responseKey}` });
}

function reply(store: Store, playbackKey: string, turnId: string, responseKey: string, at: number, drainAfter: number | null): void {
  record(store, 'playback.received', { liveSessionId: SESSION, turnId, responseKey, playbackKey }, { segmentSeq: 0, receivedAt: at });
  record(store, 'playback.audible', { liveSessionId: SESSION, turnId, playbackKey }, { audibleAt: at + 10 });
  record(store, 'playback.started', { liveSessionId: SESSION, turnId, playbackKey }, { startedAt: at + 20 });
  if (drainAfter !== null) record(store, 'playback.drained', { liveSessionId: SESSION, turnId, playbackKey }, { drainedAt: drainAfter });
}

test('a turn opened while the previous answer is still playing stays its own open turn', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0 + 1_000);
    completedResponse(store, 'r1', 't1', T0 + 1_100);
    reply(store, 'p1', 't1', 'r1', T0 + 1_200, null);
    openTurn(store, 't2', 2, T0 + 1_300);

    const report = buildTimeline(readOf(store), SESSION);
    assert.equal(report.turns.length, 2);
    const [first, second] = report.turns;
    assert.equal(first!.turn.closedAt, null, 'the playing turn is not closed by the next turn opening');
    assert.equal(first!.turn.origin, 'owner');
    assert.equal(first!.playback.length, 1);
    assert.equal(first!.playback[0]!.turnId, 't1', 'playback is not reparented onto the newer turn');
    assert.deepEqual(second!.responses, []);
    assert.deepEqual(report.gaps.map(gap => `${gap.turnIndex}:${gap.obligation}`), ['1:no_playback_drain']);
  });
});

test('two parallel calls settle in reverse order and share one continuation', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    for (const [callKey, name, intent] of [['c1', 'calendar_window', T0 + 110], ['c2', 'search_knowledge', T0 + 120]] as const) {
      record(store, 'call.intent', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1', callKey }, { name, argsChars: 12, intentAt: intent });
      record(store, 'call.executed', { liveSessionId: SESSION, callKey }, { executedAt: intent + 5 });
      record(store, 'call.output_prepared', { liveSessionId: SESSION, callKey }, { outputPreparedAt: intent + 9 });
    }
    record(store, 'call.output_written', { liveSessionId: SESSION, callKey: 'c2' }, { outputWrittenAt: T0 + 400, outcome: 'completed', ms: 280, resultChars: 120 });
    record(store, 'call.output_written', { liveSessionId: SESSION, callKey: 'c1' }, { outputWrittenAt: T0 + 500, outcome: 'completed', ms: 390, resultChars: 64 });
    record(store, 'response.created', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r2' },
      { createdAt: T0 + 600, status: 'pending', continuationOfResponseKey: 'r1' });
    reply(store, 'p1', 't1', 'r1', T0 + 700, T0 + 1_500);

    const report = buildTimeline(readOf(store), SESSION);
    const calls = report.turns[0]!.calls;
    assert.deepEqual(calls.map(call => call.callKey), ['c1', 'c2'], 'report order is intent order, not answer order');
    assert.deepEqual(calls.map(call => call.outputWrittenAt), [T0 + 500, T0 + 400], 'reverse completion is preserved');
    assert.equal(report.turns[0]!.responses[1]!.continuationOfResponseKey, 'r1');
    assert.equal(report.gaps.some(gap => gap.obligation === 'no_continuation_decision'), false);
    assert.equal(report.gaps.some(gap => gap.obligation === 'no_response'), true, 'the continuation itself still owes a provider receipt');
  });
});

test('a reconnect changes the connection epoch and stale ids are rejected', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    record(store, 'response.created', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1', connectionEpoch: 'epoch-1' }, { createdAt: T0 + 100 });
    assert.throws(
      () => record(store, 'response.observed', { liveSessionId: SESSION, responseKey: 'r1', connectionEpoch: 'epoch-2' }, { observedAt: T0 + 200, providerResponseId: 'prov-1' }),
      (error: unknown) => error instanceof TraceRecordError && error.code === 'STALE_EPOCH');
    record(store, 'response.observed', { liveSessionId: SESSION, responseKey: 'r1', connectionEpoch: 'epoch-1' }, { observedAt: T0 + 200, providerResponseId: 'prov-1' });
    record(store, 'call.intent', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1', callKey: 'c1', connectionEpoch: 'epoch-1' }, { name: 'calendar_window', argsChars: 4, intentAt: T0 + 300 });
    assert.throws(
      () => record(store, 'call.executed', { liveSessionId: SESSION, callKey: 'c1', connectionEpoch: 'epoch-2' }, { executedAt: T0 + 400 }),
      (error: unknown) => error instanceof TraceRecordError && error.code === 'STALE_EPOCH');
    record(store, 'call.executed', { liveSessionId: SESSION, callKey: 'c1', connectionEpoch: 'epoch-1' }, { executedAt: T0 + 400 });
    const report = buildTimeline(readOf(store), SESSION);
    assert.equal(report.turns[0]!.responses[0]!.providerResponseId, 'prov-1');
    assert.equal(report.turns[0]!.calls[0]!.executedAt, T0 + 400);
  });
});

test('an interrupted playback is terminated work, not a stall', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    reply(store, 'p1', 't1', 'r1', T0 + 200, null);
    record(store, 'playback.interrupted', { liveSessionId: SESSION, turnId: 't1', playbackKey: 'p1' }, { interruptedAt: T0 + 900, terminationReason: 'interrupted' });
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't1' }, { closedAt: T0 + 950, closeReason: 'interrupted' });

    const report = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(report.gaps, [], 'interrupted work owes nothing');
    assert.equal(report.turns[0]!.playback[0]!.terminationReason, 'interrupted');
    assert.equal(report.turns[0]!.turn.closeReason, 'interrupted');
  });
});

test('a stall with no delegation prints a typed GAP and the receipt that would close it', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    record(store, 'response.created', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1' }, { createdAt: T0 + 100 });

    const report = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(report.gaps.map(gap => [gap.obligation, gap.expectedReceipt]), [['no_delegation', 'provider.response_id or delegation_id']]);
    const text = renderTimeline({ ...report, capturedAt: T0 + 5_000 });
    assert.match(text, /GAP turn 1 obligation=no_delegation expected=provider\.response_id or delegation_id response=r1/);
    assert.doesNotMatch(text, /stall/i);
  });
});

test('a duplicate native receipt is deduplicated on (source_instance_id, source_seq)', () => {
  withStore(store => {
    const native = { liveSessionId: SESSION, turnId: 't1', playbackKey: 'p1', source: 'native', sourceInstanceId: 'inst-1', sourceSeq: 1, at: T0 + 100, monoMs: 40 } as const;
    const first = record(store, 'playback.received', native, { segmentSeq: 0, receivedAt: T0 + 110 });
    const replay = record(store, 'playback.received', native, { segmentSeq: 0, receivedAt: T0 + 120 });
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.seq, first.seq);
    assert.equal(counts(store).trace_event, 1);
    assert.throws(
      () => record(store, 'playback.received', { liveSessionId: SESSION, playbackKey: 'p2', source: 'native', sourceInstanceId: 'inst-1' }, { segmentSeq: 1, receivedAt: T0 }),
      (error: unknown) => error instanceof TraceRecordError && error.code === 'MISSING_FIELD');
    assert.throws(
      () => record(store, 'playback.received', { liveSessionId: SESSION, playbackKey: 'p3', source: 'native', sourceInstanceId: 'inst-1', sourceSeq: 3 }, { segmentSeq: 2, receivedAt: T0 }),
      (error: unknown) => error instanceof TraceRecordError && error.code === 'MISSING_FIELD', 'a native receipt without its own clock is refused');
  });
});

test('a missing native sequence range is reported, never filled', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    for (const seq of [1, 2, 4]) {
      record(store, 'playback.received',
        { liveSessionId: SESSION, turnId: 't1', playbackKey: `p${seq}`, source: 'native', sourceInstanceId: 'inst-1', sourceSeq: seq, at: T0 + seq, monoMs: seq },
        { segmentSeq: seq, receivedAt: T0 + seq });
    }
    assert.deepEqual(missingNativeRanges(readOf(store), SESSION), [{ sourceInstanceId: 'inst-1', fromSeq: 3, toSeq: 3 }]);
    const report = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(report.nativeGaps, [{ sourceInstanceId: 'inst-1', fromSeq: 3, toSeq: 3 }]);
    assert.match(renderTimeline(report), /NATIVE-GAP instance=inst-1 missing=3\.\.3/);
  });
});

test('every metadata entry point rejects injected text', () => {
  withStore(store => {
    const cases: (() => unknown)[] = [
      () => record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 'turn one says hello' }, { origin: 'owner', turnIndex: 1, openedAt: T0, monoMs: 1 }),
      () => record(store, 'turn.opened', { liveSessionId: 'ls one', turnId: 't1' }, { origin: 'owner', turnIndex: 1, openedAt: T0, monoMs: 1 }),
      () => record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't1' }, { origin: 'the owner said hello' as never, turnIndex: 1, openedAt: T0, monoMs: 1 }),
      () => record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't1' }, { origin: 'owner', turnIndex: 1, openedAt: T0, monoMs: 1, transcript: 'hello' } as never),
      () => record(store, 'turn.summary', { liveSessionId: SESSION, turnId: 't1', note: 'hello there' } as never, {}),
      () => record(store, 'playback.received', { liveSessionId: SESSION, playbackKey: 'p1', source: 'native', sourceInstanceId: 'inst 1 has words', sourceSeq: 1 }, { segmentSeq: 0, receivedAt: T0 }),
      () => record(store, 'call.intent', { liveSessionId: SESSION, callKey: 'c1' }, { name: 'search the web for cats', argsChars: 4, intentAt: T0 }),
      () => record(store, 'response.created', { liveSessionId: SESSION, responseKey: 'r1' }, { createdAt: T0, providerResponseId: 'resp with prose' }),
      () => record(store, 'response.terminal', { liveSessionId: SESSION, responseKey: 'r1' }, { terminalAt: T0, status: 'completed', terminalReason: 'it just stopped' as never }),
      () => record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't1' }, { origin: 'owner', turnIndex: -1, openedAt: T0, monoMs: 1 }),
    ];
    for (const [index, body] of cases.entries()) {
      assert.throws(body, (error: unknown) => error instanceof TraceRecordError, `case ${index} must be refused`);
    }
    assert.equal(counts(store).trace_turn, 0);
    assert.equal(counts(store).trace_event, 0);
  });
});

test('the JSON timeline carries no owner text unless --content asks for it', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    recordUtterance(store, { turnId: 't1', role: 'owner', at: T0 + 100, final: true, text: 'SECRET-OWNER-WORDS-ONLY-HERE' });
    record(store, 'call.intent', { liveSessionId: SESSION, turnId: 't1', callKey: 'c1' }, { name: 'calendar_window', argsChars: 3, intentAt: T0 + 200 });
    recordCallResult(store, { callKey: 'c1', text: 'SECRET-RESULT-TEXT-ONLY-HERE' });

    const bare = JSON.stringify(buildTimeline(readOf(store), SESSION));
    assert.ok(!bare.includes('SECRET-OWNER-WORDS'), 'no owner text in the default JSON');
    assert.ok(!bare.includes('SECRET-RESULT'), 'no result text in the default JSON');
    const withContent = JSON.stringify(buildTimeline(readOf(store), SESSION, { content: true }));
    assert.ok(withContent.includes('SECRET-OWNER-WORDS'), 'content is present only when asked');
  });
});

test('the 31-day prune removes trace content and keeps every metadata row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  const now = Date.now();
  const old = now - 31 * 86_400_000;
  const recent = now - 3_600_000;
  try {
    const first = new Store(dir, []);
    openTurn(first, 't-old', 1, old);
    record(first, 'call.intent', { liveSessionId: SESSION, turnId: 't-old', callKey: 'c-old' }, { name: 'calendar_window', argsChars: 3, intentAt: old + 5 });
    recordUtterance(first, { turnId: 't-old', role: 'owner', at: old + 10, final: true, text: 'old transcript' });
    recordCallResult(first, { callKey: 'c-old', text: 'old result' });
    openTurn(first, 't-new', 2, recent);
    recordUtterance(first, { turnId: 't-new', role: 'owner', at: recent + 10, final: true, text: 'fresh transcript' });
    assert.deepEqual(counts(first), { trace_turn: 2, trace_response: 0, trace_call: 1, trace_playback: 0, trace_event: 3, trace_utterance: 2, trace_call_result: 1 });
    first.close();

    const reopened = new Store(dir, []);
    assert.deepEqual(counts(reopened), { trace_turn: 2, trace_response: 0, trace_call: 1, trace_playback: 0, trace_event: 3, trace_utterance: 1, trace_call_result: 0 });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneTraceContent is scoped to the two content tables', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    record(store, 'call.intent', { liveSessionId: SESSION, turnId: 't1', callKey: 'c1' }, { name: 'calendar_window', argsChars: 3, intentAt: T0 + 5 });
    recordUtterance(store, { turnId: 't1', role: 'model', at: T0, final: true, text: 'hello' });
    recordCallResult(store, { callKey: 'c1', text: 'r'.repeat(20_000) });
    const pruned = store.transaction(tx => pruneTraceContent(tx, T0 + 40 * 86_400_000));
    assert.deepEqual(pruned, { utterances: 1, callResults: 1 });
    assert.equal(counts(store).trace_turn, 1);
    assert.equal(counts(store).trace_call, 1);
  });
});

test('scripts/didi-timeline reads SQL only and prints the timeline and the metadata export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  try {
    const store = new Store(dir, []);
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    reply(store, 'p1', 't1', 'r1', T0 + 200, T0 + 900);
    recordUtterance(store, { turnId: 't1', role: 'model', at: T0 + 250, final: true, text: 'SECRET-OWNER-WORDS' });
    store.close();

    const script = join(repoRoot, 'scripts', 'didi-timeline');
    const json = JSON.parse(execFileSync(process.execPath, [script, 'latest', '--data-dir', dir, '--json'], { encoding: 'utf8' }));
    assert.equal(json.liveSessionId, SESSION);
    assert.equal(json.turns.length, 1);
    assert.equal(json.turns[0].playback[0].playbackKey, 'p1');
    assert.ok(!JSON.stringify(json).includes('SECRET-OWNER-WORDS'), 'the default JSON has no owner text');

    const text = execFileSync(process.execPath, [script, 'latest', '--data-dir', dir], { encoding: 'utf8' });
    assert.match(text, /turn 1 \(t1\) origin=owner/);
    assert.ok(!text.includes('SECRET-OWNER-WORDS'));

    const withContent = execFileSync(process.execPath, [script, 'latest', '--data-dir', dir, '--content'], { encoding: 'utf8' });
    assert.ok(withContent.includes('SECRET-OWNER-WORDS'), '--content is the one way to see text');

    const turnOne = execFileSync(process.execPath, [script, 'latest', '--data-dir', dir, '--turn', '1'], { encoding: 'utf8' });
    assert.match(turnOne, /^turn 1 \(t1\)/m);
    const noTurn = JSON.parse(execFileSync(process.execPath, [script, 'latest', '--data-dir', dir, '--turn', '9', '--json'], { encoding: 'utf8' }));
    assert.deepEqual(noTurn.turns, [], '--turn selects one index and prints nothing else');
    assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /--export-metadata/);

    const exported = JSON.parse(execFileSync(process.execPath, [script, '--export-metadata', '--data-dir', dir], { encoding: 'utf8' }));
    assert.deepEqual(Object.keys(exported).sort(), ['trace_call', 'trace_event', 'trace_playback', 'trace_response', 'trace_turn']);
    assert.ok(!JSON.stringify(exported).includes('SECRET-OWNER-WORDS'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSession answers latest from the trace tables', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    assert.equal(resolveSession(readOf(store), 'latest'), SESSION);
    assert.equal(resolveSession(readOf(store), SESSION), SESSION);
  });
});

test('exportMetadata selects named columns only', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    recordUtterance(store, { turnId: 't1', role: 'owner', at: T0 + 1, final: true, text: 'text' });
    const exported = exportMetadata(readOf(store), SESSION);
    assert.deepEqual(Object.keys(exported.trace_turn![0]!).sort(), [
      'attribution_uncertain', 'close_reason', 'closed_at', 'first_audible_at', 'live_session_id', 'mono_ms',
      'opened_at', 'origin', 'outcome', 'playback_drained_at', 'stall_reason', 'supersedes_turn_id', 'turn_id', 'turn_index',
    ]);
    assert.equal(exported.trace_utterance, undefined);
  });
});

// O1b-N: the app's playback receipts, forwarded over the live socket. The frames here are the
// exact closed shapes the Swift side sends; nothing in this test is owner content.
const INSTANCE = 'inst-a1';
const frame = (receipt: string, seq: number, wallMs: number, extra: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'playback_receipt', receipt, segment_seq: 1, source_instance_id: INSTANCE, source_seq: seq,
  mono_ms: 1_000 + seq, wall_ms: wallMs, ...extra,
});
const forward = (store: Store, raw: string, attribution?: { turnId: string; responseKey: string }): RecordResult =>
  recordPlaybackReceipt(store, SESSION, parsePlaybackReceipt(raw), attribution);

test('a forwarded receipt sequence records native events and the playback row', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    for (const [receipt, seq] of [['received', 1], ['enqueued', 2], ['started', 3], ['drained', 4]] as const) {
      assert.equal(forward(store, frame(receipt, seq, T0 + 200 + seq), { turnId: 't1', responseKey: 'r1' }).duplicate, false);
    }
    const events = store.transaction(tx => tx.all('SELECT kind, source, source_instance_id, source_seq, at, mono_ms, turn_id, playback_key FROM trace_event ORDER BY seq'));
    assert.deepEqual(events.map(row => row['kind']), ['playback.received', 'playback.enqueued', 'playback.started', 'playback.drained']);
    assert.ok(events.every(row => row['source'] === 'native'), 'every forward is a native event');
    assert.deepEqual(events.map(row => row['source_seq']), [1, 2, 3, 4]);
    assert.equal(events[3]!['at'], T0 + 204, 'the producer wall ms is stored as sent, never replaced by the host clock');
    assert.equal(events[3]!['mono_ms'], 1_004);
    const row = store.transaction(tx => tx.get('SELECT * FROM trace_playback WHERE playback_key=?', [`${INSTANCE}:1`]))!;
    assert.equal(row['received_at'], T0 + 201);
    assert.equal(row['enqueued_at'], T0 + 202);
    assert.equal(row['started_at'], T0 + 203);
    assert.equal(row['drained_at'], T0 + 204);
    assert.equal(row['turn_id'], 't1');
  });
});

test('a duplicate receipt frame is deduped, not recorded twice', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    const raw = frame('received', 7, T0 + 10);
    assert.equal(forward(store, raw).duplicate, false);
    const replay = forward(store, raw);
    assert.equal(replay.duplicate, true);
    assert.equal(counts(store)['trace_event'], 1);
    assert.equal(counts(store)['trace_playback'], 1);
    // A drained receipt for the same segment is not a replay: it is the next receipt in order.
    assert.equal(forward(store, frame('drained', 8, T0 + 90)).duplicate, false);
    assert.equal(counts(store)['trace_event'], 2);
  });
});

test('a frame with an unknown or free-text field is refused by a typed code', () => {
  const base = { type: 'playback_receipt', receipt: 'drained', segment_seq: 1, source_instance_id: INSTANCE, source_seq: 1, mono_ms: 1, wall_ms: 2 };
  for (const [label, raw, code] of [
    ['free text', { ...base, note: 'the owner said something' }, 'unknown_field'],
    ['unknown receipt', { ...base, receipt: 'audible' }, 'unknown_receipt'],
    ['string count', { ...base, source_seq: '1' }, 'invalid_field'],
    ['missing clock', { ...base, wall_ms: undefined, mono_ms: undefined }, 'missing_field'],
  ] as const) {
    assert.throws(() => parsePlaybackReceipt(JSON.stringify(raw)),
      (error: unknown) => error instanceof IngestReject && error.code === code, label);
  }
  assert.throws(() => parsePlaybackReceipt('x'.repeat(PLAYBACK_RECEIPT_MAX_BYTES + 1)),
    (error: unknown) => error instanceof IngestReject && error.code === 'frame_too_large');
  // A refused frame writes nothing at all.
  withStore(store => assert.throws(() => forward(store, JSON.stringify({ ...base, note: 'x' }))));
});

test('a missing sequence range is reported by the timeline reader', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    forward(store, frame('received', 1, T0 + 10));
    forward(store, frame('started', 4, T0 + 20));
    assert.deepEqual(buildTimeline(readOf(store), SESSION).nativeGaps, [{ sourceInstanceId: INSTANCE, fromSeq: 2, toSeq: 3 }]);
  });
});

test('the timeline prints a drained playback inside its turn when attributable and outside when not', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    for (const [receipt, seq] of [['received', 1], ['started', 2], ['drained', 3]] as const) {
      forward(store, frame(receipt, seq, T0 + 200 + seq), { turnId: 't1', responseKey: 'r1' });
    }
    const report = buildTimeline(readOf(store), SESSION);
    assert.equal(report.turns[0]!.playback.length, 1);
    assert.deepEqual(report.unattributedPlayback, []);
    const rendered = renderTimeline(report);
    assert.match(rendered, /\n {2}playback inst-a1:1 segment=1 .*drained=.*clock=approx/);
    assert.doesNotMatch(rendered, /turn=none/);
  });
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    forward(store, frame('received', 1, T0 + 10));
    forward(store, frame('drained', 2, T0 + 20));
    const report = buildTimeline(readOf(store), SESSION);
    assert.equal(report.turns[0]!.playback.length, 0);
    assert.equal(report.unattributedPlayback.length, 1);
    const rendered = renderTimeline(report);
    assert.match(rendered, /^playback inst-a1:1 segment=1 .*turn=none/m);
    assert.equal(report.gaps, [], 'an orphan segment is not a stall: it is printed outside the turns');
  });
});
