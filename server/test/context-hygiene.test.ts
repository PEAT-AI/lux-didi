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
  assert.ok(f.receipts.some(row => row.event === 'task_delivery' && row.state === 'heard'));
  assert.equal(JSON.stringify(f.receipts).includes(marker), false, 'source bytes never enter the closed audit');
});
