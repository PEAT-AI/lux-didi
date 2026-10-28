import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLog } from '../host/log.js';
import { LOG_CAUSES, LOG_LEVELS, clearLogContext, setLogContext } from '../host/events.js';
import { attachHostLogSink, hostLogEvent } from '../tools/host-events.js';

// C-LOG-ENVELOPE: one envelope per host.log line, written in HostLog.append from the process-global
// context, so a reader can order a call by monoMs, see how bad a line is, and join it to the live call.

const SESSION = '11111111-2222-4333-8444-555555555555';
type Line = Record<string, unknown> & { event: string; level: string; seq: number; monoMs: number };

async function lines(root: string): Promise<Line[]> {
  const text = await readFile(join(root, 'logs', 'host.log'), 'utf8');
  return text.trim().split('\n').map(line => JSON.parse(line) as Line);
}

test('C-LOG-ENVELOPE: every line carries level, seq, monoMs and the wall clock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-level-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new HostLog(root);
  log.event({ event: 'config_seeded', file: 'providers.json', from: 'provider-config' });
  log.event({ event: 'host_started', releaseCommit: 'unknown', configDir: 'seeded', endpoints: 0 });
  log.event({ event: 'live_attach_rejected', code: 'internal' });
  const records = await lines(root);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.ok(LOG_LEVELS.includes(record.level as never), `${record.event} carries a level`);
    // A line whose name says nothing about its domain carries no cause; when it has one it is closed.
    if ('cause' in record) assert.ok(LOG_CAUSES.includes(record.cause as never), `${record.event} cause is closed`);
    assert.ok(Number.isInteger(record.monoMs) && record.monoMs >= 0, `${record.event} carries monoMs`);
    assert.ok(!Number.isNaN(Date.parse(String(record.timestamp))));
  }
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3], 'seq is one per line, per process');
  assert.ok(records[1]!.monoMs >= records[0]!.monoMs, 'monoMs never goes backwards');
  assert.equal(records[1]!.level, 'info');
  assert.equal(records[1]!.cause, 'host');
  assert.equal(records[2]!.level, 'warn', 'a rejected event is a degradation, not a routine line');
});

test('C-LOG-ENVELOPE: a scripted call stamps its session and generation on every live event', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-call-'));
  const log = new HostLog(root);
  const detach = attachHostLogSink(log);
  t.after(() => { detach(); clearLogContext(); return rm(root, { recursive: true, force: true }); });
  // The live layer opens a call by naming the session it runs in, then emits as usual.
  setLogContext({ liveSessionId: SESSION, generation: 0 });
  hostLogEvent({ event: 'clock_sync', reason: 'call_open' });
  hostLogEvent({ event: 'live_dead_air', deadAirMs: 1200 });
  hostLogEvent({ event: 'live_heard_silence', ms: 900, silence: 'owner' });
  hostLogEvent({ event: 'live_tool_turn', sequence: 1, toolCallsThisTurn: 0, toolLatencyMs: [], toolResponseWhileGenerating: false });
  hostLogEvent({ event: 'gptlive_tool_output', calls: 0, responseCreate: 'sent' });
  log.terminal({ state: 'closed', code: 'voice_stop' });
  const records = await lines(root);
  assert.deepEqual(records.map(record => record.event),
    ['clock_sync', 'live_dead_air', 'live_heard_silence', 'live_tool_turn', 'gptlive_tool_output', 'live_terminal']);
  for (const record of records) {
    assert.equal(record.liveSessionId, SESSION, `${record.event} names the live session`);
    assert.equal(record.generation, 0, `${record.event} names the provider generation`);
    assert.equal('callId' in record, false, 'one live session is one call: there is no second call id');
  }
  detach();
  clearLogContext();
});

