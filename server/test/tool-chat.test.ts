import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { format } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture, barrier, scope, syntheticKey, rotatedKey, answer, sourceId, type FixtureOptions } from './tool-chat-process.js';
import type { ToolCallIntent, ToolResultRef } from '../adapters/model/types.js';
import type { RunSnapshot } from '../chat/index.js';
import { listenService } from '../http/server.js';

async function open(t: TestContext, options: FixtureOptions = {}) {
  const f = await fixture(options); t.after(() => f.close()); return f;
}
function forbiddenContinuation(calls: { body: string }[]) {
  return calls.filter(call => call.body.includes('functionResponse')).length;
}
function noSQLiteKeys(f: Awaited<ReturnType<typeof fixture>>) {
  const files = readdirSync(f.dir).filter(name => /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(name));
  assert.ok(files.length > 0, 'Key-exclusion assertion must inspect an actual SQLite file, not an empty list');
  for (const name of files) for (const key of [syntheticKey, rotatedKey]) {
    assert.ok(!readFileSync(join(f.dir, name)).includes(Buffer.from(key)), `No synthetic key bytes in SQLite ${name}`);
  }
}
function safeFailure(value: unknown) {
  assert.ok(value instanceof Error || (value && typeof value === 'object' && 'outcome' in value && value.outcome !== 'complete'),
    'A refused run must not look like completed synthetic evidence');
  assert.doesNotMatch(value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value), /tool-chat-synthetic-key/);
}

// B1: Fault the owning snapshot boundary AFTER it writes, inside the real
// Store transaction. Counting every owned table catches orphan user/policy/run
// (and, once imported by root, persona) rows, not only an HTTP success code.
test('B1 snapshot failure rolls back every acceptance write', async t => {
  const f = await open(t); const session = await f.enroll(); const before = f.counts();
  const original = f.tools.snapshotRun;
  f.tools.snapshotRun = (tx, input) => { original(tx, input); throw Error('synthetic snapshot failure'); };
  assert.throws(() => f.accept(session), /synthetic snapshot failure|unavailable|persistence/);
  assert.deepEqual(f.counts(), before);
  assert.equal(f.sdkCalls.length, 0); assert.equal(f.modelCalls.length, 0);
});
test('B1 missing protected binding captures nothing; replay preserves one run and one SDK effect', async t => {
  const f = await open(t); const session = await f.enroll(); const before = f.counts();
  writeFileSync(f.recordPath, '{malformed synthetic binding', { mode: 0o600 });
  assert.throws(() => f.accept(session)); assert.deepEqual(f.counts(), before);
  f.writeRecord(); const key = randomUUID(); const accepted = f.accept(session, key);
  const terminal = await f.terminal(accepted); assert.equal(terminal.outcome, 'complete');
  const calls = f.sdkCalls.length; assert.equal(calls, 1);
  const counts = f.counts(); const replay = f.accept(session, key);
  assert.equal(replay.runId, accepted.runId); assert.deepEqual(f.counts(), counts);
  assert.equal(f.sdkCalls.length, calls);
  assert.throws(() => f.accept(session, key, []), /idempotency_conflict/);
  const journal = f.store.transaction(tx => tx.all('SELECT * FROM tool_calls WHERE owner_id = ? AND run_id = ?', [f.store.assistantId, accepted.runId]));
  assert.equal(journal.length, 1, 'Actual owner journal must contain exactly one effect for this Chat run');
  const intent = JSON.parse(String(journal[0]!.intent_json)) as ToolCallIntent;
  assert.equal(intent.runId, accepted.runId); assert.equal(journal[0]!.owner_id, f.store.assistantId);
  assert.equal(intent.actorId, f.context.clientId); assert.equal(intent.authorityEpoch, accepted.authorityEpoch);
  assert.equal(intent.executionId, journal[0]!.execution_id); assert.equal(journal[0]!.state, 'completed');
  assert.notEqual(intent.executionId, accepted.runId, 'Tool execution identity is not the Chat run UUID');
  const durable = terminal.toolReferences[0]!;
  assert.equal(durable.id, journal[0]!.result_id); assert.equal(durable.sha256, journal[0]!.result_sha256);
  assert.equal(terminal.toolReferences.length, 1, 'Replay must not invent another durable result reference');
});

