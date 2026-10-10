import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, barrier, scope, syntheticKey, rotatedKey, answer, sourceId, type FixtureOptions } from './tool-chat-process.js';
import type { ToolResultRef } from '../adapters/model/types.js';

async function open(t: TestContext, options: FixtureOptions = {}) {
  const f = await fixture(options); t.after(() => f.close()); return f;
}
function forbiddenContinuation(calls: { body: string }[]) {
  return calls.filter(call => call.body.includes('functionResponse')).length;
}
function safeFailure(value: unknown) {
  assert.ok(value instanceof Error || (value && typeof value === 'object' && 'outcome' in value && value.outcome !== 'complete'),
    'A refused run must not look like completed synthetic evidence');
  assert.doesNotMatch(JSON.stringify(value), /tool-chat-synthetic-key/);
}

// B1: Fault the owning snapshot boundary AFTER it writes, inside the real
// Store transaction. Counting every owned table catches orphan user/policy/run
// (and, once imported by root, persona) rows, not only an HTTP success code.
test('B1 snapshot failure rolls back every acceptance write', async t => {
  const f = await open(t); const session = f.enroll(); const before = f.counts();
  const original = f.tools.snapshotRun;
  f.tools.snapshotRun = (tx, input) => { original(tx, input); throw Error('synthetic snapshot failure'); };
  assert.throws(() => f.accept(session), /synthetic snapshot failure|unavailable|persistence/);
  assert.deepEqual(f.counts(), before);
  assert.equal(f.sdkCalls.length, 0); assert.equal(f.modelCalls.length, 0);
});
test('B1 missing protected binding captures nothing; replay preserves one run and one SDK effect', async t => {
  const f = await open(t); const session = f.enroll(); const before = f.counts();
  writeFileSync(f.recordPath, '{malformed synthetic binding', { mode: 0o600 });
  assert.throws(() => f.accept(session)); assert.deepEqual(f.counts(), before);
  f.writeRecord(); const key = randomUUID(); const accepted = f.accept(session, key);
  const terminal = await f.terminal(accepted); assert.equal(terminal.outcome, 'complete');
  const calls = f.sdkCalls.length; assert.equal(calls, 1);
  const counts = f.counts(); const replay = f.accept(session, key);
  assert.equal(replay.runId, accepted.runId); assert.deepEqual(f.counts(), counts);
  assert.equal(f.sdkCalls.length, calls);
  assert.throws(() => f.accept(session, key, []), /idempotency_conflict/);
  const intents = f.store.transaction(tx => tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '%intent%'"));
  assert.ok(intents.length > 0, 'Durable tools dispatch journal must exist');
  assert.equal(terminal.toolReferences.length, 1, 'Replay must not invent another durable result reference');
});

test('B2 accepted definitions/hash survive a changed live catalog and policy', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const accepted = f.accept(f.enroll()); const done = f.terminal(accepted);
  await gate.entered;
  try {
    const definitions = f.tools.definitions(accepted.runId);
    assert.ok(definitions.length > 0); assert.equal(typeof accepted.toolBindingHash, 'string');
    assert.match(accepted.toolBindingHash, /^[a-f0-9]{64}$/);
    f.setLiveDefinitions(); await f.port.discover(f.policy().endpoint.id);
    assert.deepEqual(f.tools.definitions(accepted.runId), definitions, 'Live schema must not replace accepted declarations');
    f.updatePolicy({ generation: 2, enabled: false });
    assert.equal(f.chat.get(accepted.runId, f.context).toolBindingHash, accepted.toolBindingHash);
  } finally { gate.release(); }
  safeFailure(await done.catch(error => error));
  assert.equal(f.modelCalls.length, 0); assert.equal(f.sdkCalls.length, 0);
});
for (const kind of ['connection', 'schema', 'source', 'wrong-class', 'unmapped-class'] as const) {
  test(`B2/B4 later-step ${kind} denial prevents all result continuation egress`, async t => {
    const gate = barrier(); const f = await open(t, { beforeContinuation: gate.pause });
    const accepted = f.accept(f.enroll()); const done = f.terminal(accepted);
    await gate.entered;
    try {
      assert.equal(f.sdkCalls.length, 1, 'Denied continuation must start with a real completed SDK result');
      assert.equal(f.modelCalls.length, 1, 'Only the permitted first model request has left');
      if (kind === 'connection') f.updatePolicy({ generation: 2, enabled: false });
      if (kind === 'schema') f.updatePolicy({ generation: 2, schemaDigest: '0'.repeat(64) });
      if (kind === 'source') f.updatePolicy({ generation: 2, sourcePolicy: { ...f.policy().sourcePolicy, revision: 2, allowedClasses: [] } });
      if (kind === 'wrong-class') f.updatePolicy({ generation: 2, sourcePolicy: { ...f.policy().sourcePolicy, revision: 2, unknownClass: 'private', allowedClasses: ['private'] } });
      if (kind === 'unmapped-class') f.updatePolicy({ generation: 2, sourcePolicy: { ...f.policy().sourcePolicy, revision: 2, unknownClass: null } });
    } finally { gate.release(); }
    safeFailure(await done.catch(error => error));
    assert.equal(forbiddenContinuation(f.modelCalls), 0, 'Owner gate must be called again at lower egress, not only before credentials resolve');
    assert.equal(f.sdkCalls.length, 1, 'A denied result is never re-executed');
  });
}

