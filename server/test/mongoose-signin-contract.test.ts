import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mongooseAccessToken, mongooseBinding, writeMongooseOAuth, MongooseCredentialError, type MongooseOAuthRecord } from '../host/mongoose-auth.js';
import { MongooseLoginError, runMongooseLogin, type MongooseLoginOptions, type MongooseSignInHop } from '../host/mongoose-login.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_AUDIENCES, MONGOOSE_ENDPOINT_TOOLS, mongooseEndpointName, type MongooseEndpoint } from '../connectors/mongoose.js';
import { FAKE_ORIGIN, canonicalResource, startContractFake, type ContractFake } from './mongoose-contract-fake.js';

const NOW = 1_760_000_000_000;

function configDir(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'didi-mongoose-contract-'));
  const dir = join(root, 'provider-config');
  mkdirSync(dir, { mode: 0o700 });
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const stored = (dir: string, endpoint: MongooseEndpoint): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, `mongoose-${endpoint}.json`), 'utf8')) as Record<string, unknown>;

/** The real host login against the fake, with the owner's browser driven synthetically. */
function login(fake: ContractFake, dir: string, endpoint: MongooseEndpoint, extra: Partial<MongooseLoginOptions> & { browse?: { state?: string; times?: number } } = {}) {
  const opened: string[] = [];
  const hops: MongooseSignInHop[] = [];
  const answers: Promise<string[]>[] = [];
  const { browse, ...options } = extra;
  const operation = runMongooseLogin({
    configDir: dir, reference: `mongoose-${endpoint}`, resourceUrl: `${FAKE_ORIGIN}/mcp/${endpoint}`, endpoint, account: 'local',
    redirectPort: 0, timeoutMs: 5_000, now: () => NOW, fetch: fake.fetch,
    onHop: hop => { hops.push(hop); },
    openBrowser: url => { opened.push(url); answers.push(fake.browse(url, browse)); },
    ...options,
  });
  return { operation, opened, hops, answers };
}

/** Every byte Didi sent to Mongoose, so no request can carry the invented `mongoose:<name>` resource. */
function wire(fake: ContractFake): string {
  return JSON.stringify([fake.registrations, fake.authorizations.map(q => [...q.entries()]), fake.tokenCalls.map(call => call.form)]);
}

test('contract fake: the omitted authorize resource binds knowledge and a supplied resource must pass canonical_resource', () => {
  const allowed = ['knowledge', 'data', 'crm', 'admin'].map(name => `${FAKE_ORIGIN}/mcp/${name}`);
  assert.equal(canonicalResource(`${FAKE_ORIGIN}/mcp/data`, allowed), `${FAKE_ORIGIN}/mcp/data`);
  assert.equal(canonicalResource('HTTPS://MONGOOSE.TEST/mcp/data/', allowed), `${FAKE_ORIGIN}/mcp/data`, 'Mongoose itself normalises case and one trailing slash');
  for (const refused of ['mongoose:data', 'mongoose:knowledge', `http://mongoose.test/mcp/data`, `${FAKE_ORIGIN}/mcp/data?toolset=x`, `${FAKE_ORIGIN}/mcp/data#x`, `https://user@mongoose.test/mcp/data`, `${FAKE_ORIGIN}/mcp`, 'https://elsewhere.test/mcp/data']) {
    assert.throws(() => canonicalResource(refused, allowed), `${refused} is refused`);
  }
});

