import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createLuxKnowledgeReader } from '../connectors/lux-knowledge.js';
import type { McpPort, ToolDefinition as McpTool } from '../adapters/mcp/port.js';
import { runTools } from '../adapters/model/loop.js';
import type { HostContext, ModelPort, ModelRequest, ModelResult, ToolCallIntent, ToolResultBinding } from '../adapters/model/types.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import type { ConnectionPolicy, LiveAuthority, RunAcceptance } from '../tools/types.js';

const tools: McpTool[] = [
  { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false } },
  { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
];
const route = { identity: 'synthetic-route', provider: 'gemini' as const, modelId: 'synthetic-model', allowedClasses: ['ordinary', 'private'] as const };
function policy(overrides: Partial<ConnectionPolicy> = {}): ConnectionPolicy {
  return { schemaVersion: 1, ownerId: 'owner', connectionId: 'lux', generation: 1, enabled: true,
    endpoint: { id: 'endpoint', url: 'https://synthetic.invalid/mcp', account: 'account', resource: 'resource', credentialRef: 'private:synthetic-reference' },
    toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(tools),
    sourcePolicy: { id: 'synthetic-policy', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
    route: { identity: route.identity, allowedClasses: ['private'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 }, ...overrides };
}
const request: ModelRequest = { system: 'synthetic', promptVersion: '1', contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }], dataClasses: ['ordinary'], context: { items: [], selectedIds: [], maxChars: 100 } };
function modelResult(name?: string, args: Record<string, unknown> = { query: 'synthetic', limit: 1 }): ModelResult {
  return { status: 'complete', text: name ? '' : 'done', providerContent: { role: 'model', parts: name ? [{ functionCall: { name, args, id: 'call' } }] : [{ text: 'done' }] }, reason: 'complete', prompt: { version: '1', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
}
interface FixtureOptions { policy?: ConnectionPolicy; bindings?: string[]; result?: unknown; memoryBytes?: number }
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-owner-test-'));
  let store = new Store(dir, toolsMigrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const registry = new McpRegistry(); const p = options.policy ?? policy();
  const endpoint = { id: p.endpoint.id, url: p.endpoint.url, account: p.endpoint.account, resource: p.endpoint.resource, ...(p.endpoint.credentialRef ? { credentialRef: p.endpoint.credentialRef } : {}) };
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const sdk = new Server({ name: 'synthetic-owner', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  const calls: { name: string; arguments: unknown; signal: AbortSignal }[] = [];
  let onDispatch: (() => void) | undefined;
  let result: unknown = options.result ?? { content: [{ type: 'text', text: 'nonempty synthetic α insight' }] };
  sdk.setRequestHandler('tools/list', () => ({ tools }) as never);
  sdk.setRequestHandler('tools/call', () => { onDispatch?.(); return result as never; });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, p.endpoint.url);
    if (req.method === 'GET') return new Response(null, { status: 405 });
    if (req.method === 'POST') {
      const packet = await req.clone().json() as { method: string; params?: { name: string; arguments: unknown } };
      if (packet.method === 'tools/call') calls.push({ name: packet.params!.name, arguments: packet.params!.arguments, signal: req.signal });
    }
    return transport.handleRequest(req);
  });
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: options.memoryBytes ?? 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: 12000, projectionChars: 10, timeoutMs: 1000 } });
  t.after(async () => { await port.close(); await transport.close(); await sdk.close(); });
  const acceptance: RunAcceptance = { ownerId: 'owner', actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1,
    route: { ...route, allowedClasses: [...route.allowedClasses] }, allowedClasses: ['ordinary', 'private'], connectionIds: options.bindings ?? ['lux'] };
  let live: LiveAuthority | null = { ...acceptance, acceptedRunHash: '' };
  let lookup: (() => Promise<LiveAuthority | null>) | undefined;
  const lookupAuthority = async () => lookup ? lookup() : structuredClone(live);
  const owner = createToolsOwner({ store, ownerId: 'owner', registry, port, lookupAuthority });
  owner.applyConnection(p);
  assert.equal((await port.discover(endpoint.id)).state, 'discovered');
  if (p.enabled) owner.projectConnection('lux');
  const reader = createLuxKnowledgeReader({ port, registry, config: { endpointId: p.endpoint.id, account: p.endpoint.account, resource: p.endpoint.resource, schemaDigest: p.schemaDigest, generation: p.generation, maxSearchLimit: p.bounds.maxSearchLimit, maxQueryChars: p.bounds.maxQueryChars, maxGetIds: p.bounds.maxGetIds } });
  const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
  live.acceptedRunHash = accepted.sha256;
  const host: HostContext = { runId: 'run', actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1,
    grants: tools.map(tool => ({ tool: tool.name, effect: 'read', accountId: 'account', resourceId: 'resource' })) };
  const signal = new AbortController().signal;
  const definitions = () => owner.definitions('run');
  const intent = (executionId = 'run:1:0', name = 'search_knowledge', args = { query: 'synthetic', limit: 1 }): ToolCallIntent => ({ runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch, revision: host.revision,
    executionId, toolName: name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), callId: 'call', accountId: 'account', resourceId: 'resource' });
  const binding = (ref: { id: string; sha256: string }, call = intent()): ToolResultBinding => ({ executionId: call.executionId, name: call.toolName, callId: call.callId!, contentIndex: 2, partIndex: 0, result: structuredClone(ref) });
  const execute = (call = intent(), args = { query: 'synthetic', limit: 1 }, useSignal = signal) => definitions().find(d => d.name === call.toolName)!.execute(args, { ...call, signal: useSignal });
  const run = async (model: ModelPort) => runTools({ model, request, registry: definitions(), host, authority: { isCurrent: async () => true }, maxSteps: 3,
    control: { signal, deadlineMs: Date.now() + 5000 }, journal: owner.journal, resultGate: owner.resultGate });
  return { dir, get store() { return store; }, owner, port, reader, registry, acceptance, host, signal, calls, intent, binding, execute, run, definitions,
    setLive: (value: LiveAuthority | null) => { live = value; }, getLive: () => structuredClone(live!),
    setLookup: (value: () => Promise<LiveAuthority | null>) => { lookup = value; }, setDispatch: (value: () => void) => { onDispatch = value; }, setResult: (value: unknown) => { result = value; },
    reopen: () => { store.close(); store = new Store(dir, toolsMigrations); return createToolsOwner({ store, ownerId: 'owner', registry, port, lookupAuthority }); },
  };
}

