import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { CallRequest, EndpointConfig, McpPort } from '../adapters/mcp/port.js';

// Synthetic local stdio/HTTP bindings only: no real account, network or credential.
// The binding is cast because the discriminated endpoint binding is the change under test.
const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'stdio-mcp-child.mjs');
const ACCOUNT = 'local'; const RESOURCE = 'stdio-fixture';

function config(id: string, mode: string, pidFile: string, payload = 'stdio-pong', over: Record<string, unknown> = {}): EndpointConfig {
  return { id, transport: 'stdio', command: process.execPath, args: [child, mode, pidFile, payload], account: ACCOUNT, resource: RESOURCE, ...over } as unknown as EndpointConfig;
}
function request(id: string): CallRequest { return { endpointId: id, toolName: 'echo', arguments: {}, generation: 1, account: ACCOUNT, resource: RESOURCE }; }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!pidAlive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return !pidAlive(pid);
}
function readPayload(adapter: McpPort, req: CallRequest, handle: string, byteLength: number): string {
  const slice = adapter.readSlice({ endpointId: req.endpointId, generation: req.generation, account: req.account, resource: req.resource, handle, offset: 0, length: byteLength });
  assert.equal(slice.state, 'available');
  const bytes = slice.state === 'available' ? slice.bytes : new Uint8Array();
  return (JSON.parse(Buffer.from(bytes).toString()) as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '';
}
function adapterFor(registry: McpRegistry, timeoutMs = 4000): McpPort {
  return createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs } });
}
function scratch(): { dir: string; pidFile: string } { const dir = mkdtempSync(join(tmpdir(), 'didi-stdio-')); return { dir, pidFile: join(dir, 'child.pid') }; }

