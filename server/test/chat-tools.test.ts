import { test, type TestContext } from 'node:test';
import { answerInstruction, chatToolRegistry, CHAT_TOOL_TIMEOUT_MS, deterministicAnswer, notReachedLabels, toolLabel } from '../chat/tools.js';
import type { ChatStepEvent } from '../chat/types.js';
import type { ExecutionContext, ToolDefinition } from '../adapters/model/types.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { safeEvent } from '../host/log.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { openFixture, result } from './chat-process.js';
import { ChatService, type RunSnapshot } from '../chat/index.js';
import { chatAllowsToolClasses } from '../chat/context.js';
import { toolsMigrations } from '../tools/index.js';
import { readDiagnosticDispatches } from '../tools/dispatch.js';
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

async function fixture(t: TestContext, routeClasses: DataClass[] = ['ordinary', 'private'],
  overrides: Partial<import('../chat/index.js').ChatConfig> = {}, sourceKind: 'lux' | 'gmail' = 'lux') {
  const dir = mkdtempSync(join(tmpdir(), 'chat-tools-'));
  const requests: ModelRequest[] = [];
  const responseEntities: string[] = [];
  let mailId = 'synthetic-message'; let ask = true; let exactRead = false; let followBodies = false; let bodyMode: 'follow' | 'duplicate' | 'repeat' = 'follow';
  // Fence fixtures: hang the connector after N dispatches, and fail the tool-free answer call.
  let hangAfter: number | null = null;
  let failAnswer = false;
  let repeat = false;
  let illegalFinal = false;
  let finalStatus: 'complete' | 'empty' | 'truncated' = 'complete';
  let beforeFinal: (() => void) | undefined;
  const model: ModelPort = { generate: async (request, control) => {
    requests.push(structuredClone(request));
    if (failAnswer && (request.declarations?.length ?? 0) === 0) throw new Error('provider down');
    if (ask && request.declarations?.some(d => d.name === (sourceKind === 'gmail' ? 'gmail_read_message' : exactRead ? 'get_insight' : 'search_knowledge')) && (repeat || !request.contents.some(c => c.parts.some(p => p.functionResponse)))) {
      return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [{ functionCall: { name: sourceKind === 'gmail' ? 'gmail_read_message' : exactRead ? 'get_insight' : 'search_knowledge', args: sourceKind === 'gmail' ? { id: mailId } : exactRead ? { ids: [42] } : { query: 'which emails arrived', limit: 1 }, id: randomUUID() } }] } };
    }
    if (followBodies && request.declarations?.some(d => d.name === 'read_received_body')) {
      const prior = request.contents.flatMap(content => content.parts.flatMap(part => part.functionResponse ? [part.functionResponse.response] : [])).at(-1);
      const continuation = prior?.['bodyContinuation'] as Record<string, unknown> | undefined;
      const first = request.contents.flatMap(content => content.parts.flatMap(part => part.functionResponse?.response['bodyContinuation'] ? [part.functionResponse.response['bodyContinuation']] : []))[0] as Record<string, unknown> | undefined;
      const cursor = bodyMode === 'repeat' ? first?.['cursor'] : prior?.['nextCursor'] ?? continuation?.['cursor'];
      if (bodyMode === 'duplicate' && continuation && typeof cursor === 'string') return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [0, 1].map(() => ({ functionCall: { name: 'read_received_body', args: { cursor }, id: randomUUID() } })) } };
      if (typeof cursor === 'string') return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [{ functionCall: { name: 'read_received_body', args: { cursor }, id: randomUUID() } }] } };
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
  let executions = 0; const sourceRequests: Record<string, unknown>[] = [];
  // The real helper always publishes its identity probe, and a strict Google connector refuses to
  // publish without it, so the fixture publishes and answers gmail_get_profile as well.
  let exposed = sourceKind === 'gmail' ? [{ name: 'gmail_get_profile', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, { name: 'gmail_read_message', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string', enum: ['full', 'metadata'] } }, required: ['id', 'format'], additionalProperties: false } }] : structuredClone(tools);
  let onDispatch: (() => void) | undefined;
  let reject = false;
  let errorFlag = true;
  let payload = ACCEPTED; let canonicalSource = false;
  sdk.setRequestHandler('tools/list', () => ({ tools: exposed }) as never);
  sdk.setRequestHandler('tools/call', req => {
    // The identity probe is not a read: it never counts as an execution and never reaches the payload.
    if (req.params.name === 'gmail_get_profile') return { content: [{ type: 'text', text: JSON.stringify({ emailAddress: 'owner@example.invalid' }) }] } as never;
    sourceRequests.push(structuredClone(req.params.arguments ?? {})); executions++; onDispatch?.();
    if (hangAfter !== null && executions > hangAfter) return new Promise(() => {}) as never;
    return { content: [{ type: 'text', text: reject ? REJECTED : payload }], structuredContent: canonicalSource ? { result: reject ? REJECTED : payload } : { hidden: UNCLASSIFIED }, ...(reject && errorFlag ? { isError: true } : {}) } as never; });

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
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ ...endpoint, connector: sourceKind === 'gmail' ? 'google' : 'lux-knowledge', transport: 'streamable-http', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }] }), { mode: 0o600 });
  // Use actual host policy construction, including its current denial, never a matching fixture route.
  const logEvents: Record<string, unknown>[] = [];
  const mcp = await composeMcpRuntime({ store: f.store, ownerId: f.store.assistantId, configDir: dir, lookupAuthority: async (id, signal) => authority?.(id, signal) ?? null, log: event => logEvents.push(event as unknown as Record<string, unknown>) });
  const { owner, registry } = mcp;
  assert.deepEqual(mcp.connectionIds(), [endpoint.id]);
  t.after(async () => { await mcp.close(); await transport.close(); await sdk.close(); });
  const composition = { owner, connectionIds: () => mcp.connectionIds(), registerAuthoritySource: (source: typeof authority) => { authority = source; } };
  const chat = new ChatService(Object.assign({}, f.config, { tools: composition, classify: (subject: Parameters<NonNullable<import('../chat/index.js').ChatConfig['classify']>>[0], tx: Parameters<NonNullable<import('../chat/index.js').ChatConfig['classify']>>[1]) => { if (subject.kind === 'recall') return null; const label = f.domain.getRoutingLabel(tx, { kind: subject.kind, id: subject.id }); return label.dataClass === 'unknown' ? null : { ownerId: f.store.assistantId, dataClass: label.dataClass, revision: label.revision }; } }, overrides));
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
  // Same turn, keeping the subscription events so a test can see the partial flags.
  const turnEvents = async (sessionId: string) => {
    const accepted = chat.accept({ sessionId, text: 'Which emails arrived?', idempotencyKey: randomUUID() }, f.context);
    const events: import('../chat/types.js').ChatEvent[] = [];
    let finished: RunSnapshot | undefined;
    for await (const event of chat.subscribe(accepted.runId, f.context)) {
      events.push(event);
      if (event.type === 'snapshot' && event.run.state === 'terminal') { finished = event.run; break; }
    }
    if (!finished) throw Error('no terminal snapshot');
    return { run: finished, events };
  };
  return { ...f, dir, chat, owner, registry, sourceRequests, exactMail: (id: string) => { mailId = id; }, canonicalSource: () => { canonicalSource = true; }, followBodies: (mode: 'follow' | 'duplicate' | 'repeat' = 'follow') => { followBodies = true; bodyMode = mode; }, exactGet: () => { exactRead = true; }, turnEvents, requests, responseEntities, endpoint, mcp, composition, session, turn, executions: () => executions,
    slowCalls: (after = 0) => { hangAfter = after; }, failAnswerCall: () => { failAnswer = true; }, repeatCalls: () => { repeat = true; }, noCalls: () => { ask = false; }, rejectResult: () => { reject = true; }, rawRejectedResult: () => { reject = true; errorFlag = false; }, setDispatchHook: (hook: () => void) => { onDispatch = hook; },
    illegalFinalCall: () => { illegalFinal = true; }, finalOutcome: (status: 'empty' | 'truncated') => { finalStatus = status; },
    setFinalHook: (hook: () => void) => { beforeFinal = hook; },
    leak: (text: string) => { payload = text; },
    logEvents,
    approveY: async () => { exposed.push({ name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } }); const current = f.store.transaction(tx => tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?', [endpoint.id])!); const prior = JSON.parse(String(current.policy_json)) as ConnectionPolicy; owner.applyConnectionIntent({ expectedPolicySha256: String(current.policy_sha256), policy: { ...prior, generation: prior.generation + 1, toolNames: exposed.map(tool => tool.name), schemaDigest: canonicalToolDigest(exposed) } }); await mcp.refresh(); },
    privateOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'private', allowedClasses: ['private'] }, route: { ...p.route, allowedClasses: ['private'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    sensitiveOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'sensitive', allowedClasses: ['sensitive'] }, route: { ...p.route, allowedClasses: ['sensitive'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    admission: (sessionId: string) => f.store.transaction(tx => { const row = tx.get('SELECT * FROM chat_capability_acceptances WHERE session_id=?', [sessionId]); return row ? JSON.parse(String(row.capabilities_json)) as { name: string }[] : []; }) };
}

test('real chat declares approved reads, journals execution, and discloses only gated evidence', async t => {
  const f = await fixture(t); const run = await f.turn(f.session());
  t.diagnostic(JSON.stringify(f.store.transaction(tx => tx.all("SELECT state,reason FROM tool_dispatches"))));
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

// Synthetic fixtures only: every secret below is invented for this test.
const SECRETS = [
  'alpha-bravo-charlie',
  'zulu-yankee-xray-1234',
  'sk-proj-QWERTYUIOP12345',
  'ghp_ABCDEFGHIJKLMNOPQRSTUV',
  'github_pat_ABCDEFGHIJKLMNOPQRSTUV',
  'xoxb-123456789012-abcdefghij',
  'AKIAABCDEFGHIJKLMNOP',
  `AIza${'K'.repeat(35)}`,
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXZhbHVl',
];
const NEIGHBOURHOOD_LEAK = 'xK9!mQ2vR7tZ';
const PEM_BODY = 'MIIBOgIBAAJBAK'.repeat(3);
const LEAKY = [
  'Archive results', 'someone@example.invalid', 'username: deploybot', NEIGHBOURHOOD_LEAK,
  `password=${SECRETS[0]}`, `authorization: Bearer ${SECRETS[1]}`, SECRETS[2] as string, SECRETS[3] as string,
  SECRETS[4] as string, SECRETS[5] as string, SECRETS[6] as string, SECRETS[7] as string, SECRETS[8] as string,
  '-----BEGIN RSA PRIVATE KEY-----', PEM_BODY, '-----END RSA PRIVATE KEY-----', 'ACCEPTED',
].join('\n');

test('tool results are redacted before the model, storage and evidence', async t => {
  const f = await fixture(t);
  f.leak(LEAKY);
  const run = await f.turn(f.session());
  const rows = f.store.transaction(tx => tx.all('SELECT result_json FROM tool_calls WHERE run_id=?', [run.runId]));
  const surfaces: [string, string][] = [
    ['stored result_json', String(rows[0]?.result_json)],
    ['model request', JSON.stringify(f.requests)],
    ['tool evidence', JSON.stringify((run as { toolEvidence?: unknown }).toolEvidence)],
    ['snapshot retrieval', JSON.stringify(f.chat.get(run.runId, f.context))],
  ];
  const forbidden = [...SECRETS, NEIGHBOURHOOD_LEAK, PEM_BODY, 'alpha-bravo-charlie'];
  for (const [name, surface] of surfaces) {
    assert.match(surface, /\[redacted\]/, `${name} carries no redaction marker`);
    for (const secret of forbidden) assert.equal(surface.includes(secret), false, `${name} leaked ${secret}`);
  }
  assert.match(JSON.stringify(f.chat.get(run.runId, f.context)), /ACCEPTED/, 'ordinary evidence survives');
  const receipt = f.logEvents.filter(event => event['event'] === 'tool_redaction');
  assert.equal(receipt.length, 1, 'one receipt per redacted tool result');
  assert.deepEqual(Object.keys(receipt[0] as object).sort(), ['count', 'event', 'tool']);
  assert.equal(receipt[0]?.['tool'], 'search_knowledge');
  assert.ok(Number(receipt[0]?.['count']) >= SECRETS.length);
  assert.equal(JSON.stringify(f.logEvents).includes('alpha-bravo-charlie'), false, 'a receipt never carries a value');
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
  assert.deepEqual(f.admission(first).map(d => d.name), ['conversation_history', 'search_knowledge']);
  await f.approveY(); f.noCalls(); await f.turn(first);
  assert.deepEqual(f.admission(first).map(d => d.name), ['conversation_history', 'search_knowledge']);
  const second = f.session(); await f.turn(second);
  assert.ok(f.admission(second).some(d => d.name === 'get_insight'));
  assert.ok(f.admission(second).some(d => d.name === 'read_received_body'));
  assert(!f.requests.slice(1, 2).some(request => request.declarations?.some(tool => tool.name === 'read_received_body')), 'local consumer cannot silently join the old enrollment');
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

test('conversation consent revocation during final synthesis stays cancelled and cannot commit its answer', async t => {
  const f = await fixture(t); const session = f.session(); f.repeatCalls();
  f.setFinalHook(() => { f.chat.revoke(session, f.context); });
  const run = await f.turn(session);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.requests[4]!.declarations, []);
  assert.equal(f.executions(), 4);
  assert.equal(run.outcome, 'cancelled');
  assert.equal(run.finalEntryId, null);
});

test('explicit user Stop during final synthesis stays cancelled without a final answer', async t => {
  const f = await fixture(t); const session = f.session(); f.repeatCalls();
  f.setFinalHook(() => {
    const active = f.store.transaction(tx => tx.get("SELECT run_id FROM chat_runs WHERE session_id=? AND state!='terminal'", [session]));
    assert(active); f.chat.cancel(String(active.run_id), f.context);
  });
  const run = await f.turn(session);
  assert.equal(f.requests.length, 5); assert.equal(f.executions(), 4);
  assert.equal(run.outcome, 'cancelled'); assert.equal(run.finalEntryId, null);
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
  const registry = chatToolRegistry([toolDef('gmail_search_messages', () => new Promise(() => {}))],
    { runId: 'run-1', onStep: event => events.push(event),
      onFinished: record => events.push({ type: 'chat_step', runId: 'run-1', ...record, phase: 'end', resultCount: 0 }), timeoutMs: 20 });
  assert.deepEqual(await registry[0]!.execute({}, execContext()), { status: 'failed', code: 'timeout' });
  const end = events.at(-1)!;
  assert.deepEqual([end.phase, end.ok, end.tool], ['end', false, 'gmail_search_messages']);
  assert.equal(typeof end.ms, 'number');
});

test('the fence signal aborts an in-flight chat call and reports it as cancelled', async () => {
  const events: ChatStepEvent[] = [];
  const fence = new AbortController();
  let aborted = false;
  const registry = chatToolRegistry([toolDef('search', (_args, ctx) => new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }))], { runId: 'run-1', onStep: event => events.push(event),
      onFinished: record => events.push({ type: 'chat_step', runId: 'run-1', ...record, phase: 'end', resultCount: 0 }), timeoutMs: CHAT_TOOL_TIMEOUT_MS });
  const pending = registry[0]!.execute({}, execContext(fence.signal));
  fence.abort();
  assert.deepEqual(await pending, { status: 'failed', code: 'cancelled' });
  assert.equal(aborted, true);
});

test('chat step events pair start with end in order and carry no tool content', async () => {
  const events: ChatStepEvent[] = [];
  const registry = chatToolRegistry([
    toolDef('gmail_search_messages', async () => completedOutcome),
    toolDef('gdrive_read', async () => ({ status: 'failed', code: 'connector_error' })),
  ], { runId: 'run-1', onStep: event => events.push(event),
      onFinished: record => events.push({ type: 'chat_step', runId: 'run-1', ...record, phase: 'end', resultCount: 0 }) });
  await registry[0]!.execute({ query: 'secret query text' }, execContext());
  await registry[1]!.execute({}, execContext());
  assert.deepEqual(events.map(event => [event.phase, event.tool, event.ok]),
    [['start', 'gmail_search_messages', undefined], ['end', 'gmail_search_messages', true],
      ['start', 'gdrive_read', undefined], ['end', 'gdrive_read', false]]);
  assert.equal(events[0]!.label, 'listed mail');
  const wire = JSON.stringify(events);
  assert.equal(wire.includes('secret query text'), false);
  assert.equal(wire.includes('result-1'), false);
});

test('a throwing chat tool keeps the failure and still closes its step', async () => {
  const events: ChatStepEvent[] = [];
  const registry = chatToolRegistry([toolDef('calendar', async () => { throw new Error('boom'); })],
    { runId: 'run-1', onStep: event => events.push(event),
      onFinished: record => events.push({ type: 'chat_step', runId: 'run-1', ...record, phase: 'end', resultCount: 0 }) });
  await assert.rejects(() => registry[0]!.execute({}, execContext()), /boom/);
  assert.deepEqual(events.map(event => [event.phase, event.ok]), [['start', undefined], ['end', false]]);
});

test('a call cut by the fence is named as not reached for the partial answer', () => {
  const base = { type: 'chat_step' as const, runId: 'run-1', tool: 'mail', label: toolLabel('mail') };
  assert.deepEqual(notReachedLabels([{ ...base, stepId: 'run-1:1', phase: 'start' },
    { ...base, stepId: 'run-1:2', phase: 'start' }, { ...base, stepId: 'run-1:1', phase: 'end', ok: true }]), ['searched mail']);
});

test('the deterministic answer is written from the frozen evidence, never from nothing', () => {
  const evidence = [{ name: 'gmail_search_messages', markdown: 'two messages' }, { name: 'search', markdown: 'one insight' }];
  assert.equal(deterministicAnswer(evidence, ['searched mail']),
    'I searched listed mail and searched everything; found 2 items; searched mail did not answer in time.');
  assert.equal(deterministicAnswer([], []), 'I could not search any source; found 0 items.');
  const instruction = answerInstruction(evidence, ['searched mail']);
  assert.equal(instruction.includes('two messages'), true);
  assert.equal(instruction.includes('Do not call any tool'), true);
  assert.equal(instruction.includes('Still running when the search stopped: searched mail.'), true);
});

// --- The contract's fence evidence: a slow connector, the answer that still lands, and the receipt ---

const receipts = (): { seen: Record<string, unknown>[]; detach: () => void } => {
  const seen: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { const safe = safeEvent(raw); if (safe) seen.push(safe); } });
  return { seen, detach };
};

test('a slow connector is fenced: the answer lands, the aborted call is not retried, and the receipt records it', async t => {
  const { seen, detach } = receipts();
  t.after(detach);
  const f = await fixture(t, ['ordinary', 'private'], { deadlineMs: 1200 });
  f.slowCalls();
  const { run, events } = await f.turnEvents(f.session());
  assert.equal(run.outcome, 'complete', 'a fenced run still answers');
  assert.notEqual(run.finalEntryId, null);
  assert.equal(f.executions(), 1, 'the aborted connector call is dispatched once and never retried');
  assert.equal(f.requests.length, 2, 'one acquire request plus one answer request');
  assert.deepEqual(f.requests[1]!.declarations, [], 'the answer call declares no tools');
  const last = events.filter(event => event.type === 'snapshot').at(-1);
  assert.equal(last?.type === 'snapshot' && last.partial, true, 'the final answer event is marked partial');
  assert.deepEqual(last?.type === 'snapshot' ? last.notReached : undefined, ['searched the knowledge base'],
    'the fence names the call it cut');
  const receipt = seen.find(entry => entry.event === 'chat_timing');
  assert.equal(receipt?.outcome, 'fenced');
  assert.equal(Array.isArray(receipt?.tools) && (receipt!.tools as { ok: boolean }[])[0]!.ok, false, 'the aborted call is recorded as not ok');
  assert.equal(typeof receipt?.fenceMs, 'number');
});

test('the evidence gathered before the fence is answered from even when the answer call fails', async t => {
  const f = await fixture(t, ['ordinary', 'private'], { deadlineMs: 2000 });
  f.repeatCalls(); f.slowCalls(1); f.failAnswerCall();
  const run = await f.turn(f.session());
  assert.equal(run.outcome, 'complete');
  assert.equal((run.toolEvidence ?? []).length, 1, 'the first round evidence is kept, never discarded');
  assert.match(run.finalText ?? '', /found 1 item/, 'the deterministic answer is written from that evidence');
});

// --- The chat intent surface: voice parity, one call searches and shapes ---








test('Lux received-body integration: canonical full body survives preview clipping only inside the active run', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet();
  const raw = JSON.stringify({ id: 42, title: 'Synthetic long insight', content: 'Sentence evidence. '.repeat(1600) + 'LUX_RECEIVED_TAIL' }); f.leak(raw);
  const original = f.owner.resultGate.authorize.bind(f.owner.resultGate); let full = '';
  t.mock.method(f.owner.resultGate, 'authorize', async (...args: Parameters<typeof original>) => {
    const result = await original(...args); const binding = args[1].find(binding => binding.name === 'get_insight');
    if (binding && result.state === 'allowed') { const value = f.owner.consumeEvidence(args[0], binding, f.chat.lookupAuthority(args[0].runId), args[3]); if (value.state === 'allowed' && value.evidence.kind === 'remote-body') { full = value.evidence.body; assert.equal(value.evidence.upstreamComplete, 'unknown'); assert.equal(value.evidence.upstreamOmitted, 'unknown'); } }
    return result;
  });
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1); assert.equal(full, raw);
  const row = f.store.transaction(tx => tx.get("SELECT result_json FROM tool_calls WHERE run_id=? AND json_extract(intent_json,'$.toolName')='get_insight'", [run.runId]))!;
  const snapshot = JSON.parse(String(row.result_json)); assert.equal(snapshot.response.partial, true); assert(snapshot.response.omittedCharacters > 0); assert.doesNotMatch(snapshot.response.text, /LUX_RECEIVED_TAIL/); assert.doesNotMatch(String(row.result_json), /LUX_RECEIVED_TAIL|bodySha256/);
});

