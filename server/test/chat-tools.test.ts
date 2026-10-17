import { test, type TestContext } from 'node:test';
import { answerInstruction, chatToolRegistry, CHAT_TOOL_TIMEOUT_MS, deterministicAnswer, notReachedLabels, toolLabel } from '../chat/tools.js';
import type { ChatStepEvent } from '../chat/types.js';
import type { ExecutionContext, ToolDefinition } from '../adapters/model/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { openFixture, result } from './chat-process.js';
import { ChatService, type RunSnapshot } from '../chat/index.js';
import { chatAllowsToolClasses } from '../chat/context.js';
import { toolsMigrations } from '../tools/index.js';
import { canonicalToolDigest } from '../adapters/mcp/registry.js';
import { composeMcpRuntime } from '../host/mcp.js';
import type { LiveAuthority, ConnectionPolicy } from '../tools/types.js';
import type { ModelPort, ModelRequest, DataClass } from '../adapters/model/types.js';

const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false };
const tools: { name: string; inputSchema: Record<string, unknown> }[] = [{ name: 'search_knowledge', inputSchema: schema }];
const ACCEPTED = 'ACCEPTED [Überblick 🌱](https://example.com/evidence) insight 42';
const SOURCES = [{ title: 'Überblick 🌱', url: 'https://example.com/evidence' }, { title: 'KB: 42' }];
const REJECTED = 'REJECTED [diagnostic](https://example.com/rejected) insight 99';
const UNCLASSIFIED = '[unclassified](https://example.com/unclassified) insight 100';

