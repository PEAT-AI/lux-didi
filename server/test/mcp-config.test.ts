import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync, linkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { CallRequest, ToolDefinition } from '../adapters/mcp/port.js';
import { Store } from '../runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';

// Dynamic module paths keep the red baseline compilable: missing behavior fails at runtime.
const configModule = '../config/mcp.js'; const hostModule = '../host/mcp.js';
const tools: ToolDefinition[] = [
  { name: 'search_knowledge', inputSchema: { type: 'object' } },
  { name: 'get_insight', inputSchema: { type: 'object' } },
];
function privateJSON(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); }
async function localSource(t: TestContext) {
  const accounts = ['alpha', 'beta'] as const;
  const tokens = new Map([['alpha-secret', 'alpha'], ['alpha-rotated-secret', 'alpha'], ['beta-secret', 'beta']]);
  const sessions = new Map<string, { sdk: Server; transport: WebStandardStreamableHTTPServerTransport }>();
  let list: ToolDefinition[] = structuredClone(tools); let repeat = false; let oversized = false; let toolHttp = 0; let executed = 0;
  let beforeList: (() => Promise<void>) | undefined;
  for (const account of accounts) {
    const sdk = new Server({ name: `synthetic-${account}`, version: '1' }, { capabilities: { tools: {} } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', async req => {
      await beforeList?.();
      if (oversized) return { tools: [{ name: 'big', inputSchema: { type: 'object' }, description: 'x'.repeat(200000) }] } as never;
      const index = req.params?.cursor === 'second' ? 1 : 0;
      return { tools: [list[index]!], ...(index === 0 || repeat ? { nextCursor: 'second' } : {}) } as never;
    });
    sdk.setRequestHandler('tools/call', req => {
      executed++;
      const args = req.params.arguments ?? {};
      const ids = args['ids'] as number[] | undefined;
      const ownId = account === 'alpha' ? 101 : 202;
      const text = req.params.name === 'search_knowledge' ? `${ownId}: nonempty ${account} synthetic search` : ids?.includes(ownId) ? `${ownId}: nonempty ${account} synthetic insight` : 'not found in selected account';
      return { content: [{ type: 'text', text }] } as never;
    });
    await sdk.connect(transport); sessions.set(account, { sdk, transport });
  }
  const http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      if (bytes.length) { const packet = JSON.parse(bytes.toString()) as { method?: string }; if (packet.method === 'tools/call') toolHttp++; }
      const account = tokens.get((headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (!account) { res.writeHead(401); res.end('synthetic remote rejection'); return; }
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'GET', headers, ...(bytes.length ? { body: new Uint8Array(bytes) } : {}) });
      const response = await sessions.get(account)!.transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) { const reader = response.body.getReader(); while (true) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); } }
      res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); const address = http.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); for (const { sdk, transport } of sessions.values()) { await transport.close(); await sdk.close(); } });
  return { url: `http://127.0.0.1:${address.port}/mcp`, tokens, get toolHttp() { return toolHttp; }, get executed() { return executed; },
    changeCatalog: (changed: boolean) => { list = structuredClone(tools); if (changed) list[0]!.description = 'changed'; },
    repeat: (value: boolean) => { repeat = value; }, oversized: (value: boolean) => { oversized = value; }, beforeList: (value: (() => Promise<void>) | undefined) => { beforeList = value; } };
}
async function configFixture(t: TestContext, url = 'https://synthetic.invalid/mcp', account = 'alpha') {
  const config = await import(configModule); const host = await import(hostModule);
  const dir = mkdtempSync(join(tmpdir(), 'didi-mcp-config-test-')); chmodSync(dir, 0o700);
  const dataDir = join(dir, 'data'); const store = new Store(dataDir, toolsMigrations); const ownerId = store.assistantId;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const p: ConnectionPolicy = { schemaVersion: 1, ownerId, connectionId: 'knowledge', generation: 1, enabled: false,
    endpoint: { id: 'endpoint', url, account, resource: 'synthetic-corpus', credentialRef: 'mcp-credential' }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(tools),
    sourcePolicy: { id: 'operator-reviewed', revision: 1, unknownClass: null, allowedClasses: ['ordinary'] }, route: { identity: 'synthetic-route', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } };
  const profile = { schemaVersion: 1, transport: 'streamable-http', dataDir, expectedPolicySha256: null, policy: p };
  const credential = { schemaVersion: 1, ownerId, connectionId: p.connectionId, endpointId: p.endpoint.id, url, account, resource: p.endpoint.resource, generation: 1, credentialRef: p.endpoint.credentialRef, token: `${account}-secret`, enabled: false };
  const profileInput = join(dir, 'profile-input.json'); const credentialInput = join(dir, 'credential-input.json'); const policyInput = join(dir, 'intent-input.json'); const configDir = join(dir, 'config');
  privateJSON(profileInput, profile); privateJSON(credentialInput, credential);
  assert.equal(config.initMcpConfiguration({ configDir, ownerId, profileInput, credentialInput }).state, 'pending');
  const approve = (generation = 1, expectedPolicySha256: string | null = null) => {
    p.enabled = true; p.generation = generation; privateJSON(policyInput, { ...profile, expectedPolicySha256, policy: p });
    return config.approveMcpConfiguration({ configDir, ownerId, dataDir, policyInput });
  };
  const registry = new McpRegistry(); const initial = config.loadMcpConfiguration({ configDir, ownerId, dataDir }); registry.register(initial.endpoint);
  let selection = initial;
  const port = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: async (ref: string) => selection.resolveCredential(ref), assertCredentialCurrent: (ref: string) => selection.assertCredentialCurrent(ref), budgets: { timeoutMs: 1500 } } as Parameters<typeof createMcpAdapter>[0]);
  const owner = createToolsOwner({ store, ownerId, registry, port, lookupAuthority: async () => null });
  t.after(async () => { await port.close(); });
  const compose = () => { selection = config.loadMcpConfiguration({ configDir, ownerId, dataDir }); return host.composeMcpConnection({ store, owner, registry, configDir }); };
  return { config, host, dir, dataDir, store, ownerId, configDir, p, profile, credential, policyInput, profileInput, credentialInput, registry, owner, port, approve, compose, get selection() { return selection; } };
}
function request(p: ConnectionPolicy, toolName: string, args: Record<string, unknown>): CallRequest { return { endpointId: p.endpoint.id, account: p.endpoint.account, resource: p.endpoint.resource, generation: p.generation, toolName, arguments: args }; }