test('B3 real SDK evidence reaches a model continuation and durable references', async t => {
  const f = await open(t); const accepted = f.accept(f.enroll()); const final = await f.terminal(accepted);
  assert.equal(final.outcome, 'complete'); assert.match(final.finalText!, /Synthetic insight 731/);
  assert.equal(f.sdkCalls.length, 1); assert.equal(f.modelCalls.length, 2);
  assert.equal(forbiddenContinuation(f.modelCalls), 1);
  assert.match(f.modelCalls[1]!.body, /Synthetic nonempty evidence/);
  assert.ok(final.toolReferences.length > 0, 'Nonempty durable tool references, never transient MCP buffers');
  assert.ok(final.sourceIds.includes(sourceId), 'Trusted identifier is derived by tools owner, not model URL');
  assert.deepEqual(f.chat.get(final.runId, f.context).toolReferences, final.toolReferences);
  assert.ok(answer.length > 0);
});

const mutations = ['consent-revoke', 'consent-revision', 'epoch', 'run', 'selected-label', 'exact-route',
  'credential-account', 'credential-scope', 'credential-generation', 'credential-delete', 'credential-malformed', 'abort', 'deadline'] as const;
// BOTH barrier positions are necessary. afterResolve changes the current
// protected locator after key+receipt were parsed: receipt-only guards fail.
for (const position of ['beforeResolve', 'afterResolve'] as const) for (const mutation of mutations) {
  test(`B4 ${position}: ${mutation} produces zero lower transport calls`, async t => {
    const gate = barrier(); const f = await open(t, { [position]: gate.pause });
    const session = f.enroll(); const accepted = f.accept(session); const done = f.terminal(accepted);
    await gate.entered;
    try {
      assert.equal(f.modelCalls.length, 0, 'Barrier must be above the actual injected lower transport');
      if (position === 'afterResolve') assert.equal(f.receipt().bindingGeneration, 'synthetic-generation-1', 'Valid receipt exists before the mutation');
      if (mutation === 'consent-revoke') f.chat.revoke(session, f.context);
      if (mutation === 'consent-revision') f.store.transaction(tx => tx.run('UPDATE chat_consents SET revision = revision + 1 WHERE session_id = ?', [session]));
      if (mutation === 'epoch') f.store.transaction(tx => tx.run('UPDATE chat_runs SET authority_epoch = ? WHERE run_id = ?', ['synthetic-obsolete-epoch', accepted.runId]));
      if (mutation === 'run') f.store.transaction(tx => tx.run('UPDATE chat_runs SET owner_assistant_id = ? WHERE run_id = ?', ['synthetic-other-owner', accepted.runId]));
      if (mutation === 'selected-label') f.store.transaction(tx => tx.run('UPDATE chat_run_policy SET selected_labels = ? WHERE run_id = ?', ['[]', accepted.runId]));
      if (mutation === 'exact-route') writeFileSync(join(f.configDir, 'profile.json'), JSON.stringify({ ...f.profile, modelId: 'gemini-other-synthetic' }), { mode: 0o600 });
      if (mutation === 'credential-account') f.writeRecord({ configuredAccount: 'operator-asserted-other-synthetic-account' });
      if (mutation === 'credential-scope') f.writeRecord({ routeScope: { ...scope, allowedClasses: ['ordinary', 'private'] } });
      if (mutation === 'credential-generation') f.writeRecord({ bindingGeneration: 'synthetic-generation-2' });
      if (mutation === 'credential-delete') rmSync(f.recordPath);
      if (mutation === 'credential-malformed') writeFileSync(f.recordPath, '{synthetic-malformed', { mode: 0o600 });
      if (mutation === 'abort') f.chat.cancel(accepted.runId, f.context);
      if (mutation === 'deadline') f.advance(5000);
    } finally { gate.release(); }
    safeFailure(await done.catch(error => error));
    assert.equal(f.modelCalls.length, 0, 'Forbidden actual lower fetch count must be zero, including injected transports');
    assert.equal(f.sdkCalls.length, 0);
  });
}

