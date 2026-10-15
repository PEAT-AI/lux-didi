import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { EndpointConfig, McpPort } from '../adapters/mcp/port.js';
import { createMattermostReader, MATTERMOST_AUTH_NEEDED, MATTERMOST_TOOLS, parseChannelList, resolveChannelReference } from '../connectors/index.js';
import { mattermostToolStatus, projectMattermostResult } from '../tools/mattermost.js';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'stdio-mattermost-child.mjs');
const ACCOUNT = 'local';
const RESOURCE = 'mattermost';

function config(id: string, mode: string, home: string): EndpointConfig {
  return { id, transport: 'stdio', command: process.execPath, args: [child, mode], env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin', MATTERMOST_URL: 'https://chat.peat-cloud.com', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: ACCOUNT, resource: RESOURCE };
}

function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-'));
  const registry = new McpRegistry();
  registry.register(config('mattermost', mode, dir));
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  return { dir, registry, adapter };
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

test('channel history projects Markdown with bounded fields and permalink sources', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).getChannelHistory({ channel: 'town-square', limit: 20 });
  assert.equal(result.state, 'completed');
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.match(projected.projection.text, /town-square \| Rob \| 2026-10-11T10:00:00Z/);
  assert.match(projected.projection.text, /Standup at ten/);
  assert.match(projected.projection.text, /source: https:\/\/chat\.peat-cloud\.com\/team\/pl\/abcdef1234567890abcdefghij/);
});

test('a long message body is kept in full (no per-field clip)', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).search({ query: 'standup' });
  assert.equal(result.state, 'completed');
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  const long = 'L'.repeat(700);
  assert.ok(projected.projection.text.includes(long), 'the full message body must reach the model');
  assert.equal(projected.projection.text.includes('[omitted:'), false, 'a body under the message bound is not cut');
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
  assert.equal((await r.getThread({ postId: 'p', limit: 0 })).state, 'refused');
  assert.equal((await r.search({ query: '   ' })).state, 'refused');
  assert.equal((await r.listChannels({ limit: 9999 })).state, 'refused');
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
