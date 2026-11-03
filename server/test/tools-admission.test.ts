import { canonicalTaskFixture } from './canonical-task-fixture.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations, validateLiveProfile } from '../live/index.js';
import { toolsMigrations } from '../tools/schema.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { composeLive } from '../host/live.js';
import { HostLog, safeEvent } from '../host/log.js';
import { sha256 } from '../tools/canonical.js';
import { runTools } from '../adapters/model/loop.js';
import type { DataClass, HostContext, ModelPort, ModelRequest, ModelResult, ToolCallIntent } from '../adapters/model/types.js';
import type { LiveAuthority, RunAcceptance } from '../tools/types.js';
import { fixture as voiceFixture } from './live-voice-fixture.js';

const endpoints = [
  { id: 'lux-knowledge', connector: 'lux-knowledge', tool: 'search_knowledge', task: 'search_knowledge', args: { query: 'synthetic' } },
  { id: 'gmail', connector: 'google', tool: 'gmail_search_messages', task: 'search_mail', args: { query: 'synthetic', cursor: null } },
  { id: 'calendar', connector: 'google', tool: 'calendar_list_events', task: 'calendar_events', args: { start: '2026-11-03T00:00:00Z', end: '2026-11-04T00:00:00Z' } },
  { id: 'mattermost', connector: 'mattermost', tool: 'mattermost_search', task: 'search_chat', args: { query: 'synthetic' } },
  { id: 'drive', connector: 'google', tool: 'drive_search_files', task: 'search_drive', args: { query: 'synthetic' } },
];
const pair = ['lux-knowledge', 'gmail'];
const all = endpoints.map(e => e.id);
const signal = new AbortController().signal;
function result(name?: string, args: Record<string, unknown> = {}): ModelResult {
  return { status: 'complete', text: name ? '' : 'done', providerContent: { role: 'model', parts: name ? [{ functionCall: { name, args, id: 'call' } }] : [{ text: 'done' }] }, reason: 'complete', prompt: { version: '1', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
}

async function harness(t: TestContext, builder: 'live' | 'chat-shaped', failure?: 'transport' | 'result') {
  const dir = mkdtempSync(join(tmpdir(), 'didi-admission-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const log = new HostLog(dir);
  let store = new Store(join(dir, 'data'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
  const sources: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>)[] = [];
  const chatAuthorities = new Map<string, LiveAuthority>();
  const counts = new Map(all.map(id => [id, 0]));
  const readers = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let dispatch: ((id: string) => Promise<void> | void) | undefined;
  let visible = new Set(pair);
  const sdks = new Map<string, Server>();
  const resetReaders = async () => {
    for (const transport of readers.values()) await transport.close();
    for (const sdk of sdks.values()) await sdk.close();
    readers.clear(); sdks.clear();
    for (const entry of endpoints) {
    const identityTool = entry.id === 'gmail' ? 'gmail_get_profile' : entry.id === 'calendar' ? 'calendar_list_calendars' : entry.id === 'mattermost' ? 'mattermost_whoami' : undefined;
    const account = entry.connector === 'google' ? `${entry.id}@synthetic.invalid` : entry.id;
    const sdk = new Server({ name: entry.id, version: '1' }, { capabilities: { tools: {} } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: entry.id !== 'lux-knowledge' });
    sdk.setRequestHandler('tools/list', () => ({ tools: visible.has(entry.id) ? [{ name: entry.tool, inputSchema: entry.id === 'lux-knowledge' ? { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', maximum: 3 }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit'], additionalProperties: false } : entry.connector === 'google' ? { type: 'object', properties: { maxResults: { type: 'integer' }, pageToken: { type: 'string' }, q: { type: 'string' }, query: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, calendarId: { type: 'string' } }, additionalProperties: false } : { type: 'object', properties: entry.id === 'mattermost' ? { query: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' }, from_date: { type: 'string' }, to_date: { type: 'string' } } : {}, additionalProperties: false } }, ...(identityTool ? [{ name: identityTool, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] : [])] : [] }) as never);
    sdk.setRequestHandler('tools/call', async request => {
      const tool = request.params.name;
      if (tool === entry.tool) { counts.set(entry.id, counts.get(entry.id)! + 1); await dispatch?.(entry.id); }
      if (tool === identityTool) {
        const data = entry.id === 'gmail' ? { emailAddress: account } : entry.id === 'calendar' ? { calendars: [{ id: account, summary: 'Primary', primary: true }] } : { id: account, username: account };
        const body = entry.connector === 'google' ? { family: entry.id, tool, method: tool, account: { configured: account, provider: account }, data } : data;
        return { content: [{ type: 'text', text: JSON.stringify(body) }] } as never;
      }
      const text = entry.connector === 'google' ? JSON.stringify({ family: entry.id === 'gmail' ? 'gmail' : entry.id === 'drive' ? 'drive' : 'calendar', tool: entry.tool, method: entry.tool, account: { configured: account, provider: account }, data: entry.id === 'gmail' ? { messages: [{ id: 'synthetic', headers: { Subject: 'Synthetic mail', From: 'Synthetic sender <synthetic@example.invalid>', Date: 'Synthetic date' } }] } : entry.id === 'drive' ? { files: [{ id: 'synthetic', name: 'synthetic drive read' }] } : { events: [{ id: 'synthetic', summary: 'Synthetic calendar', start: { dateTime: '2026-11-03T09:00:00Z' }, end: { dateTime: '2026-11-03T10:00:00Z' } }] } }) : entry.id === 'lux-knowledge' ? 'synthetic lux-knowledge read; knowledge results: 1\n**#1** Synthetic result' : entry.id === 'mattermost' ? JSON.stringify({ posts: [{ id: 'synthetic', message: 'synthetic mattermost read' }] }) : `synthetic ${entry.id} read`;
      return { content: [{ type: 'text', text }], ...(entry.id === 'lux-knowledge' ? { structuredContent: { unclassified_marker: 'synthetic-private-unclassified' }, isError: false } : {}) } as never;
    });
    await sdk.connect(transport); readers.set(entry.id, transport); sdks.set(entry.id, sdk);
    }
  };
  await resetReaders();
  t.after(async () => { for (const transport of readers.values()) await transport.close(); for (const sdk of sdks.values()) await sdk.close(); });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const id = new URL(request.url).pathname.slice(1);
    const transport = readers.get(id); assert(transport, request.url);
    if (failure && id === 'lux-knowledge' && request.method === 'POST') {
      const packet = await request.clone().json() as { method?: string; id?: unknown };
      if (packet.method === 'tools/call') return new Response(failure === 'transport' ? ': keepalive\n\n' : `data: ${JSON.stringify({ jsonrpc: '2.0', id: packet.id, result: { content: 'invalid' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return request.method === 'GET' ? new Response(null, { status: 405 }) : transport.handleRequest(request);
  });
  const runtimes: Awaited<ReturnType<typeof composeMcpRuntime>>[] = [];
  const services: ReturnType<typeof composeLive>['service'][] = [];
  t.after(async () => { for (const service of services) await service.shutdown(); for (const runtime of runtimes) await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const lookupAuthority = async (runId: string, s: AbortSignal) => {
    if (s.aborted) return null;
    for (const source of sources) { const found = await source(runId, s); if (found) return found; }
    return chatAuthorities.get(runId) ?? null;
  };
  const start = async (enabled = all, sourceClasses: Record<string, unknown> = {}) => {
    if (runtimes.length) {
      for (const service of services) await service.shutdown(); services.length = 0;
      for (const runtime of runtimes) await runtime.close(); runtimes.length = 0;
      store.close(); store = new Store(join(dir, 'data'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
      sources.length = 0; chatAuthorities.clear();
      // Each SDK HTTP transport represents one session, so a host restart needs fresh readers.
      await resetReaders();
    }
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: endpoints.map(e => ({ id: e.id, connector: e.connector, transport: 'streamable-http', url: `http://127.0.0.1:18765/${e.id}`, account: e.connector === 'google' ? `${e.id}@synthetic.invalid` : e.id, resource: e.id, credentialRef: null, enabled: enabled.includes(e.id), allowEgress: true, unknownClass: Object.hasOwn(sourceClasses, e.id) ? sourceClasses[e.id] : 'private' })) }), { mode: 0o600 });
    const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority, log: event => log.event(event) }); runtimes.push(runtime); return runtime;
  };
  const accept = async (runtime: Awaited<ReturnType<typeof start>>, allowedClasses: DataClass[] = ['ordinary', 'private']) => {
    let acceptance: RunAcceptance;
    if (builder === 'live') {
      const f = await voiceFixture(t);
      const profile = validateLiveProfile({ provider: 'gemini', liveModelId: 'models/admission-live', voice: 'SyntheticVoice', keyReference: 'synthetic', route: { enabled: true, provider: 'gemini', modelId: 'models/admission-live', dataClasses: allowedClasses }, prompt: { text: 'Synthetic system', dataClass: 'ordinary' } });
      const { service } = composeLive(store, configDir, { profile, socketFactory: f.socketFactory, credentials: { resolve: async () => 'synthetic-key' } }, undefined, undefined, { owner: runtime.owner, connectionIds: () => runtime.connectionIds(), registerAuthoritySource: source => { sources.push(source); } }); services.push(service);
      const context = { clientId: 'synthetic-actor', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
      const session = service.create('ordinary', randomUUID(), context);
      const attachment = service.attach(session.liveSessionId, context);
      await f.frame(1); f.send({ setupComplete: {} }); await attachment.ready;
      acceptance = store.transaction(tx => JSON.parse(String(tx.get('SELECT acceptance_json FROM live_tool_acceptances WHERE live_session_id=?', [session.liveSessionId])!.acceptance_json)) as RunAcceptance);
    } else {
      // T8-FIX-R1: public owner API until W-U supplies the real ChatService builder.
      acceptance = { ownerId: store.assistantId, actorId: 'synthetic-actor', runId: randomUUID(), authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: JSON.stringify({ version: 1, provider: 'gemini', model: 'synthetic-chat', endpoint: 'https://model.invalid', apiVersion: 'v1beta', keyReference: 'synthetic', allowedClasses: [...allowedClasses].sort(), policyVersion: 1 }), provider: 'gemini', modelId: 'synthetic-chat', allowedClasses }, allowedClasses, connectionIds: runtime.connectionIds().filter(id => (runtime.registry.currentGrant(id)?.toolNames.length ?? 0) > 0) };
      const hash = store.transaction(tx => runtime.owner.snapshotRun(tx, acceptance).sha256);
      chatAuthorities.set(acceptance.runId, { ...acceptance, acceptedRunHash: hash });
    }
    const host: HostContext & Pick<RunAcceptance, 'connectionIds'> = { ...acceptance, grants: endpoints.map(e => ({ tool: e.tool, effect: 'read', accountId: e.id, resourceId: e.id })) };
    return { acceptance, host };
  };
  const read = async (runtime: Awaited<ReturnType<typeof start>>, host: HostContext & Pick<RunAcceptance, 'connectionIds'>, ids: readonly string[]) => {
    const selected = ids.map(id => endpoints.find(e => e.id === id)!); const seen: ModelRequest[] = [];
    const model: ModelPort = { generate: async request => { seen.push(structuredClone(request)); if (seen.length !== 1) return result(); const answer = result(); answer.providerContent.parts = selected.map(e => ({ functionCall: { name: e.task, args: e.args, id: `call-${e.id}` } })); return answer; } };
    const task = canonicalTaskFixture(store, runtime.owner, host.runId, 'Read the synthetic sources', host.connectionIds);
    try {
    const outcome = await runTools({ model, request: { system: 'synthetic', promptVersion: '1', contents: [{ role: 'user', parts: [{ text: 'read' }] }], dataClasses: ['ordinary'], context: { items: [], selectedIds: [], maxChars: 100 } }, registry: task.tools, host: { ...host, grants: task.tools.map(d => ({ tool: d.name, effect: d.effect, accountId: d.accountId, resourceId: d.resourceId })) }, authority: { isCurrent: async () => (await lookupAuthority(host.runId, signal)) !== null }, maxSteps: 3, control: { signal, deadlineMs: Date.now() + 5000 }, journal: runtime.owner.journal, resultGate: runtime.owner.resultGate });
    return { outcome, seen, errors: task.errors, policies: task.bindings.map(b => ({ id: b.policy.connectionId, mode: b.policy.bindingMode, generation: b.policy.generation, source: b.policy.sourcePolicy, route: b.policy.route })) };
    } finally { task.close(); }
  };
  return { logRows: () => readFileSync(join(dir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>), get store() { return store; }, start, accept, read, counts, revealAll: () => { visible = new Set(all); }, setDispatch: (hook: typeof dispatch) => { dispatch = hook; } };
}

for (const builder of ['live', 'chat-shaped'] as const) test(`connection-scoped admission through host composition (${builder}, T8-FIX-R1)`, async t => {
  const h = await harness(t, builder);
  const initial = await h.start(); const run = await h.accept(initial);
  assert.deepEqual(run.acceptance.connectionIds, pair);
  const probe = canonicalTaskFixture(h.store, initial.owner, run.host.runId, 'Read synthetic knowledge', run.acceptance.connectionIds);
  const definition = probe.tools.find(d => d.name === 'search_knowledge')!;
  const intent: ToolCallIntent = { runId: run.host.runId, actorId: run.host.actorId, authorityEpoch: run.host.authorityEpoch, revision: run.host.revision, executionId: `${run.host.runId}:probe`, toolName: 'search_knowledge', accountId: definition.accountId, resourceId: definition.resourceId, callId: 'probe', argumentsHash: sha256(JSON.stringify(endpoints[0]!.args)) };
  // At the base this throws intent_policy_denied, before any connector is invoked.
  assert.equal(initial.owner.journal.intent(intent), 'fresh');
  const completed = await definition.execute(endpoints[0]!.args, { ...intent, signal });
  probe.close(); assert.equal(completed.status, 'completed');
  h.revealAll(); await initial.refresh();
  const expanded = initial;
  const beforePair = new Map(h.counts);
  const batch = await h.read(expanded, run.host, [...pair, 'mattermost']);
  assert.equal(batch.outcome.status, 'complete'); assert.equal(batch.seen.length, 2);
  assert(batch.seen[1]!.dataClasses.includes('private'), 'private connector evidence reaches the explicitly private-capable route');
  for (const id of pair) assert.equal(h.counts.get(id), beforePair.get(id)! + 1, id + ': ' + JSON.stringify({ tools: batch.outcome.tools, errors: batch.errors, policies: batch.policies, gmailGrant: expanded.registry.currentGrant('gmail') }));
  assert.equal(h.counts.get('mattermost'), 0);
  const responses = batch.seen[1]!.contents.flatMap(c => c.parts.flatMap(p => p.functionResponse ? [p.functionResponse] : []));
  assert.equal(responses.length, 3);
  assert.match(JSON.stringify(responses), /Synthetic result/);
  assert.match(JSON.stringify(responses), /Synthetic mail/);
  assert(!JSON.stringify(responses).includes('synthetic mattermost read'));
  const rows = h.store.transaction(tx => tx.all('SELECT state,intent_json,result_json FROM tool_calls WHERE run_id=?', [run.host.runId]));
  assert(rows.some(r => r.state === 'completed')); assert(rows.some(r => r.state === 'refused'));
  for (const row of rows) { assert.equal(JSON.parse(String(row.intent_json)).routeIdentity, run.acceptance.route.identity); assert.equal(JSON.parse(String(row.result_json)).routeIdentity, run.acceptance.route.identity); }
  const allRun = await h.accept(expanded);
  assert.deepEqual(allRun.acceptance.connectionIds, all);
  const beforeAll = new Map(h.counts);
  const allRead = await h.read(expanded, allRun.host, all); assert.equal(allRead.outcome.status, 'complete'); assert.equal(allRead.seen.length, 2);
  for (const id of all) assert.equal(h.counts.get(id), beforeAll.get(id)! + 1, id + ': ' + JSON.stringify({ tools: allRead.outcome.tools, errors: allRead.errors, replies: allRead.seen[1]?.contents.flatMap(c => c.parts.filter(p => p.functionResponse?.name === 'search_chat')) }));
  const allResponses = allRead.seen[1]!.contents.flatMap(c => c.parts.flatMap(p => p.functionResponse ? [p.functionResponse.response] : []));
  assert.equal(allResponses.length, 5);
  for (const response of allResponses) assert(typeof response['text'] === 'string' && (response['text'].length > 0 || Array.isArray(response['references']) && response['references'].length > 0), 'each admitted read releases verified text or ranked references');
  const generations = () => h.store.transaction(tx => tx.all('SELECT connection_id,generation FROM tool_connections ORDER BY connection_id'));
  const unchanged = generations(); await h.start(); assert.deepEqual(generations(), unchanged, 'unchanged restart must not bump generations');
  // Missing or invalid class is a typed local error for only that connection.
  const missing = await h.start(all, { mattermost: undefined });
  assert.deepEqual(missing.connectionIds(), all.filter(id => id !== 'mattermost'), JSON.stringify(missing.status()));
  assert.equal(missing.status().endpoints.find(e => e.id === 'mattermost')?.configurationError, 'unknown-class-missing');
  const invalid = await h.start(all, { mattermost: 'public' });
  assert.deepEqual(invalid.connectionIds(), all.filter(id => id !== 'mattermost'));
  assert.equal(invalid.status().endpoints.find(e => e.id === 'mattermost')?.configurationError, 'unknown-class-invalid');
  // Class tightening changes generation and denies an admitted connection before invocation.
  const sensitive = await h.start(all, { 'lux-knowledge': 'sensitive' });
  const classRun = await h.accept(sensitive); const beforeClass = h.counts.get('lux-knowledge')!;
  const classDenied = await h.read(sensitive, classRun.host, ['lux-knowledge']);
  assert(classRun.acceptance.connectionIds.includes('lux-knowledge'));
  assert.equal(h.counts.get('lux-knowledge'), beforeClass); assert.equal(classDenied.seen.length, 2); assert(!classDenied.seen[1]!.dataClasses.includes('sensitive'), 'the repair continuation contains no tightened source evidence');
  assert.notEqual(classDenied.outcome.status, 'complete');
  assert(Number(generations().find(r => r.connection_id === 'lux-knowledge')!.generation) > Number(unchanged.find(r => r.connection_id === 'lux-knowledge')!.generation));
  const lower = await h.start();
  assert.equal(lower.status().endpoints.find(e => e.id === 'lux-knowledge')?.configurationError, 'owner-approval-required');
  // Revocation during an actual SDK read must withhold that result from the model.
  const inFlightRun = await h.accept(lower); const beforeFlight = h.counts.get('gmail')!;
  h.setDispatch(id => {
    if (id !== 'gmail') return;
    const row = h.store.transaction(tx => tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?', ['gmail']))!;
    const policy = JSON.parse(String(row.policy_json)); policy.enabled = false; policy.generation += 1;
    lower.owner.applyConnectionIntent({ expectedPolicySha256: String(row.policy_sha256), policy });
  });
  const revoked = await h.read(lower, inFlightRun.host, ['gmail']); h.setDispatch(undefined);
  assert.equal(h.counts.get('gmail'), beforeFlight + 1); assert.equal(revoked.seen.length, 2);
  assert.equal(revoked.outcome.status, 'complete', 'a source-free repair can continue from accepted owner context');
  assert(!JSON.stringify(revoked.seen[1]).includes('synthetic gmail read'), 'revoked raw content never enters the continuation');
  assert(!revoked.seen[1]!.dataClasses.includes('private')); 
  const withheld = h.store.transaction(tx => tx.all('SELECT state,result_json FROM tool_calls WHERE run_id=?', [inFlightRun.host.runId]));
  assert.equal(withheld.length, 1); assert.notEqual(withheld[0]!.state, 'completed');

});

for (const failure of ['transport', 'result'] as const) test(`MCP ${failure} failure retains a bounded code through the real owner`, async t => {
  const h = await harness(t, 'live', failure);
  const runtime = await h.start(); const run = await h.accept(runtime);
  const observed = await h.read(runtime, run.host, ['lux-knowledge']);
  const expected = failure === 'transport' ? 'sdk_protocol_rejected' : 'invalid_result';
  const rows = h.store.transaction(tx => tx.all('SELECT state, result_json FROM tool_calls WHERE run_id=?', [run.host.runId]));
  assert.equal(rows.length, 1);
  const result = JSON.parse(String(rows[0]!.result_json));
  assert.equal(result.response.reason, expected);
  assert.equal(rows[0]!.state, 'failed', 'the canonical read failed; no unverified evidence is disclosed');
  assert.equal(observed.outcome.status, 'complete'); assert.equal(observed.outcome.reason, 'stop', 'the helper can continue after a verified connector failure');
  const logs = h.logRows(); assert.equal(logs.length, 1);
  assert.equal(logs[0]!['event'], 'tool_failure'); assert.equal(logs[0]!['code'], expected);
  assert.equal(logs[0]!['tool'], 'search_knowledge'); assert.equal(logs[0]!['connector'], 'lux-knowledge');
  assert.equal(logs[0]!['errorClass'], 'Error'); assert.equal(logs[0]!['messageHead'], expected);
  assert(!('payload' in logs[0]!));
});

test('host log accepts only bounded tool-failure metadata and drops extra payload fields', () => {
  const event = { event: 'tool_failure', code: 'invalid_result', tool: 'search_knowledge', connector: 'lux-knowledge', errorClass: 'McpResultError', messageHead: 'invalid_result' };
  assert.deepEqual(safeEvent({ ...event, payload: 'synthetic forbidden content' }), event);
  assert.equal(safeEvent({ ...event, code: 'arbitrary_code' }), undefined);
  assert.equal(safeEvent({ ...event, messageHead: 'x'.repeat(121) }), undefined);
  assert.equal(safeEvent({ ...event, messageHead: 'synthetic knowledge text' }), undefined);
});

test('Live knowledge SSE response completes with one result and no unclassified structuredContent', async t => {
  const h = await harness(t, 'live'); const runtime = await h.start(); const run = await h.accept(runtime);
  const observed = await h.read(runtime, run.host, ['lux-knowledge']);
  assert.equal(observed.outcome.status, 'complete');
  const rows = h.store.transaction(tx => tx.all('SELECT state, result_json FROM tool_calls WHERE run_id=?', [run.host.runId]));
  assert.equal(rows.length, 1); assert.equal(rows[0]!.state, 'completed');
  const saved = JSON.parse(String(rows[0]!.result_json));
  assert.equal(saved.response.status, 'no_match', 'ranked neighbours are not exact title matches');
  assert.equal(saved.response.text, ''); assert.equal(saved.response.references[0].title, 'Synthetic result', 'unopened neighbours remain references, not read evidence');
  const responses = observed.seen[1]!.contents.flatMap(c => c.parts.flatMap(p => p.functionResponse ? [p.functionResponse.response] : []));
  assert.equal(responses.length, 1); assert.equal(responses[0]!['text'], saved.response.text);
  assert(!JSON.stringify(responses).includes('synthetic-private-unclassified'));
  assert(!('structuredContent' in responses[0]!));
});

test('bounded tool_failure metadata is written to host.log without an attached payload', t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-tool-failure-log-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new HostLog(dir);
  log.event({ event: 'tool_failure', code: 'child_exited', tool: 'search_knowledge', connector: 'lux-knowledge', errorClass: 'Error', messageHead: 'child_exited', payload: 'synthetic-private-payload' });
  const text = readFileSync(join(dir, 'logs', 'host.log'), 'utf8');
  const row = JSON.parse(text);
  assert.equal(row.event, 'tool_failure'); assert.equal(row.code, 'child_exited');
  assert.equal(row.messageHead, 'child_exited'); assert.equal(row.errorClass, 'Error');
  assert(!text.includes('synthetic-private-payload')); assert(!('payload' in row));
});