test('B5 same-binding rotation sends the new key only to the lower trusted transport', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const accepted = f.accept(f.enroll()); const done = f.terminal(accepted); await gate.entered;
  try { f.writeRecord({ key: rotatedKey }); } finally { gate.release(); }
  const final = await done; assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
  assert.ok(f.modelCalls.length >= 2); assert.ok(f.modelCalls.every(call => call.key === rotatedKey));
  const publicState = JSON.stringify({ final, bodies: f.modelCalls.map(call => call.body), sdk: f.sdkCalls, counts: f.counts() });
  for (const key of [syntheticKey, rotatedKey]) {
    assert.ok(!publicState.includes(key));
    for (const name of readdirSync(f.dir)) if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(name)) {
      assert.ok(!readFileSync(join(f.dir, name)).includes(Buffer.from(key)), `No key in SQLite ${name}`);
    }
  }
});
test('B5 simultaneous sessions cannot consume another invocation receipt/result handoff', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const first = f.accept(f.enroll('Synthetic first')); const firstDone = f.terminal(first); await gate.entered;
  try {
    f.chat.cancel(first.runId, f.context);
    f.writeRecord({ key: rotatedKey, configuredAccount: 'operator-asserted-synthetic-second' });
    const second = f.accept(f.enroll('Synthetic second')); const final = await f.terminal(second);
    assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
    assert.equal(f.modelCalls.length, 2); assert.ok(f.modelCalls.every(call => call.key === rotatedKey));
    assert.ok(final.sourceIds.includes(sourceId)); assert.ok(final.toolReferences.length > 0);
    assert.equal(f.chat.get(first.runId, f.context).toolReferences.length, 0);
  } finally { gate.release(); }
  safeFailure(await firstDone.catch(error => error));
  assert.equal(f.modelCalls.length, 2, 'Releasing cancelled generation cannot send or steal another run result');
});

test('B6 legacy text credentials advertise no tools and never resnapshot on replay', async t => {
  const f = await open(t, { legacy: true }); const session = f.enroll();
  // Explicit tool selection cannot silently upgrade a legacy credential.
  const before = f.counts(); assert.throws(() => f.accept(session)); assert.deepEqual(f.counts(), before);
  const key = randomUUID(); const run = f.accept(session, key, []); const final = await f.terminal(run);
  assert.equal(final.outcome, 'complete'); assert.match(final.finalText!, /Synthetic insight 731/);
  assert.equal(f.sdkCalls.length, 0); assert.equal(final.toolReferences.length, 0);
  assert.ok(f.modelCalls.every(call => !call.body.includes('functionDeclarations')));
  f.writeRecord(); const counts = f.counts(); assert.equal(f.accept(session, key, []).runId, run.runId);
  assert.deepEqual(f.counts(), counts); assert.equal(f.sdkCalls.length, 0);
});
test('B5 two live sessions keep resolved keys, result refs, and trusted source IDs invocation-local', async t => {
  const gate = barrier(); const f = await open(t, { afterResolve: gate.pause });
  const first = f.accept(f.enroll('Synthetic first'), randomUUID(), ['synthetic-lux'], [], 'Synthetic first evidence');
  const firstDone = f.terminal(first); await gate.entered;
  let secondFinal;
  try {
    // Same binding, different key bytes. The first invocation already resolved
    // key one; a second successful invocation must not overwrite its closure.
    f.writeRecord({ key: rotatedKey });
    secondFinal = await f.terminal(f.accept(f.enroll('Synthetic second'), randomUUID(), ['synthetic-lux'], [], 'Synthetic second evidence'));
    assert.equal(secondFinal.outcome, 'complete'); assert.ok(secondFinal.sourceIds.includes('lux-knowledge:732'));
    assert.ok(!secondFinal.sourceIds.includes(sourceId));
  } finally { gate.release(); }
  const firstFinal = await firstDone; assert.equal(firstFinal.outcome, 'complete');
  assert.ok(firstFinal.sourceIds.includes(sourceId)); assert.ok(!firstFinal.sourceIds.includes('lux-knowledge:732'));
  assert.notDeepEqual(firstFinal.toolReferences, secondFinal!.toolReferences);
  assert.equal(f.sdkCalls.length, 2); assert.equal(f.modelCalls.length, 4);
  const firstRequests = f.modelCalls.filter(call => call.body.includes('Synthetic first evidence'));
  const secondRequests = f.modelCalls.filter(call => call.body.includes('Synthetic second evidence'));
  assert.equal(firstRequests.length, 2); assert.equal(secondRequests.length, 2);
  assert.equal(firstRequests[0]!.key, syntheticKey); assert.ok(secondRequests.every(call => call.key === rotatedKey));
  assert.match(firstRequests[1]!.body, /731/); assert.match(secondRequests[1]!.body, /732/);
});

