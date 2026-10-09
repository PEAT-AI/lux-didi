import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { ToolDefinition, CallRequest, McpPort } from '../adapters/mcp/port.js';

// Explicitly synthetic public protocol fixture; no real accounts, model or corpus.
const tool: ToolDefinition = { name: 'read', description: 'Synthetic text', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } };
const writeTool: ToolDefinition = { name: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
interface FixtureOptions {
  list?: (cursor: string | undefined) => unknown;
  call?: () => Promise<unknown> | unknown;
  status?: number;
  location?: string;
  jsonResponse?: boolean;
  callStatus?: number;
  malformedCall?: boolean;
}
async function fixture(options: FixtureOptions = {}) {
  const observed: { method: string; origin: string | undefined; host: string | undefined; auth: string | undefined; path: string }[] = [];
  let counter = 0;
  let cancellations = 0;
  const responseEntities: Buffer[] = [];
  const sdk = new Server({ name: 'synthetic-fixture', version: '1' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  sdk.setRequestHandler('tools/list', request => (options.list?.(request.params?.cursor) ?? { tools: [tool, writeTool] }) as never);
  sdk.setRequestHandler('tools/call', async () => {
    counter++;
    return (await options.call?.() ?? { content: [{ type: 'text', text: 'synthetic α payload' }] }) as never;
  });
  sdk.setNotificationHandler('notifications/cancelled', async () => { cancellations++; });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: options.jsonResponse ?? true });
  await sdk.connect(transport);
  const listener = createServer(async (req, res) => {
    try {
      const bytes = await body(req);
      const packet = bytes.length ? JSON.parse(bytes.toString()) as { method?: string } : {};
      observed.push({ method: packet.method ?? req.method ?? '', origin: req.headers.origin, host: req.headers.host, auth: req.headers.authorization, path: req.url ?? '' });
      if (options.status) {
        res.writeHead(options.status, { ...(options.location ? { Location: options.location } : {}), 'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1:1/discovery"' });
        res.end(); return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'GET', headers, ...(bytes.length ? { body: new Uint8Array(bytes) } : {}) });
      let response = await transport.handleRequest(request);
      if (packet.method === 'tools/call' && options.malformedCall) {
        // Deliberately corrupt one genuine SDK response after server execution.
        // This is a negative wire fixture, never a fabricated success response.
        const envelope = await response.json() as Record<string, unknown>;
        envelope.result = { content: [{ type: 'unsupported', text: 'invalid wire result' }] };
        response = new Response(JSON.stringify(envelope), { status: 200, headers: response.headers });
      }
      if (packet.method === 'tools/call' && options.callStatus) {
        void response.body?.cancel().catch(() => {});
        res.writeHead(options.callStatus); res.end(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      const reader = response.body.getReader();
      const entity: Buffer[] = [];
      res.on('close', () => { void reader.cancel().catch(() => {}); });
      while (!res.destroyed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        entity.push(Buffer.from(chunk.value));
        res.write(chunk.value);
      }
      if (packet.method === 'tools/call') responseEntities.push(Buffer.concat(entity));
      res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return { url, observed, sdk, responseEntities, get counter() { return counter; }, get cancellations() { return cancellations; }, async close() { await sdk.close(); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); } };
}
function setup(url: string, extras: { now?: () => number; maxBytes?: number; ttlMs?: number; maxEntries?: number; timeoutMs?: number; responseBytes?: number; credential?: string } = {}) {
  const registry = new McpRegistry();
  registry.register({ id: 'source', url, account: 'account-a', resource: 'resource-a', ...(extras.credential ? { credentialRef: 'token-ref' } : {}) });
  registry.enable('source'); registry.allowEgress('source');
  const store = new MemoryResultStore({ maxBytes: extras.maxBytes ?? 20_000, maxEntries: extras.maxEntries ?? 10, ttlMs: extras.ttlMs ?? 1000, maxSliceBytes: 97, now: extras.now ?? Date.now });
  const adapter = createMcpAdapter({ registry, store, resolveCredential: async ref => { assert.equal(ref, 'token-ref'); return extras.credential ?? ''; }, budgets: { timeoutMs: extras.timeoutMs ?? 1000, maxResponseBytes: extras.responseBytes ?? 20_000, maxPages: 8, maxTools: 20, projectionChars: 18 } });
  return { registry, adapter, store };
}
const request: CallRequest = { endpointId: 'source', toolName: 'read', arguments: {}, generation: 1, account: 'account-a', resource: 'resource-a' };
async function approve(adapter: McpPort, registry: McpRegistry, names = ['read'], generation = 1) {
  const discovery = await adapter.discover('source');
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId: 'source', schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: 'account-a', resource: 'resource-a', generation });
  return discovery;
}

test('official SDK handshake; no Origin; exact Host; read grants ignore advisory annotations; exact byte reconstruction', async () => {
  const f = await fixture(); const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    assert.deepEqual(adapter.visibleTools('source').map(t => t.name), ['read']);
    assert.equal((await adapter.call({ ...request, toolName: 'write' })).state, 'refused');
    assert.equal(f.counter, 0);
    const result = await adapter.call(request);
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed' || result.payload.state !== 'available') throw new Error('missing payload');
    assert.equal(result.source.endpointId, 'source');
    assert.equal(result.coverage.completeCorpus, false);
    assert.equal(result.projection.omitted, true);
    const pieces: Uint8Array[] = [];
    for (let offset = 0; offset < result.payload.byteLength; offset += 97) {
      const slice = adapter.readSlice({ ...request, handle: result.payload.handle, offset, length: Math.min(97, result.payload.byteLength - offset) });
      assert.equal(slice.state, 'available'); if (slice.state === 'available') pieces.push(slice.bytes);
    }
    const original = Buffer.concat(pieces);
    assert.deepEqual(original, f.responseEntities[0]);
    assert.equal(original.length, result.payload.byteLength);
    assert.equal(createHash('sha256').update(original).digest('hex'), result.payload.sha256);
    const envelope = JSON.parse(original.toString()) as { result: { content: { text: string }[] } };
    assert.equal(envelope.result.content[0]?.text, 'synthetic α payload');
    assert(f.observed.some(r => r.method === 'initialize'));
    assert(f.observed.some(r => r.method === 'notifications/initialized'));
    for (const row of f.observed) { assert.equal(row.origin, undefined); assert.equal(row.host, new URL(f.url).host); }
  } finally { await adapter.close(); await f.close(); }
});

test('empty registry and connector enablement never imply source egress; URL and unknown config policy rejects before dispatch', async () => {
  const f = await fixture(); const registry = new McpRegistry();
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  try {
    assert.equal((await adapter.discover('missing')).state, 'unavailable');
    registry.register({ id: 'source', url: f.url, account: 'account-a', resource: 'resource-a' }); registry.enable('source');
    assert.equal((await adapter.discover('source')).state, 'unavailable'); assert.equal(f.observed.length, 0);
    for (const url of ['http://localhost:1/mcp', 'http://127.1:1/mcp', 'http://0x7f000001/mcp', 'http://user:pass@127.0.0.1:1/mcp', 'http://example.com/mcp']) {
      assert.throws(() => registry.register({ id: url, url, account: 'a', resource: 'r' }));
    }
    assert.throws(() => registry.register({ id: 'headers', url: f.url, account: 'a', resource: 'r', headers: { 'X-Arbitrary': 'secret' } } as never));
  } finally { await adapter.close(); await f.close(); }
});

test('redirect never reaches second listener; credential scoped to exact source; 401 causes no OAuth discovery', async () => {
  const destination = await fixture(); const redirect = await fixture({ status: 307, location: destination.url });
  const unauthorized = await fixture({ status: 401 });
  const a = setup(redirect.url, { credential: 'synthetic-only-token' }); const b = setup(unauthorized.url, { credential: 'other-synthetic-token' });
  try {
    assert.equal((await a.adapter.discover('source')).state, 'unavailable');
    assert.equal(destination.observed.length, 0);
    assert.equal((await b.adapter.discover('source')).state, 'unavailable');
    assert.equal(unauthorized.observed.length, 1);
    assert.equal(unauthorized.observed[0]?.path, '/mcp');
    assert.equal(unauthorized.observed[0]?.auth, 'Bearer other-synthetic-token');
    assert.equal(redirect.observed[0]?.auth, 'Bearer synthetic-only-token');
  } finally { await a.adapter.close(); await b.adapter.close(); await redirect.close(); await unauthorized.close(); await destination.close(); }
});

test('canonical discovery follows all pages and rejects duplicate names, repeated cursor, malformed and unavailable without partial readiness', async () => {
  assert.equal(canonicalToolDigest([tool, writeTool]), canonicalToolDigest([{ inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, name: 'write' }, { annotations: { readOnlyHint: false }, inputSchema: { type: 'object' }, description: 'Synthetic text', name: 'read' }]));
  assert.notEqual(canonicalToolDigest([tool]), canonicalToolDigest([{ ...tool, description: 'drift' }]));
  for (const mode of ['pages', 'duplicate', 'cursor', 'malformed', 'empty'] as const) {
    const cursors: (string | undefined)[] = [];
    const f = await fixture({ list: cursor => {
      cursors.push(cursor);
      if (mode === 'empty') return { tools: [] };
      if (mode === 'malformed') return { tools: [{ name: 'bad', inputSchema: {} }] };
      if (mode === 'cursor') return { tools: cursor ? [writeTool] : [tool], nextCursor: 'same' };
      if (!cursor) return { tools: [tool], nextCursor: 'next' };
      return { tools: mode === 'duplicate' ? [tool] : [writeTool] };
    } });
    const { adapter, registry } = setup(f.url);
    try {
      const d = await adapter.discover('source');
      assert.equal(d.state, mode === 'pages' || mode === 'empty' ? 'discovered' : 'unavailable');
      assert.deepEqual(adapter.visibleTools('source'), []);
      assert.equal(registry.currentGrant('source'), undefined);
      if (d.state === 'discovered') assert.equal(d.tools.length, mode === 'pages' ? 2 : 0);
      if (mode === 'pages') assert.deepEqual(cursors, [undefined, 'next']);
    } finally { await adapter.close(); await f.close(); }
  }
});

test('list_changed suspends grants before refresh and drift requires new local generation', async () => {
  let description = 'Synthetic text';
  const f = await fixture({ list: () => ({ tools: [{ ...tool, description }] }) }); const { adapter, registry } = setup(f.url);
  try {
    const before = await approve(adapter, registry);
    description = 'changed';
    await f.sdk.notification({ method: 'notifications/tools/list_changed' });
    // Observe the incoming notification through the SDK, without sleeps or fabricated state.
    await adapter.whenSuspended('source');
    assert.equal((await adapter.call(request)).state, 'refused'); assert.equal(f.counter, 0);
    const after = await adapter.discover('source'); assert.equal(after.state, 'discovered');
    if (after.state !== 'discovered') throw new Error('missing refresh');
    assert.notEqual(before.schemaDigest, after.schemaDigest);
    assert.equal((await adapter.call(request)).state, 'refused');
    assert.throws(() => registry.approve({ endpointId: 'source', schemaDigest: after.schemaDigest, toolNames: ['read'], effect: 'read', account: 'account-a', resource: 'resource-a', generation: 1 }));
    registry.approve({ endpointId: 'source', schemaDigest: after.schemaDigest, toolNames: ['read'], effect: 'read', account: 'account-a', resource: 'resource-a', generation: 2 });
    assert.equal((await adapter.call({ ...request, generation: 2 })).state, 'completed');
  } finally { await adapter.close(); await f.close(); }
});

test('timeout and cancellation are unknown after observed side effect, terminate locally and never replay', async () => {
  for (const cancel of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture({ call: async () => { entered(); await gate; return { content: [] }; } });
    const { adapter, registry } = setup(f.url, { timeoutMs: 150 });
    try {
      await approve(adapter, registry);
      const controller = new AbortController();
      const started = Date.now(); const pending = adapter.call(request, controller.signal);
      await dispatched; if (cancel) controller.abort();
      const result = await pending;
      assert.equal(result.state, 'unknown'); assert.equal(f.counter, 1); assert(Date.now() - started < 1500);
      release();
      await adapter.discover('source'); assert.equal(f.counter, 1);
      assert.equal(adapter.visibleTools('source').length, 0);
      assert(f.observed.some(row => row.method === 'notifications/cancelled'), 'SDK attempts bounded protocol cancellation');
    } finally { release(); await adapter.close(); await f.close(); }
  }
});

test('revocation during dispatch invalidates completed result and prior handles; scope, expiry and bounded slices', async () => {
  let now = 100;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const dispatched = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  const f = await fixture({ call: async () => { if (blocked) { entered(); await gate; } return { content: [{ type: 'text', text: 'result' }] }; } });
  const { adapter, registry } = setup(f.url, { now: () => now, ttlMs: 10 });
  try {
    await approve(adapter, registry);
    const first = await adapter.call(request); assert.equal(first.state, 'completed');
    if (first.state !== 'completed' || first.payload.state !== 'available') throw new Error('missing handle');
    const slice = { ...request, handle: first.payload.handle, offset: 0, length: 1 };
    assert.equal(adapter.readSlice({ ...slice, account: 'other' }).state, 'refused');
    assert.equal(adapter.readSlice({ ...slice, resource: 'other' }).state, 'refused');
    assert.equal(adapter.readSlice({ ...slice, generation: 2 }).state, 'refused');
    assert.equal(adapter.readSlice({ ...slice, length: 98 }).state, 'unavailable');
    now = 111; assert.equal(adapter.readSlice(slice).state, 'expired');
    blocked = true; const pending = adapter.call(request); await dispatched;
    registry.revoke('source'); release();
    assert.equal((await pending).state, 'unknown');
    assert.equal(adapter.readSlice(slice).state, 'refused');
  } finally { release(); await adapter.close(); await f.close(); }
});

test('tool errors are explicit, capacity and oversize unavailable, empty result is not fake coverage', async () => {
  for (const mode of ['tool-error', 'capacity', 'oversize', 'empty'] as const) {
    const f = await fixture({ call: () => mode === 'tool-error' ? { isError: true, content: [{ type: 'text', text: 'synthetic error' }] } : { content: mode === 'empty' ? [] : [{ type: 'text', text: 'x'.repeat(mode === 'oversize' ? 1000 : 300) }] } });
    const { adapter, registry } = setup(f.url, { maxBytes: mode === 'capacity' ? 1 : 20_000, responseBytes: mode === 'oversize' ? 500 : 20_000 });
    try {
      await approve(adapter, registry);
      const result = await adapter.call(request);
      if (mode === 'oversize') { assert.equal(result.state, 'unknown'); assert.equal(f.counter, 1); }
      else {
        assert.equal(result.state, mode === 'tool-error' ? 'tool-error' : 'completed');
        if (result.state !== 'completed' && result.state !== 'tool-error') throw new Error('missing result');
        assert.equal(result.coverage.completeCorpus, false);
        assert.equal(result.payload.state, mode === 'capacity' ? 'unavailable' : 'available');
      }
    } finally { await adapter.close(); await f.close(); }
  }
});

test('SSE call entity reconstructed exactly through bounded slices, not reserialized SDK JSON', async () => {
  const f = await fixture({ jsonResponse: false }); const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const result = await adapter.call(request);
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed' || result.payload.state !== 'available') throw new Error('missing SSE result');
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < result.payload.byteLength; offset += 97) {
      const slice = adapter.readSlice({ ...request, handle: result.payload.handle, offset, length: Math.min(97, result.payload.byteLength - offset) });
      if (slice.state !== 'available') throw new Error('missing SSE bytes');
      chunks.push(slice.bytes);
    }
    assert.deepEqual(Buffer.concat(chunks), f.responseEntities[0]);
    assert.match(Buffer.concat(chunks).toString(), /data:.*synthetic α payload/);
  } finally { await adapter.close(); await f.close(); }
});

