
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
import type { ToolResult } from '../tasks/results.js';

/** C-REPEAT: what she already said, and what is really running, reach the helper as plain data. */


function fixture(t: TestContext, infer: Infer, execute?: () => Promise<ToolResult>) {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-repeat-synthetic-')), store = new Store(directory);
  const sent: { id: string | null; text: string }[] = [];
  const call = new TaskCall({ provider: 'openai',
    createRuntime: delivery => new TaskRuntime({ store, delivery, infer, timeZone: 'UTC',
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal() }),
      execute: execute ?? (async () => { throw new Error('unexpected fixture tool'); }) }),
    append: (_generation, id, text) => { sent.push({ id, text }); return `c${sent.length}`; },
    respond: () => 'sent', state: () => {} });
  call.socket(1);
  t.after(() => { call.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, store, sent };
}


const progress = { id: 'p1', name: 'report_progress', args: { findings: [{ text: 'The synthetic review is Tuesday.', source: 'calendar: synthetic review' }], still_checking: 'the attendee replies' } };
function deferred() { let resolve!: (value: Inference) => void; let reject!: (error: unknown) => void; const promise = new Promise<Inference>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

test('production runtime emits one sourced partial before final and rejects a duplicate', async t => {
  let step = 0;
  const reached = deferred(), final = deferred();
  const f = fixture(t, async request => {
    try {
    if (step++ === 0) return { text: '', calls: [{ id: 'read1', name: 'calendar_events', args: { start: '2026-11-10T00:00:00Z', end: '2026-11-11T00:00:00Z' } }] };
    if (step === 2) {
      assert.ok(request.tools.some(tool => tool.name === 'report_progress'));
      return { text: '', calls: [progress] };
    }
    if (step === 3) {
      assert.match(JSON.stringify(request.outputs), /delivered/);
      assert.equal(f.store.transaction(tx => tx.get("SELECT state FROM task_deliveries WHERE attempt_id LIKE 'progress:%'"))?.state, 'pending');
      for (let i = 0; i < f.sent.length; i++) { assert.ok(i < 20); f.call.delivery.accepted(`c${i + 1}`); }
      assert.match(f.sent.map(item => item.text).join(' '), /Provisional, still checking the attendee replies:/);
      return { text: '', calls: [{ ...progress, id: 'p2' }] };
    }
    assert.match(JSON.stringify(request.outputs), /already_reported/);
    reached.resolve({ text: '', calls: [] });
    return final.promise;
    } catch (error) { reached.reject(error); throw error; }
  }, async () => ({ status: 'ok', text: 'The synthetic review is Tuesday.', references: [], next_cursor: null, coverage: 'Synthetic calendar record.', repair: null }));
  const pending = f.call.input('Synthetic review question', 1);
  await Promise.race([reached.promise, pending.then(answer => { throw new Error(`Worker settled before reporting progress: ${JSON.stringify(answer.failure)}`); })]);
  // Accept every part of the progress envelope before asking for the final.
  for (let i = 0; i < f.sent.length; i++) f.call.delivery.accepted(`c${i + 1}`);
  const before = f.sent.map(item => item.text).join(' ');
  assert.equal((before.match(/Provisional, still checking/g) ?? []).length, 1);
  assert.match(before, /partial/);
  const progressRows = f.store.transaction(tx => tx.all("SELECT attempt_id,state FROM task_deliveries WHERE attempt_id LIKE 'progress:%'"));
  assert.equal(progressRows.length, 1);
  assert.match(String(progressRows[0]?.attempt_id), /^progress:/);
  assert.equal(progressRows[0]?.state, 'delivered', 'accepted progress uses the existing CHECK-compatible state machine');
  final.resolve({ text: 'Confirmed; synthetic replies are complete.', calls: [] });
  await pending;
  assert.match(f.sent.slice(before ? 1 : 0).map(item => item.text).join(' '), /result/);
});

test('without progress production delivery stays a result', async t => {
  const f = fixture(t, async () => ({ text: 'Synthetic final only.', calls: [] }));
  await f.call.input('Synthetic ask', 1);
  assert.match(f.sent.map(item => item.text).join(' '), /result/);
  assert.doesNotMatch(f.sent.map(item => item.text).join(' '), /Provisional/);
});

test('a superseded inference cannot report progress', async t => {
  const old = deferred(), started = deferred(); let step = 0;
  const f = fixture(t, async () => {
    if (step++ === 0) { started.resolve({ text: '', calls: [] }); return old.promise; }
    return { text: 'Synthetic current answer.', calls: [] };
  });
  const first = f.call.input('Synthetic old ask', 1);
  await started.promise;
  // A correction no longer aborts the running inference (#1016): it is recorded, and the hop's own
  // provider answer is what releases both calls, so the revision's answer settles after this.
  const second = f.call.input('Synthetic revised ask', 1);
  old.resolve({ text: '', calls: [progress] });
  await Promise.all([first, second]);
  assert.doesNotMatch(f.sent.map(item => item.text).join(' '), /Provisional/);
});

// No real time passes: timers run only when the test advances this clock.
function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => now,
    timer(callback: () => void, ms: number) { const id = ++next; timers.set(id, { due: now + ms, callback }); return () => { timers.delete(id); }; },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
    },
    remaining: () => [...timers.values()].map(timer => timer.due - now),
  };
}

