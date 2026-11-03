import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { safeEvent } from '../host/log.js';
test('task content gating, receipts, final answer, delivery and pruning use Store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-store-fixture-'));
  const store = new Store(directory);
  try {
    const identity = { task_id: 'fixture', task_revision: 1, connection_generation: 2 };
    const now = 1800000000000;
    store.saveTaskRevision(identity, ['synthetic owner words'], [], false, now);
    assert.equal(store.transaction(tx => tx.get('SELECT owner_words FROM task_revisions'))?.owner_words, null);
    const second = { ...identity, task_revision: 2 };
    store.saveTaskRevision(second, ['synthetic correction'], [], true, now);
    const operation = { ...second, operation_id: 'op', tool: 'delete_event', effect: 'destructive', state: 'pending' as const, args: { id: 'fixture-event' }, result: null };
    store.saveTaskOperation(operation, true, now);
    store.saveTaskOperation({ ...operation, state: 'committed', result: { status: 'ok' } }, true, now);
    assert.equal(store.transaction(tx => tx.get('SELECT state FROM task_receipts'))?.state, 'committed');
    assert.equal(store.finishTask(identity, 'complete', 'stale', true, now), false);
    assert.equal(store.finishTask(second, 'complete', 'synthetic answer', true, now), true);
    store.saveTaskDelivery(second, 'binding', 'delivered', now);
    assert.equal(store.transaction(tx => tx.get('SELECT state FROM task_deliveries'))?.state, 'delivered');
    store.pruneTasks(now + 31 * 86400000);
    assert.equal(store.transaction(tx => tx.get('SELECT result FROM task_operations'))?.result, null);
    assert.equal(store.transaction(tx => tx.get('SELECT state FROM task_receipts'))?.state, 'committed');
    store.pruneTasks(now + 91 * 86400000);
    assert.equal(store.transaction(tx => tx.all('SELECT * FROM tasks')).length, 0);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('task log allowlist refuses bodies and queries but accepts a closed event', () => {
  const valid = { event: 'task_lifecycle', phase: 'complete', revision: 2, count: 3, ms: 12 };
  assert.ok(safeEvent(valid));
  assert.equal(safeEvent({ ...valid, query: 'secret synthetic query' }), undefined);
  assert.equal(safeEvent({ ...valid, body: 'synthetic body' }), undefined);
});

test('host runtime persists a real synthetic worker revision and delivery attempt', async () => {
  const { TaskRuntime } = await import('../tasks/runtime.js');
  const { FakeDelivery } = await import('../tasks/controller.js');
  const directory = mkdtempSync(join(tmpdir(), 'task-runtime-fixture-'));
  const store = new Store(directory), delivery = new FakeDelivery();
  try {
    const runtime = new TaskRuntime({ store, delivery, registry: new Map(), contentAllowed: () => true, infer: async () => ({ text: 'synthetic final', calls: [] }) });
    const { result } = runtime.finalize('synthetic input', 1);
    assert.equal((await result).status, 'complete');
    assert.equal(delivery.answers.length, 1);
    assert.match(String(store.transaction(tx => tx.get('SELECT final_answer FROM tasks'))?.final_answer), /synthetic final/);
    assert.equal(store.transaction(tx => tx.get('SELECT state FROM task_deliveries'))?.state, 'delivered');
    runtime.close();
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
