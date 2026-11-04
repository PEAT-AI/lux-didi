import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as memory from '../domain/memory.js';
import type { Inference } from '../tasks/worker.js';
import { taskLiveFixture, flushTaskLive } from './task-live-fixture.js';
test('helper source text stays out of voice context across an in-flight ordinary provider rebuild', async t => {
  const marker = 'SYNTHETIC_RAW_TOOL_ONLY_MARKER';
  let calls = 0, finish: ((value: Inference) => void) | undefined;
  const outputs: string[] = [];
  const f = await taskLiveFixture(t, async request => {
    calls++;
    if (calls === 1) return { text: '', calls: [{ id: 'synthetic-memory-read', name: 'search_memory', args: { query: 'syntheticcontext' } }] };
    outputs.push(JSON.stringify(request.outputs));
    return new Promise<Inference>(resolve => { finish = resolve; });
  });
  const now = Date.now(), clock = { now: () => now };
  f.store.transaction(tx => {
    const session = memory.createSession(tx, { title: 'syntheticcontext', startedAt: now, timeZone: 'UTC' }, clock);
    memory.appendEntry(tx, { sessionId: session.id, text: `syntheticcontext ${marker}`, capturedAt: now, timeZone: 'UTC',
      source: { label: 'synthetic fixture', provider: 'unit-test', accountId: 'synthetic', externalId: 'synthetic-entry', sourceTimestamp: now, availability: 'present', note: 'kind:fact' } }, clock);
  });
  await f.emit({ type: 'inputTranscription', text: 'Find the syntheticcontext note.', finished: true, finalOrigin: 'provider' });
  assert.equal(calls, 2); assert.ok(outputs[0]?.includes(marker), 'the helper actually read the populated source');
  assert.deepEqual(f.appended, []);
  await f.emit({ type: 'goAway', timeLeftMs: 10000 });
  assert.equal(f.requests.length, 2, 'the transport rebuilt while the same helper work remained pending');
  assert.equal(JSON.stringify(f.requests).includes(marker), false, 'raw tool evidence never becomes voice startup context');
  await f.emit({ type: 'delegation', delegationId: 'synthetic-rebuilt-delegation' });
  finish!({ text: 'Synthetic concise answer.', calls: [] }); await flushTaskLive();
  assert.equal(calls, 2, 'a transport rebuild does not restart helper inference');
  assert.deepEqual(f.appended, ['Synthetic concise answer.']);
  await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
  await f.emit({ type: 'outputTranscription', text: 'Synthetic concise answer.', finished: true });
  assert.ok(f.receipts.some(row => row.event === 'task_delivery' && row.state === 'accepted'));
  assert.equal(JSON.stringify(f.receipts).includes(marker), false, 'source bytes never enter the closed audit');
});

test('each finalized helper ask receives a fresh host clock and the owner time zone, not model-guessed time', async t => {
  let now = Date.UTC(2031, 0, 2, 23, 45);
  const inputs: { time_context?: { now_utc: string; owner_time_zone: string } }[] = [];
  const f = await taskLiveFixture(t, async request => {
    inputs.push(JSON.parse(request.input) as typeof inputs[number]);
    return { text: 'Synthetic clock answer.', calls: [] };
  }, { timeZone: 'Asia/Tokyo', now: () => now });
  await f.emit({ type: 'delegation', delegationId: 'synthetic-clock-delegation' });
  await f.emit({ type: 'inputTranscription', text: 'What is today in my time zone?', finished: true, finalOrigin: 'provider' });
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0]!.time_context, { now_utc: '2031-01-02T23:45:00.000Z', owner_time_zone: 'Asia/Tokyo' });
  await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
  await f.emit({ type: 'outputTranscription', text: 'Synthetic clock answer.', finished: true });
  await f.emit({ type: 'goAway', timeLeftMs: 10000 });
  assert.equal(f.requests.length, 2);
  now += 60000;
  await f.emit({ type: 'inputTranscription', text: 'And now?', finished: true, finalOrigin: 'provider' });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[1]!.time_context, { now_utc: '2031-01-02T23:46:00.000Z', owner_time_zone: 'Asia/Tokyo' });
});

test('an unbound finished task appends on the existing host line', async t => {
  const { liveTaskFixture } = await import('./live-task-fixture.js');
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const transitions: { event: string; state?: unknown; trigger?: unknown }[] = [];
  t.after(attachHostLogSink({ event(raw) {
    const value = raw as Record<string, unknown>;
    if (value.event === 'task_delivery' || value.event === 'live_rebuild' || value.event === 'live_provider_open') transitions.push({ event: value.event, state: value.state, trigger: value.trigger });
  } }));
  const f = await liveTaskFixture(t, async () => ({ text: 'The retained synthetic answer.', calls: [] }));
  f.finalize('Give the retained synthetic answer.'); await f.flush();
  assert.equal(f.voice.sessionsOpened, 1, JSON.stringify(transitions));
  assert.equal(f.voice.taskAnswers[0]?.delegationId, null);
});

test('verified helper status reports only a real in-call rebuild and its closed cause', async t => {
  const statuses: { rebuilt: boolean; rebuild_cause: string | null }[] = [];
  const f = await taskLiveFixture(t, async request => {
    statuses.push(JSON.parse(JSON.parse(request.input).verified_status));
    return { text: 'Synthetic status answer.', calls: [] };
  });
  await f.emit({ type: 'inputTranscription', text: 'Synthetic first status ask.', finished: true, finalOrigin: 'provider' });
  assert.equal(statuses[0]!.rebuilt, false); assert.equal(statuses[0]!.rebuild_cause, null);
  await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
  await f.emit({ type: 'goAway', timeLeftMs: 10_000 });
  await f.emit({ type: 'inputTranscription', text: 'Synthetic next status ask.', finished: true, finalOrigin: 'provider' });
  assert.equal(statuses[1]!.rebuilt, true); assert.ok(['host', 'network', 'provider'].includes(statuses[1]!.rebuild_cause!));
  const rebuild = f.receipts.find(event => event.event === 'live_rebuild'); assert.equal(rebuild?.owed, 'nothing_owed');
  const opened = f.receipts.filter(event => event.event === 'live_provider_open').at(-1)!;
  assert.equal(opened.seedChars, (f.requests[1]!.history ?? []).reduce((total, turn) => total + turn.text.length, 0));
});
