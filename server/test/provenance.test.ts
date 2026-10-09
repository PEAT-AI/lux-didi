import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/runtime/store.js';
import { Outbox } from '../dist/runtime/outbox.js';
import { createDomainPort } from '../dist/domain/facade.js';
import type { RoutingSubject, TrustedWriteLabel } from '../dist/contracts/domain.js';

// Immutable actual v1 fixture copied verbatim (only constant name/type changed)
// from fd268309c1f1de88fa80d406a31ed2e0d9c47165:server/domain/schema.ts.
// Never import the future migration array to manufacture a legacy database.
const LEGACY_MIGRATIONS = [
  {
    owner: 'domain',
    version: 1,
    statements: [
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         started_at INTEGER NOT NULL,
         ended_at INTEGER,
         time_zone TEXT NOT NULL,
         revision INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE entries (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL REFERENCES sessions(id),
         sequence INTEGER NOT NULL,
         role TEXT NOT NULL,
         text TEXT NOT NULL,
         captured_at INTEGER NOT NULL,
         time_zone TEXT NOT NULL,
         revision INTEGER NOT NULL,
         UNIQUE (session_id, sequence)
       )`,
      `CREATE TABLE source_references (
         id TEXT PRIMARY KEY,
         owner_kind TEXT NOT NULL,
         owner_id TEXT NOT NULL,
         source_label TEXT NOT NULL,
         provider TEXT,
         account_id TEXT,
         external_id TEXT,
         source_timestamp INTEGER,
         availability TEXT NOT NULL,
         note TEXT
       )`,
      `CREATE TABLE preferences (
         id TEXT PRIMARY KEY,
         key TEXT NOT NULL UNIQUE,
         value TEXT NOT NULL,
         revision INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE commitments (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         notes TEXT NOT NULL,
         due_at INTEGER,
         due_time_zone TEXT,
         status TEXT NOT NULL,
         revision INTEGER NOT NULL,
         source_session_id TEXT,
         source_entry_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      // Append-only history: no code path issues UPDATE/DELETE on this table,
      // and (commitment_id, revision) is the primary key. A storage-level
      // trigger is not possible here because the runtime admits exactly one SQL
      // statement per migration entry and a trigger body needs an inner `;`.
      `CREATE TABLE commitment_revisions (
         commitment_id TEXT NOT NULL,
         revision INTEGER NOT NULL,
         title TEXT NOT NULL,
         notes TEXT NOT NULL,
         due_at INTEGER,
         due_time_zone TEXT,
         status TEXT NOT NULL,
         operation TEXT NOT NULL,
         recorded_at INTEGER NOT NULL,
         PRIMARY KEY (commitment_id, revision)
       )`,
    ],
  },
];

const NOW = '2026-10-09T12:00:00.000Z';
const PRIVATE = { writer: 'capture', dataClass: 'private' } as const;
const MODEL = { writer: 'model', dataClass: 'sensitive' } as const;
function fixture(migrations?: typeof LEGACY_MIGRATIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-provenance-'));
  const port = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, migrations ?? port.migrations);
  const context = { assistantId: store.assistantId, clientId: 'synthetic-client', authorityEpoch: store.authorityEpoch, now: NOW };
  return { dir, port, store, context };
}
function cleanup(h: ReturnType<typeof fixture>) {
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
}
function seed(h: ReturnType<typeof fixture>, labeled = false) {
  return h.store.transaction(tx => {
    const session = h.port.execute(tx, 'createSession', { title: 'Synthetic session', timeZone: 'UTC' }, h.context, labeled ? PRIVATE : undefined);
    const entry = h.port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'Synthetic note', role: 'user', timeZone: 'UTC' }, h.context, labeled ? PRIVATE : undefined);
    const commitment = h.port.execute(tx, 'createCommitment', { title: 'Synthetic task', notes: 'Keep original', dueAt: '2026-10-10T12:00:00.000Z', timeZone: 'UTC', sourceSessionId: session.id, sourceEntryId: entry.id }, h.context, labeled ? PRIVATE : undefined);
    return { session, entry, commitment };
  });
}
function subjects(records: ReturnType<typeof seed>): RoutingSubject[] {
  return [{ kind: 'session', id: records.session.id }, { kind: 'entry', id: records.entry.id }, { kind: 'commitment', id: records.commitment.id }];
}
function code(expected: string) {
  return (error: unknown) => (error as { code?: string }).code === expected;
}

