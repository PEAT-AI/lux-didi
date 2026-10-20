import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';
import { traceMigrations } from '../trace/schema.js';
import { liveMigrations } from '../live/schema.js';
import { domainMigrations } from '../domain/schema.js';
import { liveTracePort, scopedTraceKey, TraceRecordError, pruneTraceContent, record, recordCallResult, recordUtterance, type RecordResult } from '../trace/record.js';
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
    assert.ok(!withContent.includes('SECRET-OWNER-WORDS'), 'legacy content without current source authority stays denied');
    assert.ok(withContent.includes('authority_required'));
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
    assert.deepEqual(pruned, { utterances: 1, callResults: 1, journalText: 0, promptSnapshots: 0 });
    assert.equal(counts(store).trace_turn, 1);
    assert.equal(counts(store).trace_call, 1);
  });
});

// Retention rule (lux 90269): content pruned at 30 days, metadata kept. A live session that ended
// before the cutoff keeps its row, its kind, its byte count and its outcome, and loses only the
// owner text: journal text, journal tool payload and the accepted prompt snapshot. The journal text
// of a session that has no summary yet is kept, because summaries.reconcile() still distils it.
test('pruneTraceContent clears live text only where the transcript is no longer needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  const day = 86_400_000, endedAt = T0 + 1 * day, liveAt = T0 + 31 * day, now = T0 + 60 * day;
  type Summary = { status: 'complete' | 'skipped' | 'failed'; skipReason?: string; errorCode?: string } | null;
  try {
    const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
    const seed = (id: string, terminalAt: number | null, at: number, summary: Summary, excluded = false): void => {
      store.transaction(tx => {
        tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
            client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events,
            journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, accepted_prompt_snapshot)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,0,0,'attached',?,?,?,?,?)`,
          [id, store.assistantId, store.authorityEpoch, `key-${id}`, `fp-${id}`, 'client', `audit-${id}`, 'profile', 'prompt',
            terminalAt === null ? 'active' : 'terminal', 3, terminalAt === null ? null : 'complete', terminalAt, at, at,
            JSON.stringify({ ownerText: `accepted words ${id}` })]);
        tx.run("INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?)",
          [id, 'inputTranscription', `owner words ${id}`, 1, 9, at]);
        // Marker rows: no owner speech, and their `text` is the marker itself, which must survive.
        tx.run("INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,NULL,1,0,?)",
          [id, 'ready', at]);
        tx.run("INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,4,?)",
          [id, 'remember_deferred', '1200', at]);
        tx.run("INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,44,?)",
          [id, 'continuity', JSON.stringify({ event: 'rebuilding', reason: 'stall' }), at]);
        tx.run("INSERT INTO live_journal (live_session_id, kind, text, finished, tool_json, payload_bytes, arrived_at) VALUES (?,?,NULL,1,?,0,?)",
          [id, 'toolCall', JSON.stringify({ name: 'search', args: { query: `owner words ${id}` } }), at]);
        if (summary) {
          tx.run(`INSERT INTO conversation_summaries (id, live_session_id, status, summary, ended_at, model, input_chars,
              input_truncated, injected_summary_ids, retry_count, error_code, created_at, skip_reason)
            VALUES (?,?,?,?,?,?,?,0,'[]',0,?,?,?)`,
            [`sum-${id}`, id, summary.status, summary.status === 'complete' ? 'a summary' : null, at, 'm', 10,
              summary.errorCode ?? null, at, summary.skipReason ?? null]);
        }
        if (excluded) tx.run("INSERT INTO history_exclusions (source_kind, source_id, forgotten_at) VALUES ('live',?,?)", [id, at]);
      });
    };
    seed('ls-summarised', endedAt, endedAt, { status: 'complete' });
    seed('ls-unsummarised', endedAt, endedAt, null);
    seed('ls-no-model', endedAt, endedAt, { status: 'skipped', skipReason: 'no_text_model' });
    seed('ls-deadline', endedAt, endedAt, { status: 'failed', errorCode: 'deadline' });
    seed('ls-gave-up', endedAt, endedAt, { status: 'failed', errorCode: 'model_error' });
    seed('ls-forgotten', endedAt, endedAt, null, true);
    seed('ls-live', null, liveAt, null);

    const pruned = store.transaction(tx => pruneTraceContent(tx, now));
    // Three ended sessions are done with their transcript, and each clears two rows (the transcript
    // and the tool payload); all six ended sessions lose the accepted prompt snapshot.
    assert.deepEqual(pruned, { utterances: 0, callResults: 0, journalText: 6, promptSnapshots: 6 });

    const rows = store.transaction(tx => tx.all("SELECT live_session_id, kind, text, tool_json, payload_bytes FROM live_journal WHERE kind IN ('inputTranscription','toolCall') ORDER BY live_session_id, journal_id"));
    const bySession = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) bySession.set(String(row.live_session_id), [...(bySession.get(String(row.live_session_id)) ?? []), row]);
    const cleared = ['ls-summarised', 'ls-gave-up', 'ls-forgotten', 'ls-live'].filter(id => bySession.get(id)!.every(row => row.text === null && row.tool_json === null)).sort();
    assert.deepEqual(cleared, ['ls-forgotten', 'ls-gave-up', 'ls-summarised'], 'a session still owed a summary keeps its text');
    for (const id of ['ls-unsummarised', 'ls-no-model', 'ls-deadline']) {
      assert.deepEqual(bySession.get(id)!.map(row => row.text), [`owner words ${id}`, null], `${id} still has to be distilled`);
    }
    assert.equal(bySession.get('ls-live')!.every(row => row.text === null && row.tool_json === null), false, 'a session that has not ended keeps its reattach text');

    const transcription = store.transaction(tx => tx.get("SELECT payload_bytes, arrived_at FROM live_journal WHERE live_session_id='ls-summarised' AND kind='inputTranscription'"));
    assert.deepEqual([transcription?.payload_bytes, transcription?.arrived_at], [9, endedAt], 'the byte count and the arrival time are metadata and stay');
    const marker = store.transaction(tx => tx.get("SELECT text, tool_json, payload_bytes, finished FROM live_journal WHERE live_session_id='ls-summarised' AND kind='ready'"));
    assert.deepEqual([marker?.text, marker?.tool_json, marker?.payload_bytes, marker?.finished], [null, null, 0, 1], 'a marker row keeps its own metadata untouched');
    // The reviewer's seed: a wait duration and a continuity event are markers, not owner speech, so a
    // prune that cleared them would report a 1200 ms wait as 0 and lose the continuity event.
    const wait = store.transaction(tx => tx.get("SELECT text, payload_bytes FROM live_journal WHERE live_session_id='ls-summarised' AND kind='remember_deferred'"));
    assert.deepEqual([wait?.text, wait?.payload_bytes], ['1200', 4], 'the deferred wait keeps its duration and its byte count');
    const continuity = store.transaction(tx => tx.get("SELECT text, payload_bytes FROM live_journal WHERE live_session_id='ls-summarised' AND kind='continuity'"));
    assert.equal(continuity?.text, JSON.stringify({ event: 'rebuilding', reason: 'stall' }), 'the continuity event survives');
    assert.equal(continuity?.payload_bytes, 44);

    const sessions = store.transaction(tx => tx.all('SELECT live_session_id, lifecycle, terminal_outcome, accepted_prompt_snapshot FROM live_sessions ORDER BY live_session_id'));
    assert.deepEqual(sessions.map(row => [row.live_session_id, row.lifecycle, row.terminal_outcome, row.accepted_prompt_snapshot]), [
      ['ls-deadline', 'terminal', 'complete', null],
      ['ls-forgotten', 'terminal', 'complete', null],
      ['ls-gave-up', 'terminal', 'complete', null],
      ['ls-live', 'active', null, JSON.stringify({ ownerText: 'accepted words ls-live' })],
      ['ls-no-model', 'terminal', 'complete', null],
      ['ls-summarised', 'terminal', 'complete', null],
      ['ls-unsummarised', 'terminal', 'complete', null],
    ]);

    const again = store.transaction(tx => pruneTraceContent(tx, now));
    assert.deepEqual(again, { utterances: 0, callResults: 0, journalText: 0, promptSnapshots: 0 }, 'the second start finds nothing to do');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// W8 retention meets the live journal migration: a Store still at v2 keeps the narrow live_journal
// with no tool_json, and v3 renames the wider live_journal_extended into its place. The boot pruner
// must clear the tool payload on the migrated journal and must not guess a column a v2 Store lacks.
test('a prune over a migrated v3 journal clears the tool payload the migration moved into place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-migrated-'));
  const day = 86_400_000, endedAt = T0 + 1 * day, now = T0 + 60 * day;
  try {
    const v2 = new Store(dir, [...domainMigrations, ...liveMigrations.filter(migration => migration.version < 3)]);
    v2.transaction(tx => {
      tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
          client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events,
          journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'terminal',1,1,2,0,0,'attached','complete',?,?,?)`,
        [SESSION, v2.assistantId, v2.authorityEpoch, 'key-migrated', 'fp-migrated', 'client', 'audit-migrated', 'profile', 'prompt',
          endedAt, endedAt, endedAt]);
      tx.run("INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,11,?)",
        [SESSION, 'inputTranscription', 'owner words', endedAt]);
    });
    // A v2 store has no tool_json to clear, and the pruner must not fail on the column it cannot see.
    assert.deepEqual(v2.transaction(tx => pruneTraceContent(tx, now)), { utterances: 0, callResults: 0, journalText: 0, promptSnapshots: 0 });
    v2.close();

    const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
    try {
      store.transaction(tx => {
        // The migrated journal carries the tool payload the wider table makes room for.
        tx.run("INSERT INTO live_journal (live_session_id, kind, finished, tool_json, payload_bytes, arrived_at) VALUES (?,?,1,?,0,?)",
          [SESSION, 'toolCall', JSON.stringify({ name: 'search', args: { query: 'owner words' } }), endedAt]);
        tx.run(`INSERT INTO conversation_summaries (id, live_session_id, status, summary, ended_at, model, input_chars,
            input_truncated, injected_summary_ids, retry_count, error_code, created_at, skip_reason)
          VALUES (?,?,?,?,?,?,?,0,'[]',0,NULL,?,NULL)`, ['sum-migrated', SESSION, 'complete', 'a summary', endedAt, 'm', 11, endedAt]);
      });
      const pruned = store.transaction(tx => pruneTraceContent(tx, now));
      assert.deepEqual(pruned, { utterances: 0, callResults: 0, journalText: 2, promptSnapshots: 0 }, 'the migrated journal clears its text and its tool payload');
      const rows = store.transaction(tx => tx.all("SELECT kind, text, tool_json FROM live_journal WHERE live_session_id=? ORDER BY journal_id", [SESSION]));
      assert.deepEqual(rows.map(row => [row['kind'], row['text'], row['tool_json']]), [['inputTranscription', null, null], ['toolCall', null, null]]);
    } finally { store.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// H16: the boot prune must be an index search, never a full scan of a content table that grows with
// every turn. The statements here are the prune predicates from pruneTraceContent.
test('the prune deletes and scans run as index searches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  try {
    const plan = store.transaction(tx => [
      ...tx.all('EXPLAIN QUERY PLAN DELETE FROM trace_utterance WHERE at < ?', [T0]),
      ...tx.all('EXPLAIN QUERY PLAN DELETE FROM trace_call_result WHERE call_key IN (SELECT call_key FROM trace_call WHERE intent_at < ?)', [T0]),
      ...tx.all('EXPLAIN QUERY PLAN UPDATE live_journal SET text=NULL, tool_json=NULL WHERE (text IS NOT NULL OR tool_json IS NOT NULL) AND live_session_id IN (SELECT s.live_session_id FROM live_sessions s WHERE s.terminal_at IS NOT NULL AND s.terminal_at < ?)', [T0]),
      ...tx.all('EXPLAIN QUERY PLAN UPDATE live_sessions SET accepted_prompt_snapshot=NULL WHERE accepted_prompt_snapshot IS NOT NULL AND terminal_at IS NOT NULL AND terminal_at < ?', [T0]),
    ].map(row => String(row.detail)));
    assert.deepEqual(plan.filter(detail => /^SCAN (trace_utterance|trace_call|live_journal|live_sessions)\b/.test(detail)), [], `no content table is scanned: ${plan.join(' | ')}`);
    for (const index of ['trace_utterance_at', 'trace_call_intent_at', 'live_journal_content', 'live_sessions_terminal_at']) {
      assert.ok(plan.some(detail => detail.includes(index)), `${index} is searched: ${plan.join(' | ')}`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/didi-timeline reads SQL only and prints the timeline and the metadata export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  try {
    const store = new Store(dir, [...domainMigrations]);
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    reply(store, 'p1', 't1', 'r1', T0 + 200, T0 + 900);
    recordUtterance(store, { turnId: 't1', role: 'model', at: T0 + 250, final: true, text: 'SECRET-OWNER-WORDS' });
    // --content is gated on the session's own current history evidence, so the fixture records it.
    store.transaction(tx => tx.run('INSERT INTO history_sessions(live_session_id,owner_id,data_class,revision,created_at) VALUES(?,?,?,1,?)', [SESSION, 'owner-fixture', 'ordinary', T0]));
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

    // --content asks, and the gate answers truthfully: this fixture is a trace-only session with no
    // canonical live evidence, so it is refused rather than served legacy preview rows (content.ts).
    const withContent = execFileSync(process.execPath, [script, 'latest', '--data-dir', dir, '--content'], { encoding: 'utf8' });
    assert.match(withContent, /content: denied reason=legacy_unavailable/);
    assert.ok(!withContent.includes('SECRET-OWNER-WORDS'), 'a refused gate never serves text anyway');

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
      'attribution_uncertain', 'clock_domain', 'close_reason', 'closed_at', 'first_audible_at', 'live_session_id', 'mono_ms',
      'opened_at', 'origin', 'outcome', 'playback_drained_at', 'stall_reason', 'supersedes_turn_id', 'turn_id', 'turn_index',
    ], 'the export names every metadata column the turn row carries, including its clock domain');
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
    const events = store.transaction(tx => tx.all('SELECT kind, source, source_instance_id, source_seq, at, mono_ms, turn_id, playback_key FROM trace_event WHERE source=? ORDER BY seq', ['native']));
    assert.deepEqual(events.map(row => row['kind']), ['playback.received', 'playback.enqueued', 'playback.started', 'playback.drained']);
    assert.ok(events.every(row => row['source'] === 'native'), 'every forward is a native event');
    assert.deepEqual(events.map(row => row['source_seq']), [1, 2, 3, 4]);
    assert.equal(events[3]!['at'], T0 + 204, 'the producer wall ms is stored as sent, never replaced by the host clock');
    assert.equal(events[3]!['mono_ms'], 1_004);
    const row = store.transaction(tx => tx.get('SELECT * FROM trace_playback WHERE playback_key=?', [`${SESSION}:${INSTANCE}:1`]))!;
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
    const nativeEvents = (): number => store.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM trace_event WHERE source='native'")!['n']));
    assert.equal(nativeEvents(), 1);
    assert.equal(counts(store)['trace_playback'], 1);
    // A drained receipt for the same segment is not a replay: it is the next receipt in order.
    assert.equal(forward(store, frame('drained', 8, T0 + 90)).duplicate, false);
    assert.equal(nativeEvents(), 2);
  });
});

