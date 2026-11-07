import { ProviderError } from '../tasks/model.js';
import { attachHostLogSink } from '../tools/host-events.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker, INFERENCE_DEADLINE_MS, type Infer, type Inference, type InferRequest, type WorkerResult } from '../tasks/worker.js';
import { createRegistry, type TaskTool } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';
import { documentResult } from '../tasks/results.js';
import { TaskController, FakeDelivery, type Revision } from '../tasks/controller.js';
import { projectTaskPayload } from '../tasks/connectors.js';

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
      if (!inferred++) return { text: '', calls: [{ id: 'synthetic-read', name: 'search_knowledge', args: { query: 'synthetic' , mode: null } }] };
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

/** The runtime's half of the revision policy: the hop is in flight and his words wait for its boundary. */
function hopWork(options: { controller: TaskController; revision: Revision; registry: Map<string, TaskTool>; infer: Infer; clock: FakeClock }): Promise<WorkerResult> {
  const { controller, revision, registry, infer, clock } = options;
  const latest = (): string => {
    const context = controller.taskContext(revision.identity.task_id);
    return JSON.stringify({ owner_words_in_order: context?.ownerWords ?? '', latest: context?.latestOwnerWords ?? '' });
  };
  controller.hop(true);
  return runWorker({ registry, identity: revision.identity, input: latest(), signal: revision.signal, clock, infer, reads: revision.reads,
    pending: () => controller.pending,
    reconcile: () => controller.reconcile() ? { input: latest(), elapsed: 0 } : undefined,
  }).finally(() => controller.hop(false));
}
const memoryRegistry = (executed: string[]) => createRegistry({ authority: new FakeAuthority(),
  execute: async name => { executed.push(name); return documentResult('synthetic memory entry', 'memory:1'); } });

test('a final that arrives mid-hop finishes the hop, caches its read and answers the latest whole', async () => {
  const delivery = new FakeDelivery(), controller = new TaskController(delivery, () => 'synthetic-task');
  const executed: string[] = [], seen: InferRequest[] = [], firstHop = deferred<Inference>();
  const registry = memoryRegistry(executed);
  const infer: Infer = request => { seen.push(request); return seen.length === 1 ? firstHop.promise : Promise.resolve({ text: 'synthetic answer', calls: [] }); };
  const first = controller.finalize('synthetic first words', 1);
  const work = hopWork({ controller, revision: first, registry, infer, clock: new FakeClock() });
  controller.finalize('synthetic correction words', 1);
  assert.equal(first.signal.aborted, false);
  firstHop.resolve({ text: '', calls: [
    { id: 'read', name: 'search_memory', args: { query: 'synthetic' } },
    { id: 'write', name: 'remember_note', args: { text: 'synthetic note' } },
  ] });
  const answer = await work;
  assert.equal(answer.status, 'complete');
  assert.deepEqual(executed, ['search_memory']);
  assert.equal(seen.length, 2);
  assert.match(seen[0]!.input, /synthetic first words/);
  assert.match(seen[1]!.input, /synthetic first words/); assert.match(seen[1]!.input, /synthetic correction words/);
  assert.equal(first.reads.size, 1);
  assert.equal(controller.isCurrent(first.identity), true);
  controller.complete(first.identity, answer);
  assert.equal(delivery.answers.length, 1);
  assert.equal(delivery.answers[0]!.identity.task_revision, 2);
});

test('his correction mid-hop is never answered with the stale result', async () => {
  const delivery = new FakeDelivery(), controller = new TaskController(delivery, () => 'synthetic-task');
  const seen: InferRequest[] = [], firstHop = deferred<Inference>();
  const infer: Infer = request => { seen.push(request); return seen.length === 1 ? firstHop.promise : Promise.resolve({ text: 'synthetic answer for the latest whole', calls: [] }); };
  const first = controller.finalize('which synthetic record', 1);
  const work = hopWork({ controller, revision: first, registry: new Map(), infer, clock: new FakeClock() });
  controller.finalize('the other synthetic record', 1);
  firstHop.resolve({ text: 'synthetic answer about the first record', calls: [] });
  const answer = await work;
  controller.complete(first.identity, answer);
  assert.equal(delivery.answers.length, 1);
  assert.match(delivery.answers[0]!.answer.text, /latest whole/);
  assert.doesNotMatch(delivery.answers[0]!.answer.text, /first record/);
});

