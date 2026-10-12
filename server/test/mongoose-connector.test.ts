import { connectorDescriptor } from '../connectors/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { McpPort, ToolDefinition } from '../adapters/mcp/port.js';
import { createMongooseReader, MONGOOSE_TOOLS } from '../connectors/index.js';
import { projectMongooseResult } from '../tools/mongoose.js';
import { Store } from '../runtime/store.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { toolsMigrations } from '../tools/index.js';

const ACCOUNT = 'account-a';
const RESOURCE = 'resource-a';

const readTools: ToolDefinition[] = MONGOOSE_TOOLS.map(name => ({ name, inputSchema: { type: 'object' } }));
// Advisory readOnlyHint must never turn a writer into authority.
const writeTools: ToolDefinition[] = [
  { name: 'create_ticket', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'claim_ticket', inputSchema: { type: 'object' } },
];

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface FixtureOptions { text?: string; requireBearer?: boolean; tools?: Array<{ name: string; inputSchema: Record<string, unknown> }> }
async function fixture(options: FixtureOptions = {}) {
  const calls: { name: unknown; arguments: unknown }[] = [];
  const requireBearer = options.requireBearer ?? true;
  const sdk = new Server({ name: 'synthetic-mongoose', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  sdk.setRequestHandler('tools/list', () => ({ tools: options.tools ?? [...readTools, ...writeTools] }) as never);
  sdk.setRequestHandler('tools/call', request => {
    const params = request.params as { name: string; arguments: Record<string, unknown> };
    calls.push({ name: params.name, arguments: params.arguments });
    return { content: [{ type: 'text', text: options.text ?? JSON.stringify({ items: [{ title: 'Agri input pricing', url: 'https://mongoose.dev.peat-cloud.com/knowledge/agri-pricing' }] }) }] } as never;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  await sdk.connect(transport);
  const listener = createServer(async (req, res) => {
    try {
      const bytes = await body(req);
      const method = bytes.length ? (JSON.parse(bytes.toString()) as { method?: string }).method : undefined;
      if (requireBearer && method !== 'tools/list' && req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); res.end(); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'GET', headers, ...(bytes.length ? { body: new Uint8Array(bytes) } : {}) });
      const response = await transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      const reader = response.body.getReader();
      res.on('close', () => { void reader.cancel().catch(() => {}); });
      while (!res.destroyed) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return { url, calls, async close() { await sdk.close().catch(() => {}); await new Promise<void>(resolve => listener.close(() => resolve())); } };
}

function adapterFor(url: string, resolveCredential: (ref: string) => Promise<string> = async () => 'test-token') {
  const registry = new McpRegistry();
  registry.register({ id: 'source', url, account: ACCOUNT, resource: RESOURCE, credentialRef: 'mongoose-mcp' });
  registry.enable('source'); registry.allowEgress('source');
  const store = new MemoryResultStore();
  const adapter = createMcpAdapter({ registry, store, resolveCredential });
  return { registry, store, adapter };
}

async function approve(adapter: McpPort, registry: McpRegistry, names: readonly string[] = [...MONGOOSE_TOOLS]) {
  const discovery = await adapter.discover('source');
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId: 'source', schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return discovery.schemaDigest;
}

function reader(adapter: McpPort, registry: McpRegistry, schemaDigest: string) {
  return createMongooseReader({ port: adapter, registry, config: { endpointId: 'source', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxSearchLimit: 10, maxListLimit: 10, queryChars: 200 } });
}

test('search round trip: exact outgoing arguments and opaque unknown/local-only evidence', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry);
  try {
    const result = await reader(adapter, registry, digest).search({ query: 'agri pricing', limit: 3 });
    assert.equal(result.state, 'completed');
    assert.deepEqual(f.calls, [{ name: 'search_mongoose', arguments: { query: 'agri pricing', limit: 3 } }]);
    const projected = projectMongooseResult(adapter, result);
    assert.equal(projected.ok, true);
    if (!projected.ok) return;
    assert.match(projected.projection.text, /- Agri input pricing/);
    assert.match(projected.projection.text, /source: https:\/\/mongoose\.dev\.peat-cloud\.com\/knowledge\/agri-pricing/);
  } finally { await adapter.close(); }
});

test('bearer missing is a typed refusal before an empty success', async t => {
  const f = await fixture(); t.after(() => f.close());
  let authed = true;
  const registry = new McpRegistry();
  registry.register({ id: 'source', url: f.url, account: ACCOUNT, resource: RESOURCE, credentialRef: 'mongoose-mcp' });
  registry.enable('source'); registry.allowEgress('source');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: async () => { if (!authed) throw new Error('revoked'); return 'test-token'; } });
  const digest = await approve(adapter, registry);
  try {
    authed = false;
    const result = await reader(adapter, registry, digest).search({ query: 'secret' });
    assert.ok(result.state === 'refused' || result.state === 'unknown', `expected a typed refusal, got ${result.state}`);
    assert.equal(projectMongooseResult(adapter, result).ok, false);
  } finally { await adapter.close(); }
});

test('only the read envelope is eligible; a granted writer refuses the whole call', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry, [...MONGOOSE_TOOLS, 'create_ticket']);
  try {
    const result = await reader(adapter, registry, digest).search({ query: 'agri' });
    assert.equal(result.state, 'refused');
    assert.equal(result.state === 'refused' ? result.reason : '', 'ineligible-tool-granted');
    assert.equal(f.calls.length, 0);
  } finally { await adapter.close(); }
});

