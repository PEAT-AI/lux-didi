import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  classifyIdentity, gmailIdentityValues, mattermostIdentityValues, tokenIdentity,
  type IdentityProof, type IdentitySource,
} from '../connectors/identity.js';
import { MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_AUDIENCES, mongooseTokenIdentity as endpointTokenIdentity } from '../connectors/mongoose.js';
import { runMongooseLogin, type MongooseSignInHop } from '../host/mongoose-login.js';
import { loadMcpEndpoints } from '../config/mcp.js';
import { connectorDescriptor } from '../connectors/index.js';
import { googleAccountPinRefused } from '../connectors/google.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { startHost } from '../host/runtime.js';
import type { ConnectorResult } from '../connectors/index.js';

// Every identity below is synthetic; no real account, address or token appears in this file.
const OWNER = 'owner@example.test';
const OTHER = 'other@example.test';

/** The shared contract fixture, captured from Mongoose's own mint (see its provenance block). */
const claimsFixture = JSON.parse(readFileSync(new URL('../../test/fixtures/mongoose-token-claims.json', import.meta.url), 'utf8')) as {
  provenance: { repo: string; sha: string; file: string; symbol: string };
  authorize: { params: string[]; provenance: { repo: string; note: string } };
  token: { claims: string[]; typ: string; email_claim: string; audiences: Record<string, string> };
  refusal: { error: string; mongoose_error: string };
};

