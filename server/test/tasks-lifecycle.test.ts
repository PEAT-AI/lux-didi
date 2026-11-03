import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker } from '../tasks/worker.js';
import { createRegistry } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';
import { documentResult } from '../tasks/results.js';
import { TaskController, FakeDelivery } from '../tasks/controller.js';

test('worker concurrently dedupes identical reads and repairs unknown calls', async () => {
  let executed = 0; let inferred = 0;
  const registry = createRegistry({ execute: async () => { executed++; return documentResult('verified', 'fixture'); }, authority: new FakeAuthority() });
  const result = await runWorker({ registry, identity: { task_id: 't', task_revision: 1, connection_generation: 1 }, input: 'synthetic ask', signal: new AbortController().signal,
    infer: async request => {
      inferred++;
      if (inferred === 1) return { text: '', calls: [{ id: '1', name: 'read_mail', args: { id: 'm', cursor: null } }, { id: '2', name: 'read_mail', args: { cursor: null, id: 'm' } }, { id: '3', name: 'unknown', args: {} }] };
      assert.match(JSON.stringify(request.outputs), /repair/);
      return { text: 'verified answer', calls: [] };
    } });
  assert.equal(executed, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'verified answer');
});
test('revision cancels old inference and stale results cannot deliver or authorize', () => {
  const delivery = new FakeDelivery(); const controller = new TaskController(delivery);
  const old = controller.finalize('first', 1);
  const next = controller.finalize('correction', 1);
  assert.equal(old.signal.aborted, true);
  assert.equal(controller.isCurrent(old.identity), false);
  assert.equal(controller.isCurrent(next.identity), true);
  assert.equal(controller.complete(old.identity, { status: 'complete', text: 'stale', findings: [] }), false);
  assert.equal(controller.complete(next.identity, { status: 'no_action', text: '', findings: [] }), true);
  assert.equal(delivery.answers.length, 1);
  assert.deepEqual(next.ownerWords, ['first', 'correction']);
});

class FakeClock {
  time = 0;
  timers: { at: number; callback: () => void }[] = [];
  now = (): number => this.time;
  timer = (callback: () => void, ms: number): (() => void) => {
    const timer = { at: this.time + ms, callback }; this.timers.push(timer);
    return () => { this.timers = this.timers.filter(item => item !== timer); };
  };
  advance(ms: number): void {
    this.time += ms;
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at)) if (timer.at <= this.time && this.timers.includes(timer)) {
      this.timers = this.timers.filter(item => item !== timer); timer.callback();
    }
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
const identity = { task_id: 't', task_revision: 1, connection_generation: 1 };
test('inference deadline and cancellation abort the provider without a real clock wait', async () => {
  for (const cancel of [false, true]) {
    const clock = new FakeClock(), abort = new AbortController();
    let signal: AbortSignal | undefined;
    const result = runWorker({ registry: new Map(), identity, input: 'fixture', signal: abort.signal, clock,
      infer: async (_request, providerSignal) => { signal = providerSignal; return new Promise(() => {}); } });
    if (cancel) abort.abort(); else clock.advance(12000);
    assert.equal((await result).status, cancel ? 'cancelled' : 'incomplete');
    assert.equal(signal?.aborted, true); assert.equal(clock.timers.length, 0);
  }
});
test('connector expiry stops subsequent admissions and preserves verified reads', async () => {
  const clock = new FakeClock(), entered = deferred<void>();
  let inference = 0;
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async (_name, args) => {
    if (args.id === 'fast') return documentResult('verified fast', 'fast');
    entered.resolve(); return new Promise(() => {});
  } });
  const result = runWorker({ registry, identity, input: 'fixture', signal: new AbortController().signal, clock,
    infer: async () => { inference++; return { text: '', calls: [{ id: '1', name: 'read_mail', args: { id: 'fast', cursor: null } }, { id: '2', name: 'read_mail', args: { id: 'slow', cursor: null } }] }; } });
  await entered.promise;
  // Flush the already-completed read, not a real timer.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  clock.advance(12000);
  const final = await result;
  assert.equal(final.status, 'incomplete'); assert.match(final.text, /verified fast/); assert.equal(inference, 1);
});
test('committed receipts survive correction; old worker cannot admit a write', async () => {
  const controller = new TaskController(new FakeDelivery());
  const old = controller.finalize('first', 1);
  controller.recordReceipt(documentResult('committed', 'receipt'));
  const next = controller.finalize('correction', 1);
  let writes = 0;
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => { writes++; return documentResult('write', 'receipt'); } });
  const result = await registry.get('delete_event')!.run({ id: 'event' }, { ...old.identity, operation_id: 'op' }, old.signal);
  assert.equal(result.status, 'failed'); assert.equal(writes, 0);
  const valid = await registry.get('delete_event')!.run({ id: 'event' }, { ...next.identity, operation_id: 'op2' }, next.signal);
  assert.equal(valid.status, 'ok'); assert.equal(writes, 1); assert.equal(next.receipts.length, 1);
});
test('ambiguous write is not replayed by the worker', async () => {
  let writes = 0, inference = 0;
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => { writes++; throw new Error('fixture lost acknowledgement'); } });
  const final = await runWorker({ registry, identity, input: 'fixture', signal: new AbortController().signal,
    infer: async request => {
      if (inference++ === 0) return { text: '', calls: [{ id: '1', name: 'delete_event', args: { id: 'event' } }] };
      assert.match(JSON.stringify(request.outputs), /Reconcile/); return { text: 'Outcome unverified', calls: [] };
    } });
  assert.equal(writes, 1); assert.equal(final.text, 'Outcome unverified');
});

test('outside text is tracked by the host across inference turns', async () => {
  const authority = new FakeAuthority(); let hop = 0;
  const registry = createRegistry({ authority, execute: async () => documentResult('synthetic outside evidence', 'm') });
  await runWorker({ registry, identity, input: 'fixture', signal: new AbortController().signal, infer: async () => {
    hop++;
    return hop === 1 ? { text: '', calls: [{ id: 'read', name: 'read_mail', args: { id: 'm', cursor: null } }] } : hop === 2 ? { text: '', calls: [{ id: 'write', name: 'delete_event', args: { id: 'e' } }] } : { text: 'done', calls: [] };
  } });
  assert.equal(authority.requests[0]?.outside_text, true);
});