for (const endpoint of MONGOOSE_ENDPOINTS) {
  test(`${endpoint}: the real login signs in against the live discovery shape, binds the URL resource, refreshes and reads`, async () => {
    const { dir, cleanup } = configDir();
    const fake = await startContractFake();
    try {
      const resource = `${FAKE_ORIGIN}/mcp/${endpoint}`;
      const run = login(fake, dir, endpoint);
      await run.operation;
      assert.equal(run.opened.length, 1, 'one browser handoff');
      const authorize = new URL(run.opened[0]!);
      assert.equal(authorize.origin + authorize.pathname, `${FAKE_ORIGIN}/oauth/authorize`);
      assert.deepEqual(authorize.searchParams.getAll('resource'), [resource], 'the authorize URL carries exactly this endpoint resource');
      assert.deepEqual((await Promise.all(run.answers)).flat(), ['Lux Didi received the Mongoose sign-in. You can close this tab.\n']);
      const exchange = fake.tokenCalls.find(call => call.form['grant_type'] === 'authorization_code')!;
      assert.equal(exchange.status, 200, `the exchange is accepted (${exchange.error ?? 'ok'})`);
      assert.equal(exchange.form['resource'], resource, 'the code exchange carries the URL');
      const record = stored(dir, endpoint);
      assert.equal(record['endpoint'], endpoint);
      assert.equal(record['resource'], resource);
      assert.equal(record['issuer'], FAKE_ORIGIN);
      assert.equal('audience' in record, false, 'the auth model has no mongoose:<name> field');
      assert.deepEqual(run.hops.map(hop => `${hop.hop}:${hop.outcome}`), ['discovery:ok', 'registration:ok', 'browser_handoff:ok', 'callback:ok', 'token:ok', 'stored:ok']);

      // A read through this endpoint works with the stored token, and the token opens no other endpoint.
      const binding = mongooseBinding(resource, endpoint)!;
      const first = await mongooseAccessToken(dir, `mongoose-${endpoint}`, binding, { now: () => NOW, fetch: fake.fetch });
      assert.equal(await fake.read(`/mcp/${endpoint}`, first), 200);
      const other = MONGOOSE_ENDPOINTS.find(name => name !== endpoint)!;
      assert.equal(await fake.read(`/mcp/${other}`, first), 401);

      // An expired access token refreshes once, with the URL resource, and the new token reads.
      const later = NOW + 3_600_000;
      const second = await mongooseAccessToken(dir, `mongoose-${endpoint}`, binding, { now: () => later, fetch: fake.fetch });
      const refresh = fake.tokenCalls.filter(call => call.form['grant_type'] === 'refresh_token');
      assert.equal(refresh.length, 1, 'one refresh');
      assert.equal(refresh[0]!.status, 200, `the refresh is accepted (${refresh[0]!.error ?? 'ok'})`);
      assert.equal(refresh[0]!.form['resource'], resource, 'the refresh carries the URL');
      assert.notEqual(second, first);
      assert.equal(await fake.read(`/mcp/${endpoint}`, second), 200);
      assert.doesNotMatch(wire(fake), /mongoose:(knowledge|data|crm)/, 'no request carries the invented resource');
      assert.deepEqual(fake.offOrigin, [], 'nothing left the configured origin');
    } finally { await fake.close(); cleanup(); }
  });
}

async function refusedAtDiscovery(edit: (fake: ContractFake) => void, outcome: string): Promise<void> {
  const { dir, cleanup } = configDir();
  const fake = await startContractFake();
  try {
    edit(fake);
    const run = login(fake, dir, 'data');
    await assert.rejects(run.operation, (error: unknown) => error instanceof MongooseLoginError && error.code === 'metadata-unavailable');
    assert.deepEqual(run.hops.map(hop => `${hop.hop}:${hop.outcome}`), [`discovery:${outcome}`]);
    assert.deepEqual(run.opened, [], 'no browser opens');
    assert.deepEqual(fake.registrations, [], 'no client is registered');
    assert.deepEqual(readdirSync(dir), [], 'nothing is written');
    assert.deepEqual(fake.offOrigin, [], 'no request leaves the configured origin');
    assert.deepEqual(fake.followed, [], 'no redirect is followed');
  } finally { await fake.close(); cleanup(); }
}

const DATA_DOC = '/.well-known/oauth-protected-resource/mcp/data';
const AS_DOC = '/.well-known/oauth-authorization-server';
const editDoc = (fake: ContractFake, path: string, change: Record<string, unknown>) => { fake.documents.set(path, { ...fake.documents.get(path), ...change }); };

test('a sibling-path discovery document on the same origin is refused', async () => {
  await refusedAtDiscovery(fake => editDoc(fake, DATA_DOC, { resource: `${FAKE_ORIGIN}/mcp/knowledge` }), 'resource_mismatch');
});