test('Lux sensitive integration: trusted whole-source policy selects sensitive discovery and ordinary routes dispatch nothing', async t => {
  for (const allowed of [false, true]) for (const exact of [false, true]) {
    const f = await fixture(t, allowed ? ['ordinary', 'private', 'sensitive'] : ['ordinary', 'private']); if (exact) { await f.approveY(); f.exactGet(); } await f.sensitiveOnly();
    const run = await f.turn(f.session());
    if (!allowed) { assert.equal(f.executions(), 0); continue; }
    assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1); if (exact) assert.deepEqual(f.sourceRequests[0]!['ids'], [42]); else assert.equal(f.sourceRequests[0]!['include_sensitive'], true);
    const row = f.store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE run_id=?', [run.runId]))!; assert.deepEqual(JSON.parse(String(row.result_json)).dataClasses, ['sensitive']);
  }
});

test('Text body integration: canonical same-run consumer reconstructs the received tail with immutable source lineage', async t => {
  const f = await fixture(t); f.canonicalSource(); await f.approveY(); f.exactGet(); f.followBodies();
  const raw = JSON.stringify({ id: 42, title: 'Synthetic complete received content', content: 'Source evidence sentence. '.repeat(1300) + '🍃'.repeat(1200) + 'TEXT_FINAL_RECEIVED_TAIL' }); f.leak(raw);
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1);
  const continuations = f.requests.flatMap(request => request.contents.flatMap(content => content.parts.flatMap(part => part.functionResponse ? [part.functionResponse] : [])));
  const original = continuations.find(response => response.name === 'get_insight'); assert(original);
  const cursor = (original.response['bodyContinuation'] as Record<string, unknown> | undefined)?.['cursor']; assert.equal(typeof cursor, 'string', 'original sealed source response must already carry its canonical cursor');
  const originalRow = f.store.transaction(tx => tx.get("SELECT result_json FROM tool_calls WHERE run_id=? AND json_extract(intent_json,'$.toolName')='get_insight'", [run.runId]))!;
  assert.deepEqual(JSON.parse(String(originalRow.result_json)).response, original.response, 'later consumer pages never mutate the original sealed response');
  const unique = new Map<string, Record<string, unknown>>();
  for (const response of continuations) if (response.name === 'read_received_body') unique.set(response.id!, response.response);
  let joined = '';
  for (const response of unique.values()) {
    const slices = response['bodySlices'] as { text: string; offset: number; end: number; total: number; unit: string }[]; assert(Array.isArray(slices) && slices.length === 1);
    const slice = slices[0]!; assert.equal(slice.offset, joined.length); assert.equal(slice.end - slice.offset, slice.text.length); assert.equal(slice.total, raw.length); assert.equal(slice.unit, 'utf16'); assert(!/[\uDC00-\uDFFF]/u.test(slice.text.slice(0, 1))); assert(!/[\uD800-\uDBFF]/u.test(slice.text.slice(-1))); joined += slice.text;
  }
  assert.equal(joined, raw); assert(unique.size > 1); assert(f.requests.length <= 5, 'existing four acquisition steps plus synthesis stay fixed');
  const rows = f.store.transaction(tx => tx.all("SELECT state,result_id,result_json FROM tool_calls WHERE run_id=? AND json_extract(intent_json,'$.toolName')='read_received_body'", [run.runId]));
  assert.equal(rows.length, unique.size); assert(rows.every(row => row.state === 'completed' && JSON.parse(String(row.result_json)).hostEvidenceRequired === true));
  assert.equal(new Set(rows.map(row => row.result_id)).size, rows.length); assert.doesNotMatch(JSON.stringify([...unique.values()]), /bodySha256|entitySha256|remote-page|gateway:/);
  const parentRefs = JSON.parse(String(originalRow.result_json)).sourceDispatchRefs; assert.equal(parentRefs?.length, 1, JSON.stringify(f.store.transaction(tx => tx.all('SELECT state,reason,source_json FROM tool_dispatches WHERE run_id=?',[run.runId]))));
  for (const row of rows) assert.deepEqual(JSON.parse(String(row.result_json)).sourceDispatchRefs, parentRefs, 'each local page preserves exact canonical source provenance');
  const edges = f.store.transaction(tx => tx.all('SELECT * FROM tool_dispatch_reuse WHERE run_id=?', [run.runId])); assert.equal(edges.length, rows.length); assert(edges.every(edge => edge.origin_dispatch_id === parentRefs[0]));
  f.chat.shutdown(); await f.mcp.close(); f.store.close();
  const reopened = openFixture(f.dir, { generate: async request => result(request, 'complete', '') }, {}, undefined, toolsMigrations);
  try {
    const authority = { ownerId: reopened.store.assistantId, allowedClasses: ['ordinary', 'private'] as const };
    const read = () => reopened.store.transaction(tx => readDiagnosticDispatches(tx, run.runId, authority));
    const persisted = read(); assert.equal(persisted.reuse.length, rows.length); assert(persisted.reuse.every(edge => edge.read_state === 'allowed' && String(edge.source_json).includes('TEXT_FINAL_RECEIVED_TAIL')));
    reopened.store.transaction(tx => tx.run('UPDATE tool_connections SET generation=generation+1 WHERE connection_id=?', [f.endpoint.id]));
    assert(read().reuse.every(edge => edge.source_json === null && edge.read_state === 'origin_unavailable_or_denied'));
  } finally { reopened.chat.shutdown(); reopened.store.close(); }
});