/** A literal Mongoose access token shape: the fixture's claims, base64url, no signature to verify. */
function token(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.synthetic-signature`;
}

function claimsFor(audience: string, email: string): Record<string, unknown> {
  return {
    iss: 'https://mongoose.example.test', aud: audience, sub: 'synthetic-user', email,
    sid: 'synthetic-session', jti: 'synthetic-jti', typ: claimsFixture.token.typ,
    iat: 1_790_000_000, nbf: 1_790_000_000, exp: 1_790_003_600,
  };
}

test('the Mongoose contract fixture names the exact claims, audiences and authorize parameters', () => {
  assert.equal(claimsFixture.provenance.repo, 'PEAT-AI/mongoose');
  assert.equal(claimsFixture.provenance.symbol, 'issue_mongoose_access_token');
  assert.ok(/^[0-9a-f]{40}$/.test(claimsFixture.provenance.sha), 'the fixture names the commit it was read from');
  assert.deepEqual([...claimsFixture.token.claims].sort(), ['aud', 'email', 'exp', 'iat', 'iss', 'jti', 'nbf', 'sid', 'sub', 'typ']);
  assert.equal(claimsFixture.token.email_claim, 'email');
  assert.equal(claimsFixture.token.typ, 'access');
  // The audience strings are the production map, not a copy of it.
  for (const endpoint of MONGOOSE_ENDPOINTS) assert.equal(MONGOOSE_ENDPOINT_AUDIENCES[endpoint], claimsFixture.token.audiences[endpoint]);
  assert.deepEqual(Object.keys(claimsFixture.token.audiences).sort(), [...MONGOOSE_ENDPOINTS].sort());
  assert.deepEqual([...claimsFixture.authorize.params].sort(),
    ['client_id', 'code_challenge', 'code_challenge_method', 'expected_email', 'login_hint', 'redirect_uri', 'resource', 'response_type', 'scope', 'state']);
  assert.deepEqual(claimsFixture.refusal, { error: 'access_denied', mongoose_error: 'account_mismatch' });
  // The two request parameters are this contract's, not cade720f's: M1 adds them, and the token proof is the guard today.
  assert.equal(claimsFixture.authorize.provenance.repo, 'PEAT-AI/lux-didi');
  assert.match(claimsFixture.authorize.provenance.note, /ignores unknown parameters/);
});

test('the Mongoose token proves the owner email and the endpoint audience, and refuses anything else', () => {
  for (const endpoint of MONGOOSE_ENDPOINTS) {
    const audience = claimsFixture.token.audiences[endpoint]!;
    const owned = token(claimsFor(audience, OWNER));
    assert.deepEqual(endpointTokenIdentity(owned, endpoint, [OWNER]), { proven: true, match: true, value: OWNER });
    // A real address shape that is not the owner is a mismatch, never merely unproven.
    assert.equal(endpointTokenIdentity(token(claimsFor(audience, OTHER)), endpoint, [OWNER]).match, false);
    // A token for another endpoint's audience is not this connection's token.
    const sibling = MONGOOSE_ENDPOINTS.find(name => name !== endpoint)!;
    assert.equal(endpointTokenIdentity(token(claimsFor(claimsFixture.token.audiences[sibling]!, OWNER)), endpoint, [OWNER]).match, false);
  }
  assert.deepEqual(tokenIdentity('not-a-jwt', { emailClaim: 'email', audience: 'mongoose:knowledge' }, [OWNER]),
    { proven: false, match: null, value: null, code: 'identity_unverified' });
  assert.deepEqual(tokenIdentity(token({ aud: 'mongoose:knowledge' }), { emailClaim: 'email', audience: 'mongoose:knowledge' }, [OWNER]),
    { proven: false, match: null, value: null, code: 'identity_unverified' });
  assert.equal(endpointTokenIdentity(token(claimsFor('mongoose:crm', OWNER)), 'crm', [OWNER]).match, true);
});

test('every identity-bearing connector proves the owner email and refuses another account', () => {
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues };
  const mattermost: IdentitySource = { tool: 'mattermost_whoami', args: {}, values: mattermostIdentityValues };
  const proof = (source: IdentitySource, decoded: unknown): IdentityProof =>
    classifyIdentity({ state: 'completed', decodedResult: decoded } as unknown as ConnectorResult, source, [OWNER]);

  for (const source of [gmail, mattermost]) {
    assert.equal(proof(source, { emailAddress: OWNER, email: OWNER }).match, true);
    assert.equal(proof(source, { emailAddress: OTHER, email: OTHER }).match, false);
    assert.equal(proof(source, {}).proven, false, 'an absent identity never proves');
  }
  // AUD-007: a username that matches never carries an email that does not.
  assert.equal(proof(mattermost, { username: 'rob', email: OTHER }).match, false);
  // With no email at all the username is the only account value; it still has to match the expected set.
  assert.equal(classifyIdentity({ state: 'completed', decodedResult: { username: 'rob' } } as unknown as ConnectorResult, mattermost, ['rob']).match, true);
});

function gmailHostWith(email: string, owner: string) {
  return startFakeHost(email, owner, 'gmail');
}

async function startFakeHost(email: string, owner: string, family: 'gmail') {
  const dir = await mkdtemp(join(tmpdir(), 'didi-owner-identity-'));
  const config = join(dir, 'provider-config');
  await mkdir(config, { mode: 0o700 });
  const tools = (family === 'gmail' ? ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message'] : [])
    .map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
  const calls: string[] = [];
  const reply = (message: { id?: unknown; method: string }) => message.id === undefined ? undefined : {
    jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : message.method === 'tools/list' ? { tools }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ emailAddress: email }) }] } : {},
  };
  const endpoint = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body) as { id?: unknown; method: string; params?: { name?: string } };
    if (message.params?.name !== undefined) calls.push(message.params.name);
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': randomUUID() }).end(JSON.stringify(reply(message)));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const address = endpoint.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/gmail`;
  const stopEndpoint = async (): Promise<void> => {
    endpoint.closeAllConnections();
    await new Promise<void>(done => endpoint.close(() => done()));
  };
  try {
    await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: owner, endpoints: [
      { id: 'gmail', connector: 'google', transport: 'streamable-http', url, account: 'synthetic', resource: 'gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' },
    ] }), { mode: 0o600 });
  } catch (error) {
    await stopEndpoint();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const webRoot = scratchWebRoot();
  let host: Awaited<ReturnType<typeof startHost>>;
  try {
    host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
  } catch (error) {
    await stopEndpoint();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const close = async (): Promise<void> => {
    await host.close();
    await stopEndpoint();
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, host, calls, close };
}

function scratchWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'didi-owner-identity-web-'));
  writeFileSync(join(root, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script src="/assets/app.js"></script></body></html>');
  for (const name of ['sw.js', 'manifest.webmanifest', 'icon.svg']) writeFileSync(join(root, name), name === 'sw.js' ? '' : '{}');
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const name of ['app.js', 'app.css']) writeFileSync(join(root, 'assets', name), '');
  return root;
}