test('actual baseline v1 upgrade preserves all values, starts unknown, labels persist on reopen', () => {
  const h = fixture(LEGACY_MIGRATIONS);
  try {
    const original = seed(h);
    const assistantId = h.store.assistantId;
    h.store.transaction(tx => assert.equal(tx.get("SELECT name FROM sqlite_master WHERE name='routing_labels'"), undefined));
    h.store.close();
    h.store = new Store(h.dir, h.port.migrations);
    assert.equal(h.store.assistantId, assistantId);
    h.store.transaction(tx => {
      assert.deepEqual(h.port.execute(tx, 'getSession', { id: original.session.id }, h.context), { session: original.session, entries: [original.entry], nextCursor: null });
      assert.deepEqual(h.port.execute(tx, 'getCommitment', { id: original.commitment.id }, h.context).commitment, original.commitment);
      assert.deepEqual(tx.all("SELECT version FROM runtime_migrations WHERE owner='domain' ORDER BY version").map(r => r.version), [1, 2]);
      for (const subject of subjects(original)) {
        assert.deepEqual(h.port.getRoutingLabel(tx, subject), { subject, revision: 0, dataClass: 'unknown', writer: null, recordedAt: null });
        assert.deepEqual(h.port.getRoutingLabelHistory(tx, subject), []);
        h.port.correctRoutingLabel(tx, { subject, expectedRevision: 0, dataClass: 'ordinary' }, h.context);
      }
    });
    h.store.close(); h.store = new Store(h.dir, h.port.migrations);
    h.store.transaction(tx => {
      for (const subject of subjects(original)) assert.deepEqual(h.port.getRoutingLabel(tx, subject), { subject, revision: 1, dataClass: 'ordinary', writer: 'owner_review', recordedAt: NOW });
    });
  } finally { cleanup(h); }
});

test('all four trusted create paths stamp atomically and four-argument calls stay unknown', () => {
  const h = fixture();
  try {
    const labeled = seed(h, true);
    const unlabeled = seed(h);
    h.store.transaction(tx => {
      for (const subject of subjects(labeled)) assert.deepEqual(h.port.getRoutingLabel(tx, subject), { subject, revision: 1, dataClass: 'private', writer: 'capture', recordedAt: NOW });
      for (const subject of subjects(unlabeled)) assert.equal(h.port.getRoutingLabel(tx, subject).dataClass, 'unknown');
      const assistant = h.port.execute(tx, 'appendAssistantEntry', { sessionId: labeled.session.id, text: 'Synthetic response', timeZone: 'UTC' }, h.context, MODEL);
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'entry', id: assistant.id }).dataClass, 'sensitive');
      const privateAssistant = h.port.execute(tx, 'appendAssistantEntry', { sessionId: labeled.session.id, text: 'Private response', timeZone: 'UTC' }, h.context, { writer: 'model', dataClass: 'private' });
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'entry', id: privateAssistant.id }).writer, 'model');
      for (const operation of ['createSession', 'createCommitment'] as const) {
        const input = operation === 'createSession' ? { title: 'Model session', timeZone: 'UTC' } : { title: 'Model task', timeZone: 'UTC', dueAt: null };
        const record = h.port.execute(tx, operation, input, h.context, MODEL);
        assert.equal(h.port.getRoutingLabel(tx, { kind: operation === 'createSession' ? 'session' : 'commitment', id: record.id }).dataClass, 'sensitive');
      }
    });
  } finally { cleanup(h); }
});