test('B2 accepted definitions/hash survive a changed live catalog and policy', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const accepted = f.accept(await f.enroll()); const done = f.terminal(accepted);
  await gate.entered;
  try {
    const modelFacing = (list: ReturnType<typeof f.tools.definitions>) => list.map(({ name, description, effect, accountId, resourceId, parameters }) => ({ name, description, effect, accountId, resourceId, parameters }));
    const definitions = modelFacing(f.tools.definitions(accepted.runId));
    assert.ok(definitions.length > 0); assert.equal(typeof accepted.toolBindingHash, 'string');
    assert.match(accepted.toolBindingHash, /^[a-f0-9]{64}$/);
    f.setLiveDefinitions(); await f.port.discover(f.policy().endpoint.id);
    // Model-facing declarations only: definitions() allocates fresh execute/validate closures per
    // call, so a strict reference compare failed on identity alone. Names, descriptions, canonical
    // parameter schema and the accepted hash are still compared exactly (frozen-catalog proof).
    assert.deepEqual(modelFacing(f.tools.definitions(accepted.runId)), definitions, 'Live schema must not replace accepted declarations');
    f.updatePolicy({ generation: 2, enabled: false });
    assert.equal(f.chat.get(accepted.runId, f.context).toolBindingHash, accepted.toolBindingHash);
  } finally { gate.release(); }
  safeFailure(await done.catch(error => error));
  assert.equal(f.modelCalls.length, 0, 'revoking the accepted tool connection before resolve must block model egress'); assert.equal(f.sdkCalls.length, 0, 'revoking the accepted tool connection must block the SDK call');
});
test('B2 permitted egress advertises only accepted definitions/hash despite a differing live SDK catalog', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const accepted = f.accept(await f.enroll()); const done = f.terminal(accepted); await gate.entered;
  let declarations: { name: string; description: string; parameters: unknown }[] = [];
  try {
    declarations = f.tools.definitions(accepted.runId).map(({ name, description, parameters }) => ({ name, description, parameters }));
    assert.ok(declarations.length > 0);
    const row = f.store.transaction(tx => tx.get('SELECT snapshot_sha256 FROM tool_runs WHERE owner_id = ? AND run_id = ?', [f.store.assistantId, accepted.runId]));
    assert.equal(accepted.toolBindingHash, row?.snapshot_sha256);
    const live = await f.differentLiveCatalog(); assert.notEqual(live.schemaDigest, f.policy().schemaDigest);
    assert.ok(live.tools.every(tool => JSON.stringify(tool.inputSchema).includes('liveOnly')));
    assert.deepEqual(f.tools.definitions(accepted.runId).map(({ name, description, parameters }) => ({ name, description, parameters })), declarations);
  } finally { gate.release(); }
  const final = await done; assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
  assert.equal(f.modelCalls.length, 2); assert.equal(final.toolBindingHash, accepted.toolBindingHash);
  for (const call of f.modelCalls) {
    const body = JSON.parse(call.body) as { tools?: { functionDeclarations: unknown[] }[] };
    assert.deepEqual(body.tools?.flatMap(tool => tool.functionDeclarations), declarations);
    assert.ok(!call.body.includes('liveOnly'), 'Fresh catalog does not substitute the accepted function schema');
  }
});

for (const kind of ['connection', 'schema', 'source', 'wrong-class', 'unmapped-class'] as const) {
  test(`B2/B4 later-step ${kind} denial prevents all result continuation egress`, async t => {
    const gate = barrier(); const f = await open(t, { beforeContinuation: gate.pause });
    const accepted = f.accept(await f.enroll()); const done = f.terminal(accepted);
    await gate.entered;
    try {
      assert.equal(f.sdkCalls.length, 1, 'Denied continuation must start with a real completed SDK result');
      assert.equal(f.modelCalls.length, 1, 'Only the permitted first model request has left');
      if (kind === 'connection') f.updatePolicy({ generation: 2, enabled: false });
      if (kind === 'schema') f.updatePolicy({ generation: 2, schemaDigest: '0'.repeat(64) });
      if (kind === 'source') f.updatePolicy({ generation: 2, sourcePolicy: { ...f.policy().sourcePolicy, revision: 2, allowedClasses: [] } });
      if (kind === 'wrong-class') f.updatePolicy({ generation: 2, sourcePolicy: { ...f.policy().sourcePolicy, revision: 2, unknownClass: 'sensitive', allowedClasses: ['sensitive'] } });
      if (kind === 'unmapped-class') f.updatePolicy({ generation: 2, sourcePolicy: { ...f.policy().sourcePolicy, revision: 2, unknownClass: null } });
    } finally { gate.release(); }
    safeFailure(await done.catch(error => error));
    assert.equal(forbiddenContinuation(f.modelCalls), 0, 'Owner gate must be called again at lower egress, not only before credentials resolve');
    assert.equal(f.sdkCalls.length, 1, 'A denied result is never re-executed');
  });
}

