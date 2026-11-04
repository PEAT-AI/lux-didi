import { TaskRuntime } from '../tasks/runtime.js';
import { Authority } from '../tasks/authority.js';
import { connectorExecutor } from '../tasks/connectors.js';
import { taskDefinitions, TASK_ACCOUNT, TASK_RESOURCE } from '../tasks/chat.js';
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
import { attachHostLogSink } from '../tools/host-events.js';


import type { ComposeDispatch } from '../tools/types.js';
import type { HostContext, JsonObject, ModelPort, ModelRequest, ModelResult, ToolCallIntent, ToolCallJournal, ToolDefinition, ToolResultBinding, ToolResultGate } from '../adapters/model/types.js';
import { CONNECTOR_DESCRIPTORS, normalizeGetInsightArgs } from '../connectors/index.js';
import { declarationsFor, runToolCalls } from '../tools/declarations.js';
import { createToolsOwner, toolsMigrations, validatePolicy } from '../tools/index.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import type { ConnectionPolicy, LiveAuthority, RunAcceptance, ToolsOwnerOptions, ToolFailureEvent } from '../tools/types.js';

const tools: McpTool[] = [
  { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false } },
  { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
];
const route = { identity: 'synthetic-route', provider: 'gemini' as const, modelId: 'synthetic-model', allowedClasses: ['ordinary', 'private'] as const };
// This suite drives the HTTP arm; the union's stdio arm has no url.
const policyUrl = (e: ConnectionPolicy['endpoint']): string => (e as { transport?: unknown }).transport === 'stdio' ? '' : (e as { url: string }).url;
function policy(overrides: Partial<ConnectionPolicy> = {}): ConnectionPolicy {
  return { schemaVersion: 1, bindingMode: 'connection', ownerId: 'owner', connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { id: 'endpoint', url: 'https://synthetic.invalid/mcp', account: 'account', resource: 'resource', credentialRef: 'private:synthetic-reference' },
    toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(tools),
    sourcePolicy: { id: 'synthetic-policy', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
    route: { identity: route.identity, allowedClasses: ['private'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 }, ...overrides };
}
const request: ModelRequest = { system: 'synthetic', promptVersion: '1', contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }], dataClasses: ['ordinary'], context: { items: [], selectedIds: [], maxChars: 100 } };
function modelResult(name?: string, args: Record<string, unknown> = { query: 'synthetic' }): ModelResult {
  return { status: 'complete', text: name ? '' : 'done', providerContent: { role: 'model', parts: name ? [{ functionCall: { name, args, id: 'call' } }] : [{ text: 'done' }] }, reason: 'complete', prompt: { version: '1', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
}
interface FixtureOptions { sourceTools?: McpTool[]; resultOf?: (name: string) => unknown; log?: ToolsOwnerOptions['log']; policy?: ConnectionPolicy; bindings?: string[]; result?: unknown; memoryBytes?: number; responseBytes?: number; compose?: ComposeDispatch; grantMode?: 'owner-trusted-reads'; alarms?: ToolsOwnerOptions['alarms']; timezone?: string }
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-owner-test-'));
  let store = new Store(dir, toolsMigrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const registry = new McpRegistry(); const p = options.policy ?? policy();
  const sourceTools = options.sourceTools ?? tools;
  const endpoint = { id: p.endpoint.id, url: policyUrl(p.endpoint), account: p.endpoint.account, resource: p.endpoint.resource, ...(p.endpoint.credentialRef ? { credentialRef: p.endpoint.credentialRef } : {}) };
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const sdk = new Server({ name: 'synthetic-owner', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  const calls: { name: string; arguments: unknown; signal: AbortSignal }[] = [];
  let onDispatch: (() => void) | undefined;
  let result: unknown = options.result ?? { content: [{ type: 'text', text: 'nonempty synthetic α insight' }] };
  sdk.setRequestHandler('tools/list', () => ({ tools: sourceTools }) as never);
  sdk.setRequestHandler('tools/call', request => { onDispatch?.(); return (options.resultOf ? options.resultOf(request.params.name) : result) as never; });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, policyUrl(p.endpoint));
    if (req.method === 'GET') return new Response(null, { status: 405 });
    if (req.method === 'POST') {
      const packet = await req.clone().json() as { method: string; params?: { name: string; arguments: unknown } };
      if (packet.method === 'tools/call') calls.push({ name: packet.params!.name, arguments: packet.params!.arguments, signal: req.signal });
    }
    return transport.handleRequest(req);
  });
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: options.memoryBytes ?? 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: options.responseBytes ?? 12000, projectionChars: 10, timeoutMs: 1000 } });
  t.after(async () => { await port.close(); await transport.close(); await sdk.close(); });
  const acceptance: RunAcceptance = { ownerId: 'owner', actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1,
    route: { ...route, allowedClasses: [...route.allowedClasses] }, allowedClasses: ['ordinary', 'private'], connectionIds: options.bindings ?? ['lux'] };
  let live: LiveAuthority | null = { ...acceptance, acceptedRunHash: '' };
  let lookup: (() => Promise<LiveAuthority | null>) | undefined;
  const lookupAuthority = async () => lookup ? lookup() : structuredClone(live);
  const owner = createToolsOwner({ store, ownerId: 'owner', registry, port, lookupAuthority, ...(options.log ? { log: options.log } : {}), ...(options.compose ? { compose: options.compose } : {}), ...(options.grantMode ? { grantMode: options.grantMode } : {}), ...(options.alarms ? { alarms: options.alarms } : {}), ...(options.timezone ? { timezone: options.timezone } : {}) });
  owner.applyConnection(p);
  assert.equal((await port.discover(endpoint.id)).state, 'discovered');
  if (p.enabled) owner.projectConnection('lux');
  const reader = createLuxKnowledgeReader({ port, registry, config: { endpointId: p.endpoint.id, account: p.endpoint.account, resource: p.endpoint.resource, schemaDigest: p.schemaDigest, generation: p.generation, maxSearchLimit: p.bounds.maxSearchLimit, maxQueryChars: p.bounds.maxQueryChars, maxGetIds: p.bounds.maxGetIds } });
  const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
  live.acceptedRunHash = accepted.sha256;
  const host: HostContext = { runId: 'run', actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1,
    grants: tools.map(tool => ({ tool: tool.name, effect: 'read', accountId: TASK_ACCOUNT, resourceId: TASK_RESOURCE })) };
  const signal = new AbortController().signal;
  const ownerWords = new Map<string, string[]>();
  const observeOwner = (runId: string, journalId: string, words: string, at: number) => {
    ownerWords.set(runId, [...(ownerWords.get(runId) ?? []), words]);
    taskRuns.delete(runId);
    owner.observeAlarmOwner(runId, journalId, words, at);
  };
  const taskRuns = new Map<string, { runtime: TaskRuntime; identity: ReturnType<TaskRuntime['begin']>['identity'] }>();
  const allDefinitions = (runId = 'run') => {
    let task = taskRuns.get(runId);
    if (!task) {
      const runtime = new TaskRuntime({ store, execute: connectorExecutor(owner.taskBindings(acceptance.connectionIds), owner.taskExecutors(runId)),
        authority: new Authority({ journal: store.taskEffectJournal(() => true), checkEffect: async () => true, log() {} }),
        infer: async () => ({ text: '', calls: [], no_action: true }), contentAllowed: () => true,
        delivery: { attach() {}, progress() {}, deliver() {}, closed() {} } });
      task = { runtime, identity: runtime.begin(ownerWords.get(runId)?.join(' ') ?? 'Synthetic owner request', 1).identity }; taskRuns.set(runId, task);
    }
    return taskDefinitions(task.runtime, task.identity, owner, runId);
  };
  const definitions = () => allDefinitions().filter(tool => tool.name === 'search_knowledge' || tool.name === 'read_knowledge');
  const intent = (executionId = 'run:1:0', name = 'search_knowledge', args: Record<string, unknown> = { query: 'synthetic' }): ToolCallIntent => ({ runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch, revision: host.revision,
    executionId, toolName: name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), callId: 'call', accountId: TASK_ACCOUNT, resourceId: TASK_RESOURCE });
  const binding = (ref: { id: string; sha256: string }, call = intent()): ToolResultBinding => ({ executionId: call.executionId, name: call.toolName, callId: call.callId!, contentIndex: 2, partIndex: 0, result: structuredClone(ref) });
  const execute = (call = intent(), args: Record<string, unknown> = { query: 'synthetic' }, useSignal = signal) => definitions().find(d => d.name === call.toolName)!.execute(args, { ...call, signal: useSignal });
  const run = async (model: ModelPort) => runTools({ model, request, registry: definitions(), host, authority: { isCurrent: async () => true }, maxSteps: 3,
    control: { signal, deadlineMs: Date.now() + 5000 }, journal: owner.journal, resultGate: owner.resultGate });
  return { dir, get store() { return store; }, owner, port, reader, registry, acceptance, host, signal, calls, intent, binding, execute, run, definitions, allDefinitions, observeOwner, taskRuntime: () => { allDefinitions(); return taskRuns.get('run')!.runtime; },
    setLive: (value: LiveAuthority | null) => { live = value; }, getLive: () => structuredClone(live!),
    setLookup: (value: () => Promise<LiveAuthority | null>) => { lookup = value; }, setDispatch: (value: () => void) => { onDispatch = value; }, setResult: (value: unknown) => { result = value; },
    reopen: () => { store.close(); store = new Store(dir, toolsMigrations); return createToolsOwner({ store, ownerId: 'owner', registry, port, lookupAuthority, ...(options.log ? { log: options.log } : {}), ...(options.compose ? { compose: options.compose } : {}), ...(options.grantMode ? { grantMode: options.grantMode } : {}), ...(options.alarms ? { alarms: options.alarms } : {}), ...(options.timezone ? { timezone: options.timezone } : {}) }); },
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
  assert.deepEqual(f.calls[0]!.arguments, { query: 'synthetic', limit: 3, include_sensitive: false });
  const response = seen[1]!.contents.at(-1)!.parts[0]!.functionResponse!.response;
  assert.equal(response['text'], 'nonempty synthetic α insight');
  assert.deepEqual(seen[1]!.dataClasses, ['ordinary', 'private']);
  assert.equal(response['sourceVersion'], undefined, 'host provenance is not a model-supplied source version'); assert.equal(JSON.stringify(response).includes('synthetic-token'), false);
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

test('SOURCE DEFECT task read delivery: persisted disable survives reopen and stale grants cannot dispatch', async t => {
  const f = await fixture(t);
  const initialCall = { ...f.intent('initial-result'), callId: 'initial-result' };
  f.owner.journal.intent(initialCall); const initialResult = await f.execute(initialCall);
  assert.equal(initialResult.status, 'completed'); if (initialResult.status !== 'completed') throw Error('initial read failed');
  const oldGrant = f.registry.currentGrant('endpoint')!;
  const staleCall = f.intent('stale-read'); f.owner.journal.intent(staleCall);
  f.owner.applyConnection(policy({ generation: 2, enabled: false }));
  assert.equal(f.registry.currentGrant('endpoint'), undefined);
  // Even a stale external projection restored after revoke is not authority.
  f.registry.enable('endpoint'); f.registry.observed('endpoint', tools, f.registry.revision('endpoint'));
  f.registry.approve({ ...oldGrant, generation: 3 });
  await assert.rejects(f.execute(staleCall), /task_source_policy_denied/);
  assert.equal(f.calls.length, 1, 'stale dispatch did not add a connector invocation');
  const reopened = f.reopen();
  assert.equal((await reopened.resultGate.authorize(f.host, [f.binding(initialResult.result, initialCall)], ['ordinary'], f.signal)).state, 'refused', JSON.stringify(f.store.transaction(tx => tx.get("SELECT state, json_extract(result_json, '$.sourceDispatchRefs') AS refs FROM tool_calls WHERE execution_id=?", [initialCall.executionId]))));
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
  const staleCall = f.intent('stale-policy-read'); f.owner.journal.intent(staleCall);
  f.owner.applyConnection(policy({ generation: 2, sourcePolicy: { ...policy().sourcePolicy, revision: 2 } }));
  assert.equal((await f.owner.resultGate.authorize(f.host, [], ['ordinary'], f.signal)).state, 'allowed');
  await assert.rejects(f.execute(staleCall), /task_source_policy_denied/);
});

test('unbound run still needs live authority, including initial request', async t => {
  const f = await fixture(t, { bindings: [] }); f.setLive(null); let requests = 0;
  const result = await f.run({ generate: async () => { requests++; return modelResult(); } });
  assert.equal(result.status, 'denied'); assert.equal(requests, 0);
});

test('SOURCE DEFECT task read delivery: revoke during authority await refuses the captured result', async t => {
  const f = await fixture(t); const original = f.getLive();
  f.owner.journal.intent(f.intent()); const completed = await f.execute();
  assert.equal(completed.status, 'completed'); if (completed.status !== 'completed') throw Error('initial read failed');
  let resolve!: (value: LiveAuthority) => void;
  f.setLookup(() => new Promise(r => { resolve = r; }));
  const gate = f.owner.resultGate.authorize(f.host, [f.binding(completed.result)], ['ordinary'], f.signal);
  f.owner.applyConnection(policy({ generation: 2, enabled: false })); resolve(original);
  assert.equal((await gate).state, 'refused'); assert.equal(f.calls.length, 1, 'completed result is withheld after revoke');
});

test('unrelated connection revocation does not poison empty continuation; its own intent is denied', async t => {
  const f = await fixture(t);
  const second = policy({ connectionId: 'second', endpoint: { ...policy().endpoint, id: 'second-endpoint', account: 'second', resource: 'second' } });
  f.registry.register({ id: 'second-endpoint', url: policyUrl(second.endpoint), account: 'second', resource: 'second' });
  f.owner.applyConnection(second);
  const acceptance = { ...f.acceptance, runId: 'two', connectionIds: ['lux', 'second'] };
  const accepted = f.store.transaction(tx => f.owner.snapshotRun(tx, acceptance));
  f.setLive({ ...acceptance, acceptedRunHash: accepted.sha256 });
  f.owner.applyConnection({ ...second, generation: 2, enabled: false });
  assert.equal((await f.owner.resultGate.authorize({ ...f.host, runId: 'two' }, [], ['ordinary'], f.signal)).state, 'allowed');
  assert.throws(() => f.owner.journal.intent({ ...f.intent(), runId: 'two', accountId: 'second', resourceId: 'second' }), /intent_policy_denied/);
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

test('task search/read strict arguments keep requested ids distinct from verified provenance', async t => {
  const f = await fixture(t);
  const search = f.definitions().find(tool => tool.name === 'search_knowledge')!;
  assert.equal(search.parameters['additionalProperties'], false);
  assert.equal(search.validate({ query: 'x', limit: 4 }), false);
  assert.equal(search.validate({ query: 'x', account: 'foreign' }), false);
  assert.equal(search.validate({ query: 'x' }), true);
  const read = f.definitions().find(tool => tool.name === 'read_knowledge')!;
  assert.equal(read.validate({ ids: [13, 7] }), false, 'a task read opens one typed id, not a retired native batch schema');
  assert.equal(read.validate({ id: '13', cursor: null, account: 'foreign' }), false);
  for (const [index, id] of [13, 7].entries()) {
    const args = { id: String(id), cursor: null };
    const call = { ...f.intent(`run:read:${index}`, 'read_knowledge', args), callId: `read-${index}` };
    f.owner.journal.intent(call);
    const outcome = await read.execute(args, { ...call, signal: f.signal });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(f.calls[index]!.arguments, { ids: [id], include_links: false });
    if (outcome.status !== 'completed') throw Error('typed read did not complete');
    const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result, call)], ['ordinary'], f.signal);
    assert.equal(gate.state, 'allowed'); if (gate.state !== 'allowed') throw Error('typed read delivery refused');
    const value = gate.results[0]!.response;
    assert.notEqual(value['requestedIdsVerified'], true, 'the requested id is never evidence the source verified its identity');
    assert.equal(typeof value['coverage'], 'string', 'the task result states its bounded coverage');
    assert.equal(JSON.stringify(value).includes('private:synthetic-reference'), false);
  }
});