test('invalid trusted labels and unsupported operations fail before mutation even if caller catches', () => {
  const h = fixture();
  try {
    const { session, commitment } = seed(h);
    h.store.transaction(tx => {
      const before = tx.all('SELECT * FROM sessions');
      for (const label of [
        { writer: 'capture', dataClass: 'ordinary' }, { writer: 'capture', dataClass: 'sensitive' },
        { writer: 'model', dataClass: 'ordinary' }, { writer: 'owner_review', dataClass: 'private' },
        { writer: 'bogus', dataClass: 'private' }, { writer: 'capture', dataClass: 'bogus' }, {}, null,
      ]) assert.throws(() => h.port.execute(tx, 'createSession', { title: 'Must not insert', timeZone: 'UTC' }, h.context, label as TrustedWriteLabel), code('BAD_REQUEST'));
      assert.deepEqual(tx.all('SELECT * FROM sessions'), before);
      for (const [operation, input] of [
        ['listSessions', {}], ['getSession', { id: session.id }], ['recall', { q: 'Synthetic', limit: 10 }],
        ['listCommitments', {}], ['getCommitment', { id: commitment.id }],
        ['updateCommitment', { id: commitment.id, expectedRevision: 1, title: 'Must not change' }],
        ['transitionCommitment', { id: commitment.id, expectedRevision: 1, operation: 'complete' }],
        ['plan', { date: '2026-10-10', timeZone: 'UTC' }],
      ] as const) assert.throws(() => h.port.execute(tx, operation, input, h.context, PRIVATE), code('BAD_REQUEST'));
      assert.equal(h.port.execute(tx, 'getCommitment', { id: commitment.id }, h.context).commitment.title, commitment.title);
      assert.throws(() => h.port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'No model capture', role: 'user', timeZone: 'UTC' }, h.context, MODEL), code('BAD_REQUEST'));
      assert.throws(() => h.port.execute(tx, 'appendAssistantEntry', { sessionId: session.id, text: 'No capture completion', timeZone: 'UTC' }, h.context, PRIVATE), code('BAD_REQUEST'));
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM routing_labels')!.n, 0);
    });
  } finally { cleanup(h); }
});

test('SourceRef and body-like extra fields never confer routing authority or owner identity', () => {
  const h = fixture();
  try {
    h.store.transaction(tx => {
      const session = h.port.execute(tx, 'createSession', { title: 'Spoofed fields', timeZone: 'UTC', writer: 'owner_review', dataClass: 'ordinary', owner: 'foreign-owner', writeLabel: MODEL } as never, h.context);
      const entry = h.port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'Synthetic spoof', role: 'user', timeZone: 'UTC', dataClass: 'ordinary', writer: 'owner_review', writeLabel: MODEL, sourceRef: { id: 'synthetic-source', label: 'ordinary', sourceTimestamp: null, availability: 'present', accountId: 'foreign-owner', writer: 'owner_review', dataClass: 'ordinary', owner: 'foreign-owner' } } as never, h.context);
      const commitment = h.port.execute(tx, 'createCommitment', { title: 'Spoof task', dueAt: null, timeZone: 'UTC', writer: 'owner_review', dataClass: 'ordinary', owner: 'foreign-owner' } as never, h.context);
      for (const subject of subjects({ session, entry, commitment })) assert.equal(h.port.getRoutingLabel(tx, subject).dataClass, 'unknown');
      const captured = h.port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'Trusted capture wins', role: 'user', timeZone: 'UTC', dataClass: 'ordinary', sourceRef: { id: 'another-source', label: 'ordinary', sourceTimestamp: null, availability: 'present', dataClass: 'ordinary' } } as never, h.context, PRIVATE);
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'entry', id: captured.id }).dataClass, 'private');
    });
  } finally { cleanup(h); }
});

