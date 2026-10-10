import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { openMemoryFixture, result, ROUTE_CLASSES } from './memory-context-process.js';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { chatMigrations, ChatError, type ChatConfig, type RunSnapshot } from '../chat/index.js';
import type { ModelPort, ModelRequest, ModelControl, ModelResult } from '../adapters/model/types.js';
import type { DomainContext, SourceRef } from '../contracts/domain.js';

class CountingModel implements ModelPort {
  calls: ModelRequest[] = []; controls: ModelControl[] = [];
  pending: ((value: ModelResult) => void)[] = [];
  #waiters: { n: number; resolve: () => void }[] = [];
  delayed = false; status: ModelResult['status'] = 'complete'; text = 'Answer';
  generate(request: ModelRequest, control: ModelControl): Promise<ModelResult> {
    this.calls.push(request); this.controls.push(control);
    for (const waiter of this.#waiters) if (this.calls.length >= waiter.n) waiter.resolve();
    if (this.delayed) return new Promise(resolve => this.pending.push(resolve));
    return Promise.resolve(result(request, this.status, this.text));
  }
  waitFor(n = 1): Promise<void> {
    if (this.calls.length >= n) return Promise.resolve();
    return new Promise<void>(resolve => this.#waiters.push({ n, resolve }));
  }
  finish(index = 0) { this.pending[index]?.(result(this.calls[index]!, this.status, this.text)); }
}

function fixture(overrides: Partial<ChatConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-ctx-')); const model = new CountingModel();
  const f = openMemoryFixture(dir, model, overrides);
  return { ...f, model, dir,
    close() { f.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function terminal(f: ReturnType<typeof fixture>, run: RunSnapshot) {
  for await (const event of f.chat.subscribe(run.runId, f.context))
    if (event.type === 'snapshot' && event.run.state === 'terminal') return event.run;
  throw Error('no durable terminal event');
}
async function started(f: ReturnType<typeof fixture>, n = 1) { await f.model.waitFor(n); assert.equal(f.model.calls.length, n); }
function recordOf(request: ModelRequest, entryId: string) {
  const item = request.context.items.find(i => i.id === `selected:${entryId}`);
  assert.ok(item, 'selected evidence item present');
  return JSON.parse(JSON.parse(item!.text).text);
}
function error(code: string) { return (e: unknown) => e instanceof ChatError && e.code === code && !e.localCapture; }
function chatVersions(store: Store): number[] {
  return store.transaction(tx => tx.all("SELECT version FROM runtime_migrations WHERE owner='chat' ORDER BY version", [])).map(r => Number(r.version));
}
function sourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return { id: 'source-1', label: 'Inbox', provider: 'synthetic-mail', externalId: 'msg-1',
    sourceTimestamp: '2026-01-02T03:04:05.000Z', availability: 'present', note: 'imported', ...overrides };
}
function accept(f: ReturnType<typeof fixture>, sessionId: string, text: string, key: string, selection?: readonly string[], context: DomainContext = f.context) {
  return f.chat.accept({ sessionId, text, idempotencyKey: key, ...(selection ? { selectedMemoryEntryIds: selection } : {}) }, context);
}

// 1. Cross-session selected record with exact source refs and frozen context row.
test('cross-session selected record is resolved, frozen, classified and delivered with exact source refs', async () => {
  const f = fixture();
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Cross-session memory payload', sourceRef());
    const sending = f.enroll();
    const run = accept(f, sending.id, 'Use my other session note', 'sel-1', [record.id], { ...f.context, clientId: 'principal-b' });
    assert.deepEqual(run.memorySelection?.requestedIds, [record.id]);
    assert.equal(run.memorySelection?.frozen, false);
    await started(f);
    const request = f.model.calls[0]!;
    const parsed = recordOf(request, record.id);
    assert.equal(parsed.entryId, record.id); assert.equal(parsed.sessionId, source.id);
    assert.equal(parsed.text, 'Cross-session memory payload'); assert.equal(parsed.role, 'user');
    assert.equal(parsed.capturedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(parsed.sourceTimestamp, null);
    assert.deepEqual(parsed.sourceRefs, [{ id: 'source-1', label: 'Inbox', provider: 'synthetic-mail',
      externalId: 'msg-1', sourceTimestamp: '2026-01-02T03:04:05.000Z', availability: 'present', note: 'imported' }]);
    assert.deepEqual(request.declarations, []);
    assert.ok(request.dataClasses.includes('private'));
    const row = f.store.transaction(tx => tx.get('SELECT * FROM chat_run_context WHERE run_id=?', [run.runId]));
    assert.ok(row); assert.equal(Number(row!.schema_version), 1);
    assert.deepEqual(JSON.parse(String(row!.requested_ids)), [record.id]);
    const frozen = JSON.parse(String(row!.resolved_records));
    assert.equal(frozen[0].text, 'Cross-session memory payload');
    await terminal(f, run);
    const snapshot = f.chat.get(run.runId, f.context).memorySelection;
    assert.deepEqual(snapshot?.requestedIds, [record.id]);
    assert.deepEqual(snapshot?.usedIds, [record.id]);
    assert.deepEqual(snapshot?.omitted, []);
    assert.deepEqual(snapshot?.counts, { requested: 1, used: 1, omitted: 0 });
    assert.equal(snapshot?.frozen, true);
  } finally { f.close(); }
});

// 2. Idempotency: same / reordered / duplicate-equal / empty / different selection.
test('selection normalization drives idempotency: reordered equal replays, different or empty conflicts', async () => {
  const f = fixture();
  try {
    const source = f.createSession('Source');
    const e1 = f.append(source.id, 'one'); const e2 = f.append(source.id, 'two');
    const sending = f.enroll();
    const run1 = accept(f, sending.id, 't', 'k1', [e2.id, e1.id]);
    await started(f);
    const canonical = [e1.id, e2.id].sort();
    const row = f.store.transaction(tx => tx.get('SELECT requested_ids FROM chat_run_context WHERE run_id=?', [run1.runId]))!;
    assert.deepEqual(JSON.parse(String(row.requested_ids)), canonical);
    assert.equal(accept(f, sending.id, 't', 'k1', [e1.id, e2.id]).runId, run1.runId);
    assert.equal(accept(f, sending.id, 't', 'k1', [e1.id, e1.id, e2.id]).runId, run1.runId);
    assert.throws(() => accept(f, sending.id, 't', 'k1', []), error('idempotency_conflict'));
    assert.throws(() => accept(f, sending.id, 't', 'k1', [e1.id]), error('idempotency_conflict'));
    await terminal(f, run1);
    const run2 = accept(f, sending.id, 't2', 'k2');
    await started(f, 2); await terminal(f, run2);
    assert.equal(f.store.transaction(tx => tx.get('SELECT COUNT(*) c FROM chat_run_context WHERE run_id=?', [run2.runId]))!.c, 0);
    assert.equal(f.model.calls.length, 2);
  } finally { f.close(); }
});

// 3. unknown / foreign / over-policy entry and unknown parent fail with no capture.
test('unknown, foreign, over-policy and unknown-parent selections fail with no capture', async () => {
  const f = fixture();
  const otherDir = mkdtempSync(join(tmpdir(), 'mem-other-'));
  try {
    const sending = f.enroll();
    assert.throws(() => accept(f, sending.id, 'x', 'u1', ['no-such-entry']), error('not_found'));
    const otherDomain = createDomainPort({ outbox: Outbox });
    const otherStore = new Store(otherDir, [...otherDomain.migrations, ...chatMigrations]);
    const otherContext: DomainContext = { assistantId: otherStore.assistantId, clientId: 'x', authorityEpoch: otherStore.authorityEpoch, now: new Date(0).toISOString() };
    const otherSession = otherStore.transaction(tx => otherDomain.execute(tx, 'createSession', { title: 'Foreign', timeZone: 'UTC' }, otherContext, { writer: 'capture', dataClass: 'private' }));
    const foreign = otherStore.transaction(tx => otherDomain.execute(tx, 'appendEntry', { sessionId: otherSession.id, text: 'Foreign record', role: 'user', timeZone: 'UTC' }, otherContext, { writer: 'capture', dataClass: 'private' }));
    otherStore.close();
    assert.throws(() => accept(f, sending.id, 'x', 'u2', [foreign.id]), error('not_found'));
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Over policy', sourceRef({ id: 'over-1' }));
    f.chat.correctRoutingLabel({ subject: { kind: 'entry', id: record.id }, expectedRevision: 1, dataClass: 'sensitive' }, f.context);
    assert.throws(() => accept(f, sending.id, 'x', 'u3', [record.id]), error('unavailable'));
    const unlabeled = f.createUnlabeledSession('Legacy');
    const legacy = f.append(unlabeled.id, 'Legacy record', sourceRef({ id: 'legacy-1' }));
    assert.throws(() => accept(f, sending.id, 'x', 'u4', [legacy.id]), error('unavailable'));
    assert.equal(f.entries(sending.id).length, 0);
    assert.equal(Number(f.store.transaction(tx => tx.get('SELECT COUNT(*) c FROM chat_runs', []))!.c), 0);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); rmSync(otherDir, { recursive: true, force: true }); }
});

// 3b. invalid shape, UTF-8 byte-bound overflow and non-ASCII behaviour.
test('invalid selection shape and UTF-8 byte overflow are refused before any capture', async () => {
  const f = fixture();
  try {
    const sending = f.enroll();
    const bad: unknown[] = ['not-an-array', [1], [''], ['bad id'], new Array(33).fill('x')];
    for (const value of bad)
      assert.throws(() => f.chat.accept({ sessionId: sending.id, text: 'x', idempotencyKey: randomUUID(), selectedMemoryEntryIds: value as never }, f.context), error('invalid_input'));
    const source = f.createSession('Source');
    const huge = f.append(source.id, 'Q'.repeat(200000), sourceRef());
    assert.throws(() => accept(f, sending.id, 'x', 'big', [huge.id]), error('selection_too_large'));
    // 40k UTF-16 code units but ~120k UTF-8 bytes: only the byte bound refuses it.
    const multibyte = f.append(source.id, '\u20ac'.repeat(40000), sourceRef({ id: 's-euro' }));
    assert.throws(() => accept(f, sending.id, 'x', 'big-mb', [multibyte.id]), error('selection_too_large'));
    assert.equal(f.entries(sending.id).length, 0);
    assert.equal(Number(f.store.transaction(tx => tx.get('SELECT COUNT(*) c FROM chat_runs', []))!.c), 0);
    // A small non-ASCII selection fits: the bound is capacity, not a workload promise.
    const small = f.append(source.id, 'caf\u00e9 \u2615', sourceRef({ id: 's-small' }));
    const run = accept(f, sending.id, 'small', 'small-mb', [small.id]);
    await started(f);
    assert.equal(recordOf(f.model.calls[0]!, small.id).text, 'caf\u00e9 \u2615');
    await terminal(f, run);
  } finally { f.close(); }
});

// 3c. a missing source reference stays missing through frozen data and evidence.
test('a missing source reference stays missing through frozen data and emitted evidence', async () => {
  const f = fixture();
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Missing source record', sourceRef({ id: 'missing-1', availability: 'missing', sourceTimestamp: null }));
    const sending = f.enroll();
    const run = accept(f, sending.id, 'go', 'miss-1', [record.id]);
    await started(f);
    const parsed = recordOf(f.model.calls[0]!, record.id);
    const expected = [{ id: 'missing-1', label: 'Inbox', provider: 'synthetic-mail', externalId: 'msg-1', sourceTimestamp: null, availability: 'missing', note: 'imported' }];
    assert.equal(parsed.sourceTimestamp, null);
    assert.deepEqual(parsed.sourceRefs, expected);
    const stored = JSON.parse(String(f.store.transaction(tx => tx.get('SELECT resolved_records FROM chat_run_context WHERE run_id=?', [run.runId]))!.resolved_records));
    assert.deepEqual(stored[0].sourceRefs, expected);
    await terminal(f, run);
  } finally { f.close(); }
});

// 4. Frozen source snapshot: the row is written once and dispatch never re-reads Domain.
test('frozen source snapshot stays byte-identical from acceptance to terminal', async () => {
  const f = fixture();
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Snapshot body', sourceRef());
    const sending = f.enroll();
    const run = accept(f, sending.id, 'read it', 'snap-1', [record.id]);
    const before = String(f.store.transaction(tx => tx.get('SELECT resolved_records FROM chat_run_context WHERE run_id=?', [run.runId]))!.resolved_records);
    await started(f);
    const sent = recordOf(f.model.calls[0]!, record.id);
    assert.deepEqual(sent, JSON.parse(before)[0]);
    await terminal(f, run);
    const after = String(f.store.transaction(tx => tx.get('SELECT resolved_records FROM chat_run_context WHERE run_id=?', [run.runId]))!.resolved_records);
    assert.equal(after, before);
  } finally { f.close(); }
});

// 5. Include/omit budget accounting with honest reasons and no text slicing.
test('budget accounting reports omit reasons and never slices evidence text', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 6000, historyChars: 12000 }, sources: [] } });
  try {
    const source = f.createSession('Source');
    const r1 = f.append(source.id, 'X'.repeat(3000), sourceRef({ id: 's1' }));
    const r2 = f.append(source.id, 'Y'.repeat(3000), sourceRef({ id: 's2' }));
    const huge = f.append(source.id, 'Z'.repeat(20000), sourceRef({ id: 's3' }));
    const sending = f.enroll();
    const run1 = accept(f, sending.id, 'pick', 'b1', [r1.id, r2.id]);
    await started(f);
    const request = f.model.calls[0]!;
    const included = [r1.id, r2.id].filter(id => request.context.items.some(i => i.id === `selected:${id}`));
    assert.equal(included.length, 1);
    await terminal(f, run1);
    const sel = f.chat.get(run1.runId, f.context).memorySelection!;
    assert.deepEqual(sel.counts, { requested: 2, used: 1, omitted: 1 });
    const omittedId = sel.omitted[0]!.id;
    assert.equal(sel.omitted[0]!.reason, 'budget');
    const omittedText = omittedId === r1.id ? 'X'.repeat(3000) : 'Y'.repeat(3000);
    assert.ok(!request.context.items.some(i => i.text.includes(omittedText)));
    const includedText = included[0] === r1.id ? 'X'.repeat(3000) : 'Y'.repeat(3000);
    assert.ok(request.context.items.some(i => i.text.includes(includedText)));
    const run2 = accept(f, sending.id, 'oversized', 'b2', [huge.id]);
    await started(f, 2);
    const request2 = f.model.calls[1]!;
    assert.ok(!request2.context.items.some(i => i.id === `selected:${huge.id}`));
    await terminal(f, run2);
    const sel2 = f.chat.get(run2.runId, f.context).memorySelection!;
    assert.deepEqual(sel2.usedIds, []);
    assert.deepEqual(sel2.omitted, [{ id: huge.id, reason: 'oversized' }]);
  } finally { f.close(); }
});

