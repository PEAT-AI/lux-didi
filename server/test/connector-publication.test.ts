import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type Server } from 'node:http';
import { chmod } from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Server as McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { toolsMigrations } from '../tools/schema.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Store } from '../runtime/store.js';
import { hostMigrations } from '../host/runtime.js';
import { composeMcpRuntime, type ConnectorLifecycleEvent } from '../host/mcp.js';
import type { ConnectionPolicy, RunAcceptance } from '../tools/types.js';
import { CONNECTOR_COMPOSED_TOOLS, MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL, MATTERMOST_PERSON_TOOLS, MATTERMOST_READ_TOOLS, MATTERMOST_TOOLS, composedDeclarationDigest, composedGrantedNames, connectorDescriptor } from '../connectors/index.js';
import { validatePolicy } from '../tools/index.js';

// Every identity below is synthetic; no real account, address or token appears in this file.
const OWNER = 'owner@example.test';
const OTHER = 'other@example.test';

interface FakeConnector {
  url: string;
  changeCatalog(): void;
  failRead(status: number): void;
  discoveryCount(): number;
  failDiscovery(status: number): void;
  deferDiscovery(): { entered: Promise<void>; release(): void };
  calls: string[];
  onConnect: Promise<void>;
  releaseConnect(): void;
  onDiscovery: Promise<void>;
  proofCount(): number;
  waitProof(n: number): Promise<void>;
  releaseProof(index: number, identity: string): void;
  close(): Promise<void>;
}

/**
 * One fake Gmail MCP endpoint with deferred promises instead of sleeps. `blockConnect` holds the
 * initialize handshake; proofs await an explicit identity from the test.
 */
