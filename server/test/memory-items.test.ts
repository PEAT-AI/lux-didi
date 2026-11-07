import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/runtime/store.js';
import { domainMigrations } from '../dist/domain/schema.js';
import * as items from '../dist/domain/memory-items.js';
import * as memory from '../dist/domain/memory.js';
import type { Transaction } from '../dist/contracts/storage.js';
import { fold } from '../dist/domain/util.js';

// Source-run by scripts/check-domain.sh (node strips the types), so every
// import points at the build the check just produced.

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-items-'));
  const store = new Store(dir, domainMigrations);
  return {
    dir,
    store,
    done() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Synthetic turns: the provenance rows a memory source points at. */
function turns(store: Store, sessionId: string, texts: readonly string[]): number[] {
  return store.transaction(tx => {
    texts.forEach((text, index) => tx.run(
      'INSERT INTO history_turns(live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?)',
      [sessionId, index + 1, index + 1, index === 0 ? 'owner' : 'assistant', text, 1000 + index]));
    return tx.all('SELECT id,text FROM history_turns WHERE live_session_id=? ORDER BY journal_first', [sessionId])
      .map(row => {
        // The domain keeps history_turns_fts in step itself, so a synthetic turn does the same.
        tx.run('INSERT INTO history_turns_fts(rowid,text) VALUES(?,?)', [Number(row.id), String(row.text)]);
        return Number(row.id);
      });
  });
}

test('migrations 10 and 11 create the memory tables, the indexes and both FTS tables, and reopening is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-items-'));
  const store = new Store(dir, domainMigrations);
  try {
    const names = store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE name LIKE 'memory%' ORDER BY name")
      .map(row => String(row.name)));
    for (const name of ['memory_generation', 'memory_items', 'memory_items_fts', 'memory_jobs', 'memory_sources']) {
      assert.ok(names.includes(name), `missing ${name}: ${names.join(',')}`);
    }
    const indexes = store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ix_memory%'")
      .map(row => String(row.name)));
    assert.deepEqual(indexes.sort(), ['ix_memory_items_event_at', 'ix_memory_items_status_kind',
      'ix_memory_items_subject', 'ix_memory_sources_memory', 'ix_memory_sources_session'].sort());
    store.close();
    const again = new Store(dir, domainMigrations);
    try {
      assert.equal(again.transaction(tx => Number(tx.get('SELECT generation FROM memory_generation WHERE id=1')!.generation)), 1);
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// --- M19: the helper's own memory search -------------------------------------

/** A synthetic entry with its session and the current labels a route admits. */
function entry(store: Store, id: string, text: string, capturedAt: number, entryClass: string, parentClass: string) {
  store.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', [`parent-${id}`, 'Synthetic', capturedAt, 'UTC', capturedAt, capturedAt]);
    tx.run('INSERT INTO entries VALUES (?,?,1,?,?,?,?,1)', [id, `parent-${id}`, 'user', text, capturedAt, 'UTC']);
    tx.run('INSERT INTO routing_labels VALUES (?,?,1,?,?,?)', ['entry', id, entryClass, 'owner_review', capturedAt]);
    tx.run('INSERT INTO routing_labels VALUES (?,?,1,?,?,?)', ['session', `parent-${id}`, parentClass, 'owner_review', capturedAt]);
  });
}

/** A record that only the history mirror gives a memory item its class from. */
function mirrored(store: Store, sessionId: string, dataClass: string) {
  store.transaction(tx => tx.run('INSERT INTO history_sessions VALUES (?,?,?,?,?)', [sessionId, store.assistantId, dataClass, 1, 1000]));
}

interface CountingSeen { queries: number; maxRows: number }
/** Counts the store work the way a query budget does: round trips, and rows any read returned. */
function counted<T>(tx: Transaction, body: (tx: Transaction) => T) {
  const seen: CountingSeen = { queries: 0, maxRows: 0 };
  const proxy: Transaction = {
    run: (sql, params) => tx.run(sql, params),
    get: (sql, params) => { seen.queries += 1; return tx.get(sql, params); },
    all: (sql, params) => {
      seen.queries += 1;
      const rows = tx.all(sql, params);
      seen.maxRows = Math.max(seen.maxRows, rows.length);
      return rows;
    },
  };
  return { seen, result: body(proxy) };
}

