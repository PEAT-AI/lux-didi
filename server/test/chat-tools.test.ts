import { TRUSTED_SYSTEM_CODE_UNIT_LIMIT } from '../prompt/index.js';
import { syntheticTaskFactory } from './synthetic-task.js';
import { test, type TestContext } from 'node:test';
import { answerInstruction, chatToolRegistry, CHAT_TOOL_TIMEOUT_MS, deterministicAnswer, notReachedLabels, toolLabel } from '../chat/tools.js';
import type { ChatStepEvent } from '../chat/types.js';
import type { ExecutionContext, ToolDefinition } from '../adapters/model/types.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { safeEvent } from '../host/log.js';
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

const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' }, detail: { type: 'string', enum: ['snippets', 'bodies', 'voice'] }, snippet_chars: { type: 'integer', minimum: 100, maximum: 6000 } }, required: ['query'], additionalProperties: false };
const tools: { name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }[] = [{ name: 'search_insights', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: schema }];
const ACCEPTED = 'ACCEPTED [Überblick 🌱](https://example.com/evidence) insight 42';
const REJECTED = 'REJECTED [diagnostic](https://example.com/rejected) insight 99';
const UNCLASSIFIED = '[unclassified](https://example.com/unclassified) insight 100';

async function fixture(t: TestContext, routeClasses: DataClass[] = ['ordinary', 'private'],
  overrides: Partial<import('../chat/index.js').ChatConfig> = {}, sourceKind: 'lux' | 'gmail' = 'lux') {
  const dir = mkdtempSync(join(tmpdir(), 'chat-tools-'));
  const requests: ModelRequest[] = [];
  const responseEntities: string[] = [];
  const sourceProofs: Record<string, unknown>[] = [];
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
    if (ask && request.declarations?.some(d => d.name === (sourceKind === 'gmail' ? 'read_mail' : exactRead ? 'get_insight' : 'search_insights')) && (repeat || !request.contents.some(c => c.parts.some(p => p.functionResponse)))) {
      return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [{ functionCall: { name: sourceKind === 'gmail' ? 'read_mail' : exactRead ? 'get_insight' : 'search_insights', args: sourceKind === 'gmail' ? { id: mailId, cursor: null } : exactRead ? { insight_ids: [42], include_links: true } : { query: repeat ? `synthetic acquisition round ${requests.length}` : 'which emails arrived' }, id: randomUUID() } }] } };
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
        { text: 'PROVISIONAL' }, { functionCall: { name: 'search_insights', args: { query: 'one more', limit: 1 }, id: randomUUID() } },
      ] } };
    }
    if (finalStatus !== 'complete') return result(request, finalStatus, '');
    beforeFinal?.();
    return result(request, 'complete', 'Answer from evidence');
  } };
  const f = openFixture(dir, model, { now: Date.now, route: { provider: 'gemini', model: 'fixture', available: true, allows: classes => classes.every(c => routeClasses.includes(c)), endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'fixture', allowedClasses: routeClasses } }, undefined, toolsMigrations);
  let taskChat: ChatService | undefined;
  t.after(() => { taskChat?.shutdown(); f.chat.shutdown(); f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const endpoint = { id: 'fixture-endpoint', url: 'https://fixture.invalid/mcp', account: 'fixture-account', resource: 'fixture-resource' };
  const sdk = new Server({ name: 'chat-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: false });
  let executions = 0; const sourceRequests: Record<string, unknown>[] = [];
  // The real helper always publishes its identity probe, and a strict Google connector refuses to
  // publish without it, so the fixture publishes and answers gmail_get_profile as well.
  let exposed: { name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }[] = sourceKind === 'gmail' ? [{ name: 'gmail_get_profile', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, { name: 'gmail_read_message', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string', enum: ['full', 'metadata'] } }, required: ['id', 'format'], additionalProperties: false } }] : structuredClone(tools);
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
  const nativeBindings = owner.taskBindings.bind(owner);
  t.mock.method(owner, 'taskBindings', (connectionIds: readonly string[]) => nativeBindings(connectionIds).map(binding => {
    const project = binding.project;
    if (!project) return binding;
    return { ...binding, project: (evidence: Parameters<typeof project>[0]) => {
      const snapshot = project(evidence); sourceProofs.push(structuredClone(snapshot.response)); return snapshot;
    } };
  }));
  assert.deepEqual(mcp.connectionIds(), [endpoint.id]);
  t.after(async () => { await mcp.close(); await transport.close(); await sdk.close(); });
  const composition = { owner, connectionIds: () => mcp.connectionIds(), registerAuthoritySource: (source: typeof authority) => { authority = source; } };
  const chat = new ChatService(Object.assign({}, f.config, { context: { ...f.config.context, budgets: { ...f.config.context.budgets, trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT } }, tools: composition, createTaskRuntime: syntheticTaskFactory(f.store, composition), classify: (subject: Parameters<NonNullable<import('../chat/index.js').ChatConfig['classify']>>[0], tx: Parameters<NonNullable<import('../chat/index.js').ChatConfig['classify']>>[1]) => { if (subject.kind === 'recall') return null; const label = f.domain.getRoutingLabel(tx, { kind: subject.kind, id: subject.id }); return label.dataClass === 'unknown' ? null : { ownerId: f.store.assistantId, dataClass: label.dataClass, revision: label.revision }; } }, overrides));
  chat.recover(f.recoveryContext);
  // This mirrors the host's trusted authority-source registration seam.
  composition.registerAuthoritySource(async (id, signal) => signal.aborted ? null : (chat as ChatService & { lookupAuthority?(id: string): LiveAuthority | null }).lookupAuthority?.(id) ?? null);
  taskChat = chat;
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
  return { ...f, dir, chat, owner, registry, sourceRequests, sourceProofs, exactMail: (id: string) => { mailId = id; }, canonicalSource: () => { canonicalSource = true; }, followBodies: (mode: 'follow' | 'duplicate' | 'repeat' = 'follow') => { followBodies = true; bodyMode = mode; }, exactGet: () => { exactRead = true; }, turnEvents, requests, responseEntities, endpoint, mcp, composition, session, turn, executions: () => executions,
    slowCalls: (after = 0) => { hangAfter = after; }, failAnswerCall: () => { failAnswer = true; }, repeatCalls: () => { repeat = true; }, noCalls: () => { ask = false; }, rejectResult: () => { reject = true; }, rawRejectedResult: () => { reject = true; errorFlag = false; }, setDispatchHook: (hook: () => void) => { onDispatch = hook; },
    illegalFinalCall: () => { illegalFinal = true; }, finalOutcome: (status: 'empty' | 'truncated') => { finalStatus = status; },
    setFinalHook: (hook: () => void) => { beforeFinal = hook; },
    leak: (text: string) => { payload = text; },
    logEvents,
    approveY: async () => { exposed.push({ name: 'get_insight', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { insight_ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['insight_ids', 'include_links'], additionalProperties: false } }); const current = f.store.transaction(tx => tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?', [endpoint.id])!); const prior = JSON.parse(String(current.policy_json)) as ConnectionPolicy; owner.applyConnectionIntent({ expectedPolicySha256: String(current.policy_sha256), policy: { ...prior, generation: prior.generation + 1, toolNames: exposed.map(tool => tool.name), schemaDigest: canonicalToolDigest(exposed) } }); await mcp.refresh(); },
    privateOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'private', allowedClasses: ['private'] }, route: { ...p.route, allowedClasses: ['private'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    sensitiveOnly: async () => { const p = f.store.transaction(tx => JSON.parse(String(tx.get('SELECT policy_json FROM tool_connections WHERE connection_id=?', [endpoint.id])!.policy_json)) as ConnectionPolicy); owner.applyConnection({ ...p, generation: p.generation + 1, sourcePolicy: { ...p.sourcePolicy, unknownClass: 'sensitive', allowedClasses: ['sensitive'] }, route: { ...p.route, allowedClasses: ['sensitive'] } }); assert.equal((await mcp.port.discover(endpoint.id)).state, 'discovered'); owner.projectConnection(endpoint.id); },
    admission: (sessionId: string) => f.store.transaction(tx => { const row = tx.get('SELECT * FROM chat_capability_acceptances WHERE session_id=?', [sessionId]); return row ? JSON.parse(String(row.capabilities_json)) as { name: string }[] : []; }) };
}

test('real chat declares task reads, journals execution, and discloses only gated evidence', async t => {
  const f = await fixture(t); f.canonicalSource(); const run = await f.turn(f.session());
  t.diagnostic(JSON.stringify({ outcome: run.outcome, requests: f.requests.length, executions: f.executions() }));
  assert.equal(run.outcome, 'complete', 'task registry composition must reach the model, not compile_failed');
  const declarations = f.requests[0]?.declarations ?? [];
  assert.ok(declarations.some(tool => tool.name === 'search_insights'));
  assert.equal(declarations.some(tool => tool.name === 'read_knowledge'), false, 'the retired helper read is gone; discovery is the only source');
  assert.equal(declarations.some(tool => tool.name === 'read_received_body'), false);
  assert.equal(f.executions(), 1);
  const rows = f.store.transaction(tx => tx.all('SELECT state,intent_json,result_json FROM tool_calls WHERE run_id=?', [run.runId]));
  assert.equal(rows.length, 1); assert.equal(rows[0]?.state, 'completed');
  assert.match(JSON.stringify(f.requests.slice(1)), /ACCEPTED/, JSON.stringify(f.requests.slice(1), (key, value) => ['system', 'tools'].includes(key) ? undefined : value));
  assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED|UNCLASSIFIED/);
  assert.doesNotMatch(JSON.stringify(run), /REJECTED|UNCLASSIFIED/);
  assert.match(JSON.stringify(f.chat.get(run.runId, f.context)), /ACCEPTED/);
  const packets = f.responseEntities.flatMap(entity => entity.trim().startsWith('{') ? [JSON.parse(entity)]
    : entity.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()))) as { result?: Record<string, unknown> }[];
  const wire = packets.find(packet => packet.result && Array.isArray(packet.result.content)); assert(wire?.result);
  assert.equal(f.responseEntities.length, 1);
  const capturedEntity = f.responseEntities[0]!; assert.match(capturedEntity, /structuredContent/, 'hash the actual entity, not only accepted display text');
  assert.notEqual(createHash('sha256').update(capturedEntity).digest('hex'), createHash('sha256').update(ACCEPTED).digest('hex'));
  const proof = f.sourceProofs.find(value => value.entitySha256); assert(proof, 'the real canonical chat read invokes the native byte-bound projector');
  assert.equal(proof.entitySha256, createHash('sha256').update(capturedEntity).digest('hex'));
  const grant = f.registry.currentGrant('fixture-endpoint')!;
  assert.deepEqual(proof.source, { endpointId: 'fixture-endpoint', url: 'https://fixture.invalid/mcp', schemaDigest: grant.schemaDigest,
    toolName: 'search_insights', generation: grant.generation, account: 'fixture-account', resource: 'fixture-resource' });
  const expectedSources = [{ title: 'Überblick 🌱', url: 'https://example.com/evidence' }, { title: 'KB: 42' }];
  assert.deepEqual(run.toolEvidence?.flatMap(value => value.sources), expectedSources, 'completed run retains exact gated source metadata');
  assert.deepEqual(f.chat.get(run.runId, f.context)?.toolEvidence?.flatMap(value => value.sources), expectedSources, 'Chat.get projects the same exact source metadata');

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
  const f = await fixture(t); f.canonicalSource();
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
  assert.equal(receipt[0]?.['tool'], 'search_insights');
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
  assert.ok(f.admission(session).some(d => d.name === 'search_insights'));
});


test('provider/model route change cannot reuse an existing frozen admission', async t => {
  const f = await fixture(t); const session = f.session(); await f.turn(session);
  const before = f.admission(session);
  const changed = new ChatService({ ...f.config, tools: f.composition, createTaskRuntime: syntheticTaskFactory(f.store, f.composition), route: { ...f.config.route, model: 'different-model' } });
  changed.recover(f.recoveryContext); t.after(() => changed.shutdown());
  assert.throws(() => changed.accept({ sessionId: session, text: 'mail', idempotencyKey: randomUUID() }, f.context), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'route_changed');
  assert.deepEqual(f.admission(session), before);
});

test('four bounded tool rounds receive one tools-disabled final synthesis request', async t => {
  const f = await fixture(t); f.canonicalSource(); f.repeatCalls(); const run = await f.turn(f.session());
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
  const f = await fixture(t); f.canonicalSource(); f.repeatCalls(); f.illegalFinalCall(); const run = await f.turn(f.session());
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
  const f = await fixture(t); f.canonicalSource(); const session = f.session(); const accepted = await f.turn(session);
  assert.match(JSON.stringify(accepted.toolEvidence), /ACCEPTED/);
  f.rawRejectedResult(); f.setDispatchHook(() => { f.registry.revoke(f.endpoint.id); });
  const rejected = await f.turn(session);
  assert.equal(f.executions(), 2, 'rejected raw connector response must actually be produced');
  assert.equal(rejected.outcome, 'complete', 'the owner still gets an answer from the accepted evidence: ' + JSON.stringify({ run: rejected, calls: f.store.transaction(tx => tx.all('SELECT state,result_json FROM tool_calls WHERE run_id=?', [rejected.runId])) }));
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
  assert.ok(!f.requests[0]!.declarations?.some(d => d.name === 'search_insights'));
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
  assert.deepEqual(last?.type === 'snapshot' ? last.notReached : undefined, ['search insights'],
    'the fence names the call it cut');
  const receipt = seen.find(entry => entry.event === 'chat_timing');
  assert.equal(receipt?.outcome, 'fenced');
  assert.equal(Array.isArray(receipt?.tools) && (receipt!.tools as { ok: boolean }[])[0]!.ok, false, 'the aborted call is recorded as not ok');
  assert.equal(typeof receipt?.fenceMs, 'number');
});

test('the evidence gathered before the fence is answered from even when the answer call fails', async t => {
  const f = await fixture(t, ['ordinary', 'private'], { deadlineMs: 2000 });
  f.canonicalSource();
  f.repeatCalls(); f.slowCalls(1); f.failAnswerCall();
  const run = await f.turn(f.session());
  assert.equal(run.outcome, 'complete');
  assert.equal((run.toolEvidence ?? []).length, 1, 'the first round evidence is kept, never discarded');
  assert.match(run.finalText ?? '', /found 1 item/, 'the deterministic answer is written from that evidence');
});

// --- The chat intent surface: voice parity, one call searches and shapes ---










test('Lux sensitive integration: trusted whole-source policy selects sensitive discovery and ordinary routes dispatch nothing', async t => {
  for (const allowed of [false, true]) for (const exact of [false, true]) {
    const f = await fixture(t, allowed ? ['ordinary', 'private', 'sensitive'] : ['ordinary', 'private']); if (exact) { await f.approveY(); f.exactGet(); } await f.sensitiveOnly();
    const run = await f.turn(f.session());
    if (!allowed) { assert.equal(f.executions(), 0); continue; }
    assert.equal(run.outcome, 'complete'); assert.equal(f.executions(), 1); if (exact) assert.deepEqual(f.sourceRequests[0]!['insight_ids'], [42]); else assert.equal(f.sourceRequests[0]!['include_sensitive'], true);
    const row = f.store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE run_id=?', [run.runId]))!; assert.deepEqual(JSON.parse(String(row.result_json)).dataClasses, ['sensitive']);
  }
});



















// Unsupported structured content must not acquire provenance from its text sibling.
test('unsupported structured envelope withholds diagnostic evidence', async t => {
  const f = await fixture(t);
  const run = await f.turn(f.session());
  assert.equal(run.outcome, 'complete');
  assert.equal(f.executions(), 1);
  assert.deepEqual(run.toolEvidence, []);
  assert.deepEqual(f.chat.get(run.runId, f.context).toolEvidence, []);
  const rows = f.store.transaction(tx => tx.all('SELECT state,reason FROM tool_dispatches'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'unavailable');
  assert.equal(rows[0]!.reason, 'structured_source_projection_unavailable');
  assert.doesNotMatch(JSON.stringify(run), /ACCEPTED|unclassified/);
});


test('real chat turn reads a local reminder and commits a task note through canonical declarations', async t => {
  const observed: ModelRequest[] = []; let step = 0;
  const model: ModelPort = { generate: async request => {
    observed.push(request);
    const call = step++ === 0 ? { name: 'alarm_list', args: {}, id: 'list' } : step === 2 ? { name: 'remember_note', args: { text: 'Synthetic task note body' }, id: 'note' } : undefined;
    return { status: 'complete', text: call ? '' : 'Synthetic turn finished.', providerContent: { role: 'model', parts: call ? [{ functionCall: call }] : [{ text: 'Synthetic turn finished.' }] },
      reason: 'complete', prompt: { version: 'synthetic', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
  } };
  const f = await fixture(t, ['ordinary', 'private'], { model, context: { budgets: { trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, contextChars: 12000, historyChars: 12000 }, sources: [] } });
  let completionError = ''; const complete = f.owner.complete.bind(f.owner);
  f.owner.complete = (...args) => { try { return complete(...args); } catch (error) { completionError = error instanceof Error ? error.message : 'non_error'; throw error; } };
  f.store.transaction(tx => tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,'pending',?)", ['synthetic-reminder', Date.UTC(2030, 0, 2), 'UTC', 'Known reminder label', 'synthetic-journal']));
  const sessionId = f.session(), accepted = f.chat.accept({ sessionId, text: 'List my reminders and keep this note: Synthetic task note body', idempotencyKey: randomUUID() }, f.context);
  let outcome: string | null = null;
  for await (const event of f.chat.subscribe(accepted.runId, f.context)) if (event.type === 'snapshot' && event.run.state === 'terminal') { outcome = event.run.outcome; break; }
  assert.equal(outcome, 'complete');
  const continuation = observed.flatMap(request => request.contents).flatMap(content => content.parts).flatMap(part => part.functionResponse ? [part.functionResponse.response] : []);
  assert.ok(continuation.some(response => JSON.stringify(response).includes('Known reminder label')), JSON.stringify({ completionError, operations: f.store.transaction(tx => tx.all('SELECT tool,state FROM task_operations')), responses: continuation, calls: f.store.transaction(tx => tx.all('SELECT state,result_json FROM tool_calls')) }).slice(0, 1600));
  assert.ok(continuation.some(response => JSON.stringify(response).includes('committed')), 'the chat model receives the effect receipt');
  const notes = f.store.transaction(tx => tx.all("SELECT e.text FROM entries e JOIN sessions s ON s.id=e.session_id WHERE s.title='Task note'"));
  assert.deepEqual(notes.map(row => row.text), ['Synthetic task note body']);
});

test('the task facade is stable across newly approved source tools and owner revisions', async t => {
  const f = await fixture(t); const session = f.session();
  const first = await f.turn(session);
  assert.equal(first.outcome, 'complete');
  const names = f.requests[0]?.declarations?.map(tool => tool.name) ?? [];
  assert.ok(names.includes('search_insights'));
  assert.equal(names.includes('get_insight'), false, 'an unapproved read is not declared');
  await f.approveY(); f.noCalls();
  const next = await f.turn(session);
  assert.equal(next.outcome, 'denied', 'an accepted conversation cannot silently widen its source policy');
  assert.deepEqual(f.requests.at(-1)?.declarations?.map(tool => tool.name), names, 'the refused turn still declares the accepted set');
  const fresh = await f.turn(f.session());
  assert.equal(fresh.outcome, 'complete', 'fresh owner consent captures the approved source policy');
  // Reads come from discovery, so the newly approved read is declared by the next accepted run and nothing else moves.
  assert.deepEqual(f.requests.at(-1)?.declarations?.map(tool => tool.name), [...names, 'get_insight']);
  assert.equal(f.requests.at(-1)?.declarations?.some(tool => tool.name === 'create_insight'), false, 'a discovered write never becomes a chat tool');
});

test('chat reads canonical mail through task id/cursor arguments, not a legacy body consumer', async t => {
  const f = await fixture(t, ['ordinary', 'private'], {}, 'gmail');
  f.exactMail('synthetic-message');
  const run = await f.turn(f.session());
  assert.equal(run.outcome, 'complete');
  const tool = f.requests[0]?.declarations?.find(tool => tool.name === 'read_mail');
  assert.ok(tool);
  assert.equal(f.requests[0]?.declarations?.some(item => item.name === 'read_received_body'), false);
  assert.equal(f.executions(), 1);
  assert.equal(f.sourceRequests[0]?.id, 'synthetic-message');
  assert.match(JSON.stringify(f.requests.slice(1)), /next_cursor/);
});