async function fakeConnector(options: { blockConnect?: boolean; autoProof?: string } = {}): Promise<FakeConnector> {
  const calls: string[] = [];
  let connectResolve!: () => void; const connectGate = new Promise<void>(resolve => { connectResolve = resolve; });
  const tools = ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
  let readStatus = 0, discoveryStatus = 0;
  let discoveryGate: { entered(): void; pending: Promise<void> } | undefined;
  let discoveries = 0; const discoveryWaiters: Array<() => void> = [];
  const signalDiscovery = (): void => { discoveries++; for (const waiter of discoveryWaiters.splice(0)) waiter(); };
  let proofs = 0; const proofWaiters: Array<() => void> = [];
  const pendingProofs: Array<(identity: string) => void> = [];
  const endpoint: Server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown; method: string; params?: { name?: string } };
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (message.method === 'initialize' && options.blockConnect) await connectGate;
    if (message.method === 'tools/list') { signalDiscovery(); if (discoveryGate) { const gate = discoveryGate; discoveryGate = undefined; gate.entered(); await gate.pending; }
      if (discoveryStatus) { const status = discoveryStatus; discoveryStatus = 0; res.writeHead(status); res.end(); return; } }
    let identity: string | undefined;
    if (message.method === 'tools/call') {
      const name = String(message.params?.name ?? '');
      calls.push(name);
      if (name === 'gmail_search_messages' && readStatus) { const status = readStatus; readStatus = 0; res.writeHead(status); res.end(); return; }
      if (name === 'gmail_get_profile') {
        proofs++; for (const waiter of proofWaiters.splice(0)) waiter();
        identity = options.autoProof ?? await new Promise<string>(resolveIdentity => { pendingProofs.push(resolveIdentity); });
      }
    }
    const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : message.method === 'tools/list' ? { tools }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(message.params?.name === 'gmail_get_profile' ? { emailAddress: identity } : { ok: true }) }] }
      : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}/gmail`,
    calls,
    failDiscovery: status => { discoveryStatus = status; },
    deferDiscovery: () => { let entered!: () => void, release!: () => void; const onEntry = new Promise<void>(resolve => { entered = resolve; }); const pending = new Promise<void>(resolve => { release = resolve; }); discoveryGate = { entered, pending }; return { entered: onEntry, release }; },
    failRead: status => { readStatus = status; },
    discoveryCount: () => discoveries,
    changeCatalog: () => { Object.assign(tools[0]!, { description: 'Changed same-name schema contract' }); },
    onConnect: options.blockConnect ? new Promise<void>(resolveConnect => { void connectGate.then(resolveConnect); }) : Promise.resolve(),
    releaseConnect: connectResolve,
    onDiscovery: discoveries > 0 ? Promise.resolve() : new Promise<void>(resolveDiscovery => { discoveryWaiters.push(resolveDiscovery); }),
    proofCount: () => proofs,
    waitProof: (n: number) => proofs >= n ? Promise.resolve() : new Promise<void>(resolveProof => { proofWaiters.push(() => { if (proofs >= n) resolveProof(); }); }),
    releaseProof: (index, identity) => { const next = pendingProofs.splice(index, 1)[0]; if (!next) throw new Error('no pending proof'); next(identity); },
    close: () => new Promise<void>(resolveClose => endpoint.close(() => resolveClose())),
  };
}

async function compose(t: TestContext, options: { ownerIdentity?: string | null; blockConnect?: boolean; autoProof?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-publication-'));
  const configDir = join(dir, 'provider-config'); await mkdir(configDir, { mode: 0o700 });
  const fake = await fakeConnector({ ...(options.blockConnect === undefined ? {} : { blockConnect: options.blockConnect }), ...(options.autoProof === undefined ? {} : { autoProof: options.autoProof }) });
  // A superseded generation can leave a proof POST in flight; close the composition so the adapter
  // aborts it before the fake endpoint is asked to close (F8-R3).
  t.after(async () => { await mcp.close(); await fake.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads',
    ...(options.ownerIdentity === undefined || options.ownerIdentity === null ? {} : { ownerIdentity: options.ownerIdentity }),
    endpoints: [{ id: 'gmail', connector: 'google', transport: 'streamable-http', url: fake.url, account: 'synthetic', resource: 'gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'state'), hostMigrations);
  const mcp = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, deferConnectors: true });
  return { store, mcp, fake, configDir };
}

test('a connector round is deferred: composition returns while connect is blocked', async t => {
  const { mcp, fake } = await compose(t, { blockConnect: true, autoProof: OWNER });
  assert.equal(mcp.connectionIds().length, 0);
  assert.equal(mcp.status().endpoints[0]!.state, 'connecting');
  const started = mcp.start();
  assert.equal(mcp.status().endpoints[0]!.state, 'connecting');
  assert.equal(mcp.registry.currentGrant('gmail'), undefined);
  fake.releaseConnect();
  await started;
  assert.equal(mcp.status().endpoints[0]!.state, 'connected');
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
});

test('pre-proof discovery exposes nothing, mismatch refuses, match publishes', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const started = mcp.start();
  await fake.onDiscovery;
  await fake.waitProof(1);
  // Discovery is done and the identity proof is in flight: no declaration, no grant, no read handler.
  assert.equal(mcp.connectionIds().length, 0);
  assert.notEqual(mcp.status().endpoints[0]!.state, 'connected');
  // Only the private identity candidate exists; no model-facing tool is callable.
  assert.deepEqual(mcp.registry.visibleTools('gmail').map(tool => tool.name), ['gmail_get_profile']);
  assert.equal(mcp.registry.currentGrant('gmail')?.toolNames.includes('gmail_search_messages'), false);
  assert.deepEqual(fake.calls.filter(name => name !== 'gmail_get_profile'), []);
  fake.releaseProof(0, OTHER);
  await started;
  assert.equal(mcp.status().endpoints[0]!.state, 'error');
  assert.equal(mcp.status().endpoints[0]!.reasonCode, 'identity_mismatch');
  assert.equal(mcp.connectionIds().length, 0);
  assert.equal(mcp.registry.currentGrant('gmail'), undefined);

  const matching = await compose(t, { ownerIdentity: OWNER });
  const startedMatch = matching.mcp.start();
  await matching.fake.waitProof(1);
  matching.fake.releaseProof(0, OWNER);
  await startedMatch;
  assert.equal(matching.mcp.status().endpoints[0]!.state, 'connected');
  assert.deepEqual(matching.mcp.connectionIds(), ['gmail']);
  assert.ok(matching.mcp.registry.currentGrant('gmail'));
  assert.ok(matching.mcp.registry.visibleTools('gmail').length > 0);
});

test('a proof for a replaced generation publishes nothing', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const first = mcp.start();
  await fake.waitProof(1);
  // `refresh` bumps the generation token synchronously, before its discovery call.
  const second = mcp.refresh();
  // The replaced generation now resolves a matching proof: it must authorize nothing.
  fake.releaseProof(0, OWNER);
  await first;
  // The replacement round carries its own pending proof; settle it (a different account, so it still
  // publishes nothing) rather than waiting out a fixed proof timeout.
  await fake.waitProof(2);
  fake.releaseProof(0, OTHER);
  await second;
  // Generation 2 cannot take the busy session, but the old proof published nothing either way.
  assert.deepEqual(mcp.connectionIds(), []);
  assert.equal(mcp.registry.currentGrant('gmail'), undefined);
});

test('shutdown during a proof publishes nothing and leaves no unhandled rejection', async t => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const started = mcp.start();
  await fake.waitProof(1);
  await mcp.close();
  fake.releaseProof(0, OWNER);
  await started;
  await new Promise<void>(resolveTurn => { setImmediate(resolveTurn); });
  assert.equal(mcp.connectionIds().length, 0);
  assert.notEqual(mcp.status().endpoints[0]!.state, 'connected');
  assert.deepEqual(rejections, []);
});

test('no owner identity still probes Google, so an unproven read never publishes', async t => {
  // lux-didi #495 and review C1: Google is a strict identity source, so the no-comparison policy does
  // not publish it without a proof. The empty identity value is the helper's unverifiable account.
  const { mcp, fake } = await compose(t, { ownerIdentity: null });
  const started = mcp.start();
  await fake.waitProof(1);
  assert.notEqual(mcp.status().endpoints[0]!.state, 'connected');
  assert.deepEqual(mcp.connectionIds(), []);
  assert.equal(fake.calls.filter(name => name === 'gmail_get_profile').length, 1);
  fake.releaseProof(0, '');
  await started;
  assert.equal(mcp.status().endpoints[0]!.state, 'error');
  assert.equal(mcp.status().endpoints[0]!.reasonCode, 'identity_unverified');
  assert.equal(mcp.connectionIds().length, 0);
  assert.equal(mcp.registry.currentGrant('gmail'), undefined);
});

test('no owner identity publishes a proven Google identity under the no-comparison policy', async t => {
  const { mcp } = await compose(t, { ownerIdentity: null, autoProof: OWNER });
  await mcp.start();
  assert.equal(mcp.status().endpoints[0]!.state, 'connected');
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
});

test('connectionIds is empty while a connector is verifying', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const started = mcp.start();
  await fake.onDiscovery;
  await fake.waitProof(1);
  assert.deepEqual(mcp.connectionIds(), []);
  fake.releaseProof(0, OWNER);
  await started;
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
});

test('a Live acceptance snapshot taken while verifying never gains the connector', async t => {
  const { store, mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const remember = (): { remembered: boolean; code: string } => ({ remembered: false, code: 'owner_transcript_not_final' });
  const started = mcp.start();
  await fake.onDiscovery;
  await fake.waitProof(1);
  const acceptance: RunAcceptance = {
    ownerId: store.assistantId, actorId: 'synthetic-actor', runId: 'live-verifying', authorityEpoch: store.authorityEpoch, revision: 1,
    route: { identity: 'gateway:live-voice', provider: 'gemini', modelId: 'models/synthetic', allowedClasses: ['ordinary'] },
    allowedClasses: ['ordinary'], connectionIds: [...mcp.connectionIds()],
  };
  store.transaction(tx => mcp.owner.snapshotRun(tx, acceptance));
  assert.equal(mcp.owner.liveDefinitions('live-verifying', remember).some(tool => tool.name.startsWith('gmail')), false);
  fake.releaseProof(0, OWNER);
  await started;
  // The recorded acceptance snapshot is immutable: the same session still has no connector tool.
  assert.equal(mcp.owner.liveDefinitions('live-verifying', remember).some(tool => tool.name.startsWith('gmail')), false);
  // A session accepted after readiness does carry the connector tools.
  store.transaction(tx => mcp.owner.snapshotRun(tx, { ...acceptance, runId: 'live-ready', connectionIds: [...mcp.connectionIds()] }));
  assert.equal(mcp.owner.liveDefinitions('live-ready', remember).some(tool => tool.name.startsWith('gmail')), true);
});

test('a slow identity proof inside the endpoint call deadline still publishes the connector', async t => {
  // F9: the proof is one read call, so it is bounded by the endpoint's own call deadline, not a shorter
  // fixed bound. A healthy connector whose first identity call is slow under host load must be proven,
  // never wrongly marked unproven and fail-closed. The fake answers at 4.2 s, past the old 4 s bound.
  const { store, mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const remember = (): { remembered: boolean; code: string } => ({ remembered: false, code: 'owner_transcript_not_final' });
  const started = mcp.start();
  await fake.onDiscovery;
  await fake.waitProof(1);
  await new Promise<void>(resolve => setTimeout(resolve, 4_200));
  fake.releaseProof(0, OWNER);
  await started;
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  const acceptance: RunAcceptance = {
    ownerId: store.assistantId, actorId: 'synthetic-actor', runId: 'live-slow-proof', authorityEpoch: store.authorityEpoch, revision: 1,
    route: { identity: 'gateway:live-voice', provider: 'gemini', modelId: 'models/synthetic', allowedClasses: ['ordinary'] },
    allowedClasses: ['ordinary'], connectionIds: [...mcp.connectionIds()],
  };
  store.transaction(tx => mcp.owner.snapshotRun(tx, acceptance));
  assert.equal(mcp.owner.liveDefinitions('live-slow-proof', remember).some(tool => tool.name.startsWith('gmail')), true);
});

test('a refresh suspends the ready grant before the replacement publishes and refuses old calls', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const first = mcp.start();
  await fake.waitProof(1);
  fake.releaseProof(0, OWNER);
  await first;
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  const refreshed = mcp.refresh();
  // The generation bump drops the callable grant before any replacement can publish.
  assert.equal(mcp.registry.currentGrant('gmail'), undefined);
  assert.deepEqual(mcp.registry.visibleTools('gmail'), []);
  assert.deepEqual(mcp.connectionIds(), []);
  await fake.waitProof(2);
  fake.releaseProof(0, OWNER);
  await refreshed;
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  assert.equal(fake.calls.includes('gmail_search_messages'), false);
});

test('a failed re-verification after a refresh leaves no grant', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const first = mcp.start();
  await fake.waitProof(1);
  fake.releaseProof(0, OWNER);
  await first;
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  const refreshed = mcp.refresh();
  await fake.waitProof(2);
  fake.releaseProof(0, OTHER);
  await refreshed;
  assert.equal(mcp.registry.currentGrant('gmail'), undefined);
  assert.deepEqual(mcp.connectionIds(), []);
  assert.equal(mcp.status().endpoints[0]!.state, 'error');
  assert.equal(mcp.status().endpoints[0]!.reasonCode, 'identity_mismatch');
});


test('fluency: startup refresh cannot auto-adopt a changed same-name catalog', async t => {
  const { mcp, store, fake } = await compose(t, { ownerIdentity: null, autoProof: OWNER });
  await mcp.start();
  const before = store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE connection_id=?', ['gmail']));
  fake.changeCatalog();
  await mcp.refresh();
  assert.equal(mcp.status().endpoints[0]!.configurationError, 'owner-approval-required');
  assert.equal(mcp.connectionIds().length, 0);
  assert.deepEqual(store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE connection_id=?', ['gmail'])), before);
});


test('fluency: host recovers exact approved transport once and never replays the failed read', async t => {
  const { mcp, store, fake } = await compose(t, { ownerIdentity: null, autoProof: OWNER });
  await mcp.start();
  const before = store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE connection_id=?', ['gmail']));
  const grant = mcp.registry.currentGrant('gmail')!;
  fake.failRead(503);
  const failed = await mcp.port.call({ endpointId: 'gmail', toolName: 'gmail_search_messages', arguments: {}, generation: grant.generation, account: grant.account, resource: grant.resource });
  assert.deepEqual(failed, { state: 'unknown', reason: 'transport_unavailable' });
  assert.notEqual(mcp.status().endpoints[0]!.state, 'connected');
  for (let i = 0; i < 1000 && mcp.connectionIds().length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  assert.equal(fake.discoveryCount(), 2, 'exactly one automatic recovery discovery');
  assert.deepEqual(fake.calls.filter(name => name !== 'gmail_get_profile'), ['gmail_search_messages'], 'no read replay and exactly one identity probe');
  assert.deepEqual(store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE connection_id=?', ['gmail'])), before);
  const next = await mcp.port.call({ endpointId: 'gmail', toolName: 'gmail_search_messages', arguments: {}, generation: grant.generation, account: grant.account, resource: grant.resource });
  assert.equal(next.state, 'completed');
  assert.deepEqual(fake.calls.filter(name => name !== 'gmail_get_profile'), ['gmail_search_messages', 'gmail_search_messages']);
});


test('fluency: failed recovery has no recursive retry and a distinct demand can restore it', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: null, autoProof: OWNER }); await mcp.start();
  const grant = mcp.registry.currentGrant('gmail')!;
  fake.failRead(503); fake.failDiscovery(503);
  await mcp.port.call({ endpointId: 'gmail', toolName: 'gmail_search_messages', arguments: {}, generation: grant.generation, account: grant.account, resource: grant.resource });
  await mcp.recover();
  assert.equal(mcp.status().endpoints[0]!.state, 'error');
  assert.equal(fake.discoveryCount(), 2, 'failed discovery does not recurse');
  assert.deepEqual(fake.calls.filter(name => name !== 'gmail_get_profile'), ['gmail_search_messages']);
  await mcp.recover();
  assert.equal(fake.discoveryCount(), 3);
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  assert.deepEqual(fake.calls.filter(name => name !== 'gmail_get_profile'), ['gmail_search_messages'], 'demand recovers transport only, with one identity probe');
});

test('fluency: recovery refuses changed catalog, binding, revocation and late close', async t => {
  for (const change of ['catalog', 'binding', 'revoke', 'close', 'revision'] as const) {
    const { mcp, fake, store, configDir } = await compose(t, { ownerIdentity: null, autoProof: OWNER }); await mcp.start();
    const before = store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE connection_id=?', ['gmail']));
    const grant = mcp.registry.currentGrant('gmail')!;
    const gate = fake.deferDiscovery(); fake.failRead(503);
    const failed = mcp.port.call({ endpointId: 'gmail', toolName: 'gmail_search_messages', arguments: {}, generation: grant.generation, account: grant.account, resource: grant.resource });
    await gate.entered;
    const currentFlight = mcp.recover();
    let closing: Promise<void> | undefined;
    if (change === 'catalog') fake.changeCatalog();
    if (change === 'revoke') mcp.registry.revoke('gmail');
    if (change === 'revision') mcp.registry.suspend('gmail');
    if (change === 'binding') await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [] }), { mode: 0o600 });
    if (change === 'close') closing = mcp.close();
    gate.release(); await failed; await currentFlight; await closing;
    assert.equal(mcp.registry.currentGrant('gmail'), undefined, change);
    assert.equal(mcp.connectionIds().length, 0, change);
    assert.notEqual(mcp.status().endpoints[0]!.state, 'connected', change);
    assert.deepEqual(store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE connection_id=?', ['gmail'])), before, change);
    assert.deepEqual(fake.calls.filter(name => name !== 'gmail_get_profile'), ['gmail_search_messages']);
  }
});

// #604: the attention view is the connector's own composite, so it is granted only when every child
// read it needs is granted, and never because a server published a name that looks like it.
test('#604: the composed attention view is granted only when every child read is granted', () => {
  const composed = CONNECTOR_COMPOSED_TOOLS['mattermost'] ?? [];
  // C-CHAT: the chat read is the second composite, standing on the same five base reads.
  assert.deepEqual(composed.map(entry => entry.name), [MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL]);
  assert.deepEqual(composedGrantedNames('mattermost', MATTERMOST_TOOLS), [MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL]);
  const withoutThread = MATTERMOST_TOOLS.filter(name => name !== 'mattermost_get_thread');
  assert.deepEqual(composedGrantedNames('mattermost', withoutThread), [], 'a missing child read leaves the composite ungranted');
  assert.deepEqual(composedGrantedNames('google', MATTERMOST_TOOLS), [], 'no other connector carries a composite');
});

test('#604: a composed grant is its own declaration, with a host-computed digest', () => {
  const [attention] = CONNECTOR_COMPOSED_TOOLS['mattermost'] ?? [];
  assert.ok(attention);
  assert.equal(composedDeclarationDigest(attention), composedDeclarationDigest(attention), 'the digest is stable');
  const changed = { ...attention, description: `${attention.description} Extra.` };
  assert.notEqual(composedDeclarationDigest(changed), composedDeclarationDigest(attention), 'a changed declaration is a changed digest');
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 1024, maxResultBytes: 1024 } };
  const declaration = connectorDescriptor('mattermost')!.declarations(policy as never).find(entry => entry.name === MATTERMOST_ATTENTION_TOOL);
  assert.ok(declaration, 'the composite is a declared read tool');
  assert.equal(declaration.validate({ days: 3 }), true);
  assert.equal(declaration.validate({ days: 400 }), false);
});

test('#604: a policy may name the composite only beside the children it reads', () => {
  const base = {
    schemaVersion: 1, bindingMode: 'connection', ownerId: OWNER, connectionId: 'mattermost', generation: 1, enabled: true,
    connector: 'mattermost',
    endpoint: { id: 'mattermost', url: 'https://synthetic.invalid/mcp', account: 'local', resource: 'mattermost', credentialRef: null },
    schemaDigest: 'a'.repeat(64),
    sourcePolicy: { id: 'mattermost', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'mattermost', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 1024, maxResultBytes: 1024 },
  };
  assert.doesNotThrow(() => validatePolicy({ ...base, toolNames: [...MATTERMOST_TOOLS, MATTERMOST_ATTENTION_TOOL] } as never));
  assert.throws(() => validatePolicy({ ...base, toolNames: [...MATTERMOST_TOOLS.filter(name => name !== 'mattermost_get_thread'), MATTERMOST_ATTENTION_TOOL] } as never), /invalid_read_tools/u);
});

// C-CHAT: a newer child's person reads are readable names a policy may grant, beside both composites; a
// child without them keeps the five base reads and both composites, and a write is never a grantable name.
test('C-CHAT: a policy may grant the person reads and the chat read, never a write', () => {
  const base = {
    schemaVersion: 1, bindingMode: 'connection', ownerId: OWNER, connectionId: 'mattermost', generation: 1, enabled: true,
    connector: 'mattermost',
    endpoint: { id: 'mattermost', url: 'https://synthetic.invalid/mcp', account: 'local', resource: 'mattermost', credentialRef: null },
    schemaDigest: 'a'.repeat(64),
    sourcePolicy: { id: 'mattermost', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'mattermost', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 1024, maxResultBytes: 1024 },
  };
  assert.deepEqual([...MATTERMOST_READ_TOOLS], [...MATTERMOST_TOOLS, ...MATTERMOST_PERSON_TOOLS]);
  assert.doesNotThrow(() => validatePolicy({ ...base, toolNames: [...MATTERMOST_READ_TOOLS, MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL] } as never));
  assert.doesNotThrow(() => validatePolicy({ ...base, toolNames: [...MATTERMOST_TOOLS, MATTERMOST_CHAT_TOOL] } as never), 'the older child keeps the chat read');
  assert.throws(() => validatePolicy({ ...base, toolNames: [...MATTERMOST_READ_TOOLS, 'mattermost_post_message'] } as never), /invalid_read_tools/u);
  assert.throws(() => validatePolicy({ ...base, toolNames: [...MATTERMOST_TOOLS.filter(name => name !== 'mattermost_search'), MATTERMOST_CHAT_TOOL] } as never), /invalid_read_tools/u);
});

// ---- C-CHAT (W2b): moving an installed Didi to a Mattermost child with the person reads ---------------------
// The same connection may never widen its approved envelope by itself, so the install adds the newer child as a
// new connection id and disables the old one: the new id settles from the reviewed read envelope, no CLI call.

type Endpoint = { id: string; path: string; enabled: boolean };

/** One synthetic Mattermost child per URL path, each publishing its own tool list (plus a write it never gets). */
async function mattermostBindingHost(t: TestContext, grantMode: 'owner-trusted-reads' | 'explicit' = 'owner-trusted-reads') {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-binding-'));
  const configDir = join(dir, 'provider-config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const servers = new Map<string, { sdk: McpServer; transport: WebStandardStreamableHTTPServerTransport }>();
  const published = new Map<string, readonly string[]>();
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const server = servers.get(path);
    assert.ok(server, `a fake child answers ${path}`);
    return server.transport.handleRequest(new Request(input, init));
  });
  let store = new Store(join(dir, 'data'), toolsMigrations);
  let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
  const lifecycle: ConnectorLifecycleEvent[] = [];
  t.after(async () => {
    await runtime?.close();
    for (const { sdk, transport } of servers.values()) { await sdk.close(); await transport.close(); }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const start = async (endpoints: readonly Endpoint[], tools: Record<string, readonly string[]>) => {
    if (runtime) { await runtime.close(); store.close(); store = new Store(join(dir, 'data'), toolsMigrations); }
    for (const { sdk, transport } of servers.values()) { await sdk.close(); await transport.close(); }
    servers.clear();
    for (const [path, names] of Object.entries(tools)) {
      published.set(path, names);
      const sdk = new McpServer({ name: 'synthetic-mattermost', version: '1' }, { capabilities: { tools: {} } });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      sdk.setRequestHandler('tools/list', () => ({ tools: [...names, 'mattermost_post_message'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) }) as never);
      sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ username: 'synthetic-owner', email: 'owner@example.invalid' }) }] }) as never);
      await sdk.connect(transport);
      servers.set(path, { sdk, transport });
    }
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      schemaVersion: 1, grantMode,
      endpoints: endpoints.map(endpoint => ({ id: endpoint.id, connector: 'mattermost', transport: 'streamable-http', url: `http://127.0.0.1:18766${endpoint.path}`, account: 'mattermost', resource: 'mattermost', credentialRef: null, enabled: endpoint.enabled, allowEgress: true, unknownClass: 'private' })),
    }));
    await chmod(join(configDir, 'mcp.json'), 0o600);
    runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, lifecycleLog: event => { lifecycle.push(event); } });
    await runtime.start();
    return runtime;
  };
  const policy = (id: string): ConnectionPolicy | undefined => {
    const row = store.transaction(tx => tx.get('SELECT policy_json FROM tool_connections WHERE owner_id=? AND connection_id=?', [store.assistantId, id]));
    return row === undefined ? undefined : JSON.parse(String(row['policy_json'])) as ConnectionPolicy;
  };
  return { start, policy, lifecycle };
}

