import { ProviderError } from '../tasks/model.js';
import { attachHostLogSink } from '../tools/host-events.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker, INFERENCE_DEADLINE_MS } from '../tasks/worker.js';
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
    if (cancel) abort.abort(); else clock.advance(INFERENCE_DEADLINE_MS);
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
    infer: async request => { if (++inference > 1) { assert.equal(request.tools.length, 0); return { text: 'verified fast; slow read did not finish', calls: [] }; } return { text: '', calls: [{ id: '1', name: 'read_mail', args: { id: 'fast', cursor: null } }, { id: '2', name: 'read_mail', args: { id: 'slow', cursor: null } }] }; } });
  await entered.promise;
  // Flush the already-completed read, not a real timer.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  clock.advance(12000);
  const final = await result;
  assert.equal(final.status, 'incomplete'); assert.match(final.text, /verified fast/); assert.equal(inference, 2);
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
  assert.equal(final.receipts?.[0]?.receipt?.state, 'unknown');
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

test('no hop cap and the revision deadline is independent of individual call deadlines', async () => {
  let hops = 0;
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => documentResult('verified', 'm') });
  const complete = await runWorker({ registry, identity, input: 'fixture', signal: new AbortController().signal,
    infer: async () => ++hops > 30 ? { text: 'thirty hops complete', calls: [] } : { text: '', calls: [{ id: String(hops), name: 'read_mail', args: { id: 'm', cursor: null } }] } });
  assert.equal(complete.status, 'complete'); assert.equal(hops, 31);
  const clock = new FakeClock(); hops = 0;
  const expired = await runWorker({ registry, identity, input: 'fixture', signal: new AbortController().signal, clock,
    infer: async () => { clock.advance(11000); return { text: '', calls: [{ id: String(++hops), name: 'read_mail', args: { id: 'm', cursor: null } }] }; } });
  assert.equal(expired.status, 'incomplete'); assert.equal(hops, 4); assert.match(expired.text, /verified/);
});

test('controller captures host owner turn and immediately preceding task words', () => {
  const delivery = new FakeDelivery(); let ids = 0;
  const controller = new TaskController(delivery, () => `t${++ids}`);
  const first = controller.finalize('Read the synthetic note', 1, 10);
  assert.equal(first.ownerTurn, 10);
  controller.complete(first.identity, { status: 'complete', text: 'Read.', findings: [] });
  const second = controller.finalize('Save it', 1, 11);
  assert.equal(second.precedingOwnerWords, 'Read the synthetic note');
  assert.equal(second.ownerTurn, 11);
  const revised = controller.finalize('Use the other title', 1, 12);
  assert.equal(revised.precedingOwnerWords, 'Read the synthetic note');
  assert.equal(revised.ownerTurn, 12);
  assert.equal(controller.taskContext(second.identity.task_id)?.ownerWords, 'Save it\nUse the other title');
});


for (const mode of ['inference failure', 'deadline expiry', 'no action'] as const) test(`R24 EF6: partial evidence with ${mode} is honest and no_action stays silent`, async () => {
  let now = 0, inferred = 0, expireRevision = () => {};
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => {
    return documentResult('Verified partial synthetic finding.', 'synthetic-read');
  } });
  const result = await runWorker({ registry, identity: { task_id: 'partial-fixture', task_revision: 1, connection_generation: 1 },
    input: 'Read the synthetic source', signal: new AbortController().signal,
    clock: { now: () => now, timer: (callback, ms) => { if (ms === 36000) expireRevision = callback; return () => {}; } }, infer: async () => {
      if (!inferred++) return { text: '', calls: [{ id: 'synthetic-read', name: 'search_insights', args: { query: 'synthetic' , mode: null } }] };
      if (mode === 'no action') return { text: '', calls: [], no_action: true };
      if (mode === 'deadline expiry') { now = 36001; expireRevision(); return { text: '', calls: [] }; }
      throw Error('synthetic inference failure');
    } });
  assert.equal(result.findings.length, 1); assert.match(result.findings[0]!.text, /Verified partial synthetic finding/);
  if (mode === 'no action') { assert.equal(result.status, 'no_action'); assert.equal(result.text, ''); }
  else { assert.equal(result.status, 'incomplete'); assert.match(result.text, /Verified partial synthetic finding/);
    assert.equal(result.status, 'incomplete', 'partial evidence never claims task completion'); }
});

test('provider rejection is a typed empty result and emits its closed diagnostic', async () => {
  const events: Record<string, unknown>[] = [], clock = new FakeClock();
  const detach = attachHostLogSink({ event: event => { events.push(event as Record<string, unknown>); } });
  try {
    const result = await runWorker({ registry: new Map(), identity, input: 'fixture', signal: new AbortController().signal, clock,
      infer: async () => { throw new ProviderError('provider_rejected', 'uniqueItems is not permitted', 400); } });
    assert.equal(result.status, 'incomplete'); assert.equal(result.text, '');
    assert.deepEqual(result.failure, { stage: 'inference', reason_code: 'provider_rejected', detail: 'uniqueItems is not permitted' });
    const event = events.find(event => event.event === 'task_inference_failed');
    assert.equal(event?.status, 400); assert.equal(event?.reason_code, 'provider_rejected');
    assert.equal(event?.elapsed_ms, 0); assert.equal(clock.timers.length, 0);
  } finally { detach(); }
});