async function fixture(t: TestContext, routeClasses: DataClass[] = ['ordinary', 'private']) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-tools-'));
  const requests: ModelRequest[] = [];
  const responseEntities: string[] = [];
  let ask = true;
  let repeat = false;
  let illegalFinal = false;
  let finalStatus: 'complete' | 'empty' | 'truncated' = 'complete';
  let beforeFinal: (() => void) | undefined;
  const model: ModelPort = { generate: async (request, control) => {
    requests.push(structuredClone(request));
    if (ask && request.declarations?.some(d => d.name === 'search_knowledge') && (repeat || !request.contents.some(c => c.parts.some(p => p.functionResponse)))) {
      return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [{ functionCall: { name: 'search_knowledge', args: { query: 'which emails arrived', limit: 1 }, id: randomUUID() } }] } };
    }
    if (illegalFinal) {
      control.onEvent?.({ type: 'text', text: 'PROVISIONAL', provisional: true });
      return { ...result(request, 'complete', 'PROVISIONAL'), providerContent: { role: 'model', parts: [
        { text: 'PROVISIONAL' }, { functionCall: { name: 'search_knowledge', args: { query: 'one more', limit: 1 }, id: randomUUID() } },
      ] } };
    }
    if (finalStatus !== 'complete') return result(request, finalStatus, '');
    beforeFinal?.();
    return result(request, 'complete', 'Answer from evidence');
  } };
  const f = openFixture(dir, model, { now: Date.now, route: { provider: 'gemini', model: 'fixture', available: true, allows: classes => classes.every(c => routeClasses.includes(c)), endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'fixture', allowedClasses: routeClasses } }, undefined, toolsMigrations);
  t.after(() => { f.chat.shutdown(); f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const endpoint = { id: 'fixture-endpoint', url: 'https://fixture.invalid/mcp', account: 'fixture-account', resource: 'fixture-resource' };
  const sdk = new Server({ name: 'chat-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: false });
  let executions = 0;
  let exposed = structuredClone(tools);
  let onDispatch: (() => void) | undefined;
  let reject = false;
  let errorFlag = true;
  sdk.setRequestHandler('tools/list', () => ({ tools: exposed }) as never);
  sdk.setRequestHandler('tools/call', () => { executions++; onDispatch?.(); return { content: [{ type: 'text', text: reject ? REJECTED : ACCEPTED }], structuredContent: { hidden: UNCLASSIFIED }, ...(reject && errorFlag ? { isError: true } : {}) } as never; });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); assert.equal(req.url, endpoint.url);
    if (req.method === 'GET') return new Response(null, { status: 405 });
    const packet = await req.clone().json() as { method?: string };
    const response = await transport.handleRequest(req);
    if (packet.method === 'tools/call') responseEntities.push(await response.clone().text());
    return response;
  });
  let authority: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ ...endpoint, connector: 'lux-knowledge', transport: 'streamable-http', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }] }), { mode: 0o600 });
  // Use actual host policy construction, including its current denial, never a matching fixture route.
  const mcp = await composeMcpRuntime({ store: f.store, ownerId: f.store.assistantId, configDir: dir, lookupAuthority: async (id, signal) => authority?.(id, signal) ?? null });
  const { owner, registry } = mcp;
  assert.deepEqual(mcp.connectionIds(), [endpoint.id]);
  t.after(async () => { await mcp.close(); await transport.close(); await sdk.close(); });
  const composition = { owner, connectionIds: () => mcp.connectionIds(), registerAuthoritySource: (source: typeof authority) => { authority = source; } };
  const chat = new ChatService(Object.assign({}, f.config, { tools: composition }));
  chat.recover(f.recoveryContext);
  // This mirrors the host's trusted authority-source registration seam.
  composition.registerAuthoritySource(async (id, signal) => signal.aborted ? null : (chat as ChatService & { lookupAuthority?(id: string): LiveAuthority | null }).lookupAuthority?.(id) ?? null);
  t.after(() => chat.shutdown());
  const session = () => chat.enroll({ title: 'Tools', timeZone: 'UTC', idempotencyKey: randomUUID() }, f.context).sessionId;
  const turn = async (sessionId: string) => {
    const accepted = chat.accept({ sessionId, text: 'Which emails arrived?', idempotencyKey: randomUUID() }, f.context);
    for await (const event of chat.subscribe(accepted.runId, f.context)) if (event.type === 'snapshot' && event.run.state === 'terminal') return event.run;
    throw Error('no terminal snapshot');
  };
  return { ...f, chat, owner, registry, requests, responseEntities, endpoint, mcp, composition, session, turn, executions: () => executions, repeatCalls: () => { repeat = true; }, noCalls: () => { ask = false; }, rejectResult: () => { reject = true; }, rawRejectedResult: () => { reject = true; errorFlag = false; }, setDispatchHook: (hook: () => void) => { onDispatch = hook; },
    illegalFinalCall: () => { illegalFinal = true; }, finalOutcome: (status: 'empty' | 'truncated') => { finalStatus = status; },
    setFinalHook: (hook: () => void) => { beforeFinal = hook; },
    approveY: async () => { exposed.push({ name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } }); const current = f.store.transaction(tx => tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?', [endpoint.id])!); const prior = JSON.parse(String(current.policy_json)) as ConnectionPolicy; owner.applyConnectionIntent({ expectedPolicySha256: String(current.policy_sha256), policy: { ...prior, generation: prior.generation + 1, toolNames: exposed.map(tool => tool.name), schemaDigest: canonicalToolDigest(exposed) } }); await mcp.refresh(); },
    privateOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'private', allowedClasses: ['private'] }, route: { ...p.route, allowedClasses: ['private'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    sensitiveOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'sensitive', allowedClasses: ['sensitive'] }, route: { ...p.route, allowedClasses: ['sensitive'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    admission: (sessionId: string) => f.store.transaction(tx => { const row = tx.get('SELECT * FROM chat_capability_acceptances WHERE session_id=?', [sessionId]); return row ? JSON.parse(String(row.capabilities_json)) as { name: string }[] : []; }) };
}

test('real chat declares approved reads, journals execution, and discloses only gated evidence', async t => {
  const f = await fixture(t); const run = await f.turn(f.session());
  t.diagnostic(`real-owner outcome=${run.outcome}; model requests=${f.requests.length}; connector executions=${f.executions()}`);
  assert.ok(f.requests[0]?.declarations?.some(d => d.name === 'search_knowledge'), 'approved read declaration must reach text chat');
  assert.equal(f.executions(), 1);
  const rows = f.store.transaction(tx => tx.all('SELECT state,intent_json,result_json FROM tool_calls WHERE run_id=?', [run.runId]));
  assert.equal(rows.length, 1); assert.equal(rows[0]?.state, 'completed');
  assert.match(f.responseEntities[0]!, /^event:|^data:/);
  const persisted = JSON.parse(String(rows[0]?.result_json)) as { response: { entitySha256: string } };
  assert.equal(persisted.response.entitySha256, createHash('sha256').update(f.responseEntities[0]!).digest('hex'));
  assert.doesNotMatch(String(rows[0]?.result_json), /decodedResult|unclassified/);
  assert.ok(f.requests.length >= 2);
  assert.match(JSON.stringify(f.requests[1]), /ACCEPTED/); assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
  const evidence = (run as RunSnapshot & { toolEvidence?: unknown }).toolEvidence;
  assert.match(JSON.stringify(evidence) ?? '', /ACCEPTED/); assert.doesNotMatch(JSON.stringify(run), /REJECTED/);
  assert.match(JSON.stringify(f.chat.get(run.runId, f.context)), /ACCEPTED/, 'evidence survives snapshot retrieval');
  assert.deepEqual(run.toolEvidence?.[0]?.sources, SOURCES);
  assert.doesNotMatch(JSON.stringify(run), /unclassified/);
  assert.doesNotMatch(JSON.stringify(f.requests), /unclassified/);
  assert.deepEqual(f.chat.get(run.runId, f.context).toolEvidence?.[0]?.sources, SOURCES);
});

test('frozen declarations cannot authorize a revoked registry grant', async t => {
  const f = await fixture(t); const session = f.session(); await f.turn(session);
  const count = f.executions(); assert.equal(count, 1, 'initial read must execute before revocation'); f.registry.revoke(f.endpoint.id);
  await f.turn(session);
  assert.equal(f.executions(), count, 'revoked read never reaches the connector');
  assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
});

test('revoked provider consent prevents any model request', async t => {
  const f = await fixture(t); const session = f.session(); f.chat.revoke(session, f.context);
  assert.throws(() => f.chat.accept({ sessionId: session, text: 'mail', idempotencyKey: randomUUID() }, f.context));
  assert.equal(f.requests.length, 0);
});


test('new approval never joins a frozen conversation but is admitted to a new one', async t => {
  const f = await fixture(t); const first = f.session(); await f.turn(first);
  assert.deepEqual(f.admission(first).map(d => d.name), ['search_knowledge']);
  await f.approveY(); f.noCalls(); await f.turn(first);
  assert.deepEqual(f.admission(first).map(d => d.name), ['search_knowledge']);
  const second = f.session(); await f.turn(second);
  assert.ok(f.admission(second).some(d => d.name === 'get_insight'));
});

test('connector rejection never reaches model continuation or browser response', async t => {
  const f = await fixture(t); f.rejectResult(); const run = await f.turn(f.session());
  assert.equal(f.executions(), 1, 'canonical connector rejection must actually be exercised');
  assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
  assert.doesNotMatch(JSON.stringify(run), /REJECTED/);
  assert.ok(run.toolEvidence?.every(card => card.sources.length === 0));
});

test('provider consent revoked while evidence is pending refuses the follow-up request', async t => {
  const f = await fixture(t); const session = f.session();
  f.setDispatchHook(() => { f.chat.revoke(session, f.context); });
  await f.turn(session);
  assert.equal(f.executions(), 1, 'evidence-producing call must actually run');
  assert.equal(f.requests.length, 1, 'no evidence-bearing request after provider consent revocation');
  assert.doesNotMatch(JSON.stringify(f.requests), /ACCEPTED|REJECTED/);
});


test('route class filter excludes private-only envelopes from ordinary classes', () => {
  // Current enrollment requires ordinary+private provider support; exercise the
  // exact admission predicate rather than fabricate an ordinary-only enrollment.
  assert.equal(chatAllowsToolClasses(['ordinary'], ['private'], ['private']), false);
  assert.equal(chatAllowsToolClasses(['private'], ['private'], ['private']), true);
  assert.equal(chatAllowsToolClasses(['ordinary', 'private'], ['sensitive'], ['ordinary', 'private']), false);
});

test('private-permitted route admits the private-only envelope through the same class filter', async t => {
  const f = await fixture(t); await f.privateOnly();
  const session = f.session(); await f.turn(session);
  assert.ok(f.admission(session).some(d => d.name === 'search_knowledge'));
});


test('provider/model route change cannot reuse an existing frozen admission', async t => {
  const f = await fixture(t); const session = f.session(); await f.turn(session);
  const before = f.admission(session);
  const changed = new ChatService({ ...f.config, tools: f.composition, route: { ...f.config.route, model: 'different-model' } });
  changed.recover(f.recoveryContext); t.after(() => changed.shutdown());
  assert.throws(() => changed.accept({ sessionId: session, text: 'mail', idempotencyKey: randomUUID() }, f.context), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'route_changed');
  assert.deepEqual(f.admission(session), before);
});

test('four bounded tool rounds receive one tools-disabled final synthesis request', async t => {
  const f = await fixture(t); f.repeatCalls(); const run = await f.turn(f.session());
  assert.equal(f.requests.length, 5, 'four tool rounds require one final synthesis request');
  assert.equal(f.executions(), 4);
  assert.equal(run.outcome, 'complete');
  assert.ok(run.finalEntryId);
  assert.deepEqual(f.requests[4]!.declarations, []);
  assert.match(JSON.stringify(f.requests[4]), /ACCEPTED/);
  assert.equal(JSON.stringify(f.requests[4]).match(/ACCEPTED/g)?.length, 4);
  assert.doesNotMatch(JSON.stringify(f.requests[4]), /REJECTED|unclassified/);
  assert.equal(run.toolEvidence?.length, 4, 'all bounded tool results remain gated in the completed answer');
  assert.doesNotMatch(JSON.stringify(run), /REJECTED/);
});

test('an early visible answer does not add a synthesis request', async t => {
  const f = await fixture(t); f.noCalls(); const run = await f.turn(f.session());
  assert.equal(run.outcome, 'complete'); assert.equal(f.requests.length, 1); assert.equal(f.executions(), 0);
});

test('the fenced synthesis still answers, and its function call is never dispatched', async t => {
  const f = await fixture(t); f.repeatCalls(); f.illegalFinalCall(); const run = await f.turn(f.session());
  assert.equal(f.requests.length, 6, 'the fence adds exactly one tool-free answer call');
  assert.deepEqual(f.requests[4]!.declarations, []);
  assert.deepEqual(f.requests[5]!.declarations, [], 'the answer call declares no tools');
  assert.equal(f.executions(), 4, 'a synthesis function call is never dispatched');
  assert.equal(run.outcome, 'complete');
  assert.notEqual(run.finalEntryId, null);
  assert.equal(run.toolEvidence?.length, 4);
});

test('a fence that reached no answer still commits one from the evidence gathered', async t => {
  for (const status of ['empty', 'truncated'] as const) {
    const f = await fixture(t); f.repeatCalls(); f.finalOutcome(status); const run = await f.turn(f.session());
    assert.equal(f.requests.length, 6);
    assert.deepEqual(f.requests[5]!.declarations, [], 'the answer call declares no tools');
    assert.equal(f.executions(), 4);
    assert.equal(run.outcome, 'complete', `${status} still answers the owner`);
    assert.notEqual(run.finalEntryId, null);
  }
});

test('revocation during final synthesis cannot commit its answer', async t => {
  const f = await fixture(t); const session = f.session(); f.repeatCalls();
  f.setFinalHook(() => { f.chat.revoke(session, f.context); });
  const run = await f.turn(session);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.requests[4]!.declarations, []);
  assert.equal(f.executions(), 4);
  assert.equal(run.outcome, 'cancelled');
  assert.equal(run.finalEntryId, null);
});

test('final synthesis retains the monotonic class of gated tool results', async t => {
  const f = await fixture(t, ['ordinary', 'private', 'sensitive']); await f.sensitiveOnly();
  const session = f.session();
  f.store.transaction(tx => tx.run('UPDATE chat_consents SET permitted_classes=? WHERE session_id=?', ['["ordinary","private","sensitive"]', session]));
  f.repeatCalls(); const run = await f.turn(session);
  assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 4); assert.equal(f.requests.length, 5);
  assert.deepEqual(f.requests[4]!.declarations, []);
  assert.ok(f.requests[4]!.dataClasses.includes('sensitive'));
  assert.equal(f.store.transaction(tx => f.domain.getRoutingLabel(tx, { kind: 'entry', id: run.finalEntryId! })).dataClass, 'sensitive');
});