test('W2-R1: a release that widens inside the reviewed envelope reconnects the owner\'s own connector, one generation on', async t => {
  const h = await mattermostBindingHost(t);
  await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  const before = h.policy('mattermost');
  assert.deepEqual(before?.toolNames, [...MATTERMOST_TOOLS, MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL].sort(), 'the older child: five reads and both composites');
  const widened = await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_READ_TOOLS });
  const after = h.policy('mattermost');
  assert.ok(widened.connectionIds().includes('mattermost'), 'the reviewed envelope is the approval, so the connector reconnects itself');
  assert.deepEqual(after?.toolNames, [...MATTERMOST_READ_TOOLS, MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL].sort(), 'the reconciled row carries the person reads too');
  assert.equal(after?.generation, Number(before?.generation) + 1, 'a reconciled widening is a new generation');
  assert.equal(widened.status().endpoints.find(endpoint => endpoint.id === 'mattermost')?.state, 'connected');
  assert.deepEqual(h.lifecycle.find(event => event.event === 'connector_envelope_widened'),
    { event: 'connector_envelope_widened', endpointId: 'mattermost', addedToolNames: [...MATTERMOST_PERSON_TOOLS].sort() }, 'the receipt names the added reads and nothing else');
  // The child also publishes a write tool the envelope never carries, and the widening is not a way in.
  const grant = widened.registry.currentGrant('mattermost');
  assert.ok(grant && !grant.toolNames.includes('mattermost_post_message'));
});