test('a mismatch latches the endpoint: one probe, one connector_latched line, and no per-turn re-probe', async () => {
  const f = await gmailHostWith(OTHER, OWNER);
  try {
    // Fifty owner turns in a real call each ask the runtime to recover; a latched endpoint is never probed again.
    for (let turn = 0; turn < 50; turn += 1) await f.host.tools.recover?.();
    const headers = { Authorization: `Bearer ${f.host.store.adminCredential}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': f.host.descriptor.authorityEpoch, 'Idempotency-Key': randomUUID() };
    const status = await fetch(f.host.descriptor.origin + '/api/v1/tools/status', { headers });
    const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string; reasonCode?: string }>;
    assert.equal(reports[0]!.state, 'error');
    assert.equal(reports[0]!.reasonCode, 'identity_mismatch');
    assert.equal(f.calls.filter(name => name === 'gmail_get_profile').length, 1, 'the account was probed once, never 290 times');
    const lines = (await readFile(join(f.dir, 'state', 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.filter(line => line.event === 'connector_latched').map(line => ({ endpointId: line.endpointId, code: line.code })), [{ endpointId: 'gmail', code: 'identity_mismatch' }]);
  } finally { await f.close(); }
});

test('a Google child pinned to another account is refused at catalog load, the owner pin passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-google-pin-'));
  const config = join(dir, 'provider-config');
  await mkdir(config, { mode: 0o700 });
  const child = (id: string, pinned: string) => ({
    id, connector: 'google', transport: 'stdio', command: '/usr/bin/env', args: [],
    env: { HOME: '/tmp', LOGNAME: '', LUX_GOOGLE_MCP_ACCOUNT: pinned, PATH: '/usr/bin', SHELL: '', TERM: '', USER: '' },
    account: 'local', resource: id, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'private',
  });
  // D1-R4: the helper pins every family to LUX_GOOGLE_MCP_ACCOUNT and refuses a read otherwise, so Didi
  // refuses a child pinned elsewhere before it ever spawns, and accepts the owner's own pin.
  await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: OWNER, endpoints: [
    child('drive-owner', OWNER.toUpperCase()), child('drive-other', OTHER),
  ] }), { mode: 0o600 });
  try {
    const selection = loadMcpEndpoints({ configDir: config });
    assert.equal(selection.state, 'configured');
    const entries = selection.state === 'configured' ? selection.catalog.endpoints : [];
    const refused = (id: string, owner: string | null) => {
      const entry = entries.find(candidate => candidate.id === id);
      assert.ok(entry !== undefined, `the catalogue carries ${id}`);
      return googleAccountPinRefused(entry, owner);
    };
    // Exactly what the host does at registration, before any spawn.
    assert.equal(refused('drive-owner', OWNER), false, 'the owner pin, case-insensitively, proves the family');
    assert.equal(refused('drive-other', OWNER), true, 'another account is refused before spawn');
    assert.equal(refused('drive-owner', null), false, 'no configured owner is the no-comparison policy');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the Drive family records its account proof as the helper pin, and stays strict', () => {
  const source = connectorDescriptor('google')?.identity?.({ toolNames: ['drive_search_files', 'drive_get_file'] } as never);
  assert.equal(source?.proof, 'helper_pin');
  assert.equal(source?.proves, 'consent');
  assert.equal(source?.strict, true);
});

test('composition refuses a Drive child pinned to another account and connects the owner pin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-google-compose-'));
  const config = join(dir, 'provider-config');
  await mkdir(config, { mode: 0o700 });
  // The child speaks stdio MCP and drops a marker on start-up, so "never spawned" is an observation, not a claim.
  const child = join(dir, 'fake-drive.cjs');
  const tools = ['drive_search_files', 'drive_get_file'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
  const reply = (message: { id?: unknown; method: string }) => message.id === undefined ? undefined : {
    jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-drive', version: '1' } }
      : message.method === 'tools/list' ? { tools }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ files: [], nextPageToken: null }) }] } : {},
  };
  await writeFile(child, [
    "require('node:fs').writeFileSync(process.env.DRIVE_CHILD_MARKER, 'started');",
    `const tools=${JSON.stringify(tools)};`,
    `const reply=${reply.toString()};`,
    "require('node:readline').createInterface({input:process.stdin}).on('line', line => { const response=reply(JSON.parse(line)); if(response) console.log(JSON.stringify(response)); });",
  ].join('\n'));
  const marker = (id: string): string => join(dir, `${id}.started`);
  const googleChild = (id: string, pinned: string) => ({
    id, connector: 'google', transport: 'stdio', command: process.execPath, args: [child],
    env: { HOME: dir, LOGNAME: '', LUX_GOOGLE_MCP_ACCOUNT: pinned, PATH: process.env.PATH ?? '/usr/bin', SHELL: '', TERM: '', USER: '', DRIVE_CHILD_MARKER: marker(id) },
    account: 'local', resource: id, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'private',
  });
  await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: OWNER, endpoints: [
    googleChild('drive-other', OTHER), googleChild('drive-owner', OWNER.toUpperCase()),
  ] }), { mode: 0o600 });
  const webRoot = scratchWebRoot();
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
    const headers = { Authorization: `Bearer ${host.store.adminCredential}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': host.descriptor.authorityEpoch, 'Idempotency-Key': randomUUID() };
    const status = await fetch(host.descriptor.origin + '/api/v1/tools/status', { headers });
    const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string; reasonCode?: string }>;
    const byId = (id: string) => reports.find(report => report.id === id);
    assert.equal(byId('drive-other')?.state, 'error', 'a child pinned to another account is refused');
    assert.equal(byId('drive-other')?.reasonCode, 'identity_mismatch');
    assert.equal(existsSync(marker('drive-other')), false, 'the refused child never spawned');
    assert.equal(byId('drive-owner')?.state, 'connected', 'the owner pin connects');
    assert.equal(existsSync(marker('drive-owner')), true, 'the owner child really spawned');
  } finally {
    if (host !== undefined) await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tool call routed to a latched endpoint is refused with its closed code', async () => {
  // The latch is checked before any grant, so the refusal names the real reason instead of a lost grant.
  const registry = new McpRegistry();
  registry.register({ id: 'gmail', url: 'http://127.0.0.1:9/gmail', account: 'synthetic', resource: 'gmail' });
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), latchedCode: id => id === 'gmail' ? 'identity_mismatch' : undefined });
  const request = { endpointId: 'gmail', toolName: 'gmail_search_messages', arguments: {}, generation: 1, account: 'synthetic', resource: 'gmail' };
  assert.deepEqual(await adapter.call(request), { state: 'refused', reason: 'identity_mismatch' });
  await adapter.close();
});

