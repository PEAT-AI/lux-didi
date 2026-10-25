import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { CompletedResult, EndpointConfig, McpPort } from '../adapters/mcp/port.js';
import { createMattermostReader, MATTERMOST_AUTH_NEEDED, MATTERMOST_TOOLS, parseChannelList, resolveChannelReference } from '../connectors/index.js';
import { mattermostToolStatus, projectMattermostResult } from '../tools/mattermost.js';
import { mongooseFailureStage } from '../connectors/mongoose.js';
import { ResearchLedger, runResearch, type ResearchDeps } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { Store } from '../runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { runToolCalls } from '../tools/declarations.js';
import type { LiveAuthority, RunAcceptance } from '../tools/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'stdio-mattermost-child.mjs');
const ACCOUNT = 'local';
const RESOURCE = 'mattermost';

function config(id: string, mode: string, home: string, log?: string): EndpointConfig {
  return { id, transport: 'stdio', command: process.execPath, args: [child, mode], env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin', MATTERMOST_URL: 'https://chat.peat-cloud.com', LOGNAME: '', SHELL: '', TERM: '', USER: '', ...(log === undefined ? {} : { DIDI_FAKE_MATTERMOST_LOG: log }) }, account: ACCOUNT, resource: RESOURCE };
}

function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-'));
  const log = join(dir, 'calls.log');
  const registry = new McpRegistry();
  registry.register(config('mattermost', mode, dir, log));
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  return { dir, registry, adapter, calls: (): { name: string; arguments: Record<string, unknown> }[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> }) : [] };
}

async function approve(adapter: McpPort, registry: McpRegistry, names: readonly string[] = [...MATTERMOST_TOOLS]) {
  const discovery = await adapter.discover('mattermost');
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId: 'mattermost', schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return discovery.schemaDigest;
}

function reader(adapter: McpPort, registry: McpRegistry, schemaDigest: string) {
  return createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxLimit: 60, queryChars: 200 } });
}

// #661: a fake channel child whose list_channels declares its own page size, and whose paging
// argument, when declared, is followed. No listening socket: the transport answers a mocked fetch.
type ChannelRow = { id: string; name: string; displayName: string };

async function channelReader(t: TestContext, options: { channels: ChannelRow[]; paging: 'offset' | 'none'; pageSize: number; failPage?: number }) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const listSchema = options.paging === 'offset'
    ? { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: options.pageSize }, offset: { type: 'integer', minimum: 0 } } }
    : { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: options.pageSize } } };
  const sdk = new Server({ name: 'synthetic-channels', version: '1' }, { capabilities: { tools: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  sdk.setRequestHandler('tools/list', () => ({ tools: [
    { name: 'mattermost_list_channels', inputSchema: listSchema },
    { name: 'mattermost_get_channel_history', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'integer', minimum: 1 } } } },
  ] }) as never);
  sdk.setRequestHandler('tools/call', request => {
    const args: Record<string, unknown> = request.params.arguments ?? {};
    calls.push({ name: request.params.name, arguments: args });
    if (request.params.name === 'mattermost_list_channels') {
      const limit = Math.min(Number(args['limit'] ?? 12), options.pageSize);
      const offset = options.paging === 'offset' ? Number(args['offset'] ?? 0) : 0;
      if (options.failPage !== undefined && offset / limit === options.failPage) return { content: [{ type: 'text', text: 'page failed' }], isError: true };
      const channels = options.channels.slice(offset, offset + limit).map(channel => ({ id: channel.id, name: channel.name, display_name: channel.displayName }));
      return { content: [{ type: 'text', text: JSON.stringify({ count: options.channels.length, channels }) }], isError: false };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ total: 0, returned: 0, results: [] }) }], isError: false };
  });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.method === 'GET' ? new Response(null, { status: 405 }) : transport.handleRequest(request);
  });
  const registry = new McpRegistry();
  registry.register({ id: 'channels', url: 'http://127.0.0.1:18767/mcp', account: 'synthetic', resource: 'synthetic' });
  registry.enable('channels'); registry.allowEgress('channels');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  t.after(async () => { await adapter.close(); await sdk.close(); });
  const discovery = await adapter.discover('channels');
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId: 'channels', schemaDigest: discovery.schemaDigest, toolNames: ['mattermost_list_channels', 'mattermost_get_channel_history'], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const port = createMattermostReader({ port: adapter, registry, config: { endpointId: 'channels', account: 'synthetic', resource: 'synthetic', schemaDigest: discovery.schemaDigest, generation: 1, maxLimit: 60, queryChars: 200 } });
  return { port, calls };
}

