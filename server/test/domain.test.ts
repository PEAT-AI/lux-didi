import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual service runtime, not a stand-in: the real Store (node:sqlite, sole
// writer) and the real Outbox, loaded from the service package's compiled
// output (`server/dist`, produced by `npm run build` + the domain build config).
// The domain under test never opens a database.
import { Store } from '../dist/runtime/store.js';
import { Outbox } from '../dist/runtime/outbox.js';
import type { DomainContext } from '../dist/contracts/domain.js';
import { createDomainPort } from '../dist/domain/facade.js';

const AUTHORITY = 'epoch-1';

interface Harness {
  dir: string;
  store: Store;
  port: ReturnType<typeof createDomainPort>;
}

function open(dir: string, resolveTarget?: () => { deviceId: string; grant: string } | null): Harness {
  const port = createDomainPort({ outbox: Outbox, resolveTarget });
  const store = new Store(dir, port.migrations);
  return { dir, store, port };
}

function fixture(): Harness {
  return open(mkdtempSync(join(tmpdir(), 'didi-domain-')));
}

function cleanup(h: Harness): void {
  h.store.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function context(now: string, overrides: Partial<DomainContext> = {}): DomainContext {
  return { assistantId: 'assistant-1', clientId: 'client-1', authorityEpoch: AUTHORITY, now, ...overrides };
}

let tick = 0;
function nextNow(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
}

test('restart recall: durable entries survive a close/reopen', () => {
  const h = fixture();
  try {
    const created = h.store.transaction((tx) =>
      h.port.execute(tx, 'createSession', { title: 'Synthetic plan', timeZone: 'UTC' }, context(nextNow())),
    ) as { id: string };
    h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'appendEntry',
        { sessionId: created.id, text: 'Call the café about the résumé', role: 'user', timeZone: 'UTC' },
        context(nextNow()),
      ),
    );
    h.store.close();

    const reopened = open(h.dir);
    try {
      const found = reopened.store.transaction((tx) =>
        reopened.port.execute(tx, 'recall', { q: 'resume', limit: 10 }, context(nextNow())),
      ) as { hits: { snippet: string }[]; totalMatches: number };
      assert.equal(found.totalMatches, 1);
      assert.equal(found.hits.length, 1);
      assert.match(found.hits[0]!.snippet, /r.sum/i);
    } finally {
      reopened.store.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  } catch (error) {
    cleanup(h);
    throw error;
  }
});

test('provenance: a present source is present and a missing imported source stays missing', () => {
  const h = fixture();
  try {
    const created = h.store.transaction((tx) =>
      h.port.execute(tx, 'createSession', { title: 'Synthetic', timeZone: 'UTC' }, context(nextNow())),
    ) as { id: string };

    h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'appendEntry',
        {
          sessionId: created.id,
          text: 'Imported note from the archive',
          role: 'user',
          timeZone: 'UTC',
          sourceRef: {
            id: 'src-present',
            label: 'Archive export',
            provider: 'synthetic-provider',
            externalId: 'ext-1',
            sourceTimestamp: '2025-12-31T23:00:00.000Z',
            availability: 'present',
          },
        },
        context(nextNow()),
      ),
    );
    h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'appendEntry',
        {
          sessionId: created.id,
          text: 'Imported note whose source was unavailable',
          role: 'user',
          timeZone: 'UTC',
          sourceRef: { id: 'src-missing', label: 'Missing export', sourceTimestamp: null, availability: 'missing', note: 'absent' },
        },
        context(nextNow()),
      ),
    );
    // A failed lookup is a missing source too, but its reason stays distinct from
    // a confirmed absence: neither is ever implied present.
    h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'appendEntry',
        {
          sessionId: created.id,
          text: 'Imported note whose lookup failed',
          role: 'user',
          timeZone: 'UTC',
          sourceRef: { id: 'src-lookup', label: 'Archive lookup', sourceTimestamp: null, availability: 'missing', note: 'lookup_failed' },
        },
        context(nextNow()),
      ),
    );

    const recall = h.store.transaction((tx) =>
      h.port.execute(tx, 'recall', { q: 'imported note', limit: 10 }, context(nextNow())),
    ) as {
      hits: { snippet: string; sourceRefs: { id: string; availability: string; sourceTimestamp: string | null; note?: string }[]; sourceTimestamp: string | null }[];
    };
    assert.equal(recall.hits.length, 3);
    const present = recall.hits.find((hit) => hit.sourceRefs[0]?.id === 'src-present');
    const missing = recall.hits.find((hit) => hit.sourceRefs[0]?.id === 'src-missing');
    const lookup = recall.hits.find((hit) => hit.sourceRefs[0]?.id === 'src-lookup');
    assert.ok(present);
    assert.ok(missing);
    assert.ok(lookup);
    assert.equal(present.sourceRefs[0]!.availability, 'present');
    assert.equal(missing.sourceRefs[0]!.availability, 'missing');
    assert.equal(missing.sourceRefs[0]!.sourceTimestamp, null);
    assert.equal(missing.sourceRefs[0]!.note, 'absent');
    assert.equal(lookup.sourceRefs[0]!.availability, 'missing');
    assert.equal(lookup.sourceRefs[0]!.note, 'lookup_failed', 'a failed lookup is recorded distinctly from absence');
    assert.notEqual(missing.sourceRefs[0]!.note, lookup.sourceRefs[0]!.note);
  } finally {
    cleanup(h);
  }
});