test('lookup/history/correction distinguish missing subjects from existing unknown and reject recall kind', () => {
  const h = fixture();
  try {
    const records = seed(h);
    h.store.transaction(tx => {
      for (const subject of subjects(records)) {
        const missing = { ...subject, id: 'nonexistent' };
        assert.throws(() => h.port.getRoutingLabel(tx, missing), code('NOT_FOUND'));
        assert.throws(() => h.port.getRoutingLabelHistory(tx, missing), code('NOT_FOUND'));
        assert.throws(() => h.port.correctRoutingLabel(tx, { subject: missing, expectedRevision: 0, dataClass: 'private' }, h.context), code('NOT_FOUND'));
        assert.equal(h.port.getRoutingLabel(tx, subject).dataClass, 'unknown');
      }
      for (const subject of [{ kind: 'recall', id: records.entry.id }, { kind: 'entry', id: '' }, { kind: 'entry', id: 12 }, null]) {
        assert.throws(() => h.port.getRoutingLabel(tx, subject as RoutingSubject), code('BAD_REQUEST'));
        assert.throws(() => h.port.getRoutingLabelHistory(tx, subject as RoutingSubject), code('BAD_REQUEST'));
      }
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM routing_labels')!.n, 0);
    });
  } finally { cleanup(h); }
});

test('owner corrections append, allow raising/lowering, stale-check and never rewrite content', () => {
  const h = fixture();
  try {
    const records = seed(h, true);
    h.store.transaction(tx => {
      for (const subject of subjects(records)) {
        assert.throws(() => h.port.correctRoutingLabel(tx, { subject, expectedRevision: 0, dataClass: 'ordinary' }, h.context), code('CONFLICT'));
        const raised = h.port.correctRoutingLabel(tx, { subject, expectedRevision: 1, dataClass: 'sensitive' }, h.context);
        assert.equal(raised.revision, 2); assert.equal(raised.writer, 'owner_review');
        assert.throws(() => h.port.correctRoutingLabel(tx, { subject, expectedRevision: 1, dataClass: 'ordinary' }, h.context), code('CONFLICT'));
        const lowered = h.port.correctRoutingLabel(tx, { subject, expectedRevision: 2, dataClass: 'ordinary' }, h.context);
        assert.equal(lowered.revision, 3);
        assert.deepEqual(h.port.getRoutingLabelHistory(tx, subject).map(l => [l.revision, l.dataClass, l.writer]), [[1, 'private', 'capture'], [2, 'sensitive', 'owner_review'], [3, 'ordinary', 'owner_review']]);
        assert.deepEqual(h.port.getRoutingLabel(tx, subject), lowered);
        for (const expectedRevision of [-1, 1.5, NaN, '3']) assert.throws(() => h.port.correctRoutingLabel(tx, { subject, expectedRevision, dataClass: 'private' } as never, h.context), code('BAD_REQUEST'));
        assert.throws(() => h.port.correctRoutingLabel(tx, { subject, expectedRevision: 3, dataClass: 'unknown' } as never, h.context), code('BAD_REQUEST'));
      }
      assert.deepEqual(h.port.execute(tx, 'getSession', { id: records.session.id }, h.context).entries, [records.entry]);
      assert.deepEqual(h.port.execute(tx, 'getCommitment', { id: records.commitment.id }, h.context).commitment, records.commitment);
      h.port.execute(tx, 'updateCommitment', { id: records.commitment.id, expectedRevision: 1, title: 'Explicit content correction' }, h.context);
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'commitment', id: records.commitment.id }).revision, 3);
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'commitment', id: records.commitment.id }).dataClass, 'ordinary');
    });
  } finally { cleanup(h); }
});