test('B3 real SDK evidence reaches a model continuation and durable references', async t => {
  const f = await open(t); const accepted = f.accept(await f.enroll()); const final = await f.terminal(accepted);
  assert.equal(final.outcome, 'complete'); assert.match(final.finalText!, /Synthetic insight 731/);
  assert.equal(f.sdkCalls.length, 1); assert.equal(f.modelCalls.length, 2);
  assert.equal(forbiddenContinuation(f.modelCalls), 1);
  assert.match(f.modelCalls[1]!.body, /Synthetic nonempty evidence/);
  assert.ok(final.toolReferences.length > 0, 'Nonempty durable tool references, never transient MCP buffers');
  assert.ok(final.sourceIds.includes(sourceId), 'Source provenance is the validated connection, never a model-supplied URL or provider id');
  assert.deepEqual(f.chat.get(final.runId, f.context).toolReferences, final.toolReferences);
  assert.ok(answer.length > 0);
});

const mutations = ['consent-revoke', 'consent-revision', 'epoch', 'run', 'selected-label', 'exact-route',
  'credential-account', 'credential-scope', 'credential-generation', 'credential-delete', 'credential-malformed', 'abort', 'deadline'] as const;
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Mutation = typeof mutations[number];
function mutate(f: Fixture, accepted: RunSnapshot, session: string, mutation: Mutation) {
  if (mutation === 'consent-revoke') f.chat.revoke(session, f.context);
  if (mutation === 'consent-revision') f.store.transaction(tx => tx.run('UPDATE chat_consents SET revision = revision + 1 WHERE session_id = ?', [session]));
  if (mutation === 'epoch') f.store.transaction(tx => tx.run('UPDATE chat_runs SET authority_epoch = ? WHERE run_id = ?', ['synthetic-obsolete-epoch', accepted.runId]));
  if (mutation === 'run') f.store.transaction(tx => tx.run('UPDATE chat_runs SET owner_assistant_id = ? WHERE run_id = ?', ['synthetic-other-owner', accepted.runId]));
  if (mutation === 'selected-label') assert.equal(f.correctLabel(accepted).dataClass, 'sensitive');
  if (mutation === 'exact-route') writeFileSync(join(f.configDir, 'profile.json'), JSON.stringify({ ...f.profile, modelId: 'gemini-other-synthetic' }), { mode: 0o600 });
  if (mutation === 'credential-account') f.writeRecord({ configuredAccount: 'operator-asserted-other-synthetic-account' });
  if (mutation === 'credential-scope') f.writeRecord({ routeScope: { ...scope, allowedClasses: ['ordinary'] } });
  if (mutation === 'credential-generation') f.writeRecord({ bindingGeneration: 'synthetic-generation-2' });
  if (mutation === 'credential-delete') rmSync(f.recordPath);
  if (mutation === 'credential-malformed') writeFileSync(f.recordPath, '{synthetic-malformed', { mode: 0o600 });
  if (mutation === 'abort') f.chat.cancel(accepted.runId, f.context);
  if (mutation === 'deadline') f.advance(5000);
}
// BOTH barrier positions are necessary. afterResolve changes the current
// protected locator after key+receipt were parsed: receipt-only guards fail.
for (const position of ['beforeResolve', 'afterResolve'] as const) for (const mutation of mutations) {
  test(`B4 ${position}: ${mutation} produces zero lower transport calls`, async t => {
    const gate = barrier(); const f = await open(t, { [position]: gate.pause });
    const session = await f.enroll(); const accepted = f.accept(session); const done = f.terminal(accepted);
    await gate.entered;
    try {
      assert.equal(f.modelCalls.length, 0, 'Barrier must be above the actual injected lower transport');
      if (position === 'afterResolve') assert.equal(f.receipt().bindingGeneration, 'synthetic-generation-1', 'Valid receipt exists before the mutation');
      mutate(f, accepted, session, mutation);
    } finally { gate.release(); }
    safeFailure(await done.catch(error => error));
    assert.equal(f.modelCalls.length, 0, 'Forbidden actual lower fetch count must be zero, including injected transports');
    assert.equal(f.sdkCalls.length, 0);
  });
}

