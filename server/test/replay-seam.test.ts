import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = process.env['DIDI_TEST_SOURCE_ROOT'] ?? resolve(process.cwd(), 'test');
const script = resolve(root, '../../scripts/didi-replay-seam');
const { classifyTiming } = require(script);
const fixture = JSON.parse(readFileSync(resolve(root, 'fixtures/replay-seam/events.json'), 'utf8'));
test('retrieval after first audio is late, not early; retrieval before it is early', () => {
  assert.deepEqual(fixture.map(classifyTiming), ['late', 'early']);
});
test('missing timestamps never imply retrieval was early', () => {
  assert.equal(classifyTiming({ first_audio_at: 1500 }), 'missing:retrieval_returned_at');
  assert.equal(classifyTiming({ retrieval_returned_at: 1400 }), 'missing:first_audio_at');
  assert.equal(classifyTiming({ owner_final_at: 1600, first_audio_at: 1500, retrieval_returned_at: 1700 }), 'invalid:first_audio_before_owner_final');
});
test('CLI joins synthetic SQLite and host events read-only and marks late and early', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-seam-'));
  try {
    mkdirSync(join(dir, 'logs'));
    const db = new DatabaseSync(join(dir, 'state.sqlite'));
    db.exec(`CREATE TABLE trace_turn(turn_id TEXT,live_session_id TEXT,turn_index INTEGER,origin TEXT,opened_at INTEGER,first_audible_at INTEGER);
      CREATE TABLE trace_utterance(turn_id TEXT,role TEXT,at INTEGER,final INTEGER,text TEXT);
      CREATE TABLE trace_response(response_key TEXT,live_session_id TEXT,turn_id TEXT,created_at INTEGER);
      CREATE TABLE tasks(task_id TEXT,live_session_id TEXT);
      CREATE TABLE task_operations(operation_id TEXT,task_id TEXT,task_revision INTEGER,tool TEXT,created_at INTEGER,updated_at INTEGER,state TEXT,result TEXT);
      CREATE TABLE task_deliveries(task_id TEXT,task_revision INTEGER,state TEXT,updated_at INTEGER);
      CREATE TABLE tool_calls(execution_id TEXT,run_id TEXT,state TEXT,intent_json TEXT,created_at INTEGER);`);
    const logs = fixture.map((r: Record<string, any>, i: number) => {
      const turn = `turn-${i}`, task = `task-${i}`;
      db.prepare('INSERT INTO trace_turn VALUES(?,?,?,?,?,?)').run(turn, 'synthetic', i, 'owner', r.owner_final_at, r.first_audio_at);
      db.prepare('INSERT INTO trace_utterance VALUES(?,?,?,?,?)').run(turn, 'owner', r.owner_final_at, 1, r.owner_words);
      db.prepare('INSERT INTO tasks VALUES(?,?)').run(task, i ? 'synthetic' : null);
      db.prepare('INSERT INTO task_operations VALUES(?,?,?,?,?,?,?,?)').run(`op-${i}`, task, 1, i ? 'search_memory' : 'conversation_history', r.retrieval_started_at, r.retrieval_returned_at, 'committed', JSON.stringify({ records: i ? [] : [{ text: 'Synthetic kite' }] }));
      db.prepare('INSERT INTO task_operations VALUES(?,?,?,?,?,?,?,?)').run(`unrelated-revision-${i}`, task, 2, 'search_memory', 1, 2, 'committed', '{}');
      return [
        { event: 'task_lifecycle', phase: 'start', revision: 1, liveSessionId: 'synthetic', turnId: turn, taskId: task, timestamp: new Date(r.helper_started_at).toISOString() },
        { event: 'task_delivery', state: 'accepted', revision: 1, liveSessionId: 'synthetic', taskId: task, timestamp: new Date(i ? 2300 : 1700).toISOString() },
      ].map(e => JSON.stringify(e)).join('\n');
    });
    db.close();
    writeFileSync(join(dir, 'logs/host.log'), logs.join('\n'));
    const before = readFileSync(join(dir, 'state.sqlite'));
    const result = spawnSync(process.execPath, [script, '--data-dir', dir, 'synthetic', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.rows.map((r: any) => r.timing), ['late', 'early']);
    assert.equal(output.rows[0].response_create_at, 'missing:response_create_at');
    assert.deepEqual(output.rows.map((r: any) => r.retrievals[0].result), ['found', 'empty']);
    assert.deepEqual(output.rows.map((r: any) => r.retrievals.length), [1, 1], 'another revision must never be attributed to this turn');
    assert.deepEqual(output.rows.map((r: any) => r.owner_final_to_first_audio_ms), [500, 500]);
    assert.deepEqual(output.rows.map((r: any) => r.helper_start_to_first_commentary_ms), [600, 200]);
    assert.deepEqual(output.rows.map((r: any) => r.audio_preceded_first_commentary), [true, false]);
    assert.deepEqual(output.rows.map((r: any) => r.delegation_created_at), ['missing:delegation_created_at', 'missing:delegation_created_at'], 'helper start must not invent delegation creation');
    assert.equal(output.measured_cued_turns, 2);
    assert.equal(output.median_ms, 0);
    assert.equal(output.p90_ms, 100);
    assert.deepEqual(readFileSync(join(dir, 'state.sqlite')), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
