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
import { createMongooseReader, mongooseReadOnly, MONGOOSE_KNOWN_WRITES, MONGOOSE_READ_TOOLS, MONGOOSE_TOOLS, MONGOOSE_FAILURE_STAGES, mongooseFailureStage } from '../connectors/index.js';
import { projectMongooseResult } from '../tools/mongoose.js';
import { mongooseAccessToken } from '../host/mongoose-auth.js';
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
    const result = await reader(adapter, registry, digest).getTicket({ number: 'ticket-1' });
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
    assert.equal((await r.getTicket({ number: '' })).state, 'refused');
    assert.equal(f.calls.length, 0);
  } finally { await adapter.close(); }
});

test('a large Mongoose answer is projected as bounded, partial-marked Markdown', async t => {
  const f = await fixture({ text: 'x'.repeat(4096) }); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url);
  const digest = await approve(adapter, registry);
  try {
    const result = await reader(adapter, registry, digest).companyProfile({ company_name: 'Synthetic Company' });
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
      endpoints: [{ id: 'mongoose', transport: 'streamable-http', url: f.url, connector: 'mongoose', account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
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
      writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ id: connector, connector, transport: 'streamable-http', url: f.url, account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }] }), { mode: 0o600 });
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
        assert.throws(() => descriptor.project(accepted, runtime!.port, { ...policy, sourcePolicy: { ...policy.sourcePolicy, unknownClass: null } }), /unknown_source_denied/);
        // The synthetic fixture's opaque payload is explicitly classified, never production consent.
        const classified = { ...policy, sourcePolicy: { ...policy.sourcePolicy, unknownClass: 'ordinary' as const } };
        const snapshot = descriptor.project(accepted, runtime.port, classified);
        assert.equal(snapshot.response['tool'], tool);
        assert.equal(typeof snapshot.response['text'], 'string');
        assert.deepEqual(snapshot.dataClasses, ['ordinary']);
      }
    } finally { await runtime?.close(); store.close(); await f.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

// Fake MCP HTTP server at the real guarded-fetch seam, no listening socket or corpus.
test('search_mongoose projects an SSE MCP entity from separately decodedResult', async t => {
  const sdk = new Server({ name: 'synthetic-sse', version: '1' }, { capabilities: { tools: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: false });
  const tool = { name: 'search_mongoose', inputSchema: { type: 'object' } };
  sdk.setRequestHandler('tools/list', () => ({ tools: [tool] }) as never);
  sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'synthetic-id', title: 'Synthetic SSE', body: 'Public synthetic body' }] }) }], structuredContent: { marker: 'synthetic-unclassified' }, isError: false }) as never);
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
  registry.approve({ endpointId: 'sse', schemaDigest: discovery.schemaDigest, toolNames: ['search_mongoose'], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const result = await createMongooseReader({ port: adapter, registry, config: { endpointId: 'sse', account: 'synthetic', resource: 'synthetic', schemaDigest: discovery.schemaDigest, generation: 1, maxSearchLimit: 10, maxListLimit: 10, queryChars: 200 } }).search({ query: 'synthetic' });
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed' || result.response.state !== 'available') throw Error('missing result');
  const wire = adapter.readSlice({ ...result.source, handle: result.response.handle, offset: 0, length: 16 });
  assert.equal(wire.state, 'available');
  if (wire.state === 'available') assert.match(new TextDecoder().decode(wire.bytes), /^event:|^data:/);
  const projected = projectMongooseResult(adapter, result); assert.equal(projected.ok, true);
  if (!projected.ok) throw Error('projection failed');
  assert(projected.projection.text.includes('Synthetic SSE'));
  assert(!projected.projection.text.includes('synthetic-unclassified'));
});

test("mongoose connect failures map to a closed stage", () => {
  assert.deepEqual(MONGOOSE_FAILURE_STAGES, ["credential", "spawn", "handshake", "first_call"]);
  assert.equal(mongooseFailureStage("credential-unavailable"), "credential");
  assert.equal(mongooseFailureStage("unknown", "credential-unavailable"), "credential");
  assert.equal(mongooseFailureStage("child_exited"), "spawn");
  assert.equal(mongooseFailureStage("pipe_closed"), "spawn");
  assert.equal(mongooseFailureStage("discovery-required"), "handshake");
  assert.equal(mongooseFailureStage("unknown", "discovery-unavailable"), "handshake");
  assert.equal(mongooseFailureStage("timeout"), "first_call");
  assert.equal(mongooseFailureStage("cancelled-before-dispatch"), "first_call");
});

