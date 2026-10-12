import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
import { sha256 } from '../tools/canonical.js';
import { runTools } from '../adapters/model/loop.js';
import type { DataClass, HostContext, ModelPort, ModelRequest, ModelResult, ToolCallIntent } from '../adapters/model/types.js';
import type { LiveAuthority, RunAcceptance } from '../tools/types.js';
import { fixture as voiceFixture } from './live-voice-fixture.js';

const endpoints = [
  { id: 'lux-knowledge', connector: 'lux-knowledge', tool: 'search_knowledge', args: { query: 'synthetic', limit: 1 } },
  { id: 'gmail', connector: 'google', tool: 'gmail_get_profile', args: {} },
  { id: 'calendar', connector: 'google', tool: 'gcal_calendars', args: {} },
  { id: 'mattermost', connector: 'mattermost', tool: 'mattermost_whoami', args: {} },
  { id: 'mongoose', connector: 'mongoose', tool: 'get_company_profile', args: {} },
];
const pair = ['lux-knowledge', 'gmail'];
const all = endpoints.map(e => e.id);
const signal = new AbortController().signal;
function result(name?: string, args: Record<string, unknown> = {}): ModelResult {
  return { status: 'complete', text: name ? '' : 'done', providerContent: { role: 'model', parts: name ? [{ functionCall: { name, args, id: 'call' } }] : [{ text: 'done' }] }, reason: 'complete', prompt: { version: '1', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
}

async function harness(t: TestContext, builder: 'live' | 'chat-shaped') {
  const dir = mkdtempSync(join(tmpdir(), 'didi-admission-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const store = new Store(join(dir, 'data'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
  const sources: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>)[] = [];
  const chatAuthorities = new Map<string, LiveAuthority>();
  const counts = new Map(all.map(id => [id, 0]));
  const readers = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let dispatch: ((id: string) => Promise<void> | void) | undefined;
  for (const entry of endpoints) {
    const sdk = new Server({ name: entry.id, version: '1' }, { capabilities: { tools: {} } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', () => ({ tools: [{ name: entry.tool, inputSchema: entry.id === 'lux-knowledge' ? { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false } : { type: 'object', properties: {}, additionalProperties: false } }] }) as never);
    sdk.setRequestHandler('tools/call', async () => {
      counts.set(entry.id, counts.get(entry.id)! + 1);
      await dispatch?.(entry.id);
      const text = entry.connector === 'google' ? JSON.stringify({ family: entry.id === 'gmail' ? 'gmail' : 'calendar', tool: entry.tool, method: entry.tool, account: { configured: 'configured', provider: null }, data: entry.id === 'gmail' ? { emailAddress: 'synthetic@example.invalid', messagesTotal: 1, threadsTotal: 1 } : { calendars: [{ id: 'synthetic', summary: 'Synthetic calendar' }] } }) : `synthetic ${entry.id} read`;
      return { content: [{ type: 'text', text }] } as never;
    });
    await sdk.connect(transport); readers.set(entry.id, transport);
    t.after(async () => { await transport.close(); await sdk.close(); });
  }
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const id = new URL(request.url).pathname.slice(1);
    const transport = readers.get(id); assert(transport, request.url);
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
  const start = async (enabled = all) => {
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: endpoints.map(e => ({ id: e.id, connector: e.connector, transport: 'streamable-http', url: `http://127.0.0.1:18765/${e.id}`, account: e.id, resource: e.id, credentialRef: null, enabled: enabled.includes(e.id), allowEgress: true })) }), { mode: 0o600 });
    const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority }); runtimes.push(runtime); return runtime;
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
      acceptance = { ownerId: store.assistantId, actorId: 'synthetic-actor', runId: randomUUID(), authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: JSON.stringify({ version: 1, provider: 'gemini', model: 'synthetic-chat', endpoint: 'https://model.invalid', apiVersion: 'v1beta', keyReference: 'synthetic', allowedClasses: [...allowedClasses].sort(), policyVersion: 1 }), provider: 'gemini', modelId: 'synthetic-chat', allowedClasses }, allowedClasses, connectionIds: runtime.connectionIds() };
      const hash = store.transaction(tx => runtime.owner.snapshotRun(tx, acceptance).sha256);
      chatAuthorities.set(acceptance.runId, { ...acceptance, acceptedRunHash: hash });
    }
    const host: HostContext = { ...acceptance, grants: endpoints.map(e => ({ tool: e.tool, effect: 'read', accountId: e.id, resourceId: e.id })) };
    return { acceptance, host };
  };
  const read = async (runtime: Awaited<ReturnType<typeof start>>, host: HostContext, id: string) => {
    const endpoint = endpoints.find(e => e.id === id)!; const seen: ModelRequest[] = [];
    const model: ModelPort = { generate: async request => { seen.push(structuredClone(request)); return seen.length === 1 ? result(endpoint.tool, endpoint.args) : result(); } };
    const outcome = await runTools({ model, request: { system: 'synthetic', promptVersion: '1', contents: [{ role: 'user', parts: [{ text: 'read' }] }], dataClasses: ['ordinary'], context: { items: [], selectedIds: [], maxChars: 100 } }, registry: runtime.owner.definitions(host.runId), host, authority: { isCurrent: async () => (await lookupAuthority(host.runId, signal)) !== null }, maxSteps: 3, control: { signal, deadlineMs: Date.now() + 5000 }, journal: runtime.owner.journal, resultGate: runtime.owner.resultGate });
    return { outcome, seen };
  };
  return { store, start, accept, read, counts, setDispatch: (hook: typeof dispatch) => { dispatch = hook; } };
}