test('M19 D2: a fact the dreaming pass learned is found by the helper memory search', () => {
  const f = fixture();
  const session = '33333333-3333-4333-8333-333333333333';
  try {
    const [turn] = turns(f.store, session, ['my passport expires in march next year']);
    mirrored(f.store, session, 'ordinary');
    const written = f.store.transaction(tx => items.insertItem(tx, {
      kind: 'durable_fact', text: 'His passport expires in March next year.', subject: 'documents:passport',
      validFrom: 4000, createdAt: 4000, createdBy: 'dreaming:v1',
      sources: [{ sessionId: session, turnStartId: turn!, turnEndId: turn! }],
    }));
    // A superseded fact is not a fact any more, and the entries table never held it.
    const replaced = f.store.transaction(tx => items.insertItem(tx, {
      kind: 'durable_fact', text: 'His old passport number was synthetic.', subject: 'documents:passport',
      validFrom: 3000, createdAt: 3000, createdBy: 'dreaming:v1',
    }));
    f.store.transaction(tx => items.supersedeItem(tx, replaced.id, written.id, 4000));
    // F7: an explicit owner entry and a derived fact that score the same, so the tie-break is exercised.
    entry(f.store, 'e-passport', 'Synthetic passport photo is in the drawer', 1500, 'ordinary', 'ordinary');
    const found = f.store.transaction(tx => memory.searchMemory(tx, 'passport', 20, { classes: ['ordinary'] }));
    assert.deepEqual(found.hits.map(hit => [hit.source, hit.id, hit.score, hit.date]),
      [['entry', 'e-passport', 1, 1500], ['memory_item', written.id, 1, 4000]]);
    assert.ok(found.hits[1]!.text.includes('passport'));
    assert.equal(found.totalMatches, 2);
  } finally { f.done(); }
});

test('M19 D3: the helper memory search admits only the data classes the route allows', () => {
  const f = fixture();
  const session = '44444444-4444-4444-8444-444444444444';
  try {
    entry(f.store, 'e-ordinary', 'Synthetic keycard lifts on monday', 1000, 'ordinary', 'ordinary');
    entry(f.store, 'e-sensitive', 'Synthetic keycard code is 0000', 2000, 'sensitive', 'ordinary');
    mirrored(f.store, session, 'private');
    const [turn] = turns(f.store, session, ['the keycard pin was written down']);
    const secret = f.store.transaction(tx => items.insertItem(tx, {
      kind: 'durable_fact', text: 'The keycard pin for the garage is synthetic.', subject: 'home:keycard',
      validFrom: 3000, createdAt: 3000, createdBy: 'dreaming:v1',
      sources: [{ sessionId: session, turnStartId: turn!, turnEndId: turn! }],
    }));
    const ordinaryOnly = f.store.transaction(tx => memory.searchMemory(tx, 'keycard', 20, { classes: ['ordinary'] }));
    assert.deepEqual(ordinaryOnly.hits.map(hit => hit.id), ['e-ordinary']);
    assert.equal(ordinaryOnly.totalMatches, 1, 'the withheld matches are not counted either');
    const all = f.store.transaction(tx => memory.searchMemory(tx, 'keycard', 20, { classes: ['ordinary', 'private', 'sensitive'] }));
    assert.deepEqual(all.hits.map(hit => hit.id).sort(), [secret.id, 'e-ordinary', 'e-sensitive'].sort());
  } finally { f.done(); }
});