for (const bad of [null, 'absent'] as const) test(`unknown source policy ${bad} is not an executable connection approval`, async t => {
  const p = policy(); p.sourcePolicy.unknownClass = null;
  if (bad === 'absent') delete (p.sourcePolicy as Partial<typeof p.sourcePolicy>).unknownClass;
  const dir = mkdtempSync(join(tmpdir(), 'didi-owner-test-')); const store = new Store(dir, toolsMigrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createToolsOwner({ store, ownerId: 'owner', registry: new McpRegistry(), port: {} as McpPort, lookupAuthority: async () => null });
  assert.throws(() => owner.applyConnection(p));
  assert.equal(store.transaction(tx => tx.all('SELECT * FROM tool_connections')).length, 0);
});

for (const [label, result, memoryBytes] of [
  ['empty-valid', { content: [] }, 10000], ['unsupported', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, 10000],
  ['oversize', { content: [{ type: 'text', text: 'x'.repeat(5000) }] }, 10000], ['capacity', { content: [{ type: 'text', text: 'nonempty' }] }, 1],
] as const) test(`honest bounded Lux ${label} outcome`, async t => {
  const f = await fixture(t, { result, memoryBytes }); f.owner.journal.intent(f.intent());
  const outcome = await f.execute();
  assert.equal(outcome.status, 'completed', 'the task envelope completed, not necessarily the connector action');
  const state = f.store.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', ['run:1:0']))?.state;
  assert.equal(state, label === 'empty-valid' ? 'completed' : 'failed', 'failed source reads must remain failed durable calls');
  const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result)], ['ordinary'], f.signal);
  if (label === 'empty-valid') {
    assert.equal(gate.state, 'allowed'); if (gate.state === 'allowed') assert.equal(gate.results[0]!.response['text'], '');
  } else {
    assert.equal(gate.state, 'allowed', 'the host-authored failure repair is safe to deliver');
    if (gate.state === 'allowed') {
      assert.equal(gate.results[0]!.response['status'], 'failed');
      assert.equal(typeof gate.results[0]!.response['cause'], 'string');
      assert.equal(typeof gate.results[0]!.response['next'], 'string');
      assert.ok(JSON.stringify(gate.results[0]!.response).length < 1_000, 'unbounded source bytes are not delivered as a repair');
    }
  }
});