test('a native audible receipt is accepted and lands as the segment first audible time (W6-R1 ASK-1)', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    assert.equal(forward(store, frame('received', 1, T0 + 201), { turnId: 't1', responseKey: 'r1' }).duplicate, false);
    assert.equal(forward(store, frame('audible', 2, T0 + 950), { turnId: 't1', responseKey: 'r1' }).duplicate, false);
    const row = store.transaction(tx => tx.get('SELECT audible_at FROM trace_playback WHERE playback_key=?', [`${SESSION}:${INSTANCE}:1`]))!;
    assert.equal(row['audible_at'], T0 + 950, 'the app\'s own first-audible-chunk receipt is recorded');
    const kinds = store.transaction(tx => tx.all('SELECT kind FROM trace_event WHERE source=? ORDER BY seq', ['native']).map(row => row['kind']));
    assert.deepEqual(kinds, ['playback.received', 'playback.audible']);
  });
});

test('a frame with an unknown or free-text field is refused by a typed code', () => {
  const base = { type: 'playback_receipt', receipt: 'drained', segment_seq: 1, source_instance_id: INSTANCE, source_seq: 1, mono_ms: 1, wall_ms: 2 };
  for (const [label, raw, code] of [
    ['free text', { ...base, note: 'the owner said something' }, 'unknown_field'],
    ['unknown receipt', { ...base, receipt: 'played' }, 'unknown_receipt'],
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
    assert.ok(rendered.includes(`  playback ${SESSION}:inst-a1:1 segment=1 `), rendered);
    assert.match(rendered, /drained=.*clock=approx/);
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
    assert.match(rendered, new RegExp(`^playback ${SESSION}:inst-a1:1 segment=1 .*turn=none`, 'm'));
    assert.deepEqual(report.gaps, [], 'an orphan segment is not a stall: it is printed outside the turns');
  });
});