// Durable ordering and database enforcement, not a mock journal.
test('intent commits before exact MCP dispatch; collision stops actual loop without a second invocation', async t => {
  const f = await fixture(t);
  f.setDispatch(() => assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', ['run:1:0']))?.state, 'intent'));
  const seen: ModelRequest[] = [];
  const model: ModelPort = { generate: async req => { seen.push(structuredClone(req)); return seen.length === 1 ? modelResult('search_knowledge') : modelResult(); } };
  const outcome = await f.run(model);
  assert.equal(outcome.status, 'complete'); assert.equal(f.calls.length, 1); assert.equal(seen.length, 2);
  assert.deepEqual(f.calls[0]!.arguments, { query: 'synthetic', limit: 1, include_sensitive: false });
  const response = seen[1]!.contents.at(-1)!.parts[0]!.functionResponse!.response;
  assert.equal(response['text'], 'nonempty synthetic α insight');
  assert.deepEqual(seen[1]!.dataClasses, ['ordinary', 'private']);
  assert.equal(response['sourceVersion'], 'unknown'); assert.equal(JSON.stringify(response).includes('synthetic-token'), false);
  assert.equal(JSON.stringify(response).includes('private:synthetic-reference'), false);
  const again = await f.run({ generate: async () => modelResult('search_knowledge') });
  assert.equal(again.status, 'uncertain'); assert.equal(f.calls.length, 1);
  assert.throws(() => f.owner.journal.intent({ ...f.intent(), argumentsHash: '0'.repeat(64) }), /collision/);
});

test('failed intent persistence and acceptance rollback cause zero dispatch and no provider continuation', async t => {
  const f = await fixture(t); let count = 0;
  f.store.transaction(tx => tx.run("CREATE TRIGGER inject_intent_failure BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT,'fixture'); END"));
  const result = await f.run({ generate: async () => { count++; return modelResult('search_knowledge'); } });
  assert.equal(result.reason, 'tool_journal_failed'); assert.equal(count, 1); assert.equal(f.calls.length, 0);
  assert.throws(() => f.store.transaction(tx => { f.owner.snapshotRun(tx, { ...f.acceptance, runId: 'rolled-back' }); throw Error('rollback'); }));
  assert.equal(f.store.transaction(tx => tx.get('SELECT run_id FROM tool_runs WHERE run_id=?', ['rolled-back'])), undefined);
});

test('completion persistence failure cannot be replaced by a failed receipt or continued', async t => {
  const f = await fixture(t); let count = 0;
  f.store.transaction(tx => tx.run("CREATE TRIGGER inject_completion_failure BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(ABORT,'fixture'); END"));
  const result = await f.run({ generate: async () => { count++; return modelResult('search_knowledge'); } });
  assert.equal(result.reason, 'tool_journal_failed'); assert.equal(count, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.store.transaction(tx => tx.get('SELECT state,result_id FROM tool_calls'))?.state, 'intent');
  assert.equal(f.store.transaction(tx => tx.get('SELECT result_id FROM tool_calls'))?.result_id, null);
});

test('exclusive Store composition rejects duplicate owner; reopen seals only matching pending intents once', async t => {
  const f = await fixture(t); f.owner.journal.intent(f.intent());
  assert.throws(() => createToolsOwner({ store: f.store, ownerId: 'other', registry: f.registry, port: f.port, lookupAuthority: async () => null }), /owner/);
  assert.throws(() => new Store(f.dir, toolsMigrations));
  f.store.transaction(tx => {
    const row = tx.get('SELECT * FROM tool_calls')!;
    tx.run('INSERT INTO tool_calls (owner_id,run_id,execution_id,intent_json,state) VALUES (?,?,?,?,?)', ['other', 'foreign', 'foreign', String(row['intent_json']), 'intent']);
  });
  const reopened = f.reopen();
  const rows = f.store.transaction(tx => tx.all('SELECT owner_id,state,result_json FROM tool_calls ORDER BY owner_id'));
  const own = rows.find(row => row.owner_id === 'owner')!;
  const unrelated = rows.find(row => row.owner_id === 'other')!;
  assert.equal(own.state, 'unknown'); assert.equal(unrelated.state, 'intent');
  const bytes = own.result_json;
  assert.throws(() => reopened.complete(f.intent(), { text: 'late' }, ['private']), /terminal/);
  assert.equal(f.store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE owner_id=?', ['owner']))?.result_json, bytes);
  assert.equal(f.calls.length, 0);
});

test('policy identical apply is a SQL no-op; generation/identity/delete and immutable receipt guards hold', async t => {
  const f = await fixture(t);
  f.store.transaction(tx => tx.run("CREATE TRIGGER reject_policy_update BEFORE UPDATE ON tool_connections BEGIN SELECT RAISE(ABORT,'no-update'); END"));
  f.owner.applyConnection(policy());
  f.store.transaction(tx => tx.run('DROP TRIGGER reject_policy_update'));
  assert.throws(() => f.owner.applyConnection(policy({ enabled: false })), /generation/);
  assert.throws(() => f.owner.applyConnection(policy({ generation: 0 })));
  const mutations = ["DELETE FROM tool_connections", "UPDATE tool_connections SET generation=0", "UPDATE tool_connections SET connection_id='replacement',generation=2", "UPDATE tool_runs SET snapshot_json='{}'", 'DELETE FROM tool_runs'];
  for (const sql of mutations) assert.throws(() => f.store.transaction(tx => tx.run(sql)), sql);
  f.owner.journal.intent(f.intent());
  for (const sql of ["DELETE FROM tool_calls", "UPDATE tool_calls SET intent_json='{}'", "UPDATE tool_calls SET execution_id='new'"]) assert.throws(() => f.store.transaction(tx => tx.run(sql)), sql);
  const ref = f.owner.complete(f.intent(), { text: 'bounded' }, ['private']);
  for (const sql of ["UPDATE tool_calls SET state='intent'", "UPDATE tool_calls SET result_json='{}'", "UPDATE tool_calls SET result_sha256='bad'"]) assert.throws(() => f.store.transaction(tx => tx.run(sql)), sql);
  assert.throws(() => f.owner.complete(f.intent(), { text: 'replacement' }, ['private']), /terminal/);
  assert.equal((await f.owner.resultGate.authorize(f.host, [f.binding(ref)], ['ordinary'], f.signal)).state, 'allowed');
});

test('persisted disable survives reopen and stale projected registry grants cannot dispatch', async t => {
  const f = await fixture(t); const oldGrant = f.registry.currentGrant('endpoint')!;
  f.owner.applyConnection(policy({ generation: 2, enabled: false }));
  assert.equal(f.registry.currentGrant('endpoint'), undefined);
  // Even a stale external projection restored after revoke is not authority.
  f.registry.enable('endpoint'); f.registry.observed('endpoint', tools, f.registry.revision('endpoint'));
  f.registry.approve({ ...oldGrant, generation: 3 });
  assert.throws(() => f.owner.journal.intent(f.intent()), /policy/);
  assert.equal(f.calls.length, 0);
  const reopened = f.reopen();
  assert.equal((await reopened.resultGate.authorize(f.host, [], ['ordinary'], f.signal)).state, 'refused');
  assert.throws(() => reopened.projectConnection('lux'), /disabled/);
});

test('every request denies empty-binding authority and every accepted connection revocation', async t => {
  const f = await fixture(t);
  for (const mutate of [
    (l: LiveAuthority) => ({ ...l, actorId: 'foreign' }), (l: LiveAuthority) => ({ ...l, ownerId: 'foreign' }),
    (l: LiveAuthority) => ({ ...l, authorityEpoch: 'foreign' }), (l: LiveAuthority) => ({ ...l, revision: 2 }),
    (l: LiveAuthority) => ({ ...l, runId: 'foreign' }), (l: LiveAuthority) => ({ ...l, acceptedRunHash: '0'.repeat(64) }),
    (l: LiveAuthority) => ({ ...l, allowedClasses: ['ordinary'] as LiveAuthority['allowedClasses'] }),
    (l: LiveAuthority) => ({ ...l, route: { ...l.route, modelId: 'other' } }),
  ]) {
    const original = { ...f.acceptance, acceptedRunHash: f.getLive().acceptedRunHash };
    f.setLive(mutate(original));
    let requests = 0; const result = await f.run({ generate: async () => { requests++; return modelResult(); } });
    assert.equal(result.status, 'denied'); assert.equal(requests, 0);
    f.setLive(original);
  }
  f.owner.applyConnection(policy({ generation: 2, sourcePolicy: { ...policy().sourcePolicy, revision: 2 } }));
  assert.equal((await f.owner.resultGate.authorize(f.host, [], ['ordinary'], f.signal)).state, 'refused');
});

test('unbound run still needs live authority, including initial request', async t => {
  const f = await fixture(t, { bindings: [] }); f.setLive(null); let requests = 0;
  const result = await f.run({ generate: async () => { requests++; return modelResult(); } });
  assert.equal(result.status, 'denied'); assert.equal(requests, 0);
});

test('revoke while awaiting authority is caught by final synchronous persisted reread', async t => {
  const f = await fixture(t); const original = f.getLive();
  let resolve!: (value: LiveAuthority) => void;
  f.setLookup(() => new Promise(r => { resolve = r; }));
  const gate = f.owner.resultGate.authorize(f.host, [], ['ordinary'], f.signal);
  f.owner.applyConnection(policy({ generation: 2, enabled: false })); resolve(original);
  assert.equal((await gate).state, 'refused'); assert.equal(f.calls.length, 0);
});

test('all bound connections checked even zero refs from another connection', async t => {
  const f = await fixture(t);
  const second = policy({ connectionId: 'second', endpoint: { ...policy().endpoint, id: 'second-endpoint' } });
  f.registry.register({ id: 'second-endpoint', url: second.endpoint.url, account: 'account', resource: 'resource' });
  f.owner.applyConnection(second);
  const acceptance = { ...f.acceptance, runId: 'two', connectionIds: ['lux', 'second'] };
  const accepted = f.store.transaction(tx => f.owner.snapshotRun(tx, acceptance));
  f.setLive({ ...acceptance, acceptedRunHash: accepted.sha256 });
  f.owner.applyConnection({ ...second, generation: 2, enabled: false });
  assert.equal((await f.owner.resultGate.authorize({ ...f.host, runId: 'two' }, [], ['ordinary'], f.signal)).state, 'refused');
});

test('result ref, execution/name/call/scope/hash binding and detached immutable bytes survive reopen', async t => {
  const f = await fixture(t); f.owner.journal.intent(f.intent());
  const outcome = await f.execute(); assert.equal(outcome.status, 'completed'); if (outcome.status !== 'completed') return;
  const good = f.binding(outcome.result);
  const gate = await f.owner.resultGate.authorize(f.host, [good], ['ordinary'], f.signal); assert.equal(gate.state, 'allowed');
  if (gate.state !== 'allowed') return;
  gate.results[0]!.response['text'] = 'mutated'; good.result.sha256 = '0'.repeat(64);
  const originals = f.binding(outcome.result);
  for (const binding of [ { ...originals, executionId: 'other' }, { ...originals, name: 'get_insight' }, { ...originals, callId: 'other' },
    { ...originals, result: { ...outcome.result, id: 'missing' } }, { ...originals, result: { ...outcome.result, sha256: '0'.repeat(64) } } ]) {
    assert.equal((await f.owner.resultGate.authorize(f.host, [binding], ['ordinary'], f.signal)).state, 'refused');
  }
  const before = f.store.transaction(tx => tx.get('SELECT result_json,result_sha256 FROM tool_calls'))!;
  assert.equal(sha256(String(before.result_json)), before.result_sha256);
  const reopened = f.reopen(); const after = await reopened.resultGate.authorize(f.host, [originals], ['ordinary'], f.signal);
  assert.equal(after.state, 'allowed'); if (after.state === 'allowed') assert.equal(after.results[0]!.response['text'], 'nonempty synthetic α insight');
});

test('search/get strict arguments, provenance and requested IDs remain unverified', async t => {
  const f = await fixture(t);
  const search = f.definitions()[0]!;
  assert.equal(search.parameters['additionalProperties'], false);
  assert.equal(search.validate({ query: 'x', limit: 4 }), false); assert.equal(search.validate({ query: 'x', limit: 1, account: 'foreign' }), false);
  assert.equal(search.validate({ query: 'x', limit: 1 }), true);
  const args = { ids: [13, 7] }; const call = { ...f.intent('run:1:1', 'get_insight', args as never), callId: 'get' };
  f.owner.journal.intent(call);
  const outcome = await f.definitions().find(d => d.name === 'get_insight')!.execute(args, { ...call, signal: f.signal });
  assert.equal(outcome.status, 'completed'); assert.deepEqual(f.calls[0]!.arguments, { ids: [13, 7], include_links: false });
  if (outcome.status !== 'completed') return;
  const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result, call)], ['ordinary'], f.signal);
  assert.equal(gate.state, 'allowed'); if (gate.state !== 'allowed') return;
  const value = gate.results[0]!.response;
  assert.deepEqual(value['requestedIds'], [13, 7]); assert.equal(value['requestedIdsVerified'], false);
  assert.deepEqual(value['coverage'], { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' });
  assert.equal((value['source'] as Record<string, unknown>)['account'], 'account');
});

for (const bad of [null, 'absent'] as const) test(`unknown source policy ${bad} denies before initial provider`, async t => {
  const p = policy(); p.sourcePolicy.unknownClass = null;
  if (bad === 'absent') delete (p.sourcePolicy as Partial<typeof p.sourcePolicy>).unknownClass;
  if (bad === 'absent') {
    const dir = mkdtempSync(join(tmpdir(), 'didi-owner-test-')); const store = new Store(dir, toolsMigrations);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const owner = createToolsOwner({ store, ownerId: 'owner', registry: new McpRegistry(), port: {} as McpPort, lookupAuthority: async () => null });
    assert.throws(() => owner.applyConnection(p)); return;
  }
  const f = await fixture(t, { policy: p }); let requests = 0;
  assert.equal((await f.run({ generate: async () => { requests++; return modelResult(); } })).status, 'denied'); assert.equal(requests, 0);
});

for (const [label, result, memoryBytes] of [
  ['empty-valid', { content: [] }, 10000], ['unsupported', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, 10000],
  ['oversize', { content: [{ type: 'text', text: 'x'.repeat(5000) }] }, 10000], ['capacity', { content: [{ type: 'text', text: 'nonempty' }] }, 1],
] as const) test(`honest bounded Lux ${label} outcome`, async t => {
  const f = await fixture(t, { result, memoryBytes }); f.owner.journal.intent(f.intent());
  const outcome = await f.execute();
  assert.equal(outcome.status, label === 'empty-valid' ? 'completed' : 'failed');
  if (outcome.status === 'completed') {
    const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result)], ['ordinary'], f.signal);
    assert.equal(gate.state, 'allowed'); if (gate.state === 'allowed') assert.equal(gate.results[0]!.response['text'], '');
  }
});