test('a result rejected after connector execution cannot disclose its raw sentinel', async t => {
  const f = await fixture(t); const session = f.session(); const accepted = await f.turn(session);
  assert.match(JSON.stringify(accepted.toolEvidence), /ACCEPTED/);
  f.rawRejectedResult(); f.setDispatchHook(() => { f.registry.revoke(f.endpoint.id); });
  const rejected = await f.turn(session);
  assert.equal(f.executions(), 2, 'rejected raw connector response must actually be produced');
  assert.equal(rejected.outcome, 'complete', 'the owner still gets an answer from the accepted evidence');
  assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
  assert.doesNotMatch(JSON.stringify(rejected), /REJECTED/);
  assert.doesNotMatch(JSON.stringify(f.chat.get(rejected.runId, f.context)), /REJECTED/);
});


test('later sensitive tool evidence raises the completed Chat reply class', async t => {
  const f = await fixture(t, ['ordinary', 'private', 'sensitive']); await f.sensitiveOnly();
  const session = f.session();
  // Isolate actual tool-loop reply labeling from the separately tested enrollment change.
  f.store.transaction(tx => tx.run('UPDATE chat_consents SET permitted_classes=? WHERE session_id=?', ['["ordinary","private","sensitive"]', session]));
  const run = await f.turn(session);
  assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1);
  assert.equal(f.requests[0]!.dataClasses.includes('sensitive'), false);
  assert.ok(f.requests[1]!.dataClasses.includes('sensitive'));
  assert.equal(f.store.transaction(tx => f.domain.getRoutingLabel(tx, { kind: 'entry', id: run.finalEntryId! })).dataClass, 'sensitive');
});