test('Text body integration: the fixed four-step budget reports exact remaining received range', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet(); f.followBodies();
  const raw = JSON.stringify({ id: 42, title: 'Synthetic bounded read', content: 'Bounded source sentence. '.repeat(5000) }); f.leak(raw);
  const { run, events } = await f.turnEvents(f.session()); assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1); assert.equal(f.requests.length, 5);
  assert.equal(f.requests.at(-1)!.declarations!.length, 0); assert.match(run.finalText!, /characters remain/);
  const trace = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId])!.trace)));
  const coverage = trace.receivedBodyCoverage[0]; assert.equal(coverage.total, raw.length); assert.equal(coverage.preparedEnd, 48000); assert.equal(coverage.remaining, raw.length - 48000); assert.deepEqual(coverage.remainingRange, { offset: 48000, end: raw.length, unit: 'utf16' }); assert.equal(coverage.stage, 'canonical-preparation');
  assert(events.some(event => event.type === 'snapshot' && event.partial === true)); assert.match(run.finalText!, /did not confirm/);
});

test('Text body integration: concurrent identical cursors prepare one page and return deterministic independent receipts', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet(); f.followBodies('duplicate'); f.leak(JSON.stringify({ id: 42, content: 'Concurrent source evidence. '.repeat(700) }));
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1);
  const rows = f.store.transaction(tx => tx.all("SELECT result_id,result_json FROM tool_calls WHERE run_id=? AND json_extract(intent_json,'$.toolName')='read_received_body' ORDER BY rowid", [run.runId]));
  const first = JSON.parse(String(rows[0]!.result_json)).response, repeated = JSON.parse(String(rows[1]!.result_json)).response;
  assert(first.bodySlices.length === 1); assert.equal(repeated.alreadyPrepared, true); assert.deepEqual(repeated.bodySlices, []); assert.equal(repeated.nextCursor, first.nextCursor); assert.notEqual(rows[0]!.result_id, rows[1]!.result_id);
  const coverage = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId])!.trace))).receivedBodyCoverage[0]; assert.equal(coverage.remaining, 0);
});

