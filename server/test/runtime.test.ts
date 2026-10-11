import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import type { OutboxEvent } from '../runtime/outbox.js';
import type { Transaction } from '../contracts/storage.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'didi-runtime-'));
  const store = new Store(dir, [{ owner: 'test', version: 1, statements: ['CREATE TABLE records(id TEXT PRIMARY KEY, text TEXT NOT NULL)'] }]);
  return { dir, store, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const event: OutboxEvent = { id: 'event', entityId: 'record', entityRevision: 1, authorityEpoch: 'epoch', requiredGrant: 'native.notify', payload: '{"title":"Synthetic"}', sourceTimeZone: 'UTC', dueAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' };
const now = '2026-01-01T01:00:00.000Z';

test('bound values, rollback, expired handles and restart retain committed data', () => {
  const f = fixture();
  try {
    let retained: Transaction | undefined;
    f.store.transaction(tx => { retained = tx; tx.run('INSERT INTO records VALUES (?,?)', ['one', "'; DROP TABLE records; --"]); });
    assert.throws(() => retained!.all('SELECT * FROM records'), /expired/);
    assert.throws(() => f.store.transaction(tx => { tx.run('INSERT INTO records VALUES (?,?)', ['two', 'rollback']); throw Error('abort'); }), /abort/);
    const epoch = f.store.authorityEpoch;
    f.store.close();
    const reopened = new Store(f.dir, [{ owner: 'test', version: 1, statements: ['CREATE TABLE records(id TEXT PRIMARY KEY, text TEXT NOT NULL)'] }]);
    try { assert.equal(reopened.authorityEpoch, epoch); assert.equal(reopened.transaction(tx => tx.all('SELECT * FROM records')).length, 1); } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('second process is refused; close releases writer ownership', () => {
  const f = fixture();
  try {
    const script = `import { Store } from ${JSON.stringify(new URL('../runtime/store.js', import.meta.url).href)}; try { const s = new Store(process.env.TEST_DIR, [{owner:'test',version:1,statements:['CREATE TABLE records(id TEXT PRIMARY KEY, text TEXT NOT NULL)']}]); s.close(); } catch(e) { if(e.code==='WRITER_LOCKED') process.exit(23); throw e; }`;
    const child = () => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_DIR: f.dir }, timeout: 5000, encoding: 'utf8' });
    assert.equal(child().status, 23);
    f.store.close();
    const released = child(); assert.equal(released.status, 0, released.stderr);
  } finally { f.cleanup(); }
});

test('directory and database ownership permissions are private', () => {
  const f = fixture();
  try { assert.equal(statSync(f.dir).mode & 0o777, 0o700); for (const name of ['state.sqlite', 'writer.sqlite', 'admin-credential']) assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o600); } finally { f.cleanup(); }
});

test('no async, nested transactions, SQL control, duplicate columns or multiple statements', () => {
  const f = fixture();
  try {
    let ran = false;
    assert.throws(() => f.store.transaction((async () => { ran = true; }) as never), /synchronous/);
    assert.equal(ran, false);
    assert.throws(() => f.store.transaction(tx => { tx.run('INSERT INTO records VALUES (?,?)', ['async', 'no']); return Promise.resolve() as never; }), /synchronous/);
    assert.equal(f.store.transaction(tx => tx.all('SELECT * FROM records')).length, 0);
    assert.throws(() => f.store.transaction(() => f.store.transaction(() => 1)), /nested/i);
    for (const sql of ['COMMIT', 'PRAGMA journal_mode=OFF', "ATTACH DATABASE ':memory:' AS other", 'SELECT 1; SELECT 2']) assert.throws(() => f.store.transaction(tx => tx.all(sql)));
    assert.throws(() => f.store.transaction(tx => tx.all('SELECT 1 AS a, 2 AS a')), /column/);
    assert.equal(f.store.transaction(tx => tx.get("SELECT ';' AS value /* ; */"))!.value, ';');
  } finally { f.cleanup(); }
});

test('failed migration rolls back DDL and metadata; gaps, reserved owner and downgrade refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-migration-'));
  const migrations = [{ owner: 'domain', version: 1, statements: ['CREATE TABLE marker(id TEXT)'] }];
  try {
    assert.throws(() => new Store(dir, [{ owner: 'domain', version: 1, statements: ['CREATE TABLE marker(id TEXT)', 'BROKEN SQL'] }]));
    const s = new Store(dir, migrations); s.close();
    assert.throws(() => new Store(dir, []), /downgrade/);
    assert.throws(() => new Store(dir, [{ owner: 'domain', version: 2, statements: [] }]), /contiguous/);
    assert.throws(() => new Store(dir, [{ owner: 'runtime', version: 1, statements: [] }]), /reserved/);
    const s2 = new Store(dir, migrations); s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const triggerSchema = [
  'CREATE TABLE records(id TEXT PRIMARY KEY, text TEXT NOT NULL)',
  'CREATE TABLE audit(text TEXT NOT NULL)',
  `/* α; END */ CREATE TRIGGER "quoted; END α" AFTER INSERT ON records BEGIN
    INSERT INTO audit VALUES(CASE WHEN NEW.text='α; END' THEN 'quoted ''END;'' β' ELSE 'else' END);
    UPDATE records SET text=text || ' 😀' WHERE id=NEW.id; /* END; */
  END; /* complete suffix ; */ -- line suffix\n`,
  `CREATE TRIGGER immutable_identity BEFORE UPDATE ON records WHEN NEW.id IS NOT OLD.id
    BEGIN SELECT RAISE(ABORT,'identity_guard'); END;`,
  `CREATE TRIGGER immutable_delete BEFORE DELETE ON records
    BEGIN SELECT RAISE(ABORT,'delete_guard'); END;`,
];

test('typed compound trigger migration enforces guards with CASE comments quotes and Unicode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trigger-'));
  const migrations = [{ owner: 'trigger', version: 1, statements: triggerSchema }];
  let store: Store | undefined;
  try {
    store = new Store(dir, migrations);
    store.transaction(tx => {
      tx.run('INSERT INTO records VALUES (?,?)', ['one', 'α; END']);
      assert.equal(tx.get('SELECT text FROM records')!['text'], 'α; END 😀');
      assert.equal(tx.all('SELECT text FROM audit')[0]!['text'], "quoted 'END;' β");
      assert.throws(() => tx.run("UPDATE records SET id='changed'"), /identity_guard/);
      assert.throws(() => tx.run('DELETE FROM records'), /delete_guard/);
      assert.equal(tx.get('SELECT count(*) AS n FROM records')!['n'], 1);
    });
    store.close(); store = new Store(dir, migrations);
    assert.throws(() => store!.transaction(tx => tx.run('DELETE FROM records')), /delete_guard/);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('all prepare surfaces reject tails before stepping even when rejection is caught and transaction commits', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => {
      const first = "INSERT INTO records VALUES ('side','α')";
      const tails = [' SELECT 1', ' CREATE TABLE tail(x)', ' COMMIT', ';', ' /* unterminated', ' /* valid */ garbage', '\u00a0', '\v'];
      for (const method of ['run', 'all', 'get'] as const) {
        for (const tail of tails) {
          assert.throws(() => tx[method](first + ';' + tail), `reject ${method} tail ${JSON.stringify(tail)}`);
          assert.equal(tx.get('SELECT count(*) AS n FROM records')!['n'], 0, 'first INSERT must not have stepped');
        }
        assert.throws(() => tx[method]('CREATE TABLE hidden(x); SELECT 1'));
        assert.equal(tx.get("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('hidden','tail')")!['n'], 0);
      }
      assert.equal(tx.get("SELECT '; /* END -- α */' AS text; \t\n\f\r /* complete ; */ -- EOF")!['text'], '; /* END -- α */');
      assert.equal(tx.all("SELECT 'β' AS text; -- line\n /* block */")[0]!['text'], 'β');
      tx.run('INSERT INTO records VALUES (?,?); -- complete suffix', ['valid', '😀']);
    });
    assert.equal(f.store.transaction(tx => tx.get('SELECT count(*) AS n FROM records'))!['n'], 1);
  } finally { f.cleanup(); }
});