test('cancelled task reads never dispatch early or accept a late completion', async t => {
  const f = await fixture(t); f.owner.journal.intent(f.intent());
  const before = new AbortController(); before.abort();
  assert.equal((await f.execute(f.intent(), { query: 'synthetic' }, before.signal)).status, 'completed');
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', [f.intent().executionId]))?.state, 'failed'); assert.equal(f.calls.length, 0);
  // Fresh independent execution identity; an aborted committed intent is never rekeyed automatically.
  const call = { ...f.intent('run:1:1'), callId: 'second' }; f.owner.journal.intent(call);
  const after = new AbortController(); f.setDispatch(() => after.abort());
  assert.equal((await f.execute(call, { query: 'synthetic' }, after.signal)).status, 'completed');
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', [call.executionId]))?.state, 'failed');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.signal.aborted, true);
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

test('SOURCE DEFECT task identity: a captured declaration rejects a superseded task before reading', async t => {
  const f = await fixture(t);
  const stale = f.definitions().find(tool => tool.name === 'search_knowledge')!;
  const call = f.intent(); f.owner.journal.intent(call);
  f.taskRuntime().begin('A different finalized synthetic task.', 2);
  const outcome = await stale.execute({ query: 'synthetic' }, { ...call, signal: f.signal });
  assert.equal(outcome.status, 'completed', 'the task boundary returns its durable failure repair');
  assert.equal(f.calls.length, 0, 'superseded task identity must never reach a connector');
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', [call.executionId]))?.state, 'failed');
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
test('SOURCE DEFECT task read delivery: restore then revoke and restart keep old results gated', async t => {
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

// Added for MCP-STDIO-R2: the endpoint binding is a per-arm union. HTTP stays
// byte-for-byte canonical (absent transport, credentialRef string|null);
// stdio carries transport=stdio, absolute command, ordered args, minimal env,
// credentialRef=null and no url.
test('endpoint union: stdio arm validates; HTTP nullability and cross-arm rejection are enforced', () => {
  const http = policy({ endpoint: { id: 'lux', url: 'https://example.invalid/mcp', account: 'a', resource: 'r', credentialRef: null } });
  assert.doesNotThrow(() => validatePolicy(http));
  const stdioEndpoint = { id: 'lux', transport: 'stdio', command: '/bin/echo', args: ['a', 'b'], env: { HOME: '/tmp/x', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'a', resource: 'r', credentialRef: null } as unknown as ConnectionPolicy['endpoint'];
  const asPolicy = (endpoint: unknown): ConnectionPolicy => ({ ...policy(), endpoint } as unknown as ConnectionPolicy);
  assert.doesNotThrow(() => validatePolicy(asPolicy(stdioEndpoint)), 'stdio arm must validate');
  // Strict stdio credentialRef: a non-null reference is a cross-arm value.
  assert.throws(() => validatePolicy(asPolicy({ ...stdioEndpoint, credentialRef: 'token-ref' })), /invalid/);
  // Cross-arm fields are refused on either arm.
  assert.throws(() => validatePolicy(asPolicy({ ...stdioEndpoint, url: 'https://example.invalid/mcp' })));
  assert.throws(() => validatePolicy(asPolicy({ ...http.endpoint, command: '/bin/echo', args: [] })));
  // Unknown transport and a non-absolute command are refused.
  assert.throws(() => validatePolicy(asPolicy({ ...http.endpoint, transport: 'sse' })));
  assert.throws(() => validatePolicy(asPolicy({ ...stdioEndpoint, command: 'echo' })));
});

for (const legacyRoute of ['endpoint', 'ambiguous-model-route']) test(`migration does not turn legacy ${legacyRoute} into route approval`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-legacy-policy-'));
  const legacy = policy(); delete legacy.bindingMode; legacy.route.identity = legacyRoute;
  const bytes = canonicalJSON(legacy); const hash = sha256(bytes);
  const oldStore = new Store(dir, toolsMigrations.filter(m => m.version === 1));
  oldStore.transaction(tx => tx.run('INSERT INTO tool_connections VALUES (?,?,?,?,?,?,?)', ['owner', 'lux', 'endpoint', 1, 1, bytes, hash])); oldStore.close();
  const store = new Store(dir, toolsMigrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createToolsOwner({ store, ownerId: 'owner', registry: new McpRegistry(), port: {} as McpPort, lookupAuthority: async () => null });
  const acceptance: RunAcceptance = { ownerId: 'owner', actorId: 'actor', runId: 'legacy-run', authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: legacyRoute, provider: 'gemini', modelId: 'synthetic', allowedClasses: ['private'] }, allowedClasses: ['private'], connectionIds: ['lux'] };
  store.transaction(tx => owner.snapshotRun(tx, acceptance));
  assert.equal(owner.taskVisible(acceptance.runId, 'search_knowledge'), false, 'legacy route approval never becomes an exposed task read');
  assert.throws(() => owner.projectConnection('lux'), /connection_not_executable/);
  assert.equal((await owner.restoreConnection('lux', () => {})).state, 'refused');
  assert.equal(store.transaction(tx => tx.get('SELECT policy_sha256 FROM tool_connections'))!.policy_sha256, hash);
  assert.equal(store.transaction(tx => tx.all('SELECT * FROM tool_connection_semantics')).length, 0);
});

for (const code of ['timeout', 'cancelled', 'child_exited', 'pipe_closed', 'sdk_protocol_rejected', 'invalid_result', 'connector_error', 'handler_outcome'] as const) test(`thrown ${code} survives owner journal and tool response`, async t => {
  const f = await fixture(t); const seen: ModelRequest[] = [];
  const model: ModelPort = { generate: async req => { seen.push(structuredClone(req)); return seen.length === 1 ? modelResult('search_knowledge') : modelResult(); } };
  const registry = f.definitions().map(tool => ({ ...tool, async execute() {
    if (code === 'handler_outcome') throw Error('synthetic unclassified');
    throw Object.assign(Error('synthetic failure, not a response payload'), { code });
  } }));
  const outcome = await runTools({ model, request, registry, host: f.host, authority: { isCurrent: async () => true }, maxSteps: 3,
    control: { signal: f.signal, deadlineMs: Date.now() + 5000 }, journal: f.owner.journal, resultGate: f.owner.resultGate });
  assert.equal(outcome.status, 'complete');
  const response = seen[1]!.contents.at(-1)!.parts[0]!.functionResponse!.response;
  assert.equal(response['reason'], code);
  const row = f.store.transaction(tx => tx.get('SELECT state, result_json FROM tool_calls WHERE execution_id=?', ['run:1:0']));
  assert.equal(row?.state, 'failed');
  assert.equal(JSON.parse(String(row?.result_json)).response.reason, code);
});

test('SOURCE DEFECT task failure code: a thrown MCP transport failure is logged without exception payload and reports the closed stage', async t => {
  const events: ToolFailureEvent[] = []; const f = await fixture(t, { log: event => { if (event.event === 'tool_failure') events.push(event); } });
  t.mock.method(f.port, 'call', async () => { throw Object.assign(Error('synthetic-private-payload must not reach logging'), { code: 'timeout' }); });
  const seen: ModelRequest[] = [];
  const outcome = await f.run({ generate: async request => { seen.push(request); return seen.length === 1 ? modelResult('search_knowledge') : modelResult(); } });
  // ROUTE-R2: an unclassified dispatched failure takes the closed stage from the adapter's own
  // classifier (failureStage, 994bb035d #211, documented in docs/mcp-adapter.md, pinned by
  // server/test/mcp.test.ts) and dispatchedFailureCode (e27d3870). The exception's own code is never a
  // log token, so the `timeout` this mock attaches stays inert and the stage is the protocol rejection.
  assert.equal(outcome.status, 'complete');
  assert.equal(seen[1]!.contents.at(-1)!.parts[0]!.functionResponse!.response['reason'], 'sdk_protocol_rejected');
  assert.deepEqual(events, [{ event: 'tool_failure', code: 'sdk_protocol_rejected', tool: 'search_knowledge', connector: 'lux-knowledge', errorClass: 'Error', messageHead: 'sdk_protocol_rejected' }]);
  assert(!JSON.stringify(events).includes('synthetic-private-payload'));
});
test('SOURCE DEFECT task failure code: an oversize unknown result stays invalid_result, never generic transport', async t => {
  const events: ToolFailureEvent[] = []; const f = await fixture(t, { result: { content: [{ type: 'text', text: 'X'.repeat(14_000) }] }, log: event => { if (event.event === 'tool_failure') events.push(event); } });
  const seen: ModelRequest[] = [];
  const outcome = await f.run({ generate: async request => { seen.push(request); return seen.length === 1 ? modelResult('search_knowledge') : modelResult(); } });
  assert.equal(outcome.status, 'complete');
  assert.equal(seen[1]!.contents.at(-1)!.parts[0]!.functionResponse!.response['reason'], 'invalid_result');
  assert.deepEqual(events, [{ event: 'tool_failure', code: 'invalid_result', tool: 'search_knowledge', connector: 'lux-knowledge', errorClass: 'Error', messageHead: 'invalid_result' }]);
});
test('SOURCE DEFECT task failure code: a connector-rejected decoded content shape is logged and returned with invalid_result', async t => {
  const events: ToolFailureEvent[] = []; const f = await fixture(t, { log: event => { if (event.event === 'tool_failure') events.push(event); }, result: { content: [{ type: 'text', text: 'synthetic', annotations: { priority: 0.5 } }] } });
  const seen: ModelRequest[] = [];
  const outcome = await f.run({ generate: async req => { seen.push(structuredClone(req)); return seen.length === 1 ? modelResult('search_knowledge') : modelResult(); } });
  assert.equal(outcome.status, 'complete');
  assert.equal(seen[1]!.contents.at(-1)!.parts[0]!.functionResponse!.response['reason'], 'invalid_result');
  assert.deepEqual(events, [{ event: 'tool_failure', code: 'invalid_result', tool: 'search_knowledge', connector: 'lux-knowledge', errorClass: 'Error', messageHead: 'invalid_result' }]);
});

test('W4-R5/F6: a batch dispatches across and within endpoints concurrently and keeps batch order', async () => {
  const ref = { id: 'ref', sha256: 'a'.repeat(64) };
  let live = 0; let peak = 0; const order: string[] = [];
  const make = (name: string, endpointId: string) => ({
    name, description: '', effect: 'read' as const, accountId: 'acct', resourceId: 'res', endpointId,
    validate: () => true, parameters: {},
    async execute() {
      live += 1; peak = Math.max(peak, live); order.push(`start:${name}`);
      await new Promise(resolve => setTimeout(resolve, 300));
      order.push(`end:${name}`); live -= 1;
      return { status: 'completed' as const, result: structuredClone(ref) };
    },
  });
  const journal: ToolCallJournal = { intent: () => 'fresh', refuse: () => ref, fail: () => ref };
  const owner = { journal, resultGate: {} as unknown as ToolResultGate };
  const grants = ['a1', 'a2', 'b1'].map(tool => ({ tool, effect: 'read' as const, accountId: 'acct', resourceId: 'res' }));
  const ctxFor = (names: string[]) => ({
    registry: names.map(name => make(name, name.startsWith('a') ? 'ep-a' : 'ep-b')),
    host: { runId: 'run', actorId: 'actor', authorityEpoch: 'epoch', revision: 1, grants },
    control: { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 },
    authority: { isCurrent: async () => true }, seenIds: new Set<string>(), step: 0, contentIndex: 0,
  });
  const call = (id: string, name: string): { id: string; name: string; args: JsonObject } => ({ id, name, args: {} });
  const ids = (batch: { responses: readonly unknown[] }) => batch.responses.map(r => (r as { functionResponse: { id: string } }).functionResponse.id);

  live = 0; peak = 0; order.length = 0;
  const t0 = Date.now();
  const across = await runToolCalls(owner, [call('1', 'a1'), call('2', 'b1')], ctxFor(['a1', 'b1']) as never);
  const elapsed = Date.now() - t0;
  assert.equal(across.error, undefined);
  assert.deepEqual(ids(across), ['1', '2'], 'results keep their original batch order');
  assert.equal(peak, 2, 'two different endpoints must dispatch concurrently');
  assert.ok(elapsed < 550, `two 300 ms calls on different endpoints must finish near 300 ms, took ${elapsed}`);

  live = 0; peak = 0; order.length = 0;
  const same = await runToolCalls(owner, [call('1', 'a1'), call('2', 'a2')], ctxFor(['a1', 'a2']) as never);
  assert.equal(same.error, undefined);
  assert.deepEqual(ids(same), ['1', '2'], 'results keep their original batch order');
  assert.equal(order.filter(entry => entry.startsWith('start')).length, 2, 'both same-endpoint calls dispatch');
  assert.equal(peak, 2, 'one endpoint dispatches concurrently, never refused as busy');
});

// K1: get_insight must open entries for a reasonable id shape instead of refusing at the boundary.
test('K1: get_insight argument normalization accepts loose id shapes at the boundary', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 12, maxGetIds: 3 } } as unknown as ConnectionPolicy;
  const get = Object.values(CONNECTOR_DESCRIPTORS).flatMap(descriptor => descriptor.declarations(policy)).find(declaration => declaration.name === 'get_insight')!;
  assert.equal(get.validate({ ids: ['89820', 89933] }), true, 'integer-valued numeric strings are accepted');
  assert.equal(get.validate({ ids: 89820 }), true, 'a single number under ids is accepted');
  assert.equal(get.validate({ id: '89820' }), true, 'the id key is accepted');
  assert.equal(get.validate(89820), true, 'a bare id is accepted');
  assert.deepEqual(get.normalize!({ ids: ['89820', 89933] }), { args: { ids: [89820, 89933] } });
  assert.deepEqual(get.normalize!({ ids: [89820, 89820] }), { args: { ids: [89820] } }, 'duplicates are deduped');
  assert.equal(get.validate({ ids: ['abc'] }), false, 'a non-numeric id is refused');
  assert.equal(get.validate({ ids: [] }), false, 'an empty id list is refused');
  assert.equal(get.validate({ ids: [7, 9], include_links: false }), true, 'a declared include_links key is accepted');
  assert.equal(get.validate({ ids: [7, 9], project: 'p' }), true, 'an unknown read key is dropped, not refused');
  assert.deepEqual(get.normalize!({ ids: [7, 9], include_links: true }), { args: { ids: [7, 9], include_links: true } }, 'include_links is passed through');
  const capped = normalizeGetInsightArgs({ ids: [1, 2, 3, 4, 5] }, 3)!;
  assert.deepEqual(capped.args, { ids: [1, 2, 3] }, 'over-budget ids are truncated, not refused');
  assert.match(capped.notice!, /first 3 of 5/);
});

function errorTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'get_insight', description: 'Read', effect: 'read', accountId: 'acct', resourceId: 'res',
    guidance: 'Needs ids as a list of entry ids from the knowledge search results, like {"ids": [89820, 89933]}.',
    parameters: { type: 'object', properties: { ids: { type: 'array' } }, required: ['ids'] },
    validate: () => false, execute: async () => ({ status: 'failed' as const }),
    ...overrides,
  };
}
function errorContext(tool: ToolDefinition, seenIds = new Set<string>()) {
  return {
    registry: [tool],
    host: { runId: 'run', actorId: 'actor', authorityEpoch: 'epoch', revision: 1, grants: [{ tool: tool.name, effect: 'read' as const, accountId: 'acct', resourceId: 'res' }] },
    control: { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 },
    authority: { isCurrent: async () => true }, seenIds, step: 0, contentIndex: 0,
  };
}
const refuses = (reasons: string[]): ToolCallJournal => ({ intent: () => 'fresh', refuse: (_call, reason) => { reasons.push(reason); return { id: 'ref', sha256: 'a'.repeat(64) }; }, fail: () => ({ id: 'ref', sha256: 'a'.repeat(64) }) });

test('K1: an invalid tool call returns actionable guidance and an identical repeat closes its branch', async () => {
  const reasons: string[] = [];
  const owner = { journal: refuses(reasons), resultGate: {} as unknown as ToolResultGate };
  const tool = errorTool(); const seenIds = new Set<string>();
  const call = (id: string, args: JsonObject) => ({ id, name: 'get_insight', args });
  const ctx = () => errorContext(tool, seenIds);
  const first = await runToolCalls(owner, [call('1', { ids: ['top-secret'] })], ctx() as never);
  assert.equal(first.tools[0]!.status, 'refused');
  assert.match(first.tools[0]!.reason, /Invalid arguments for get_insight/);
  assert.match(first.tools[0]!.reason, /ids/);
  assert.doesNotMatch(first.tools[0]!.reason, /top-secret/, 'never echoes the bad value');
  assert.doesNotMatch(first.tools[0]!.reason, /Stop retrying/);
  await runToolCalls(owner, [call('2', { ids: ['top-secret'] })], ctx() as never);
  const third = await runToolCalls(owner, [call('3', { ids: ['top-secret'] })], ctx() as never);
  // C-ARGS: the identical call is answered from the cached rejection, so its branch closes instead of
  // being validated again, and the fix it already carries is still the one it is answered with.
  assert.match(third.tools[0]!.reason, /Invalid arguments for get_insight/);
  assert.match(third.tools[0]!.reason, /closed until the owner adds facts/);
  assert.doesNotMatch(third.tools[0]!.reason, /Stop retrying/);
  assert.equal(reasons.length, 3, 'each refusal is journaled, never silently dropped');
});

test('K1: a declared tool without tailored guidance states its expected shape', async () => {
  const reasons: string[] = [];
  const owner = { journal: refuses(reasons), resultGate: {} as unknown as ToolResultGate };
  const tool: ToolDefinition = { name: 'search_knowledge', description: 'Search', effect: 'read', accountId: 'acct', resourceId: 'res',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'] },
    validate: () => false, execute: async () => ({ status: 'failed' as const }) };
  const batch = await runToolCalls(owner, [{ id: '1', name: 'search_knowledge', args: { query: '' } }], errorContext(tool) as never);
  // AL-R1: the refusal names the declared key it is about before it states the shape.
  assert.match(batch.tools[0]!.reason, /Invalid arguments for search_knowledge\. Rejected argument: limit:required\. Expected an object with query \(string\), limit \(integer\)\./);
});

test('K1: an invalid tool call logs a metadata-only argument diagnostic', async () => {
  const owner = { journal: refuses([]), resultGate: {} as unknown as ToolResultGate };
  const events: { event?: string }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as { event?: string }); } });
  try {
    await runToolCalls(owner, [{ id: '1', name: 'get_insight', args: { ids: ['hunter2'], limit: 3 } }], errorContext(errorTool()) as never);
  } finally { detach(); }
  const event = events.find(line => line.event === 'tool_arguments_rejected') as { tool: string; violations: string[]; reason: string };
  assert.equal(event.tool, 'get_insight');
  // AL-R1: a tool whose refusal is a plain validator still names the declared key it is about, so the
  // retry has somewhere to land, and the line never carries a value.
  assert.deepEqual(event.violations, ['ids:refused']);
  assert.equal(event.reason, 'schema_validation_failed');
  assert.doesNotMatch(JSON.stringify(event), /hunter2/);
});