test('B5 sequential continuations consume a fresh result handoff for each generation', async t => {
  const f = await open(t, { multiStep: true }); const final = await f.terminal(f.accept(f.enroll()));
  assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 2);
  assert.equal(f.modelCalls.length, 3); assert.equal(forbiddenContinuation(f.modelCalls), 2);
  assert.equal(final.toolReferences.length, 2);
  assert.equal(new Set(final.toolReferences.map((ref: ToolResultRef) => JSON.stringify(ref))).size, 2);
  assert.match(f.modelCalls[2]!.body, /731/); assert.match(f.modelCalls[2]!.body, /732/);
});

test('B6 explicit requested memory remains frozen beside durable tool references', async t => {
  const gate = barrier(); const f = await open(t, { afterEachResolve: async number => { if (number === 2) await gate.pause(); } });
  const session = f.enroll();
  const note = f.accept(session, randomUUID(), [], [], 'Frozen synthetic memory: green pencil.');
  assert.equal((await f.terminal(note)).outcome, 'complete');
  const selected = f.accept(session, randomUUID(), ['synthetic-lux'], [note.userEntryId]); const done = f.terminal(selected);
  await gate.entered;
  try {
    // A real owning record changes after prompt preparation; the detached
    // requested-memory snapshot, not a late live reread, must reach the model.
    const changed = f.store.transaction(tx => {
      let changed = 0;
      for (const row of tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
        const table = `"${String(row.name).replaceAll('"', '""')}"`;
        const columns = tx.all(`PRAGMA table_info(${table})`).map(column => String(column.name));
        const id = columns.includes('entry_id') ? 'entry_id' : columns.includes('id') ? 'id' : null;
        if (id && columns.includes('text')) changed += tx.run(`UPDATE ${table} SET text = ? WHERE ${id} = ?`, ['Changed synthetic memory: red pencil.', note.userEntryId]);
      }
      return changed;
    });
    assert.equal(changed, 1, 'The fixture must really change one existing Domain entry, not empty data');
  } finally { gate.release(); }
  const final = await done;
  assert.equal(final.outcome, 'complete'); assert.equal(final.memorySelection?.frozen, true);
  assert.deepEqual(final.memorySelection?.requestedIds, [note.userEntryId]);
  assert.deepEqual(final.memorySelection?.usedIds, [note.userEntryId]);
  assert.ok(final.toolReferences.length > 0);
  assert.match(f.modelCalls.at(-1)!.body, /Frozen synthetic memory: green pencil/);
  assert.doesNotMatch(f.modelCalls.at(-1)!.body, /Changed synthetic memory: red pencil/);
});

test('B6 provisional text stays provisional when the continuation is cancelled', async t => {
  const gate = barrier(); const f = await open(t, { afterText: gate.pause }); const run = f.accept(f.enroll());
  const done = f.terminal(run);
  const provisional = (async () => {
    for await (const event of f.chat.subscribe(run.runId, f.context)) {
      if (event.type === 'text') { assert.equal(event.provisional, true); assert.match(event.text, /Provisional synthetic/); return; }
    }
    assert.fail('Real model continuation must emit nonempty provisional text');
  })();
  await gate.entered;
  try {
    await provisional; assert.equal(f.chat.get(run.runId, f.context).finalText, null);
    f.chat.cancel(run.runId, f.context);
  } finally { gate.release(); }
  const final = await done; assert.equal(final.outcome, 'cancelled'); assert.equal(final.finalText, null);
  assert.equal(f.sdkCalls.length, 1); assert.equal(f.modelCalls.length, 2);
});

test('B6 recovery does not repeat a terminal tool intent or unknown SDK effect', async t => {
  const f = await open(t, { unknownEffect: true }); const key = randomUUID(); const session = f.enroll();
  const run = f.accept(session, key); const final = await f.terminal(run);
  assert.notEqual(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
  const before = f.counts(); f.chat.recover({ assistantId: f.store.assistantId, authorityEpoch: f.store.authorityEpoch });
  assert.equal(f.accept(session, key).runId, run.runId); assert.deepEqual(f.counts(), before);
  assert.equal(f.sdkCalls.length, 1); assert.equal(forbiddenContinuation(f.modelCalls), 0);
});
