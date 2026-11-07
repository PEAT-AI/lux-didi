import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, REVISION_DEADLINE_MS, type Clock } from '../tasks/worker.js';
import { documentResult, type ToolResult } from '../tasks/results.js';
import type { TaskTool } from '../tasks/tools.js';
import { TaskCall } from '../tasks/call.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { Authority } from '../tasks/authority.js';
import { Store } from '../runtime/store.js';

function clock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  const port: Clock = { now: () => now, timer: (callback, ms) => { timers.set(callback, now + ms); return () => { timers.delete(callback); }; } };
  return { port, deadline() { now = REVISION_DEADLINE_MS; for (const [callback, due] of [...timers]) if (due <= now && timers.delete(callback)) callback(); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function tool(name: string, run: TaskTool['run']): TaskTool {
  return { name, description: 'Synthetic pending-write boundary', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'none', outside_text: false, run };
}

test('voice delivery reports an unresolved vault request as pending at the revision deadline, never as saved', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-vault-pending-')), store = new Store(directory);
  const time = clock(), started = deferred<void>(), completion = deferred<ToolResult>(), finished = deferred<void>();
  const sent: string[] = [];
  const call = new TaskCall({ provider: 'openai', createRuntime: delivery => {
    const runtime = new TaskRuntime({ store, delivery, clock: time.port, timeZone: 'UTC',
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal() }),
      execute: async () => { throw Error('unexpected synthetic executor'); },
      infer: async () => ({ text: '', calls: [{ id: 'synthetic-write', name: 'vault_save', args: {} }] }) });
    runtime.registry.set('vault_save', tool('vault_save', async () => { started.resolve(); const result = await completion.promise; finished.resolve(); return result; }));
    return runtime;
  }, append: (_generation, _id, text) => { sent.push(text); return `synthetic-${sent.length}`; }, respond: () => 'sent', state: () => {} });
  call.socket(1);
  t.after(() => { call.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = call.input('Synthetic owner asks for a vault save', 1);
  await started.promise;
  time.deadline();
  await request;
  assert.ok(sent.some(text => /pending/i.test(text)), 'pending must reach the actual voice delivery surface');
  assert.ok(sent.some(text => /not confirmed saved/i.test(text)), 'no success claim before the transport receipt');
  completion.resolve(documentResult('{"disposition":"created","insight_id":42}', 'vault-receipt'));
  await finished.promise;
});

test('an unrelated connector still times out without a vault pending receipt', async () => {
  const time = clock(), started = deferred<void>(), completion = deferred<ToolResult>();
  const other = tool('synthetic_other_connector', async () => { started.resolve(); return completion.promise; });
  const request = runWorker({ registry: new Map([[other.name, other]]), identity: { task_id: 'synthetic-task', task_revision: 1, connection_generation: 1 },
    input: 'Synthetic read', signal: new AbortController().signal, clock: time.port,
    infer: async () => ({ text: '', calls: [{ id: 'synthetic-read', name: other.name, args: {} }] }) });
  await started.promise;
  time.deadline();
  const result = await request;
  assert.equal(result.status, 'incomplete');
  assert.doesNotMatch(result.text, /vault|pending/i);
  completion.resolve(documentResult('Synthetic late read', other.name));
});
