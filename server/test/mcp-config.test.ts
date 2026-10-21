import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, lstatSync, symlinkSync, linkSync, readdirSync, existsSync } from 'node:fs';
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
  const tokens = new Map([['alpha-secret', 'alpha'], ['alpha-rotated-secret', 'alpha'], ['beta-secret', 'beta']]);
  const sessions = new Map<string, { account: string; sdk: Server; transport: WebStandardStreamableHTTPServerTransport }>();
  let list: ToolDefinition[] = structuredClone(tools); let repeat = false; let oversized = false; let toolHttp = 0; let executed = 0;
  let beforeList: (() => Promise<void>) | undefined;
  let callDelayMs = 0;
  async function newSession(account: string) {
    const id = randomUUID();
    const sdk = new Server({ name: `synthetic-${account}`, version: '1' }, { capabilities: { tools: {} } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', async req => {
      await beforeList?.();
      if (oversized) return { tools: [{ name: 'big', inputSchema: { type: 'object' }, description: 'x'.repeat(2 * 1024 * 1024) }] } as never;
      const index = req.params?.cursor === 'second' ? 1 : 0;
      return { tools: [list[index]!], ...(index === 0 || repeat ? { nextCursor: 'second' } : {}) } as never;
    });
    sdk.setRequestHandler('tools/call', async req => {
      executed++;
      if (callDelayMs) await new Promise(resolve => setTimeout(resolve, callDelayMs));
      const args = req.params.arguments ?? {};
      const ids = args['ids'] as number[] | undefined;
      const ownId = account === 'alpha' ? 101 : 202;
      // A Google endpoint proves its account before any read (server/connectors/identity.ts, strict):
      // the fake helper answers its own identity tool with the account it pins, like the real one.
      const text = req.params.name === 'gmail_get_profile' ? JSON.stringify({ emailAddress: account })
        : req.params.name === 'calendar_list_calendars' ? JSON.stringify({ calendars: [{ id: account, primary: true }] })
        : req.params.name === 'gmail_search_messages' ? JSON.stringify({ data: { messages: [{ id: 'synthetic-message' }] } })
        : req.params.name === 'search_knowledge' ? `${ownId}: nonempty ${account} synthetic search` : ids?.includes(ownId) ? `${ownId}: nonempty ${account} synthetic insight` : 'not found in selected account';
      return { content: [{ type: 'text', text }] } as never;
    });
    await sdk.connect(transport); const session = { account, sdk, transport }; sessions.set(id, session); return session;
  }
  const http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      if (bytes.length) { const packet = JSON.parse(bytes.toString()) as { method?: string }; if (packet.method === 'tools/call') toolHttp++; }
      const account = tokens.get((headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (!account) { res.writeHead(401); res.end('synthetic remote rejection'); return; }
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      const sessionId = headers.get('mcp-session-id');
      const session = sessionId ? sessions.get(sessionId) : await newSession(account);
      if (!session || session.account !== account) { res.writeHead(401); res.end(); return; }
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'GET', headers, ...(bytes.length ? { body: new Uint8Array(bytes) } : {}) });
      const response = await session.transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) { const reader = response.body.getReader(); while (true) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); } }
      res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); const address = http.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); for (const { sdk, transport } of sessions.values()) { await transport.close(); await sdk.close(); } });
  return { url: `http://127.0.0.1:${address.port}/mcp`, tokens, get toolHttp() { return toolHttp; }, get executed() { return executed; },
    changeCatalog: (changed: boolean) => { list = structuredClone(tools); if (changed) list[0]!.description = 'changed'; },
    catalogNames: (names: string[]) => { list = structuredClone(tools); names.forEach((name, index) => { list[index]!.name = name; }); },
    repeat: (value: boolean) => { repeat = value; }, oversized: (value: boolean) => { oversized = value; }, beforeList: (value: (() => Promise<void>) | undefined) => { beforeList = value; },
    callDelay: (value: number) => { callDelayMs = value; } };
}
async function configFixture(t: TestContext, url = 'https://synthetic.invalid/mcp', account = 'alpha') {
  const config = await import(configModule); const host = await import(hostModule);
  const dir = mkdtempSync(join(tmpdir(), 'didi-mcp-config-test-')); chmodSync(dir, 0o700);
  const dataDir = join(dir, 'data'); const store = new Store(dataDir, toolsMigrations); const ownerId = store.assistantId;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const p: ConnectionPolicy = { schemaVersion: 1, bindingMode: 'connection', ownerId, connectionId: 'knowledge', generation: 1, enabled: false, connector: 'lux-knowledge',
    endpoint: { id: 'endpoint', url, account, resource: 'synthetic-corpus', credentialRef: 'mcp-credential' }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(tools),
    sourcePolicy: { id: 'operator-reviewed', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'synthetic-route', allowedClasses: ['ordinary'] },
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
  const alternate = new Store(join(f.dir, 'other'), toolsMigrations);
  const alternateRegistry = new McpRegistry(); alternateRegistry.register(f.selection.endpoint);
  const alternateOwner = createToolsOwner({ store: alternate, ownerId: alternate.assistantId, registry: alternateRegistry, port: f.port, lookupAuthority: async () => null });
  // Distinct cases: wrong Store with original owner; wrong owner with original Store/registry.
  assert.throws(() => f.host.composeMcpConnection({ store: alternate, owner: f.owner, registry: f.registry, configDir: f.configDir }), /binding/);
  assert.throws(() => f.host.composeMcpConnection({ store: f.store, owner: alternateOwner, registry: f.registry, configDir: f.configDir }), /binding/);
  assert.equal(f.store.transaction(tx => tx.get('SELECT count(*) AS n FROM tool_connections'))?.n, 0);
  assert.equal(alternate.transaction(tx => tx.get('SELECT count(*) AS n FROM tool_connections'))?.n, 0);
  assert.throws(() => f.registry.endpoint('endpoint'), /egress/);
  assert.throws(() => alternateRegistry.endpoint('endpoint'), /egress/);
  alternate.close();
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
  let enter!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const resolveCredential = f.selection.resolveCredential;
  t.mock.method(f.selection, 'resolveCredential', async (reference: string) => { const token = await resolveCredential(reference); enter(); await gate; return token; });
  const localBefore = source.toolHttp; const localPending = f.port.call(request(f.p, 'search_knowledge', { query: 'synthetic', limit: 1 }));
  await started; f.config.disableMcpConfiguration({ configDir: f.configDir, ownerId: f.ownerId, dataDir: f.dataDir }); release();
  assert.equal((await localPending).state, 'refused'); assert.equal(source.toolHttp, localBefore);
  t.mock.restoreAll(); writeFileSync(join(f.configDir, 'credential.json'), original); await bundle.restore();
  source.tokens.delete('alpha-secret');
  const executed = source.executed; const rejected = await f.port.call(request(f.p, 'search_knowledge', { query: 'synthetic', limit: 1 }));
  assert.notEqual(rejected.state, 'completed'); assert.equal(source.executed, executed); assert.ok(source.toolHttp > before);
});