test('five finals in eleven seconds keep one hop in flight and deliver once', async () => {
  const delivery = new FakeDelivery(), controller = new TaskController(delivery, () => 'synthetic-task'), clock = new FakeClock();
  const executed: string[] = [], seen: InferRequest[] = [], firstHop = deferred<Inference>();
  let inFlight = 0, peak = 0;
  const infer: Infer = request => {
    seen.push(request); inFlight++; peak = Math.max(peak, inFlight);
    const answer = seen.length === 1 ? firstHop.promise : Promise.resolve<Inference>({ text: 'synthetic answer', calls: [] });
    return answer.then(value => { inFlight--; return value; });
  };
  const first = controller.finalize('synthetic piece one', 1);
  const work = hopWork({ controller, revision: first, registry: memoryRegistry(executed), infer, clock });
  for (const piece of ['synthetic piece two', 'synthetic piece three', 'synthetic piece four', 'synthetic piece five']) {
    clock.advance(2200); controller.finalize(piece, 1);
    await Promise.resolve();
  }
  firstHop.resolve({ text: '', calls: [{ id: 'read', name: 'search_memory', args: { query: 'synthetic' } }] });
  const answer = await work;
  assert.equal(peak, 1);
  assert.equal(seen.length, 2);
  for (const piece of ['one', 'two', 'three', 'four', 'five']) assert.match(seen[1]!.input, new RegExp(`synthetic piece ${piece}`));
  controller.complete(first.identity, answer);
  assert.equal(delivery.answers.length, 1);
  assert.equal(delivery.answers[0]!.identity.task_revision, 5);
});

test('the inference deadline still ends a stuck hop while his words wait', async () => {
  const controller = new TaskController(new FakeDelivery(), () => 'synthetic-task'), clock = new FakeClock();
  const first = controller.finalize('synthetic ask', 1);
  const work = hopWork({ controller, revision: first, registry: new Map(), infer: async () => new Promise(() => {}), clock });
  controller.finalize('synthetic correction', 1);
  clock.advance(INFERENCE_DEADLINE_MS);
  const answer = await work;
  assert.equal(answer.status, 'incomplete');
  assert.equal(answer.failure?.reason_code, 'deadline');
});

test('the revision deadline re-anchors on his latest final', async () => {
  const controller = new TaskController(new FakeDelivery(), () => 'synthetic-task'), clock = new FakeClock();
  const executed: string[] = [], firstHop = deferred<Inference>(), secondHop = deferred<Inference>(), secondHopStarted = deferred<void>();
  let hop = 0;
  const infer: Infer = () => (++hop === 1 ? firstHop.promise : (secondHopStarted.resolve(), secondHop.promise));
  const first = controller.finalize('synthetic ask', 1);
  const work = hopWork({ controller, revision: first, registry: memoryRegistry(executed), infer, clock });
  clock.advance(20000);
  controller.finalize('synthetic correction', 1);
  firstHop.resolve({ text: '', calls: [{ id: 'read', name: 'search_memory', args: { query: 'synthetic' } }] });
  await secondHopStarted.promise;
  clock.advance(20000);
  secondHop.resolve({ text: 'synthetic answer', calls: [] });
  const answer = await work;
  assert.deepEqual(executed, ['search_memory']);
  assert.equal(answer.status, 'complete');
});

test('the read cache holds the obsolete hop reads and the next hop reuses them', async () => {
  const controller = new TaskController(new FakeDelivery(), () => 'synthetic-task');
  const executed: string[] = [], seen: InferRequest[] = [], firstHop = deferred<Inference>();
  const read = { id: 'read', name: 'search_memory', args: { query: 'synthetic' } };
  const infer: Infer = request => { seen.push(request); return seen.length === 1 ? firstHop.promise : Promise.resolve(seen.length === 2 ? { text: '', calls: [read] } : { text: 'synthetic answer', calls: [] }); };
  const first = controller.finalize('synthetic first words', 1);
  const work = hopWork({ controller, revision: first, registry: memoryRegistry(executed), infer, clock: new FakeClock() });
  controller.finalize('synthetic correction words', 1);
  firstHop.resolve({ text: '', calls: [read] });
  const answer = await work;
  assert.equal(answer.status, 'complete');
  assert.deepEqual(executed, ['search_memory']);
  assert.equal(first.reads.size, 1);
});

