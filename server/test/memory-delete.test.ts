import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import * as memory from '../domain/memory.js';
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
