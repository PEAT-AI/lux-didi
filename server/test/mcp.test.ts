import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/index.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import type { ToolDefinition, CallRequest, McpPort, EndpointConfig } from '../adapters/mcp/port.js';

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
  callStatusWithBody?: boolean;
  callHtml?: boolean;
  callOutcome?: ((index: number) => Promise<{ status?: number; malformed?: boolean }>) | undefined;
  malformedCall?: boolean;
  callFraming?: 'single' | 'multiline' | 'keepalive' | 'empty';
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
      const callIndex = packet.method === 'tools/call' ? observed.filter(row => row.method === 'tools/call').length : 0;
      let response = await transport.handleRequest(request);
      const outcome = callIndex > 0 ? await options.callOutcome?.(callIndex) : undefined;
      if (packet.method === 'tools/call' && (options.malformedCall || outcome?.malformed)) {
        // Deliberately corrupt one genuine SDK response after server execution.
        // This is a negative wire fixture, never a fabricated success response.
        const envelope = await response.json() as Record<string, unknown>;
        envelope.result = { content: [{ type: 'unsupported', text: 'invalid wire result' }] };
        response = new Response(JSON.stringify(envelope), { status: 200, headers: response.headers });
      }
      if (packet.method === 'tools/call' && options.callFraming) {
        const json = await response.text();
        const frame = options.callFraming === 'empty' ? ': keepalive\n\n'
          : options.callFraming === 'multiline' ? `event: message\ndata: ${json.slice(0, json.indexOf(',') + 1)}\ndata: ${json.slice(json.indexOf(',') + 1)}\n\n`
          : `${options.callFraming === 'keepalive' ? ': heartbeat\r\n\r\n' : ''}event: message\r\ndata: ${json}\r\n\r\n`;
        response = new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (packet.method === 'tools/call' && (options.callStatus || outcome?.status)) {
        if (options.callHtml) { void response.body?.cancel().catch(() => {}); res.writeHead(outcome?.status ?? options.callStatus!, { 'content-type': 'text/html' }); res.end('<html>Temporarily unavailable</html>'); return; }
        if (options.callStatusWithBody) { res.writeHead(outcome?.status ?? options.callStatus!, { 'content-type': 'application/json' }); res.end(await response.text()); return; }
        void response.body?.cancel().catch(() => {});
        res.writeHead(outcome?.status ?? options.callStatus!); res.end(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
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
function setup(url: string, extras: { now?: () => number; maxBytes?: number; ttlMs?: number; maxEntries?: number; timeoutMs?: number; responseBytes?: number; credential?: string; transportState?: (event: { state: string; recoverable: boolean }) => void } = {}) {
  const registry = new McpRegistry();
  registry.register({ id: 'source', url, account: 'account-a', resource: 'resource-a', ...(extras.credential ? { credentialRef: 'token-ref' } : {}) });
  registry.enable('source'); registry.allowEgress('source');
  const store = new MemoryResultStore({ maxBytes: extras.maxBytes ?? 20_000, maxEntries: extras.maxEntries ?? 10, ttlMs: extras.ttlMs ?? 1000, maxSliceBytes: 97, now: extras.now ?? Date.now });
  const adapter = createMcpAdapter({ registry, store, ...(extras.transportState ? { onTransportState: extras.transportState } : {}), resolveCredential: async ref => { assert.equal(ref, 'token-ref'); return extras.credential ?? ''; }, budgets: { timeoutMs: extras.timeoutMs ?? 1000, maxResponseBytes: extras.responseBytes ?? 20_000, maxPages: 8, maxTools: 20, projectionChars: 18 } });
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
      assert.equal(result.state, 'unknown'); if (result.state === 'unknown') assert.equal(result.reason, cancel ? 'cancelled' : 'timeout'); assert.equal(adapter.visibleTools('source').length, 1, 'a soft failure must not suspend the connector'); assert.equal(f.counter, 1); assert(Date.now() - started < 1500);
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
    assert.equal(result.state, 'unknown'); if (result.state === 'unknown') assert.equal(result.reason, 'invalid_result'); assert.equal(a.adapter.visibleTools('source').length, 1, 'an invalid result must not suspend the connector'); assert.equal(malformed.counter, 1);
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

test('CURRENT locator mutation across credential await refuses before any tool HTTP; same-binding replacement stays authorized', async () => {
  const f = await fixture(); const registry = new McpRegistry();
  registry.register({ id: 'source', url: f.url, account: 'account-a', resource: 'resource-a', credentialRef: 'local-ref' }); registry.enable('source'); registry.allowEgress('source');
  let current = true; let block = false; let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  // Structural extension is deliberately ignored on the baseline: observable zero-HTTP requirement fails.
  const options = { registry, store: new MemoryResultStore(), resolveCredential: async () => { if (block) { entered(); await gate; } return 'synthetic-token'; },
    assertCredentialCurrent: (reference: string) => { assert.equal(reference, 'local-ref'); if (!current) throw Error('credential-not-current'); } };
  const adapter = createMcpAdapter(options);
  try {
    await approve(adapter, registry);
    assert.equal((await adapter.call(request)).state, 'completed');
    const before = f.observed.filter(row => row.method === 'tools/call').length;
    block = true; const pending = adapter.call(request); await started; current = false; release();
    assert.equal((await pending).state, 'refused');
    assert.equal(f.observed.filter(row => row.method === 'tools/call').length, before);
  } finally { release(); await adapter.close(); await f.close(); }
});

test('registry restoration is distinct from new approval and retains exact scope through suspension', () => {
  const registry = new McpRegistry(); registry.register({ id: 'x', url: 'https://synthetic.invalid/mcp', account: 'a', resource: 'r' }); registry.enable('x'); registry.allowEgress('x');
  const digest = registry.observed('x', [tool, writeTool], registry.revision('x'));
  const grant = { endpointId: 'x', schemaDigest: digest, toolNames: ['read'], effect: 'read' as const, account: 'a', resource: 'r', generation: 1 };
  registry.approve(grant); registry.suspend('x'); registry.observed('x', [tool, writeTool], registry.revision('x'));
  const restorable = registry as McpRegistry & { restore(input: typeof grant): void };
  assert.throws(() => restorable.restore({ ...grant, toolNames: ['read', 'write'] }));
  restorable.restore(grant); assert.deepEqual(registry.currentGrant('x'), grant);
  assert.throws(() => registry.approve(grant));
  registry.revoke('x'); assert.throws(() => restorable.restore(grant));
});

// D11b d11b-mcp.jsonl records 6/10/14/15: shape only, no knowledge text.
const recordedProviderShape = { content: [{ type: 'text', text: 'synthetic α payload' }], structuredContent: { synthetic: true }, isError: false };
for (const framing of ['single', 'multiline', 'keepalive'] as const) {
  test(`SSE ${framing} response publishes a decoded JSON-RPC result`, async () => {
    const f = await fixture({ jsonResponse: true, callFraming: framing, call: () => recordedProviderShape });
    const { adapter, registry } = setup(f.url);
    try {
      await approve(adapter, registry);
      const result = await adapter.call(request);
      assert.equal(result.state, 'completed');
      if (result.state !== 'completed' || result.payload.state !== 'available') throw Error('missing result');
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < result.payload.byteLength; offset += 97) {
        const slice = adapter.readSlice({ ...result.source, handle: result.payload.handle, offset, length: Math.min(97, result.payload.byteLength - offset) });
        assert.equal(slice.state, 'available');
        if (slice.state !== 'available') throw Error('missing slice');
        chunks.push(slice.bytes);
      }
      assert.deepEqual(Buffer.concat(chunks), f.responseEntities[0], 'SSE wire entity stays exact');
      assert('decodedResult' in result, 'adapter separately returns the decoded MCP result');
      const decoded = result.decodedResult as { content: { text: string }[] };
      assert.equal(decoded.content[0]?.text, 'synthetic α payload');
      assert.deepEqual(result.decodedResult, recordedProviderShape);
    } finally { await adapter.close(); await f.close(); }
  });
}
test('SSE without a JSON-RPC response returns a bounded transport code', async () => {
  const f = await fixture({ jsonResponse: true, callFraming: 'empty' });
  const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const result = await adapter.call(request);
    assert.deepEqual(result, { state: 'unknown', reason: 'sdk_protocol_rejected' });
    await adapter.whenSuspended('source');
    assert.equal(adapter.visibleTools('source').length, 0, 'a transport protocol rejection suspends the connector');
  } finally { await adapter.close(); await f.close(); }
});


test('call timeout overrides snapshot valid values and reject invalid durations', async () => {
  const f = await fixture({ call: async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { content: [{ type: 'text', text: 'synthetic delayed result' }] };
  } });
  const registry = new McpRegistry();
  registry.register({ id: 'source', url: f.url, account: 'account-a', resource: 'resource-a' });
  registry.enable('source'); registry.allowEgress('source');
  const overrides = new Map([['source', 2000]]);
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 1000 },
    callTimeoutMsByEndpoint: overrides } as Parameters<typeof createMcpAdapter>[0]);
  overrides.set('source', 1);
  try {
    await approve(adapter, registry);
    const result = await adapter.call(request);
    assert.equal(result.state, 'completed', JSON.stringify(result));
  } finally { await adapter.close(); await f.close(); }
  for (const timeout of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createMcpAdapter({ registry, store: new MemoryResultStore(),
      callTimeoutMsByEndpoint: new Map([['source', timeout]]) } as Parameters<typeof createMcpAdapter>[0]), /invalid-adapter-budget/);
  }
});