test('M19 D8: recall keeps the base result over an indexed, bounded read', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => {
      for (let i = 0; i < 500; i += 1) {
        const text = i % 2 === 0 ? `Synthetic keyword note ${i}` : `Synthetic other note ${i}`;
        tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', [`parent-${i}`, 'Synthetic', 1000 + i, 'UTC', 1000, 1000]);
        tx.run('INSERT INTO entries VALUES (?,?,1,?,?,?,?,1)', [`e-${i}`, `parent-${i}`, 'user', text, 2000 + i, 'UTC']);
      }
    });
    // The base algorithm, written out with the product's own fold: the tokens present, score, capture order.
    const base = f.store.transaction(tx => {
      const tokens = ['synthetic', 'keyword'];
      const scored = tx.all('SELECT * FROM entries').map(row => {
        const text = fold(String(row['text']));
        return { id: String(row['id']), capturedAt: Number(row['captured_at']), score: tokens.filter(token => text.includes(token)).length };
      }).filter(row => row.score > 0);
      scored.sort((a, b) => b.score - a.score || b.capturedAt - a.capturedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { ids: scored.slice(0, 20).map(row => row.id), totalMatches: scored.length, truncated: scored.length > 20 };
    });
    const { seen, result: actual } = f.store.transaction(outer => counted(outer, tx => memory.recall(tx, 'synthetic keyword', 20)));
    assert.deepEqual(actual.hits.map(hit => hit.entryId), base.ids);
    assert.equal(actual.totalMatches, base.totalMatches);
    assert.equal(actual.truncated, base.truncated);
    assert.ok(seen.maxRows <= 200, `recall reads a bounded candidate set, read ${seen.maxRows} rows`);
    assert.ok(seen.queries <= 4, `recall issues a fixed number of queries, issued ${seen.queries}`);
  } finally { f.done(); }
});

test('M19 D8/F4: the entries index folds diacritics exactly as fold() did', () => {
  const f = fixture();
  try {
    entry(f.store, 'e-cafe', 'Synthetic caf\u00e9 r\u00e9sum\u00e9 note', 1000, 'ordinary', 'ordinary');
    entry(f.store, 'e-plain', 'Synthetic plain note', 2000, 'ordinary', 'ordinary');
    // Base matched fold(text).includes(token); the index tokenizer removes diacritics too.
    for (const query of ['caf\u00e9', 'cafe', 'r\u00e9sum\u00e9']) {
      const tokens = fold(query).split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0);
      const expected = f.store.transaction(tx => tx.all('SELECT * FROM entries')
        .map(row => ({ id: String(row['id']), text: fold(String(row['text'])) }))
        .filter(row => tokens.some(token => row.text.includes(token)))
        .map(row => row.id));
      const actual = f.store.transaction(tx => memory.recall(tx, query, 20));
      assert.deepEqual(actual.hits.map(hit => hit.entryId).sort(), expected.sort(), `recall matches the fold oracle for ${query}`);
    }
    assert.deepEqual(f.store.transaction(tx => memory.recall(tx, 'cafe', 20)).hits.map(hit => hit.entryId), ['e-cafe']);
  } finally { f.done(); }
});

test('M19 D8/F6: an entry already in the store is found on the first recall after migration 11', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-items-upgrade-'));
  try {
    // A store at migration 10 only: entries exist, the entries index does not.
    const before = new Store(dir, domainMigrations.slice(0, 10));
    before.transaction(tx => {
      tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', ['s-legacy', 'Synthetic', 1000, 'UTC', 1000, 1000]);
      for (let i = 0; i < 3; i += 1) {
        tx.run('INSERT INTO entries VALUES (?,?,?,?,?,?,?,1)', [`old-${i}`, 's-legacy', i + 1, 'user', `Synthetic legacy sentinel ${i}`, 2000 + i, 'UTC']);
      }
    });
    assert.equal(before.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE name='entries_fts'").length), 0);
    before.close();
    // Reopening runs migration 11, whose rebuild statement indexes what is already there.
    const after = new Store(dir, domainMigrations);
    try {
      assert.deepEqual(after.transaction(tx => memory.recall(tx, 'legacy sentinel', 20)).hits.map(hit => hit.entryId), ['old-2', 'old-1', 'old-0']);
      assert.equal(after.transaction(tx => memory.recall(tx, 'legacy sentinel', 20)).totalMatches, 3);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