test('session404 after observed dispatch never reinitializes or replays the call; reconnect only discovers', async () => {
  const f = await fixture({ callStatus: 404 }); const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const before = f.observed.filter(row => row.method === 'initialize').length;
    const result = await adapter.call(request); assert.equal(result.state, 'unknown'); assert.equal(f.counter, 1);
    assert.equal(f.observed.filter(row => row.method === 'initialize').length, before);
    // This fixture is intentionally one-session only: stale reconnect can fail explicitly, never fabricate data.
    await adapter.discover('source'); assert.equal(f.counter, 1);
    assert.equal(adapter.visibleTools('source').length, 0);
  } finally { await adapter.close(); await f.close(); }
});

test('actual list_changed during call invalidates result before any handle is published', async () => {
  let entered!: () => void; let release!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ call: async () => { entered(); await gate; return { content: [] }; } });
  const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const pending = adapter.call(request); await dispatched;
    await f.sdk.notification({ method: 'notifications/tools/list_changed' }); await adapter.whenSuspended('source');
    release(); assert.equal((await pending).state, 'unknown'); assert.equal(f.counter, 1);
    assert.equal((await adapter.call(request)).state, 'refused'); assert.equal(f.counter, 1);
  } finally { release(); await adapter.close(); await f.close(); }
});

