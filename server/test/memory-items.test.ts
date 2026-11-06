import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/runtime/store.js';
import { domainMigrations } from '../dist/domain/schema.js';
import * as items from '../dist/domain/memory-items.js';

// Source-run by scripts/check-domain.sh (node strips the types), so every
// import points at the build the check just produced.

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-items-'));
  const store = new Store(dir, domainMigrations);
  return {
    dir,
    store,
    open: () => new Store(dir, domainMigrations),
    done() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Synthetic turns: the provenance rows a memory source points at. */
function turns(store: Store, sessionId: string, texts: readonly string[]): number[] {
  return store.transaction(tx => {
    texts.forEach((text, index) => tx.run(
      'INSERT INTO history_turns(live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?)',
      [sessionId, index + 1, index + 1, index === 0 ? 'owner' : 'assistant', text, 1000 + index]));
    return tx.all('SELECT id FROM history_turns WHERE live_session_id=? ORDER BY journal_first', [sessionId])
      .map(row => Number(row.id));
  });
}

test('migration 10 creates the memory tables, the indexes and the FTS table, and reopening is clean', () => {
  const f = fixture();
  try {
    const names = f.store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE name LIKE 'memory%' ORDER BY name")
      .map(row => String(row.name)));
    for (const name of ['memory_generation', 'memory_items', 'memory_items_fts', 'memory_jobs', 'memory_sources']) {
      assert.ok(names.includes(name), `missing ${name}: ${names.join(',')}`);
    }
    const indexes = f.store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ix_memory%'")
      .map(row => String(row.name)));
    assert.deepEqual(indexes.sort(), ['ix_memory_items_event_at', 'ix_memory_items_status_kind',
      'ix_memory_items_subject', 'ix_memory_sources_session'].sort());
    const again = f.open();
    try {
      assert.equal(again.transaction(tx => Number(tx.get('SELECT generation FROM memory_generation WHERE id=1')!.generation)), 1);
    } finally { again.close(); }
  } finally { f.done(); }
});

test('insertItem stores the fact and sources join the turn text at read time', () => {
  const f = fixture();
  const session = '11111111-1111-4111-8111-111111111111';
  try {
    const [first, second] = turns(f.store, session, ['my flight is on friday', 'noted, friday']);
    const item = f.store.transaction(tx => items.insertItem(tx, {
      kind: 'durable_fact', text: 'His flight to Phuket is on Friday.', subject: 'trip:phuket',
      validFrom: 5000, createdAt: 5000, createdBy: 'remember_note', authority: 'explicit_owner',
      sources: [{ sessionId: session, turnStartId: first!, turnEndId: second! }],
    }));
    assert.equal(item.status, 'active');
    assert.equal(item.generation, 1);
    assert.equal(item.salience, 1);
    const active = f.store.transaction(tx => items.activeItems(tx, {}));
    assert.deepEqual(active.map(row => row.id), [item.id]);
    const sources = f.store.transaction(tx => items.sources(tx, item.id));
    assert.deepEqual(sources.map(row => [row.role, row.text]), [['owner', 'my flight is on friday'], ['assistant', 'noted, friday']]);
    assert.equal(f.store.transaction(tx => items.itemsForSubject(tx, 'trip:phuket').length), 1);
  } finally { f.done(); }
});

test('supersedeItem keeps the old row as history with its validity end and never serves it', () => {
  const f = fixture();
  try {
    const pair = f.store.transaction(tx => {
      const old = items.insertItem(tx, { kind: 'durable_fact', text: 'His flight is Friday.', subject: 'trip:phuket', validFrom: 1000, createdAt: 1000, createdBy: 'dreaming:v1' });
      const fresh = items.insertItem(tx, { kind: 'durable_fact', text: 'His flight is Saturday.', subject: 'trip:phuket', validFrom: 2000, createdAt: 2000, createdBy: 'dreaming:v1' });
      items.supersedeItem(tx, old.id, fresh.id, 2000);
      return { old: items.itemsForSubject(tx, 'trip:phuket').find(row => row.id === old.id)!, fresh };
    });
    assert.equal(pair.old.status, 'superseded');
    assert.equal(pair.old.supersededBy, pair.fresh.id);
    assert.equal(pair.old.validUntil, 2000);
    assert.deepEqual(f.store.transaction(tx => items.activeItems(tx, {})).map(row => row.text), ['His flight is Saturday.']);
  } finally { f.done(); }
});

test('invalidateItem marks the row invalid and activeItems drops it', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => {
      const item = items.insertItem(tx, { kind: 'durable_fact', text: 'He lives in Berlin.', subject: 'home', validFrom: 1000, createdAt: 1000, createdBy: 'remember_note' });
      items.invalidateItem(tx, item.id, 'owner corrected it');
    });
    assert.equal(f.store.transaction(tx => items.itemsForSubject(tx, 'home'))[0]!.status, 'invalid');
    assert.equal(f.store.transaction(tx => items.activeItems(tx, {})).length, 0);
  } finally { f.done(); }
});

test('expireDue expires a transient state past its date and never a durable fact', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => {
      items.insertItem(tx, { kind: 'transient_state', text: 'He is in Tokyo this week.', subject: 'where:tokyo', validFrom: 1000, validUntil: 3000, createdAt: 1000, createdBy: 'dreaming:v1' });
      items.insertItem(tx, { kind: 'durable_fact', text: 'He is allergic to peanuts.', subject: 'allergy:peanut', validFrom: 1000, validUntil: 3000, createdAt: 1000, createdBy: 'dreaming:v1' });
    });
    assert.equal(f.store.transaction(tx => items.expireDue(tx, 4000)), 1);
    const bySubject = f.store.transaction(tx => [items.itemsForSubject(tx, 'where:tokyo')[0]!, items.itemsForSubject(tx, 'allergy:peanut')[0]!]);
    assert.equal(bySubject[0]!.status, 'expired');
    assert.equal(bySubject[1]!.status, 'active');
    assert.deepEqual(f.store.transaction(tx => items.activeItems(tx, {})).map(row => row.kind), ['durable_fact']);
  } finally { f.done(); }
});