test('protected init is disabled/pending; strict binding and canonical owner composition reject alternate Store/registry/owner', async t => {
  const f = await configFixture(t);
  assert.equal(f.store.transaction(tx => tx.get('SELECT count(*) AS n FROM tool_connections'))?.n, 0);
  assert.equal(f.selection.intent.policy.enabled, false);
  assert.throws(() => f.config.loadMcpConfiguration({ configDir: f.configDir, ownerId: 'wrong', dataDir: f.dataDir }));
  assert.throws(() => f.config.loadMcpConfiguration({ configDir: f.configDir, ownerId: f.ownerId, dataDir: join(f.dir, 'wrong') }));
  assert.throws(() => f.host.composeMcpConnection({ store: f.store, owner: f.owner, registry: new McpRegistry(), configDir: f.configDir }));
  assert.equal(f.approve().state, 'pending');
  const bundle = f.compose(); assert.equal(bundle.state, 'applied'); assert.equal(f.registry.currentGrant('endpoint'), undefined);
  assert.equal(f.compose().state, 'unchanged');
});

test('official authenticated SDK full paged rediscovery restores exact consent; alpha/beta nonempty reads, rotation, revoke and restart', async t => {
  const source = await localSource(t); const a = await configFixture(t, source.url); const b = await configFixture(t, source.url, 'beta');
  for (const f of [a, b]) {
    f.approve(); const bundle = f.compose(); assert.deepEqual(await bundle.restore(), { state: 'restored' });
    const search = await f.port.call(request(f.p, 'search_knowledge', { query: 'synthetic', limit: 1, include_sensitive: false }));
    assert.equal(search.state, 'completed'); if (search.state !== 'completed') return;
    assert.match(search.projection.text, new RegExp(`nonempty ${f.p.endpoint.account}`));
    assert.equal(search.coverage.completeCorpus, false);
    const get = await f.port.call(request(f.p, 'get_insight', { ids: [f === a ? 101 : 202], include_links: false }));
    assert.equal(get.state, 'completed'); if (get.state !== 'completed') return;
    assert.match(get.projection.text, new RegExp(`nonempty ${f.p.endpoint.account} synthetic insight`));
    const other = await f.port.call(request(f.p, 'get_insight', { ids: [f === a ? 202 : 101], include_links: false }));
    assert.equal(other.state, 'completed'); if (other.state !== 'completed') return;
    assert.match(other.projection.text, /not found/); assert.doesNotMatch(other.projection.text, /nonempty/);
  }
  const bundle = a.compose(); const originalHash = sha256(canonicalJSON(a.p));
  privateJSON(join(a.configDir, 'credential.json'), { ...a.credential, enabled: true, token: 'alpha-rotated-secret' });
  assert.equal((await a.port.call(request(a.p, 'search_knowledge', { query: 'synthetic', limit: 1 }))).state, 'completed');
  assert.equal(a.registry.currentGrant('endpoint')?.generation, 1);
  assert.equal(a.store.transaction(tx => tx.get('SELECT policy_sha256 FROM tool_connections'))?.policy_sha256, originalHash);
  source.changeCatalog(true); assert.equal((await bundle.restore()).state, 'refused'); assert.equal(a.registry.currentGrant('endpoint'), undefined);
  source.changeCatalog(false); assert.deepEqual(await bundle.restore(), { state: 'restored' });
  a.registry.suspend('endpoint'); assert.deepEqual(await bundle.restore(), { state: 'restored' });
  // A genuinely fresh registry/adapter and reopened Store retain exactly the original generation.
  await a.port.close(); a.store.close(); const reopened = new Store(a.dataDir, toolsMigrations);
  const registry = new McpRegistry(); const selected = a.config.loadMcpConfiguration({ configDir: a.configDir, ownerId: a.ownerId, dataDir: a.dataDir }); registry.register(selected.endpoint);
  const port = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: selected.resolveCredential, assertCredentialCurrent: selected.assertCredentialCurrent } as Parameters<typeof createMcpAdapter>[0]);
  const owner = createToolsOwner({ store: reopened, ownerId: a.ownerId, registry, port, lookupAuthority: async () => null });
  t.after(async () => { await port.close(); reopened.close(); });
  const restored = a.host.composeMcpConnection({ store: reopened, owner, registry, configDir: a.configDir }); assert.equal(restored.state, 'unchanged');
  assert.deepEqual(await restored.restore(), { state: 'restored' }); assert.equal(registry.currentGrant('endpoint')?.generation, 1);
  assert.equal(a.config.disableMcpConfiguration({ configDir: a.configDir, ownerId: a.ownerId, dataDir: a.dataDir }).state, 'pending');
  const before = source.toolHttp;
  assert.equal((await port.call(request(a.p, 'search_knowledge', { query: 'synthetic', limit: 1 }))).state, 'refused'); assert.equal(source.toolHttp, before);
  assert.equal((await restored.restore()).state, 'refused');
  assert.equal(a.host.composeMcpConnection({ store: reopened, owner, registry, configDir: a.configDir }).state, 'pending');
  assert.equal(reopened.transaction(tx => tx.get('SELECT enabled FROM tool_connections'))?.enabled, 1); // CLI has not invented a durable revocation.
  const disabled = { ...a.p, generation: 2, enabled: false }; privateJSON(a.policyInput, { ...a.profile, expectedPolicySha256: originalHash, policy: disabled });
  // Disabled durable intent is operator-supplied through approve; no automatic generation is fabricated.
  a.config.approveMcpConfiguration({ configDir: a.configDir, ownerId: a.ownerId, dataDir: a.dataDir, policyInput: a.policyInput });
  assert.equal(a.host.composeMcpConnection({ store: reopened, owner, registry, configDir: a.configDir }).state, 'applied');
  assert.equal(reopened.transaction(tx => tx.get('SELECT enabled FROM tool_connections'))?.enabled, 0);
  a.approve(3, originalHash); assert.equal(a.host.composeMcpConnection({ store: reopened, owner, registry, configDir: a.configDir }).state, 'refused');
  assert.equal(reopened.transaction(tx => tx.get('SELECT enabled FROM tool_connections'))?.enabled, 0);
});

