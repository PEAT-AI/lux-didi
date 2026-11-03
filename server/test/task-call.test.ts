import './live-declarations.test.js';
import './task-unbounded-projection.test.js';
import './task-draft-chat.test.js';
import './task-live-correction.test.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { Authority } from '../tasks/authority.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { TaskCall } from '../tasks/call.js';
import type { Infer, Inference } from '../tasks/worker.js';
function fixture(t: TestContext, infer: Infer, provider: 'openai' | 'gemini' = 'openai') {
  const directory = mkdtempSync(join(tmpdir(), 'task-call-synthetic-')), store = new Store(directory);
  const sent: { id: string; text: string }[] = [], responses: unknown[] = []; let reconnects = 0;
  const call = new TaskCall({ provider,
    createRuntime: delivery => new TaskRuntime({ store, delivery, infer, contentAllowed: () => true,
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal(() => true) }), execute: async () => { throw new Error('unexpected fixture tool'); } }),
    append: (_generation, id, text) => { sent.push({ id, text }); return `c${sent.length}`; },
    respond: (_generation, values) => { responses.push(values); return 'sent'; },
    reconnect: () => { reconnects++; return true; }, state: () => {},
  });
  call.socket(1); t.after(() => { call.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, sent, responses, reconnects: () => reconnects };
}
function deferred() { let resolve!: (value: Inference) => void; const promise = new Promise<Inference>(done => { resolve = done; }); return { promise, resolve }; }
test('delegation before final input and duplicates do not start a worker', async t => {
  let inference = 0; const f = fixture(t, async () => { inference++; return { text: 'Synthetic answer.', calls: [] }; });
  f.call.delegation('d1'); f.call.delegation('d1'); assert.equal(inference, 0);
  await f.call.input('Synthetic request', 1); assert.equal(inference, 1);
  assert.deepEqual(f.sent, [{ id: 'd1', text: 'Synthetic answer.' }]);
});
test('a socket rebuild does not abort a running task', async t => {
  const pending = deferred(); let signal: AbortSignal | undefined;
  const f = fixture(t, async (_request, abort) => { signal = abort; return pending.promise; });
  const running = f.call.input('Synthetic request', 1);
  f.call.socket(2); f.call.delegation('new-socket');
  assert.equal(signal?.aborted, false); pending.resolve({ text: 'Completed after rebuild.', calls: [] }); await running;
  assert.deepEqual(f.sent, [{ id: 'new-socket', text: 'Completed after rebuild.' }]);
});
test('a correction suppresses the stale worker answer', async t => {
  const first = deferred(); let inference = 0;
  const f = fixture(t, async () => ++inference === 1 ? first.promise : { text: 'Corrected answer.', calls: [] });
  f.call.delegation('d1'); const stale = f.call.input('First request', 1);
  await f.call.input('Correction', 2); first.resolve({ text: 'Stale answer.', calls: [] }); await stale;
  assert.deepEqual(f.sent, [{ id: 'd1', text: 'Corrected answer.' }]);
});
test('no delegation still executes finalized input and uses the finished-result reconnect', async t => {
  const f = fixture(t, async () => ({ text: 'Synthetic answer.', calls: [] }));
  await f.call.input('Synthetic request', 1); assert.equal(f.reconnects(), 1);
  assert.equal(f.call.reconnectAnswer()?.text, 'Synthetic answer.');
});
test('Gemini delegate attaches to the finalized task and carries its spoken answer', async t => {
  let inference = 0; const f = fixture(t, async () => { inference++; return { text: 'Synthetic spoken answer.', calls: [] }; }, 'gemini');
  f.call.functions([{ id: 'fn1', name: 'delegate', args: { request: 'Model words are not the owner request' } }]);
  assert.equal(inference, 0); await f.call.input('Actual finalized owner words', 1);
  assert.deepEqual(f.responses, [[{ id: 'fn1', name: 'delegate', response: { status: 'complete', text: 'Synthetic spoken answer.' } }]]);
  assert.equal(f.sent.length, 0); assert.equal(f.reconnects(), 0);
});
