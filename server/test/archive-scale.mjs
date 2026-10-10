// Observational contract: growing owner work is data, not a failing performance test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const measurementContract = Object.freeze({
  schemaVersion: 1,
  historicalEntrySizes: [0, 20, 100, 500],
  samplesPerSurface: 1,
  surfaces: ['getSession', 'acceptedSend', 'contextAssembly', 'completedSnapshot'],
  sqlCoverage: 'Domain-port methods only; returned rows, not scanned rows or whole-Store totals',
  desiredTarget: 'snapshot independent of unrelated history; budget-bounded context materialization with classification/provenance preserved',
});
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const historicalText = 'Synthetic archive turn with fixed modest text for owner-cost observation.';
const currentText = 'Synthetic current turn.';
const finalText = 'Synthetic final answer.';

// Only Domain methods receive a forwarding transaction. Chat/runtime SQL is NOT
// counted. Every method executes once with unchanged arguments and return value.
function observeDomain(owner) {
  let active = null;
  const port = new Proxy(owner, { get(target, name) {
    const value = Reflect.get(target, name);
    if (typeof value !== 'function') return value;
    return (tx, ...args) => {
      if (!active) return value.call(target, tx, ...args);
      const meter = active;
      meter.portCalls[name] = (meter.portCalls[name] ?? 0) + 1;
      if (name === 'execute') meter.operations[args[0]] = (meter.operations[args[0]] ?? 0) + 1;
      const forwarded = Object.fromEntries(['get', 'all', 'run'].map(method => [method, (sql, ...params) => {
        const result = tx[method](sql, ...params);
        const key = JSON.stringify([name, method, sql]);
        const row = meter.groups.get(key) ?? { domainMethod: name, method, sql, calls: 0, returnedRows: 0, affectedRows: 0 };
        row.calls++;
        if (method === 'run') row.affectedRows += result;
        else row.returnedRows += method === 'all' ? result.length : Number(result !== undefined);
        meter.groups.set(key, row);
        return result;
      }]));
      return value.call(target, forwarded, ...args);
    };
  } });
  return { port,
    classification(subject, label) { if (active) active.classifications.push({ ...subject, label }); },
    measure(surface, denominator, body) {
      assert.equal(active, null);
      active = { portCalls: {}, operations: {}, groups: new Map(), classifications: [] };
      const meter = active;
      const start = performance.now();
      let value;
      try { value = body(); } finally { active = null; }
      const elapsedMs = performance.now() - start;
      const sql = [...meter.groups.values()];
      return { value, measurement: { surface, denominator, elapsedMs, responseBytes: bytes(value),
        domainPortCalls: meter.portCalls, domainOperations: meter.operations,
        domainSqlCalls: sql.reduce((n, r) => n + r.calls, 0),
        domainReturnedRows: sql.reduce((n, r) => n + r.returnedRows, 0),
        domainAffectedRows: sql.reduce((n, r) => n + r.affectedRows, 0), sql,
        classifications: meter.classifications } };
    },
  };
}

function queryPlans(dir, sessionId, entryId) {
  const db = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
  try {
    const required = { entries: ['session_id', 'sequence'], source_references: ['owner_id', 'id'], sessions: ['started_at'] };
    const schema = Object.fromEntries(Object.keys(required).map(table => [table, db.prepare(`PRAGMA table_info(${table})`).all()]));
    for (const [table, columns] of Object.entries(required)) {
      for (const column of columns) assert.ok(schema[table].some(row => row.name === column), `${table}.${column}`);
    }
    const queries = [
      ['entriesBySession', 'SELECT * FROM entries WHERE session_id = ? ORDER BY sequence ASC', [sessionId]],
      ['sourceReferencesByOwner', 'SELECT * FROM source_references WHERE owner_id = ? ORDER BY id ASC', [entryId]],
      ['sessionsByStartedAt', 'SELECT * FROM sessions ORDER BY started_at DESC', []],
    ];
    const plans = queries.map(([shape, sql, params]) => {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      assert.ok(rows.length > 0, `${shape} plan absent`);
      return { shape, sql, params, rows, search: rows.some(r => /\bSEARCH\b/.test(r.detail)),
        scan: rows.some(r => /\bSCAN\b/.test(r.detail)), tempSort: rows.some(r => /USE TEMP B-TREE/.test(r.detail)) };
    });
    return { schema, sessionCount: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, plans };
  } finally { db.close(); }
}

