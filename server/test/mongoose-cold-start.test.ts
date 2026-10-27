import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/index.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_AUDIENCES } from '../connectors/mongoose.js';

const literal = JSON.parse(readFileSync(join(process.cwd(), 'server/test/fixtures/mongoose-tools-list-literal.json'), 'utf8'));

for (const hang of [false, true]) test(hang ? 'hung handshake ends with connect_timeout' : 'cold start: all three literal Mongoose catalogues connect', async t => {
  const deadlines: AbortController[] = [];
  if (hang) t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.ok(ms > 0 && ms <= 30000, 'connect work uses a finite deadline');
    const controller = new AbortController(); deadlines.push(controller); return controller.signal;
  });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (hang && message.method === 'initialize') {
      for (const controller of deadlines.splice(0)) controller.abort(new DOMException('deadline', 'TimeoutError'));
      return;
    }
    const endpoint = req.url!.split('/').at(-1)!;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mongoose-fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: literal[endpoint] } : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const root = mkdtempSync(join(tmpdir(), 'didi-cold-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'provider-config'); mkdirSync(configDir, { mode: 0o700 });
  const endpoints = MONGOOSE_ENDPOINTS.map(endpoint => {
    const resource = `http://127.0.0.1:${address.port}/mcp/${endpoint}`;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'HS256' })}.${encode({ email: 'owner@example.test', aud: MONGOOSE_ENDPOINT_AUDIENCES[endpoint] })}.c2ln`;
    writeFileSync(join(configDir, `mongoose-${endpoint}.json`), JSON.stringify({
      schemaVersion: 3, endpoint, resource, issuer: new URL(resource).origin,
      tokenEndpoint: `${new URL(resource).origin}/oauth/token`, clientId: 'test', redirectPort: 8768,
      account: 'owner@example.test', accessToken: token, refreshToken: 'refresh-test',
      expiresAt: Date.now() + 3600000, consentStartedAt: Date.now(),
    }), { mode: 0o600 });
    return { id: `mongoose-${endpoint}`, connector: 'mongoose', transport: 'streamable-http', url: resource,
      account: 'owner@example.test', resource: `mongoose:${endpoint}`, credentialRef: `mongoose-${endpoint}`,
      enabled: true, allowEgress: true, unknownClass: 'ordinary' };
  });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: 'owner@example.test', endpoints }), { mode: 0o600 });
  const store = new Store(join(root, 'data'), toolsMigrations); t.after(() => store.close());
  const connected: string[] = [];
  const identities: string[] = [];
  const failures: string[] = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir,
    lookupAuthority: async () => null, connectorLog: (_connector, _stage, detail) => { if (detail?.reason) failures.push(detail.reason); }, identityLog: (_connector, _proven, _match, endpointId) => { identities.push(endpointId!); }, recoveryDelaysMs: [], lifecycleLog: event => {
      if (event.event === 'connector_connected') connected.push(event.endpointId);
    } });
  t.after(() => runtime.close());
  if (hang) {
    assert.deepEqual(failures, ['connect_timeout', 'connect_timeout', 'connect_timeout']);
    assert.deepEqual(connected, []); return;
  }
  for (const endpoint of MONGOOSE_ENDPOINTS) {
    for (let i = 0; i < 3; i++) await runtime.port.discover(`mongoose-${endpoint}`);
  }
  assert.deepEqual(identities.sort(), MONGOOSE_ENDPOINTS.map(endpoint => `mongoose-${endpoint}`).sort(), 'one identity receipt per endpoint, not per credential resolution');
  assert.deepEqual(connected.sort(), MONGOOSE_ENDPOINTS.map(endpoint => `mongoose-${endpoint}`).sort(), JSON.stringify(runtime.status()));
});