test('call timeout override retains the HTTP response byte limit', async () => {
  const f = await fixture({ call: () => ({ content: [{ type: 'text', text: 'x'.repeat(4000) }] }) });
  const registry = new McpRegistry();
  registry.register({ id: 'source', url: f.url, account: 'account-a', resource: 'resource-a' });
  registry.enable('source'); registry.allowEgress('source');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { maxResponseBytes: 1000 },
    callTimeoutMsByEndpoint: new Map([['source', 30000]]) });
  try {
    await approve(adapter, registry);
    const result = await adapter.call(request);
    assert.equal(result.state, 'unknown');
    if (result.state === 'unknown') assert.equal(result.reason, 'response-oversize');
    assert.equal(f.counter, 1);
  } finally { await adapter.close(); await f.close(); }
});

// Warm-connector audit (W7): the same child process serves two sequential calls, and concurrent
// calls to one endpoint are refused, so a provider batch must fan out across endpoints, not within
// one (see the author report: batch dispatch is serial in tools/declarations.ts).
test('one long-lived stdio client serves two sequential calls and never forks per call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-warm-'));
  const pidFile = join(dir, 'child.pid');
  const child = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'stdio-mcp-child.mjs');
  const endpoint: EndpointConfig = { id: 'warm', transport: 'stdio', command: process.execPath, args: [child, 'ok', pidFile, 'stdio-pong'], env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'local', resource: 'warm-fixture' } as unknown as EndpointConfig;
  const registry = new McpRegistry();
  registry.register(endpoint);
  registry.enable('warm'); registry.allowEgress('warm');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 4000 } });
  try {
    const discovery = await adapter.discover('warm');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') return;
    registry.approve({ endpointId: 'warm', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: 'local', resource: 'warm-fixture', generation: 1 });
    const req: CallRequest = { endpointId: 'warm', toolName: 'echo', arguments: {}, generation: 1, account: 'local', resource: 'warm-fixture' };
    assert.equal((await adapter.call(req)).state, 'completed');
    const first = readFileSync(pidFile, 'utf8');
    assert.equal((await adapter.call(req)).state, 'completed');
    assert.equal(readFileSync(pidFile, 'utf8'), first, 'the same child pid must serve both sequential calls');
    const pair = await Promise.all([adapter.call(req), adapter.call(req)]);
    assert.deepEqual(pair.map(result => result.state), ['completed', 'completed'], 'two concurrent same-endpoint calls both complete, none is refused as busy');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

const flush = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

/** The fixture server holds every tools/call on `gate` so the test can observe true concurrency. */
function heldCall(): { call: () => Promise<unknown>; release: () => void; peak: () => number; arrived: () => number } {
  let inFlight = 0; let peak = 0; let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return {
    release,
    peak: () => peak,
    arrived: () => arrived,
    call: async () => { inFlight += 1; arrived += 1; peak = Math.max(peak, inFlight); await gate; inFlight -= 1; return { content: [{ type: 'text', text: 'synthetic pong' }] }; },
  };
}

test('F6: N concurrent same-endpoint calls run at once, N+2 queue, and all complete', async () => {
  const held = heldCall();
  const f = await fixture({ call: held.call });
  const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const calls = Array.from({ length: 8 }, () => adapter.call(request));
    for (let i = 0; i < 100 && held.peak() < 6; i++) await flush();
    assert.equal(held.peak(), 6, 'six calls run at once; the two beyond the limit queue');
    held.release();
    const results = await Promise.all(calls);
    assert.equal(results.every(result => result.state === 'completed'), true, JSON.stringify(results));
    assert.equal(held.peak(), 6, 'the concurrency limit is never exceeded');
  } finally { await adapter.close(); await f.close(); }
});