// 6. Correction of an included entry before dispatch: no provider call.
test('correcting an included entry before dispatch aborts with no provider call', async () => {
  const work: (() => void)[] = [];
  const f = fixture({ schedule: task => work.push(task) });
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Before dispatch', sourceRef());
    const sending = f.enroll();
    const run = accept(f, sending.id, 'first', 'c1', [record.id]);
    assert.equal(run.state, 'accepted');
    f.chat.correctRoutingLabel({ subject: { kind: 'entry', id: record.id }, expectedRevision: 1, dataClass: 'sensitive' }, f.context);
    for (const task of work) task();
    const done = f.chat.get(run.runId, f.context);
    assert.equal(done.state, 'terminal'); assert.equal(done.outcome, 'cancelled');
    assert.equal(f.model.calls.length, 0);
    assert.equal(f.entries(sending.id).length, 1);
  } finally { f.close(); }
});

// 7. Correction after intent: abort in-flight generation, never commit an answer.
test('correcting an included entry after intent aborts in-flight generation with no committed answer', async () => {
  const f = fixture(); f.model.delayed = true;
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'In flight', sourceRef());
    const sending = f.enroll();
    const run = accept(f, sending.id, 'go', 'd1', [record.id]);
    await started(f);
    assert.equal(f.chat.get(run.runId, f.context).state, 'dispatch_intent');
    f.model.controls[0]!.onEvent?.({ type: 'text', text: 'partial answer', provisional: true });
    assert.equal(f.chat.get(run.runId, f.context).partialText, 'partial answer');
    f.chat.correctRoutingLabel({ subject: { kind: 'entry', id: record.id }, expectedRevision: 1, dataClass: 'sensitive' }, f.context);
    const done = f.chat.get(run.runId, f.context);
    assert.equal(done.outcome, 'cancelled');
    assert.equal(done.finalEntryId, null); assert.equal(done.finalText, null);
    assert.equal(done.mayHaveBeenSent, true);
    assert.equal(f.entries(sending.id).length, 1);
    f.model.finish();
    assert.equal(f.chat.get(run.runId, f.context).outcome, 'cancelled');
    assert.equal(f.entries(sending.id).length, 1);
  } finally { f.close(); }
});