/** Forty channels, numbered so one sits past the first dozen. */
function fortyChannels(): ChannelRow[] {
  return Array.from({ length: 40 }, (_, index) => ({
    id: `idChannel${String(index + 1).padStart(2, '0')}`,
    name: `channel-${String(index + 1).padStart(2, '0')}`,
    displayName: `Channel ${String(index + 1).padStart(2, '0')}`,
  }));
}

test('channel history projects Markdown with bounded fields and permalink sources', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).getChannelHistory({ channel: 'town-square', limit: 20 });
  assert.equal(result.state, 'completed');
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.match(projected.projection.text, /town-square \| rob \| 2026-10-11T10:00:00\.000Z/);
  assert.match(projected.projection.text, /Standup at ten/);
  assert.equal(/https?:\/\//.test(projected.projection.text), false, 'mattermost model text holds no raw url');
  // get_channel_history shapes newest first (M1, commit 5d75587); permalink sources follow that order.
  assert.deepEqual(projected.projection.sources, [
    { title: 'Mattermost: #town-square', url: 'https://chat.peat-cloud.com/team/pl/longbody0000000000000000000000', sourceType: 'mattermost' },
    { title: 'Mattermost: #town-square', url: 'https://chat.peat-cloud.com/team/pl/0987654321fedcba0987654321', sourceType: 'mattermost' },
    { title: 'Mattermost: #town-square', url: 'https://chat.peat-cloud.com/team/pl/abcdef1234567890abcdefghij', sourceType: 'mattermost' },
  ]);
});

test('a message body is clipped to the per-post bound with an omission note', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).search({ query: 'standup' });
  assert.equal(result.state, 'completed');
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.ok(projected.projection.text.includes('L'.repeat(250)), 'the bounded body reaches the model');
  assert.equal(projected.projection.text.includes('L'.repeat(251)), false, 'a body over the 250-character bound is clipped');
  assert.match(projected.projection.text, /\[omitted: \d+ characters; final/);
});

test('only the read envelope is eligible; a granted writer refuses the whole call', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry, [...MATTERMOST_TOOLS, 'mattermost_post_message']);
  const result = await reader(f.adapter, f.registry, digest).whoami();
  assert.equal(result.state, 'refused');
  assert.equal(result.state === 'refused' ? result.reason : '', 'ineligible-tool-granted');
});

test('a missing session reports auth-needed, never an empty success', async t => {
  const f = setup('auth-needed');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).whoami();
  assert.equal(result.state, 'tool-error');
  if (result.state !== 'tool-error') throw new Error('not a tool error');
  assert.deepEqual(mattermostToolStatus(result), { state: 'configured', reason: MATTERMOST_AUTH_NEEDED });
});

test('input budgets refuse malformed arguments before any wire call', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const r = reader(f.adapter, f.registry, digest);
  assert.equal((await r.getChannelHistory({ channel: '' })).state, 'refused');
  assert.equal((await r.getThread({ postId: '' })).state, 'refused');
  assert.equal((await r.search({ query: '   ' })).state, 'refused');
  assert.equal((await r.listChannels({ limit: 9999 })).state, 'refused');
});

test('a thread read sends only the arguments the child declares, so the thread body reaches the model', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).getThread({ postId: 'abcdef1234567890abcdefghij' });
  assert.equal(result.state, 'completed');
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.ok(projected.projection.text.includes('Standup at ten'), 'the thread body reaches the model');
});