test('F6: a queued call aborted before dispatch never reaches the transport', async () => {
  const held = heldCall();
  const f = await fixture({ call: held.call });
  const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const running = Array.from({ length: 6 }, () => adapter.call(request));
    for (let i = 0; i < 100 && held.arrived() < 6; i++) await flush();
    assert.equal(held.arrived(), 6, 'six calls are in flight');
    const controller = new AbortController();
    const queued = adapter.call(request, controller.signal);
    await flush();
    controller.abort();
    const rejected = await queued;
    assert.equal(rejected.state, 'refused');
    assert.equal(rejected.reason, 'cancelled-before-dispatch');
    held.release();
    const results = await Promise.all(running);
    assert.equal(results.every(result => result.state === 'completed'), true);
    assert.equal(held.arrived(), 6, 'the aborted queued call never reached the transport');
  } finally { await adapter.close(); await f.close(); }
});

test('F8-R3: adapter close aborts an in-flight and a queued call with the close code', async () => {
  const held = heldCall();
  const f = await fixture({ call: held.call });
  const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const running = Array.from({ length: 6 }, () => adapter.call(request));
    for (let i = 0; i < 100 && held.peak() < 6; i++) await flush();
    assert.equal(held.peak(), 6, 'six calls are in flight');
    const queued = adapter.call(request);
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(held.arrived(), 6, 'the seventh call queues behind the limit');
    const startedAt = Date.now();
    await adapter.close();
    assert.ok(Date.now() - startedAt < 2000, 'close completes promptly');
    const results = await Promise.all([...running, queued]);
    assert.equal(results.every(result => result.state === 'refused' && result.reason === 'adapter-closed'), true, JSON.stringify(results));
  } finally { await adapter.close(); await f.close(); }
});

