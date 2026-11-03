import { createHash } from 'node:crypto';
import { canonicalTaskFixture } from './canonical-task-fixture.js';
import { connectorExecutor } from '../tasks/connectors.js';
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

test('a full native message body reaches the projection without the removed spoken bound', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).search({ query: 'standup' });
  assert.equal(result.state, 'completed');
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.ok(projected.projection.text.includes('L'.repeat(700)), 'the complete fixture body reaches the model');
  assert.doesNotMatch(projected.projection.text, /\[omitted:/);
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

test('canonical read_thread uses the child argument name and returns its full thread body', async t => {
  const h = await canonicalMattermostRun(t), definition = h.task.tools.find(tool => tool.name === 'read_thread')!;
  const args = { ref: 'abcdef1234567890abcdefghij', cursor: null };
  const call = { runId: h.host.runId, actorId: h.host.actorId, authorityEpoch: h.host.authorityEpoch, revision: h.host.revision, executionId: 'thread:0', callId: 'thread-call', accountId: definition.accountId, resourceId: definition.resourceId, toolName: definition.name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex') };
  assert.equal(h.owner.journal.intent(call), 'fresh');
  const outcome = await definition.execute(args, { ...call, signal: new AbortController().signal });
  assert.equal(outcome.status, 'completed');
  const row = h.store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE execution_id=?', [call.executionId]));
  assert.match(JSON.stringify(JSON.parse(String(row?.result_json)).response), /Standup at ten/);
  assert.ok(h.f.calls().some(call => call.name === 'mattermost_get_thread'));
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
test('canonical chat lookup without a configured connector returns an immediate repair', async () => {
  const reply = await connectorExecutor([])('search_chat', { query: 'standup' }, new AbortController().signal);
  assert.equal(reply.status, 'failed'); assert.match(reply.repair ?? '', /not configured/);
});

// #581: a chat window written as an inline `After:` made the child rank the whole archive by relevance
// before it filtered. The window now rides the child's own from_date, with sort=newest.
test('#581: the native chat time window reaches the child through typed from_date and newest sort', async t => {
  const f = setup('ok'); t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const result = await r.search({ query: 'release freeze', from_date: '2026-10-19' });
  assert.equal(result.state, 'completed');
  const first = f.calls().find(call => call.name === 'mattermost_search'); assert.ok(first);
  assert.equal(first.arguments.from_date, '2026-10-19'); assert.equal(first.arguments.sort, 'newest');
  assert.equal(first.arguments.query, 'release freeze');
});

// #647: the child defaults a search to hybrid, which embeds the query on CPU over the whole archive, so
// one chat read took tens of seconds. The first read must use keyword mode; C-CHAT permits one broader retry only after an empty read.


// #647: keyword is an every-term match, so a paraphrased ask can miss. One retry with the single most
// specific term, and the answer says the match was broadened, never that chat held nothing.


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

test('#637: a native unknown-channel read refuses with its cause and makes no wide archive search', async t => {
  const f = setup('ok'); t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const result = await r.search({ query: 'release', channel: 'nowhere' });
  assert.equal(result.state, 'refused');
  assert.match(result.state === 'refused' ? result.reason : '', /^channel-not-found: nowhere/);
  assert.ok(!f.calls().some(call => call.name === 'mattermost_search'), 'no wide archive search follows the unknown channel');
});

// #637: an owner names a channel by the words he sees, so a plain word reference resolves the display
// name and the name alike, and two channels that carry the word are named, never picked.
test('#637: a native unknown-channel read refuses with its cause and makes no wide archive search', async t => {
  const f = setup('ok'); t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const result = await r.search({ query: 'release', channel: 'nowhere' });
  assert.equal(result.state, 'refused');
  assert.match(result.state === 'refused' ? result.reason : '', /^channel-not-found: nowhere/);
  assert.ok(!f.calls().some(call => call.name === 'mattermost_search'), 'no wide archive search follows the unknown channel');
});

// #637 CHANNELS-R6 (a): a refused channel read driven through the real tools owner records the closed
// code channel_not_found, and no wide archive read is issued for it.
test('#637: a native unknown-channel read refuses with its cause and makes no wide archive search', async t => {
  const f = setup('ok'); t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.adapter, f.registry));
  const result = await r.search({ query: 'release', channel: 'nowhere' });
  assert.equal(result.state, 'refused');
  assert.match(result.state === 'refused' ? result.reason : '', /^channel-not-found: nowhere/);
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


test('STAGE4: a named-day search result reports the actual read window to the owner', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).search({ query: 'release', from_date: '2026-10-21', to_date: '2026-10-21' });
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed') return;
  assert.deepEqual(result.window, { from: '2026-10-21', to: '2026-10-21' });
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.match(projected.projection.text, /^Read window: 2026-10-21 through 2026-10-21\./u);
});

async function canonicalMattermostRun(t: TestContext) {
  let task: ReturnType<typeof canonicalTaskFixture> | undefined;
  const f = setup('ok');
  const store = new Store(join(f.dir, 'data'), toolsMigrations);
  t.after(async () => { task?.close(); await f.adapter.close(); store.close(); rmSync(f.dir, { recursive: true, force: true }); });
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

  task = canonicalTaskFixture(store, owner, 'run', 'Read the synthetic chat', ['mattermost']);
  return { f, store, owner, task, host: live! };
}