// C-ARGS: a refused write names the rule that refused it and never a value, a number, a switch or a text.
test('C-ARGS a refused write names no value of his in the argument log', async () => {
  const owner = { journal: refuses([]), resultGate: {} as unknown as ToolResultGate };
  const events: { event?: string }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as { event?: string }); } });
  const write = errorTool({ name: 'create_event', effect: 'write', validate: () => false });
  try {
    await runToolCalls(owner, [{ id: '1', name: 'create_event', args: { summary: 'cardio with Zara', duration_minutes: 1.5, all_day: true } }], errorContext(write) as never);
  } finally { detach(); }
  const event = events.find(line => line.event === 'tool_arguments_rejected') as { tool: string; violations: string[] };
  assert.equal(event.tool, 'create_event');
  // AL-R1: a refusal names the declared key it is about, here the required one that never arrived.
  assert.deepEqual(event.violations, ['ids:required'], 'a refusal names the field it is about');
  const logged = JSON.stringify(event);
  for (const value of ['cardio with Zara', '1.5', 'true']) {
    assert.equal(logged.includes(value), false, `no value of his reaches the log: ${value}`);
  }
});




// #795: the model asked how long the block should be, so his one-word answer arrives as its own owner
// final with no scheduling verb in it. The ask's own grant is what authorizes the one write, once.