test('Text body integration: a consumer alone cannot launder revoked original source at final delivery', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet(); f.followBodies(); f.leak(JSON.stringify({ id: 42, content: 'Never publish revoked retained body. '.repeat(80) }));
  const original = f.owner.resultGate.authorize.bind(f.owner.resultGate); let captured: Parameters<typeof original> | undefined;
  t.mock.method(f.owner.resultGate, 'authorize', async (...args: Parameters<typeof original>) => { const result = await original(...args); if (result.state === 'allowed' && args[1].some(binding => binding.name === 'read_received_body')) captured = args; return result; });
  f.setFinalHook(() => {
    assert(captured); const only = captured[1].filter(binding => binding.name === 'read_received_body'); assert(only.length > 0);
    assert.equal(f.owner.authorizeDelivery(captured[0], only, [], f.chat.lookupAuthority(captured[0].runId), captured[3]).state, 'allowed');
    f.registry.revoke(f.endpoint.id);
    assert.equal(f.owner.authorizeDelivery(captured[0], only, [], f.chat.lookupAuthority(captured[0].runId), captured[3]).state, 'refused');
  });
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'unavailable'); assert.equal(run.finalText, null); assert.equal(f.executions(), 1); assert.doesNotMatch(JSON.stringify(run.toolEvidence), /Never publish/);
});

