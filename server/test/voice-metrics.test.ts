// scripts/didi-voice-metrics: the numbers it prints on a real call.
// Fixture: server/test/fixtures/voice-metrics/{store.json,host.log}. Every id, time and word is invented.
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
function dataDirectory(body: (directory: string) => void): void {
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
    writeFileSync(join(directory, 'logs', 'host.log'), hostLog);
    body(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function metrics(directory: string, ...extra: readonly string[]): { status: number | null; stdout: string; parsed: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [CLI, '--data-dir', directory, '--json', ...extra], { encoding: 'utf8' });
  assert.equal(run.error, undefined, `the script must run: ${String(run.error)}`);
  assert.equal(run.status, 0, `the script must exit 0: ${run.stderr}`);
  return { status: run.status, stdout: run.stdout, parsed: JSON.parse(run.stdout) as Record<string, unknown> };
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
          latency: { n: 1, unmeasured: 1, p50: 300, p90: 300 },
          silence: { n: 1, unmeasured: 0, totalMs: 4800, longestMs: 3500 },
          groundedFact: { n: 1, unmeasured: 1, p50: 80, p90: 80 },
          fastEvidence: { n: 0, outcomes: {}, p50: null, p90: null },
          progress: { deliveries: { 'b-task-1': { delivered: 1, closed: 1 } }, reports: { lookup: 1 }, corrections: { 'b-task-1': 1 } },
        },
      ],
      total: {
        latency: { n: 2, unmeasured: 1, p50: 300, p90: 2500 },
        silence: { n: 2, unmeasured: 0, totalMs: 14300, p50: 4800, p90: 9500, longestMs: 6000, longestP50: 3500, longestP90: 6000 },
        groundedFact: { n: 2, unmeasured: 1, p50: 80, p90: 7000 },
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

test('VOICE-METRICS: a turn the record cannot time is counted unmeasured, never dropped', () => {
  dataDirectory(directory => {
    const { parsed } = metrics(directory, '--session', 'synthetic-call-b');
    const calls = parsed.calls as readonly Record<string, Record<string, number | null>>[];
    assert.equal(calls.length, 1, 'one call is selected');
    assert.deepEqual(calls[0]!.latency, { n: 1, unmeasured: 1, p50: 300, p90: 300 },
      'the second owner turn has no assistant audio, so it is unmeasured and still counted');
    assert.deepEqual(calls[0]!.groundedFact, { n: 1, unmeasured: 1, p50: 80, p90: 80 },
      'no fact reached the owner after the second owner final, so that turn is unmeasured too');
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