test('store entry capacity, endpoint scope, independent caller bytes, and budget validation are explicit', async () => {
  const f = await fixture(); const { adapter, registry } = setup(f.url, { maxEntries: 1 });
  try {
    await approve(adapter, registry);
    const first = await adapter.call(request); const second = await adapter.call(request);
    if (first.state !== 'completed' || first.payload.state !== 'available' || second.state !== 'completed') throw new Error('missing store results');
    assert.deepEqual(second.payload, { state: 'unavailable', reason: 'capacity' });
    assert.equal(adapter.readSlice({ ...request, endpointId: 'unknown', handle: first.payload.handle, offset: 0, length: 1 }).state, 'refused');
    const slice = { ...request, handle: first.payload.handle, offset: 0, length: 1 };
    const original = adapter.readSlice(slice); if (original.state !== 'available') throw new Error('missing original');
    original.bytes[0] = 0;
    const again = adapter.readSlice(slice); assert.equal(again.state, 'available');
    if (again.state === 'available') assert.notEqual(again.bytes[0], 0);
    assert.throws(() => new MemoryResultStore({ maxBytes: 0 }));
    assert.throws(() => createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { maxPages: Infinity } }));
  } finally { await adapter.close(); await f.close(); }
});

test('malformed remote results and finite discovery page/tool budgets fail explicitly with no partial ready state', async () => {
  const malformed = await fixture({ malformedCall: true });
  const normal = await fixture();
  const a = setup(malformed.url);
  const registry = new McpRegistry(); registry.register({ id: 'source', url: normal.url, account: 'account-a', resource: 'resource-a' }); registry.enable('source'); registry.allowEgress('source');
  const b = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { maxTools: 1 } });
  try {
    await approve(a.adapter, a.registry);
    const result = await a.adapter.call(request);
    const wire = JSON.parse(malformed.responseEntities[0]!.toString()) as Record<string, unknown>;
    assert('result' in wire && !('error' in wire), 'actual malformed result, not official server validation error');
    assert.equal(result.state, 'unknown'); assert.equal(malformed.counter, 1);
    assert.equal((await b.discover('source')).state, 'unavailable'); assert.deepEqual(b.visibleTools('source'), []);
  } finally { await a.adapter.close(); await b.close(); await malformed.close(); await normal.close(); }
});

