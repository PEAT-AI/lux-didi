import { connectorDescriptor } from '../connectors/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { McpPort, ToolDefinition } from '../adapters/mcp/port.js';
import {
  createMongooseReader, mongooseReadOnly, mongooseClosedReason, mongooseOwnerLine, mongooseProfileRoute, MONGOOSE_DENIED_TOOLS,
  MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_AUDIENCES, MONGOOSE_ENDPOINT_PATHS, MONGOOSE_ENDPOINT_TOOLS, MONGOOSE_READ_TOOLS,
  MONGOOSE_FAILURE_STAGES, mongooseCredentialAtStart, mongooseFailureStage, type MongooseEndpoint,
} from '../connectors/index.js';
import { projectMongooseResult, mongooseToolStatus } from '../tools/mongoose.js';
import { loadMcpEndpoints, mcpErrorCode } from '../config/mcp.js';

const ACCOUNT = 'account-a';

const endpointTools: Record<MongooseEndpoint, ToolDefinition[]> = {
  knowledge: MONGOOSE_ENDPOINT_TOOLS.knowledge.map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })),
  data: MONGOOSE_ENDPOINT_TOOLS.data.map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })),
  crm: MONGOOSE_ENDPOINT_TOOLS.crm.map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })),
};

const SEARCH_TEXT = JSON.stringify({
  outcome: 'evidence',
  items: [{ type: 'knowledge_item', ref: 'item-9', name: 'Agri input pricing', url: 'https://mongoose.dev.peat-cloud.com/knowledge/agri-pricing' }],
  next_cursor: null, next_tool: null, restriction: null, request_id: 'req-1',
});
const READ_TEXT = JSON.stringify({
  outcome: 'evidence', ref: 'item-9', depth: 'summary',
  items: [{ type: 'knowledge_item', ref: 'item-9', name: 'Agri input pricing', url: 'https://mongoose.dev.peat-cloud.com/knowledge/agri-pricing' }],
  next_cursor: null, coverage: { depth: 'summary', complete: true }, restriction: null, request_id: 'req-1',
  body: 'Agri input pricing reached 41 companies in 2025.',
});

interface FixtureOptions { replies?: Record<string, string>; text?: string; status?: number }

async function fixture(endpoint: MongooseEndpoint, options: FixtureOptions = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const authorization: (string | undefined)[] = [];
  const sdk = new Server({ name: `synthetic-mongoose-${endpoint}`, version: '1' }, { capabilities: { tools: { listChanged: false } } });
  sdk.setRequestHandler('tools/list', () => ({ tools: endpointTools[endpoint] }) as never);
  sdk.setRequestHandler('tools/call', request => {
    const params = request.params as { name: string; arguments: Record<string, unknown> };
    calls.push({ name: params.name, arguments: params.arguments });
    const text = options.replies?.[params.name] ?? options.text ?? SEARCH_TEXT;
    return { content: [{ type: 'text', text }] } as never;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 's' });
  await sdk.connect(transport);
  const listener = createServer(async (req, res) => {
    try {
      authorization.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
      const bytes = Buffer.concat(chunks);
      // A refusing endpoint refuses the read call, not the discovery a client needs to get there.
      if (options.status !== undefined && options.status !== 200 && bytes.toString('utf8').includes('"tools/call"')) {
        res.writeHead(options.status, { 'www-authenticate': `Bearer resource_metadata="${MONGOOSE_ENDPOINT_AUDIENCES[endpoint]}"` }); res.end(); return;
      }
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
  const url = `http://127.0.0.1:${address.port}${MONGOOSE_ENDPOINT_PATHS[endpoint]}`;
  return { url, calls, get authorization() { return authorization.filter(value => value !== undefined); }, async close() { await sdk.close().catch(() => {}); await new Promise<void>(resolve => listener.close(() => resolve())); } };
}

function adapterFor(endpoint: MongooseEndpoint, url: string, token: string) {
  const registry = new McpRegistry();
  const endpointId = `mongoose-${endpoint}`;
  registry.register({ id: endpointId, url, account: ACCOUNT, resource: MONGOOSE_ENDPOINT_AUDIENCES[endpoint], credentialRef: `mongoose-${endpoint}` });
  registry.enable(endpointId); registry.allowEgress(endpointId);
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: async () => token });
  return { registry, adapter, endpointId };
}

async function approve(adapter: McpPort, registry: McpRegistry, endpoint: MongooseEndpoint, endpointId: string, names?: readonly string[]) {
  const discovery = await adapter.discover(endpointId);
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId, schemaDigest: discovery.schemaDigest, toolNames: names ?? MONGOOSE_ENDPOINT_TOOLS[endpoint], effect: 'read', account: ACCOUNT, resource: MONGOOSE_ENDPOINT_AUDIENCES[endpoint], generation: 1 });
  return discovery.schemaDigest;
}