// P-R8: the executor itself must complete the dropped-recurrence ask. A throw inside it becomes the
// opaque handler_outcome the model sees, so this test names the throw before the production path does.


// #796: a one-time alarm retried without the recurrence the model invented is the alarm he asked for.








for (const effect of ['read', 'write'] as const) {
  test(`a handler that throws outside its own catch writes one closed tool_handler_error line: ${effect}`, async t => {
    const f = await fixture(t);
    const lines: Record<string, unknown>[] = [];
    const detach = attachHostLogSink({ event: raw => { lines.push(raw as Record<string, unknown>); } });
    t.after(detach);
    const original = f.definitions().find(tool => tool.name === 'search_knowledge')!;
    const throwing = { ...original, effect, execute: async () => { throw new TypeError('synthetic handler failure'); } };
    const batch = await runToolCalls(f.owner, [{ id: 'call-handler', name: throwing.name, args: { query: 'synthetic' } }], {
      registry: [throwing], host: { ...f.host, grants: [{ tool: throwing.name, effect, accountId: TASK_ACCOUNT, resourceId: TASK_RESOURCE }] },
      authority: { isCurrent: async () => true }, control: { signal: f.signal, deadlineMs: Date.now() + 5000 },
      seenIds: new Set(), step: 0, contentIndex: 0, baseClasses: ['ordinary'],
    });
    assert.equal(batch.tools[0]?.status, effect === 'write' ? 'unknown' : 'failed');
    assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls'))?.state, effect === 'write' ? 'unknown' : 'failed');
    const logged = lines.filter(line => line['event'] === 'tool_handler_error');
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0], { event: 'tool_handler_error', tool: throwing.name, class: 'TypeError', reason: 'handler_outcome' });
    assert.equal(JSON.stringify(logged).includes('synthetic handler failure'), false, 'the exception message is not diagnostic payload');
  });
}