test('stdio binding registers, discovers and calls a real child server, then cleans up and closes within bounds', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ok', pidFile));
  registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter = adapterFor(registry);
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') return;
    assert.deepEqual(discovery.tools.map(tool => tool.name), ['echo']);
    registry.approve({ endpointId: 'local-stdio', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
    const result = await adapter.call(request('local-stdio'));
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed' || result.payload.state !== 'available') throw new Error('missing stdio payload');
    assert.equal(readPayload(adapter, request('local-stdio'), result.payload.handle, result.payload.byteLength), 'stdio-pong');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 0);
    const closed = await Promise.race([adapter.close().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))]);
    assert.equal(closed, true, 'adapter.close() must settle within bounds');
    assert.equal(await waitDead(pid, 2000), true, 'child must be gone after disposal');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unapproved stdio binding spawns no child', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ok', pidFile));
  const adapter = adapterFor(registry, 1000);
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.notEqual(discovery.state, 'discovered');
    assert.equal(existsSync(pidFile), false);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('malformed stdout, silent handshake and crash all fail explicitly instead of hanging', async () => {
  for (const mode of ['malformed', 'silent', 'crash']) {
    const { dir, pidFile } = scratch();
    const registry = new McpRegistry();
    registry.register(config('local-stdio', mode, pidFile));
    registry.enable('local-stdio'); registry.allowEgress('local-stdio');
    const adapter = adapterFor(registry, 2000);
    try {
      const discovery = await adapter.discover('local-stdio');
      assert.equal(discovery.state, 'unavailable', `${mode} must be unavailable`);
    } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('cancellation retires the child and reports an unknown outcome', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'hang-call', pidFile));
  registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter = adapterFor(registry, 8000);
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') return;
    registry.approve({ endpointId: 'local-stdio', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const result = await adapter.call(request('local-stdio'), controller.signal);
    clearTimeout(timer);
    assert.equal(result.state, 'unknown');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(await waitDead(pid, 2000), true, 'child must be gone after cancellation');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('parent shutdown retires every live child', async () => {
  const { dir, pidFile } = scratch();
  const second = join(dir, 'child2.pid');
  const registry = new McpRegistry();
  registry.register(config('local-a', 'ok', pidFile));
  registry.register(config('local-b', 'ok', second));
  registry.enable('local-a'); registry.allowEgress('local-a'); registry.enable('local-b'); registry.allowEgress('local-b');
  const adapter = adapterFor(registry);
  try {
    assert.equal((await adapter.discover('local-a')).state, 'discovered');
    assert.equal((await adapter.discover('local-b')).state, 'discovered');
    const pids = [Number(readFileSync(pidFile, 'utf8')), Number(readFileSync(second, 'utf8'))];
    await adapter.close();
    for (const pid of pids) assert.equal(await waitDead(pid, 2000), true, 'every child must be gone after parent shutdown');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent stdio responses stay isolated per endpoint', async () => {
  const { dir, pidFile } = scratch();
  const second = join(dir, 'child2.pid');
  const registry = new McpRegistry();
  registry.register(config('local-a', 'ok', pidFile, 'stdio-a'));
  registry.register(config('local-b', 'ok', second, 'stdio-b'));
  registry.enable('local-a'); registry.allowEgress('local-a'); registry.enable('local-b'); registry.allowEgress('local-b');
  const adapter = adapterFor(registry);
  try {
    const [a, b] = await Promise.all([adapter.discover('local-a'), adapter.discover('local-b')]);
    assert.equal(a.state, 'discovered'); assert.equal(b.state, 'discovered');
    if (a.state !== 'discovered' || b.state !== 'discovered') return;
    registry.approve({ endpointId: 'local-a', schemaDigest: a.schemaDigest, toolNames: ['echo'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
    registry.approve({ endpointId: 'local-b', schemaDigest: b.schemaDigest, toolNames: ['echo'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
    const [ra, rb] = await Promise.all([adapter.call(request('local-a')), adapter.call(request('local-b'))]);
    assert.equal(ra.state, 'completed'); assert.equal(rb.state, 'completed');
    if (ra.state !== 'completed' || ra.payload.state !== 'available' || rb.state !== 'completed' || rb.payload.state !== 'available') throw new Error('missing concurrent payload');
    assert.equal(readPayload(adapter, request('local-a'), ra.payload.handle, ra.payload.byteLength), 'stdio-a');
    assert.equal(readPayload(adapter, request('local-b'), rb.payload.handle, rb.payload.byteLength), 'stdio-b');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('changed args, environment or account lose the approved binding', () => {
  const registry = new McpRegistry();
  const base = config('local-stdio', 'ok', '/tmp/unused.pid');
  registry.register(base);
  assert.equal(registry.matchesEndpoint(base), true);
  const variant = (over: Record<string, unknown>): EndpointConfig => config('local-stdio', 'ok', '/tmp/unused.pid', 'stdio-pong', over);
  assert.equal(registry.matchesEndpoint(variant({ args: [child, 'ok', '/tmp/unused.pid', 'stdio-pong', 'EXTRA'] })), false);
  assert.equal(registry.matchesEndpoint(variant({ account: 'other' })), false);
  assert.equal(registry.matchesEndpoint(variant({ env: { HOME: '/tmp/other-root' } })), false);
});

test('non-absolute command is refused; an absolute binding ignores a decoy PATH entry', async () => {
  const registry = new McpRegistry();
  assert.throws(() => registry.register({ id: 'local-stdio', transport: 'stdio', command: 'node', args: [], account: ACCOUNT, resource: RESOURCE } as unknown as EndpointConfig));
  const { dir, pidFile } = scratch();
  const decoyDir = join(dir, 'decoy');
  mkdirSync(decoyDir);
  writeFileSync(join(decoyDir, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const original = process.env.PATH;
  process.env.PATH = `${decoyDir}:${original ?? ''}`;
  const decoyRegistry = new McpRegistry();
  decoyRegistry.register(config('local-stdio', 'ok', pidFile));
  decoyRegistry.enable('local-stdio'); decoyRegistry.allowEgress('local-stdio');
  const adapter = adapterFor(decoyRegistry);
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.equal(discovery.state, 'discovered');
  } finally { process.env.PATH = original; await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('secret-marker env never leaks into refusals or diagnostics', async () => {
  const marker = 'DIDI-SECRET-MARKER-XYZZY';
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  const binding = config('local-stdio', 'crash', pidFile, 'stdio-pong', { env: { DIDI_MARKER: marker } });
  let registered = false;
  try { registry.register(binding); registered = true; }
  catch (error) { assert.equal(String(error).includes(marker), false); assert.equal(String(error).includes(child), false); }
  try {
    if (!registered) return;
    registry.enable('local-stdio'); registry.allowEgress('local-stdio');
    const adapter = adapterFor(registry, 2000);
    try {
      const discovery = await adapter.discover('local-stdio');
      const serialized = JSON.stringify(discovery);
      assert.equal(serialized.includes(marker), false);
      assert.equal(serialized.includes(child), false);
      assert.equal(serialized.includes(process.execPath), false);
    } finally { await adapter.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function httpFixture() {
  const sdk = new Server({ name: 'http-synthetic-fixture', version: '1' }, { capabilities: { tools: {} } });
  sdk.setRequestHandler('tools/list', () => ({ tools: [{ name: 'echo', description: 'Synthetic http echo', inputSchema: { type: 'object' } }] }));
  sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: 'http-pong' }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  await sdk.connect(transport);
  const listener = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'GET', headers, ...(chunks.length ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}) });
    const response = await transport.handleRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) { res.end(); return; }
    const reader = response.body.getReader();
    res.on('close', () => { void reader.cancel().catch(() => {}); });
    while (!res.destroyed) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); }
    res.end();
  });
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('no-listener-address');
  return { url: `http://127.0.0.1:${address.port}/mcp`, async close() { await sdk.close(); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); } };
}

test('existing HTTP endpoint behavior is unchanged and still registers without a transport field', async () => {
  const registry = new McpRegistry();
  const fixture = await httpFixture();
  registry.register({ id: 'source', url: fixture.url, account: ACCOUNT, resource: RESOURCE });
  registry.enable('source'); registry.allowEgress('source');
  const adapter = adapterFor(registry);
  try {
    const discovery = await adapter.discover('source');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') return;
    registry.approve({ endpointId: 'source', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
    const result = await adapter.call(request('source'));
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed' || result.payload.state !== 'available') throw new Error('missing http payload');
    assert.equal(readPayload(adapter, request('source'), result.payload.handle, result.payload.byteLength), 'http-pong');
  } finally { await adapter.close(); await fixture.close(); }
});