test('explicit JSON-RPC error is a completed protocol-error, not unknown success or retried execution', async () => {
  const f = await fixture({ call: () => { throw new Error('synthetic protocol rejection'); } }); const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const result = await adapter.call(request);
    assert.equal(String(result.state), 'protocol-error'); assert.equal(f.counter, 1);
    assert('protocolErrorCode' in result);
    assert.equal(typeof result.protocolErrorCode, 'number');
    assert('coverage' in result);
    assert.equal(result.coverage.remoteSideEffects, 'unverified');
  } finally { await adapter.close(); await f.close(); }
});

test('notification stream resource budget suspends authority; source refuses revoked egress before dispatch', async () => {
  const f = await fixture(); const { adapter, registry } = setup(f.url, { responseBytes: 500 });
  try {
    await approve(adapter, registry);
    await f.sdk.notification({ method: 'notifications/message', params: { level: 'info', data: 'x'.repeat(1000) } });
    await adapter.whenSuspended('source');
    assert.equal((await adapter.call(request)).state, 'refused'); assert.equal(f.counter, 0);
    registry.denyEgress('source');
    const before = f.observed.length;
    assert.equal((await adapter.discover('source')).state, 'unavailable');
    assert.equal(f.observed.length, before);
  } finally { await adapter.close(); await f.close(); }
});

