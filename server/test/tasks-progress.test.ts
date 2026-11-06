
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { Authority } from '../tasks/authority.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { TaskCall } from '../tasks/call.js';
import { failed } from '../tasks/results.js';
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
function deferred() { let resolve!: (value: Inference) => void; const promise = new Promise<Inference>(done => { resolve = done; }); return { promise, resolve }; }

test('production runtime emits one sourced partial before final and rejects a duplicate', async t => {
  let step = 0;
  const reached = deferred(), final = deferred();
  const f = fixture(t, async request => {
    if (step++ === 0) {
      assert.ok(request.tools.some(tool => tool.name === 'report_progress'));
      return { text: '', calls: [progress] };
    }
    if (step === 2) {
      assert.match(JSON.stringify(request.outputs), /delivered/);
      assert.match(f.sent.map(item => item.text).join(' '), /Provisional, still checking the attendee replies:/);
      return { text: '', calls: [{ ...progress, id: 'p2' }] };
    }
    assert.match(JSON.stringify(request.outputs), /already_reported/);
    reached.resolve({ text: '', calls: [] });
    return final.promise;
  });
  const pending = f.call.input('Synthetic review question', 1);
  await reached.promise;
  // Accept every part of the progress envelope before asking for the final.
  for (let i = 0; i < f.sent.length; i++) f.call.delivery.accepted(`c${i + 1}`);
  const before = f.sent.map(item => item.text).join(' ');
  assert.equal((before.match(/Provisional, still checking/g) ?? []).length, 1);
  assert.match(before, /partial/);
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
  await f.call.input('Synthetic revised ask', 1);
  old.resolve({ text: '', calls: [progress] }); await first;
  assert.doesNotMatch(f.sent.map(item => item.text).join(' '), /Provisional/);
});
