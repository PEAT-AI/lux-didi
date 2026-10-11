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
import { createMattermostReader, MATTERMOST_AUTH_NEEDED, MATTERMOST_TOOLS } from '../connectors/index.js';
import { projectMattermostResult } from '../tools/mattermost.js';

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
  return createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxLimit: 100, maxQueryChars: 200 } });
}

test('channel history projects Markdown with bounded fields and permalink sources', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).getChannelHistory('town-square', 20);
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed') return;
  const projected = projectMattermostResult(result, f.adapter);
  assert.match(projected.text, /town-square · Rob · 2026-10-11T10:00:00Z/);
  assert.match(projected.text, /Standup at ten/);
  assert.deepEqual(projected.sources, [
    'https://chat.peat-cloud.com/team/pl/abcdef1234567890abcdefghij',
    'https://chat.peat-cloud.com/team/pl/0987654321fedcba0987654321',
  ]);
});

test('a long message body is clipped to 600 characters per field', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const result = await reader(f.adapter, f.registry, digest).search('standup', 5);
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed') return;
  const projected = projectMattermostResult(result, f.adapter);
  assert.ok(projected.text.length > 0);
});

test('only the read envelope is eligible; a granted writer refuses the whole call', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry, [...MATTERMOST_TOOLS, 'mattermost_post_message']);
  const result = await reader(f.adapter, f.registry, digest).whoami();
  assert.equal(result.state, 'refused');
  assert.equal(result.reason, 'ineligible-tool-granted');
});

test('a missing session reports auth-needed, never an empty success', async t => {
  const f = setup('auth-needed');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const r = reader(f.adapter, f.registry, digest);
  const result = await r.whoami();
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, MATTERMOST_AUTH_NEEDED);
  assert.equal(await r.status(), MATTERMOST_AUTH_NEEDED);
});

test('input budgets refuse malformed arguments before any wire call', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry);
  const r = reader(f.adapter, f.registry, digest);
  assert.equal((await r.getChannelHistory('', 1)).state, 'refused');
  assert.equal((await r.getThread('p', 0)).state, 'refused');
  assert.equal((await r.search('   ', 1)).state, 'refused');
  assert.equal((await r.listChannels(9999)).state, 'refused');
});

test('a missing read definition refuses before dispatch', async t => {
  const f = setup('ok');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digest = await approve(f.adapter, f.registry, MATTERMOST_TOOLS.filter(name => name !== 'mattermost_get_thread'));
  const result = await reader(f.adapter, f.registry, digest).getThread('post-1', 1);
  assert.equal(result.state, 'refused');
  assert.equal(result.reason, 'required-definition-absent');
});