test('F6: five callers racing a cold endpoint create one session', async () => {
  const f = await fixture();
  const { adapter, registry } = setup(f.url);
  try {
    // Pre-approve without discovery so no session exists when the callers race.
    const tools = [tool, writeTool];
    const digest = registry.observed('source', tools, registry.revision('source'));
    registry.approve({ endpointId: 'source', schemaDigest: digest, toolNames: tools.map(value => value.name), effect: 'read', account: 'account-a', resource: 'resource-a', generation: 1 });
    const results = await Promise.all(Array.from({ length: 5 }, () => adapter.call(request)));
    assert.equal(results.every(result => result.state === 'completed'), true, JSON.stringify(results));
    assert.equal(f.observed.filter(row => row.method === 'initialize').length, 1, 'one session creation for five racing callers');
  } finally { await adapter.close(); await f.close(); }
});

test('F6: discovery waits for in-flight calls and new calls wait for discovery', async () => {
  const held = heldCall();
  const f = await fixture({ call: held.call });
  const { adapter, registry } = setup(f.url);
  try {
    await approve(adapter, registry);
    const inFlight = adapter.call(request);
    for (let i = 0; i < 100 && held.arrived() < 1; i++) await flush();
    assert.equal(held.arrived(), 1, 'the first call is in flight');
    const during = adapter.call(request);
    let discovered: string | undefined;
    void adapter.discover('source').then(result => { discovered = result.state; });
    for (let i = 0; i < 50; i++) await flush();
    assert.equal(discovered, undefined, 'discovery waits for the in-flight call');
    held.release();
    assert.equal((await inFlight).state, 'completed');
    for (let i = 0; i < 100 && discovered === undefined; i++) await flush();
    assert.equal(discovered, 'discovered', 'discovery completes once the calls drain');
    assert.equal((await during).state, 'completed', 'a call waiting on discovery then completes');
  } finally { await adapter.close(); await f.close(); }
});