// --- O1b-A: the receipts the adapter and host now write -----------------------------------------

test('O1b-A: a full synthetic call turn prints its turn, ordered utterances, call, continuation, first audible and drain', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0 + 1_000);
    const id = { liveSessionId: SESSION, connectionEpoch: 'e0' };
    record(store, 'delegation.created', { ...id, responseKey: 'r1' }, { createdAt: T0 + 1_050, providerResponseId: 'resp_1', callCount: 1 });
    record(store, 'response.created', { ...id, responseKey: 'r1', turnId: 't1' }, { createdAt: T0 + 1_050, providerResponseId: 'resp_1' });
    record(store, 'call.intent', { ...id, callKey: 'c1', responseKey: 'r1', turnId: 't1' }, { name: 'research', argsChars: 12, intentAt: T0 + 1_100, providerCallId: 'call_1' });
    record(store, 'call.executed', { ...id, callKey: 'c1' }, { executedAt: T0 + 1_300 });
    record(store, 'call.output_prepared', { ...id, callKey: 'c1' }, { outputPreparedAt: T0 + 1_300 });
    record(store, 'call.output_written', { ...id, callKey: 'c1' }, { outputWrittenAt: T0 + 1_320, outcome: 'completed', ms: 220, resultChars: 40 });
    record(store, 'continuation.decided', { ...id, responseKey: 'r1' }, { decidedAt: T0 + 1_320, outcome: 'sent' });
    record(store, 'response.terminal', { ...id, responseKey: 'r1' }, { terminalAt: T0 + 1_400, status: 'completed', terminalReason: 'completed' });
    recordUtterance(store, { turnId: 't1', role: 'owner', at: T0 + 1_000, final: true, text: 'Synthetic question' });
    recordUtterance(store, { turnId: 't1', role: 'model', at: T0 + 1_500, final: true, text: 'Synthetic answer' });
    recordCallResult(store, { callKey: 'c1', text: '{"ok":true}' });
    reply(store, 'p1', 't1', 'r1', T0 + 1_500, T0 + 1_900);

    const report = buildTimeline(readOf(store), SESSION, { content: true });
    const track = report.turns[0]!;
    assert.equal(track.turn.turnId, 't1');
    assert.deepEqual(track.utterances, [], 'no content without current canonical source authority');
    assert.equal(report.contentAccess?.state, 'denied');
    assert.equal(track.calls.length, 1);
    assert.equal(track.calls[0]!.outputWrittenAt, T0 + 1_320, 'the call carries its output time');
    assert.equal(track.calls[0]!.continuationAt, T0 + 1_320, 'and the continuation it earned');
    assert.equal(track.calls[0]!.continuationOutcome, 'sent');
    assert.equal(track.turn.firstAudibleAt, track.playback[0]!.audibleAt, 'first audible comes from the playback receipt itself');
    assert.equal(track.playback[0]!.drainedAt, T0 + 1_900);
    const printed = renderTimeline(report);
    assert.match(printed, /call c1 research/);
    assert.match(printed, /continuation=\S+:sent/);
  });
});