test('C-LOG-ENVELOPE: a call context never widens the allowlist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-context-'));
  t.after(() => { clearLogContext(); return rm(root, { recursive: true, force: true }); });
  const log = new HostLog(root);
  // Free text in a context field is refused, exactly as a content field would be.
  setLogContext({ liveSessionId: 'SECRET-session', runId: 'a SECRET run id' });
  log.event({ event: 'config_seeded', file: 'providers.json', from: 'provider-config' });
  const text = await readFile(join(root, 'logs', 'host.log'), 'utf8');
  assert.equal(text.includes('SECRET'), false);
  const [record] = await lines(root);
  assert.equal('liveSessionId' in record!, false);
  assert.equal('runId' in record!, false);
  clearLogContext();
});

test('C-LOG-ENVELOPE: a normal end is info and never host_error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new HostLog(root);
  log.terminal({ state: 'closed', code: 'closed' });
  log.terminal({ state: 'closed', code: 'voice_stop' });
  log.terminal({ state: 'failed', code: 'idle_timeout' });
  log.terminal({ state: 'failed', code: 'protocol_error' });
  log.terminal({ state: 'failed', code: 'SECRET invalid code' });
  const records = await lines(root);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map(record => record.event), ['live_terminal', 'live_terminal', 'live_terminal', 'host_error']);
  assert.deepEqual(records.map(record => record.level), ['info', 'info', 'info', 'error']);
  assert.deepEqual(records.map(record => record.cause), ['owner', 'owner', 'owner', 'host']);
});

test('C-LOG-ENVELOPE: the call context ends with its terminal line', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-after-terminal-'));
  t.after(() => { clearLogContext(); return rm(root, { recursive: true, force: true }); });
  const log = new HostLog(root);
  setLogContext({ liveSessionId: SESSION, generation: 0 });
  log.event({ event: 'live_heard_silence', ms: 10, silence: 'owner' });
  log.terminal({ state: 'closed', code: 'voice_stop' });
  // Nothing after the end of the call belongs to it: the host's own lines are not that call's aftermath.
  log.event({ event: 'host_resources', rssMb: 120, heapUsedMb: 40, cpuPct: 1 });
  const records = await lines(root);
  assert.deepEqual(records.map(record => record.event), ['live_heard_silence', 'live_terminal', 'host_resources']);
  assert.equal(records[0]!.liveSessionId, SESSION, 'the call names itself while it is live');
  assert.equal(records[1]!.liveSessionId, SESSION, 'and its terminal line still names it');
  assert.equal('liveSessionId' in records[2]!, false, 'a line after the terminal belongs to no call');
  assert.equal('generation' in records[2]!, false);
});

test('C-LOG-ENVELOPE: a clock_sync line ties one process clock to wall time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new HostLog(root);
  log.event({ event: 'clock_sync', reason: 'host_start' });
  log.event({ event: 'clock_sync', reason: 'call_open' });
  log.event({ event: 'clock_sync', reason: 'SECRET' });
  const records = await lines(root);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.reason), ['host_start', 'call_open']);
  for (const record of records) assert.ok(Number.isInteger(record.monoMs) && !Number.isNaN(Date.parse(String(record.timestamp))));
});

// C-LOGS11: the turn and the tool call are envelope-shaped ids, so a line joins a turn and a call without a
// timestamp bracket, and a field that would carry a word of anyone's is dropped where it is written.