test('CURRENT protected rebind and credential-await local revoke send zero HTTP; remote auth rejection executes zero tools', async t => {
  const source = await localSource(t); const f = await configFixture(t, source.url); f.approve(); const bundle = f.compose(); await bundle.restore();
  const original = readFileSync(join(f.configDir, 'credential.json'), 'utf8');
  privateJSON(join(f.configDir, 'credential.json'), { ...JSON.parse(original), account: 'beta', token: 'beta-secret' });
  const before = source.toolHttp; assert.equal((await f.port.call(request(f.p, 'search_knowledge', { query: 'synthetic', limit: 1 }))).state, 'refused'); assert.equal(source.toolHttp, before);
  writeFileSync(join(f.configDir, 'credential.json'), original);
  await bundle.restore();
  source.tokens.delete('alpha-secret');
  const executed = source.executed; const rejected = await f.port.call(request(f.p, 'search_knowledge', { query: 'synthetic', limit: 1 }));
  assert.notEqual(rejected.state, 'completed'); assert.equal(source.executed, executed); assert.ok(source.toolHttp > before);
});

test('catalog is explicitly egress-approved, bounded complete discovery with digest-bound local pages; repeated/oversize source denied', async t => {
  const source = await localSource(t); const f = await configFixture(t, source.url);
  const options = { configDir: f.configDir, ownerId: f.ownerId, allowEgress: true, limit: 1 };
  await assert.rejects(f.config.catalogMcpConfiguration({ ...options, allowEgress: false }));
  const first = await f.config.catalogMcpConfiguration(options); assert.equal(first.total, 2); assert.equal(first.toolNames.length, 1); assert.ok(first.cursor);
  const second = await f.config.catalogMcpConfiguration({ ...options, cursor: first.cursor }); assert.equal(second.toolNames.length, 1); assert.equal(second.cursor, null); assert.notDeepEqual(first.toolNames, second.toolNames);
  await assert.rejects(f.config.catalogMcpConfiguration({ ...options, cursor: 'invalid' }));
  source.changeCatalog(true); await assert.rejects(f.config.catalogMcpConfiguration({ ...options, cursor: first.cursor })); source.changeCatalog(false);
  source.repeat(true); await assert.rejects(f.config.catalogMcpConfiguration(options)); source.repeat(false);
  source.oversized(true); await assert.rejects(f.config.catalogMcpConfiguration(options));
  assert.equal(source.toolHttp, 0); assert.equal(f.store.transaction(tx => tx.get('SELECT count(*) AS n FROM tool_connections'))?.n, 0);
});