function readerFor(adapter: McpPort, registry: McpRegistry, endpoint: MongooseEndpoint, endpointId: string, schemaDigest: string) {
  return createMongooseReader({ port: adapter, registry, config: {
    endpointId, account: ACCOUNT, resource: MONGOOSE_ENDPOINT_AUDIENCES[endpoint], endpoint, schemaDigest, generation: 1,
    maxSearchLimit: 10, maxListLimit: 10, queryChars: 200 } });
}

/** One knowledge endpoint wired end to end, approved, with a live reader. */
async function knowledge(options: FixtureOptions = {}) {
  const f = await fixture('knowledge', options);
  const a = adapterFor('knowledge', f.url, 'knowledge-token');
  const digest = await approve(a.adapter, a.registry, 'knowledge', a.endpointId);
  return { f, a, reader: readerFor(a.adapter, a.registry, 'knowledge', a.endpointId, digest) };
}

// --- acceptance 1: the installed catalog carries exactly three mongoose endpoints ---

function configDir(): { dir: string; close: () => void } {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'didi-mongoose-config-'))), 'provider-config');
  mkdirSync(dir, { mode: 0o700 });
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function mongooseEntry(endpoint: MongooseEndpoint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `mongoose-${endpoint}`, transport: 'streamable-http', connector: 'mongoose', unknownClass: 'sensitive',
    account: 'local', resource: MONGOOSE_ENDPOINT_AUDIENCES[endpoint], credentialRef: `mongoose-${endpoint}`,
    enabled: true, allowEgress: true, url: `https://mongoose.dev.peat-cloud.com${MONGOOSE_ENDPOINT_PATHS[endpoint]}`, ...overrides,
  };
}

function load(entries: unknown[]) {
  const c = configDir();
  try {
    writeFileSync(join(c.dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, endpoints: entries }), { mode: 0o600 });
    return loadMcpEndpoints({ configDir: c.dir });
  } finally { c.close(); }
}

test('the installed catalog carries exactly three mongoose endpoints with distinct resources', () => {
  const loaded = load(MONGOOSE_ENDPOINTS.map(endpoint => mongooseEntry(endpoint)));
  assert.equal(loaded.state, 'configured');
  if (loaded.state !== 'configured') return;
  const mongoose = loaded.catalog.endpoints.filter(endpoint => endpoint.connector === 'mongoose');
  assert.equal(mongoose.length, 3);
  assert.deepEqual(mongoose.map(endpoint => endpoint.id).sort(), ['mongoose-crm', 'mongoose-data', 'mongoose-knowledge']);
  assert.deepEqual(mongoose.map(endpoint => endpoint.resource).sort(), ['mongoose:crm', 'mongoose:data', 'mongoose:knowledge']);
  assert.equal(new Set(mongoose.map(endpoint => endpoint.credentialRef)).size, 3);
});

test('a mongoose endpoint naming /mcp, a toolset or admin is refused with a closed reason', () => {
  const cases: unknown[][] = [
    [mongooseEntry('knowledge', { url: 'https://mongoose.dev.peat-cloud.com/mcp' }), mongooseEntry('data'), mongooseEntry('crm')],
    [mongooseEntry('knowledge', { url: 'https://mongoose.dev.peat-cloud.com/mcp/' }), mongooseEntry('data'), mongooseEntry('crm')],
    [mongooseEntry('knowledge', { url: 'https://mongoose.dev.peat-cloud.com/mcp?toolset=core' }), mongooseEntry('data'), mongooseEntry('crm')],
    [mongooseEntry('knowledge', { url: 'https://mongoose.dev.peat-cloud.com/mcp/knowledge', resource: 'mongoose:knowledge' }), mongooseEntry('data'), mongooseEntry('crm'), mongooseEntry('crm', { id: 'mongoose-admin', url: 'https://mongoose.dev.peat-cloud.com/mcp/admin', resource: 'mongoose:admin', credentialRef: 'mongoose-admin' })],
    [mongooseEntry('knowledge'), mongooseEntry('data')],
    [mongooseEntry('knowledge'), mongooseEntry('data'), mongooseEntry('crm', { resource: 'mongoose:knowledge' })],
  ];
  for (const entries of cases) {
    assert.throws(() => load(entries), (error: unknown) => mcpErrorCode(error) === 'invalid_source');
  }
});