import { runWorker } from '../tasks/worker.js';
import type { TaskTool } from '../tasks/tools.js';
import { TaskDelivery } from '../tasks/delivery.js';
const syntheticResult = (): ToolResult => ({ status: 'ok', text: 'Synthetic sourced finding.', references: [], next_cursor: null, coverage: 'Synthetic record.', repair: null });
function reader(run: TaskTool['run']): TaskTool {
  return { name: 'synthetic_read', description: 'Read a synthetic record', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, effect: 'none', outside_text: false, run };
}
const identity = { task_id: 'synthetic-progress-budget', task_revision: 1, connection_generation: 1 };

test('expired revision returns held findings without starting a final inference by 38 seconds', async () => {
  const clock = fakeClock(), fifth = deferred(); let reads = 0, finals = 0, asks = 0;
  const tool = reader(async () => {
    if (++reads === 5) { fifth.resolve({ text: '', calls: [] }); return new Promise(() => {}); }
    clock.advance(8000); return syntheticResult();
  });
  const pending = runWorker({ registry: new Map([[tool.name, tool]]), identity, input: 'Synthetic budget ask', signal: new AbortController().signal, clock,
    infer: async request => {
      if (!request.tools.length) { finals++; return { text: 'Wrong late compose.', calls: [] }; }
      return { text: '', calls: [{ id: `r${++asks}`, name: tool.name, args: { id: String(asks) } }] };
    } });
  await fifth.promise;
  clock.advance(4000);
  const result = await pending;
  assert.equal(result.status, 'incomplete'); assert.equal(result.failure?.reason_code, 'deadline');
  assert.match(result.text, /Synthetic sourced finding/); assert.equal(finals, 0);
  assert.ok(clock.now() <= 38000);
});

test('reads finishing at 30 seconds leave only the last six seconds for final composition', async () => {
  const clock = fakeClock(), composing = deferred(); let asks = 0;
  const tool = reader(async () => { clock.advance(10000); return syntheticResult(); });
  const pending = runWorker({ registry: new Map([[tool.name, tool]]), identity, input: 'Synthetic remaining budget', signal: new AbortController().signal, clock,
    infer: async request => {
      if (!request.tools.length) { composing.resolve({ text: '', calls: [] }); return new Promise(() => {}); }
      if (asks++ === 3) throw new Error('Synthetic inference failure after reads');
      return { text: '', calls: [{ id: `r${asks}`, name: tool.name, args: { id: String(asks) } }] };
    } });
  await composing.promise;
  assert.ok(clock.remaining().includes(6000));
  assert.ok(!clock.remaining().includes(24000));
  clock.advance(6000);
  const result = await pending;
  assert.equal(result.status, 'incomplete'); assert.equal(result.failure?.reason_code, 'deadline');
  assert.equal(clock.now(), 36000);
});

test('final waits behind an unaccepted progress envelope and then delivers as result', () => {
  const sent: string[] = [];
  const delivery = new TaskDelivery({ isCurrent: () => true, append: (_binding, text) => { sent.push(text); return `c${sent.length}`; }, state: () => {} });
  delivery.socket(1);
  delivery.deliver(identity, { progress: true, status: 'incomplete', text: 'Provisional, still checking replies: Tuesday [calendar].', findings: [] });
  delivery.deliver(identity, { status: 'complete', text: 'Synthetic final adds the replies.', findings: [] });
  assert.doesNotMatch(sent.join(' '), /Synthetic final/);
  for (let i = 0; i < sent.length; i++) { assert.ok(i < 20); delivery.accepted(`c${i + 1}`); }
  assert.match(sent.join(' '), /Synthetic final/); assert.match(sent.join(' '), /result/);
});

test('progress requires one to five nonblank sourced findings and a nonblank remaining read', async () => {
  const { REPORT_PROGRESS_TOOL, validateArguments } = await import('../tasks/tools.js');
  assert.equal(validateArguments(REPORT_PROGRESS_TOOL, progress.args).ok, true);
  for (const args of [
    { ...progress.args, findings: [] },
    { ...progress.args, findings: Array.from({ length: 6 }, () => progress.args.findings[0]) },
    { ...progress.args, findings: [{ text: 'A guess', source: ' ' }] },
    { ...progress.args, findings: [{ text: ' ', source: 'calendar: synthetic' }] },
    { ...progress.args, still_checking: ' ' },
  ]) assert.equal(validateArguments(REPORT_PROGRESS_TOOL, args).ok, false);
});

test('a progress report queued while output is busy cannot drain after its revision is stale', () => {
  let current = true;
  const sent: string[] = [];
  const delivery = new TaskDelivery({ isCurrent: () => current, append: (_binding, text) => { sent.push(text); return 'synthetic-command'; }, state: () => {} });
  delivery.socket(1); delivery.activity({ outputQuiet: false, ownerSpeaking: false });
  delivery.deliver(identity, { progress: true, status: 'incomplete', text: 'Provisional, still checking replies: Tuesday [calendar].', findings: [] });
  assert.equal(sent.length, 0);
  current = false;
  delivery.activity({ outputQuiet: true, ownerSpeaking: false });
  assert.equal(sent.length, 0);
});