test('Text body integration: source completeness remains distinct from fully consumed received mail text', async t => {
  for (const complete of [false, true]) {
    const f = await fixture(t, ['ordinary', 'private'], {}, 'gmail'); f.followBodies();
    f.leak(JSON.stringify({ family: 'gmail', tool: 'gmail_read_message', data: { id: 'synthetic-message', headers: { Subject: 'Synthetic completeness' }, body: 'Received mail evidence. '.repeat(180), bodyCoverage: { complete } } }));
    const { run, events } = await f.turnEvents(f.session()); assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1); assert.equal(f.sourceRequests[0]!['format'], 'full');
    const trace = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId])!.trace))), coverage = trace.receivedBodyCoverage[0];
    assert.equal(coverage.remaining, 0); assert.equal(coverage.upstreamComplete, complete); assert.equal(coverage.upstreamOmitted, !complete);
    if (complete) { assert.doesNotMatch(run.finalText!, /source omitted|characters remain/); assert(!events.some(event => event.type === 'snapshot' && event.partial)); }
    else { assert.match(run.finalText!, /source omitted content/); assert(events.some(event => event.type === 'snapshot' && event.partial === true)); }
  }
});

test('Text body integration: actual companion MIME envelope reaches the final received tail with one source read', async t => {
  const f = await fixture(t, ['ordinary', 'private'], {}, 'gmail'); f.followBodies();
  const envelope = readFileSync(new URL('../../test/fixtures/google-mime-long-produced.json', import.meta.url), 'utf8');
  const produced = JSON.parse(envelope) as { data: { id: string; body: string; bodyCoverage: { complete: boolean } } };
  f.exactMail(produced.data.id); f.leak(envelope);
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1);
  assert.deepEqual(f.sourceRequests, [{ id: produced.data.id, format: 'full' }]);
  const pages = f.store.transaction(tx => tx.all("SELECT result_json FROM tool_calls WHERE run_id=? AND json_extract(intent_json,'$.toolName')='read_received_body' ORDER BY rowid", [run.runId]));
  const text = pages.map(row => JSON.parse(String(row.result_json)).response.bodySlices.map((slice: { text: string }) => slice.text).join('')).join('');
  assert(text.includes(produced.data.body)); assert(text.endsWith('TAIL-MIME-SYNTHETIC'));
  const trace = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId])!.trace)));
  assert.equal(trace.receivedBodyCoverage[0].remaining, 0); assert.equal(trace.receivedBodyCoverage[0].upstreamComplete, true); assert.equal(trace.receivedBodyCoverage[0].upstreamOmitted, false);
});