// Task document continuations are typed id plus character offset, not the
// retired owner-only read_body capability tokens.
async function pagedTaskFixture(t: TestContext, resultOf: () => unknown) {
  const p = policy(); p.bounds = { ...p.bounds, maxEntityBytes: 200_000, maxResultBytes: 200_000 };
  return fixture(t, { policy: p, memoryBytes: 1_000_000, responseBytes: 200_000, resultOf });
}
async function readTaskPage(f: Awaited<ReturnType<typeof fixture>>, id: string, cursor: string | null, executionId: string) {
  const args = { id, cursor }, call = { ...f.intent(executionId, 'read_knowledge', args), callId: executionId };
  f.owner.journal.intent(call);
  const outcome = await f.definitions().find(tool => tool.name === 'read_knowledge')!.execute(args, { ...call, signal: f.signal });
  assert.equal(outcome.status, 'completed'); if (outcome.status !== 'completed') throw Error('page execution failed');
  const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result, call)], ['ordinary'], f.signal);
  assert.equal(gate.state, 'allowed'); if (gate.state !== 'allowed') throw Error('page delivery refused');
  return gate.results[0]!.response;
}
test('task document pages reconstruct the complete source body and reject invalid cursors', async t => {
  const body = 'A'.repeat(25_000) + 'synthetic-tail';
  const f = await pagedTaskFixture(t, () => ({ content: [{ type: 'text', text: JSON.stringify({ id: 7, content: body }) }] }));
  const source = await f.reader.get({ ids: [7], include_links: false }, f.signal);
  assert.equal(source.state, 'completed', 'the same configured reader can fetch the source before task projection');
  const first = await readTaskPage(f, '7', null, 'page-first');
  assert.equal(first.status, 'partial', JSON.stringify({ status: first.status, cause: first.cause, next: first.next, repair: first.repair })); assert.ok(typeof first.next_cursor === 'string');
  const next = await readTaskPage(f, '7', first.next_cursor, 'page-next');
  assert.equal(String(first.text) + String(next.text), `### insight 7 [id 7]\n${body}`, 'whole-body paging neither truncates nor duplicates content');
  assert.equal(next.next_cursor, null);
  const invalid = await readTaskPage(f, '7', 'not-a-cursor', 'page-invalid');
  assert.equal(invalid.status, 'failed', 'malformed offsets cannot silently restart or choose another parent');
});
test('SOURCE DEFECT task document pages: a continuation cannot silently splice changed source bytes', async t => {
  const original = 'A'.repeat(25_000) + 'original-tail'; let current = original;
  const f = await pagedTaskFixture(t, () => ({ content: [{ type: 'text', text: JSON.stringify({ id: 7, content: current }) }] }));
  const first = await readTaskPage(f, '7', null, 'version-first'); assert.equal(first.status, 'partial', JSON.stringify({ status: first.status, cause: first.cause, next: first.next, repair: first.repair })); assert.ok(typeof first.next_cursor === 'string');
  current = 'B'.repeat(25_000) + 'changed-tail';
  const next = await readTaskPage(f, '7', first.next_cursor, 'version-next');
  if (next.status !== 'failed') assert.equal(String(first.text) + String(next.text), `### insight 7 [id 7]\n${original}`, 'continue the captured version or explicitly refuse, never splice different documents');
  else assert.ok(next.repair, 'a version change refusal tells the worker to restart');
});
test('SOURCE DEFECT task read delivery: a captured document page is refused after its source is revoked', async t => {
  const f = await pagedTaskFixture(t, () => ({ content: [{ type: 'text', text: JSON.stringify({ id: 7, content: 'A'.repeat(25_000) }) }] }));
  const args = { id: '7', cursor: null }, call = f.intent('pending-page', 'read_knowledge', args); f.owner.journal.intent(call);
  const outcome = await f.definitions().find(tool => tool.name === 'read_knowledge')!.execute(args, { ...call, signal: f.signal });
  assert.equal(outcome.status, 'completed'); if (outcome.status !== 'completed') throw Error('page read failed');
  f.owner.applyConnection(policy({ generation: 2, enabled: false }));
  const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result, call)], ['ordinary'], f.signal);
  assert.equal(gate.state, 'refused', 'captured private document pages cannot survive explicit source revocation');
});

test('C-STEADY104: a rolled-back read completion still permits a failed terminal', async t => {
  const f = await fixture(t);
  const call = f.intent();
  f.owner.journal.intent(call);
  f.store.transaction(tx => tx.run("CREATE TRIGGER inject_completion_failure BEFORE UPDATE ON tool_calls WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'synthetic_completion_failure'); END"));
  assert.throws(() => f.owner.complete(call, { text: 'synthetic completion' }, ['private']), /synthetic_completion_failure/);
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls'))?.state, 'intent', 'failed completion transaction rolls back');
  f.store.transaction(tx => tx.run('DROP TRIGGER inject_completion_failure'));
  f.owner.journal.fail(call, 'failed', 'handler_outcome');
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM tool_calls'))?.state, 'failed');
});

// Raw mattermost_chat model tools were retired. Task queries preserve explicit
// channel operators and strict typed args; connector-level roster resolution is
// exercised through the real host composition rather than fake live definitions.
async function chatTaskFixture(t: TestContext, posts: Record<string, unknown>) {
  const { MATTERMOST_TOOLS } = await import('../connectors/mattermost.js');
  const sourceTools = MATTERMOST_TOOLS.map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
  return fixture(t, { policy: policy({ connector: 'mattermost', toolNames: sourceTools.map(tool => tool.name), schemaDigest: canonicalToolDigest(sourceTools) }), sourceTools,
    resultOf: () => ({ content: [{ type: 'text', text: JSON.stringify({ posts, order: Object.keys(posts) }) }] }) });
}
for (const channel of ['eng', 'synthetic-missing']) test(`C-STEADY104: typed chat query ${channel} closes its task journal honestly`, async t => {
  const f = await chatTaskFixture(t, channel === 'eng' ? { synthetic: { id: 'synthetic', message: 'Synthetic channel result.', channel_id: 'eng' } } : {});
  const tool = f.allDefinitions().find(tool => tool.name === 'search_chat')!;
  const args = { query: `in:${channel}` };
  const call = f.intent('run:chat:0', tool.name, args); f.owner.journal.intent(call);
  const outcome = await tool.execute(args, { ...call, signal: f.signal });
  assert.equal(outcome.status, 'completed');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.name, 'mattermost_search');
  assert.equal((f.calls[0]!.arguments as Record<string, unknown>).query, args.query, 'no local prefix silently changes the requested channel');
  const row = f.store.transaction(tx => tx.get('SELECT state,result_json FROM tool_calls WHERE execution_id=?', [call.executionId]))!;
  assert.equal(row.state, 'completed');
  const result = JSON.parse(String(row.result_json)).response;
  assert.ok([channel === 'eng' ? 'ok' : 'empty', 'partial'].includes(result.status), 'a structured answer or an explicitly incomplete source is honest');
  if (result.status === 'partial') { assert.equal(typeof result.text, 'string'); assert.ok(result.repair); }
  assert.ok(result.coverage, 'even an empty result carries bounded source coverage');
});
test('C-ARGS: typed chat queries reject native filler fields and wrong types before dispatch', async t => {
  const f = await chatTaskFixture(t, {});
  const tool = f.allDefinitions().find(tool => tool.name === 'search_chat')!;
  for (const [index, args] of [{ query: 7 }, { query: 'from:synthetic', intent: 'person', person: 'Synthetic', people: [] }].entries()) {
    assert.equal(tool.validate(args), false);
    const call = { ...f.intent(`run:invalid-chat:${index}`, tool.name, args), callId: `invalid-chat-${index}` }; f.owner.journal.intent(call);
    const result = await tool.execute(args, { ...call, signal: f.signal });
    assert.equal(result.status, 'completed');
    assert.equal(f.calls.length, 0, 'invalid task arguments cannot reach a native reader');
  }
  assert.equal(tool.validate({ query: 'from:synthetic' }), true, 'the corrected task shape is accepted without native fillers');
});
test('SOURCE DEFECT task chat wiring: native search ids remain available to the worker', async t => {
  const f = await chatTaskFixture(t, { synthetic: { id: 'synthetic', message: 'Synthetic source message.', channel_id: 'eng' } });
  const tool = f.allDefinitions().find(tool => tool.name === 'search_chat')!;
  const args = { query: 'in:eng' }, call = f.intent('chat-native-id', tool.name, args); f.owner.journal.intent(call);
  const outcome = await tool.execute(args, { ...call, signal: f.signal });
  assert.equal(outcome.status, 'completed'); if (outcome.status !== 'completed') throw Error('chat read failed');
  const gate = await f.owner.resultGate.authorize(f.host, [f.binding(outcome.result, call)], ['ordinary'], f.signal);
  assert.equal(gate.state, 'allowed'); if (gate.state !== 'allowed') throw Error('chat delivery refused');
  const refs = gate.results[0]!.response['references'];
  assert.ok(Array.isArray(refs) && refs.some(ref => (ref as Record<string, unknown>).id === 'synthetic'), 'a real native post id must not disappear into unopenable display text');
});

// W1030/WT-R1: the write tools through the real tool call, with a synthetic compose port standing in
// for the host's connector families. No send, no invite, no second write on replay.



