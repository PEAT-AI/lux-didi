// scripts/didi-voice-metrics: the numbers it prints on a real call.
// Fixture: server/test/fixtures/voice-metrics/{store.json,host.log}. Every id, time and word is invented.
//
// The fixture path resolves from the compiled file, `<repo>/server/dist/test/`, which is where the registered
// check step runs it; run the `.ts` directly and `../../test/fixtures` would mean `<repo>/test/fixtures`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';

const CLI = fileURLToPath(new URL('../../../scripts/didi-voice-metrics', import.meta.url));
const FIXTURE = new URL('../../test/fixtures/voice-metrics/', import.meta.url);

interface Row { readonly [key: string]: string | number | null }

/** The named cells of one synthetic row, in insert order; a fixture row that lacks a key is a mistake, not null. */
function cells(row: Row, ...keys: readonly string[]): (string | number | null)[] {
  return keys.map(key => {
    const value = row[key];
    if (value === undefined) throw new Error(`fixture row is missing ${key}`);
    return value;
  });
}

interface FixtureStore {
  readonly turns: readonly Row[];
  readonly utterances: readonly Row[];
  readonly playbacks: readonly Row[];
  readonly events: readonly Row[];
  readonly tasks: readonly Row[];
  readonly revisions: readonly Row[];
  readonly deliveries: readonly Row[];
}

const fixture = JSON.parse(readFileSync(new URL('store.json', FIXTURE), 'utf8')) as FixtureStore;
const hostLog = readFileSync(new URL('host.log', FIXTURE), 'utf8');

/** A data directory the script may read: one store built from the fixture rows, and the day's host log. */
function dataDirectory(body: (directory: string) => void, log: string = hostLog): void {
  const directory = mkdtempSync(join(tmpdir(), 'didi-voice-metrics-'));
  try {
    const store = new Store(directory);
    try {
      store.transaction(tx => {
        for (const row of fixture.turns) tx.run('INSERT INTO trace_turn(turn_id,live_session_id,turn_index,origin,opened_at,mono_ms,closed_at,first_audible_at) VALUES(?,?,?,?,?,?,?,?)',
          cells(row, 'turn_id', 'live_session_id', 'turn_index', 'origin', 'opened_at', 'mono_ms', 'closed_at', 'first_audible_at'));
        for (const row of fixture.utterances) tx.run('INSERT INTO trace_utterance(turn_id,role,at,final,text) VALUES(?,?,?,?,?)',
          cells(row, 'turn_id', 'role', 'at', 'final', 'text'));
        for (const row of fixture.playbacks) tx.run('INSERT INTO trace_playback(playback_key,live_session_id,source_instance_id,segment_seq,turn_id,received_at,audible_at,started_at,drained_at,termination_reason) VALUES(?,?,?,?,?,?,?,?,?,?)',
          cells(row, 'playback_key', 'live_session_id', 'source_instance_id', 'segment_seq', 'turn_id', 'received_at', 'audible_at', 'started_at', 'drained_at', 'termination_reason'));
        for (const row of fixture.events) tx.run('INSERT INTO trace_event(live_session_id,turn_id,kind,source,at,mono_ms,received_at,schema_version,detail) VALUES(?,?,?,?,?,?,?,?,?)',
          cells(row, 'live_session_id', 'turn_id', 'kind', 'source', 'at', 'mono_ms', 'received_at', 'schema_version', 'detail'));
        for (const row of fixture.tasks) tx.run('INSERT INTO tasks(task_id,created_at,updated_at,current_revision,status,live_session_id) VALUES(?,?,?,?,?,?)',
          cells(row, 'task_id', 'created_at', 'updated_at', 'current_revision', 'status', 'live_session_id'));
        for (const row of fixture.revisions) tx.run('INSERT INTO task_revisions(task_id,task_revision,connection_generation,created_at) VALUES(?,?,?,?)',
          cells(row, 'task_id', 'task_revision', 'connection_generation', 'created_at'));
        for (const row of fixture.deliveries) tx.run('INSERT INTO task_deliveries(attempt_id,task_id,task_revision,connection_generation,state,updated_at) VALUES(?,?,?,?,?,?)',
          cells(row, 'attempt_id', 'task_id', 'task_revision', 'connection_generation', 'state', 'updated_at'));
      });
    } finally { store.close(); }
    mkdirSync(join(directory, 'logs'), { recursive: true });
    writeFileSync(join(directory, 'logs', 'host.log'), log);
    body(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function metrics(directory: string, ...extra: readonly string[]): { stdout: string; parsed: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [CLI, '--data-dir', directory, '--json', ...extra], { encoding: 'utf8' });
  assert.equal(run.error, undefined, `the script must run: ${String(run.error)}`);
  assert.equal(run.status, 0, `the script must exit 0: ${run.stderr}`);
  return { stdout: run.stdout, parsed: JSON.parse(run.stdout) as Record<string, unknown> };
}

test('the script exists and refuses to guess a data directory', () => {
  assert.ok(existsSync(CLI), 'scripts/didi-voice-metrics is missing');
  const run = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env: { ...process.env, DIDI_STATE_DIR: '' } });
  assert.equal(run.status, 2, 'with no data directory it stops and says so');
  assert.match(run.stderr, /data directory/);
});