// The published 64-tool surface, as documented in the Mongoose catalog. The classifier must agree
// with it: 49 reads and 15 writes, disjoint, with no name left unclassified.
const CATALOG_64 = [
  'ask_mongoose', 'check_data_capability', 'claim_ticket', 'create_knowledge_item',
  'create_ticket', 'get_commercial_paths', 'get_company_crm', 'get_company_profile',
  'get_knowledge_graph', 'get_knowledge_item', 'get_knowledge_versions', 'get_market_profile',
  'get_reach', 'get_schema', 'get_started', 'get_ticket',
  'inbound_lead_events', 'lightdash_create_content', 'lightdash_create_scheduled_delivery', 'lightdash_edit_content',
  'lightdash_find_content', 'lightdash_generate_hashes', 'lightdash_get_context', 'lightdash_get_current_project',
  'lightdash_get_lightdash_version', 'lightdash_get_metadata', 'lightdash_get_query_result', 'lightdash_grep_fields',
  'lightdash_list_content', 'lightdash_list_explores', 'lightdash_list_projects', 'lightdash_list_verified_content',
  'lightdash_read_content', 'lightdash_resolve_url', 'lightdash_run_metric_query', 'lightdash_run_sql',
  'lightdash_search_field_values', 'lightdash_set_project', 'lint_knowledge', 'list_companies',
  'list_company_products', 'list_data_capabilities', 'list_inbound_leads', 'list_knowledge_domains',
  'list_knowledge_edges', 'list_knowledge_items', 'list_markets', 'list_offerings',
  'list_seed_conflicts', 'list_tickets', 'list_user_handles', 'list_users',
  'lookup_efficacy_evidence', 'patch_knowledge_body', 'provision_user', 'read_knowledge_body',
  'resolve_seed_conflict', 'search_mongoose', 'set_knowledge_edge', 'set_knowledge_item_status',
  'set_user_access', 'summarize_email_engagements', 'update_knowledge_item', 'update_ticket',
];

const CATALOG_READS = [...MONGOOSE_READ_TOOLS];
const CATALOG_WRITES = [...MONGOOSE_KNOWN_WRITES];

test('the read classifier covers the published 64-tool catalog and never admits a write', () => {
  assert.equal(CATALOG_READS.length, 49);
  assert.equal(CATALOG_WRITES.length, 15);
  assert.deepEqual([...new Set([...CATALOG_READS, ...CATALOG_WRITES])].sort(), [...CATALOG_64].sort());
  for (const name of CATALOG_READS) {
    // A read needs the server's own annotation once it sends any.
    assert.equal(mongooseReadOnly({ name, annotations: { readOnlyHint: true } }), true, name);
    // With no annotations at all, only a read prefix stands; the rest needs the annotation.
    const prefixed = ['get_', 'list_', 'search_', 'ask_', 'read_', 'lookup_', 'check_'].some(prefix => name.startsWith(prefix));
    assert.equal(mongooseReadOnly({ name }), prefixed, name);
  }
  for (const name of CATALOG_WRITES) {
    // A known write is never authority, even when the remote annotates it read-only.
    assert.equal(mongooseReadOnly({ name, annotations: { readOnlyHint: true } }), false, name);
    assert.equal(mongooseReadOnly({ name }), false, name);
  }
});

test('annotations without a read hint never authorize a name on its spelling alone', () => {
  assert.equal(mongooseReadOnly({ name: 'get_schema', annotations: {} }), false);
  assert.equal(mongooseReadOnly({ name: 'get_schema', annotations: { destructiveHint: false } }), false);
  assert.equal(mongooseReadOnly({ name: 'get_schema', annotations: { readOnlyHint: 'yes' } }), false);
  assert.equal(mongooseReadOnly({ name: 'get_schema', annotations: { readOnlyHint: false } }), false);
  assert.equal(mongooseReadOnly({ name: 'custom_reader' }), false);
  assert.equal(mongooseReadOnly({ name: 'ask_mongoose' }), true);
});