test('recall honesty: empty query, unseen term, and truncated coverage', () => {
  const h = fixture();
  try {
    const created = h.store.transaction((tx) =>
      h.port.execute(tx, 'createSession', { title: 'Synthetic', timeZone: 'UTC' }, context(nextNow())),
    ) as { id: string };
    for (const text of ['alpha note', 'alpha reminder', 'alpha task']) {
      h.store.transaction((tx) =>
        h.port.execute(tx, 'appendEntry', { sessionId: created.id, text, role: 'user', timeZone: 'UTC' }, context(nextNow())),
      );
    }
    const empty = h.store.transaction((tx) =>
      h.port.execute(tx, 'recall', { q: '   ', limit: 10 }, context(nextNow())),
    ) as { hits: unknown[]; totalMatches: number; truncated: boolean };
    assert.deepEqual(empty, { hits: [], totalMatches: 0, truncated: false, nextCursor: null });

    const unseen = h.store.transaction((tx) =>
      h.port.execute(tx, 'recall', { q: 'zebra', limit: 10 }, context(nextNow())),
    ) as { hits: unknown[]; totalMatches: number };
    assert.equal(unseen.totalMatches, 0);
    assert.equal(unseen.hits.length, 0);

    const limited = h.store.transaction((tx) =>
      h.port.execute(tx, 'recall', { q: 'alpha', limit: 2 }, context(nextNow())),
    ) as { hits: unknown[]; totalMatches: number; truncated: boolean };
    assert.equal(limited.totalMatches, 3);
    assert.equal(limited.hits.length, 2);
    assert.equal(limited.truncated, true);
  } finally {
    cleanup(h);
  }
});

test('correction replaces the pending reminder atomically and invalidates the old one', () => {
  const h = fixture();
  try {
    const c = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'Send the report', notes: 'first', dueAt: '2026-02-01T09:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string; revision: number; dueAt: string | null };
    assert.equal(c.revision, 1);

    const oldId = `${c.id}:1`;
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, oldId)), 'pending');

    const corrected = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'updateCommitment',
        { id: c.id, expectedRevision: 1, dueAt: '2026-02-02T09:00:00.000Z' },
        context(nextNow()),
      ),
    ) as { revision: number; dueAt: string | null };
    assert.equal(corrected.revision, 2);
    assert.equal(corrected.dueAt, '2026-02-02T09:00:00.000Z');
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, oldId)), 'superseded');
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:2`)), 'pending');

    const history = h.store.transaction((tx) =>
      h.port.execute(tx, 'getCommitment', { id: c.id }, context(nextNow())),
    ) as { commitment: { revision: number }; history: { revision: number; operation: string }[] };
    assert.deepEqual(
      history.history.map((row) => [row.revision, row.operation]),
      [
        [1, 'captured'],
        [2, 'corrected'],
      ],
    );
  } finally {
    cleanup(h);
  }
});

test('stale writer: a wrong expectedRevision conflicts and leaves commitment and reminder intact', () => {
  const h = fixture();
  try {
    const c = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'Renew the licence', dueAt: '2026-03-01T09:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string; revision: number };

    assert.throws(
      () =>
        h.store.transaction((tx) =>
          h.port.execute(
            tx,
            'updateCommitment',
            { id: c.id, expectedRevision: 99, title: 'Renew quickly' },
            context(nextNow()),
          ),
        ),
      (error: { code?: string; details?: Record<string, unknown> }) => {
        assert.equal(error.code, 'CONFLICT');
        assert.deepEqual(error.details, { id: c.id, expected: 99, stored: 1 });
        return true;
      },
    );

    const after = h.store.transaction((tx) =>
      h.port.execute(tx, 'getCommitment', { id: c.id }, context(nextNow())),
    ) as { commitment: { revision: number; title: string }; history: unknown[] };
    assert.equal(after.commitment.revision, 1);
    assert.equal(after.commitment.title, 'Renew the licence');
    assert.equal(after.history.length, 1);
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:1`)), 'pending');
  } finally {
    cleanup(h);
  }
});