test('W2-R1: explicit mode never widens itself, whatever the child publishes', async t => {
  const h = await mattermostBindingHost(t, 'explicit');
  await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  const widened = await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_READ_TOOLS });
  const report = widened.status().endpoints.find(endpoint => endpoint.id === 'mattermost');
  // Explicit mode admits a read only from the owner's own approve command, so no published read and no
  // stored row can widen it: nothing is granted and no reconcile receipt is written.
  assert.deepEqual(widened.connectionIds(), [], 'an explicit approval never widens itself');
  assert.equal(report?.tools, 0, 'no read is granted without the owner');
  assert.equal(h.lifecycle.some(event => event.event === 'connector_envelope_widened'), false);
});

test('W2-R1: a changed http url for the same endpoint id is still a move, never a silent re-approval', async t => {
  const h = await mattermostBindingHost(t);
  await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  const moved = await h.start([{ id: 'mattermost', path: '/moved', enabled: true }], { '/old': MATTERMOST_TOOLS, '/moved': MATTERMOST_TOOLS });
  assert.deepEqual(moved.connectionIds(), [], 'only a stdio child may move its own path');
  assert.equal(moved.status().endpoints.find(endpoint => endpoint.id === 'mattermost')?.configurationError, 'owner-approval-required');
  assert.deepEqual(h.lifecycle.filter(event => event.event === 'connector_approval_refused').at(-1),
    { event: 'connector_approval_refused', endpointId: 'mattermost', reason: 'endpoint_changed' });
});