test('O1b-A: a turn that stalls before any delegation prints its typed GAP and the receipt that would close it', () => {
  withStore(store => {
    const id = { liveSessionId: SESSION, connectionEpoch: 'e0' };
    openTurn(store, 't1', 1, T0 + 1_000);
    // The response was created and no delegation or provider id ever came back: that is the D12-1 stall.
    record(store, 'response.created', { ...id, responseKey: 'r1', turnId: 't1' }, { createdAt: T0 + 1_050 });
    record(store, 'live.dead_air_stalled', { ...id, turnId: 't1' }, { stalledAt: T0 + 9_000, turnAgeMs: 8_000, anyAudio: false, inaudibleMs: 0 });

    const report = buildTimeline(readOf(store), SESSION);
    assert.equal(report.turns[0]!.turn.stallReason, 'no_audible_output', 'the stall receipt lands on the open turn');
    assert.ok(report.gaps.some(gap => gap.obligation === 'no_delegation'), 'the stall before any delegation is a typed GAP');
    const printed = renderTimeline(report);
    assert.match(printed, /GAP/);
    assert.match(printed, /no_delegation/);
  });
});

test('O1b-A: a rebuilt connection gets a new epoch and the old port cannot write into it', () => {
  withStore(store => {
    const first = liveTracePort({ port: store, liveSessionId: SESSION, connectionEpoch: 'e1' });
    first.receipt('response.created', { responseKey: 'r1' }, { createdAt: T0 });
    const rejected: string[] = [];
    const rebuilt = liveTracePort({ port: store, liveSessionId: SESSION, connectionEpoch: 'e2', onReject: code => rejected.push(code) });
    rebuilt.receipt('response.observed', { responseKey: 'r1' }, { observedAt: T0 + 10 });
    assert.deepEqual(rejected, ['UNKNOWN_ID'],
      'a rebuilt port names its own epoch, so its key for r1 belongs to no row: refused, never written');
    assert.equal(store.transaction(tx => tx.all("SELECT kind FROM trace_event WHERE kind='response.observed'")).length, 0, 'and it writes no row');
    // The epoch guard itself still refuses a row written under another epoch, whatever key names it.
    const firstEpochKey = scopedTraceKey(SESSION, 'e1', 'response', 'r1');
    assert.throws(() => record(store, 'response.observed', { liveSessionId: SESSION, connectionEpoch: 'e2', responseKey: firstEpochKey }, { observedAt: T0 + 20 }),
      (error: unknown) => error instanceof TraceRecordError && error.code === 'STALE_EPOCH',
      'a receipt that names a row from another epoch is refused by the epoch it carries');
  });
});

