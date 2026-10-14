import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { HostLog, captureHostDiagnostics, emitHostEvent, setLogContext, eventSchemas } from '../host/log.js';

async function withLog(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-log.'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = new HostLog(dir);
  const stop = captureHostDiagnostics(log);
  t.after(stop);
  return dir;
}

async function readEvents(dir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(dir, 'logs', 'host.log'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

test('every line carries the timestamp, monotonic, level, process and event envelope', async t => {
  setLogContext({});
  const dir = await withLog(t);
  emitHostEvent('live.attempt_start', { attemptId: 'attempt-1', liveSessionId: 'live-1' });
  const [line] = await readEvents(dir);
  assert.ok(line);
  assert.match(String(line.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(typeof line.mono, 'number');
  assert.equal(line.level, 'info');
  assert.equal(line.process, 'host');
  assert.equal(line.event, 'live.attempt_start');
  assert.equal(line.pid, process.pid);
  assert.equal(line.attemptId, 'attempt-1');
  assert.equal(line.liveSessionId, 'live-1');
});

test('a field outside the closed schema is dropped and counted, never written', async t => {
  setLogContext({});
  const dir = await withLog(t);
  emitHostEvent('audio.config', { inputRate: 48000, channels: 1, leaked: 'Re: Q3 planning and hiring' });
  const events = await readEvents(dir);
  const config = events.find(event => event.event === 'audio.config');
  assert.ok(config);
  assert.equal('leaked' in config, false, 'the unknown field is dropped');
  const violation = events.find(event => event.event === 'log.schema_violation');
  assert.ok(violation);
  assert.equal(violation.kind, 'audio.config');
  assert.equal(violation.dropped, 1);
  assert.equal(JSON.stringify(events).includes('Q3 planning'), false, 'no rejected value reaches the log');
});

test('a value that is not a closed enum is dropped and counted', async t => {
  setLogContext({});
  const dir = await withLog(t);
  emitHostEvent('provider.turn', { reason: 'not_a_reason', frames: 1, bytes: 2 });
  const events = await readEvents(dir);
  const turn = events.find(event => event.event === 'provider.turn');
  assert.ok(turn);
  assert.equal('reason' in turn, false);
  assert.equal(turn.frames, 1);
  assert.equal(events.some(event => event.event === 'log.schema_violation' && event.dropped === 1), true);
});

test('no realistic owner content is ever written, whatever field it is offered on', async t => {
  setLogContext({});
  const dir = await withLog(t);
  const fixtures = ['Re: Q3 planning and hiring', 'transcript line one two three', 'chat: hello there friend', 'user@example.com'];
  // Every event kind, every declared field, offered free text: none may reach a byte.
  for (const [kind, schema] of Object.entries(eventSchemas)) {
    const fields: Record<string, unknown> = {};
    for (const field of Object.keys(schema)) fields[field] = fixtures[0]!;
    emitHostEvent(kind, fields);
  }
  emitHostEvent('tool.call_start', { name: fixtures[0]!, toolCallId: 'call-1' });
  emitHostEvent('audio.config', { languageCode: fixtures[3]!, inputRate: 48000 });
  emitHostEvent('live.state_change', { from: fixtures[2]!, to: 'listening' });
  emitHostEvent('host.started', { releaseCommit: fixtures[1]!, configDir: 'seeded', endpoints: 0 });
  const bytes = await readFile(join(dir, 'logs', 'host.log'), 'utf8');
  for (const fixture of fixtures) assert.equal(bytes.includes(fixture), false, `no content for ${fixture.slice(0, 6)}`);
  assert.equal(bytes.includes('planning and hiring'), false);
});

test('the event vocabulary is closed and complete', () => {
  const required = ['host.started', 'host.stop_requested', 'host.exit', 'live.attempt_start', 'live.session_open', 'live.state_change', 'live.reconnect', 'live.session_terminal', 'provider.turn', 'provider.frame_rejected', 'tool.call_start', 'tool.call_end', 'audio.flow', 'audio.config', 'log.schema_violation'];
  for (const kind of required) assert.ok(kind in eventSchemas, `missing schema for ${kind}`);
});

test('call-timeline reconstructs attempt, open, three turns, a tool call, a barge-in, a reconnect and the terminal in order', async t => {
  setLogContext({});
  const dir = await withLog(t);
  setLogContext({ launchId: 'launch-1' });
  const ids = { attemptId: 'attempt-1', liveSessionId: 'live-1', generation: 0 };
  emitHostEvent('host.started', { releaseCommit: 'unknown', configDir: 'seeded', endpoints: 0 });
  emitHostEvent('live.attempt_start', ids);
  emitHostEvent('live.session_open', ids);
  for (const turnSeq of [1, 2, 3]) emitHostEvent('provider.turn', { ...ids, turnSeq, reason: 'turnComplete', frames: turnSeq, bytes: turnSeq * 10 });
  emitHostEvent('tool.call_start', { ...ids, toolCallId: 'call-1', name: 'first' });
  emitHostEvent('tool.call_end', { ...ids, toolCallId: 'call-1', name: 'first', latencyMs: 4, outcome: 'success' });
  emitHostEvent('provider.turn', { ...ids, turnSeq: 4, reason: 'interrupted', frames: 0, bytes: 0 });
  emitHostEvent('live.reconnect', { ...ids, reason: 'go_away', attempt: 1 });
  emitHostEvent('live.session_terminal', { ...ids, code: 'closed' });
  const output = execFileSync(process.execPath, [resolve(import.meta.dirname, '../../../scripts/call-timeline.mjs'), '--last', '--json', '--dir', join(dir, 'logs')], { encoding: 'utf8' });
  const events = (JSON.parse(output) as { event: string }[]).map(entry => entry.event);
  assert.deepEqual(events, ['host.started', 'live.attempt_start', 'live.session_open', 'provider.turn', 'provider.turn', 'provider.turn', 'tool.call_start', 'tool.call_end', 'provider.turn', 'live.reconnect', 'live.session_terminal']);
});