for (const interval of ['continuation-resolved', 'final-owner-return'] as const) for (const mutation of mutations) {
  test(`B4 nonempty result ${interval}: ${mutation} denies continuation`, async t => {
    const gate = barrier(); const f = await open(t, interval === 'continuation-resolved' ? { beforeContinuation: gate.pause } : {});
    const gateCount = interval === 'final-owner-return' ? f.gateBarrier(gate.pause) : null;
    const session = await f.enroll(); const accepted = f.accept(session); const done = f.terminal(accepted);
    await gate.entered;
    try {
      assert.equal(f.sdkCalls.length, 1); assert.equal(f.modelCalls.length, 1);
      const result = f.store.transaction(tx => tx.get('SELECT state, result_json, result_id FROM tool_calls WHERE owner_id = ? AND run_id = ?', [f.store.assistantId, accepted.runId]));
      assert.equal(result?.state, 'completed'); assert.ok(result?.result_id);
      assert.match(String(result?.result_json), /Synthetic nonempty evidence/, 'A real nonempty completed SDK result precedes the revoked continuation');
      if (gateCount) assert.equal(gateCount(), 2, 'Pause AFTER the second successful owner authorization, BEFORE final synchronous guards/lower fetch');
      mutate(f, accepted, session, mutation);
    } finally { gate.release(); }
    safeFailure(await done.catch(error => error));
    assert.equal(forbiddenContinuation(f.modelCalls), 0); assert.equal(f.modelCalls.length, 1);
    assert.equal(f.sdkCalls.length, 1, 'Refused continuation never repeats the effect');
  });
}

test('B5 same-binding rotation sends the new key only to the lower trusted transport', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const accepted = f.accept(await f.enroll()); const done = f.terminal(accepted); await gate.entered;
  try { f.writeRecord({ key: rotatedKey }); } finally { gate.release(); }
  const final = await done; assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
  assert.ok(f.modelCalls.length >= 2); assert.ok(f.modelCalls.every(call => call.key === rotatedKey));
  const publicState = JSON.stringify({ final, bodies: f.modelCalls.map(call => call.body), sdk: f.sdkCalls, counts: f.counts() });
  for (const key of [syntheticKey, rotatedKey]) {
    assert.ok(!publicState.includes(key));
  }
  noSQLiteKeys(f);
});
for (const failure of ['credential', 'transport'] as const) {
  test(`B5 bounded ${failure} failure/status/event/log sinks never contain resolved synthetic keys`, async t => {
    const logs: string[] = []; let logBytes = 0;
    for (const sink of ['error', 'warn', 'log'] as const) t.mock.method(console, sink, (...parts: unknown[]) => {
      const line = format(...parts); logBytes += Buffer.byteLength(line);
      assert.ok(logBytes <= 65536, 'Bounded synthetic log capture exceeded'); logs.push(line);
    });
    const f = await open(t, failure === 'credential' ? { credentialFailure: true } : { transportFailure: true });
    const run = f.accept(await f.enroll()); const final = await f.terminal(run);
    assert.equal(final.state, 'terminal'); assert.notEqual(final.outcome, 'complete');
    assert.ok(f.resolutions() > 0, 'Synthetic failing credential branch was actually exercised');
    assert.equal(f.modelCalls.length, failure === 'transport' ? 1 : 0); assert.equal(f.sdkCalls.length, 0);
    assert.ok(f.events.length > 0, 'Failure event sink has actual nonempty lifecycle evidence');
    const service = await listenService({ store: f.store, domain: f.domain, chat: f.chat, modelStatus: f.status, port: 0 });
    let status = '';
    try {
      const response = await fetch(`${service.origin}/api/v1/status`, { headers: { Authorization: `Bearer ${f.store.adminCredential}` } });
      assert.equal(response.status, 200); status = await response.text();
      assert.ok(status.length > 0); assert.ok(status.includes(scope.modelId), 'Inspect the actual configured Host HTTP status');
    } finally { await service.close(); }
    noSQLiteKeys(f);
    const publicState = { final, events: f.events, status, bodies: f.modelCalls.map(call => call.body) };
    await f.close(); // Include cleanup logging before checking the complete sinks.
    const serialized = JSON.stringify(publicState);
    for (const key of [syntheticKey, rotatedKey]) {
      assert.ok(!serialized.includes(key), 'Key bytes absent from failure/status/event/model-body sinks');
      assert.ok(logs.every(line => !line.includes(key)), 'Key bytes absent from actual console log/error/warn sinks');
    }
    assert.ok(Buffer.byteLength(serialized) <= 65536, 'Bounded synthetic public sink capture exceeded');
  });
}
test('B5 simultaneous sessions cannot consume another invocation receipt/result handoff', async t => {
  const gate = barrier(); const f = await open(t, { beforeResolve: gate.pause });
  const first = f.accept(await f.enroll('Synthetic first')); const firstDone = f.terminal(first); await gate.entered;
  try {
    f.chat.cancel(first.runId, f.context);
    f.writeRecord({ key: rotatedKey, configuredAccount: 'operator-asserted-synthetic-second' });
    const second = f.accept(await f.enroll('Synthetic second')); const final = await f.terminal(second);
    assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
    assert.equal(f.modelCalls.length, 2); assert.ok(f.modelCalls.every(call => call.key === rotatedKey));
    assert.ok(final.sourceIds.includes(sourceId)); assert.ok(final.toolReferences.length > 0);
    assert.equal(f.chat.get(first.runId, f.context).toolReferences.length, 0);
  } finally { gate.release(); }
  safeFailure(await firstDone.catch(error => error));
  assert.equal(f.modelCalls.length, 2, 'Releasing cancelled generation cannot send or steal another run result');
});