test('strict protected JSON/modes/links/references/fields and bounded redacted secret sinks', async t => {
  const f = await configFixture(t); const path = join(f.configDir, 'credential.json'); const original = readFileSync(path, 'utf8');
  const load = () => f.config.loadMcpConfiguration({ configDir: f.configDir, ownerId: f.ownerId, dataDir: f.dataDir });
  for (const bad of [ original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), JSON.stringify({ ...JSON.parse(original), token: 'bad\r\ntoken' }), JSON.stringify({ ...JSON.parse(original), credentialRef: '../secret' }), JSON.stringify({ ...JSON.parse(original), unknown: 'alpha-secret' }), 'x'.repeat(70000) ]) {
    writeFileSync(path, bad); assert.throws(load, error => { assert.doesNotMatch(String(error), /alpha-secret|synthetic.invalid|mcp-credential/); return true; });
  }
  writeFileSync(path, original); chmodSync(path, 0o644); assert.throws(load); chmodSync(path, 0o600);
  const hardlink = join(f.dir, 'hardlink'); linkSync(path, hardlink); assert.throws(load); rmSync(hardlink);
  rmSync(path); symlinkSync(f.credentialInput, path); assert.throws(load); rmSync(path); writeFileSync(path, original, { mode: 0o600 });
  assert.throws(() => f.config.initMcpConfiguration({ configDir: f.configDir, ownerId: f.ownerId, profileInput: f.profileInput, credentialInput: f.credentialInput }));
  assert.equal(readdirSync(f.configDir).sort().join(','), 'credential.json,profile.json');
  const profileBytes = readFileSync(join(f.configDir, 'profile.json'), 'utf8'); assert.doesNotMatch(profileBytes, /alpha-secret|"token"/);
  assert.equal(existsSync(join(f.configDir, 'writer.sqlite')), false);
  f.approve(); f.compose();
  const policies = f.store.transaction(tx => tx.all('SELECT policy_json FROM tool_connections')); assert.doesNotMatch(JSON.stringify(policies), /alpha-secret|alpha-rotated-secret/);
});