// 8. Correction of an omitted-only record does not cancel the run.
test('a correction of an omitted-only record does not cancel the run', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 6000, historyChars: 12000 }, sources: [] } });
  f.model.delayed = true;
  try {
    const source = f.createSession('Source');
    const r1 = f.append(source.id, 'A'.repeat(3000), sourceRef({ id: 's1' }));
    const r2 = f.append(source.id, 'B'.repeat(3000), sourceRef({ id: 's2' }));
    const sending = f.enroll();
    const run = accept(f, sending.id, 'pick', 'o1', [r1.id, r2.id]);
    await started(f);
    const parsed = JSON.parse(String(f.store.transaction(tx => tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId]))!.trace));
    const included = parsed.manifest.selectedIds.filter((id: string) => id.startsWith('selected:')).map((id: string) => id.slice('selected:'.length));
    const omitted = parsed.manifest.omitted.filter((o: { id: string }) => o.id.startsWith('selected:')).map((o: { id: string }) => o.id.slice('selected:'.length));
    assert.equal(included.length, 1); assert.equal(omitted.length, 1);
    f.chat.correctRoutingLabel({ subject: { kind: 'entry', id: omitted[0] }, expectedRevision: 1, dataClass: 'sensitive' }, f.context);
    assert.equal(f.chat.get(run.runId, f.context).state, 'dispatch_intent');
    f.model.finish();
    const done = await terminal(f, run); assert.equal(done.outcome, 'complete');
    assert.ok(f.model.calls[0]!.context.items.some(i => i.id === `selected:${included[0]}`));
  } finally { f.close(); }
});