test('B6 legacy text credentials advertise no tools and never resnapshot on replay', async t => {
  const f = await open(t, { legacy: true }); const session = await f.enroll();
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
  const first = f.accept(await f.enroll('Synthetic first'), randomUUID(), ['synthetic-lux'], [], 'Synthetic first evidence');
  const firstDone = f.terminal(first); await gate.entered;
  let secondFinal;
  try {
    // Same binding, different key bytes. The first invocation already resolved
    // key one; a second successful invocation must not overwrite its closure.
    f.writeRecord({ key: rotatedKey });
    secondFinal = await f.terminal(f.accept(await f.enroll('Synthetic second'), randomUUID(), ['synthetic-lux'], [], 'Synthetic second evidence'));
    assert.equal(secondFinal.outcome, 'complete'); assert.ok(secondFinal.sourceIds.includes(sourceId));
    assert.ok(secondFinal.toolReferences.length > 0);
  } finally { gate.release(); }
  const firstFinal = await firstDone; assert.equal(firstFinal.outcome, 'complete');
  assert.ok(firstFinal.sourceIds.includes(sourceId)); assert.notDeepEqual(firstFinal.toolReferences, secondFinal!.toolReferences);
  assert.notDeepEqual(firstFinal.toolReferences, secondFinal!.toolReferences);
  assert.equal(f.sdkCalls.length, 2); assert.equal(f.modelCalls.length, 4);
  const firstRequests = f.modelCalls.filter(call => call.body.includes('Synthetic first evidence'));
  const secondRequests = f.modelCalls.filter(call => call.body.includes('Synthetic second evidence'));
  assert.equal(firstRequests.length, 2); assert.equal(secondRequests.length, 2);
  assert.equal(firstRequests[0]!.key, syntheticKey); assert.ok(secondRequests.every(call => call.key === rotatedKey));
  assert.match(firstRequests[1]!.body, /731/); assert.match(secondRequests[1]!.body, /732/);
});

test('B5 sequential continuations consume a fresh result handoff for each generation', async t => {
  const f = await open(t, { multiStep: true }); const final = await f.terminal(f.accept(await f.enroll()));
  assert.equal(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 2);
  assert.equal(f.modelCalls.length, 3); assert.equal(forbiddenContinuation(f.modelCalls), 2);
  assert.equal(final.toolReferences.length, 2);
  assert.equal(new Set(final.toolReferences.map((ref: ToolResultRef) => JSON.stringify(ref))).size, 2);
  assert.match(f.modelCalls[2]!.body, /731/); assert.match(f.modelCalls[2]!.body, /732/);
});