test('O1b-A: two decisions at the same millisecond resolve to the one decided last, never to chance', () => {
  withStore(store => {
    const id = { liveSessionId: SESSION, connectionEpoch: 'e0' };
    openTurn(store, 't1', 1, T0 + 1_000);
    record(store, 'response.created', { ...id, responseKey: 'r1', turnId: 't1' }, { createdAt: T0 + 1_050 });
    record(store, 'call.intent', { ...id, callKey: 'c1', responseKey: 'r1', turnId: 't1' }, { name: 'research', argsChars: 4, intentAt: T0 + 1_100 });
    // A deferral and the send it became, stamped inside the same millisecond: the seq, not the clock, decides.
    record(store, 'continuation.decided', { ...id, responseKey: 'r1' }, { decidedAt: T0 + 2_000, outcome: 'deferred', skipReason: 'awaiting_calls' });
    record(store, 'continuation.decided', { ...id, responseKey: 'r1' }, { decidedAt: T0 + 2_000, outcome: 'sent' });
    const call = buildTimeline(readOf(store), SESSION).turns[0]!.calls[0]!;
    assert.equal(call.continuationOutcome, 'sent', 'the last decision by (at, seq) is the one reported');
    assert.equal(call.continuationAt, T0 + 2_000);
  });
});