test('NUL and non-roundtripping Unicode reject before native preparation on all surfaces', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => {
      for (const method of ['run', 'all', 'get'] as const) {
        for (const sql of ['BROKEN\0SQL', "INSERT INTO records VALUES ('side','x');\0 COMMIT"])
          assert.throws(() => tx[method](sql), /NUL/, 'input boundary must win over native syntax/truncation');
        for (const bad of ['\ud800', '\udc00', '\ud800x'])
          assert.throws(() => tx[method]('BROKEN ' + bad), /Unicode/, 'input boundary must win over native syntax/UTF8 replacement');
      }
      assert.equal(tx.get("SELECT 'α😀�' AS text; /* valid UTF8 */")!['text'], 'α😀�');
      assert.equal(tx.get('SELECT count(*) AS n FROM records')!['n'], 0);
    });
  } finally { f.cleanup(); }
});

test('failed later migration rolls back compound trigger schema data and migration bookkeeping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trigger-rollback-'));
  let store: Store | undefined;
  try {
    assert.throws(() => new Store(dir, [{ owner: 'trigger', version: 1, statements: [...triggerSchema, "INSERT INTO records VALUES ('side','α; END')", 'BROKEN SQL'] }]));
    store = new Store(dir, [{ owner: 'trigger', version: 1, statements: triggerSchema }]);
    store.transaction(tx => {
      assert.equal(tx.get('SELECT count(*) AS n FROM records')!['n'], 0);
      assert.equal(tx.get('SELECT count(*) AS n FROM audit')!['n'], 0);
      assert.equal(tx.get("SELECT version FROM runtime_migrations WHERE owner='trigger'")!['version'], 1);
      tx.run("INSERT INTO records VALUES ('one','α; END')");
      assert.throws(() => tx.run('DELETE FROM records'), /delete_guard/);
    });
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('outbox and domain changes roll back together; policy default denies and wrong claims fail', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.transaction(tx => { Outbox.insert(tx, event); tx.run('INSERT INTO records VALUES (?,?)', ['one', 'synthetic']); throw Error('abort'); }));
    assert.equal(f.store.transaction(tx => Outbox.state(tx, event.id)), undefined);
    f.store.transaction(tx => Outbox.insert(tx, event));
    const claim = f.store.transaction(tx => Outbox.claim(tx, now, 60_000))!;
    assert.ok(claim);
    assert.equal(f.store.transaction(tx => Outbox.revalidate(tx, claim, 'epoch', 1, now)), false);
    const allow = { permits: (grant: string) => grant === 'native.notify' };
    assert.equal(f.store.transaction(tx => Outbox.revalidate(tx, claim, 'epoch', 1, now, allow)), true);
    assert.equal(f.store.transaction(tx => Outbox.revalidate(tx, claim, 'other', 1, now, allow)), false);
    assert.equal(f.store.transaction(tx => Outbox.revalidate(tx, claim, 'epoch', 2, now, allow)), false);
    assert.throws(() => f.store.transaction(tx => Outbox.recordOutcome(tx, { ...claim, token: 'wrong' }, 'acknowledged', now)), /claim/);
    f.store.transaction(tx => Outbox.recordOutcome(tx, claim, 'acknowledged', now));
    assert.equal(f.store.transaction(tx => Outbox.state(tx, event.id)), 'acknowledged');
  } finally { f.cleanup(); }
});