test('W2-R1: a widening outside the reviewed envelope is never granted, in any mode', async t => {
  const h = await mattermostBindingHost(t);
  await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  // The child publishes the person reads plus a name the reviewed envelope does not carry: the host filters
  // publication through connectionEnvelope before it computes any widening, so the name cannot widen.
  const widened = await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': [...MATTERMOST_READ_TOOLS, 'mattermost_admin_delete'] });
  const grant = widened.registry.currentGrant('mattermost');
  assert.ok(grant && !grant.toolNames.includes('mattermost_admin_delete') && !grant.toolNames.includes('mattermost_post_message'));
  assert.deepEqual(h.lifecycle.find(event => event.event === 'connector_envelope_widened'),
    { event: 'connector_envelope_widened', endpointId: 'mattermost', addedToolNames: [...MATTERMOST_PERSON_TOOLS].sort() });
});

test('C-CHAT: the install route, a new connection id for the newer child beside the disabled old one, settles from the envelope', async t => {
  const h = await mattermostBindingHost(t);
  await h.start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  const moved = await h.start([{ id: 'mattermost', path: '/old', enabled: false }, { id: 'mattermost-people', path: '/people', enabled: true }], { '/people': MATTERMOST_READ_TOOLS });
  assert.deepEqual(moved.connectionIds(), ['mattermost-people'], 'only the new connection is accepted');
  assert.deepEqual(h.policy('mattermost-people')?.toolNames, [...MATTERMOST_READ_TOOLS, MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL].sort(), 'seven reads and both composites, never the write');
  assert.deepEqual([...(moved.registry.currentGrant('mattermost-people')?.toolNames ?? [])].sort(), [...MATTERMOST_READ_TOOLS].sort());
  let oldGrant: unknown;
  try { oldGrant = moved.registry.currentGrant('mattermost'); } catch { oldGrant = undefined; }
  assert.equal(oldGrant, undefined, 'the old connection grants nothing');
});