test('revocation across asynchronous credential resolution is refused before dispatch; pre-abort and account/resource mismatch send no call', async () => {
  const f = await fixture(); const registry = new McpRegistry();
  registry.register({ id: 'source', url: f.url, account: 'account-a', resource: 'resource-a', credentialRef: 'local-ref' }); registry.enable('source'); registry.allowEgress('source');
  let block = false; let entered!: () => void; let release!: () => void;
  const credentialStarted = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: async reference => {
    assert.equal(reference, 'local-ref'); if (block) { entered(); await gate; } return 'synthetic-token';
  } });
  try {
    await approve(adapter, registry);
    assert.equal((await adapter.call(request, AbortSignal.abort())).state, 'refused');
    assert.equal((await adapter.call({ ...request, account: 'wrong' })).state, 'refused');
    assert.equal((await adapter.call({ ...request, resource: 'wrong' })).state, 'refused');
    block = true; const pending = adapter.call(request); await credentialStarted;
    registry.revoke('source'); release();
    assert.equal((await pending).state, 'refused'); assert.equal(f.counter, 0);
    assert.equal(f.observed.filter(row => row.method === 'tools/call').length, 0);
  } finally { release(); await adapter.close(); await f.close(); }
});

test('explicit protocol rejection over SSE is SDK-observed and never replayed', async () => {
  const f = await fixture({ jsonResponse: false, call: () => { throw new Error('synthetic SSE rejection'); } }); const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const result = await adapter.call(request); assert.equal(result.state, 'protocol-error'); assert.equal(f.counter, 1);
    assert('protocolErrorCode' in result); assert.equal(typeof result.protocolErrorCode, 'number');
  } finally { await adapter.close(); await f.close(); }
});