// 9. Sending grant revoke cancels; a source conversation grant is not a global ban.
test('revoking the sending conversation cancels; a source conversation grant is not a global ban', async () => {
  const f = fixture(); f.model.delayed = true;
  try {
    const sourceConv = f.enroll();
    const record = f.append(sourceConv.id, 'Shared record', sourceRef());
    const sending = f.enroll();
    const run1 = accept(f, sending.id, 'first', 'r1', [record.id]);
    await started(f, 1);
    f.chat.revoke(sourceConv.id, f.context);
    assert.equal(f.chat.get(run1.runId, f.context).state, 'dispatch_intent');
    f.model.finish(0);
    assert.equal((await terminal(f, run1)).outcome, 'complete');
    const sending2 = f.enroll();
    const run2 = accept(f, sending2.id, 'second', 'r2', [record.id]);
    await started(f, 2);
    f.chat.revoke(sending2.id, f.context);
    assert.equal(f.chat.get(run2.runId, f.context).outcome, 'cancelled');
    assert.equal(f.entries(sending2.id).length, 1);
    f.model.finish(1);
    assert.equal(f.chat.get(run2.runId, f.context).outcome, 'cancelled');
  } finally { f.close(); }
});

// 10. Parent session label correction aborts an included record.
test('correcting an included record parent session aborts the run', async () => {
  const f = fixture(); f.model.delayed = true;
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Child record', sourceRef());
    const sending = f.enroll();
    const run = accept(f, sending.id, 'go', 'p1', [record.id]);
    await started(f);
    assert.equal(f.chat.get(run.runId, f.context).state, 'dispatch_intent');
    f.chat.correctRoutingLabel({ subject: { kind: 'session', id: source.id }, expectedRevision: 1, dataClass: 'ordinary' }, f.context);
    const done = f.chat.get(run.runId, f.context);
    assert.equal(done.outcome, 'cancelled');
    assert.equal(f.entries(sending.id).length, 1);
  } finally { f.close(); }
});