test('Text body integration: cancel while local execution waits releases its original evidence and cannot prepare a late page', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet(); f.followBodies(); f.leak(JSON.stringify({ id: 42, content: 'Canceled local body evidence. '.repeat(90) }));
  let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }); t.after(() => release());
  const original = f.owner.resultGate.authorize.bind(f.owner.resultGate); let captured: Parameters<typeof original> | undefined, authority: LiveAuthority | null = null;
  t.mock.method(f.owner.resultGate, 'authorize', async (...args: Parameters<typeof original>) => {
    if (!captured && args[1].some(binding => binding.name === 'get_insight' && binding.contentIndex === 0)) { captured = args; authority = f.chat.lookupAuthority(args[0].runId); entered(); await held; }
    return original(...args);
  });
  const pending = f.turn(f.session()); await started; assert(captured); assert(authority);
  f.chat.cancel(captured[0].runId, f.context); const run = await pending; assert.equal(run.outcome, 'cancelled');
  release(); for (let n = 0; n < 40; n++) await new Promise<void>(resolve => setImmediate(resolve));
  const parent = captured[1].find(binding => binding.name === 'get_insight')!;
  assert.equal(f.owner.consumeEvidence(captured[0], parent, authority, new AbortController().signal).state, 'refused');
  assert.equal(f.store.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id=? AND state='completed' AND json_extract(intent_json,'$.toolName')='read_received_body'", [run.runId])!.n)), 0); assert.equal(f.executions(), 1);
});