test('a tool outside the read grant refuses before dispatch', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry, MATTERMOST_TOOLS.filter(name => name !== 'mattermost_get_thread'));
  const result = await reader(f.adapter, f.registry, digest).getThread({ postId: 'post-1' });
  assert.equal(result.state, 'refused');
  assert.equal(result.state === 'refused' ? result.reason : '', 'tool-not-granted');
});

// Fake MCP HTTP server at the real guarded-fetch seam, no listening socket or corpus.
test('mattermost_whoami projects an SSE MCP entity from separately decodedResult', async t => {
  const sdk = new Server({ name: 'synthetic-sse', version: '1' }, { capabilities: { tools: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: false });
  const tool = { name: 'mattermost_whoami', inputSchema: { type: 'object' } };
  sdk.setRequestHandler('tools/list', () => ({ tools: [tool] }) as never);
  sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ username: 'Synthetic SSE', display_name: 'Synthetic Reader' }) }], structuredContent: { marker: 'synthetic-unclassified' }, isError: false }) as never);
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.method === 'GET' ? new Response(null, { status: 405 }) : transport.handleRequest(request);
  });
  const registry = new McpRegistry();
  registry.register({ id: 'sse', url: 'http://127.0.0.1:18766/mcp', account: 'synthetic', resource: 'synthetic' });
  registry.enable('sse'); registry.allowEgress('sse');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  t.after(async () => { await adapter.close(); await sdk.close(); });
  const discovery = await adapter.discover('sse'); assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw Error('discovery failed');
  registry.approve({ endpointId: 'sse', schemaDigest: discovery.schemaDigest, toolNames: ['mattermost_whoami'], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const result = await createMattermostReader({ port: adapter, registry, config: { endpointId: 'sse', account: 'synthetic', resource: 'synthetic', schemaDigest: discovery.schemaDigest, generation: 1, maxLimit: 60, queryChars: 200 } }).whoami();
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed' || result.response.state !== 'available') throw Error('missing result');
  const wire = adapter.readSlice({ ...result.source, handle: result.response.handle, offset: 0, length: 16 });
  assert.equal(wire.state, 'available');
  if (wire.state === 'available') assert.match(new TextDecoder().decode(wire.bytes), /^event:|^data:/);
  const projected = projectMattermostResult(adapter, result); assert.equal(projected.ok, true);
  if (!projected.ok) throw Error('projection failed');
  assert(projected.projection.text.includes('Synthetic SSE'));
  assert(!projected.projection.text.includes('synthetic-unclassified'));
});

test('an unknown channel name fails loud with the closest known names', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).getChannelHistory({ channel: 'town-squar', limit: 20 });
  assert.equal(result.state, 'refused');
  assert.match(result.state === 'refused' ? result.reason : '', /channel-not-found: town-squar; closest names: Town Square/);
});

test('channel resolution maps id, name and display name, and names the closest matches', () => {
  const channels = [{ id: 'abcdefghijklmnopqrstuvwxzy', name: 'town-square', displayName: 'Town Square' }];
  assert.deepEqual(resolveChannelReference('Town Square', channels), { channel: 'abcdefghijklmnopqrstuvwxzy' });
  assert.deepEqual(resolveChannelReference('town-square', channels), { channel: 'abcdefghijklmnopqrstuvwxzy' });
  assert.deepEqual(resolveChannelReference('abcdefghijklmnopqrstuvwxzy', channels), { channel: 'abcdefghijklmnopqrstuvwxzy' });
  const miss = resolveChannelReference('off-topic', channels);
  assert.equal('error' in miss && miss.error.startsWith('channel-not-found: off-topic'), true);
  const ambiguous = resolveChannelReference('Town Square', [{ name: 'a', displayName: 'Town Square' }, { name: 'b', displayName: 'Town Square' }]);
  assert.equal('error' in ambiguous && ambiguous.error.startsWith('channel-ambiguous: Town Square matches '), true);
  assert.deepEqual(parseChannelList({ result: { content: [{ type: 'text', text: JSON.stringify({ channels }) }] } }), channels);
});

