import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDeleteControl, deleteMemoryAndReload } from '../src/memory-list.ts';

test('delete controls identify the server entry and escape ids', () => {
  assert.match(memoryDeleteControl('server-id'), /data-delete-memory="server-id"/);
  assert.match(memoryDeleteControl('"<', true), /&quot;&lt;/);
  assert.match(memoryDeleteControl('server-id', true), /disabled/);
});

test('delete applies only the reloaded server payload after confirmation', async () => {
  let payload = ['deleted', 'kept'];
  const calls: string[] = [];
  let resolveDelete!: () => void;
  const pending = new Promise<void>(resolve => { resolveDelete = resolve; });
  const operation = deleteMemoryAndReload('deleted', {
    confirm: () => { calls.push('confirm'); return true; },
    remove: async id => { calls.push(`DELETE:${id}`); await pending; },
    reload: async () => { calls.push('GET'); return ['server-retained']; },
    apply: value => { payload = value; calls.push('apply'); },
  });
  assert.deepEqual(payload, ['deleted', 'kept']);
  assert.deepEqual(calls, ['confirm', 'DELETE:deleted']);
  resolveDelete();
  assert.equal(await operation, true);
  assert.deepEqual(payload, ['server-retained']);
  assert.deepEqual(calls, ['confirm', 'DELETE:deleted', 'GET', 'apply']);
});

test('cancel does not delete or reload', async () => {
  assert.equal(await deleteMemoryAndReload('entry', {
    confirm: () => false,
    remove: async () => assert.fail('cancel must not delete'),
    reload: async () => assert.fail('cancel must not reload'),
    apply: () => assert.fail('cancel must not replace payload'),
  }), false);
});

for (const failure of ['delete', 'reload']) {
  test(`${failure} failure keeps the displayed server payload`, async () => {
    await assert.rejects(deleteMemoryAndReload('entry', {
      confirm: () => true,
      remove: async () => { if (failure === 'delete') throw new Error('refused'); },
      reload: async () => { throw new Error('reload failed'); },
      apply: () => assert.fail('failure must not replace payload'),
    }));
  });
}