// --- acceptance 2: one audience per endpoint, never crossed ---

test('each endpoint carries its own audience and its own token, never the other endpoint token', async t => {
  const servers = [] as Awaited<ReturnType<typeof fixture>>[];
  t.after(async () => { for (const server of servers) await server.close(); });
  for (const endpoint of MONGOOSE_ENDPOINTS) {
    const f = await fixture(endpoint, { text: endpoint === 'knowledge' ? SEARCH_TEXT : JSON.stringify({ outcome: 'evidence', items: [] }) });
    servers.push(f);
    const a = adapterFor(endpoint, f.url, `${endpoint}-token`);
    const digest = await approve(a.adapter, a.registry, endpoint, a.endpointId);
    const reader = readerFor(a.adapter, a.registry, endpoint, a.endpointId, digest);
    const first = MONGOOSE_ENDPOINT_TOOLS[endpoint][0] as string;
    const result = await reader.call(first, first === 'search' ? { query: 'agri' } : {}, undefined);
    assert.equal(result.state, 'completed', `${endpoint} completed`);
    // Every authenticated request carried this endpoint's own token, and never another endpoint's.
    assert(f.authorization.length > 0, `${endpoint} sent an authenticated request`);
    for (const header of f.authorization) assert.equal(header, `Bearer ${endpoint}-token`);
    await a.adapter.close();
  }
  assert.deepEqual(MONGOOSE_ENDPOINTS.map(endpoint => MONGOOSE_ENDPOINT_AUDIENCES[endpoint]), ['mongoose:knowledge', 'mongoose:data', 'mongoose:crm']);
});

// --- acceptance 3: search answer then read, browse lists, restricted stays restricted ---