test('a discovery resource is compared exactly, without normalising case or a trailing slash', async () => {
  await refusedAtDiscovery(fake => editDoc(fake, DATA_DOC, { resource: `${FAKE_ORIGIN}/mcp/data/` }), 'resource_mismatch');
  await refusedAtDiscovery(fake => editDoc(fake, DATA_DOC, { resource: 'https://MONGOOSE.test/mcp/data' }), 'resource_mismatch');
  await refusedAtDiscovery(fake => editDoc(fake, DATA_DOC, { resource: 'mongoose:data' }), 'resource_mismatch');
});

test('a foreign authorization server or issuer is refused', async () => {
  await refusedAtDiscovery(fake => editDoc(fake, DATA_DOC, { authorization_servers: ['https://elsewhere.test'] }), 'server_untrusted');
  await refusedAtDiscovery(fake => editDoc(fake, AS_DOC, { issuer: 'https://elsewhere.test' }), 'issuer_mismatch');
});

test('an authorization server endpoint off the configured origin, or not https, is refused', async () => {
  await refusedAtDiscovery(fake => editDoc(fake, AS_DOC, { token_endpoint: 'https://elsewhere.test/oauth/token' }), 'endpoint_off_origin');
  await refusedAtDiscovery(fake => editDoc(fake, AS_DOC, { registration_endpoint: 'http://mongoose.test/oauth/register' }), 'endpoint_off_origin');
  await refusedAtDiscovery(fake => editDoc(fake, AS_DOC, { authorization_endpoint: 'https://elsewhere.test/oauth/authorize' }), 'endpoint_off_origin');
});

test('a discovery redirect is never followed off the origin', async () => {
  await refusedAtDiscovery(fake => { fake.redirectOffOrigin.add(DATA_DOC); }, 'redirected');
});

test('W1-R4: a redirect on the authorization server metadata is refused', async () => {
  await refusedAtDiscovery(fake => { fake.redirectOffOrigin.add(AS_DOC); }, 'redirected');
});

test('W1-R4: a redirect on the token endpoint is never followed, at the exchange or at a refresh', async () => {
  const { dir, cleanup } = configDir();
  const fake = await startContractFake();
  try {
    fake.redirectOffOrigin.add('/oauth/token');
    const run = login(fake, dir, 'knowledge');
    await assert.rejects(run.operation, (error: unknown) => error instanceof MongooseLoginError && error.code === 'token-refused');
    assert.deepEqual(run.hops.at(-1), { hop: 'token', outcome: 'unreachable' });
    assert.deepEqual(readdirSync(dir), [], 'nothing is written');
    assert.deepEqual(fake.followed, [], 'the redirect target was never fetched');

    // A good sign-in first, then the refresh meets the same redirect.
    fake.redirectOffOrigin.delete('/oauth/token');
    await login(fake, dir, 'knowledge').operation;
    fake.redirectOffOrigin.add('/oauth/token');
    const binding = mongooseBinding(`${FAKE_ORIGIN}/mcp/knowledge`, 'knowledge')!;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', binding, { now: () => NOW + 3_600_000, fetch: fake.fetch }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-unavailable');
    assert.equal(fake.tokenCalls.at(-1)!.status, 307, 'the refresh reached the redirect');
    assert.deepEqual(fake.followed, [], 'and did not follow it');
    assert.equal(stored(dir, 'knowledge')['refreshToken'] !== undefined, true, 'the stored session is kept for a later attempt');
  } finally { await fake.close(); cleanup(); }
});

test('a token exchange whose resource does not match the code binding is refused by the server and saves nothing', async () => {
  const { dir, cleanup } = configDir();
  const fake = await startContractFake();
  try {
    // A request that names another endpoint than the one consented to: Mongoose answers invalid_target.
    const crossed: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/oauth/token') && init?.body) {
        const form = new URLSearchParams(String(init.body));
        form.set('resource', `${FAKE_ORIGIN}/mcp/crm`);
        return fake.fetch(input, { ...init, body: form });
      }
      return fake.fetch(input, init);
    };
    const run = login(fake, dir, 'data', { fetch: crossed });
    await assert.rejects(run.operation, (error: unknown) => error instanceof MongooseLoginError && error.code === 'token-refused');
    assert.equal(fake.tokenCalls[0]!.error, 'invalid_target');
    const token = run.hops.find(hop => hop.hop === 'token');
    assert.deepEqual(token, { hop: 'token', outcome: 'refused', oauthError: 'invalid_target' });
    assert.deepEqual(readdirSync(dir), []);
  } finally { await fake.close(); cleanup(); }
});