async function sample(modules, size) {
  const { Store, Outbox, createDomainPort, ChatService, chatMigrations, assemble, validatePreferences, compilePrompt } = modules;
  const dir = mkdtempSync(join(tmpdir(), 'archive-scale-store-'));
  let store;
  try {
    const owner = createDomainPort({ outbox: Outbox });
    const observed = observeDomain(owner);
    const domain = observed.port;
    store = new Store(dir, [...domain.migrations, ...chatMigrations]);
    const context = { assistantId: store.assistantId, clientId: 'synthetic-archive-observer', authorityEpoch: store.authorityEpoch, now: new Date(0).toISOString() };
    const calls = [], work = [];
    const config = { store, domain,
      model: { generate: async request => {
        calls.push(request);
        return { status: 'complete', text: finalText, providerContent: { role: 'model', parts: [{ text: finalText }] },
          reason: 'synthetic', prompt: { version: request.promptVersion, hash: 'synthetic', omittedContextIds: [] },
          timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
      } },
      route: { provider: 'synthetic', model: 'archive-observer', available: true,
        allows: classes => classes.every(c => ['ordinary', 'private'].includes(c)),
        endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'synthetic-unused', allowedClasses: ['ordinary', 'private'] },
      preferences: validatePreferences({ schemaVersion: 1, ownerId: store.assistantId, dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'balanced' }, store.assistantId),
      classify: (subject, tx) => {
        const label = domain.getRoutingLabel(tx, { kind: subject.kind, id: subject.id });
        observed.classification(subject, label);
        if (label.dataClass === 'unknown') return null;
        return { ownerId: store.assistantId, dataClass: label.dataClass, revision: label.revision };
      },
      context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 2000 }, sources: [] },
      now: () => 0, schedule: task => work.push(task),
    };
    const chat = new ChatService(config);
    chat.recover({ assistantId: store.assistantId, authorityEpoch: store.authorityEpoch });
    const sessionId = chat.enroll({ title: 'Synthetic archive', timeZone: 'UTC', idempotencyKey: 'synthetic-enrollment' }, context).sessionId;
    const seeded = [];
    const seedStart = performance.now();
    for (let i = 0; i < size; i++) {
      const sourceRef = { id: `synthetic-ref-${i}`, label: 'Synthetic archive source', provider: 'synthetic',
        externalId: `synthetic-source-${i}`, sourceTimestamp: new Date(0).toISOString(), availability: 'present', note: 'synthetic only' };
      const entry = store.transaction(tx => domain.execute(tx, 'appendEntry', { sessionId, text: historicalText,
        role: i % 2 ? 'assistant' : 'user', timeZone: 'UTC', sourceRef }, context, { writer: 'capture', dataClass: 'private' }));
      assert.deepEqual(entry.sourceRefs, [sourceRef]);
      seeded.push(entry);
    }
    const seedElapsedMs = performance.now() - seedStart;
    const plans = queryPlans(dir, sessionId, seeded[0]?.id ?? 'synthetic-missing-owner');
    assert.equal(plans.sessionCount, 1);
    const read = () => store.transaction(tx => domain.execute(tx, 'getSession', { id: sessionId }, context));
    const initial = observed.measure('getSession', { historicalEntries: size, entriesAtCall: size, emptyBoundary: size === 0 }, read);
    assert.deepEqual(initial.value.entries, seeded);
    assert.equal(initial.value.nextCursor, null);

    const accepted = observed.measure('acceptedSend', { historicalEntries: size, entriesBefore: size, entriesAfter: size + 1 },
      () => chat.accept({ sessionId, text: currentText, idempotencyKey: 'synthetic-send' }, context));
    assert.equal(accepted.value.state, 'accepted');
    assert.equal(calls.length, 0);
    assert.equal(work.length, 1);
    const before = read().entries;
    assert.deepEqual(before.slice(0, size), seeded);
    assert.equal(before.at(-1).id, accepted.value.userEntryId);
    assert.equal(before.at(-1).text, currentText);
    const assembled = observed.measure('contextAssembly', { historicalEntries: size, entriesAtCall: size + 1 },
      () => assemble(config, sessionId, accepted.value.userEntryId, context));
    const trace = assembled.value.trace;
    const allIds = before.map(e => e.id);
    const selectedIds = trace.selectedHistoryIds;
    const omittedIds = allIds.slice(0, trace.omittedHistoryCount);
    assert.ok(selectedIds.length > 0);
    assert.deepEqual(selectedIds, allIds.slice(trace.omittedHistoryCount));
    assert.equal(before[trace.omittedHistoryCount].role, 'user');
    assert.equal(selectedIds.at(-1), accepted.value.userEntryId);
    assert.equal(selectedIds.length + omittedIds.length, size + 1);
    assert.deepEqual(trace.compileInput.history.map(e => ({ id: e.id, role: e.role, text: e.text })),
      before.slice(trace.omittedHistoryCount).map(e => ({ id: e.id, role: e.role === 'assistant' ? 'model' : 'user', text: e.text })));
    const { manifest, ...compiledRequest } = compilePrompt(trace.compileInput);
    assert.deepEqual(manifest, trace.manifest);
    assert.deepEqual(compiledRequest, assembled.value.request);
    assert.deepEqual(assembled.value.request.contents.map(turn => JSON.parse(turn.parts[0].text).id), selectedIds);
    assert.equal(JSON.parse(assembled.value.request.contents.at(-1).parts[0].text).text, currentText);
    const classifications = assembled.measurement.classifications.filter(c => c.kind === 'entry');
    assert.deepEqual(classifications.map(c => c.id), allIds);
    for (const [i, subject] of classifications.entries()) {
      assert.deepEqual(subject.sourceRefs, before[i].sourceRefs);
      assert.equal(subject.label.dataClass, 'private');
    }
    // Verify maximal whole-turn suffix under the actual compiler, not a text estimate.
    if (omittedIds.length) {
      const start = trace.omittedHistoryCount - 2;
      assert.ok(start >= 0);
      assert.throws(() => compilePrompt({ ...trace.compileInput,
        history: before.slice(start).map(e => ({ schemaVersion: 1, ownerId: store.assistantId, dataClass: 'private',
          id: e.id, role: e.role === 'assistant' ? 'model' : 'user', text: e.text })) }),
      error => ['budget', 'schema'].includes(error.code));
    }
    // Durable completion is deliberately outside the completed-get sample.
    const events = chat.subscribe(accepted.value.runId, context);
    work.shift()();
    let terminal;
    for await (const event of events) {
      if (event.type === 'snapshot' && event.run.state === 'terminal') { terminal = event.run; break; }
      assert.notEqual(event.type, 'resync_required');
    }
    assert.equal(terminal?.outcome, 'complete');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], assembled.value.request);
    const completed = observed.measure('completedSnapshot', { historicalEntries: size, entriesAtCall: size + 2 },
      () => chat.get(accepted.value.runId, context));
    assert.deepEqual(completed.value, terminal);
    const finalEntries = read().entries;
    assert.equal(finalEntries.length, size + 2);
    assert.deepEqual(finalEntries.slice(0, size), seeded);
    const finalEntry = finalEntries.at(-1);
    assert.equal(completed.value.finalEntryId, finalEntry.id);
    assert.equal(completed.value.finalText, finalEntry.text);
    assert.equal(finalEntry.text, finalText);
    assert.equal(finalEntry.role, 'assistant');
    for (const measurement of [initial, accepted, assembled, completed]) {
      assert.ok(measurement.measurement.domainSqlCalls > 0, 'required SQL measurements missing');
      assert.ok(measurement.measurement.responseBytes > 0);
    }
    return { historicalEntries: size, seedElapsedMs, fixedHistoricalText: historicalText, historicalTextBytes: Buffer.byteLength(historicalText),
      sourceReferencesPerHistoricalEntry: 1, sessionId, seededEntries: seeded, queryPlans: plans,
      measurements: [initial.measurement, accepted.measurement, assembled.measurement, completed.measurement],
      context: { budgets: config.context.budgets, selectedIds, omittedIds, providerRequestBytes: bytes(assembled.value.request),
        providerHistoryBytes: bytes(assembled.value.request.contents), omissionReason: trace.historyOmissionReason },
      final: { runId: completed.value.runId, finalEntryId: completed.value.finalEntryId, finalText: completed.value.finalText,
        durableEntry: finalEntry, snapshotBytes: completed.measurement.responseBytes },
      semantics: { initialExact: true, historicalProvenancePreserved: true, classificationProvenancePreserved: true,
        contiguousWholeTurnSuffix: true, maximalCompilerSuffix: true, dispatchedRequestMatchesAssembly: true, snapshotMatchesDurableFinal: true } };
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('archive-scale records actual owner costs without changing semantics', { timeout: 15000 }, async () => {
  assert.match(process.env.ARCHIVE_SCALE_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.ok(process.env.ARCHIVE_SCALE_DIST, 'canonical compiled module location required');
  assert.ok(process.env.ARCHIVE_SCALE_OUTPUT, 'owned measurement output required');
  const load = async path => import(pathToFileURL(join(process.env.ARCHIVE_SCALE_DIST, path)).href);
  const modules = Object.assign({}, ...await Promise.all(['runtime/store.js', 'runtime/outbox.js', 'domain/facade.js',
    'chat/index.js', 'chat/context.js', 'prompt/index.js'].map(load)));
  const samples = [];
  for (const size of measurementContract.historicalEntrySizes) samples.push(await sample(modules, size));
  assert.equal(samples.length, 4);
  const output = { ...measurementContract, sourceSHA: process.env.ARCHIVE_SCALE_SOURCE_SHA, actualUTC: new Date().toISOString(),
    nodeVersion: process.version, timings: 'one-shot descriptive milliseconds; no thresholds, production extrapolation uncertain', samples };
  writeFileSync(process.env.ARCHIVE_SCALE_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  for (const sample of samples) console.log(JSON.stringify({ historicalEntries: sample.historicalEntries,
    measurements: sample.measurements.map(({ surface, domainSqlCalls, domainReturnedRows, responseBytes }) => ({ surface, domainSqlCalls, domainReturnedRows, responseBytes })),
    selectedHistory: sample.context.selectedIds.length, omittedHistory: sample.context.omittedIds.length }));
});