const liveTools = (f: Awaited<ReturnType<typeof fixture>>) => f.allDefinitions();
/** W1030: the write tools travel the production path, so a retry meets the journal, the gate and the receipt. */
type ExecutableCall = { callId: string; toolName: string; accountId: string; resourceId: string };
const liveExecute = async (f: Awaited<ReturnType<typeof fixture>>, call: ExecutableCall, args: Record<string, unknown>, step = 1) => {
  const effect = liveTools(f).find(tool => tool.name === call.toolName)?.effect ?? 'write';
  const grant = { tool: call.toolName, effect, accountId: call.accountId, resourceId: call.resourceId };
  if (!f.host.grants.some(existing => existing.tool === grant.tool)) f.host.grants.push(grant);
  const batch = await runToolCalls({ journal: f.owner.journal, resultGate: f.owner.resultGate }, [{ id: call.callId, name: call.toolName, args: args as never }], {
    registry: liveTools(f), host: f.host, authority: { isCurrent: async () => true }, control: { signal: f.signal, deadlineMs: Date.now() + 5_000 },
    step, contentIndex: 0, seenIds: new Set<string>(), baseClasses: ['ordinary'], authorize: true,
  });
  const record = batch.tools[0]!;
  const result = batch.bindings[0]?.result;
  const stored = result === undefined ? undefined : f.store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE owner_id=? AND result_id=?', ['owner', result.id]));
  return { status: record.status, reason: record.reason, result_json: stored === undefined ? undefined : String(stored['result_json'] ?? '') };
};



















// #873 C-ALARM: every argument object below is built from the DECLARED schema as the live provider
// receives it after the adapter conversion, then driven through the production call path to a
// committed row. No provider call is made: the conversion and the handler are the whole surface.
const ALARM_CLOCK = Date.parse('2030-01-02T08:00:00Z');
const alarmClock = (): NonNullable<ToolsOwnerOptions['alarms']> => ({ now: () => ALARM_CLOCK, recheck: () => {}, health: () => ({ degraded: false, reasons: [] }) });

type DeclaredSchema = { type?: unknown; properties?: Record<string, DeclaredSchema>; items?: DeclaredSchema; required?: unknown; enum?: unknown; description?: unknown; anyOf?: unknown; pattern?: unknown; minLength?: unknown; maxLength?: unknown; minimum?: unknown };

/** Every key and value type the case sends is one the declaration states, so the model can produce it. */

/** One declared time shape, and the instant it must fire at on the fixed clock in the UTC host zone. */


/** A voice model fills every unused property: null, then an empty string, then leaves mode out. */











// AL-R1: the declaration is the whole contract the model can read, so every object it declares names
// its properties and a value built only from it is never refused as a schema failure.
/**
 * The schema the declaration states. The provider dialect collapses ARRAY, BOOLEAN and every enum to a
 * STRING and appends the original schema to the description, so the true type, choices and bounds reach
 * the model as that prose. Reading it back is what a model does with the same text.
 */
const declaredShape = (schema: DeclaredSchema): DeclaredSchema => {
  if (schema.properties !== undefined && String(schema.type).toUpperCase() === 'OBJECT') return schema; // The actual strict object, not its historical description, owns required/null fields.
  const description = typeof schema.description === 'string' ? schema.description : '';
  const at = description.lastIndexOf('Original schema: ');
  if (at < 0) return schema;
  try {
    const original = JSON.parse(description.slice(at + 'Original schema: '.length).trim()) as DeclaredSchema;
    return { ...original, description };
  } catch { return schema; }
};
/** The choices the declaration states: its own enum, or the one the appended original schema carries. */
const statedChoices = (schema: DeclaredSchema): unknown[] => {
  const shape = declaredShape(schema);
  return Array.isArray(shape.enum) && shape.enum.length > 0 ? shape.enum : [];
};
/**
 * The strings the declaration names, most specific first: an example it gives, then the shape it asks
 * for in its own words, then a bare word, and only the candidates its own bounds and pattern admit.
 */
const declaredStrings = (schema: DeclaredSchema): string[] => {
  const shape = declaredShape(schema);
  const text = typeof shape.description === 'string' ? shape.description : '';
  const pool: string[] = [];
  // The example the declaration gives in its own words, without the sentence's own punctuation.
  const example = /\blike ([A-Za-z0-9/_.~-]{2,40})/u.exec(text)?.[1]?.replace(/[.,;:]+$/u, '');
  if (example !== undefined && example.length >= 2) pool.push(example);
  if (/\bHH:MM\b/u.test(text)) pool.push('09:00');
  if (/\bYYYY-MM-DD\b/u.test(text)) pool.push('2030-01-05');
  if (/\bIANA\b|Europe\//u.test(text)) pool.push('Europe/Berlin');
  if (/\babsolute\b/iu.test(text)) pool.push('/synthetic');
  pool.push('synthetic topic', 'synthetic');
  const minLength = Number(shape.minLength ?? 1);
  const maxLength = Number(shape.maxLength ?? 1024);
  let pattern: RegExp | undefined;
  if (typeof shape.pattern === 'string') { try { pattern = new RegExp(shape.pattern, 'u'); } catch { pattern = undefined; } }
  const admitted = pool.filter(value => value.length >= minLength && value.length <= maxLength
    && (pattern === undefined || pattern.test(value)));
  return admitted.length > 0 ? admitted : ['synthetic'.slice(0, maxLength)];
};
const sampleOf = (schema: DeclaredSchema): unknown => {
  const shape = declaredShape(schema);
  const choices = statedChoices(shape);
  if (choices.length > 0) return choices[0];
  const branches = Array.isArray(shape.anyOf) ? shape.anyOf as DeclaredSchema[] : [];
  if (shape.type === undefined && branches.length) return sampleOf(branches.find(branch => branch.type !== 'null') ?? branches[0]!);
  const type = Array.isArray(shape.type) ? shape.type.find(value => String(value).toLowerCase() !== 'null') : shape.type;
  switch (String(type ?? '').toUpperCase()) {
    case 'STRING': return declaredStrings(shape)[0] ?? 'synthetic';
    case 'INTEGER': case 'NUMBER': return Math.max(1, Number(shape.minimum ?? 1));
    case 'BOOLEAN': return true;
    case 'ARRAY': return [sampleOf(shape.items ?? {})];
    case 'OBJECT': return declaredValues(shape)[0] ?? {};
    default: return declaredStrings(shape)[0] ?? 'synthetic';
  }
};
/** The keys the declaration requires: its own list, plus the first anyOf branch it states. */
const requiredOf = (schema: DeclaredSchema): string[] => {
  const shape = declaredShape(schema);
  const required = Array.isArray(shape.required) ? shape.required as string[] : [];
  const branches = Array.isArray(shape.anyOf) ? shape.anyOf as DeclaredSchema[] : [];
  const branch = branches[0] === undefined ? [] : (Array.isArray(branches[0]!.required) ? branches[0]!.required as string[] : []);
  return [...new Set([...required, ...branch])].filter(key => key in (shape.properties ?? {}));
};
/**
 * Every value the declaration alone describes, most complete first: all of its keys, then the keys it
 * requires, then one key, and a pair where it holds exclusive fields. A declaration that names no
 * required key is not met by one key alone, and one that holds exclusive fields is met by the pair.
 */
const declaredValues = (schema: DeclaredSchema): Record<string, unknown>[] => {
  const shape = declaredShape(schema);
  const properties = shape.properties ?? {};
  const required = requiredOf(shape);
  const build = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, sampleOf(properties[key] ?? {})]));
  const keys = Object.keys(properties);
  const candidates = [build(keys), build(required.length > 0 ? required : keys.slice(0, 1)), ...keys.map(key => build([key]))];
  // Strict task schemas require every property, using null for omitted optional
  // fields. Generate complete objects, not legacy sparse calls or stringified
  // nullable type arrays. No tool-specific payload is supplied by the test.
  const nullable = (field: DeclaredSchema): boolean => {
    const shape = declaredShape(field);
    return (Array.isArray(shape.type) && shape.type.some(value => String(value).toLowerCase() === 'null'))
      || (Array.isArray(shape.anyOf) && (shape.anyOf as DeclaredSchema[]).some(branch => branch.type === 'null'));
  };
  const optional = keys.filter(key => nullable(properties[key] ?? {}));
  const requiredKeys = keys.filter(key => !optional.includes(key));
  const complete = (chosen: readonly string[]) => Object.fromEntries(keys.map(key => [key, requiredKeys.includes(key) || chosen.includes(key) ? sampleOf(properties[key] ?? {}) : null]));
  if (optional.length) {
    candidates.push(complete([]), ...optional.map(key => complete([key])));
    for (let i = 0; i < optional.length; i++) for (let j = i + 1; j < optional.length; j++) candidates.push(complete([optional[i]!, optional[j]!]));
  }

  // A declaration may hold exclusive fields it cannot mark, so a pair of them is a value it also describes.
  if (keys.length <= 4) for (const a of keys) for (const b of keys) if (a < b) candidates.push(build([a, b]));
  const seen = new Set<string>();
  return candidates.filter(candidate => { const key = JSON.stringify(candidate); if (seen.has(key)) return false; seen.add(key); return true; });
};
/** Every object the declaration offers, so a property-less one is named rather than silently empty. */
const namelessObjects = (schema: DeclaredSchema, path: string, found: string[]): void => {
  // An empty map is a tool that takes no argument; a missing map is a shape the model must guess.
  if (String(schema.type ?? '').toUpperCase() === 'OBJECT' && schema.properties === undefined) found.push(path);
  for (const [key, child] of Object.entries(schema.properties ?? {})) namelessObjects(child, `${path}.${key}`, found);
  if (schema.items !== undefined) namelessObjects(schema.items, `${path}[]`, found);
};

