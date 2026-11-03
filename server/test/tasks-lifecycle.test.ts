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