test('the research chat thread read uses the argument name the child declares, so the thread body reaches the answer', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  await approve(f.adapter, f.registry);
  const dispatched: string[] = [];
  const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => Promise.all(subs.map(async call => {
    dispatched.push(call.name);
    if (call.name !== 'mattermost_get_thread') {
      const text = '**team** [post abcdef1234567890abcdefghij]\nstandup thread started';
      return { key: call.key, name: call.name, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 };
    }
    const result = await f.adapter.call({ endpointId: 'mattermost', toolName: call.name, arguments: call.args as Record<string, unknown>, generation: 1, account: ACCOUNT, resource: RESOURCE });
    // Shape the read the way the host does before it reaches the model.
    const projected = result.state === 'completed'
      ? projectMattermostResult(f.adapter, { decodedResult: result.decodedResult, state: 'completed', tool: call.name, source: result.source, observedAt: Date.now(), coverage: result.coverage, projection: result.projection, response: result.payload })
      : { ok: false as const, reason: result.state };
    const text = projected.ok ? projected.projection.text : '';
    return { key: call.key, name: call.name, ok: projected.ok, text, originalCharacters: text.length, omittedCharacters: 0 };
  }));
  const deps: ResearchDeps = {
    now: () => 0, configured: ['chat'], execute, emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'what did the team say about the standup', topic: 'what did the team say about the standup' }, new AbortController().signal);
  assert.ok(dispatched.includes('mattermost_get_thread'), 'the thread follow-up runs');
  const findings = reply['findings'] as { text?: string }[];
  assert.ok(JSON.stringify(findings).includes('Standup at ten'), 'the thread body reaches the answer, never an empty failure');
});

// #351: the connector's own process fails before the MCP handshake (a missing build, a moved
// binary, a crashed child), so the host must name the cause instead of "unknown".
test('a connector that cannot start reports a typed spawn reason and the child exit code', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-'));
  const registry = new McpRegistry();
  registry.register({ ...config('mattermost', 'ok', dir), args: [join(dir, 'missing-connector.cjs')] });
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  t.after(async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  const started = Date.now();
  const result = await adapter.discover('mattermost');
  const elapsed = Date.now() - started;
  assert.equal(result.state, 'unavailable');
  if (result.state !== 'unavailable') throw new Error('not unavailable');
  assert.equal(result.reason, 'connector-unavailable', 'the reason names a connector that never started');
  assert.equal(result.exception?.code, 'child_exited', 'the child exited before the handshake');
  assert.ok(elapsed < 2000, `a dead connector fails fast, took ${elapsed} ms`);
});

// #351: a connector that exited before its handshake is stable for the whole host start, so the
// host logs one typed reason and never spends the bounded retry on it.
test('a dead connector classifies as a spawn failure, so its discovery is never retried', () => {
  assert.equal(mongooseFailureStage('connector-unavailable', 'child_exited'), 'spawn');
  assert.notEqual(mongooseFailureStage('connector-unavailable', 'child_exited'), 'first_call');
});

// #351: when the connector itself is down, a chat lookup is reported unreachable at once, instead of
// paying a source deadline on reads that cannot reach it.
test('a chat lookup settles unavailable at once when the mattermost connector is down', async () => {
  const dispatched: string[] = [];
  const deps: ResearchDeps = {
    now: () => 0, configured: ['chat'], unavailableNow: () => ['chat'],
    execute: async subs => {
      for (const call of subs) dispatched.push(call.name);
      return subs.map(call => ({ key: call.key, name: call.name, ok: true, text: 'evidence', originalCharacters: 8, omittedCharacters: 0 }));
    },
    emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'what did the team say about the standup', topic: 'what did the team say about the standup', lookups: [{ source: 'chat', query: 'standup' }] }, new AbortController().signal);
  assert.equal(reply['sources'] && (reply['sources'] as Record<string, string>)['chat'], 'unavailable');
  assert.match(String(reply['note']), /could not reach team chat/, 'the answer says chat is unreachable, never that it searched and found nothing');
  assert.deepEqual(dispatched, [], 'no sub-call is dispatched to a connector that cannot answer');
});