test('F6: a dead stdio session fails every in-flight call once and the next call gets a fresh child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-f6-death-'));
  const pidFile = join(dir, 'child.pid');
  const child = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'stdio-mcp-child.mjs');
  const endpoint: EndpointConfig = { id: 'doomed', transport: 'stdio', command: process.execPath, args: [child, 'exit-on-call', pidFile, 'stdio-pong'], env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'local', resource: 'doomed-fixture' } as unknown as EndpointConfig;
  const registry = new McpRegistry();
  registry.register(endpoint);
  registry.enable('doomed'); registry.allowEgress('doomed');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 4000 } });
  try {
    const discovery = await adapter.discover('doomed');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') return;
    registry.approve({ endpointId: 'doomed', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: 'local', resource: 'doomed-fixture', generation: 1 });
    const req: CallRequest = { endpointId: 'doomed', toolName: 'echo', arguments: {}, generation: 1, account: 'local', resource: 'doomed-fixture' };
    const firstPid = readFileSync(pidFile, 'utf8');
    const results = await Promise.all([adapter.call(req), adapter.call(req), adapter.call(req)]);
    assert.equal(results.every(result => result.state === 'unknown'), true, JSON.stringify(results));
    assert.equal(new Set(results.map(result => result.state === 'unknown' ? result.reason : '')).size, 1, 'every in-flight call fails with one clean code');
    assert.equal(adapter.visibleTools('doomed').length, 1, 'one death is counted once, so the connector stays usable');
    const revived = await adapter.call(req);
    assert.equal(revived.state, 'unknown');
    assert.notEqual(readFileSync(pidFile, 'utf8'), firstPid, 'the next call gets a fresh child session');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('fluency: official SDK 500/502/503 emits one eligible retired-session burst without replay', async () => {
  for (const status of [500, 502, 503]) {
    const events: { state: string; recoverable: boolean }[] = [];
    const f = await fixture({ callStatus: status });
    const { adapter, registry } = setup(f.url, { transportState: event => events.push(event) });
    try {
      await approve(adapter, registry);
      assert.deepEqual(await adapter.call(request), { state: 'unknown', reason: 'transport_unavailable' });
      assert.equal(events.filter(event => event.state === 'retired' && event.recoverable).length, 1);
      assert.equal(registry.visibleTools('source').length, 0);
      assert.equal(f.counter, 1);
      assert.equal((await adapter.call(request)).state, 'refused');
      assert.equal(f.counter, 1, 'failed call never replays');
    } finally { await adapter.close(); await f.close(); }
  }
});

test('fluency: mixed availability and malformed-protocol burst cannot recover or rewrite outcomes', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void; const both = new Promise<void>(resolve => { arrived = resolve; });
  const f = await fixture({ callOutcome: async index => {
    if (index === 2) { arrived(); await gate; return { malformed: true }; }
    await both; return { status: 503 };
  } });
  const events: { state: string; recoverable: boolean }[] = [];
  const { adapter, registry } = setup(f.url, { transportState: event => events.push(event) });
  try {
    await approve(adapter, registry);
    const first = adapter.call(request); const second = adapter.call(request);
    assert.deepEqual(await first, { state: 'unknown', reason: 'transport_unavailable' });
    assert.equal(events.some(event => event.recoverable), false, 'pending dispatched read must settle first');
    release();
    const hard = await second;
    assert.notEqual(hard.state === 'unknown' ? hard.reason : '', 'transport_unavailable');
    assert.equal(events.filter(event => event.state === 'retired').length, 1);
    assert.equal(events.some(event => event.recoverable), false);
    assert.equal(f.counter, 2);
  } finally { release(); await adapter.close(); await f.close(); }
});


test('fluency: availability evidence excludes unsupported status and matching protocol bodies', async () => {
  for (const value of [{ callStatus: 504 }, { callStatus: 429 }, { callStatus: 401 }, { callStatus: 503, callStatusWithBody: true }, { malformedCall: true }]) {
    const events: { state: string; recoverable: boolean }[] = [];
    const f = await fixture(value); const { adapter, registry } = setup(f.url, { transportState: event => events.push(event) });
    try {
      await approve(adapter, registry);
      const result = await adapter.call(request);
      assert.notEqual(result.state === 'unknown' ? result.reason : '', 'transport_unavailable');
      assert.equal(events.some(event => event.recoverable), false);
      assert.equal(f.counter, 1);
    } finally { await adapter.close(); await f.close(); }
  }
});


test('fluency: concurrent availability failures retire once and queued requests do not create a new session', async () => {
  const events: { state: string; recoverable: boolean }[] = [];
  const f = await fixture({ callStatus: 503 }); const { adapter, registry } = setup(f.url, { transportState: event => events.push(event) });
  try {
    await approve(adapter, registry);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => adapter.call(request)));
    assert.ok(outcomes.every(result => result.state !== 'completed'));
    assert.equal(events.filter(event => event.state === 'retired' && event.recoverable).length, 1);
    assert.equal(f.observed.filter(row => row.method === 'initialize').length, 1);
    assert.ok(f.counter <= 6, 'queued work is refused without a remote dispatch');
  } finally { await adapter.close(); await f.close(); }
});


test('fluency R1: oversized HTTP503 entity remains a hard response-budget failure', async () => {
  const events: { state: string; recoverable: boolean }[] = [];
  const f = await fixture({ callStatus: 503, callStatusWithBody: true, call: () => ({ content: [{ type: 'text', text: 'x'.repeat(4096) }] }) });
  const { adapter, registry } = setup(f.url, { responseBytes: 1024, transportState: event => events.push(event) });
  try {
    await approve(adapter, registry);
    assert.deepEqual(await adapter.call(request), { state: 'unknown', reason: 'response-oversize' });
    assert.equal(events.some(event => event.recoverable), false);
    assert.equal(f.counter, 1);
  } finally { await adapter.close(); await f.close(); }
});


test('fluency R1: ordinary HTML500/502/503 failures remain recoverable availability', async () => {
  for (const status of [500, 502, 503]) {
    const events: { state: string; recoverable: boolean }[] = [];
    const f = await fixture({ callStatus: status, callHtml: true });
    const { adapter, registry } = setup(f.url, { transportState: event => events.push(event) });
    try {
      await approve(adapter, registry);
      assert.deepEqual(await adapter.call(request), { state: 'unknown', reason: 'transport_unavailable' });
      assert.equal(events.filter(event => event.state === 'retired' && event.recoverable).length, 1);
      assert.equal(f.counter, 1);
    } finally { await adapter.close(); await f.close(); }
  }
});