test('a clean proof keeps the endpoint callable and latches nothing', async () => {
  const f = await gmailHostWith(OWNER, OWNER);
  try {
    const headers = { Authorization: `Bearer ${f.host.store.adminCredential}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': f.host.descriptor.authorityEpoch, 'Idempotency-Key': randomUUID() };
    const status = await fetch(f.host.descriptor.origin + '/api/v1/tools/status', { headers });
    const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string }>;
    assert.equal(reports[0]!.state, 'connected');
    const lines = (await readFile(join(f.dir, 'state', 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.filter(line => line.event === 'connector_latched'), []);
  } finally { await f.close(); }
});

const ISSUER = 'https://mongoose.example.test';
const RESOURCE = `${ISSUER}/mcp/knowledge`;

function mongooseFetch(accessToken: string) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/oauth-protected-resource/mcp/knowledge`) return json({ resource: RESOURCE, authorization_servers: [ISSUER] });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json({
      issuer: ISSUER, code_challenge_methods_supported: ['S256'],
      authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, registration_endpoint: `${ISSUER}/oauth/register`,
    });
    if (url === `${ISSUER}/oauth/register`) return json({ client_id: 'synthetic-client' });
    if (url === `${ISSUER}/oauth/token`) return json({ access_token: accessToken, refresh_token: 'synthetic-refresh', expires_in: 3600 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** One sign-in through the shared OAuth client, delivering the callback ourselves. */
async function signIn(accessToken: string, callback?: (url: URL) => Promise<void>, timeoutMs = 2_000) {
  const hops: MongooseSignInHop[] = [];
  let authorized: string | undefined;
  const started = runMongooseLogin({
    configDir: await mkdtemp(join(tmpdir(), 'didi-mongoose-login-')),
    reference: 'mongoose-knowledge', resourceUrl: `${ISSUER}/mcp/knowledge`, endpoint: 'knowledge',
    account: 'synthetic', ownerIdentity: OWNER, redirectPort: 0, timeoutMs, fetch: mongooseFetch(accessToken),
    onHop: hop => { hops.push(hop); },
    showAuthorizationUrl: url => { authorized = url; },
  });
  // Settle through a tuple at once, so a refusal is never an unhandled rejection while the callback runs.
  const login = started.then(
    (value): Settled<typeof value> => ({ ok: true, value }),
    (error: unknown): Settled<never> => ({ ok: false, error: error instanceof Error ? error as Error & { code?: string } : new Error('sign-in refused') }),
  );
  // The authorize URL is issued only after the listener is bound, so the callback can be delivered at once.
  for (let attempt = 0; attempt < 100 && authorized === undefined; attempt += 1) await new Promise(done => setTimeout(done, 5));
  assert.ok(authorized !== undefined, 'the sign-in issued its authorize URL');
  const url = new URL(authorized);
  if (callback !== undefined) await callback(url);
  return { login, hops, authorize: url };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error & { code?: string } };

/** Await one sign-in and return its refusal, failing the test when it unexpectedly signed in. */
async function refusalOf(login: Promise<Settled<unknown>>): Promise<Error & { code?: string }> {
  const settled = await login;
  assert.equal(settled.ok, false, `expected a refused sign-in, got ${settled.ok ? 'a stored record' : 'a refusal'}`);
  return (settled as { ok: false; error: Error & { code?: string } }).error;
}

function redirectFor(authorize: URL, params: Record<string, string>): URL {
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
  for (const [name, value] of Object.entries(params)) redirect.searchParams.set(name, value);
  redirect.searchParams.set('state', authorize.searchParams.get('state')!);
  return redirect;
}

test('the Mongoose sign-in asks for the owner email and refuses to store another account', async () => {
  const pedro = token(claimsFor(claimsFixture.token.audiences.knowledge!, OTHER));
  const { login, hops, authorize } = await signIn(pedro, async url => { await fetch(redirectFor(url, { code: 'synthetic-code' })); });
  assert.equal((await refusalOf(login)).code, 'identity-mismatch');
  assert.equal(authorize.searchParams.get('expected_email'), OWNER, 'Mongoose refuses a different account before minting a code');
  assert.equal(authorize.searchParams.get('login_hint'), OWNER, 'Google prefills the owner account');
  assert.deepEqual(hops.filter(hop => hop.outcome !== 'ok'), [{ hop: 'token', outcome: 'identity_mismatch' }]);
});

test('the owner token is stored; the callback refusal account_mismatch is its own typed outcome', async () => {
  const owner = token(claimsFor(claimsFixture.token.audiences.knowledge!, OWNER));
  const ok = await signIn(owner, async url => { await fetch(redirectFor(url, { code: 'synthetic-code' })); });
  const stored = await ok.login;
  assert.equal(stored.ok, true);
  assert.equal((stored as { ok: true; value: { accessToken: string } }).value.accessToken, owner);
  assert.equal(ok.hops.filter(hop => hop.outcome !== 'ok').length, 0);

  const refused = await signIn(owner, async url => {
    await fetch(redirectFor(url, { error: claimsFixture.refusal.error, mongoose_error: claimsFixture.refusal.mongoose_error }));
  });
  assert.equal((await refusalOf(refused.login)).code, 'account-mismatch');
  assert.deepEqual(refused.hops.filter(hop => hop.outcome !== 'ok'), [{ hop: 'callback', outcome: 'account_mismatch' }]);
});

test('a sign-in that never receives its callback ends in signin_callback outcome timeout', async () => {
  const owner = token(claimsFor(claimsFixture.token.audiences.knowledge!, OWNER));
  const { login, hops } = await signIn(owner, undefined, 120);
  assert.equal((await refusalOf(login)).code, 'timeout');
  assert.deepEqual(hops.filter(hop => hop.outcome !== 'ok'), [{ hop: 'callback', outcome: 'timeout' }]);
});