test('abort before dispatch is zero calls; forwarded abort after remote dispatch remains unknown and late completion denied', async t => {
  const f = await fixture(t); f.owner.journal.intent(f.intent());
  const before = new AbortController(); before.abort();
  assert.equal((await f.execute(f.intent(), { query: 'synthetic', limit: 1 }, before.signal)).status, 'unknown'); assert.equal(f.calls.length, 0);
  // Fresh independent execution identity; an aborted committed intent is never rekeyed automatically.
  const call = { ...f.intent('run:1:1'), callId: 'second' }; f.owner.journal.intent(call);
  const after = new AbortController(); f.setDispatch(() => after.abort());
  assert.equal((await f.execute(call, { query: 'synthetic', limit: 1 }, after.signal)).status, 'unknown');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.signal.aborted, true);
  f.owner.journal.fail(call, 'unknown', 'cancelled');
  assert.throws(() => f.owner.complete(call, { text: 'late' }, ['private']), /terminal/);
});

// Native binding evidence only: this deliberately does not repair/bypass the Store guard.
test('SQLite binding probe preserves compound trigger consumed prefix and ignores SELECT DDL COMMIT tails', t => {
  const prefix = `/* leading α; 'END' */\nCREATE TRIGGER "END; α" AFTER INSERT ON events BEGIN
    INSERT INTO trace VALUES(CASE WHEN NEW.value='α; END' THEN 'quoted ''END;'' α' ELSE 'else;END' END);
    UPDATE trace SET note=note || ' β 😀;'; /* END; 'quoted' */
  END;`;
  const tails = [' SELECT 99 AS ignored;', ' CREATE TABLE forbidden_tail(x);', ' COMMIT;', ' -- tail α; END\n SELECT 2;', ' /* trailing quote \'END;\' */ CREATE TABLE forbidden_tail(x);', ' THIS IS NOT SQL'];
  for (const tail of tails) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE events(value TEXT); CREATE TABLE trace(note TEXT); BEGIN;');
      const stmt: StatementSync = db.prepare(prefix + tail);
      assert.equal(stmt.sourceSQL, prefix, `exact consumed prefix for ${tail}`);
      assert.equal(Buffer.byteLength(stmt.sourceSQL, 'utf8'), Buffer.byteLength(prefix, 'utf8'));
      stmt.run();
      assert.equal(db.isTransaction, true, 'trailing COMMIT must not run');
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='forbidden_tail'").get()!['n'], 0);
      db.prepare('INSERT INTO events VALUES (?)').run('α; END');
      assert.equal(db.prepare('SELECT note FROM trace').get()!['note'], "quoted 'END;' α β 😀;");
      assert.equal(stmt.sourceSQL, prefix, 'execution does not rewrite sourceSQL');
      db.exec('ROLLBACK');
    } finally { db.close(); }
  }
  t.diagnostic(`BINDING-PROBE node=${process.version}; compound trigger/CASE/comments/quotes/Unicode exact prefix; six tails ignored, including SELECT/DDL/COMMIT/malformed`);
});