// --- W9: every configured source is reachable, and a source that is not says why. ---

const googleChild = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'google-mcp-child.mjs');
const ACCOUNT = 'local';
const OWNER = 'owner@example.invalid';

/** A google endpoint exactly as the installed profile shapes one: stdio helper, approved env, private class. */
function googleEndpoint(id: string, unknownClass: string): Record<string, unknown> {
  return {
    id, transport: 'stdio', command: process.execPath,
    args: [googleChild, 'ok'],
    env: { HOME: '/home/fixture', PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    connector: 'google', account: ACCOUNT, resource: `google-${id}`, credentialRef: null, enabled: true,
    allowEgress: true, unknownClass,
  };
}

function writeGoogleConfig(configDir: string, endpoints: readonly Record<string, unknown>[]): void {
  writeFileSync(join(configDir, 'mcp.json'),
    JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: OWNER, endpoints }),
    { mode: 0o600 });
}

/** The durable approval row the previous release wrote: same endpoint, the pre-rename Google tool names. */
function seedStaleGoogleRow(store: Store, id: string, endpoint: Record<string, unknown>, enabled = true): void {
  const policy = {
    schemaVersion: 1, bindingMode: 'connection', ownerId: store.assistantId, connectionId: id, generation: 2,
    enabled, connector: 'google',
    endpoint: {
      id, transport: 'stdio', command: endpoint['command'], args: endpoint['args'],
      env: endpoint['env'], account: ACCOUNT, resource: `google-${id}`, credentialRef: null,
    },
    toolNames: id === 'gmail'
      ? ['gmail_get_profile', 'gmail_list', 'gmail_read']
      : ['gcal_calendars', 'gcal_list'],
    schemaDigest: 'a'.repeat(64),
    sourcePolicy: { id, revision: 2, unknownClass: 'private', allowedClasses: ['private'] },
    route: { identity: id, allowedClasses: ['private'] },
    bounds: { maxEntityBytes: 1048576, maxGetIds: 100, maxQueryChars: 16384, maxResultBytes: 1048576, maxSearchLimit: 100 },
  };
  const bytes = canonicalJSON(policy);
  store.transaction(tx => tx.run(
    'INSERT INTO tool_connections VALUES (?,?,?,?,?,?,?)',
    [store.assistantId, id, id, 2, Number(enabled), bytes, sha256(bytes)]));
}