test('rollback: a failed transaction leaves neither commitment nor reminder', () => {
  const h = fixture();
  try {
    assert.throws(() =>
      h.store.transaction((tx) => {
        h.port.execute(
          tx,
          'createCommitment',
          { title: 'Should roll back', dueAt: '2026-04-01T09:00:00.000Z', timeZone: 'UTC' },
          context(nextNow()),
        );
        throw new Error('forced failure after the domain write');
      }),
    );

    const all = h.store.transaction((tx) =>
      h.port.execute(tx, 'listCommitments', {}, context(nextNow())),
    ) as { items: unknown[] };
    assert.equal(all.items.length, 0);
    // Inspect the actual tables: no commitment, history or outbox event may survive.
    const counts = h.store.transaction((tx) => ({
      commitments: (tx.get('SELECT COUNT(*) AS n FROM commitments', []) as { n: number }).n,
      history: (tx.get('SELECT COUNT(*) AS n FROM commitment_revisions', []) as { n: number }).n,
      outbox: (tx.get('SELECT COUNT(*) AS n FROM runtime_outbox', []) as { n: number }).n,
    }));
    assert.deepEqual(counts, { commitments: 0, history: 0, outbox: 0 });
  } finally {
    cleanup(h);
  }
});

test('complete cancels the reminder and does not resurrect; a new promise gets a new identity; reopen keeps it', () => {
  const h = fixture();
  try {
    const c = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'File the receipts', dueAt: '2026-05-01T09:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string; revision: number };

    const done = h.store.transaction((tx) =>
      h.port.execute(tx, 'transitionCommitment', { id: c.id, expectedRevision: 1, operation: 'complete' }, context(nextNow())),
    ) as { status: string; revision: number };
    assert.equal(done.status, 'completed');
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:2`)), undefined);
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:1`)), 'superseded');

    const plan = h.store.transaction((tx) =>
      h.port.execute(tx, 'plan', { date: '2026-05-01', timeZone: 'UTC' }, context(nextNow())),
    ) as { items: unknown[]; unscheduled: unknown[] };
    assert.equal(plan.items.length, 0, 'completed commitments must not resurrect in the plan');

    const again = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'File the receipts', dueAt: '2026-05-01T09:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string; revision: number };
    assert.notEqual(again.id, c.id, 'a genuinely new promise gets a new identity');
    assert.equal(again.revision, 1);

    const reopened = h.store.transaction((tx) =>
      h.port.execute(tx, 'transitionCommitment', { id: c.id, expectedRevision: 2, operation: 'reopen' }, context(nextNow())),
    ) as { id: string; status: string; revision: number };
    assert.equal(reopened.id, c.id, 'reopen keeps identity');
    assert.equal(reopened.status, 'active');
    assert.equal(reopened.revision, 3);
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:3`)), 'pending');
  } finally {
    cleanup(h);
  }
});

test('timezone day boundaries: plan uses the IANA local day, incl. unscheduled and overdue', () => {
  const h = fixture();
  try {
    // E: 2026-06-01 00:30 Auckland (NZST, UTC+12) = 2026-05-31T12:30Z.
    // In the Auckland day 2026-06-01 it is due after the local start (not overdue);
    // in the UTC day 2026-06-01 it is due before the local start (overdue).
    const early = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'Auckland early', dueAt: '2026-05-31T12:30:00.000Z', timeZone: 'Pacific/Auckland' },
        context(nextNow()),
      ),
    ) as { id: string };
    // D: 2026-06-02 01:00 Auckland = 2026-06-01T13:00Z. In the UTC day 2026-06-01
    // it is included; in the Auckland day 2026-06-01 it is after the local end.
    const late = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'Auckland late', dueAt: '2026-06-01T13:00:00.000Z', timeZone: 'Pacific/Auckland' },
        context(nextNow()),
      ),
    ) as { id: string };
    const unscheduled = h.store.transaction((tx) =>
      h.port.execute(tx, 'createCommitment', { title: 'No date', dueAt: null, timeZone: 'UTC' }, context(nextNow())),
    ) as { id: string };

    const utcPlan = h.store.transaction((tx) =>
      h.port.execute(tx, 'plan', { date: '2026-06-01', timeZone: 'UTC' }, context(nextNow())),
    ) as { items: { commitment: { id: string }; isOverdue: boolean }[] };
    const utcIds = utcPlan.items.map((i) => i.commitment.id);
    assert.ok(utcIds.includes(late.id), 'UTC day includes the 13:00Z item');
    assert.equal(utcPlan.items.find((i) => i.commitment.id === early.id)!.isOverdue, true);

    const plan = h.store.transaction((tx) =>
      h.port.execute(tx, 'plan', { date: '2026-06-01', timeZone: 'Pacific/Auckland' }, context(nextNow())),
    ) as {
      items: { commitment: { id: string; title: string }; isOverdue: boolean }[];
      unscheduled: { id: string }[];
    };
    const aklIds = plan.items.map((i) => i.commitment.id);
    assert.ok(aklIds.includes(early.id), 'Auckland day includes the 00:30 NZST item');
    assert.ok(!aklIds.includes(late.id), 'Auckland day excludes the 01:00 NZST next-day item');
    assert.equal(plan.items.find((i) => i.commitment.id === early.id)!.isOverdue, false);
    assert.ok(plan.unscheduled.some((c) => c.id === unscheduled.id));
  } finally {
    cleanup(h);
  }
});

test('unknown ids are typed NOT_FOUND errors, not empty successes', () => {
  const h = fixture();
  try {
    const cases: [() => unknown, string][] = [
      [() => h.store.transaction((tx) => h.port.execute(tx, 'getSession', { id: 'nope' }, context(nextNow()))), 'NOT_FOUND'],
      [() => h.store.transaction((tx) => h.port.execute(tx, 'getCommitment', { id: 'nope' }, context(nextNow()))), 'NOT_FOUND'],
      [() => h.store.transaction((tx) => h.port.execute(tx, 'appendEntry', { sessionId: 'nope', text: 'x', role: 'user', timeZone: 'UTC' }, context(nextNow()))), 'NOT_FOUND'],
      [() => h.store.transaction((tx) => h.port.execute(tx, 'updateCommitment', { id: 'nope', expectedRevision: 1, title: 'x' }, context(nextNow()))), 'NOT_FOUND'],
      [() => h.store.transaction((tx) => h.port.execute(tx, 'recall', { q: 'x', limit: 0 }, context(nextNow()))), 'BAD_REQUEST'],
      [() => h.store.transaction((tx) => h.port.execute(tx, 'createCommitment', { title: '   ', dueAt: null, timeZone: 'UTC' }, context(nextNow()))), 'BAD_REQUEST'],
    ];
    for (const [fn, code] of cases) {
      assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
    }
  } finally {
    cleanup(h);
  }
});

test('reminder targeting: no dispatchable intent without a bound authorized device', () => {
  // No resolver: the need is recorded but cannot be dispatched.
  const unbound = fixture();
  try {
    const c = unbound.store.transaction((tx) =>
      unbound.port.execute(
        tx,
        'createCommitment',
        { title: 'Unbound need', dueAt: '2026-06-01T10:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string };
    const row = unbound.store.transaction((tx) =>
      tx.get('SELECT required_grant, payload FROM runtime_outbox WHERE entity_id = ?', [c.id]),
    ) as { required_grant: string; payload: string };
    assert.equal(row.required_grant, 'native.notify.unbound', 'an absent target must not be a claimable grant');
    assert.equal((JSON.parse(row.payload) as { targetDeviceId: string | null }).targetDeviceId, null);

    const now = '2026-06-01T11:00:00.000Z';
    const dispatchable = unbound.store.transaction((tx) => {
      const claim = Outbox.claim(tx, now, 60_000);
      if (!claim) return 'no-claim';
      return Outbox.revalidate(tx, claim, AUTHORITY, claim.event.entityRevision, now, {
        permits: (grant: string) => grant === 'native.notify',
      });
    });
    assert.equal(dispatchable, false, 'a native.notify policy must not dispatch an unbound need');
  } finally {
    cleanup(unbound);
  }

  // A host-owned resolver binds a device and its scoped grant.
  let target: { deviceId: string; grant: string } | null = { deviceId: 'device-1', grant: 'native.notify' };
  const bound = open(mkdtempSync(join(tmpdir(), 'didi-domain-bar-')), () => target);
  try {
    const c = bound.store.transaction((tx) =>
      bound.port.execute(
        tx,
        'createCommitment',
        { title: 'Bound need', dueAt: '2026-06-01T10:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string };
    const row = bound.store.transaction((tx) =>
      tx.get('SELECT required_grant, payload FROM runtime_outbox WHERE entity_id = ?', [c.id]),
    ) as { required_grant: string; payload: string };
    assert.equal(row.required_grant, 'native.notify');
    assert.equal((JSON.parse(row.payload) as { targetDeviceId: string | null }).targetDeviceId, 'device-1');

    const now = '2026-06-01T11:00:00.000Z';
    const dispatchable = bound.store.transaction((tx) => {
      const claim = Outbox.claim(tx, now, 60_000);
      if (!claim) return 'no-claim';
      return Outbox.revalidate(tx, claim, AUTHORITY, claim.event.entityRevision, now, {
        permits: (grant: string) => grant === 'native.notify',
      });
    });
    assert.equal(dispatchable, true, 'a bound device with the scoped grant is dispatchable');

    // Revocation: the resolver now reports no target, so a correction replaces
    // the bound intent with a non-dispatchable one.
    target = null;
    bound.store.transaction((tx) =>
      bound.port.execute(tx, 'updateCommitment', { id: c.id, expectedRevision: 1, title: 'Bound need (revoked)' }, context(nextNow())),
    );
    const after = bound.store.transaction((tx) =>
      tx.all('SELECT id, required_grant, state FROM runtime_outbox WHERE entity_id = ? ORDER BY entity_revision', [c.id]),
    ) as { id: string; required_grant: string; state: string }[];
    assert.equal(after.length, 2);
    assert.equal(after[0]!.state, 'superseded');
    assert.equal(after[0]!.required_grant, 'native.notify');
    assert.equal(after[1]!.required_grant, 'native.notify.unbound', 'revoked target yields a non-dispatchable need');
  } finally {
    cleanup(bound);
  }
});

test('correction rollback: a failed correction restores the reminder, revision and history', () => {
  const h = fixture();
  try {
    const c = h.store.transaction((tx) =>
      h.port.execute(
        tx,
        'createCommitment',
        { title: 'Send the report', dueAt: '2026-02-01T09:00:00.000Z', timeZone: 'UTC' },
        context(nextNow()),
      ),
    ) as { id: string };
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:1`)), 'pending');

    // The correction really supersedes :1 and inserts :2 before the failure.
    assert.throws(() =>
      h.store.transaction((tx) => {
        const corrected = h.port.execute(
          tx,
          'updateCommitment',
          { id: c.id, expectedRevision: 1, title: 'Changed', dueAt: '2026-02-02T09:00:00.000Z' },
          context(nextNow()),
        ) as { revision: number };
        assert.equal(corrected.revision, 2);
        assert.equal((tx.get('SELECT state FROM runtime_outbox WHERE id = ?', [`${c.id}:1`]) as { state: string }).state, 'superseded');
        assert.equal((tx.get('SELECT state FROM runtime_outbox WHERE id = ?', [`${c.id}:2`]) as { state: string }).state, 'pending');
        throw new Error('forced failure after supersession/insertion');
      }),
    );

    const after = h.store.transaction((tx) =>
      h.port.execute(tx, 'getCommitment', { id: c.id }, context(nextNow())),
    ) as { commitment: { revision: number; title: string; dueAt: string | null }; history: { revision: number }[] };
    assert.equal(after.commitment.revision, 1);
    assert.equal(after.commitment.title, 'Send the report');
    assert.equal(after.commitment.dueAt, '2026-02-01T09:00:00.000Z');
    assert.deepEqual(after.history.map((row) => row.revision), [1]);

    const events = h.store.transaction((tx) =>
      tx.all('SELECT id, state FROM runtime_outbox WHERE entity_id = ? ORDER BY entity_revision', [c.id]),
    ) as { id: string; state: string }[];
    assert.equal(events.length, 1);
    assert.equal(events[0]!.id, `${c.id}:1`);
    assert.equal(events[0]!.state, 'pending', 'the superseded reminder must come back after rollback');
    assert.equal(h.store.transaction((tx) => Outbox.state(tx, `${c.id}:2`)), undefined);
  } finally {
    cleanup(h);
  }
});

test('session listing is complete: more than fifty sessions are all returned', () => {
  const h = fixture();
  try {
    const created: string[] = [];
    for (let i = 0; i < 55; i += 1) {
      const session = h.store.transaction((tx) =>
        h.port.execute(tx, 'createSession', { title: `Session ${i}`, timeZone: 'UTC' }, context(nextNow())),
      ) as { id: string };
      created.push(session.id);
    }
    const list = h.store.transaction((tx) =>
      h.port.execute(tx, 'listSessions', {}, context(nextNow())),
    ) as { items: { id: string }[]; nextCursor: null };
    assert.equal(list.items.length, 55, 'a full listing must not silently truncate');
    assert.equal(list.nextCursor, null);
    for (const id of created) assert.ok(list.items.some((item) => item.id === id));
  } finally {
    cleanup(h);
  }
});