test('a callback with a bad state is refused and nothing is exchanged or saved', async () => {
  const { dir, cleanup } = configDir();
  const fake = await startContractFake();
  try {
    const run = login(fake, dir, 'knowledge', { browse: { state: 'not-the-state' } });
    await assert.rejects(run.operation, (error: unknown) => error instanceof MongooseLoginError && error.code === 'state-mismatch');
    assert.deepEqual((await Promise.all(run.answers)).flat(), ['Lux Didi refused this sign-in. You can close this tab.\n']);
    assert.equal(fake.tokenCalls.length, 0);
    assert.deepEqual(run.hops.at(-1), { hop: 'callback', outcome: 'state_mismatch' });
    assert.deepEqual(readdirSync(dir), []);
  } finally { await fake.close(); cleanup(); }
});

test('a replayed callback is refused: the state is single use and one code is exchanged once', async () => {
  const { dir, cleanup } = configDir();
  const fake = await startContractFake();
  try {
    const run = login(fake, dir, 'crm', { browse: { times: 2 } });
    await run.operation;
    const answers = (await Promise.all(run.answers)).flat().sort();
    assert.deepEqual(answers, ['Lux Didi received the Mongoose sign-in. You can close this tab.\n', 'Lux Didi refused this sign-in. You can close this tab.\n']);
    assert.equal(fake.tokenCalls.filter(call => call.form['grant_type'] === 'authorization_code').length, 1);
    assert.equal(stored(dir, 'crm')['resource'], `${FAKE_ORIGIN}/mcp/crm`);
  } finally { await fake.close(); cleanup(); }
});

function storedRecord(resource: string, issuer: string): MongooseOAuthRecord {
  return {
    schemaVersion: 3, endpoint: 'knowledge', resource, issuer, tokenEndpoint: `${issuer}/oauth/token`, clientId: 'mcp_client', redirectPort: 8768, account: 'local',
    accessToken: 'access-token-old', refreshToken: 'refresh-token-old', expiresAt: NOW, consentStartedAt: NOW,
  };
}

test('a stored binding that no longer matches the configuration is a sign-in, and no refresh is attempted', async () => {
  const { dir, cleanup } = configDir();
  try {
    let calls = 0;
    const counting = (async () => { calls += 1; return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
    writeMongooseOAuth(dir, 'mongoose-knowledge', storedRecord('https://other.test/mcp/knowledge', 'https://other.test'));
    const binding = mongooseBinding(`${FAKE_ORIGIN}/mcp/knowledge`, 'knowledge')!;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', binding, { now: () => NOW, fetch: counting }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-missing');
    // Same origin, but the record was issued for another endpoint than the one configured under this reference.
    writeMongooseOAuth(dir, 'mongoose-knowledge', storedRecord(`${FAKE_ORIGIN}/mcp/knowledge`, FAKE_ORIGIN));
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', mongooseBinding(`${FAKE_ORIGIN}/mcp/data`, 'data'), { now: () => NOW, fetch: counting }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-missing');
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', undefined, { now: () => NOW, fetch: counting }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-missing');
    assert.equal(calls, 0, 'no refresh request was sent');
  } finally { cleanup(); }
});

test('the configured URL decides the binding: https only, no userinfo, query or fragment, the endpoint own path', () => {
  assert.deepEqual(mongooseBinding(`${FAKE_ORIGIN}/mcp/crm`, 'crm'), { endpoint: 'crm', resource: `${FAKE_ORIGIN}/mcp/crm`, issuer: FAKE_ORIGIN });
  for (const refused of ['http://mongoose.test/mcp/crm', 'https://user@mongoose.test/mcp/crm', `${FAKE_ORIGIN}/mcp/crm?toolset=x`, `${FAKE_ORIGIN}/mcp/crm#x`, `${FAKE_ORIGIN}/mcp/data`, `${FAKE_ORIGIN}/mcp`, 'mongoose:crm']) {
    assert.equal(mongooseBinding(refused, 'crm'), undefined, `${refused} is not a trusted configuration`);
  }
});