test('a write from an obsolete hop is fenced and the next hop runs it once', async () => {
  const controller = new TaskController(new FakeDelivery(), () => 'synthetic-task');
  const executed: string[] = [], seen: InferRequest[] = [], firstHop = deferred<Inference>();
  const write = { id: 'write', name: 'remember_note', args: { text: 'synthetic note' } };
  const infer: Infer = request => { seen.push(request); return seen.length === 1 ? firstHop.promise : Promise.resolve(seen.length === 2 ? { text: '', calls: [{ ...write, id: 'write-again' }] } : { text: 'synthetic answer', calls: [] }); };
  const first = controller.finalize('remember a synthetic note', 1);
  const work = hopWork({ controller, revision: first, registry: memoryRegistry(executed), infer, clock: new FakeClock() });
  controller.finalize('remember a synthetic note about the other record', 1);
  firstHop.resolve({ text: '', calls: [write] });
  const answer = await work;
  assert.deepEqual(executed, ['remember_note']);
  const fenced = seen[1]!.outputs.find(output => output.name === 'remember_note');
  assert.equal(fenced?.result.status, 'failed');
  assert.equal(fenced?.result.receipt, undefined);
  assert.equal(answer.receipts?.length, 1);
  assert.equal(answer.receipts?.[0]?.receipt?.state, 'committed');
});

test('#901: the final composition draws from the same revision deadline and never outlives it', async () => {
  const clock = new FakeClock();
  const startAt = clock.now();
  const hub = new FakeAuthority();
  const registry = createRegistry({ authority: hub, execute: async () => documentResult('Thursday 5 November 09:00 CET is free', 'plan:1') });
  let hopSeen = 0, finalSignal: AbortSignal | undefined, finalStarted!: () => void;
  const composing = new Promise<void>(resolve => { finalStarted = resolve; });
  const work = runWorker({ registry, identity, input: 'synthetic request', signal: new AbortController().signal, clock,
    infer: async (request, signal): Promise<Inference> => {
      if (request.tools.length > 0) {
        hopSeen += 1;
        // The hop spends 30 of the 36 s: only 6 s of the revision budget are left for the composition.
        clock.advance(30_000);
        return { text: '', calls: [{ id: '1', name: 'read_mail', args: { id: 'm', cursor: null } }] };
      }
      finalSignal = signal; finalStarted();
      return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('final stopped')), { once: true }); });
    } });
  await composing;
  assert.equal(hopSeen, 1);
  // 6 s are left, so a composition still pending one millisecond before the budget cannot be the 24 s timer.
  clock.advance(5_999);
  assert.equal(finalSignal?.aborted, false, 'the composition keeps working while the budget has room');
  clock.advance(1);
  const answer = await work;
  assert.equal(finalSignal?.aborted, true, 'the composition stops when the revision budget is spent');
  assert.ok(clock.now() - startAt <= 36_000, `the revision settled at ${clock.now() - startAt} ms, over the 36 s budget`);
  assert.equal(answer.status, 'incomplete');
  assert.equal(answer.failure?.stage, 'final');
  assert.equal(answer.failure?.reason_code, 'deadline');
});

test('#902: a completed calendar read with no events list is an honest empty, not an invalid result', () => {
  const window = { start: '2026-11-05T00:00:00+01:00', end: '2026-11-06T00:00:00+01:00' };
  const envelope = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ data, coverage: { complete: true } }) }] });
  // The shapes a completed calendar read comes back in when the window holds nothing: the helper either
  // omits the events key or answers with the calendar list it walked, and neither is a malformed result.
  for (const data of [{}, { events: null }, { calendars: [{ id: 'primary', primary: true }] }]) {
    const result = projectTaskPayload('calendar_events', envelope(data), window);
    assert.equal(result.status, 'empty', 'an empty window is empty, not a failure');
    assert.equal(result.reason_code, undefined, 'an honest empty must not borrow the invalid_result code');
    assert.equal(result.failure_category, undefined);
    assert.match(result.text, /No calendar events between 2026-11-05T00:00:00\+01:00 and 2026-11-06T00:00:00\+01:00/u);
    assert.match(result.coverage, /returned no events for 2026-11-05/u);
  }
  // The guard this narrowed around still stands: a mail page with no recognized list is a real failure.
  const mail = projectTaskPayload('search_mail', envelope({ nothing: true }), {});
  assert.equal(mail.status, 'failed');
  assert.equal(mail.reason_code, 'invalid_result');
});