/**
 * The one declared tool whose own rule refuses every value a declaration can describe, with the reason it
 * has none. AL-R2(c): a value the host issues and no declaration can describe stays here by name, with its
 * one-line reason, and the assertion stays exact so any new refusal fails this test.
 *
 * read_received_body cursor: the host mints the cursor. server/tools/index.ts:357 issues it only for
 * evidence it holds (`randomUUID()` when the lease is `remote-body`), and the tool's own validate at
 * server/tools/index.ts:1329-1331 admits an argument only when that exact cursor is in the bodyPages map
 * this run filled. A model that invented one is refused, and the declaration says so in its own words
 * ("using only bodyContinuation.cursor or nextCursor from this run").
 *
 * What this builder does and does not establish: it builds each candidate from the declaration as the
 * provider receives it, including the original schema the dialect appends, and only from the choices,
 * types, bounds, examples and required and anyOf keys that declaration states. It shows that the
 * declaration admits a value. It does not show that a real model produces that value, and it cannot
 * prove a constraint the declaration states only as an unbounded rule, which is why the issued-only case
 * above is named rather than built.
 */
const REFUSED_DECLARATIONS: readonly string[] = []; // No retired host-cursor verb exists in the task registry.

test('AL-R1 every declared tool accepts a value built only from its declaration', async t => {
  const events: { event?: string; tool?: string; violations?: string[]; reason?: string }[] = [];
  const detach = attachHostLogSink({ event: raw => { if (raw !== undefined) events.push(raw as { event?: string }); return undefined; } });
  try {
    const f = await fixture(t, { grantMode: 'owner-trusted-reads', alarms: alarmClock() });
    const definitions = liveTools(f);
    const { declarations } = declarationsFor(definitions);
    const nameless: string[] = [];
    const refused: string[] = [];
    const tried: string[] = [];
    const unnamed: string[] = [];
    for (const declaration of declarations) namelessObjects(declaration.parameters as DeclaredSchema, declaration.name, nameless);
    assert.deepEqual(nameless, [], 'every object parameter names its properties');
    let step = 0;
    for (const declaration of declarations) {
      const definition = definitions.find(candidate => candidate.name === declaration.name);
      assert.ok(definition, `the live table defines ${declaration.name}`);
      // The declaration describes more than one value; the tool accepting any one of them is what
      // conformance means, and a declaration whose every described value is refused describes nothing.
      const refusedHere: string[] = [];
      let accepted = false;
      for (const args of declaredValues(declaration.parameters as DeclaredSchema)) {
        step += 1;
        const at = events.length;
        await liveExecute(f, { callId: `call-${step}`, toolName: declaration.name, accountId: definition.accountId, resourceId: definition.resourceId }, args, step);
        // A grant, a connector or a missing owner ask may refuse the call; its arguments never may be
        // refused anonymously, which is the failure that met every set_alarm call in release 10.8.
        const lines = events.slice(at).filter(line => line.event === 'tool_arguments_rejected' && line.tool === declaration.name);
        for (const line of lines) refusedHere.push(...(line.violations ?? []));
        if (lines.some(line => (line.violations ?? []).length === 0)) unnamed.push(declaration.name);
        if (lines.length === 0) { accepted = true; break; }
      }
      if (!accepted) {
        refused.push(`${declaration.name} ${refusedHere[0] ?? 'refused'}`);
        tried.push(`${declaration.name}: ${JSON.stringify(declaredValues(declaration.parameters as DeclaredSchema))}`);
      }
    }
    // A refusal that names its field is repairable. One that names nothing is the opaque answer that met
    // every set_alarm call in release 10.8, and no declared value may reach it any more.
    assert.deepEqual(unnamed, [], 'no tool answers a value its declaration describes with an unnamed schema failure');
    // AL-R1: naming the rejection repairs the model's retry, not the conformance. A value the declaration
    // alone describes is accepted, so a declaration-generated call is refused only by a tool whose own rule
    // refuses everything its declaration describes. Those five are raised as findings against the files
    // named above; the list is exact, so a sixth tool or a different rule on one of them fails right here.
    assert.deepEqual([...refused].sort(), [...REFUSED_DECLARATIONS].sort(),
      `every declared tool accepts a value built only from its declaration: ${tried.join(' | ')}`);
  } finally { detach(); }
});

test('task bindings use configured validated connector readers without the research tool', async t => {
  const f = await fixture(t);
  const bindings = f.owner.taskBindings(['lux']);
  assert.equal(bindings.length, 1); assert.equal(bindings[0]?.connector, 'lux-knowledge');
  const read = await bindings[0]!.reader.call('search_knowledge', { query: 'synthetic', limit: 1, include_sensitive: false }, f.signal);
  assert.equal(read.state, 'completed'); assert.equal(f.calls.length, 1);
  f.owner.applyConnection(policy({ enabled: false, generation: 2 }));
  assert.equal(f.owner.taskBindings(['lux']).length, 0);
});


test('task alarm executors keep the existing scheduler and refuse invalid writes', async t => {
  const now = Date.UTC(2030, 0, 1); let rechecks = 0;
  const f = await fixture(t, { alarms: { now: () => now, recheck: () => { rechecks++; }, health: () => ({ degraded: false, reasons: [] }) }, timezone: 'UTC' });
  const runtime = new TaskRuntime({ store: f.store, now: () => now, timeZone: 'UTC',
    execute: connectorExecutor([], f.owner.taskExecutors('synthetic-call')),
    authority: new Authority({ journal: f.store.taskEffectJournal(() => true), checkEffect: async () => true, log() {} }),
    infer: async () => ({ text: '', calls: [], no_action: true }), contentAllowed: () => true,
    delivery: { attach() {}, progress() {}, deliver() {}, closed() {} } });
  try {
  const revision = runtime.begin('synthetic reminder task', 1);
  let operation = 0;
  const call = (name: string, args: Record<string, unknown>) => runtime.runTool(name, name === 'alarm_create' || name === 'alarm_update' ? { recurrence: null, ...args } : args,
    { ...revision.identity, operation_id: `synthetic-alarm-${++operation}` }, revision.signal);
  const bad = await call('alarm_create', { text: 'Synthetic reminder', at: 'not a time' });
  assert.equal(bad.status, 'failed'); assert.equal(rechecks, 0);
  const created = await call('alarm_create', { text: 'Synthetic reminder', at: new Date(now + 3600000).toISOString() });
  assert.equal(created.status, 'ok'); const id = created.references[0]?.id; assert.ok(id);
  const updated = await call('alarm_update', { id, text: 'Updated reminder', at: new Date(now + 7200000).toISOString() });
  assert.equal(updated.status, 'ok');
  const missing = await call('alarm_cancel', { id: 'missing' }); assert.equal(missing.status, 'failed');
  const cancelled = await call('alarm_cancel', { id }); assert.equal(cancelled.status, 'ok', JSON.stringify(cancelled));
  assert.equal(rechecks, 3);
  const row = f.store.transaction(tx => tx.get('SELECT state,label,fire_at_utc FROM alarms WHERE id=?', [id]));
  assert.equal(row?.state, 'cancelled'); assert.equal(row?.label, 'Updated reminder'); assert.equal(row?.fire_at_utc, now + 7200000);
  } finally { runtime.close(); }
});