test('C-LOGS11: every line inside a turn names the turn, and a tool-call line names its call key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-turn-'));
  const log = new HostLog(root);
  const detach = attachHostLogSink(log);
  t.after(() => { detach(); clearLogContext(); return rm(root, { recursive: true, force: true }); });
  setLogContext({ liveSessionId: SESSION, generation: 0, turnId: `${SESSION}:t1` });
  hostLogEvent({ event: 'live_heard_silence', ms: 900 });
  hostLogEvent({ event: 'tool_call_admitted', callKey: 'call:0123456789abcdef', tool: 'gmail_search_messages' });
  hostLogEvent({ event: 'tool_call_dispatched', callKey: 'call:0123456789abcdef', tool: 'gmail_search_messages' });
  hostLogEvent({ event: 'tool_call_outcome', callKey: 'call:0123456789abcdef', tool: 'gmail_search_messages', outcome: 'refused', ms: 12, refusalCode: 'grant_not_permitted' });
  // The turn closes: the next line inside the same call carries no turn.
  setLogContext({ turnId: null });
  hostLogEvent({ event: 'live_heard_silence', ms: 900 });
  const records = await lines(root);
  assert.equal(records.length, 5);
  for (const record of records.slice(0, 4)) assert.equal(record.turnId, `${SESSION}:t1`, `${record.event} names the turn`);
  assert.equal('turnId' in records[4]!, false, 'a line after the turn belongs to no turn');
  // One key across admit, dispatch and outcome: the three lines name one call.
  assert.deepEqual(records.slice(1, 4).map(record => record.callKey), ['call:0123456789abcdef', 'call:0123456789abcdef', 'call:0123456789abcdef']);
  assert.deepEqual([records[3]!.outcome, records[3]!.refusalCode, records[3]!.tool], ['refused', 'grant_not_permitted', 'gmail_search_messages']);
});

test('C-LOGS11: a redaction case over every new field: content and open codes are refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'didi-envelope-redact-'));
  const log = new HostLog(root);
  const detach = attachHostLogSink(log);
  t.after(() => { detach(); clearLogContext(); return rm(root, { recursive: true, force: true }); });
  const secret = 'lunch with Ada at the bridge cafe';
  // A context is never a way in: a free-text turn or call id is dropped, and the line carries neither.
  setLogContext({ liveSessionId: SESSION, turnId: secret });
  hostLogEvent({ event: 'owner_final', ownerFinalAt: 1_792_486_800_500 });
  hostLogEvent({ event: 'owner_final', ownerFinalAt: 1_792_486_800_500, text: secret });
  hostLogEvent({ event: 'live_first_audio', liveSessionId: SESSION, generation: 0, msSinceReady: 10, msSinceOpen: 20, finalToProviderFirstAudioMs: 1_700, missingReason: null });
  hostLogEvent({ event: 'live_first_audio', liveSessionId: SESSION, generation: 0, msSinceReady: 10, msSinceOpen: 20, finalToProviderFirstAudioMs: 1_700, missingReason: 'because she said so' });
  hostLogEvent({ event: 'live_first_audible', finalToAudibleMs: 2_320, missingReason: null });
  hostLogEvent({ event: 'live_first_audible', finalToAudibleMs: secret, missingReason: null });
  hostLogEvent({ event: 'tool_call_admitted', callKey: 'call:ok', tool: secret });
  hostLogEvent({ event: 'tool_call_admitted', callKey: secret, tool: 'gmail_search_messages' });
  hostLogEvent({ event: 'tool_call_outcome', callKey: 'call:ok', tool: 'gmail_search_messages', outcome: 'refused', refusalCode: secret });
  // A code beside an outcome that did not refuse is a contradiction, so it is dropped too.
  hostLogEvent({ event: 'tool_call_outcome', callKey: 'call:ok', tool: 'gmail_search_messages', outcome: 'completed', refusalCode: 'grant_not_permitted' });
  hostLogEvent({ event: 'tool_call_outcome', callKey: 'call:ok', tool: 'gmail_search_messages', outcome: 'refused', refusalCode: 'grant_not_permitted' });
  const records = await lines(root);
  const text = records.map(record => JSON.stringify(record)).join('\n');
  assert.equal(text.includes(secret), false, 'no new field carries a word of anyone');
  assert.deepEqual(records.map(record => record.event), ['owner_final', 'live_first_audio', 'live_first_audible', 'tool_call_outcome']);
  assert.equal(records[0]!.turnId, undefined, 'a free-text turn id is not a turn');
  assert.equal(records[1]!.finalToProviderFirstAudioMs, 1_700);
  assert.deepEqual([records[2]!.finalToAudibleMs, records[2]!.missingReason], [2_320, null]);
  assert.deepEqual([records[3]!.outcome, records[3]!.refusalCode], ['refused', 'grant_not_permitted']);
});