test('SQLite binding probe NUL truncates SQL input or rejects an incomplete first statement', t => {
  const db = new DatabaseSync(':memory:');
  try {
    const prefix = "SELECT 'α 😀' AS value;";
    for (const first of [prefix, prefix.slice(0, -1)]) {
      const stmt: StatementSync = db.prepare(first + '\0 CREATE TABLE nul_tail(x);');
      assert.equal(stmt.sourceSQL, first);
      assert.equal(stmt.get()!['value'], 'α 😀');
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='nul_tail'").get()!['n'], 0);
    }
    assert.throws(() => db.prepare("SELECT 'α\0β' AS value;"), 'NUL inside literal leaves incomplete first statement');
    assert.throws(() => db.prepare('\0SELECT 1'), 'NUL before SQL produces no statement');
    t.diagnostic(`BINDING-PROBE sqlite=${db.prepare('SELECT sqlite_version() AS version').get()!['version']}; embedded NUL terminates input; incomplete/empty first statements rejected`);
  } finally { db.close(); }
});

test('SQLite binding probe sourceSQL retains parameters while expandedSQL substitutes bindings', t => {
  const db = new DatabaseSync(':memory:');
  try {
    const prefix = '/* α */ SELECT $value AS value;';
    const stmt: StatementSync = db.prepare(prefix + ' SELECT 2;');
    assert.equal(stmt.sourceSQL, prefix);
    assert.equal(stmt.get({ '$value': "α'😀" })!['value'], "α'😀");
    assert.equal(stmt.sourceSQL, prefix);
    assert.equal(stmt.expandedSQL, "/* α */ SELECT 'α''😀' AS value;");
    t.diagnostic('BINDING-PROBE sourceSQL is original consumed text, not expandedSQL; no normalizedSQL API claim');
  } finally { db.close(); }
});