// #581: a chat window written as an inline `After:` made the child rank the whole archive by relevance
// before it filtered. The window now rides the child's own from_date, with sort=newest.
test('#581: a chat window ask sends from_date and sort newest and no inline After:', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const research = reader(f.adapter, f.registry, digest);
  const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => Promise.all(subs.map(async call => {
    const window = typeof call.args['after'] === 'string' ? { after: call.args['after'] } : {};
    const result = await research.search({ query: String(call.args['query'] ?? ''), limit: Number(call.args['limit'] ?? 5), ...window });
    const projected = result.state === 'completed' ? projectMattermostResult(f.adapter, result) : { ok: false as const };
    const text = projected.ok ? projected.projection.text : '';
    return { key: call.key, name: call.name, ok: projected.ok, text, originalCharacters: text.length, omittedCharacters: 0 };
  }));
  const deps: ResearchDeps = {
    now: () => Date.parse('2026-10-21T05:30:00Z'), timeZone: 'Asia/Kolkata', configured: ['chat'], execute, emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'what did the team say about the release freeze this week' }, new AbortController().signal);
  const searches = f.calls().filter(call => call.name === 'mattermost_search');
  assert.ok(searches.length > 0, 'the chat read reached the child');
  const first = searches[0]!;
  // C-CHAT: "this week" starts on Monday in the owner's zone (2026-10-21 is a Wednesday), the calendar's own rule.
  assert.equal(first.arguments['from_date'], '2026-10-19', 'the window is the week the ask named, in the child own argument');
  assert.equal(first.arguments['sort'], 'newest', 'a windowed read is newest first');
  assert.ok(!String(first.arguments['query']).includes('After:'), 'no inline operator rides the query text');
  assert.doesNotMatch(String(first.arguments['query']), /\b(what|did|about|say|this)\b/i, 'the query carries topic words only, never a stop word or a continuation word');
  assert.ok((reply['findings'] as unknown[]).length > 0, 'the read reaches the answer');
});