test('VOICE-METRICS: one call scores latency, delegation silence, first fact, fast evidence and progress', () => {
  dataDirectory(directory => {
    const { parsed } = metrics(directory);
    assert.deepEqual(parsed, {
      calls: [
        {
          liveSessionId: 'synthetic-call-a',
          latency: { n: 1, unmeasured: 0, p50: 2500, p90: 2500 },
          silence: { n: 1, unmeasured: 0, totalMs: 9500, longestMs: 6000 },
          groundedFact: { n: 1, unmeasured: 0, p50: 7000, p90: 7000 },
          fastEvidence: { n: 3, outcomes: { hit: 2, miss: 1 }, p50: 200, p90: 400 },
          progress: { deliveries: { 'a-task-1': { delivered: 1 } }, reports: {}, corrections: {} },
        },
        {
          liveSessionId: 'synthetic-call-b',
          latency: { n: 1, unmeasured: 2, p50: 300, p90: 300 },
          silence: { n: 1, unmeasured: 0, totalMs: 7400, longestMs: 6100 },
          groundedFact: { n: 1, unmeasured: 2, p50: 80, p90: 80 },
          fastEvidence: { n: 0, outcomes: {}, p50: null, p90: null },
          progress: { deliveries: { 'b-task-1': { delivered: 1, closed: 1 } }, reports: { lookup: 1 }, corrections: { 'b-task-1': 1 } },
        },
      ],
      unjoined: { fastEvidence: 0, reports: 0, corrections: 0 },
      carriers: { factCommentary: 'recorded', fastEvidence: 'recorded' },
      total: {
        latency: { n: 2, unmeasured: 2, p50: 300, p90: 2500 },
        silence: { n: 2, unmeasured: 0, totalMs: 16900, p50: 7400, p90: 9500, longestMs: 6100, longestP50: 6000, longestP90: 6100 },
        groundedFact: { n: 2, unmeasured: 2, p50: 80, p90: 7000 },
        fastEvidence: { n: 3, outcomes: { hit: 2, miss: 1 }, p50: 200, p90: 400 },
        progress: {
          deliveries: { 'a-task-1': { delivered: 1 }, 'b-task-1': { delivered: 1, closed: 1 } },
          reports: { lookup: 1 },
          corrections: { 'b-task-1': 1 },
        },
      },
    });
  });
});

test('VOICE-METRICS: a turn the record cannot time is unmeasured, never anchored to a turn close', () => {
  dataDirectory(directory => {
    const { parsed } = metrics(directory, '--session', 'synthetic-call-b');
    const calls = parsed.calls as readonly Record<string, Record<string, number | null>>[];
    assert.equal(calls.length, 1, 'one call is selected');
    assert.deepEqual(calls[0]!.latency, { n: 1, unmeasured: 2, p50: 300, p90: 300 },
      'two owner turns are unmeasured: one has no assistant audio, and b-t5 has a reply but no owner final utterance, so its own close (9000) is not used as the anchor');
    assert.deepEqual(calls[0]!.groundedFact, { n: 1, unmeasured: 2, p50: 80, p90: 80 },
      'no helper answer reached the owner after the second or the unanchored final, so both turns are unmeasured');
  });
});