test('canonical UTF8 JSON rejects unsupported data without accessors; array order and sorted keys preserved', () => {
  assert.equal(canonicalJSON({ z: [2, 1], a: 'α' }), '{"a":"α","z":[2,1]}');
  assert.equal(sha256('α'), createHash('sha256').update(Buffer.from('α', 'utf8')).digest('hex'));
  let accessed = false; const accessor = Object.defineProperty({}, 'x', { enumerable: true, get: () => { accessed = true; return 1; } });
  for (const value of [NaN, Infinity, undefined, { x: undefined }, [undefined], accessor, new Date(), BigInt(1), [, 1]]) assert.throws(() => canonicalJSON(value));
  assert.equal(accessed, false);
});

test('actual reader defaults remain untouched; trusted typed restrictions constrain separate classified snapshot', async t => {
  const f = await fixture(t); const evidence = await f.reader.search({ query: 'synthetic', limit: 1 }, f.signal);
  assert.equal(evidence.state, 'completed');
  if (evidence.state !== 'completed') return;
  assert.equal(evidence.classification, 'unknown'); assert.equal(evidence.capability, 'local-only');
  const projected = projectLuxResult(evidence, policy(), f.port);
  assert.deepEqual(projected.dataClasses, ['private']);
  assert.equal(evidence.classification, 'unknown'); assert.equal(evidence.capability, 'local-only');
  for (const restriction of [
    { localOnly: true, nonDisclosure: false, dataClasses: ['private'] as const },
    { localOnly: false, nonDisclosure: true, dataClasses: ['private'] as const },
    { localOnly: false, nonDisclosure: false, dataClasses: ['sensitive'] as const },
  ]) assert.throws(() => projectLuxResult(evidence, policy(), f.port, restriction), /restriction/);
  assert.deepEqual(projectLuxResult(evidence, policy(), f.port, { localOnly: false, nonDisclosure: false, dataClasses: ['private'] }).dataClasses, ['private']);
});