test('the runtime grants every annotated read tool and no write, and forwards one widened read', async () => {
  const reads: ToolDefinition[] = [
    { name: 'get_schema', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'list_markets', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'create_ticket', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'lightdash_run_sql', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ];
  const f = await fixture({ requireBearer: false, tools: reads });
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-widened-'));
  let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
  try {
    const configDir = join(dir, 'provider-config');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      schemaVersion: 1, grantMode: 'owner-trusted-reads',
      endpoints: [{ id: 'mongoose', transport: 'streamable-http', url: f.url, connector: 'mongoose', account: ACCOUNT, resource: RESOURCE, credentialRef: 'mongoose-mcp', enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
    }), { mode: 0o600 });
    writeFileSync(join(configDir, 'mongoose-mcp.json'), JSON.stringify({ schemaVersion: 1, token: 'test-token' }), { mode: 0o600 });
    const store = new Store(join(dir, 'data'), toolsMigrations);
    runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
    const grant = runtime.registry.currentGrant('mongoose');
    assert.ok(grant);
    assert.deepEqual([...grant.toolNames].sort(), ['get_schema', 'lightdash_run_sql', 'list_markets']);
    assert.equal(grant.toolNames.includes('create_ticket'), false);
  } finally {
    if (runtime) await runtime.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an OAuth record carries the bearer through one tool call and logs no credential stage', async () => {
  const f = await fixture();
  // A schemaVersion 2 record whose access token is the one the fixture server accepts: the call can
  // only succeed if the host resolved the bearer from the record.
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-oauth-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const NOW = Date.now();
  const oauth = {
    schemaVersion: 2, base: f.url.replace(/\/mcp$/, ''), clientId: 'mcp_client', redirectPort: 8768, account: ACCOUNT,
    accessToken: 'test-token', refreshToken: 'refresh-token', expiresAt: NOW + 3_600_000, consentStartedAt: NOW,
  };
  writeFileSync(join(configDir, 'mongoose-mcp.json'), JSON.stringify(oauth), { mode: 0o600 });
  let store: Store | undefined;
  let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
  const stages: string[] = [];
  try {
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      schemaVersion: 1, grantMode: 'owner-trusted-reads',
      endpoints: [{ id: 'mongoose', transport: 'streamable-http', url: f.url, connector: 'mongoose', account: ACCOUNT, resource: RESOURCE, credentialRef: 'mongoose-mcp', enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
    }), { mode: 0o600 });
    store = new Store(join(dir, 'data'), toolsMigrations);
    runtime = await composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      connectorLog: (_connector, stage) => { stages.push(stage); },
    });
    assert.equal(runtime.status().endpoints[0]?.state, 'connected');
    assert.equal(runtime.status().endpoints[0]?.error, undefined);
    assert.deepEqual(stages, []);
    assert.ok(runtime.registry.currentGrant('mongoose'));
    assert.equal(f.calls.length, 0, 'no tool call ran during discovery');
    assert.deepEqual(stages, []);
  } finally {
    if (runtime) await runtime.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('one widened read tool call carries the bearer resolved from the OAuth record', async () => {
  const f = await fixture({ tools: [{ name: 'get_schema', inputSchema: { type: 'object', properties: {} } }] });
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-oauth-call-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const NOW = Date.now();
  writeFileSync(join(configDir, 'mongoose-mcp.json'), JSON.stringify({
    schemaVersion: 2, base: f.url.replace(/\/mcp$/, ''), clientId: 'mcp_client', redirectPort: 8768, account: ACCOUNT,
    accessToken: 'test-token', refreshToken: 'refresh-token', expiresAt: NOW + 3_600_000, consentStartedAt: NOW,
  }), { mode: 0o600 });
  const adapter = adapterFor(f.url, ref => mongooseAccessToken(configDir, ref));
  try {
    const digest = await approve(adapter.adapter, adapter.registry, ['get_schema']);
    const result = await reader(adapter.adapter, adapter.registry, digest).call('get_schema', {});
    assert.equal(result.state, 'completed');
    assert.deepEqual(f.calls, [{ name: 'get_schema', arguments: {} }]);
  } finally {
    await adapter.adapter.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Mongoose current contract: typed detail reads send ref, ticket number and company name through original schema validation', async t => {
  const schemas = [
    { name: 'read_knowledge_body', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, cursor: { type: 'string' }, max_chars: { type: 'integer', minimum: 1, maximum: 9000 } }, required: ['ref'], additionalProperties: false } },
    { name: 'get_ticket', inputSchema: { type: 'object', properties: { number: { type: ['integer', 'string'] }, body_offset: { type: 'integer' }, detail: { type: 'string', enum: ['summary', 'full'] } }, required: ['number'], additionalProperties: false } },
    { name: 'get_company_profile', inputSchema: { type: 'object', properties: { company_name: { type: 'string' }, detail: { type: 'string', enum: ['overview', 'summary', 'commercial', 'full'] }, sections: { type: 'array', items: { type: 'string' } } }, required: ['company_name'], additionalProperties: false } },
  ];
  const f = await fixture({ tools: schemas }); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url); t.after(() => adapter.close());
  const digest = await approve(adapter, registry, schemas.map(schema => schema.name));
  const source = reader(adapter, registry, digest);
  const body = await source.readKnowledgeBody({ ref: 'synthetic-ref', cursor: '1200', max_chars: 1200 });
  assert.equal(body.state, 'completed');
  assert.equal((await source.getTicket({ number: 17, body_offset: 1200, detail: 'full' })).state, 'completed');
  assert.equal((await source.companyProfile({ company_name: 'Synthetic Company', detail: 'full', sections: ['overview'] })).state, 'completed');
  assert.deepEqual(f.calls, [
    { name: 'read_knowledge_body', arguments: { ref: 'synthetic-ref', cursor: '1200', max_chars: 1200 } },
    { name: 'get_ticket', arguments: { number: 17, body_offset: 1200, detail: 'full' } },
    { name: 'get_company_profile', arguments: { company_name: 'Synthetic Company', detail: 'full', sections: ['overview'] } },
  ]);
  const before = f.calls.length;
  assert.equal((await source.call('read_knowledge_body', { id: 'synthetic-ref' })).state, 'refused', 'old id arguments remain refused by the original schema');
  assert.equal(f.calls.length, before);
});