for (const builder of ['live', 'chat-shaped'] as const) test(`connection-scoped admission through host composition (${builder}, T8-FIX-R1)`, async t => {
  const h = await harness(t, builder);
  const initial = await h.start(pair); const run = await h.accept(initial);
  assert.deepEqual(run.acceptance.connectionIds, pair);
  const intent: ToolCallIntent = { runId: run.host.runId, actorId: run.host.actorId, authorityEpoch: run.host.authorityEpoch, revision: run.host.revision, executionId: `${run.host.runId}:probe`, toolName: 'search_knowledge', accountId: 'lux-knowledge', resourceId: 'lux-knowledge', callId: 'probe', argumentsHash: sha256(JSON.stringify(endpoints[0]!.args)) };
  // At the base this throws intent_policy_denied, before any connector is invoked.
  assert.equal(initial.owner.journal.intent(intent), 'fresh');
  const definition = initial.owner.definitions(run.host.runId).find(d => d.name === intent.toolName)!;
  const completed = await definition.execute(endpoints[0]!.args, { ...intent, signal }); assert.equal(completed.status, 'completed');
  for (const id of pair) {
    const before = h.counts.get(id)!; const { outcome, seen } = await h.read(initial, run.host, id);
    assert.equal(outcome.status, 'complete'); assert.equal(h.counts.get(id), before + 1);
    assert.equal(seen.length, 2); assert(seen[1]!.contents.some(c => c.parts.some(p => p.functionResponse)));
  }
  const expanded = await h.start();
  const denied = await h.read(expanded, run.host, 'mattermost');
  assert.equal(h.counts.get('mattermost'), 0); assert(!denied.seen.some(r => r.contents.some(c => c.parts.some(p => p.functionResponse && JSON.stringify(p.functionResponse).includes('synthetic mattermost read')))));
  const rows = h.store.transaction(tx => tx.all('SELECT state,intent_json,result_json FROM tool_calls WHERE run_id=?', [run.host.runId]));
  assert(rows.some(r => r.state === 'completed')); assert(rows.some(r => r.state === 'refused'));
  for (const row of rows) { assert.equal(JSON.parse(String(row.intent_json)).routeIdentity, run.acceptance.route.identity); assert.equal(JSON.parse(String(row.result_json)).routeIdentity, run.acceptance.route.identity); }
  const allRun = await h.accept(expanded);
  assert.deepEqual(allRun.acceptance.connectionIds, all);
  for (const id of all) { const before = h.counts.get(id)!; const read = await h.read(expanded, allRun.host, id); assert.equal(read.outcome.status, 'complete', id); assert.equal(h.counts.get(id), before + 1, id); }
});