test('bounded complete slice reader denies expired, missing, partial, hash and source scope mismatches', async t => {
  const f = await fixture(t); const evidence = await f.reader.search({ query: 'synthetic', limit: 1 }, f.signal);
  if (evidence.state !== 'completed') { assert.fail('nonempty fixture must complete'); }
  for (const state of ['expired', 'unavailable', 'refused'] as const) {
    assert.throws(() => projectLuxResult(evidence, policy(), { ...f.port, readSlice: () => ({ state, reason: 'synthetic' }) }));
  }
  assert.throws(() => projectLuxResult(evidence, policy(), { ...f.port, readSlice: req => {
    const slice = f.port.readSlice(req); return slice.state === 'available' ? { ...slice, bytes: slice.bytes.slice(1) } : slice;
  } }));
  assert.throws(() => projectLuxResult(evidence, policy(), { ...f.port, readSlice: req => {
    const slice = f.port.readSlice(req); return slice.state === 'available' ? { ...slice, sha256: '0'.repeat(64) } : slice;
  } }));
  for (const source of [ { ...evidence.source, account: 'foreign' }, { ...evidence.source, resource: 'foreign' }, { ...evidence.source, url: 'https://foreign.invalid/mcp' }, { ...evidence.source, generation: 2 }, { ...evidence.source, schemaDigest: '0'.repeat(64) } ]) {
    assert.throws(() => projectLuxResult({ ...evidence, source }, policy(), f.port), /scope/);
  }
});

