import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../runtime/store.js';
import { hostMigrations } from '../host/runtime.js';
import { composeMcpRuntime } from '../host/mcp.js';

// Every identity below is synthetic; no real account, address or token appears in this file.
const OWNER = 'owner@example.test';
const OTHER = 'other@example.test';

interface FakeConnector {
  url: string;
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
async function fakeConnector(options: { blockConnect?: boolean } = {}): Promise<FakeConnector> {
  const calls: string[] = [];
  let connectResolve!: () => void; const connectGate = new Promise<void>(resolve => { connectResolve = resolve; });
  const tools = ['gmail_get_profile', 'gmail_list', 'gmail_read'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
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
    if (message.method === 'tools/list') signalDiscovery();
    let identity: string | undefined;
    if (message.method === 'tools/call') {
      const name = String(message.params?.name ?? '');
      calls.push(name);
      if (name === 'gmail_get_profile') {
        proofs++; for (const waiter of proofWaiters.splice(0)) waiter();
        identity = await new Promise<string>(resolveIdentity => { pendingProofs.push(resolveIdentity); });
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
    onConnect: options.blockConnect ? new Promise<void>(resolveConnect => { void connectGate.then(resolveConnect); }) : Promise.resolve(),
    releaseConnect: connectResolve,
    onDiscovery: discoveries > 0 ? Promise.resolve() : new Promise<void>(resolveDiscovery => { discoveryWaiters.push(resolveDiscovery); }),
    proofCount: () => proofs,
    waitProof: (n: number) => proofs >= n ? Promise.resolve() : new Promise<void>(resolveProof => { proofWaiters.push(() => { if (proofs >= n) resolveProof(); }); }),
    releaseProof: (index, identity) => { const next = pendingProofs.splice(index, 1)[0]; if (!next) throw new Error('no pending proof'); next(identity); },
    close: () => new Promise<void>(resolveClose => endpoint.close(() => resolveClose())),
  };
}

async function compose(t: TestContext, options: { ownerIdentity?: string | null; blockConnect?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-publication-'));
  const configDir = join(dir, 'provider-config'); await mkdir(configDir, { mode: 0o700 });
  const fake = await fakeConnector(options.blockConnect === undefined ? {} : { blockConnect: options.blockConnect });
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads',
    ...(options.ownerIdentity === undefined || options.ownerIdentity === null ? {} : { ownerIdentity: options.ownerIdentity }),
    endpoints: [{ id: 'gmail', connector: 'google', transport: 'streamable-http', url: fake.url, account: 'synthetic', resource: 'gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'state'), hostMigrations);
  const mcp = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, deferConnectors: true });
  return { store, mcp, fake };
}

test('a connector round is deferred: composition returns while connect is blocked', async t => {
  const { mcp, fake } = await compose(t, { blockConnect: true });
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
  assert.equal(mcp.registry.currentGrant('gmail')?.toolNames.includes('gmail_list'), false);
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

test('a stale proof never publishes or overwrites a replaced generation', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const first = mcp.start();
  await fake.waitProof(1);
  // `refresh` bumps the generation token synchronously, before its discovery call.
  const second = mcp.refresh();
  // The old generation's proof now resolves with a mismatch: it must authorize nothing.
  fake.releaseProof(0, OTHER);
  await first;
  assert.notEqual(mcp.status().endpoints[0]!.state, 'error', JSON.stringify(mcp.status().endpoints[0]));
  // Generation 2 then proves the owner and is the only round that publishes.
  await fake.waitProof(2);
  fake.releaseProof(0, OWNER);
  await second;
  assert.equal(mcp.status().endpoints[0]!.state, 'connected');
  assert.equal(mcp.status().endpoints[0]!.reasonCode, undefined);
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
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

test('no owner identity publishes after discovery under the no-comparison policy', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: null });
  const started = mcp.start();
  await started;
  assert.equal(mcp.status().endpoints[0]!.state, 'connected');
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
  assert.equal(fake.calls.filter(name => name === 'gmail_get_profile').length, 0);
});

test('a session accepted while verifying keeps no tools from that connector after it settles', async t => {
  const { mcp, fake } = await compose(t, { ownerIdentity: OWNER });
  const started = mcp.start();
  await fake.onDiscovery;
  await fake.waitProof(1);
  const admittedWhileVerifying = [...mcp.connectionIds()];
  assert.deepEqual(admittedWhileVerifying, []);
  fake.releaseProof(0, OWNER);
  await started;
  // The later session sees the connector; the earlier session's snapshot never gains it.
  assert.deepEqual(admittedWhileVerifying, []);
  assert.deepEqual(mcp.connectionIds(), ['gmail']);
});