for (const [label, tool, data] of [
  ['flat', 'search_mongoose', { results: [{ entity_type: 'knowledge', id: 'kb-17', title: 'Synthetic launch', snippet: 'Launch delayed to Monday.', status: 'active', url: 'https://example.invalid/kb/17' }], has_more: true, next_cursor: 1, total_estimate: 2 }],
  ['grouped', 'search_mongoose', { hits: { company: [{ company_name: 'Synthetic Company', name: 'Synthetic Company', snippet: 'Company evidence.' }], knowledge: [{ id: 'kb-17', title: 'Synthetic launch', snippet: 'Launch delayed to Monday.', status: 'active' }], offering: [], ticket: [{ number: 17, title: 'Synthetic ticket', snippet: 'Ticket evidence.' }] }, has_more: true, next_cursor: 1, total: 4 }],
  ['ask', 'ask_mongoose', { found: false, results: { hits: { knowledge: [{ id: 'kb-17', title: 'Synthetic launch', snippet: 'Launch delayed to Monday.', status: 'active' }] } } }],
] as const) {
  test(`Mongoose evidence projection: ${label} preserves entity identity, snippets and answerability through the actual SDK`, async t => {
    const f = await fixture({ text: JSON.stringify(data) }); t.after(() => f.close());
    const { registry, adapter } = adapterFor(f.url); t.after(() => adapter.close());
    const digest = await approve(adapter, registry);
    const result = await reader(adapter, registry, digest).call(tool, tool === 'ask_mongoose' ? { question: 'synthetic launch' } : { query: 'synthetic launch' });
    const projected = projectMongooseResult(adapter, result); assert.equal(projected.ok, true); if (!projected.ok) return;
    assert.match(projected.projection.text, /kb-17/); assert.match(projected.projection.text, /Launch delayed to Monday/); assert.match(projected.projection.text, /active/);
    if (label !== 'ask') { assert.equal(projected.projection.partial, true); assert.match(projected.projection.text, /next_cursor: 1/); }
    else assert.match(projected.projection.text, /answerable: false/);
    if (label === 'grouped') { assert.match(projected.projection.text, /company_name: Synthetic Company/); assert.match(projected.projection.text, /number: 17/); }
  });
}
test('Mongoose evidence projection: a complete chunk is not a whole body and preserves its source cursor', async t => {
  const f = await fixture({ text: JSON.stringify({ body: 'First received piece.', complete: true, whole_body: false, next_cursor: '17', body_char_count: 9000 }) }); t.after(() => f.close());
  const { registry, adapter } = adapterFor(f.url); t.after(() => adapter.close());
  const digest = await approve(adapter, registry);
  const result = await reader(adapter, registry, digest).readKnowledgeBody({ ref: 'synthetic-ref' });
  const projected = projectMongooseResult(adapter, result); assert.equal(projected.ok, true); if (!projected.ok) return;
  assert.equal(projected.projection.partial, true); assert.equal(projected.projection.omittedCharacters, 0);
  assert.match(projected.projection.text, /whole_body: false/); assert.match(projected.projection.text, /next_cursor: 17/);
});