test('SQLite enforces stored enums, positive integer revisions and composite uniqueness', () => {
  const h = fixture();
  try {
    const { session } = seed(h);
    h.store.transaction(tx => {
      const insert = (kind: string, revision: number, dataClass: string, writer: string) => tx.run('INSERT INTO routing_labels(subject_kind,subject_id,revision,data_class,writer,recorded_at) VALUES(?,?,?,?,?,?)', [kind, session.id, revision, dataClass, writer, Date.parse(NOW)]);
      for (const args of [['recall', 1, 'private', 'capture'], ['session', 1, 'unknown', 'capture'], ['session', 1, 'private', 'untrusted'], ['session', 0, 'private', 'capture'], ['session', 1.5, 'private', 'capture']] as const) assert.throws(() => insert(...args), /CHECK constraint/);
      insert('session', 1, 'private', 'capture');
      assert.throws(() => insert('session', 1, 'private', 'capture'), /UNIQUE constraint/);
      insert('session', 2, 'sensitive', 'owner_review');
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'session', id: session.id }).revision, 2);
    });
  } finally { cleanup(h); }
});

test('fault after subject insert before label rolls back subject, history and reminder', () => {
  const h = fixture();
  try {
    const records = seed(h);
    // Store intentionally disallows trigger bodies (multiple SQL statements).
    // An actual SQLite default/check fault fails the next label INSERT only.
    h.store.transaction(tx => tx.run('ALTER TABLE routing_labels ADD COLUMN synthetic_failure INTEGER NOT NULL DEFAULT 0 CHECK(synthetic_failure=1)'));
    const before = h.store.transaction(tx => ['sessions', 'entries', 'commitments', 'commitment_revisions', 'runtime_outbox'].map(table => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n));
    for (const [operation, input, label] of [
      ['createSession', { title: 'Rollback session', timeZone: 'UTC' }, PRIVATE],
      ['appendEntry', { sessionId: records.session.id, text: 'Rollback entry', role: 'user', timeZone: 'UTC' }, PRIVATE],
      ['appendAssistantEntry', { sessionId: records.session.id, text: 'Rollback completion', timeZone: 'UTC' }, MODEL],
      ['createCommitment', { title: 'Rollback task', dueAt: '2026-10-10T12:00:00.000Z', timeZone: 'UTC' }, PRIVATE],
    ] as const) assert.throws(() => h.store.transaction(tx => h.port.execute(tx, operation, input, h.context, label)), /CHECK constraint failed/);
    h.store.transaction(tx => {
      assert.deepEqual(['sessions', 'entries', 'commitments', 'commitment_revisions', 'runtime_outbox'].map(table => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n), before);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM routing_labels')!.n, 0);
    });
  } finally { cleanup(h); }
});

test('later caller persistence fault rolls back subject plus labels and corrections', () => {
  const h = fixture();
  try {
    const records = seed(h);
    assert.throws(() => h.store.transaction(tx => {
      const session = h.port.execute(tx, 'createSession', { title: 'Later rollback', timeZone: 'UTC' }, h.context, PRIVATE);
      h.port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'Synthetic turn', role: 'user', timeZone: 'UTC' }, h.context, PRIVATE);
      h.port.execute(tx, 'appendAssistantEntry', { sessionId: session.id, text: 'Synthetic response', timeZone: 'UTC' }, h.context, MODEL);
      h.port.execute(tx, 'createCommitment', { title: 'Synthetic task', dueAt: '2026-10-10T12:00:00.000Z', timeZone: 'UTC' }, h.context, MODEL);
      h.port.correctRoutingLabel(tx, { subject: { kind: 'session', id: records.session.id }, expectedRevision: 0, dataClass: 'private' }, h.context);
      // Concrete failed later SQL persistence in the caller's same transaction;
      // no claim this exercises CHAT's own run-persistence implementation.
      tx.run('INSERT INTO nonexistent_caller_run_table VALUES (?)', ['synthetic-run']);
    }), /no such table/);
    h.store.transaction(tx => {
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM sessions')!.n, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM entries')!.n, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM commitments')!.n, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM commitment_revisions')!.n, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM runtime_outbox')!.n, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM routing_labels')!.n, 0);
      assert.equal(h.port.getRoutingLabel(tx, { kind: 'session', id: records.session.id }).dataClass, 'unknown');
    });
  } finally { cleanup(h); }
});