test('a company question runs search mode answer then read on the top ref and renders a source card', async t => {
  const k = await knowledge({ replies: { search: SEARCH_TEXT, read: READ_TEXT } });
  t.after(() => k.f.close());
  t.after(() => k.a.adapter.close());
  const result = await k.reader.searchCompany({ query: 'agri input pricing', read: 'summary' });
  assert.equal(result.state, 'completed');
  assert.deepEqual(k.f.calls, [
    { name: 'search', arguments: { query: 'agri input pricing', mode: 'answer', read: 'summary', limit: 5 } },
    { name: 'read', arguments: { ref: 'item-9', depth: 'summary' } },
  ]);
  const projected = projectMongooseResult(k.a.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.match(projected.projection.text, /Agri input pricing/);
  assert.match(projected.projection.text, /source: https:\/\/mongoose\.dev\.peat-cloud\.com\/knowledge\/agri-pricing/);
});

test('a listing ask runs search mode browse and reads nothing', async t => {
  const k = await knowledge();
  t.after(() => k.f.close());
  t.after(() => k.a.adapter.close());
  const result = await k.reader.searchCompany({ query: 'companies', mode: 'browse' });
  assert.equal(result.state, 'completed');
  assert.deepEqual(k.f.calls, [{ name: 'search', arguments: { query: 'companies', mode: 'browse', limit: 5 } }]);
});

test('a restricted search yields the restricted reason, never empty evidence', async t => {
  const k = await knowledge({ text: JSON.stringify({ outcome: 'restricted', items: [], next_cursor: null, next_tool: null, restriction: { code: 'restricted', message: 'Team gate' }, request_id: 'req-2' }) });
  t.after(() => k.f.close());
  t.after(() => k.a.adapter.close());
  const result = await k.reader.searchCompany({ query: 'payroll numbers' });
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed') return;
  assert.equal(mongooseClosedReason('restricted'), 'restricted');
  const projected = projectMongooseResult(k.a.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.match(projected.projection.text, /restricted/);
});

// --- acceptance 4: closed owner lines, never a failure ---

test('a data read without a Lightdash token is one closed owner line, not a failure', async t => {
  const f = await fixture('data', { text: JSON.stringify({ error_code: 'data_not_connected', message: 'Lightdash is not connected for your account.', retryable: false, suggestions: [] }) });
  t.after(() => f.close());
  const a = adapterFor('data', f.url, 'data-token');
  const digest = await approve(a.adapter, a.registry, 'data', a.endpointId);
  t.after(() => a.adapter.close());
  const reader = readerFor(a.adapter, a.registry, 'data', a.endpointId, digest);
  const result = await reader.call('run_metric_query', {});
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed') return;
  const projected = projectMongooseResult(a.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(mongooseOwnerLine('data_not_connected'), 'your Lightdash token is not connected in Mongoose settings');
  assert.match(projected.projection.text, /your Lightdash token is not connected in Mongoose settings/);
  assert.equal(mongooseToolStatus(result), undefined);
});

test('R2: get_company on crm carries a company profile, knowledge list_companies plus read is the fallback', () => {
  assert.deepEqual(mongooseProfileRoute(true), { endpoint: 'crm', tool: 'get_company' });
  assert.deepEqual(mongooseProfileRoute(false), { endpoint: 'knowledge', tool: 'list_companies', then: 'read' });
  assert.equal(MONGOOSE_ENDPOINT_TOOLS.crm.includes('get_company'), true);
  assert.equal(MONGOOSE_ENDPOINT_TOOLS.knowledge.includes('list_companies'), true);
  assert.equal(MONGOOSE_ENDPOINT_TOOLS.knowledge.includes('read'), true);
});

test('an unauthenticated endpoint is a typed refusal, never an empty success', async t => {
  const f = await fixture('knowledge', { status: 401 });
  t.after(() => f.close());
  const a = adapterFor('knowledge', f.url, 'knowledge-token');
  const digest = await approve(a.adapter, a.registry, 'knowledge', a.endpointId);
  t.after(() => a.adapter.close());
  const result = await readerFor(a.adapter, a.registry, 'knowledge', a.endpointId, digest).searchCompany({ query: 'agri' });
  assert.notEqual(result.state, 'completed');
  assert.equal(f.calls.length, 0);
});

test('argument budgets refuse malformed input before any wire call', async t => {
  const k = await knowledge();
  t.after(() => k.f.close());
  t.after(() => k.a.adapter.close());
  const empty = await k.reader.searchCompany({ query: '   ' });
  assert.equal(empty.state, 'refused');
  assert.equal(empty.state === 'refused' ? empty.reason : '', 'invalid-query');
  const wide = await k.reader.searchCompany({ query: 'agri', limit: 11 });
  assert.equal(wide.state === 'refused' ? wide.reason : '', 'limit-out-of-budget');
  const extra = await k.reader.searchCompany({ query: 'agri', cursor: 'c', extra: 1 } as never);
  assert.equal(extra.state === 'refused' ? extra.reason : '', 'invalid-search-input');
  assert.equal(k.f.calls.length, 0);
});

test('a large answer is projected as bounded and partial-marked', async t => {
  const k = await knowledge({ text: JSON.stringify({ outcome: 'evidence', ref: 'x', depth: 'full', items: [], body: 'z'.repeat(9000), next_cursor: null, coverage: { depth: 'full', complete: true }, restriction: null, request_id: 'r' }) });
  t.after(() => k.f.close());
  t.after(() => k.a.adapter.close());
  const result = await k.reader.searchCompany({ query: 'agri' });
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed') return;
  const projected = projectMongooseResult(k.a.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.partial, true);
  assert(projected.projection.omittedCharacters > 0);
  assert(projected.projection.text.length <= 4000);
});

test('a crm sign-in refused for teams is one closed owner line', () => {
  assert.equal(mongooseClosedReason('endpoint_not_allowed'), 'endpoint_not_allowed');
  assert.equal(mongooseOwnerLine('endpoint_not_allowed'), 'your account is not in the Mongoose CRM teams');
});

test('a knowledge endpoint with no stored credential parks the sign-in line naming that endpoint', () => {
  assert.equal(mongooseCredentialAtStart('mongoose', { hasRefreshMaterial: false, consentExpired: false }), 'not_signed_in');
  assert.equal(mongooseCredentialAtStart('mongoose', { hasRefreshMaterial: true, consentExpired: false }), 'probe');
  assert.equal(mongooseCredentialAtStart('mongoose', { hasRefreshMaterial: true, consentExpired: true }), 'not_signed_in');
  assert.equal(mongooseCredentialAtStart('mattermost', { hasRefreshMaterial: false, consentExpired: true }), 'probe');
});

// --- acceptance 5: no write tool name in any envelope ---

test('no write tool name appears in any endpoint envelope', () => {
  for (const endpoint of MONGOOSE_ENDPOINTS) {
    for (const name of MONGOOSE_ENDPOINT_TOOLS[endpoint]) {
      assert.equal(MONGOOSE_DENIED_TOOLS.includes(name), false, `${endpoint} never carries ${name}`);
    }
  }
  assert.equal(new Set(MONGOOSE_ENDPOINTS.flatMap(endpoint => [...MONGOOSE_ENDPOINT_TOOLS[endpoint]])).size, MONGOOSE_READ_TOOLS.length, 'the three envelopes are disjoint');
  for (const name of ['run_sql', 'create_content', 'update_content', 'create_scheduled_delivery', 'set_project', 'create_ticket', 'update_ticket', 'claim_ticket', 'get_ticket', 'ask_mongoose', 'search_mongoose', 'get_knowledge_item', 'read_knowledge_body', 'get_company_profile', 'get_company_crm', 'get_access_report', 'provision_user']) {
    assert.equal(MONGOOSE_READ_TOOLS.includes(name), false, `${name} is not a read`);
    assert.equal(MONGOOSE_DENIED_TOOLS.includes(name), true, `${name} is denied`);
  }
});

test('a tool outside the endpoint envelope refuses before dispatch', async t => {
  const k = await knowledge();
  t.after(() => k.f.close());
  t.after(() => k.a.adapter.close());
  const result = await k.reader.call('run_sql', { sql: 'select 1' });
  assert.equal(result.state, 'refused');
  assert.equal(result.state === 'refused' ? result.reason : '', 'tool-not-in-envelope');
  assert.equal(k.f.calls.length, 0);
});

test('the read classifier never admits a write whatever the annotations say', () => {
  for (const name of MONGOOSE_DENIED_TOOLS) assert.equal(mongooseReadOnly({ name, annotations: { readOnlyHint: true } }), false, name);
  assert.equal(mongooseReadOnly({ name: 'search', annotations: { readOnlyHint: true } }), true);
  // R2: only the server's own readOnlyHint makes a read; a name is never read on its spelling.
  assert.equal(mongooseReadOnly({ name: 'list_companies' }), false);
  assert.equal(mongooseReadOnly({ name: 'search' }), false);
  assert.equal(mongooseReadOnly({ name: 'search', annotations: {} }), false);
});

test('mongoose connect failures map to a closed stage', () => {
  assert.deepEqual([...MONGOOSE_FAILURE_STAGES], ['credential', 'spawn', 'handshake', 'first_call']);
  assert.equal(mongooseFailureStage('credential-missing'), 'credential');
  assert.equal(mongooseFailureStage('protocol', 'child_exited'), 'spawn');
  assert.equal(mongooseFailureStage('discovery-required'), 'handshake');
  assert.equal(mongooseFailureStage('tool-error'), 'first_call');
});

test('the mongoose descriptor declares only the three endpoint envelopes', () => {
  const descriptor = connectorDescriptor('mongoose');
  assert(descriptor);
  if (!descriptor) return;
  assert.deepEqual([...descriptor.envelope].sort(), [...MONGOOSE_READ_TOOLS].sort());
  for (const endpoint of MONGOOSE_ENDPOINTS) {
    for (const name of MONGOOSE_ENDPOINT_TOOLS[endpoint]) assert(descriptor.envelope.includes(name), `${endpoint} declares ${name}`);
  }
});