test('a tool outside the read grant refuses before dispatch', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry, MONGOOSE_TOOLS.filter(name => name !== 'get_ticket'));
  try {
    const result = await reader(adapter, registry, digest).getTicket({ id: 'ticket-1' });
    assert.equal(result.state, 'refused');
    assert.equal(result.state === 'refused' ? result.reason : '', 'tool-not-granted');
  } finally { await adapter.close(); }
});

test('input budgets refuse malformed arguments before any wire call', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry);
  const r = reader(adapter, registry, digest);
  try {
    assert.equal((await r.search({ query: '   ' })).state, 'refused');
    assert.equal((await r.search({ query: 'ok', limit: 999 })).state, 'refused');
    assert.equal((await r.listTickets({ limit: 0 })).state, 'refused');
    assert.equal((await r.getTicket({ id: '' })).state, 'refused');
    assert.equal(f.calls.length, 0);
  } finally { await adapter.close(); }
});

test('a large Mongoose answer is projected as bounded, partial-marked Markdown', async t => {
  const f = await fixture({ text: 'x'.repeat(4096) }); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry);
  try {
    const result = await reader(adapter, registry, digest).companyProfile();
    assert.equal(result.state, 'completed');
    const projected = projectMongooseResult(adapter, result);
    assert.equal(projected.ok, true);
    if (!projected.ok) return;
    assert.equal(projected.projection.partial, true);
    assert.equal(projected.projection.text.length, 4000);
    assert.equal(projected.projection.originalCharacters, 4096);
    assert.equal(projected.projection.omittedCharacters, 96);
  } finally { await adapter.close(); }
});

test('owner-trusted-reads grants exactly the connector envelope through the runtime', async () => {
  const f = await fixture({ requireBearer: false });
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-runtime-'));
  let store: Store | undefined;
  let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
  try {
    const configDir = join(dir, 'provider-config');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      schemaVersion: 1, grantMode: 'owner-trusted-reads',
      endpoints: [{ id: 'mongoose', transport: 'streamable-http', url: f.url, connector: 'mongoose', account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true }],
    }), { mode: 0o600 });
    store = new Store(join(dir, 'data'), toolsMigrations);
    runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
    const grant = runtime.registry.currentGrant('mongoose');
    assert.ok(grant, 'the runtime must approve a read grant');
    assert.deepEqual([...grant.toolNames].sort(), [...MONGOOSE_TOOLS].sort());
    assert.equal(grant.toolNames.includes('create_ticket' as never), false);
    assert.equal(runtime.status().endpoints[0]?.tools, MONGOOSE_TOOLS.length);
    assert.equal(runtime.status().endpoints[0]?.state, 'connected');
    assert.deepEqual(runtime.connectionIds(), ['mongoose']);
    await runtime.refresh();
    assert.equal(runtime.status().endpoints[0]?.state, 'connected');
    assert.deepEqual(runtime.connectionIds(), ['mongoose']);
    assert.deepEqual(runtime.registry.currentGrant('mongoose')?.toolNames.slice().sort(), [...MONGOOSE_TOOLS].sort());
  } finally {
    if (runtime) await runtime.close();
    if (store) store.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [connector, tool] of [['mongoose', 'search_mongoose'], ['mattermost', 'mattermost_search']] as const) {
  test(`${connector} Live descriptor validates bounds and dispatches against the original MCP schema`, async () => {
    const f = await fixture({ requireBearer: false, tools: [{ name: tool, inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', maximum: 1 } }, required: ['query'], additionalProperties: false } }] });
    const dir = mkdtempSync(join(tmpdir(), 'didi-company-descriptor-'));
    const store = new Store(join(dir, 'data'), toolsMigrations);
    let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
    try {
      const configDir = join(dir, 'provider-config'); mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ id: connector, connector, transport: 'streamable-http', url: f.url, account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true }] }), { mode: 0o600 });
      runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
      const row = store.transaction(tx => tx.get('SELECT policy_json FROM tool_connections WHERE owner_id=? AND connection_id=?', [store.assistantId, connector]));
      assert.ok(row);
      const policy = JSON.parse(String(row.policy_json)) as ConnectionPolicy;
      const descriptor = connectorDescriptor(connector); assert.ok(descriptor);
      const declaration = descriptor.declarations(policy).find(candidate => candidate.name === tool); assert.ok(declaration);
      assert.equal(declaration.validate({ query: 'agri', limit: 2 }), true, 'local bounds allow two results');
      assert.equal(declaration.validate({ query: '', limit: 1 }), false);
      assert.equal(declaration.validate({ query: 'agri', limit: 101 }), false);
      assert.equal(declaration.validate({ query: 'agri', limit: 1, write: true }), false);
      const reader = descriptor.createReader({ port: runtime.port, registry: runtime.registry, endpoint: policy.endpoint, schemaDigest: policy.schemaDigest, generation: policy.generation, policy });
      const refused = await reader.call(tool, { query: 'agri', limit: 2 });
      assert.equal(refused.state, 'refused', 'original MCP schema is stricter than the local declaration');
      assert.equal(f.calls.length, 0, 'schema rejection happens before remote dispatch');
      const accepted = await reader.call(tool, { query: 'agri', limit: 1 });
      assert.equal(accepted.state, 'completed');
      assert.deepEqual(f.calls, [{ name: tool, arguments: { query: 'agri', limit: 1 } }]);
      if (accepted.state === 'completed') {
        const snapshot = descriptor.project(accepted, runtime.port, policy);
        assert.equal(snapshot.response['tool'], tool);
        assert.equal(typeof snapshot.response['text'], 'string');
        assert.deepEqual(snapshot.dataClasses, ['ordinary']);
      }
    } finally { await runtime?.close(); store.close(); await f.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