// --- C-SIGNIN-LIVE: a completed sign-in connects its own endpoint in place, with no relaunch. ---

/** The Mongoose catalogue for one synthetic origin: three endpoints, one record each. */
function syncCatalogue(origin: string): Record<string, unknown>[] {
  return MONGOOSE_ENDPOINTS.map(name => ({
    id: `mongoose-${name}`, connector: 'mongoose', transport: 'streamable-http', account: OWNER_EMAIL,
    url: `${origin}/mcp/${name}`, resource: `mongoose:${name}`, credentialRef: `mongoose-${name}`,
    enabled: true, allowEgress: true, unknownClass: 'ordinary',
  }));
}

/** A synthetic Mongoose MCP endpoint set: every path answers the handshake with that endpoint's tools. */
async function syntheticMongoose(): Promise<{ origin: string; close(): Promise<void> }> {
  const endpoint = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!/^Bearer .+$/.test(String(req.headers.authorization ?? ''))) { res.writeHead(401).end(); return; }
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown; method: string };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const name = mongooseEndpointName(String(req.url)) ?? 'crm';
    const tools = MONGOOSE_ENDPOINT_TOOLS[name].map(tool => ({ name: tool, inputSchema: { type: 'object', properties: {}, additionalProperties: true }, annotations: { readOnlyHint: true } }));
    const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-mongoose', version: '1' } }
      : message.method === 'tools/list' ? { tools } : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => endpoint.close(() => resolve())) };
}

const OWNER_EMAIL = 'owner@example.test';

/** The minted claim pair the host decodes: the owner email and that endpoint's own audience. */
function mintedToken(endpoint: MongooseEndpoint, email: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ email, aud: MONGOOSE_ENDPOINT_AUDIENCES[endpoint] })}.c2ln`;
}

test('a completed CRM sign-in connects crm in place, logging connector_connected with no host restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-inplace-'));
  const configDir = join(dir, 'provider-config'); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const fake = await syntheticMongoose();
  const store = new Store(join(dir, 'state'), toolsMigrations);
  const lifecycle: Record<string, unknown>[] = [];
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: OWNER_EMAIL, endpoints: syncCatalogue(fake.origin) }), { mode: 0o600 });
  const mcp = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, deferConnectors: true,
    lifecycleLog: event => lifecycle.push(event as unknown as Record<string, unknown>),
  });
  t.after(async () => { await mcp.close(); await fake.close(); rmSync(dir, { recursive: true, force: true }); });
  const record = (endpoint: MongooseEndpoint): Record<string, unknown> => {
    const binding = mongooseBinding(`${fake.origin}/mcp/${endpoint}`, endpoint)!;
    return { schemaVersion: 3, endpoint, resource: binding.resource, issuer: binding.issuer, tokenEndpoint: `${fake.origin}/oauth/token`, clientId: 'synthetic', redirectPort: 8768, account: OWNER_EMAIL, accessToken: mintedToken(endpoint, OWNER_EMAIL), refreshToken: `refresh-${endpoint}`, expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now(), identity: OWNER_EMAIL };
  };
  // knowledge and data were already signed in; crm is the one the owner is signing in now.
  writeFileSync(join(configDir, 'mongoose-knowledge.json'), JSON.stringify(record('knowledge')), { mode: 0o600 });
  writeFileSync(join(configDir, 'mongoose-data.json'), JSON.stringify(record('data')), { mode: 0o600 });

  await mcp.start();
  assert.equal(mcp.status().endpoints.find(row => row.id === 'mongoose-crm')?.state, 'error', 'crm is not connected before the sign-in');
  assert.equal(lifecycle.some(event => event['event'] === 'connector_connected' && event['endpointId'] === 'mongoose-crm'), false);

  // The sign-in lands: the record appears exactly as runMongooseLogin writes it.
  writeFileSync(join(configDir, 'mongoose-crm.json'), JSON.stringify(record('crm')), { mode: 0o600 });
  await mcp.recover();

  assert.equal(mcp.status().endpoints.find(row => row.id === 'mongoose-crm')?.state, 'connected', 'crm connected in place, no restart');
  assert.deepEqual(lifecycle.filter(event => event['event'] === 'connector_connected' && event['endpointId'] === 'mongoose-crm').length, 1);
});