// #647: the child defaults a search to hybrid, which embeds the query on CPU over the whole archive, so
// one chat read took tens of seconds. Every search this connector sends asks for keyword mode.
test('#647: a search asks the child for keyword mode, never hybrid or semantic', async () => {
  // The search schema the real mattermost-mcp child publishes, `mode` included (#647 re-read the child).
  const tools: ReturnType<McpPort['visibleTools']> = [{
    name: 'mattermost_search', description: 'Synthetic mattermost_search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'] }, limit: { type: 'integer', minimum: 1, maximum: 50 }, from_date: { type: 'string' }, to_date: { type: 'string' }, sort: { type: 'string', enum: ['relevance', 'newest'] } } },
  }];
  const sent: Record<string, unknown>[] = [];
  // The registry hands back the canonical digest of exactly these tools, the way the adapter's discovery does.
  const registry = new McpRegistry();
  registry.register(config('mattermost', 'ok', tmpdir()));
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const digest = registry.observed('mattermost', tools, registry.revision('mattermost'));
  const scope = { endpointId: 'mattermost', url: 'https://chat.example.invalid', schemaDigest: digest, generation: 1, account: ACCOUNT, resource: RESOURCE };
  const port: McpPort = {
    discover: async () => ({ state: 'discovered', endpointId: 'mattermost', schemaDigest: digest, tools, observedAt: 0 }),
    visibleTools: () => tools,
    call: async request => {
      sent.push({ ...(request.arguments as Record<string, unknown>) });
      return {
        state: 'completed', decodedResult: { content: [{ type: 'text', text: JSON.stringify({ total: 0, returned: 0, results: [] }) }] },
        source: { ...scope, toolName: request.toolName }, coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
        freshness: { receivedAt: 0, sourceVersion: 'unknown' }, projection: { text: '', omitted: false, originalCharacters: 0, omittedCharacters: 0 },
        payload: { state: 'unavailable', reason: 'capacity' },
      } as CompletedResult;
    },
    readSlice: () => ({ state: 'unavailable', reason: 'capacity' }),
    whenSuspended: async () => {},
    close: async () => {},
  };
  registry.approve({ endpointId: 'mattermost', schemaDigest: digest, toolNames: ['mattermost_search'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  assert.equal((await reader(port, registry, digest).search({ query: 'release freeze' })).state, 'completed');
  assert.deepEqual(sent.map(args => args['mode']), ['keyword'], 'the read never leaves the child free to embed the query');
  assert.equal(sent[0]!['query'], 'release freeze');
});

// #647: keyword is an every-term match, so a paraphrased ask can miss. One retry with the single most
// specific term, and the answer says the match was broadened, never that chat held nothing.
test('#647: an empty multi-term chat search earns one single-term retry and a broadened note', async () => {
  const dispatched: IntentSubCall[] = [];
  const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => subs.map(call => {
    dispatched.push({ key: call.key, name: call.name, args: { ...call.args } });
    const broadened = String(call.args['query']) === 'release';
    const text = broadened ? '- the release freeze moved to Monday, from Ana [post abcdef1234567890abcdefghij]' : '';
    return { key: call.key, name: call.name, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 };
  });
  const deps: ResearchDeps = {
    now: () => Date.parse('2026-10-21T05:30:00Z'), timeZone: 'Asia/Kolkata', configured: ['chat'], execute, emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'what did the team say about the release freeze' }, new AbortController().signal);
  const searches = dispatched.filter(call => call.name === 'mattermost_search');
  assert.deepEqual(searches.map(call => [call.args['query'], call.args['from_date']]), [['release freeze', undefined], ['release', undefined]], 'the empty multi-term read earns exactly one retry with the single most specific term');
  assert.match(String(reply['note']), /broadened/, 'the answer says the match was broadened');
  assert.ok((reply['findings'] as unknown[]).length > 0, 'the broadened read reaches the answer');
});

// #610: a channel named in the ask is resolved through list_channels, then searched once with the
// filter the child declares; an unknown name is one closed refusal, not another archive search.
test('#610: a channel named in the ask resolves through the channel list and filters the search', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const result = await r.search({ query: 'latest topics', channel: 'Dogcation' });
  assert.equal(result.state, 'completed');
  const names = f.calls().map(call => call.name);
  assert.deepEqual(names, ['mattermost_list_channels', 'mattermost_search']);
  const search = f.calls().find(call => call.name === 'mattermost_search');
  assert.equal(search?.arguments['channel'], 'chanDogcation', 'the resolved id carries the filter');
  assert.equal(search?.arguments['sort'], 'newest');
});

test('#637: an unknown channel name is one closed refusal with no archive search', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const result = await r.search({ query: 'latest topics', channel: 'nowhere' });
  assert.equal(result.state === 'refused' ? result.reason : result.state, 'channel-not-found: nowhere; closest names: Town Square, Dogcation');
  assert.ok(!f.calls().some(call => call.name === 'mattermost_search'), 'no archive search follows a missing channel');
});

// #637: an owner names a channel by the words he sees, so a plain word reference resolves the display
// name and the name alike, and two channels that carry the word are named, never picked.
test('#637: a plain words channel reference resolves its words, and names the channels when several do', () => {
  const aiTeam = [{ id: 'chan-ai-team', name: 'ai-team', displayName: 'AI Team' }];
  const aiMl = [{ id: 'chan-ai-ml', name: 'ai-ml', displayName: 'AI/ML' }];
  assert.deepEqual(resolveChannelReference('ai', aiTeam), { channel: 'chan-ai-team' });
  assert.deepEqual(resolveChannelReference('ai', aiMl), { channel: 'chan-ai-ml' });
  const both = resolveChannelReference('ai', [...aiTeam, ...aiMl]);
  assert.equal('error' in both && both.error.startsWith('channel-ambiguous: ai matches '), true);
  const conference = [{ id: 'chan-singapore', name: 'singapore-conference-2026', displayName: 'Singapore Conference 2026' }];
  assert.deepEqual(resolveChannelReference('singapore conference', conference), { channel: 'chan-singapore' });
  const miss = resolveChannelReference('singapore summit', conference);
  assert.equal('error' in miss && miss.error.startsWith('channel-not-found: singapore summit'), true);
  assert.equal('error' in resolveChannelReference('!!!', conference), true, 'a reference with no words resolves nothing');
});

