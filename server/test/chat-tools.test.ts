import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { openFixture, result } from './chat-process.js';
import { ChatService, type RunSnapshot } from '../chat/index.js';
import { chatAllowsToolClasses } from '../chat/context.js';
import { composeMcpRuntime } from '../host/mcp.js';
import type { LiveAuthority, ConnectionPolicy } from '../tools/types.js';
import type { ModelPort, ModelRequest, DataClass } from '../adapters/model/types.js';

const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false };
const tools: { name: string; inputSchema: Record<string, unknown> }[] = [{ name: 'search_knowledge', inputSchema: schema }];
const ACCEPTED = 'ACCEPTED mail-style synthetic evidence';
const REJECTED = 'REJECTED connector diagnostic never disclosed';

async function fixture(t: TestContext, routeClasses: DataClass[] = ['ordinary', 'private']) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-tools-'));
  const requests: ModelRequest[] = [];
  let ask = true;
  let repeat = false;
  const model: ModelPort = { generate: async request => {
    requests.push(structuredClone(request));
    if (ask && request.declarations?.some(d => d.name === 'search_knowledge') && (repeat || !request.contents.some(c => c.parts.some(p => p.functionResponse)))) {
      return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [{ functionCall: { name: 'search_knowledge', args: { query: 'which emails arrived', limit: 1 }, id: randomUUID() } }] } };
    }
    return result(request, 'complete', 'Answer from evidence');
  } };
  const f = openFixture(dir, model, { now: Date.now, route: { provider: 'gemini', model: 'fixture', available: true, allows: classes => classes.every(c => routeClasses.includes(c)), endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'fixture', allowedClasses: routeClasses } });
  t.after(() => { f.chat.shutdown(); f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const endpoint = { id: 'fixture-endpoint', url: 'https://fixture.invalid/mcp', account: 'fixture-account', resource: 'fixture-resource' };
  const sdk = new Server({ name: 'chat-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  let executions = 0;
  let exposed = structuredClone(tools);
  let onDispatch: (() => void) | undefined;
  let reject = false;
  sdk.setRequestHandler('tools/list', () => ({ tools: exposed }) as never);
  sdk.setRequestHandler('tools/call', () => { executions++; onDispatch?.(); return { content: [{ type: 'text', text: reject ? REJECTED : ACCEPTED }], ...(reject ? { isError: true } : {}), diagnostic: REJECTED } as never; });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); assert.equal(req.url, endpoint.url);
    if (req.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(req);
  });
  let authority: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ ...endpoint, connector: 'lux-knowledge', transport: 'streamable-http', credentialRef: null, enabled: true, allowEgress: true }] }), { mode: 0o600 });
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
  return { ...f, chat, owner, registry, requests, endpoint, mcp, composition, session, turn, executions: () => executions, repeatCalls: () => { repeat = true; }, noCalls: () => { ask = false; }, rejectResult: () => { reject = true; }, setDispatchHook: (hook: () => void) => { onDispatch = hook; },
    approveY: async () => { exposed.push({ name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } }); await mcp.refresh(); },
    privateOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'private', allowedClasses: ['private'] }, route: { ...p.route, allowedClasses: ['private'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    admission: (sessionId: string) => f.store.transaction(tx => { const row = tx.get('SELECT * FROM chat_capability_acceptances WHERE session_id=?', [sessionId]); return row ? JSON.parse(String(row.capabilities_json)) as { name: string }[] : []; }) };
}

test('real chat declares approved reads, journals execution, and discloses only gated evidence', async t => {
  const f = await fixture(t); const run = await f.turn(f.session());
  t.diagnostic(`real-owner outcome=${run.outcome}; model requests=${f.requests.length}; connector executions=${f.executions()}`);
  assert.ok(f.requests[0]?.declarations?.some(d => d.name === 'search_knowledge'), 'approved read declaration must reach text chat');
  assert.equal(f.executions(), 1);
  const rows = f.store.transaction(tx => tx.all('SELECT state,intent_json,result_json FROM tool_calls WHERE run_id=?', [run.runId]));
  assert.equal(rows.length, 1); assert.equal(rows[0]?.state, 'completed');
  assert.ok(f.requests.length >= 2);
  assert.match(JSON.stringify(f.requests[1]), /ACCEPTED/); assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
  const evidence = (run as RunSnapshot & { toolEvidence?: unknown }).toolEvidence;
  assert.match(JSON.stringify(evidence) ?? '', /ACCEPTED/); assert.doesNotMatch(JSON.stringify(run), /REJECTED/);
  assert.match(JSON.stringify(f.chat.get(run.runId, f.context)), /ACCEPTED/, 'evidence survives snapshot retrieval');
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

test('repeated tool requests are bounded and the last accepted result has an evidence card', async t => {
  const f = await fixture(t); f.repeatCalls(); const run = await f.turn(f.session());
  assert.equal(f.requests.length, 4, 'finite composition request bound must actually be reached');
  assert.equal(f.executions(), 4);
  assert.equal(run.outcome, 'truncated');
  assert.equal(run.finalEntryId, null);
  assert.equal(run.toolEvidence?.length, 4, 'final bounded tool result is gated and retained without another model request');
  assert.doesNotMatch(JSON.stringify(run), /REJECTED/);
});