// ---- W2-R1: a rebuilt stdio child keeps its endpoint and reconnects without an approval ----------------
// The owner's own child moved from a dated directory to a stable one and the host that launches it got a
// fresh PATH. Neither says anything about which server the endpoint is, so neither is a new approval.

// The fixture rides in server/test/fixtures, three levels up from both the source and the compiled file.
const GOOGLE_CHILD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'google-mcp-child.mjs');

function stdioApprovalHost(t: TestContext, dir: string, configDir: string) {
  let store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: { event: string; endpointId?: string; fields?: readonly string[]; reason?: string; addedToolNames?: readonly string[] }[] = [];
  const failures: string[] = [];
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const endpoint = (args: readonly string[], path: string, account = 'local', resource = 'google-gmail') => ({
    id: 'gmail', transport: 'stdio', command: process.execPath, args: [...args],
    // The whole launch environment, PATH included, exactly as the installing host shapes it.
    env: { HOME: '/home/fixture', PATH: path, LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    connector: 'google', account, resource, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'private',
  });
  const write = (grantMode: string, args: readonly string[], path: string, account?: string, resource?: string): void => {
    writeFileSync(join(configDir, 'mcp.json'),
      JSON.stringify({ schemaVersion: 1, grantMode, ownerIdentity: 'owner@example.invalid', endpoints: [endpoint(args, path, account, resource)] }),
      { mode: 0o600 });
  };
  const start = async () => {
    const runtime = await composeMcpRuntime({
      store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
      lifecycleLog: event => { lifecycle.push(event as unknown as { event: string }); },
      connectorLog: (_connector, _stage, detail) => { failures.push(String(detail?.reason)); },
    });
    await runtime.start();
    return runtime;
  };
  const generation = (): number => Number(store.transaction(tx => tx.get("SELECT generation FROM tool_connections WHERE connection_id='gmail'"))?.['generation']);
  return { endpoint, write, start, generation, lifecycle, failures, report: (runtime: Awaited<ReturnType<typeof composeMcpRuntime>>) => runtime.status().endpoints.find(entry => entry.id === 'gmail') };
}

test('W2-R1: a rebuilt stdio child in a moved directory with a fresh PATH reconnects without an approval', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-moved-child-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const rebuiltDir = join(dir, 'google-mcp-local'); mkdirSync(rebuiltDir);
  const rebuiltChild = join(rebuiltDir, 'google-mcp-child.mjs');
  copyFileSync(GOOGLE_CHILD, rebuiltChild);
  const h = stdioApprovalHost(t, dir, configDir);
  h.write('owner-trusted-reads', [GOOGLE_CHILD, 'ok'], '/usr/bin');
  const first = await h.start();
  assert.equal(h.report(first)?.state, 'connected', JSON.stringify(h.report(first)));
  await first.close();
  const settled = h.generation();
  h.lifecycle.length = 0;
  // The moved child and the host's new shell PATH: same id, same descriptor, same account and resource.
  h.write('owner-trusted-reads', [rebuiltChild, 'ok'], '/opt/homebrew/bin:/usr/bin');
  const moved = await h.start();
  try {
    assert.equal(h.report(moved)?.state, 'connected', JSON.stringify(h.report(moved)));
    assert.ok((h.report(moved)?.tools ?? 0) > 0, 'the moved child still grants its reads');
    assert.deepEqual(h.failures, [], 'a moved child is not a refusal');
    assert.equal(h.generation(), settled + 1, 'the reconciled endpoint is a new generation');
    assert.deepEqual(h.lifecycle.find(event => event.event === 'connector_endpoint_changed'),
      { event: 'connector_endpoint_changed', endpointId: 'gmail', fields: ['args', 'env'] }, 'which fields moved, never a value');
    assert.equal(h.lifecycle.some(event => event.event === 'connector_approval_refused'), false);
  } finally { await moved.close(); }
  // A PATH-only change is not an endpoint change at all: nothing moved but the shell that launched it.
  h.lifecycle.length = 0;
  h.write('owner-trusted-reads', [rebuiltChild, 'ok'], '/usr/local/bin:/usr/bin');
  const pathOnly = await h.start();
  try {
    assert.equal(h.report(pathOnly)?.state, 'connected');
    assert.equal(h.lifecycle.some(event => event.event === 'connector_endpoint_changed' || event.event === 'connector_approval_refused'), false, 'PATH is never part of the stored endpoint identity');
  } finally { await pathOnly.close(); }
});