// Release 3x / call 1019: the native player restarts its segment numbers with every session, so the
// row key carries the live session too. Without it a later session's receipts land on an earlier
// session's row (and its own event is dropped), which the timeline reads as false gaps.
test('two sessions sharing one native instance keep their own playback rows and report no false gap', () => {
  withStore(store => {
    const EARLY = 'ls-early';
    const LATE = 'ls-late';
    const receipt = (session: string, name: 'received' | 'drained', segment: number, at: number): void => {
      recordPlaybackReceipt(store, session, parsePlaybackReceipt(JSON.stringify({
        type: 'playback_receipt', receipt: name, segment_seq: segment, source_instance_id: INSTANCE,
        source_seq: segment, mono_ms: at, wall_ms: at,
      })));
    };
    for (const segment of [1, 2]) { receipt(EARLY, 'received', segment, T0 + segment); receipt(EARLY, 'drained', segment, T0 + 100 + segment); }
    // The later session re-uses segments 1 and 2 of the same instance and continues past them.
    for (const segment of [1, 2, 3]) { receipt(LATE, 'received', segment, T0 + 1_000 + segment); receipt(LATE, 'drained', segment, T0 + 1_100 + segment); }
    const keys = store.transaction(tx => tx.all('SELECT live_session_id, segment_seq FROM trace_playback ORDER BY live_session_id, segment_seq'))
      .map(row => `${row['live_session_id']}:${row['segment_seq']}`);
    assert.deepEqual(keys, ['ls-early:1', 'ls-early:2', 'ls-late:1', 'ls-late:2', 'ls-late:3'], 'each session keeps its own row');
    const early = buildTimeline(readOf(store), EARLY);
    const late = buildTimeline(readOf(store), LATE);
    assert.deepEqual(early.unattributedPlayback.map(row => row.receivedAt), [T0 + 1, T0 + 2], 'the earlier session keeps its own receipt times');
    assert.deepEqual(late.unattributedPlayback.map(row => row.receivedAt), [T0 + 1_001, T0 + 1_002, T0 + 1_003]);
    assert.deepEqual(early.nativeGaps, [], 'no native gap across sessions');
    assert.deepEqual(late.nativeGaps, []);
  });
});

// Z3-R1: the trace v2 replay index is widened to carry the live session, additively. A store already at
// v1 keeps every row of every trace table, a store already at v2 opens as a no-op with one ledger row,
// and the widened index accepts the same native sequence in a second session while still refusing a
// replay inside one session. The Store applies each migration's statements and its ledger row inside the
// one transaction it already holds open (runtime/store.ts applyMigrations), so a migration is all or none.
test('the trace v2 migration keeps every v1 row, applies once, and reopens an already-migrated store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-v1-'));
  const seeded = { trace_turn: 1, trace_response: 1, trace_call: 1, trace_playback: 1, trace_event: 1, trace_utterance: 1, trace_call_result: 1 };
  const counts = (store: Store): Record<string, number> => Object.fromEntries(Object.keys(seeded).map(table => [table,
    Number(store.transaction(tx => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!['n']))]));
  const traceVersion = (store: Store): number => Number(store.transaction(tx =>
    tx.get("SELECT MAX(version) AS v FROM runtime_migrations WHERE owner='trace'")!['v']));
  // The current owner version, not a number frozen at v2: the migration list grows with the schema.
  const latestTraceVersion = Math.max(...traceMigrations.map(migration => migration.version));
  try {
    const db = new DatabaseSync(join(dir, 'state.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('CREATE TABLE runtime_migrations(owner TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(owner,version))');
      for (const sql of traceMigrations[0]!.statements) db.exec(sql);
      db.exec("INSERT INTO runtime_migrations VALUES ('trace',1)");
      // Real clock times: the store prunes the two content tables against a thirty day retention at open.
      const rows = [
        "INSERT INTO trace_turn(turn_id, live_session_id, turn_index, origin, opened_at, mono_ms) VALUES ('t1','ls-v1',1,'owner',?,1)",
        "INSERT INTO trace_response(response_key, live_session_id, connection_epoch, status, created_at) VALUES ('r1','ls-v1','e0','completed',?)",
        "INSERT INTO trace_call(call_key, live_session_id, connection_epoch, name, args_chars, intent_at, outcome) VALUES ('c1','ls-v1','e0','research',4,?,'completed')",
        "INSERT INTO trace_playback(playback_key, live_session_id, source_instance_id, segment_seq, received_at) VALUES ('inst-v1:1','ls-v1','inst-v1',1,?)",
        "INSERT INTO trace_event(live_session_id, kind, source, source_instance_id, source_seq, at, mono_ms, received_at, schema_version, detail) VALUES ('ls-v1','playback.received','native','inst-v1',1,?,1,?,1,'{}')",
        "INSERT INTO trace_utterance(turn_id, role, at, final, text) VALUES ('t1','owner',?,1,'x')",
        "INSERT INTO trace_call_result(call_key, text, text_truncated) VALUES ('c1','y',0)",
      ];
      const now = Date.now();
      for (const sql of rows) { const count = (sql.match(/\?/g) ?? []).length; db.prepare(sql).run(...Array.from({ length: count }, () => now)); }
    } finally { db.close(); }
    const migrated = new Store(dir, []);
    try {
      assert.deepEqual(counts(migrated), seeded, 'every existing row of every trace table is kept');
      assert.equal(traceVersion(migrated), latestTraceVersion);
      const ids = { liveSessionId: 'ls-v2', playbackKey: 'ls-v2:inst-v1:1', source: 'native', sourceInstanceId: 'inst-v1', sourceSeq: 1, at: T0, monoMs: 1 } as const;
      assert.equal(record(migrated, 'playback.received', ids, { segmentSeq: 1, receivedAt: T0 }).duplicate, false,
        'the same native sequence in another session is its own event, not a replay of ls-v1');
      assert.equal(record(migrated, 'playback.received', ids, { segmentSeq: 1, receivedAt: T0 }).duplicate, true,
        'a replay inside one session is still deduped');
      assert.deepEqual(counts(migrated), { ...seeded, trace_event: 2, trace_playback: 2 });
    } finally { migrated.close(); }
    const again = new Store(dir, []);
    try {
      assert.deepEqual(counts(again), { ...seeded, trace_event: 2, trace_playback: 2 }, 'reopening an already-migrated store keeps every row');
      assert.equal(traceVersion(again), latestTraceVersion);
      assert.equal(Number(again.transaction(tx => tx.get("SELECT COUNT(*) AS n FROM runtime_migrations WHERE owner='trace'")!['n'])), traceMigrations.length,
        'one ledger row per applied version, so the migration ran once');
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// W6 (#451): the call timeline tells the whole truth. Each case below is one hole the audit found
// in the store as the host really writes it, and the fixture session at the end is the same story
// told through `scripts/didi-timeline`'s own renderer.
test('H15: executionMs comes from call.output_written, the stage the host really writes', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    const callKey = `call:${'a'.repeat(64)}`;
    record(store, 'call.intent', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1', callKey, monoMs: 5_000 },
      { name: 'research', argsChars: 12, intentAt: T0 + 200 });
    record(store, 'call.executed', { liveSessionId: SESSION, callKey, monoMs: 5_010 }, { executedAt: T0 + 210 });
    record(store, 'call.output_written', { liveSessionId: SESSION, callKey, monoMs: 5_220 },
      { outputWrittenAt: T0 + 420, outcome: 'completed', ms: 220, resultChars: 40 });
    const report = buildTimeline(readOf(store), SESSION);
    assert.equal(report.turns[0]!.calls[0]!.executionMs, 210,
      'the executed-to-written span is the call execution time, so no call is left without one');
  });
});