test('executor rechecks trusted authority and post-await policy before calling the accepted reader', async t => {
  const f = await fixture(t); f.owner.journal.intent(f.intent());
  const original = f.getLive();
  f.setLive({ ...original, actorId: 'foreign' });
  assert.equal((await f.execute()).status, 'failed'); assert.equal(f.calls.length, 0);
  f.setLive(original);
  let resolve!: (value: LiveAuthority) => void; f.setLookup(() => new Promise(r => { resolve = r; }));
  const execution = f.execute(); f.owner.applyConnection(policy({ generation: 2, enabled: false })); resolve(original);
  assert.equal((await execution).status, 'failed'); assert.equal(f.calls.length, 0);
});

test('targetless refusal is durable only for a fresh identity; mismatched complete/refusal cannot replace intent', async t => {
  const f = await fixture(t);
  const { accountId: _account, resourceId: _resource, ...targetless } = f.intent();
  const ref = f.owner.journal.refuse({ ...targetless, toolName: 'missing' }, 'unknown_tool');
  assert.equal((await f.owner.resultGate.authorize(f.host, [{ ...f.binding(ref), name: 'missing' }], ['ordinary'], f.signal)).state, 'allowed');
  assert.throws(() => f.owner.journal.refuse({ ...targetless, toolName: 'different' }, 'unknown_tool'), /collision/);
  assert.throws(() => f.owner.journal.intent(f.intent()), /collision/);
  const fresh = { ...f.intent('run:1:1'), callId: 'new' }; f.owner.journal.intent(fresh);
  assert.throws(() => f.owner.complete({ ...fresh, argumentsHash: '0'.repeat(64) }, { text: 'bad' }, ['private']), /intent/);
  assert.throws(() => f.owner.journal.refuse({ ...fresh, toolName: 'changed' }, 'unknown_tool'), /collision/);
});