test('restart converts abandoned claims to unknown; no blind retry; supersede revokes live claim', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => Outbox.insert(tx, event));
    f.store.transaction(tx => Outbox.claim(tx, now, 60_000));
    f.store.close();
    const reopened = new Store(f.dir, [{ owner: 'test', version: 1, statements: ['CREATE TABLE records(id TEXT PRIMARY KEY, text TEXT NOT NULL)'] }]);
    try {
      assert.equal(reopened.transaction(tx => Outbox.state(tx, event.id)), 'unknown');
      assert.equal(reopened.transaction(tx => Outbox.claim(tx, now, 60_000)), undefined);
      reopened.transaction(tx => Outbox.insert(tx, { ...event, id: 'new', entityRevision: 2 }));
      const claim = reopened.transaction(tx => Outbox.claim(tx, now, 60_000))!;
      assert.equal(reopened.transaction(tx => Outbox.supersede(tx, event.entityId, 2)), 1);
      assert.equal(reopened.transaction(tx => Outbox.revalidate(tx, claim, 'epoch', 2, now, { permits: () => true })), false);
      assert.throws(() => reopened.transaction(tx => Outbox.recordOutcome(tx, claim, 'acknowledged', now)));
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('lease expiry becomes unknown instead of being claimed again', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => Outbox.insert(tx, event));
    const claim = f.store.transaction(tx => Outbox.claim(tx, now, 1000))!;
    assert.equal(f.store.transaction(tx => Outbox.revalidate(tx, claim, 'epoch', 1, '2026-01-01T01:00:01.000Z', { permits: () => true })), false);
    assert.equal(f.store.transaction(tx => Outbox.claim(tx, '2026-01-01T01:00:02.000Z', 1000)), undefined);
    assert.equal(f.store.transaction(tx => Outbox.state(tx, event.id)), 'unknown');
  } finally { f.cleanup(); }
});


test('expired delivery token cannot acknowledge an effect', () => {
  const f = fixture();
  try {
    f.store.transaction(tx => Outbox.insert(tx, event));
    const claim = f.store.transaction(tx => Outbox.claim(tx, now, 1000))!;
    assert.throws(() => f.store.transaction(tx => Outbox.recordOutcome(tx, claim, 'acknowledged', '2026-01-01T01:00:02.000Z')), /claim/);
  } finally { f.cleanup(); }
});

test('unclean process exit releases writer and rolls back open transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-crash-'));
  try {
    const script = `import { Store } from ${JSON.stringify(new URL('../runtime/store.js', import.meta.url).href)};
      const s = new Store(process.env.TEST_DIR, [{owner:'crash',version:1,statements:['CREATE TABLE rows(id TEXT PRIMARY KEY)']}]);
      s.transaction(tx => tx.run('INSERT INTO rows VALUES (?)', ['committed']));
      s.transaction(tx => { tx.run('INSERT INTO rows VALUES (?)', ['uncommitted']); process.exit(17); });`;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_DIR: dir }, timeout: 5000, encoding: 'utf8' });
    assert.equal(crashed.status, 17, crashed.stderr);
    const s = new Store(dir, [{owner:'crash',version:1,statements:['CREATE TABLE rows(id TEXT PRIMARY KEY)']}]);
    try { assert.deepEqual(s.transaction(tx => tx.all('SELECT id FROM rows')).map(row => row.id), ['committed']); } finally { s.close(); }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
