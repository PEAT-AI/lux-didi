import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import * as memory from '../domain/memory.js';
import * as items from '../domain/memory-items.js';
import { domainMigrations } from '../domain/schema.js';

const context = { assistantId: 'owner', clientId: 'owner-browser', authorityEpoch: 'epoch', now: '2026-01-01T00:00:00.000Z' };

test('owner deletion removes every domain copy, is idempotent and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-delete-'));
  let store = new Store(dir, domainMigrations);
  const port = createDomainPort({ outbox: Outbox });
  const secret = 'synthetic deletion canary violet otter';
  try {
    const session = store.transaction(tx => port.execute(tx, 'createSession', { title: 'Fixture', timeZone: 'UTC' }, context));
    const entry = store.transaction(tx => port.execute(tx, 'appendEntry', { sessionId: session.id, text: secret, role: 'user', timeZone: 'UTC' }, context));
    const retained = store.transaction(tx => port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'keep this other note', role: 'user', timeZone: 'UTC' }, context));
    store.transaction(tx => memory.addSourceReference(tx, { ownerKind: 'entry', ownerId: entry.id, label: secret, note: secret, availability: 'present' }));
    // At the base the operation does not exist. Use the public runtime dispatch,
    // not a parallel production contract, to establish the red stage.
    const remove = () => store.transaction(tx => Reflect.apply(port.execute, port, [tx, 'deleteEntry', { id: entry.id }, context]));
    const tombstone = remove();
    assert.deepEqual(tombstone, { entryId: entry.id, deletedAt: context.now, actor: context.clientId, reasonCode: 'owner_request' });
    assert.deepEqual(remove(), tombstone);
    store.close();
    store = new Store(dir, domainMigrations);
    store.transaction(tx => {
      assert.deepEqual(memory.entries(tx, session.id).map(e => e.id), [retained.id]);
      assert.throws(() => memory.readEntry(tx, entry.id), { code: 'NOT_FOUND' });
      assert.throws(() => memory.resolveEntries(tx, [entry.id]), { code: 'NOT_FOUND' });
      assert.deepEqual(memory.sourceReferences(tx, entry.id), []);
      assert.equal(memory.recall(tx, 'violet otter', 10).hits.length, 0);
      assert.equal(tx.all('SELECT * FROM entry_tombstones').length, 1);
      for (const table of ['entries', 'source_references', 'entry_tombstones']) {
        assert.equal(JSON.stringify(tx.all(`SELECT * FROM ${table}`)).includes(secret), false, table);
      }
      assert.throws(() => Reflect.apply(port.execute, port, [tx, 'deleteEntry', { id: 'unknown' }, context]), { code: 'NOT_FOUND' });
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('chat refuses a deleted selectedMemoryEntryIds id with its typed not_found error', async () => {
  const { openFixture } = await import('./chat-process.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-delete-chat-'));
  const fixture = openFixture(dir, { generate: async () => { assert.fail('deleted selection must not reach the provider'); } });
  try {
    const session = fixture.createSession();
    const entry = fixture.store.transaction(tx => fixture.domain.execute(tx, 'appendEntry', { sessionId: session.id, text: 'synthetic selected deletion note', role: 'user', timeZone: 'UTC' }, fixture.context));
    fixture.store.transaction(tx => fixture.domain.execute(tx, 'deleteEntry', { id: entry.id }, fixture.context));
    assert.throws(() => fixture.chat.accept({ sessionId: session.id, text: 'Use my note', selectedMemoryEntryIds: [entry.id], idempotencyKey: 'deleted-selected-note' }, fixture.context), { code: 'not_found' });
  } finally { await fixture.chat.shutdown(); fixture.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the owner forget path reaches the memory forget scope and fences a running job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-delete-memory-'));
  const store = new Store(dir, domainMigrations);
  const port = createDomainPort({ outbox: Outbox });
  try {
    const session = store.transaction(tx => port.execute(tx, 'createSession', { title: 'Fixture', timeZone: 'UTC' }, context));
    const entry = store.transaction(tx => port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'my passport is in the drawer', role: 'user', timeZone: 'UTC' }, context));
    const built = store.transaction(tx => {
      tx.run('INSERT INTO history_turns(live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?)',
        [session.id, 1, 1, 'owner', 'my passport is in the drawer', 1000]);
      const turn = Number(tx.get('SELECT id FROM history_turns WHERE live_session_id=?', [session.id])!.id);
      memory.addSourceReference(tx, {
        ownerKind: 'entry', ownerId: entry.id, label: 'note', provider: 'live-voice',
        externalId: `${session.id}:1:deadbeef`, availability: 'present',
      });
      const item = items.insertItem(tx, {
        kind: 'durable_fact', text: 'His passport is in the drawer.', subject: 'passport',
        validFrom: 1000, createdAt: 1000, createdBy: 'dreaming:v1',
        sources: [{ sessionId: session.id, turnStartId: turn, turnEndId: turn }],
      });
      return { item, job: items.claimJob(tx, session.id, 'v1', 1500) };
    });
    store.transaction(tx => port.execute(tx, 'deleteEntry', { id: entry.id }, context));
    const after = store.transaction(tx => ({
      items: tx.all('SELECT id FROM memory_items').map(row => String(row.id)),
      sources: tx.all('SELECT memory_id FROM memory_sources').length,
      generation: Number(tx.get('SELECT generation FROM memory_generation WHERE id=1')!.generation),
      fenced: items.completeJob(tx, built.job.id, 5, 2000),
    }));
    assert.deepEqual(after.items, []);
    assert.equal(after.sources, 0);
    assert.equal(after.generation, 2);
    assert.equal(after.fenced, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