test('actual CLI help/strict flags/init/approve/disable are pending and never open a Store or print secrets', async t => {
  const f = await configFixture(t); const cli = join(dirname(fileURLToPath(import.meta.url)), '../config/mcp-cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'], CI: '1' }, timeout: 5000 });
  const help = run(['--help']); assert.equal(help.status, 0); for (const flag of ['--config-dir', '--owner-id', '--profile-input', '--credential-input', '--allow-egress', '--limit', '--cursor', '--data-dir', '--policy-input']) assert.ok(help.stdout.includes(flag));
  for (const args of [ ['catalog'], ['catalog', '--config-dir', f.configDir, '--config-dir', f.configDir], ['disable', '--token', 'alpha-secret'], ['catalog', '--limit', '0'], ['init', '--unknown'] ]) {
    const result = run(args); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /alpha-secret|synthetic.invalid|mcp-credential/);
  }
  const configDir = join(f.dir, 'cli-config');
  assert.equal(run(['init', '--config-dir', configDir, '--owner-id', f.ownerId, '--profile-input', f.profileInput, '--credential-input', f.credentialInput]).status, 0);
  f.p.enabled = true; privateJSON(f.policyInput, { ...f.profile, policy: f.p });
  const approved = run(['approve', '--config-dir', configDir, '--data-dir', f.dataDir, '--owner-id', f.ownerId, '--policy-input', f.policyInput]); assert.equal(approved.status, 0); assert.match(approved.stdout, /pending host application/);
  const disabled = run(['disable', '--config-dir', configDir, '--data-dir', f.dataDir, '--owner-id', f.ownerId]); assert.equal(disabled.status, 0); assert.match(disabled.stdout, /durable revocation pending/);
  assert.equal(existsSync(join(configDir, 'writer.sqlite')), false);
  assert.equal(f.store.transaction(tx => tx.get('SELECT count(*) AS n FROM tool_connections'))?.n, 0);
  assert.doesNotMatch(approved.stdout + disabled.stdout + approved.stderr + disabled.stderr, /alpha-secret|synthetic.invalid|mcp-credential/);
});