// #637 CHANNELS-R6 (a): a refused channel read driven through the real tools owner records the closed
// code channel_not_found, and no wide archive read is issued for it.
test('#637: a refused channel read through the real tools owner records the closed code', async t => {
  const f = setup('ok');
  const store = new Store(join(f.dir, 'data'), toolsMigrations);
  t.after(async () => { await f.adapter.close(); store.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const discovered = await f.adapter.discover('mattermost');
  assert.equal(discovered.state, 'discovered');
  if (discovered.state !== 'discovered') throw new Error('not discovered');
  let live: LiveAuthority | null = null;
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry: f.registry, port: f.adapter, lookupAuthority: async () => live });
  owner.applyConnection({
    schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mattermost', generation: 1, enabled: true, connector: 'mattermost',
    endpoint: { ...config('mattermost', 'ok', f.dir, join(f.dir, 'calls.log')), credentialRef: null },
    toolNames: [...MATTERMOST_TOOLS], schemaDigest: discovered.schemaDigest,
    sourcePolicy: { id: 'mattermost-read', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'voice', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 20000, maxResultBytes: 200000 },
  } as never);
  // applyConnection suspends the grant; a fresh discovery followed by the projection publishes it.
  const again = await f.adapter.discover('mattermost');
  assert.equal(again.state, 'discovered');
  owner.projectConnection('mattermost');
  const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1,
    route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['ordinary'] }, allowedClasses: ['ordinary'], connectionIds: ['mattermost'] };
  const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
  live = { ...acceptance, acceptedRunHash: accepted.sha256 };
  // The run's own read grants, the same shape the host hands a real run.
  const host = { ...live, grants: MATTERMOST_TOOLS.map(tool => ({ tool, effect: 'read', accountId: ACCOUNT, resourceId: RESOURCE })) };
  const batch = await runToolCalls(owner, [{ id: 's0', name: 'mattermost_search', args: { query: 'release', channel: 'nowhere' } }], {
    registry: owner.definitions('run'), host: host as never, authority: { isCurrent: async () => true } as never,
    control: { signal: new AbortController().signal, deadlineMs: Date.now() + 5000 }, step: 0, contentIndex: 0, seenIds: new Set<string>(), baseClasses: ['ordinary'],
  });
  const record = batch.tools.find(entry => entry.callId === 's0');
  assert.equal(record?.status, 'failed');
  assert.equal(record?.reason, 'channel_not_found', 'the refused read records the closed code the reply keys on');
  assert.ok(!f.calls().some(call => call.name === 'mattermost_search'), 'no wide archive search follows the unknown channel');
});

// #614: the fixture answers the installed child's real envelopes, so a decode that only knew the
// old {posts} shape would read nothing here.
test('#614: the installed child envelopes reach the model as posts', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const history = await r.getChannelHistory({ channel: 'town-square', limit: 8 });
  const projected = projectMattermostResult(f.adapter, history);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.ok(projected.projection.text.includes('Standup at ten'), 'a results envelope is a post list');
  assert.equal(projected.projection.itemCount, 3);
  const thread = await r.getThread({ postId: 'postStandup' });
  const threadText = projectMattermostResult(f.adapter, thread);
  assert.ok(threadText.ok && threadText.projection.text.includes('On it'), 'a root and replies envelope reaches the model');
});