test('configured Chat consent preserves independent connector class denial', async t => {
  const f = await fixture(t); await f.sensitiveOnly();
  const run = await f.turn(f.session());
  assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 0);
  assert.equal(f.requests.length, 1);
  assert.ok(!f.requests[0]!.declarations?.some(d => d.name === 'search_knowledge'));
});


test('sensitive-capable Chat consent does not widen a private-only connector policy', async t => {
  const f = await fixture(t, ['ordinary', 'private', 'sensitive']); await f.privateOnly();
  const before = f.store.transaction(tx => tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?', [f.endpoint.id]));
  const session = f.session(); const run = await f.turn(session);
  assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1);
  assert.deepEqual(f.chat.conversation(session, f.context).permittedClasses, ['ordinary', 'private', 'sensitive']);
  assert.ok(f.requests.every(request => !request.dataClasses.includes('sensitive')));
  assert.equal(f.store.transaction(tx => f.domain.getRoutingLabel(tx, { kind: 'entry', id: run.finalEntryId! })).dataClass, 'private');
  assert.deepEqual(f.store.transaction(tx => tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?', [f.endpoint.id])), before);
});


// --- Step events, per-call timeout and the answer phase helpers (release 3k) ---

const execContext = (signal = new AbortController().signal): ExecutionContext => ({ runId: 'run-1', actorId: 'owner',
  authorityEpoch: 'epoch-1', revision: 1, accountId: 'acct', resourceId: 'res', executionId: 'run-1:0:0', signal });

const toolDef = (name: string, execute: ToolDefinition['execute']): ToolDefinition => ({ name, description: `${name} tool`,
  parameters: { type: 'object', properties: {} }, validate: () => true, effect: 'read', accountId: 'acct', resourceId: 'res', execute });

const completedOutcome = { status: 'completed' as const, result: { id: 'result-1', sha256: 'a'.repeat(64) } };

test('a chat tool call that outlives its timeout returns a structured timeout and never hangs', async () => {
  const events: ChatStepEvent[] = [];
  const registry = chatToolRegistry([toolDef('gmail_list', () => new Promise(() => {}))],
    { runId: 'run-1', onStep: event => events.push(event), timeoutMs: 20 });
  assert.deepEqual(await registry[0]!.execute({}, execContext()), { status: 'failed', code: 'timeout' });
  const end = events.at(-1)!;
  assert.deepEqual([end.phase, end.ok, end.tool], ['end', false, 'gmail_list']);
  assert.equal(typeof end.ms, 'number');
});

test('the fence signal aborts an in-flight chat call and reports it as cancelled', async () => {
  const events: ChatStepEvent[] = [];
  const fence = new AbortController();
  let aborted = false;
  const registry = chatToolRegistry([toolDef('search', (_args, ctx) => new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }))], { runId: 'run-1', onStep: event => events.push(event), timeoutMs: CHAT_TOOL_TIMEOUT_MS });
  const pending = registry[0]!.execute({}, execContext(fence.signal));
  fence.abort();
  assert.deepEqual(await pending, { status: 'failed', code: 'cancelled' });
  assert.equal(aborted, true);
});