test('H13: playback that started but never said it became audible is unknown, not absent', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't1' }, { closedAt: T0 + 2_000, closeReason: 'completed', outcome: 'answered' });
    record(store, 'playback.received', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1', playbackKey: 'pb1' }, { segmentSeq: 1, receivedAt: T0 + 110 });
    record(store, 'playback.started', { liveSessionId: SESSION, turnId: 't1', playbackKey: 'pb1' }, { startedAt: T0 + 120 });
    record(store, 'playback.drained', { liveSessionId: SESSION, turnId: 't1', playbackKey: 'pb1' }, { drainedAt: T0 + 1_900 });
    const report = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(report.gaps.map(gap => gap.obligation), [],
      'a started segment with no audible receipt is unknown audibility, so it raises no gap');

    record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't2' }, { origin: 'owner', turnIndex: 2, openedAt: T0 + 3_000, monoMs: T0 + 3_000 });
    completedResponse(store, 'r2', 't2', T0 + 3_100);
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't2' }, { closedAt: T0 + 4_000, closeReason: 'completed', outcome: 'answered' });
    const after = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(after.gaps.map(gap => [gap.turnId, gap.obligation]), [['t2', 'no_audible_output']],
      'a turn with no playback at all still owes audibility, so a real silence keeps its gap');
  });
});

test('W6-3: once a session reports audibility, a started answer that never became audible is a real gap', () => {
  withStore(store => {
    openTurn(store, 't1', 1, T0);
    completedResponse(store, 'r1', 't1', T0 + 100);
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't1' }, { closedAt: T0 + 2_000, closeReason: 'completed', outcome: 'answered' });
    record(store, 'playback.received', { liveSessionId: SESSION, turnId: 't1', responseKey: 'r1', playbackKey: 'pb1' }, { segmentSeq: 1, receivedAt: T0 + 110 });
    record(store, 'playback.started', { liveSessionId: SESSION, playbackKey: 'pb1' }, { startedAt: T0 + 120 });
    record(store, 'playback.audible', { liveSessionId: SESSION, playbackKey: 'pb1' }, { audibleAt: T0 + 130 });
    record(store, 'playback.drained', { liveSessionId: SESSION, playbackKey: 'pb1' }, { drainedAt: T0 + 1_900 });
    openTurn(store, 't2', 2, T0 + 3_000);
    completedResponse(store, 'r2', 't2', T0 + 3_100);
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't2' }, { closedAt: T0 + 4_000, closeReason: 'completed', outcome: 'answered' });
    record(store, 'playback.received', { liveSessionId: SESSION, turnId: 't2', responseKey: 'r2', playbackKey: 'pb2' }, { segmentSeq: 2, receivedAt: T0 + 3_110 });
    record(store, 'playback.started', { liveSessionId: SESSION, playbackKey: 'pb2' }, { startedAt: T0 + 3_120 });
    record(store, 'playback.drained', { liveSessionId: SESSION, playbackKey: 'pb2' }, { drainedAt: T0 + 3_900 });
    const report = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(report.gaps.map(gap => [gap.turnId, gap.obligation]), [['t2', 'no_audible_output']],
      'the session reports audibility, so a started answer with no audible receipt is a real gap');
  });
});