test('a durable approval row from the previous tool names reconnects under owner-trusted-reads', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-stale-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const endpoint = googleEndpoint('gmail', 'private');
  writeGoogleConfig(configDir, [endpoint]);
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const failures: { connector: string; stage: string; detail?: { reason?: string; endpointId?: string } }[] = [];
  try {
    seedStaleGoogleRow(store, 'gmail', endpoint);
    const runtime = await host.composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      connectorLog: (connector, stage, detail) => { failures.push({ connector, stage, ...(detail ? { detail } : {}) }); },
    });
    try {
      const report = runtime.status().endpoints.find(endpoint => endpoint.id === 'gmail');
      assert.equal(report?.state, 'connected', JSON.stringify(report));
      const storedNames = JSON.parse(String(store.transaction(tx => tx.get(
        "SELECT policy_json FROM tool_connections WHERE connection_id='gmail'"))?.['policy_json'] ?? '{}')).toolNames as string[];
      assert.equal(report?.tools, storedNames.length, 'the grant publishes exactly the reconciled row');
      assert.ok(storedNames.includes('gmail_search_messages') && storedNames.includes('calendar_list_events'));
      assert.ok(!storedNames.includes('gmail_list') && !storedNames.includes('gcal_calendars'), 'no pre-rename name survives');
      assert.ok(runtime.connectionIds().includes('gmail'), 'the source is in connectionIds()');
      assert.deepEqual(failures, [], 'a reconciled source is not a failure');
      const row = store.transaction(tx => tx.get(
        "SELECT policy_json, generation FROM tool_connections WHERE connection_id='gmail'"));
      const stored = JSON.parse(String(row?.['policy_json'])) as { toolNames: string[]; generation: number };
      assert.deepEqual([...stored.toolNames].sort(), ['calendar_list_calendars', 'calendar_list_events', 'gmail_get_profile', 'gmail_read_message', 'gmail_search_messages']);
      assert.equal(Number(row?.['generation']), 3, 'the reconciled approval is a new generation');
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a stored revocation is honoured even when its row no longer validates', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-revoked-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const endpoint = googleEndpoint('gmail', 'private');
  writeGoogleConfig(configDir, [endpoint]);
  const store = new Store(join(dir, 'data'), toolsMigrations);
  try {
    seedStaleGoogleRow(store, 'gmail', endpoint, false);
    const runtime = await host.composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
    try {
      assert.equal(runtime.status().endpoints.find(endpoint => endpoint.id === 'gmail')?.state, 'error');
      assert.deepEqual(runtime.connectionIds(), [], 'a revoked approval is never re-published');
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a configured endpoint that cannot connect logs exactly one closed connector_failure line', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-configerr-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  // 'secret' is not one of ordinary/private/sensitive: a configuration-time rejection, never a spawn.
  writeGoogleConfig(configDir, [googleEndpoint('gmail', 'secret')]);
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const failures: { connector: string; stage: string; detail?: { reason?: string; endpointId?: string } }[] = [];
  try {
    const runtime = await host.composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      connectorLog: (connector, stage, detail) => { failures.push({ connector, stage, ...(detail ? { detail } : {}) }); },
    });
    try {
      assert.equal(runtime.status().endpoints.find(endpoint => endpoint.id === 'gmail')?.configurationError, 'unknown-class-invalid');
      assert.equal(failures.length, 1, `exactly one line, saw ${JSON.stringify(failures)}`);
      assert.equal(failures[0]?.connector, 'google');
      assert.equal(failures[0]?.detail?.endpointId, 'gmail');
      assert.equal(failures[0]?.detail?.reason, 'unknown-class-invalid');
      assert.match(failures[0]?.stage ?? '', /^[a-z_]{1,16}$/, 'a closed stage token, never free text');
      assert.deepEqual(runtime.connectionIds(), []);
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// --- W9 reviewer round: registration failures, installed shape, reconciliation breadth, line counts. ---

/** The installed provider-38 mcp.json structure, values replaced by locals. */
function installedShape(): { schemaVersion: 1; grantMode: 'owner-trusted-reads'; ownerIdentity: string; endpoints: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(new URL('../../test/fixtures/installed-mcp-config.json', import.meta.url), 'utf8')) as never;
}

function localEndpoint(endpoint: Record<string, unknown>, child: string, args: readonly string[]): Record<string, unknown> {
  const { url: _url, command: _command, ...rest } = endpoint;
  if (endpoint['transport'] === 'stdio') {
    return { ...rest, command: process.execPath, args: [...args], env: { HOME: '/home/fixture', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' } };
  }
  return { ...rest, url: child };
}

test('the installed five-endpoint shape reports every endpoint and connects every reachable one', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-installed-shape-'));
  const configDir = join(dir, 'provider-config'); mkdirSync(configDir, { mode: 0o700 });
  const fixture = installedShape();
  const shape = fixture.endpoints.map(endpoint => {
    if (endpoint['connector'] === 'google') return localEndpoint(endpoint, '', [googleChild, 'ok']);
    if (endpoint['connector'] === 'mattermost') return localEndpoint(endpoint, '', [join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdio-mattermost-child.mjs'), 'ok']);
    // lux-knowledge and mongoose keep their streamable-http shape and point at a refusing local port.
    return { ...endpoint, url: 'http://127.0.0.1:1/mcp' };
  });
  const { source: _source, ...profile } = fixture as typeof fixture & { source?: string };
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ ...profile, endpoints: shape }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const failures: { connector: string; stage: string; detail?: { reason?: string; endpointId?: string } }[] = [];
  try {
    const runtime = await host.composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      connectorLog: (connector, stage, detail) => { failures.push({ connector, stage, ...(detail ? { detail } : {}) }); },
    });
    try {
      const reports = runtime.status().endpoints;
      assert.deepEqual(reports.map(report => report.id).sort(), ['calendar', 'gmail', 'lux-knowledge', 'mattermost', 'mongoose'],
        'one report per installed endpoint: none vanishes');
      assert.deepEqual(runtime.connectionIds().sort(), ['calendar', 'gmail', 'mattermost']);
      const gmail = reports.find(report => report.id === 'gmail');
      assert.equal(gmail?.state, 'connected');
      assert.ok((gmail?.tools ?? 0) >= 3, 'gmail publishes its reads');
      // Behaviour 1's other half: the calendar digest has a reader only when a calendar grant is current.
      const grant = runtime.registry.currentGrant('calendar');
      assert.ok(grant, 'a calendar grant exists, so the digest reader is composed');
      // Every endpoint that did not connect says so exactly once, in closed codes.
      const failed = failures.map(failure => failure.detail?.endpointId).sort();
      assert.deepEqual(failed, ['lux-knowledge', 'mongoose']);
      for (const failure of failures) {
        assert.match(failure.stage, /^(config|credential|spawn|handshake|first_call)$/);
        assert.match(String(failure.detail?.reason ?? ''), /^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'closed reason only');
      }
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a registration-class rejection is reported and says why, and never takes the other sources down', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-registration-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const missing = { id: 'gmail', transport: 'stdio' as const, command: join(dir, 'no-such-helper'), args: [] as string[],
    env: { HOME: '/home/fixture', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    connector: 'google', account: ACCOUNT, resource: 'google-gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'private' };
  const healthy = { ...missing, id: 'knowledge', connector: 'lux-knowledge', resource: 'lux-knowledge', command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdio-mcp-child.mjs'), 'ok'] };
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [missing, healthy] }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const failures: { connector: string; stage: string; detail?: { reason?: string; endpointId?: string } }[] = [];
  try {
    const runtime = await host.composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      connectorLog: (connector, stage, detail) => { failures.push({ connector, stage, ...(detail ? { detail } : {}) }); },
    });
    try {
      const gmail = runtime.status().endpoints.find(report => report.id === 'gmail');
      assert.equal(gmail?.state, 'error', 'a rejected endpoint is reported, never absent');
      assert.equal(failures.length, 1, 'exactly one line for the rejected endpoint');
      assert.equal(failures[0]?.detail?.endpointId, 'gmail');
      assert.equal(failures[0]?.stage, 'config');
      assert.match(String(failures[0]?.detail?.reason), /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
      assert.ok(runtime.status().endpoints.some(report => report.id === 'knowledge'), 'the healthy sibling still composes');
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a transport failure carrying an exception code logs once, and a refresh never doubles the start line', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-exception-line-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const crashing = { id: 'mail', transport: 'stdio' as const, command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdio-mcp-child.mjs'), 'crash'],
    env: { HOME: '/home/fixture', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    connector: 'google', account: ACCOUNT, resource: 'google-gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'private' };
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [crashing] }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const failures: { connector: string; stage: string; detail?: { reason?: string; endpointId?: string; exceptionCode?: string } }[] = [];
  try {
    const runtime = await host.composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      connectorLog: (connector, stage, detail) => { failures.push({ connector, stage, ...(detail ? { detail } : {}) }); },
    });
    try {
      const report = runtime.status().endpoints.find(endpoint => endpoint.id === 'mail');
      assert.equal(report?.state, 'error');
      assert.equal(failures.length, 1, `one closed line for the start failure, saw ${JSON.stringify(failures.map(f => f.detail))}`);
      assert.ok(failures[0]?.detail?.exceptionCode || failures[0]?.detail?.reason, 'a closed code travels');
      await runtime.recover();
      assert.equal(failures.length, 1, 'a later refresh never doubles the start line');
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a tampered or foreign durable row is refused, never re-published from config', { skip: process.platform === 'win32' }, async () => {
  const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-tampered-row-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const endpoint = { id: 'gmail', transport: 'stdio' as const, command: process.execPath, args: [googleChild, 'ok'],
    env: { HOME: '/home/fixture', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    connector: 'google', account: ACCOUNT, resource: 'google-gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'private' };
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [endpoint] }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  try {
    // A row for another account: the release-rename tolerance must not adopt it.
    const foreign = { schemaVersion: 1, bindingMode: 'connection', ownerId: store.assistantId, connectionId: 'gmail', generation: 2,
      enabled: true, connector: 'google', endpoint: { id: 'gmail', transport: 'stdio', command: process.execPath, args: [googleChild, 'ok'],
        env: endpoint.env, account: 'someone-else', resource: 'google-gmail', credentialRef: null },
      toolNames: ['gmail_list'], schemaDigest: 'b'.repeat(64),
      sourcePolicy: { id: 'gmail', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
      route: { identity: 'gmail', allowedClasses: ['private'] },
      bounds: { maxEntityBytes: 1048576, maxGetIds: 100, maxQueryChars: 16384, maxResultBytes: 1048576, maxSearchLimit: 100 } };
    const bytes = canonicalJSON(foreign);
    store.transaction(tx => tx.run('INSERT INTO tool_connections VALUES (?,?,?,?,?,?,?)',
      [store.assistantId, 'gmail', 'gmail', 2, 1, bytes, sha256(bytes)]));
    const runtime = await host.composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
    try {
      const report = runtime.status().endpoints.find(entry => entry.id === 'gmail');
      assert.equal(report?.state, 'error', JSON.stringify(report));
      assert.deepEqual(runtime.connectionIds(), [], 'a foreign row is never published');
      assert.equal(report?.configurationError, 'owner-approval-required');
    } finally { await runtime.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