test('catalog is explicitly egress-approved, bounded complete discovery with digest-bound local pages; repeated/oversize source denied', async t => {
  const source = await localSource(t); const f = await configFixture(t, source.url);
  const options = { configDir: f.configDir, ownerId: f.ownerId, allowEgress: true, unknownClass: 'ordinary', limit: 1 };
  await assert.rejects(f.config.catalogMcpConfiguration({ ...options, allowEgress: false, unknownClass: 'ordinary' }));
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
  const profilePath = join(f.configDir, 'profile.json'); const profileObject = JSON.parse(profileBytes);
  for (const value of [ { ...profileObject, token: 'alpha-secret' }, { ...profileObject, dataDir: 'relative' },
    { ...profileObject, policy: { ...profileObject.policy, unexpected: true } },
    { ...profileObject, policy: { ...profileObject.policy, endpoint: { ...profileObject.policy.endpoint, credentialRef: null } } },
    { ...profileObject, policy: { ...profileObject.policy, endpoint: { ...profileObject.policy.endpoint, url: 'https://synthetic.invalid/mcp#secret' } } } ]) {
    privateJSON(profilePath, value); assert.throws(load);
  }
  writeFileSync(profilePath, profileBytes); chmodSync(f.configDir, 0o755); assert.throws(load); chmodSync(f.configDir, 0o700);
  const alias = join(f.dir, 'config-alias'); symlinkSync(f.configDir, alias); assert.throws(() => f.config.loadMcpConfiguration({ configDir: alias, ownerId: f.ownerId, dataDir: f.dataDir }));
  for (const file of [path, profilePath]) { const stat = lstatSync(file); assert.equal(stat.uid, process.getuid!()); assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.nlink, 1); }

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


test('durable revoke during actual authenticated discovery and after installation wins; higher exact approval restores', async t => {
  const source = await localSource(t); const f = await configFixture(t, source.url); f.approve(); const bundle = f.compose();
  let enter!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  source.beforeList(() => { enter(); return gate; });
  const pending = bundle.restore(); await started;
  const revoked = { ...f.p, generation: 2, enabled: false }; const hash = sha256(canonicalJSON(f.p));
  f.owner.applyConnectionIntent({ expectedPolicySha256: hash, policy: revoked }); release();
  assert.equal((await pending).state, 'refused'); assert.equal(f.registry.currentGrant('endpoint'), undefined);
  source.beforeList(undefined);
  f.approve(3, sha256(canonicalJSON(revoked))); const next = f.compose(); assert.equal(next.state, 'applied');
  assert.deepEqual(await next.restore(), { state: 'restored' });
  f.owner.applyConnectionIntent({ expectedPolicySha256: sha256(canonicalJSON(f.p)), policy: { ...f.p, generation: 4, enabled: false } });
  assert.equal((await next.restore()).state, 'refused'); assert.equal(f.registry.currentGrant('endpoint'), undefined); assert.equal(source.toolHttp, 0);
});


test('catalog never echoes arbitrary remote names containing protected token or reference', async t => {
  const source = await localSource(t); const f = await configFixture(t, source.url);
  source.catalogNames(['alpha-secret', 'mcp-credential']);
  const result = await f.config.catalogMcpConfiguration({ configDir: f.configDir, ownerId: f.ownerId, allowEgress: true, unknownClass: 'ordinary', limit: 2 });
  assert.equal(result.total, 2); assert.equal(result.cursor, null);
  assert.doesNotMatch(JSON.stringify(result), /alpha-secret|mcp-credential/);
  assert.deepEqual(result.toolNames, ['<unapproved-tool>', '<unapproved-tool>']);
});

test('mcp.json endpoint catalog: missing is a defined state; strict grantMode, owner-only, secret-free entries', async t => {
  const config = await import(configModule);
  const dir = mkdtempSync(join(tmpdir(), 'didi-mcp-endpoints-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'provider-config');
  // A missing directory and a directory without mcp.json are both the defined 'missing' state, never errors.
  assert.deepEqual(config.loadMcpEndpoints({ configDir }), { state: 'missing' });
  mkdirSync(configDir, { mode: 0o700 });
  assert.deepEqual(config.loadMcpEndpoints({ configDir }), { state: 'missing' });
  const file = join(configDir, 'mcp.json');
  const entry = { id: 'lux-knowledge', transport: 'streamable-http', url: 'http://127.0.0.1:8765/mcp', connector: 'lux-knowledge', account: 'local', resource: 'lux-knowledge', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' };
  // grantMode defaults to explicit when absent; an unknown mode is refused.
  privateJSON(file, { schemaVersion: 1, endpoints: [entry] });
  const defaulted = config.loadMcpEndpoints({ configDir });
  assert.equal(defaulted.state, 'configured'); assert.equal(defaulted.catalog.grantMode, 'explicit');
  privateJSON(file, { schemaVersion: 1, grantMode: 'auto', endpoints: [entry] });
  assert.throws(() => config.loadMcpEndpoints({ configDir }), /invalid_profile/);
  // Only credentialRef names are allowed; an inline token is rejected as a secret.
  privateJSON(file, { schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ ...entry, token: 'secret' }] });
  assert.throws(() => config.loadMcpEndpoints({ configDir }), /invalid_profile/);
  privateJSON(file, { schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [entry] });
  // Owner-only: a group/other-readable file is refused.
  chmodSync(file, 0o644);
  assert.throws(() => config.loadMcpEndpoints({ configDir }), /file_mode/);
  chmodSync(file, 0o600);
  const loaded = config.loadMcpEndpoints({ configDir });
  assert.equal(loaded.state, 'configured'); assert.equal(loaded.catalog.grantMode, 'owner-trusted-reads');
  assert.deepEqual(loaded.catalog.endpoints, [entry]);
});

test('mcp credential resolver reads an owner-only synthetic file and refuses a malformed one; a missing credential is a typed endpoint error', async t => {
  const host = await import(hostModule);
  const dir = mkdtempSync(join(tmpdir(), 'didi-mcp-credential-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const good = join(dir, 'mongo.json');
  privateJSON(good, { schemaVersion: 1, token: 'synthetic-bearer-token' });
  assert.equal(host.readMcpCredential(dir, 'mongo'), 'synthetic-bearer-token');

  privateJSON(join(dir, 'empty.json'), { schemaVersion: 1, token: '' });
  assert.throws(() => host.readMcpCredential(dir, 'empty'), /credential empty missing or invalid/);
  privateJSON(join(dir, 'v2.json'), { schemaVersion: 2, token: 'synthetic' });
  assert.throws(() => host.readMcpCredential(dir, 'v2'));
  privateJSON(join(dir, 'extra.json'), { schemaVersion: 1, token: 'synthetic', extra: true });
  assert.throws(() => host.readMcpCredential(dir, 'extra'));
  writeFileSync(join(dir, 'wide.json'), JSON.stringify({ schemaVersion: 1, token: 'synthetic' }), { mode: 0o644 });
  chmodSync(join(dir, 'wide.json'), 0o644);
  assert.throws(() => host.readMcpCredential(dir, 'wide'));
  assert.throws(() => host.readMcpCredential(dir, 'absent'));
  assert.throws(() => host.readMcpCredential(dir, '../escape'));

  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 }); chmodSync(configDir, 0o700);
  privateJSON(join(configDir, 'mcp.json'), { schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [
    { id: 'mongo', transport: 'streamable-http', url: 'https://synthetic.invalid/mcp', connector: 'mongoose', account: 'alpha', resource: 'mongodb', credentialRef: 'mongo', enabled: true, allowEgress: true, unknownClass: 'ordinary' },
  ] });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  t.after(() => store.close());
  const runtime = await host.composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
  t.after(async () => { await runtime.close(); });
  const report = runtime.status().endpoints.find((endpoint: { id: string }) => endpoint.id === 'mongo');
  // H19: no stored mongoose credential is a not-signed-in state, not a failing probe at every start.
  assert.equal(report?.state, 'error');
  assert.equal(report?.error, 'not_signed_in');
  assert.equal(report?.reasonCode, 'not_signed_in');
  assert.equal(report?.tools, 0);
});

test('owner-created synthetic catalog preserves explicit bounded source classes for all five connectors', async () => {
  const config = await import('../config/mcp.js');
  const classes = { calendar: 'ordinary', gmail: 'private', 'lux-knowledge': 'sensitive', mattermost: 'private', mongoose: 'ordinary' };
  const endpoints = Object.entries(classes).map(([id, unknownClass]) => ({
    id, connector: id, unknownClass, account: 'synthetic-owner', resource: 'synthetic-corpus',
    credentialRef: null, enabled: false, allowEgress: false,
    ...(id === 'gmail' || id === 'calendar' || id === 'mattermost'
      ? { transport: 'stdio', command: '/synthetic/node', args: [`/synthetic/${id}.mjs`], env: { HOME: '/synthetic', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' } }
      : { transport: 'streamable-http', url: `https://synthetic.invalid/${id}` }),
  }));
  const dir = mkdtempSync(join(tmpdir(), 'didi-owner-catalog-'));
  try {
    chmodSync(dir, 0o700);
    const catalog = { schemaVersion: 1, grantMode: 'explicit', endpoints };
    privateJSON(join(dir, 'mcp.json'), catalog);
    const loaded = config.loadMcpEndpoints({ configDir: dir }); assert.equal(loaded.state, 'configured');
    if (loaded.state !== 'configured') throw Error('owner catalog missing');
    assert.equal(loaded.catalog.grantMode, 'explicit');
    assert.deepEqual(loaded.catalog.endpoints.map(e => e.id).sort(), Object.keys(classes).sort());
    for (const entry of loaded.catalog.endpoints) {
      assert.equal(entry.unknownClass, classes[entry.id as keyof typeof classes]);
      assert.equal(entry.configurationError, undefined);
      assert.equal(entry.enabled, false); assert.equal(entry.allowEgress, false);
    }
    const invalid = JSON.parse(JSON.stringify(catalog));
    delete invalid.endpoints[0].unknownClass;
    invalid.endpoints[1].unknownClass = 'unbounded';
    privateJSON(join(dir, 'mcp.json'), invalid);
    const rejected = config.loadMcpEndpoints({ configDir: dir });
    if (rejected.state !== 'configured') throw Error('owner catalog missing');
    assert.equal(rejected.catalog.endpoints[0]!.unknownClass, null);
    assert.equal(rejected.catalog.endpoints[0]!.configurationError, 'unknown-class-missing');
    assert.equal(rejected.catalog.endpoints[1]!.unknownClass, null);
    assert.equal(rejected.catalog.endpoints[1]!.configurationError, 'unknown-class-invalid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


async function deadlineRuntime(t: TestContext, entries: { id: string; connector: string; url: string }[], callDeadlineMs?: number) {
  const host = await import(hostModule);
  const dir = mkdtempSync(join(tmpdir(), 'didi-call-deadline-')); chmodSync(dir, 0o700);
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  privateJSON(join(configDir, 'synthetic.json'), { schemaVersion: 1, token: 'alpha-secret' });
  privateJSON(join(configDir, 'mcp.json'), { schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: entries.map(entry => ({
    ...entry, transport: 'streamable-http', account: 'alpha', resource: 'synthetic-corpus', credentialRef: 'synthetic',
    enabled: true, allowEgress: true, unknownClass: 'ordinary',
  })) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const runtime = await host.composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, ...(callDeadlineMs === undefined ? {} : { callDeadlineMs }) });
  t.after(() => runtime.close());
  function call(id: string, toolName: string, signal?: AbortSignal) {
    const grant = runtime.registry.currentGrant(id); assert.ok(grant);
    return runtime.port.call({ endpointId: id, toolName, arguments: {}, generation: grant.generation,
      account: 'alpha', resource: 'synthetic-corpus' }, signal);
  }
  return { runtime, call };
}

test('host Google call budget admits a real slow read while every configured connector shares the endpoint deadline', async t => {
  const google = await localSource(t); google.catalogNames(['gmail_search_messages', 'gmail_get_profile']); google.callDelay(5500);
  const ordinary = await localSource(t); ordinary.callDelay(5500);
  const { runtime, call } = await deadlineRuntime(t, [
    { id: 'google', connector: 'google', url: google.url },
    { id: 'knowledge', connector: 'lux-knowledge', url: ordinary.url },
  ]);
  const [result, unchanged] = await Promise.all([call('google', 'gmail_search_messages'), call('knowledge', 'search_knowledge')]);
  assert.equal(result.state, 'completed'); assert.equal(google.executed, 1);
  if (result.state !== 'completed' || result.payload.state !== 'available') throw Error('missing real slow read');
  const grant = runtime.registry.currentGrant('google'); assert.ok(grant);
  const slice = runtime.port.readSlice({ endpointId: 'google', generation: grant.generation, account: 'alpha',
    resource: 'synthetic-corpus', handle: result.payload.handle, offset: 0, length: result.payload.byteLength });
  assert.equal(slice.state, 'available');
  if (slice.state === 'available') {
    const entity = JSON.parse(Buffer.from(slice.bytes).toString());
    assert.equal(JSON.parse(entity.result.content[0].text).data.messages.length, 1);
  }
  // The deliberate budget is endpoint-scoped and shared: the same 5.5 s read also completes on a non-Google
  // connector, so no configured connector keeps the old five-second default.
  assert.equal(unchanged.state, 'completed'); assert.equal(ordinary.executed, 1);
  // The deadline is still a real bound: a call past it fails with the timeout code instead of completing.
  const slow = await localSource(t); slow.catalogNames(['gmail_search_messages', 'gmail_get_profile']);
  const late = await deadlineRuntime(t, [{ id: 'google', connector: 'google', url: slow.url }], 500);
  slow.callDelay(2000);
  const overdue = await late.call('google', 'gmail_search_messages');
  assert.equal(overdue.state, 'unknown'); if (overdue.state === 'unknown') assert.equal(overdue.reason, 'timeout');
  assert.equal(slow.executed, 1);
});

test('host Google discovery preserves the five-second startup bound', async t => {
  const google = await localSource(t); google.catalogNames(['gmail_search_messages', 'gmail_get_profile']);
  google.beforeList(() => new Promise(() => {}));
  const began = performance.now();
  const { runtime } = await deadlineRuntime(t, [{ id: 'google', connector: 'google', url: google.url }]);
  assert.ok(performance.now() - began < 6000, 'slow Google discovery cannot consume a thirty-second call budget');
  const report = runtime.status().endpoints[0]; assert.equal(report?.state, 'error');
  assert.equal(report?.error, 'timeout-or-cancelled'); assert.equal(google.executed, 0);
});

test('host Google earlier cancellation fails one call and preserves frozen authority', async t => {
  const google = await localSource(t); google.catalogNames(['gmail_search_messages', 'gmail_get_profile']); google.callDelay(5500);
  const { runtime, call } = await deadlineRuntime(t, [{ id: 'google', connector: 'google', url: google.url }]);
  const authority = runtime.registry.currentGrant('google'); assert.ok(authority);
  const controller = new AbortController();
  const pending = call('google', 'gmail_search_messages', controller.signal);
  const deadline = performance.now() + 1000;
  while (google.executed === 0) { assert.ok(performance.now() < deadline); await new Promise<void>(resolve => setImmediate(resolve)); }
  const began = performance.now(); controller.abort();
  const result = await pending;
  assert.ok(performance.now() - began < 1000);
  assert.equal(result.state, 'unknown');
  if (result.state === 'unknown') assert.equal(result.reason, 'cancelled');
  // A cancellation is a soft failure: it fails this one call and never replays it, but the connector stays
  // usable, so the connector is not suspended and the frozen authority is left intact (issue #211, W4-R4).
  assert.equal(google.executed, 1);
  assert.deepEqual(runtime.registry.currentGrant('google'), authority);
});