test('B6 explicit requested memory remains frozen beside durable tool references', async t => {
  const gate = barrier(); const f = await open(t, { afterEachResolve: async number => { if (number === 2) await gate.pause(); } });
  const session = await f.enroll();
  const note = f.accept(session, randomUUID(), [], [], 'Frozen synthetic memory: green pencil.');
  assert.equal((await f.terminal(note)).outcome, 'complete');
  const selected = f.accept(session, randomUUID(), ['synthetic-lux'], [note.userEntryId]); const done = f.terminal(selected);
  await gate.entered;
  try {
    // A real owning record changes after prompt preparation; the detached
    // requested-memory snapshot, not a late live reread, must reach the model.
    // The Store's transaction authorizer denies PRAGMA by design, so the schema is
    // probed through a raw read-only connection while the run is mid-flight.
    const raw = new DatabaseSync(join(f.dir, 'state.sqlite'), { readOnly: true });
    let owned: { table: string; columns: string[] }[];
    try {
      owned = raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => {
        const table = `"${String(row.name).replaceAll('"', '""')}"`;
        return { table, columns: raw.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name)) };
      });
    } finally { raw.close(); }
    const changed = f.store.transaction(tx => {
      let changed = 0;
      for (const { table, columns } of owned) {
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
  const gate = barrier(); const f = await open(t, { afterText: gate.pause }); const run = f.accept(await f.enroll());
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

function childMessage(child: ChildProcess, phase: string, diagnostics: string[] = []): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const tail = () => diagnostics.length ? ` :: child stderr: ${diagnostics.join('').slice(-800)}` : '';
    const timer = setTimeout(() => finish(Error(`Synthetic recovery ${phase} timeout${tail()}`)), 5000);
    const receive = (value: Record<string, unknown>) => { if (value.phase === phase) finish(null, value); };
    const exited = () => finish(Error(`Synthetic recovery child exited before ${phase}${tail()}`));
    function finish(error: Error | null, value?: Record<string, unknown>) {
      clearTimeout(timer); child.off('message', receive); child.off('exit', exited);
      if (error) reject(error); else resolve(value!);
    }
    child.on('message', receive); child.on('exit', exited);
  });
}
async function terminateChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); let timer: ReturnType<typeof setTimeout> | undefined;
  child.kill('SIGTERM');
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic recovery child exit timeout')), 2000); })]); }
  finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = once(child, 'exit'); child.kill('SIGKILL');
      try { await Promise.race([forcedExit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic forced child exit timeout')), 2000); })]); }
      finally { clearTimeout(timer); }
    }
  }
}

