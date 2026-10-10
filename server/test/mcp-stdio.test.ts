import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { isStdioEndpoint } from '../adapters/mcp/port.js';
import type { CallRequest, EndpointConfig, McpPort } from '../adapters/mcp/port.js';

// Synthetic local stdio/HTTP bindings only: no real account, network or credential.
// The binding is cast because the discriminated endpoint binding is the change under test.
const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'stdio-mcp-child.mjs');
const ACCOUNT = 'local'; const RESOURCE = 'stdio-fixture';

function config(id: string, mode: string, pidFile: string, payload = 'stdio-pong', over: Record<string, unknown> = {}): EndpointConfig {
  return { id, transport: 'stdio', command: process.execPath, args: [child, mode, pidFile, payload], env: { HOME: join(tmpdir(), 'didi-stdio-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: ACCOUNT, resource: RESOURCE, ...over } as unknown as EndpointConfig;
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
  const parsed = JSON.parse(Buffer.from(bytes).toString()) as { result?: { content: { text: string }[] }; content?: { text: string }[] };
  const content = parsed.result?.content ?? parsed.content;
  return content?.[0]?.text ?? '';
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
    assert.equal(result.state, 'completed', JSON.stringify(result));
    if (result.state !== 'completed' || result.payload.state !== 'available') throw new Error('missing stdio payload');
    assert.equal(readPayload(adapter, request('local-stdio'), result.payload.handle, result.payload.byteLength), 'stdio-pong');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 0);
    const closed = await Promise.race([adapter.close().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 6000))]);
    assert.equal(closed, true, 'adapter.close() must settle within bounds');
    assert.equal(await waitDead(pid, 4000), true, 'child must be gone after disposal');
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
    assert.equal(await waitDead(pid, 4000), true, 'child must be gone after cancellation');
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
    for (const pid of pids) assert.equal(await waitDead(pid, 4000), true, 'every child must be gone after parent shutdown');
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

test('changed command, ordered args, routing env, account or resource lose the approved binding (full identity, never URL equality)', () => {
  const registry = new McpRegistry();
  const base = config('local-stdio', 'ok', '/tmp/unused.pid');
  registry.register(base);
  assert.equal(registry.matchesEndpoint(base), true);
  const variant = (over: Record<string, unknown>): EndpointConfig => config('local-stdio', 'ok', '/tmp/unused.pid', 'stdio-pong', over);
  // Neither side has a URL: an absent URL must never read as a match.
  assert.equal(registry.matchesEndpoint(variant({ command: process.execPath })), true);
  assert.equal(registry.matchesEndpoint(variant({ command: '/bin/sh' })), false);
  assert.equal(registry.matchesEndpoint(variant({ args: [child, 'ok', '/tmp/unused.pid', 'stdio-pong', 'EXTRA'] })), false);
  assert.equal(registry.matchesEndpoint(variant({ args: [child, 'ok', '/tmp/unused.pid', 'other-payload'] })), false);
  assert.equal(registry.matchesEndpoint(variant({ env: { HOME: '/tmp/other-root' } })), false);
  assert.equal(registry.matchesEndpoint(variant({ account: 'other' })), false);
  assert.equal(registry.matchesEndpoint(variant({ resource: 'other' })), false);
  // A plain HTTP-shaped config (absent transport) never matches a stdio binding.
  assert.equal(registry.matchesEndpoint({ id: 'local-stdio', url: 'https://example.invalid/mcp', account: ACCOUNT, resource: RESOURCE }), false);
});

test('cross-arm fields, unknown transport and a non-null stdio credentialRef are refused at registration', () => {
  const registry = new McpRegistry();
  // A valid stdio binding registers (red on base, which rejects the transport key).
  assert.doesNotThrow(() => registry.register(config('stdio-valid', 'ok', '/tmp/unused.pid')));
  assert.throws(() => registry.register({ id: 's1', transport: 'stdio', command: process.execPath, args: [], account: ACCOUNT, resource: RESOURCE, url: 'https://example.invalid/mcp' } as unknown as EndpointConfig));
  assert.throws(() => registry.register({ id: 's2', url: 'https://example.invalid/mcp', command: process.execPath, args: [], account: ACCOUNT, resource: RESOURCE } as unknown as EndpointConfig));
  assert.throws(() => registry.register({ id: 's3', transport: 'sse', url: 'https://example.invalid/mcp', account: ACCOUNT, resource: RESOURCE } as unknown as EndpointConfig));
  assert.throws(() => registry.register({ id: 's4', transport: 'stdio', command: process.execPath, args: [], account: ACCOUNT, resource: RESOURCE, credentialRef: 'token-ref' } as unknown as EndpointConfig));
  assert.throws(() => registry.register({ id: 's5', transport: 'stdio', command: 'node', args: [], account: ACCOUNT, resource: RESOURCE } as unknown as EndpointConfig));
});

test('explicit routing env merges with SDK defaults and the whole parent environment is not inherited', async () => {
  const marker = 'DIDI-PARENT-SECRET-XYZZY';
  const { dir, pidFile } = scratch();
  const home = join(dir, 'child-home');
  const approvedPath = '/synthetic/approved/bin';
  process.env.DIDI_PARENT_SECRET = marker;
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ok', pidFile, 'stdio-pong', { env: { HOME: home, PATH: approvedPath, LOGNAME: '', SHELL: '', TERM: '', USER: '' } }));
  registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter = adapterFor(registry);
  try {
    assert.equal((await adapter.discover('local-stdio')).state, 'discovered');
    const childEnv = JSON.parse(readFileSync(`${pidFile}.env`, 'utf8')) as Record<string, string | undefined>;
    // The effective routing values are the approved ones, not the parent's (PATH is missing under the SDK default merge only when unbound).
    assert.equal(childEnv['HOME'], home);
    assert.equal(childEnv['PATH'], approvedPath);
    // Non-routing defaults are neutralized by an explicit empty string in the approved identity.
    assert.equal(childEnv['SHELL'], '');
    assert.equal(childEnv['TERM'], '');
    assert.equal(Object.prototype.hasOwnProperty.call(childEnv, 'DIDI_PARENT_SECRET'), false);
  } finally { delete process.env.DIDI_PARENT_SECRET; await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an absolute args path containing a space is accepted and used', async () => {
  const { dir, pidFile } = scratch();
  const spacedDir = join(here, 'fixtures', 'space dir');
  mkdirSync(spacedDir, { recursive: true });
  const spaced = join(spacedDir, 'child.mjs');
  copyFileSync(child, spaced);
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ok', pidFile, 'stdio-pong', { args: [spaced, 'ok', pidFile, 'stdio-pong'] }));
  registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter = adapterFor(registry);
  try { assert.equal((await adapter.discover('local-stdio')).state, 'discovered'); }
  finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
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

test('secret-marker env and locator paths never leak into refusals, discovery or completed results', async () => {
  const marker = 'DIDI-SECRET-MARKER-XYZZY';
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  const crashBinding = config('local-stdio', 'crash', pidFile, 'stdio-pong', { env: { HOME: join(dir, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '', DIDI_MARKER: marker } });
  let registered = false;
  try { registry.register(crashBinding); registered = true; }
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
    // Public sink for a completed result: source/projection must carry no locator or secret marker.
    const okRegistry = new McpRegistry();
    okRegistry.register(config('local-stdio', 'ok', pidFile, 'stdio-pong', { env: { HOME: join(dir, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '', DIDI_MARKER: marker } }));
    okRegistry.enable('local-stdio'); okRegistry.allowEgress('local-stdio');
    const okAdapter = adapterFor(okRegistry);
    try {
      const discovery = await okAdapter.discover('local-stdio');
      assert.equal(discovery.state, 'discovered');
      if (discovery.state !== 'discovered') return;
      okRegistry.approve({ endpointId: 'local-stdio', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
      const result = await okAdapter.call(request('local-stdio'));
      assert.equal(result.state, 'completed');
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(marker), false);
      assert.equal(serialized.includes(child), false);
      assert.equal(serialized.includes(process.execPath), false);
    } finally { await okAdapter.close(); }
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

test('protected stdio configuration carries the binding through init/approve/load/compose and refuses a rebinding without spawning', async () => {
  const config = await import('../config/mcp.js'); const host = await import('../host/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'didi-stdio-config-'));
  const configDir = join(dir, 'config'); const dataDir = join(dir, 'data');
  const store = new Store(dataDir, toolsMigrations); const ownerId = store.assistantId;
  const { dir: childDir, pidFile } = scratch();
  const baseArgs = [child, 'ok', pidFile, 'stdio-pong'];
  const policyFor = (args: readonly string[], generation: number, enabled: boolean) => ({
    schemaVersion: 1 as const, ownerId, connectionId: 'local', generation, enabled,
    endpoint: { id: 'local-endpoint', transport: 'stdio' as const, command: process.execPath, args, env: { HOME: join(dir, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: ACCOUNT, resource: RESOURCE, credentialRef: null },
    toolNames: ['search_knowledge'] as const, schemaDigest: '0'.repeat(64),
    sourcePolicy: { id: 'operator-reviewed', revision: 1, unknownClass: null, allowedClasses: ['ordinary'] as const },
    route: { identity: 'synthetic-route', allowedClasses: ['ordinary'] as const },
    bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
  });
  const credentialFor = (generation: number, enabled: boolean) => ({ schemaVersion: 1, ownerId, connectionId: 'local', endpointId: 'local-endpoint', transport: 'stdio', command: process.execPath, args: baseArgs, env: { HOME: join(dir, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: ACCOUNT, resource: RESOURCE, generation, enabled });
  const profileInput = join(dir, 'profile.json'); const credentialInput = join(dir, 'credential.json');
  writeFileSync(credentialInput, JSON.stringify(credentialFor(1, false)), { mode: 0o600 }); chmodSync(credentialInput, 0o600);
  writeFileSync(profileInput, JSON.stringify({ schemaVersion: 1, transport: 'stdio', dataDir, expectedPolicySha256: null, policy: policyFor(baseArgs, 1, false) }), { mode: 0o600 }); chmodSync(profileInput, 0o600);
  try {
    assert.equal(config.initMcpConfiguration({ configDir, ownerId, profileInput, credentialInput }).state, 'pending');
    writeFileSync(credentialInput, JSON.stringify(credentialFor(2, true)), { mode: 0o600 }); chmodSync(credentialInput, 0o600);
    writeFileSync(profileInput, JSON.stringify({ schemaVersion: 1, transport: 'stdio', dataDir, expectedPolicySha256: null, policy: policyFor(baseArgs, 2, true) }), { mode: 0o600 }); chmodSync(profileInput, 0o600);
    assert.equal(config.approveMcpConfiguration({ configDir, ownerId, dataDir, policyInput: profileInput }).state, 'pending');
    const selection = config.loadMcpConfiguration({ configDir, ownerId, dataDir });
    assert.equal(isStdioEndpoint(selection.endpoint), true, 'protected configuration must carry the stdio binding');
    if (!isStdioEndpoint(selection.endpoint)) return;
    assert.equal(selection.endpoint.command, process.execPath);
    assert.deepEqual([...selection.endpoint.args], baseArgs);
    const registry = new McpRegistry(); registry.register(selection.endpoint); registry.enable('local-endpoint'); registry.allowEgress('local-endpoint');
    const port = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 3000 } });
    const owner = createToolsOwner({ store, ownerId, registry, port, lookupAuthority: async () => null });
    assert.equal(host.composeMcpConnection({ store, owner, registry, configDir }).state, 'applied');
    // A changed executable binding is a different identity: the approved binding must not be reusable and nothing spawns.
    const changed = config.loadMcpConfiguration({ configDir, ownerId, dataDir });
    if (!isStdioEndpoint(changed.endpoint)) throw new Error('expected stdio binding');
    const altered = { ...changed.endpoint, args: [...changed.endpoint.args, 'EXTRA'] };
    const rebindRegistry = new McpRegistry(); rebindRegistry.register(altered);
    assert.equal(rebindRegistry.matchesEndpoint(changed.endpoint), false);
    assert.equal(existsSync(pidFile), false, 'no child may spawn for a changed binding');
    await port.close(); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(childDir, { recursive: true, force: true }); }
});

test('a stdio binding missing an inherited SDK env key, or HOME/PATH, is refused at registration', { skip: process.platform === 'win32' }, () => {
  const registry = new McpRegistry();
  // Every SDK platform-inherited key must be approval-bound; HOME/PATH stay non-empty.
  const full = { HOME: '/tmp/didi-home', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' };
  const make = (id: string, env: Record<string, string>): EndpointConfig => ({ id, transport: 'stdio', command: process.execPath, args: [], env, account: ACCOUNT, resource: RESOURCE }) as unknown as EndpointConfig;
  assert.doesNotThrow(() => registry.register(make('env-ok', full)));
  assert.throws(() => registry.register(make('env-missing-user', { HOME: '/tmp/didi-home', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '' })));
  assert.throws(() => registry.register(make('env-missing-path', { HOME: '/tmp/didi-home', LOGNAME: '', SHELL: '', TERM: '', USER: '' })));
  assert.throws(() => registry.register(make('env-empty-home', { ...full, HOME: '' })));
  assert.throws(() => registry.register(make('env-empty-path', { ...full, PATH: '' })));
});