test('Text body integration: original revocation in the final gate microtask closes publication', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet(); f.followBodies(); f.leak(JSON.stringify({ id: 42, content: 'Final-gap body must be refused. '.repeat(80) }));
  let final = false; f.setFinalHook(() => { final = true; });
  const original = f.owner.resultGate.authorize.bind(f.owner.resultGate);
  t.mock.method(f.owner.resultGate, 'authorize', async (...args: Parameters<typeof original>) => { const result = await original(...args); if (final && result.state === 'allowed' && args[1].some(binding => binding.name === 'read_received_body')) queueMicrotask(() => f.registry.revoke(f.endpoint.id)); return result; });
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'unavailable'); assert.equal(run.finalText, null); assert.equal(f.executions(), 1); assert.doesNotMatch(JSON.stringify(run.toolEvidence), /Final-gap body/);
});

test('Text body integration: canonical preparation is not counted as model receipt when the next request fails', async t => {
  const f = await fixture(t); await f.approveY(); f.exactGet(); f.followBodies(); f.failAnswerCall();
  const raw = JSON.stringify({ id: 42, content: 'Source with an unobserved final page. '.repeat(2600) }); f.leak(raw);
  const run = await f.turn(f.session()); assert.equal(run.outcome, 'error'); assert.equal(run.finalText, null); assert.equal(f.executions(), 1); assert.equal(f.requests.length, 5);
  const coverage = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId])!.trace))).receivedBodyCoverage[0];
  assert.equal(coverage.preparedEnd, 48000); assert.equal(coverage.modelContextEnd, 32000); assert.equal(coverage.remaining, raw.length - 32000); assert.deepEqual(coverage.remainingRange, { offset: 32000, end: raw.length, unit: 'utf16' }); assert.equal(coverage.stage, 'canonical-preparation'); assert.equal(coverage.modelContextStage, 'response-observed');
});