test('chat step events pair start with end in order and carry no tool content', async () => {
  const events: ChatStepEvent[] = [];
  const registry = chatToolRegistry([
    toolDef('gmail_list', async () => completedOutcome),
    toolDef('gdrive_read', async () => ({ status: 'failed', code: 'connector_error' })),
  ], { runId: 'run-1', onStep: event => events.push(event) });
  await registry[0]!.execute({ query: 'secret query text' }, execContext());
  await registry[1]!.execute({}, execContext());
  assert.deepEqual(events.map(event => [event.phase, event.tool, event.ok]),
    [['start', 'gmail_list', undefined], ['end', 'gmail_list', true],
      ['start', 'gdrive_read', undefined], ['end', 'gdrive_read', false]]);
  assert.equal(events[0]!.label, 'listed mail');
  const wire = JSON.stringify(events);
  assert.equal(wire.includes('secret query text'), false);
  assert.equal(wire.includes('result-1'), false);
});

test('a throwing chat tool keeps the failure and still closes its step', async () => {
  const events: ChatStepEvent[] = [];
  const registry = chatToolRegistry([toolDef('calendar', async () => { throw new Error('boom'); })],
    { runId: 'run-1', onStep: event => events.push(event) });
  await assert.rejects(() => registry[0]!.execute({}, execContext()), /boom/);
  assert.deepEqual(events.map(event => [event.phase, event.ok]), [['start', undefined], ['end', false]]);
});

test('a call cut by the fence is named as not reached for the partial answer', () => {
  const base = { type: 'chat_step' as const, runId: 'run-1', tool: 'mail', label: toolLabel('mail') };
  assert.deepEqual(notReachedLabels([{ ...base, stepId: 'run-1:1', phase: 'start' },
    { ...base, stepId: 'run-1:2', phase: 'start' }, { ...base, stepId: 'run-1:1', phase: 'end', ok: true }]), ['searched mail']);
});

test('the deterministic answer is written from the frozen evidence, never from nothing', () => {
  const evidence = [{ name: 'gmail_list', markdown: 'two messages' }, { name: 'search', markdown: 'one insight' }];
  assert.equal(deterministicAnswer(evidence, ['searched mail']),
    'I searched listed mail and searched everything; found 2 items; searched mail did not answer in time.');
  assert.equal(deterministicAnswer([], []), 'I could not search any source; found 0 items.');
  const instruction = answerInstruction(evidence, ['searched mail']);
  assert.equal(instruction.includes('two messages'), true);
  assert.equal(instruction.includes('Do not call any tool'), true);
  assert.equal(instruction.includes('Still running when the search stopped: searched mail.'), true);
});
