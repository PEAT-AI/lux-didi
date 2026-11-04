import { TASK_DISCLOSURE } from '../tasks/results.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { FakeDelivery } from '../tasks/controller.js';
import { Authority } from '../tasks/authority.js';
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
    assert.equal(store.finishTask({ ...second, connection_generation: 99 }, 'complete', 'stale generation', true, now), false);
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
  const valid = { event: 'task_lifecycle', taskId: 'synthetic-task', generation: 1, phase: 'complete', revision: 2, count: 3, ms: 12 };
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
    const runtime = new TaskRuntime({ store, delivery, execute: async () => { throw new Error('unexpected tool'); }, authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: { get: async () => undefined, put: async () => {} } }), contentAllowed: () => true, infer: async () => ({ text: 'synthetic final', calls: [] }) });
    const { result } = runtime.finalize('synthetic input', 1);
    assert.equal((await result).status, 'complete');
    assert.equal(delivery.answers.length, 1);
    assert.match(String(store.transaction(tx => tx.get('SELECT final_answer FROM tasks'))?.final_answer), /synthetic final/);
    assert.equal(store.transaction(tx => tx.get('SELECT state FROM task_deliveries'))?.state, 'delivered');
    runtime.close();
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('runtime retains outside exposure and host result URLs across a following task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-context-fixture-'));
  const store = new Store(directory); let inferred = 0;
  try {
    const runtime = new TaskRuntime({ store, delivery: new FakeDelivery(), contentAllowed: () => true,
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: { get: async () => undefined, put: async () => {} } }),
      execute: async () => ({ status: 'ok', text: 'Synthetic https://example.test/body', references: [{ id: 'mail', url: 'https://example.test/canonical' }], next_cursor: null, coverage: 'Whole.', repair: null }),
      infer: async () => ++inferred === 1 ? { text: '', calls: [{ id: 'read', name: 'read_mail', args: { id: 'synthetic', cursor: null } }] } : { text: 'Read.', calls: [] },
    });
    const first = runtime.finalize('Read the synthetic mail', 1, 1); await first.result;
    assert.ok(runtime.taskContext(first.revision.identity.task_id)?.exposures.length);
    assert.deepEqual([...runtime.hostUrls(first.revision.identity.task_id)].sort(), ['https://example.test/body', 'https://example.test/canonical']);
    const second = runtime.finalize('Save it', 1, 2); await second.result;
    assert.ok(runtime.taskContext(second.revision.identity.task_id)?.exposures.length);
    assert.deepEqual(runtime.hostUrls(second.revision.identity.task_id), runtime.hostUrls(first.revision.identity.task_id));
    assert.equal(runtime.taskContext(second.revision.identity.task_id)?.ownerTurn, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Store owns a durable effect journal without persisting canonical argument keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-effect-journal-'));
  let store = new Store(directory);
  try {
    const journal = store.taskEffectJournal(() => true);
    await journal.put('synthetic-task:remember_note:{"text":"synthetic-private-marker"}', { status: 'pending' });
    await journal.put('synthetic-completed', { status: 'succeeded', value: { status: 'ok', text: 'Synthetic receipt.' } });
    const keys = store.transaction(tx => tx.all('SELECT identity_hash FROM task_effect_journal'));
    assert.ok(keys.every(row => /^[a-f0-9]{64}$/.test(String(row.identity_hash))));
    store.close(); store = new Store(directory);
    assert.deepEqual(await store.taskEffectJournal(() => true).get('synthetic-task:remember_note:{"text":"synthetic-private-marker"}'), { status: 'pending' });
    assert.deepEqual(await store.taskEffectJournal(() => true).get('synthetic-completed'), { status: 'succeeded', value: { status: 'ok', text: 'Synthetic receipt.' } });
    await store.taskEffectJournal(() => false).put('redacted', { status: 'succeeded', value: { text: 'synthetic-private-marker' } });
    assert.equal(JSON.stringify(await store.taskEffectJournal(() => true).get('redacted')).includes('synthetic-private-marker'), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('R24 EF4: effect executor output is redacted before the durable journal and replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-effect-secret-fixture-'));
  const store = new Store(directory), secret = 'sk-syntheticFixtureSecretOnly1234567890';
  let calls = 0;
  const runtime = new TaskRuntime({ store, delivery: new FakeDelivery(), contentAllowed: () => true,
    authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal(() => true) }),
    infer: async () => ({ text: 'unused', calls: [] }), execute: async () => {
      calls++; return { status: 'ok', text: `Ordinary receipt ${secret}`, references: [{ id: 'synthetic', title: secret }], next_cursor: null,
        coverage: 'Ordinary receipt coverage', repair: null, receipt: { operation_id: secret, state: 'committed' },
        [TASK_DISCLOSURE]: { response: { text: `Ordinary proof ${secret}` }, dataClasses: ['ordinary'], sourceDispatchRefs: ['synthetic-dispatch'] } };
    } });
  try {
    const revision = runtime.begin('Remember this ordinary synthetic note', 1, 1);
    const identity = { ...revision.identity, operation_id: 'synthetic-write' }, signal = new AbortController().signal;
    const result = await runtime.runTool('remember_note', { text: 'ordinary note' }, identity, signal);
    const rows = store.transaction(tx => tx.all('SELECT status,value FROM task_effect_journal'));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.status, 'succeeded');
    assert(!JSON.stringify(rows).includes(secret), 'no executor secret reaches the retained effect journal');
    assert.match(JSON.stringify(rows), /Ordinary receipt/); assert.match(JSON.stringify(rows), /\[redacted\]/);
    assert.deepEqual(result[TASK_DISCLOSURE]?.sourceDispatchRefs, ['synthetic-dispatch'], 'host-only disclosure proof survives pre-journal redaction');
    const replay = await runtime.runTool('remember_note', { text: 'ordinary note' }, identity, signal);
    assert.equal(calls, 1); assert(!JSON.stringify([result, replay]).includes(secret));
    assert.match(result.text, /Ordinary receipt/); assert.match(replay.text, /\[redacted\]/);
  } finally { runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('host memory reader distinguishes unknown ids and returns valid local entries', async () => {
  const { hostTaskFactory } = await import('../tasks/host.js');
  const { resolveTaskModels } = await import('../config/tasks.js');
  const { domainMigrations } = await import('../domain/schema.js');
  const memory = await import('../domain/memory.js');
  const directory = mkdtempSync(join(tmpdir(), 'task-memory-fixture-'));
  const store = new Store(directory, domainMigrations);
  try {
    const runtime = hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined), bindings: () => [], contentAllowed: () => false, timeZone: 'UTC' })('synthetic-session', new FakeDelivery());
    const identity = { task_id: 'fixture', task_revision: 1, connection_generation: 1, operation_id: 'operation' };
    const missing = await runtime.registry.get('read_memory')!.run({ ref: 'unknown-synthetic-entry', cursor: null }, identity, new AbortController().signal);
    assert.equal(missing.failure_category, 'not_found');
    assert.match(missing.repair!, /search_memory/);
    assert.doesNotMatch(JSON.stringify(missing), /unknown-synthetic-entry/);
    const session = store.transaction(tx => memory.createSession(tx, { title: 'synthetic', startedAt: 1800000000000, timeZone: 'UTC' }, { now: () => 1800000000000 }));
    const entry = store.transaction(tx => memory.appendEntry(tx, { sessionId: session.id, role: 'user', text: 'synthetic local fact', capturedAt: 1800000000000, timeZone: 'UTC' }, { now: () => 1800000000000 }));
    const valid = await runtime.registry.get('read_memory')!.run({ ref: entry.id, cursor: null }, identity, new AbortController().signal);
    assert.equal(valid.text, 'synthetic local fact');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
