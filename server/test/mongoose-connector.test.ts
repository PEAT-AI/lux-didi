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

interface FixtureOptions { text?: string; requireBearer?: boolean }
async function fixture(options: FixtureOptions = {}) {
  const calls: { name: unknown; arguments: unknown }[] = [];
  const requireBearer = options.requireBearer ?? true;
  const sdk = new Server({ name: 'synthetic-mongoose', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  sdk.setRequestHandler('tools/list', () => ({ tools: [...readTools, ...writeTools] }) as never);
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

function adapterFor(url: string, extras: { resolveCredential?: (ref: string) => Promise<string> } = {}) {
  const registry = new McpRegistry();
  registry.register({ id: 'source', url, account: ACCOUNT, resource: RESOURCE, credentialRef: 'mongoose-mcp' });
  registry.enable('source'); registry.allowEgress('source');
  const store = new MemoryResultStore();
  const adapter = createMcpAdapter({ registry, store, resolveCredential: extras.resolveCredential ?? (async () => 'test-token') });
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
  return createMongooseReader({ port: adapter, registry, config: { endpointId: 'source', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxSearchLimit: 10, maxGetIds: 10, maxQueryChars: 200 } });
}

test('search round trip: exact outgoing arguments and opaque unknown/local-only evidence', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry);
  try {
    const result = await reader(adapter, registry, digest).search('agri pricing', 3);
    assert.equal(result.state, 'completed');
    assert.deepEqual(f.calls, [{ name: 'search_mongoose', arguments: { query: 'agri pricing', limit: 3 } }]);
    if (result.state !== 'completed') return;
    assert.equal(result.classification, 'unknown');
    assert.equal(result.capability, 'local-only');
    const projected = projectMongooseResult(result, adapter);
    assert.match(projected.text, /\[Agri input pricing\]\(https:\/\/mongoose\.dev\.peat-cloud\.com\/knowledge\/agri-pricing\)/);
    assert.deepEqual(projected.sources, ['https://mongoose.dev.peat-cloud.com/knowledge/agri-pricing']);
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
    const result = await reader(adapter, registry, digest).search('secret', 1);
    assert.ok(result.state === 'refused' || result.state === 'unknown', `expected a typed refusal, got ${result.state}`);
    if (result.state === 'refused' || result.state === 'unknown') assert.match(String(result.reason), /credential|protocol|unknown|pre-dispatch/i);
  } finally { await adapter.close(); }
});

test('only the read envelope is eligible; a granted writer refuses the whole call', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry, [...MONGOOSE_TOOLS, 'create_ticket']);
  try {
    const result = await reader(adapter, registry, digest).search('agri', 1);
    assert.equal(result.state, 'refused');
    assert.equal(result.reason, 'ineligible-tool-granted');
    assert.equal(f.calls.length, 0);
  } finally { await adapter.close(); }
});

test('a missing write definition refuses before dispatch', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry, MONGOOSE_TOOLS.filter(name => name !== 'get_ticket'));
  try {
    const result = await reader(adapter, registry, digest).getTicket('ticket-1');
    assert.equal(result.state, 'refused');
    assert.equal(result.reason, 'required-definition-absent');
  } finally { await adapter.close(); }
});

test('input budgets refuse malformed arguments before any wire call', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry);
  const r = reader(adapter, registry, digest);
  try {
    assert.equal((await r.search('   ', 1)).state, 'refused');
    assert.equal((await r.search('ok', 999)).state, 'refused');
    assert.equal((await r.listTickets(0)).state, 'refused');
    assert.equal((await r.getTicket('')).state, 'refused');
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
    if (result.state !== 'completed') return;
    const projected = projectMongooseResult(result, adapter, 128);
    assert.equal(projected.bounded, true);
    assert.equal(projected.omittedCharacters, 4096 - 128);
    assert.match(projected.text, /\[partial: 3968 characters omitted\]/);
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
  } finally {
    if (runtime) await runtime.close();
    if (store) store.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