// 11. Two client principals share one owner; clientId is audit, not a tenant.
test('two client principals share one owner: a record under one principal is selectable by the other', async () => {
  const f = fixture();
  try {
    const source = f.createSession('Source', { ...f.context, clientId: 'principal-a' });
    const record = f.append(source.id, 'Owner-shared record', sourceRef());
    const sending = f.enroll();
    const run = accept(f, sending.id, 'cross principal', 'cp1', [record.id], { ...f.context, clientId: 'principal-b' });
    await started(f);
    assert.ok(f.model.calls[0]!.context.items.some(i => i.id === `selected:${record.id}`));
    await terminal(f, run);
    const row = f.store.transaction(tx => tx.get('SELECT accepting_client_id FROM chat_runs WHERE run_id=?', [run.runId]));
    assert.equal(row!.accepting_client_id, 'principal-b');
  } finally { f.close(); }
});

// 12. Additive migration on a prior clean v1 schema preserves old hashes and consent.
test('additive chat v3 migration upgrades a populated v1+v2 DB and preserves old records, fingerprint and consent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-migrate-'));
  const model = new CountingModel();
  try {
    const f1 = openMemoryFixture(dir, model, {}, chatMigrations.filter(m => m.version <= 2));
    assert.deepEqual(chatVersions(f1.store), [1, 2]);
    const source = f1.createSession('Source');
    const record = f1.append(source.id, 'Old record', sourceRef());
    assert.equal(record.id.length > 0, true);
    const sending = f1.enroll();
    const run = f1.chat.accept({ sessionId: sending.id, text: 'Old turn', idempotencyKey: 'old' }, f1.context);
    const before = f1.store.transaction(tx => tx.get('SELECT fingerprint,idempotency_key,session_id,state FROM chat_runs WHERE run_id=?', [run.runId]));
    const consentBefore = f1.store.transaction(tx => tx.get('SELECT * FROM chat_consents WHERE session_id=?', [sending.id]));
    f1.store.close();
    const f2 = openMemoryFixture(dir, model, {}, chatMigrations);
    try {
      assert.deepEqual(chatVersions(f2.store), [1, 2, 3]);
      assert.equal(f2.store.transaction(tx => tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_run_context'"))!.name, 'chat_run_context');
      assert.equal(Number(f2.store.transaction(tx => tx.get('SELECT COUNT(*) c FROM chat_run_context', []))!.c), 0);
      const after = f2.store.transaction(tx => tx.get('SELECT fingerprint,idempotency_key,session_id FROM chat_runs WHERE run_id=?', [run.runId]));
      assert.deepEqual({ ...after }, { fingerprint: before!.fingerprint, idempotency_key: before!.idempotency_key, session_id: before!.session_id });
      assert.deepEqual(f2.store.transaction(tx => tx.get('SELECT * FROM chat_consents WHERE session_id=?', [sending.id])), consentBefore);
      const replay = f2.chat.accept({ sessionId: sending.id, text: 'Old turn', idempotencyKey: 'old' }, f2.context);
      assert.equal(replay.runId, run.runId);
      assert.equal(model.calls.length, 0);
      assert.throws(() => f2.chat.accept({ sessionId: sending.id, text: 'Old turn', idempotencyKey: 'old', selectedMemoryEntryIds: [record.id] }, f2.context), error('idempotency_conflict'));
    } finally { f2.store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 3d. resolution is isolated to entry-kind source references.
test('resolution is isolated to entry-kind source references for a selected entry', async () => {
  const f = fixture();
  try {
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Kind isolation', sourceRef({ id: 'entry-ref' }));
    // Synthetic collision: a commitment-kind row that shares the selected entry id.
    f.store.transaction(tx => tx.run(
      `INSERT INTO source_references (id,owner_kind,owner_id,source_label,provider,account_id,external_id,source_timestamp,availability,note)\n       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['commitment-ref', 'commitment', record.id, 'Should not leak', null, null, null, null, 'present', null]));
    const sending = f.enroll();
    const run = accept(f, sending.id, 'go', 'kind-1', [record.id]);
    await started(f);
    const parsed = recordOf(f.model.calls[0]!, record.id);
    assert.deepEqual(parsed.sourceRefs.map((r: { id: string }) => r.id), ['entry-ref']);
    await terminal(f, run);
  } finally { f.close(); }
});

// 13. Real SIGKILL: frozen selection survives, no provider redispatch.
for (const mode of ['accepted', 'intent'] as const) {
  test(`real SIGKILL ${mode}: frozen selection survives, outcome ${mode === 'accepted' ? 'not_dispatched' : 'outcome_unknown'}, no redispatch`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-kill-')); const model = new CountingModel();
    const f = openMemoryFixture(dir, model);
    const source = f.createSession('Source');
    const record = f.append(source.id, 'Frozen across kill', sourceRef());
    const sending = f.enroll();
    f.store.close();
    const child = fork(new URL('./memory-context-process.js', import.meta.url), ['child', dir, mode, sending.id, record.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let runId = ''; let killed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`child checkpoint ${mode} missing`)), 10000);
        child.on('error', reject);
        child.on('message', (message: unknown) => {
          const event = message as { phase: string; runId?: string }; if (event.runId) runId = event.runId;
          if (event.phase === mode) { clearTimeout(timer); resolve(); }
        });
      });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); killed = true; await exited;
      assert.ok(runId);
      const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').length : 0;
      assert.equal(calls, 0);
      const recovered = openMemoryFixture(dir, model);
      try {
        const snapshot = recovered.chat.get(runId, recovered.context);
        assert.equal(snapshot.outcome, mode === 'accepted' ? 'not_dispatched' : 'outcome_unknown');
        assert.deepEqual(snapshot.memorySelection?.requestedIds, [record.id]);
        const row = recovered.store.transaction(tx => tx.get('SELECT * FROM chat_run_context WHERE run_id=?', [runId]));
        assert.ok(row);
        assert.equal(JSON.parse(String(row!.resolved_records))[0].text, 'Frozen across kill');
        assert.equal(model.calls.length, 0);
        const replay = recovered.chat.accept({ sessionId: sending.id, text: 'Synthetic selected child turn', idempotencyKey: 'child', selectedMemoryEntryIds: [record.id] }, recovered.context);
        assert.equal(replay.runId, runId);
        assert.equal(model.calls.length, 0);
      } finally { recovered.store.close(); }
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Sanity: the synthetic route classes the fixture uses.
test('fixture route permits the enrolled consent classes', () => { assert.deepEqual([...ROUTE_CLASSES], ['ordinary', 'private']); });
