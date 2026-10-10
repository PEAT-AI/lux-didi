import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { CallRequest, EndpointConfig } from '../adapters/mcp/port.js';

// Synthetic local stdio binding only: no real account, network or credential.
// The binding is cast because the discriminated endpoint binding is the change under test.
const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'stdio-mcp-child.mjs');
function binding(mode: string, pidFile: string): EndpointConfig {
  return { id: 'local-stdio', transport: 'stdio', command: process.execPath, args: [child, mode, pidFile], account: 'local', resource: 'stdio-fixture' } as unknown as EndpointConfig;
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test('stdio binding registers, discovers and calls a real child server, then cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-stdio-'));
  const pidFile = join(dir, 'child.pid');
  const registry = new McpRegistry();
  registry.register(binding('ok', pidFile));
  registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 4000 } });
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') return;
    assert.deepEqual(discovery.tools.map(tool => tool.name), ['echo']);
    registry.approve({ endpointId: 'local-stdio', schemaDigest: discovery.schemaDigest, toolNames: ['echo'], effect: 'read', account: 'local', resource: 'stdio-fixture', generation: 1 });
    const request: CallRequest = { endpointId: 'local-stdio', toolName: 'echo', arguments: {}, generation: 1, account: 'local', resource: 'stdio-fixture' };
    const result = await adapter.call(request);
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed' || result.payload.state !== 'available') throw new Error('missing stdio payload');
    assert(result.payload.byteLength > 0);
    const slice = adapter.readSlice({ ...request, handle: result.payload.handle, offset: 0, length: result.payload.byteLength });
    assert.equal(slice.state, 'available');
    const bytes = slice.state === 'available' ? slice.bytes : new Uint8Array();
    const envelope = JSON.parse(Buffer.from(bytes).toString()) as { result: { content: { text: string }[] } };
    assert.equal(envelope.result.content[0]?.text, 'stdio-pong');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 0);
    await adapter.close();
    assert.equal(pidAlive(pid), false);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unapproved stdio binding spawns no child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-stdio-'));
  const pidFile = join(dir, 'child.pid');
  const registry = new McpRegistry();
  registry.register(binding('ok', pidFile));
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 1000 } });
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.notEqual(discovery.state, 'discovered');
    assert.equal(existsSync(pidFile), false);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('malformed stdout fails explicitly instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-stdio-'));
  const registry = new McpRegistry();
  registry.register(binding('malformed', join(dir, 'child.pid')));
  registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 2000 } });
  try {
    const discovery = await adapter.discover('local-stdio');
    assert.equal(discovery.state, 'unavailable');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('non-absolute command is refused at registration (no PATH substitution)', () => {
  const registry = new McpRegistry();
  assert.throws(() => registry.register({ id: 'local-stdio', transport: 'stdio', command: 'node', args: [], account: 'local', resource: 'r' } as unknown as EndpointConfig));
});

test('existing HTTP endpoint config still registers unchanged', () => {
  const registry = new McpRegistry();
  registry.register({ id: 'source', url: 'https://example.invalid/mcp', account: 'a', resource: 'r' });
  assert.equal(registry.matchesEndpoint({ id: 'source', url: 'https://example.invalid/mcp', account: 'a', resource: 'r' }), true);
});