test('VOICE-METRICS: a running helper task is open until the call ends, not until its last write', () => {
  dataDirectory(directory => {
    const { parsed } = metrics(directory, '--session', 'synthetic-call-b');
    const calls = parsed.calls as readonly Record<string, Record<string, number | null>>[];
    // b-task-1 closed at 7000; b-task-2 is still running at its last write 6200 and the call ends at 9600, so the
    // window is [1000,9600]: 300 + 1000 ms of gaps before the audio, then 6100 ms of silence to the call's end.
    assert.deepEqual(calls[0]!.silence, { n: 1, unmeasured: 0, totalMs: 7400, longestMs: 6100 },
      'truncating at the last write would have reported 4800 / 3500');
  });
});

test('VOICE-METRICS: --since selects calls by their own turn times, and the read never writes to its source', () => {
  dataDirectory(directory => {
    const store = join(directory, 'state.sqlite');
    const digest = () => createHash('sha256').update(readFileSync(store)).digest('hex');
    const before = { digest: digest(), files: readdirSync(directory).sort() };
    const all = metrics(directory, '--since', '1970-01-01T00:00:00.000Z');
    assert.equal((all.parsed.calls as readonly unknown[]).length, 2, 'both calls are after 1970');
    const none = metrics(directory, '--since', '2026-01-01T00:00:00.000Z');
    assert.deepEqual((none.parsed.calls as readonly unknown[]).length, 0, 'a call opened before --since is excluded');
    assert.deepEqual({ digest: digest(), files: readdirSync(directory).sort() }, before,
      'the source store is byte-for-byte unchanged and no file was added');
  });
});

test('VOICE-METRICS: a carrier this release does not write is named, never read as a zero', () => {
  // Before FR1 and FR2 ship, her logs hold no fast_evidence and no commentary_sent line at all. The fact measure
  // must not depend on them, and the output must say the carriers are absent rather than print a silent zero.
  dataDirectory(directory => {
    const { parsed } = metrics(directory);
    assert.deepEqual(parsed.carriers, { factCommentary: 'not_recorded', fastEvidence: 'not_recorded' });
    const calls = parsed.calls as readonly Record<string, Record<string, unknown>>[];
    assert.deepEqual(calls[0]!.groundedFact, { n: 1, unmeasured: 0, p50: 7000, p90: 7000 },
      'the delivered helper answer still measures the first fact with no commentary line in the log');
    assert.deepEqual(calls[1]!.groundedFact, { n: 1, unmeasured: 2, p50: 80, p90: 80 });
    assert.deepEqual(calls[1]!.fastEvidence, { n: 0, outcomes: {}, p50: null, p90: null });
    assert.deepEqual(calls[1]!.progress, { deliveries: { 'b-task-1': { delivered: 1, closed: 1 } }, reports: {}, corrections: {} });
  }, '');
});

test('VOICE-METRICS: a log line that names no call the store holds is counted unjoined, not dropped', () => {
  const orphans = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', event: 'fast_evidence', outcome: 'hit', elapsedMs: 99 }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', liveSessionId: 'synthetic-call-gone', event: 'commentary_sent', delegationKey: 'synthetic-delegation-gone', reason: 'lookup' }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', liveSessionId: 'synthetic-call-gone', taskId: 'synthetic-task-gone', event: 'task_lifecycle', phase: 'revision', generation: 1, revision: 2, count: 1, ms: 1 }),
  ].join('\n');
  dataDirectory(directory => {
    const { parsed } = metrics(directory);
    assert.deepEqual(parsed.unjoined, { fastEvidence: 1, reports: 1, corrections: 1 },
      'three lines that name no stored call are counted, so an unattributable zero is never read as "not written"');
    const calls = parsed.calls as readonly Record<string, Record<string, unknown>>[];
    assert.deepEqual(calls[1]!.fastEvidence, { n: 0, outcomes: {}, p50: null, p90: null }, 'an orphan line is never given to a call');
  }, `${hostLog}${orphans}\n`);
});