// Runtime contract casts let the baseline execute the assertions (rather than fail compilation).
function standingOwner(owner: ReturnType<typeof createToolsOwner>) {
  return owner as typeof owner & {
    applyConnectionIntent(intent: { expectedPolicySha256: string | null; policy: ConnectionPolicy }): { state: string; sha256: string };
    restoreConnection(id: string, assertCurrentBinding: () => void): Promise<{ state: string; reason?: string }>;
  };
}
test('conditional intent is idempotent but stale predecessor, endpoint rebind and corruption never mutate durable consent', async t => {
  const f = await fixture(t); const owner = standingOwner(f.owner); const p = policy(); const hash = sha256(canonicalJSON(p));
  assert.deepEqual(owner.applyConnectionIntent({ expectedPolicySha256: null, policy: p }), { state: 'unchanged', sha256: hash });
  const next = policy({ generation: 2 });
  assert.throws(() => owner.applyConnectionIntent({ expectedPolicySha256: null, policy: next }), /predecessor/);
  assert.throws(() => owner.applyConnectionIntent({ expectedPolicySha256: hash, policy: policy({ generation: 2, endpoint: { ...p.endpoint, account: 'other' } }) }), /identity/);
  const revoked = policy({ generation: 2, enabled: false });
  const applied = owner.applyConnectionIntent({ expectedPolicySha256: hash, policy: revoked });
  assert.equal(applied.state, 'applied');
  assert.throws(() => owner.applyConnectionIntent({ expectedPolicySha256: hash, policy: policy({ generation: 3 }) }), /predecessor/);
  assert.equal((await owner.restoreConnection('lux', () => {})).state, 'refused');
  assert.equal(f.registry.currentGrant('endpoint'), undefined);
  const row = f.store.transaction(tx => tx.get('SELECT * FROM tool_connections'))!;
  assert.equal(row.policy_sha256, applied.sha256);
  const raw = new DatabaseSync(join(f.dir, 'state.sqlite'));
  raw.exec('DROP TRIGGER tool_connections_update_guard');
  raw.prepare('UPDATE tool_connections SET policy_sha256=?').run('0'.repeat(64)); raw.close();
  assert.throws(() => owner.applyConnectionIntent({ expectedPolicySha256: applied.sha256, policy: revoked }), /corrupt/);
});
test('standing consent restores same generation after transient and changed-to-original catalog, not after revoke', async t => {
  const f = await fixture(t); const owner = standingOwner(f.owner);
  f.registry.suspend('endpoint');
  assert.deepEqual(await owner.restoreConnection('lux', () => {}), { state: 'restored' });
  assert.equal(f.registry.currentGrant('endpoint')?.generation, 1);
  const original = tools[0]!.description;
  tools[0]!.description = 'changed synthetic schema';
  try {
    assert.equal((await owner.restoreConnection('lux', () => {})).state, 'refused');
    assert.equal(f.registry.currentGrant('endpoint'), undefined);
  } finally { if (original === undefined) delete tools[0]!.description; else tools[0]!.description = original; }
  assert.deepEqual(await owner.restoreConnection('lux', () => {}), { state: 'restored' });
  f.registry.revoke('endpoint');
  assert.equal((await owner.restoreConnection('lux', () => {})).state, 'refused');
  f.owner.applyConnection(policy({ generation: 2 }));
  assert.deepEqual(await owner.restoreConnection('lux', () => {}), { state: 'restored' });
});
test('restoration rereads durable revoke after discovery await; synchronous guard revoke also wins', async t => {
  const f = await fixture(t); const owner = standingOwner(f.owner);
  let enter!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const discover = f.port.discover.bind(f.port);
  t.mock.method(f.port, 'discover', async (id: string) => { enter(); await gate; return discover(id); });
  const pending = owner.restoreConnection('lux', () => {}); await started;
  f.owner.applyConnection(policy({ generation: 2, enabled: false })); release();
  assert.equal((await pending).state, 'refused');
  assert.equal(f.registry.currentGrant('endpoint'), undefined);
  f.owner.applyConnection(policy({ generation: 3 }));
  assert.equal((await owner.restoreConnection('lux', () => { f.owner.applyConnection(policy({ generation: 4, enabled: false })); })).state, 'refused');
  assert.equal(f.registry.currentGrant('endpoint'), undefined);
});
test('restore then revoke and restart never lose revocation; old snapshot/result stays gated', async t => {
  const f = await fixture(t); const owner = standingOwner(f.owner); f.owner.journal.intent(f.intent()); const result = await f.execute();
  assert.equal(result.status, 'completed'); if (result.status !== 'completed') return;
  assert.deepEqual(await owner.restoreConnection('lux', () => {}), { state: 'restored' });
  f.owner.applyConnection(policy({ generation: 2, enabled: false }));
  assert.equal(f.registry.visibleTools('endpoint').length, 0);
  assert.equal((await f.owner.resultGate.authorize(f.host, [f.binding(result.result)], ['ordinary'], f.signal)).state, 'refused');
  const reopened = standingOwner(f.reopen());
  assert.equal((await reopened.restoreConnection('lux', () => {})).state, 'refused');
  assert.equal(f.registry.currentGrant('endpoint'), undefined);
});
test('fresh owner restores durable enabled consent at the same generation but disabled before first projection refuses', async t => {
  const f = await fixture(t); const p = policy();
  f.registry.suspend('endpoint');
  assert.deepEqual(await standingOwner(f.reopen()).restoreConnection('lux', () => {}), { state: 'restored' });
  const other = await fixture(t, { policy: policy({ enabled: false }) });
  assert.equal((await standingOwner(other.owner).restoreConnection('lux', () => {})).state, 'refused');
  assert.equal(other.registry.currentGrant(p.endpoint.id), undefined);
});