test('W2-R1: an account change is a moved endpoint in trusted mode, and explicit mode grants no moved child', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-moved-account-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const rebuiltDir = join(dir, 'google-mcp-local'); mkdirSync(rebuiltDir);
  const rebuiltChild = join(rebuiltDir, 'google-mcp-child.mjs');
  copyFileSync(GOOGLE_CHILD, rebuiltChild);
  const h = stdioApprovalHost(t, dir, configDir);
  h.write('owner-trusted-reads', [GOOGLE_CHILD, 'ok'], '/usr/bin');
  const first = await h.start();
  assert.equal(h.report(first)?.state, 'connected');
  await first.close();
  // The approval was for one account: another account under the same id is a different endpoint.
  h.lifecycle.length = 0;
  h.write('owner-trusted-reads', [rebuiltChild, 'ok'], '/usr/bin', 'other-account');
  const account = await h.start();
  try {
    assert.equal(h.report(account)?.configurationError, 'owner-approval-required');
    assert.deepEqual(account.connectionIds(), [], 'an account change is never a reconciliation');
    assert.deepEqual(h.lifecycle.find(event => event.event === 'connector_approval_refused'),
      { event: 'connector_approval_refused', endpointId: 'gmail', reason: 'endpoint_changed' });
    assert.equal(h.lifecycle.some(event => event.event === 'connector_endpoint_changed'), false);
  } finally { await account.close(); }
});

test('W2-R1: explicit mode grants no read to a moved stdio child', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-moved-explicit-'));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const rebuiltDir = join(dir, 'google-mcp-local'); mkdirSync(rebuiltDir);
  const rebuiltChild = join(rebuiltDir, 'google-mcp-child.mjs');
  copyFileSync(GOOGLE_CHILD, rebuiltChild);
  const h = stdioApprovalHost(t, dir, configDir);
  h.write('owner-trusted-reads', [GOOGLE_CHILD, 'ok'], '/usr/bin');
  const first = await h.start();
  assert.equal(h.report(first)?.state, 'connected');
  await first.close();
  h.lifecycle.length = 0;
  h.write('explicit', [rebuiltChild, 'ok'], '/opt/homebrew/bin:/usr/bin');
  const moved = await h.start();
  try {
    assert.deepEqual(moved.connectionIds(), [], 'explicit mode never follows a moved child');
    assert.equal(h.report(moved)?.tools, 0);
    assert.equal(h.lifecycle.some(event => event.event === 'connector_endpoint_changed' || event.event === 'connector_envelope_widened'), false);
  } finally { await moved.close(); }
});