test('B6 process restart recovers a real durable nonterminal SDK-dispatched intent as unknown without repeating its effect', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-tool-chat-recovery-'));
  const childErrors: string[] = [];
  const child = fork(join(import.meta.dirname, 'tool-chat-process.js'), ['recovery'], {
    env: { ...process.env, DIDI_TOOL_CHAT_RECOVERY_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  // Bounded synthetic diagnostic: the recovery child's stderr is retained so a readiness
  // stall names its own phase instead of failing opaquely (never a deadline change).
  child.stderr?.on('data', chunk => { childErrors.push(String(chunk)); while (childErrors.join('').length > 4000) childErrors.shift(); });
  let reopened: Fixture | undefined;
  t.after(async () => { try { await reopened?.close(); } finally { try { await terminateChild(child); } finally { rmSync(dir, { recursive: true, force: true }); } } });
  const ready = await childMessage(child, 'ready', childErrors); const dispatchedPromise = childMessage(child, 'dispatched', childErrors); child.send('start');
  const dispatched = await dispatchedPromise;
  const interrupted = dispatched.run as RunSnapshot; const journal = dispatched.journal as { execution_id: string; run_id: string; owner_id: string; state: string }[];
  assert.equal(interrupted.state, 'dispatch_intent'); assert.equal(interrupted.outcome, null);
  assert.equal(dispatched.effects, 1); assert.equal(journal.length, 1); assert.equal(journal[0]!.state, 'intent');
  assert.equal(journal[0]!.run_id, interrupted.runId);
  await terminateChild(child); // Only this test's child process; no graceful completion.
  reopened = await fixture({ dir, preserve: true });
  const recovered = reopened.chat.get(interrupted.runId, reopened.context);
  assert.equal(recovered.state, 'terminal'); assert.equal(recovered.outcome, 'outcome_unknown');
  const receipt = reopened.store.transaction(tx => tx.get('SELECT * FROM tool_calls WHERE owner_id = ? AND run_id = ? AND execution_id = ?',
    [reopened!.store.assistantId, interrupted.runId, journal[0]!.execution_id]));
  assert.equal(receipt?.state, 'unknown'); assert.match(String(receipt?.result_json), /recovered_intent/);
  assert.ok(receipt?.result_id); assert.ok(receipt?.result_sha256);
  const counts = reopened.counts();
  const replay = reopened.accept(String(ready.sessionId), String(ready.key));
  assert.equal(replay.runId, interrupted.runId); assert.equal(replay.outcome, 'outcome_unknown');
  assert.equal((await reopened.terminal(replay)).outcome, 'outcome_unknown');
  reopened.chat.recover({ assistantId: reopened.store.assistantId, authorityEpoch: reopened.store.authorityEpoch });
  // A real authenticated HTTP roundtrip settles the reopened host/event loop;
  // do not assert zero immediately before an accidental queued replay can run.
  const service = await listenService({ store: reopened.store, domain: reopened.domain, chat: reopened.chat, modelStatus: reopened.status, port: 0 });
  try {
    const status = await fetch(`${service.origin}/api/v1/status`, { headers: { Authorization: `Bearer ${reopened.store.adminCredential}` } });
    assert.equal(status.status, 200); assert.ok((await status.arrayBuffer()).byteLength > 0);
  } finally { await service.close(); }
  assert.deepEqual(reopened.counts(), counts); assert.equal(reopened.sdkCalls.length, 0); assert.equal(reopened.modelCalls.length, 0);
  assert.deepEqual(reopened.store.transaction(tx => tx.get('SELECT * FROM tool_calls WHERE owner_id = ? AND run_id = ? AND execution_id = ?',
    [reopened!.store.assistantId, interrupted.runId, journal[0]!.execution_id])), receipt);
});

test('B6 recovery does not repeat a terminal tool intent or unknown SDK effect', async t => {
  const f = await open(t, { unknownEffect: true }); const key = randomUUID(); const session = await f.enroll();
  const run = f.accept(session, key); const final = await f.terminal(run);
  assert.notEqual(final.outcome, 'complete'); assert.equal(f.sdkCalls.length, 1);
  const before = f.counts(); f.chat.recover({ assistantId: f.store.assistantId, authorityEpoch: f.store.authorityEpoch });
  assert.equal(f.accept(session, key).runId, run.runId); assert.deepEqual(f.counts(), before);
  assert.equal(f.sdkCalls.length, 1); assert.equal(forbiddenContinuation(f.modelCalls), 0);
});

test('DIAG browser enrollment and selected tool accept reaches a real terminal result', async t => {
  const f = await open(t);
  const decisions: { state: string; reason: string | null; bindings: number; classes: readonly string[] }[] = [];
  const authorize = f.tools.resultGate.authorize.bind(f.tools.resultGate);
  f.tools.resultGate.authorize = async (...args) => {
    const decision = await authorize(...args);
    decisions.push({ state: decision.state, reason: decision.state === 'allowed' ? null : decision.reason,
      bindings: args[1].length, classes: [...args[2]] });
    return decision;
  };
  const authorityFailures: string[] = [];
  const authority = f.chat.authority.bind(f.chat);
  f.chat.authority = (...args) => {
    try { return authority(...args); }
    catch (error) { authorityFailures.push(error instanceof Error ? error.message : 'unknown'); throw error; }
  };
  const service = await listenService({ store: f.store, domain: f.domain, chat: f.chat, modelStatus: f.status,
    ...(f.connections ? { connections: f.connections } : {}), port: 0 });
  t.after(() => service.close());
  // Same existing browser pairing protocol: token is only the HttpOnly session cookie.
  const pairing = await fetch(`${service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: {
    Authorization: `Bearer ${f.store.adminCredential}`, Origin: service.origin, 'Content-Type': 'application/json'
  }, body: '{}' });
  assert.equal(pairing.status, 200);
  const pairingBody = await pairing.json() as { data: { pairingCode: string } };
  const paired = await fetch(`${service.origin}/api/v1/auth/pair`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: service.origin
  }, body: JSON.stringify({ pairingCode: pairingBody.data.pairingCode }) });
  assert.equal(paired.status, 200);
  const pairedBody = await paired.json() as { data: { csrfToken: string }; authorityEpoch: string };
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
  assert.ok(cookie.startsWith('didi_session='));
  const headers = { 'Content-Type': 'application/json', Cookie: cookie, Origin: service.origin,
    'X-Didi-CSRF': pairedBody.data.csrfToken, 'X-Didi-Authority-Epoch': String(pairedBody.authorityEpoch) };
  const enrolled = await fetch(`${service.origin}/api/v1/conversations`, { method: 'POST', headers: {
    ...headers, 'Idempotency-Key': randomUUID()
  }, body: JSON.stringify({ title: 'Naya connected conversation', timeZone: 'UTC' }) });
  assert.equal(enrolled.status, 200);
  const { data: { sessionId: browserEnrolledSessionId } } = await enrolled.json() as { data: { sessionId: string } };
  await f.approveSession(browserEnrolledSessionId);
  // The current hardware browser fixture resumes this locally pre-enrolled conversation.
  const sessionId = await f.enroll();
  const key = randomUUID();
  const body = JSON.stringify({ sessionId, text: 'Use synthetic insight 731.', selectedConnectionIds: ['synthetic-lux'] });
  const accept = (idempotencyKey = key) => fetch(`${service.origin}/api/v1/chat`, { method: 'POST', headers: {
    ...headers, 'Idempotency-Key': idempotencyKey
  }, body });
  const accepted = await accept(); assert.equal(accepted.status, 200);
  const { data: run } = await accepted.json() as { data: RunSnapshot };
  assert.ok(run.toolBindingHash, 'HTTP selection freezes a real owner binding');
  // Observe the real Chat subscription through authenticated HTTP, not an accepted snapshot.
  const terminal = async (run: RunSnapshot) => {
    const stream = await fetch(`${service.origin}/api/v1/chat/${run.runId}/events`, { method: 'POST', headers, body: '{}' });
    assert.equal(stream.status, 200); assert.ok(stream.body);
    const reader = stream.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let final: RunSnapshot | null = null;
    try {
      while (!final) {
        const chunk = await reader.read(); assert.equal(chunk.done, false, 'Run stream must reach terminal');
        pending += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = packet.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as { type: string; run?: RunSnapshot };
          if (event.type === 'snapshot' && event.run?.state === 'terminal') final = event.run;
        }
      }
    } finally { await reader.cancel(); }
    return final;
  };
  const final = await terminal(run);
  const replay = await accept(); assert.equal(replay.status, 200);
  const { data: replayed } = await replay.json() as { data: RunSnapshot };
  assert.equal(replayed.runId, run.runId); assert.equal(replayed.outcome, final.outcome);
  console.log('DIAG_TERMINAL ' + JSON.stringify({ outcome: final.outcome, authorityFailures, decisions,
    modelRequests: f.modelCalls.length, sdkCalls: f.sdkCalls.length, acceptedActor: f.tools.acceptedRun(run.runId)?.acceptance.actorId,
    bindingPreserved: replayed.toolBindingHash === run.toolBindingHash, sourceIds: final.sourceIds, toolReferences: final.toolReferences.length }));
  assert.equal(final.outcome, 'complete', 'Browser-equivalent run must complete, not merely accept');
  assert.ok(f.modelCalls.length >= 2); assert.ok(f.sdkCalls.length > 0);
  assert.ok(final.sourceIds.includes(sourceId)); assert.ok(final.toolReferences.length > 0);
  // The browser acceptance test sends another selected message after the panel's first run.
  // Reproduce that same-conversation history, not only a fresh single-turn fixture.
  const next = await accept(randomUUID()); assert.equal(next.status, 200);
  const { data: nextRun } = await next.json() as { data: RunSnapshot };
  const nextFinal = await terminal(nextRun);
  console.log('DIAG_SECOND_TERMINAL ' + JSON.stringify({ outcome: nextFinal.outcome, authorityFailures, decisions,
    modelRequests: f.modelCalls.length, sdkCalls: f.sdkCalls.length, sourceIds: nextFinal.sourceIds, toolReferences: nextFinal.toolReferences.length }));
  assert.equal(nextFinal.outcome, 'complete', 'The browser second selected turn must also complete');
  assert.ok(nextFinal.sourceIds.includes(sourceId)); assert.ok(nextFinal.toolReferences.length > 0);
});