test('W6: a fixture session renders every turn closed, every playback on a turn, every call timed, no audibility gap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-'));
  try {
    const store = new Store(dir, []);
    // A session the way #openTurn, the playback ingress and the call receipts now write it:
    // an owner utterance that supersedes an open turn, two audible answers, one tool call, one kill.
    record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't1' }, { origin: 'owner', turnIndex: 1, openedAt: T0, monoMs: 1_000 });
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't1' }, { closedAt: T0 + 400, closeReason: 'superseded' });
    record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't2' }, { origin: 'owner', turnIndex: 2, openedAt: T0 + 400, monoMs: 1_400, supersedesTurnId: 't1' });
    const r1 = { liveSessionId: SESSION, turnId: 't2', responseKey: 'resp-1' };
    record(store, 'response.created', r1, { createdAt: T0 + 500, status: 'completed', providerResponseId: 'p-1' });
    const callKey = `call:${'b'.repeat(64)}`;
    record(store, 'call.intent', { ...r1, callKey, monoMs: 1_500 }, { name: 'research', argsChars: 20, intentAt: T0 + 600 });
    record(store, 'call.executed', { liveSessionId: SESSION, callKey, monoMs: 1_510 }, { executedAt: T0 + 610 });
    record(store, 'call.output_written', { liveSessionId: SESSION, callKey, monoMs: 1_710 },
      { outputWrittenAt: T0 + 810, outcome: 'completed', ms: 200, resultChars: 512 });
    record(store, 'continuation.decided', { liveSessionId: SESSION, responseKey: 'resp-1' }, { decidedAt: T0 + 900, outcome: 'sent' });
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't2' }, { closedAt: T0 + 5_000, closeReason: 'completed', outcome: 'answered' });
    const r2 = { liveSessionId: SESSION, turnId: 't3', responseKey: 'resp-2' };
    record(store, 'turn.opened', { liveSessionId: SESSION, turnId: 't3' }, { origin: 'owner', turnIndex: 3, openedAt: T0 + 6_000, monoMs: 7_000, supersedesTurnId: 't2' });
    record(store, 'response.created', r2, { createdAt: T0 + 6_100, status: 'completed', providerResponseId: 'p-2' });
    record(store, 'continuation.decided', { liveSessionId: SESSION, responseKey: 'resp-2' }, { decidedAt: T0 + 6_900, outcome: 'sent' });
    // Playback rows land carrying the turn and the response that were open when their first chunk went out.
    for (const [segment, turnId, responseKey, at] of [[1, 't2', 'resp-1', T0 + 2_000], [2, 't3', 'resp-2', T0 + 7_000]] as const) {
      const playbackKey = `${SESSION}:inst-1:${segment}`;
      record(store, 'playback.received', { liveSessionId: SESSION, turnId, responseKey, playbackKey }, { segmentSeq: segment, receivedAt: at });
      record(store, 'playback.enqueued', { liveSessionId: SESSION, playbackKey }, { enqueuedAt: at + 10 });
      record(store, 'playback.started', { liveSessionId: SESSION, playbackKey }, { startedAt: at + 20 });
      record(store, 'playback.drained', { liveSessionId: SESSION, playbackKey }, { drainedAt: at + 900 });
    }
    record(store, 'turn.closed', { liveSessionId: SESSION, turnId: 't3' }, { closedAt: T0 + 9_000, closeReason: 'session_end', outcome: 'answered' });

    const report = buildTimeline(readOf(store), SESSION);
    assert.deepEqual(report.unattributedPlayback, [], 'every playback segment belongs to a turn');
    assert.deepEqual(report.unattributedCalls, [], 'every call belongs to a turn');
    assert.deepEqual(report.turns.map(track => track.turn.closeReason), ['superseded', 'completed', 'session_end'],
      'every turn is closed with its own reason, the superseded one first');
    assert.equal(report.turns[1]!.turn.supersedesTurnId, 't1');
    assert.deepEqual(report.turns.flatMap(track => track.calls).map(call => call.executionMs), [200],
      'executionMs is on the call, so no line prints ms=-');
    assert.deepEqual(report.gaps.map(gap => gap.obligation), [], 'no systematic audibility gap drowns the real ones');

    const rendered = renderTimeline(report);
    assert.match(rendered, /turn 1 .*reason=superseded outcome=-/);
    assert.doesNotMatch(rendered, /^turn .* reason=-/m, 'no turn line prints an empty close reason');
    assert.doesNotMatch(rendered, /turn=none/, 'no playback line is left off a turn');
    assert.doesNotMatch(rendered, /executionMs=-/, 'no call line is left without an execution time');
    assert.match(rendered, /executionMs=200/);
    assert.match(rendered, /gaps: none/);

    // The surface the audit reads: the script itself, on the session the host wrote.
    store.close();
    const script = join(repoRoot, 'scripts', 'didi-timeline');
    const text = execFileSync(process.execPath, [script, 'latest', '--data-dir', dir], { encoding: 'utf8' });
    assert.doesNotMatch(text, /^turn .* reason=-/m);
    assert.doesNotMatch(text, /turn=none/);
    assert.doesNotMatch(text, /executionMs=-/);
    assert.doesNotMatch(text, /obligation=no_audible_output/);
    assert.match(text, /gaps: none/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
