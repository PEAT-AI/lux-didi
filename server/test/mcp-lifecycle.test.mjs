import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryResultStore } from '../dist/adapters/mcp/store.js';
import { createResultScope } from '../dist/adapters/mcp/lifecycle.js';
const binding = { endpointId: 'synthetic', generation: 1, account: 'account', resource: 'resource' };
const bytes = new TextEncoder().encode('{"content":[{"type":"text","text":"synthetic"}]}');

test('two runs retain their own pending entries and release failed partial reads', async () => {
  let now = 1000;
  const store = new MemoryResultStore({ maxEntries: 2, now: () => now });
  const first = createResultScope(), second = createResultScope();
  const a = first.run(() => store.put(binding, bytes));
  const b = second.run(() => store.put(binding, bytes));
  assert.equal(a.state, 'available'); assert.equal(b.state, 'available');
  now += 60_001; // Pending entries are not eviction candidates, even after their nominal TTL.
  assert.deepEqual(store.put(binding, bytes), { state: 'unavailable', reason: 'capacity' });
  first.release(); first.release();
  if (b.state !== 'available' || a.state !== 'available') throw Error('missing payload');
  assert.equal(store.read({ ...binding, handle: b.handle, offset: 0, length: 1 }, () => true).state, 'available');
  assert.notEqual(store.read({ ...binding, handle: a.handle, offset: 0, length: 1 }, () => true).state, 'available');
  assert.equal(store.put(binding, bytes).state, 'available');
  second.release();
  const failed = createResultScope();
  try { await failed.run(async () => { assert.equal(store.put(binding, bytes).state, 'available'); throw Error('synthetic child failure'); }); }
  catch (error) { assert.equal(error.message, 'synthetic child failure'); }
  finally { failed.release(); }
  assert.equal(store.put(binding, bytes).state, 'available');
});

test('one oversized payload remains a specific failure and consumes no capacity', () => {
  const store = new MemoryResultStore({ maxBytes: bytes.length, maxEntries: 1 });
  const scope = createResultScope();
  try {
    assert.deepEqual(scope.run(() => store.put(binding, new Uint8Array(bytes.length + 1))), { state: 'unavailable', reason: 'oversize' });
    assert.equal(scope.failureCode, 'result_store_oversize');
    assert.equal(scope.run(() => store.put(binding, bytes)).state, 'available');
  } finally { scope.release(); }
  assert.equal(store.put(binding, bytes).state, 'available');
});