// #661: the channel index covers the child's whole channel list, so a name past the first bounded
// page still resolves, and the paging travels in the dispatch log.
test('#661: a channel name past the first page resolves through the declared paging', async t => {
  const { port, calls } = await channelReader(t, { channels: fortyChannels(), paging: 'offset', pageSize: 12 });
  const result = await port.getChannelHistory({ channel: 'channel-31', limit: 5 });
  assert.equal(result.state, 'completed');
  const list = calls.filter(call => call.name === 'mattermost_list_channels');
  assert.deepEqual(list.map(call => call.arguments), [
    { limit: 12, offset: 0 }, { limit: 12, offset: 12 }, { limit: 12, offset: 24 }, { limit: 12, offset: 36 },
  ]);
  const history = calls.filter(call => call.name === 'mattermost_get_channel_history');
  assert.equal(history.at(-1)?.arguments['channel'], 'idChannel31');
});

// #661: a child that declares no paging argument is asked once at its declared maximum.
test('#661: a child without a paging argument is read once at its declared maximum', async t => {
  const { port, calls } = await channelReader(t, { channels: fortyChannels(), paging: 'none', pageSize: 50 });
  const result = await port.getChannelHistory({ channel: 'channel-31', limit: 5 });
  assert.equal(result.state, 'completed');
  const list = calls.filter(call => call.name === 'mattermost_list_channels');
  assert.deepEqual(list.map(call => call.arguments), [{ limit: 50 }]);
  const history = calls.filter(call => call.name === 'mattermost_get_channel_history');
  assert.equal(history.at(-1)?.arguments['channel'], 'idChannel31');
});

// #661: a channel created after the index was built is found by one refresh, not a refusal.
test('#661: a channel created after the index build resolves after one refresh', async t => {
  const channels = fortyChannels();
  const { port, calls } = await channelReader(t, { channels, paging: 'offset', pageSize: 12 });
  assert.equal((await port.getChannelHistory({ channel: 'channel-31', limit: 5 })).state, 'completed');
  const built = calls.filter(call => call.name === 'mattermost_list_channels').length;
  channels.push({ id: 'idDogpark', name: 'dogpark', displayName: 'Dogpark' });
  const result = await port.getChannelHistory({ channel: 'dogpark', limit: 5 });
  assert.equal(result.state, 'completed');
  assert.ok(calls.filter(call => call.name === 'mattermost_list_channels').length > built, 'one refresh read the new channel');
  const history = calls.filter(call => call.name === 'mattermost_get_channel_history');
  assert.equal(history.at(-1)?.arguments['channel'], 'idDogpark');
});

// #661: a page that fails is a closed refusal, never a silently short index.
test('#661: a failed page refuses the whole channel index with a closed code', async t => {
  const { port } = await channelReader(t, { channels: fortyChannels(), paging: 'offset', pageSize: 12, failPage: 1 });
  const result = await port.getChannelHistory({ channel: 'channel-31', limit: 5 });
  assert.equal(result.state, 'refused');
  assert.match(result.state === 'refused' ? result.reason : '', /^channel-list-[a-z-]+$/);
});

// #661: the refusal names at most three closest channels, ranked by the word matcher's score.
test('#661: a refusal carries up to three closest channel names by word score', () => {
  const channels = [
    { id: 'idSummit', name: 'singapore-summit', displayName: 'Singapore Summit' },
    { id: 'idOffice', name: 'singapore-office', displayName: 'Singapore Office' },
    { id: 'idStandup', name: 'singapore-standup', displayName: 'Singapore Standup' },
    { id: 'idArchive', name: 'singapore-archive', displayName: 'Singapore Archive' },
    { id: 'idAlerts', name: 'singapore-alerts', displayName: 'Singapore Alerts' },
  ];
  const miss = resolveChannelReference('singapore summit office', channels);
  assert.equal('error' in miss && miss.error, 'channel-not-found: singapore summit office; closest names: Singapore Summit, Singapore Office, Singapore Standup');
});