test('activeItems filters by kind and since, orders by salience and honours the limit', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => {
      items.insertItem(tx, { kind: 'preference', text: 'He prefers window seats.', subject: 'seat', validFrom: 1000, createdAt: 1000, createdBy: 'remember_note', salience: 3 });
      items.insertItem(tx, { kind: 'durable_fact', text: 'He travels for work.', subject: 'work', validFrom: 2000, createdAt: 2000, createdBy: 'dreaming:v1', salience: 0 });
      items.insertItem(tx, { kind: 'plan', text: 'He flies to Phuket in March.', subject: 'trip:phuket', validFrom: 3000, createdAt: 3000, createdBy: 'dreaming:v1', salience: 2 });
    });
    assert.deepEqual(f.store.transaction(tx => items.activeItems(tx, { kinds: ['preference'] })).map(row => row.kind), ['preference']);
    assert.deepEqual(f.store.transaction(tx => items.activeItems(tx, { since: 2500 })).map(row => row.kind), ['plan']);
    assert.deepEqual(f.store.transaction(tx => items.activeItems(tx, { orderBy: 'salience' })).map(row => row.salience), [3, 2, 0]);
    assert.equal(f.store.transaction(tx => items.activeItems(tx, { limit: 1 })).length, 1);
  } finally { f.done(); }
});

test('forgetScope removes the items and sources of a session, bumps the generation and fences a running job', () => {
  const f = fixture();
  const session = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  try {
    const ids = turns(f.store, session, ['remember my passport number is in the drawer']);
    const kept = turns(f.store, other, ['my sister is called Mara']);
    const setup = f.store.transaction(tx => {
      const forgotten = items.insertItem(tx, { kind: 'durable_fact', text: 'His passport is in the drawer.', subject: 'passport', validFrom: 1000, createdAt: 1000, createdBy: 'dreaming:v1', sources: [{ sessionId: session, turnStartId: ids[0]!, turnEndId: ids[0]! }] });
      const survivor = items.insertItem(tx, { kind: 'person_role', text: 'His sister is Mara.', subject: 'person:mara', validFrom: 1000, createdAt: 1000, createdBy: 'dreaming:v1', sources: [{ sessionId: other, turnStartId: kept[0]!, turnEndId: kept[0]! }] });
      const job = items.claimJob(tx, session, 'v1', 1500);
      return { forgotten, survivor, job };
    });
    assert.equal(setup.job.generation, 1);
    assert.equal(setup.job.state, 'running');
    const removed = f.store.transaction(tx => items.forgetScope(tx, { sessionIds: [session], now: 9000 }));
    assert.equal(removed, 1);
    const after = f.store.transaction(tx => ({
      generations: Number(tx.get('SELECT generation FROM memory_generation WHERE id=1')!.generation),
      survivorSources: tx.all('SELECT memory_id FROM memory_sources').map(row => String(row.memory_id)),
      itemIds: tx.all('SELECT id FROM memory_items').map(row => String(row.id)),
      fenced: items.completeJob(tx, setup.job.id, 12, 9100),
      jobState: items.job(tx, session, 'v1')!.state,
    }));
    assert.equal(after.generations, 2);
    assert.deepEqual(after.itemIds, [setup.survivor.id]);
    assert.deepEqual(after.survivorSources, [setup.survivor.id]);
    assert.equal(after.fenced, false);
    assert.equal(after.jobState, 'running');
    assert.equal(f.store.transaction(tx => items.completeJob(tx, items.claimJob(tx, session, 'v1', 9200).id, 12, 9300)), true);
  } finally { f.done(); }
});

test('forgetScope by item id and all, and the FTS index returns the item by a word in its text', () => {
  const f = fixture();
  try {
    const made = f.store.transaction(tx => [
      items.insertItem(tx, { kind: 'durable_fact', text: 'His kayak is stored in the garage.', subject: 'kayak', validFrom: 1000, createdAt: 1000, createdBy: 'remember_note' }),
      items.insertItem(tx, { kind: 'durable_fact', text: 'He keeps a spare key with the neighbour.', subject: 'key', validFrom: 1000, createdAt: 1000, createdBy: 'remember_note' }),
    ]);
    const hits = f.store.transaction(tx => tx.all('SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH ?', ['kayak'])
      .map(row => Number(row.rowid)));
    assert.equal(hits.length, 1);
    assert.equal(f.store.transaction(tx => items.forgetScope(tx, { itemIds: [made[0]!.id], now: 2000 })), 1);
    assert.deepEqual(f.store.transaction(tx => tx.all('SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH ?', ['kayak'])), []);
    assert.deepEqual(f.store.transaction(tx => tx.all('SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH ?', ['neighbour'])).length, 1);
    assert.equal(f.store.transaction(tx => items.forgetScope(tx, { all: true, now: 3000 })), 1);
    assert.equal(f.store.transaction(tx => tx.all('SELECT id FROM memory_items')).length, 0);
    assert.equal(f.store.transaction(tx => tx.all('SELECT memory_id FROM memory_sources')).length, 0);
  } finally { f.done(); }
});
