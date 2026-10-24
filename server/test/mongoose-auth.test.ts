import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONGOOSE_CONSENT_CAP_MS, MONGOOSE_LOCK_STALE_MS, MONGOOSE_OAUTH_KEYS, MONGOOSE_REFRESH_MARGIN_MS, MongooseCredentialError,
  mongooseAccessToken, mongooseCredentialPresent, mongooseCredentialRefusal, readMongooseOAuth, writeMongooseOAuth, type MongooseOAuthRecord,
} from '../host/mongoose-auth.js';
import { MongooseLoginError, runMongooseLogin } from '../host/mongoose-login.js';

const NOW = 1_760_000_000_000;

function configDir(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'didi-mongoose-auth-'));
  const dir = join(root, 'provider-config');
  mkdirSync(dir, { mode: 0o700 });
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function record(overrides: Partial<MongooseOAuthRecord> = {}): MongooseOAuthRecord {
  return {
    schemaVersion: 2, base: 'https://mongoose.test', clientId: 'mcp_client', redirectPort: 8768, account: 'local',
    endpoint: 'knowledge', audience: 'mongoose:knowledge',
    accessToken: 'access-token-old', refreshToken: 'refresh-token-old',
    expiresAt: NOW + 3_600_000, consentStartedAt: NOW, ...overrides,
  };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

interface TokenCall { form: Record<string, string> }

/** A fake authorization server on the loopback: well-knowns, registration and the token endpoint. */
async function authorizationServer() {
  const tokenCalls: TokenCall[] = [];
  const redirects: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url ?? '/', origin);
    // RFC 9728 path form: each endpoint publishes its own protected-resource document.
    const protectedResource = url.pathname.match(/^\/\.well-known\/oauth-protected-resource(\/mcp\/[a-z]+)$/);
    if (request.method === 'GET' && protectedResource) {
      const name = protectedResource[1]!.slice('/mcp/'.length);
      return json(response, 200, { resource: `mongoose:${name}`, resource_url: `${origin}/mcp/${name}`, authorization_servers: [origin] });
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(response, 200, { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register` });
    }
    if (request.method === 'POST' && url.pathname === '/oauth/register') { redirects.push(await body(request)); return json(response, 201, { client_id: 'mcp_registered' }); }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const form = Object.fromEntries(new URLSearchParams(await body(request)));
      tokenCalls.push({ form });
      return json(response, 200, { access_token: 'access-token-new', refresh_token: 'refresh-token-new', token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, origin: `http://127.0.0.1:${address.port}`, tokenCalls, redirects, close: () => new Promise<void>(resolve => { server.close(() => resolve()); }) };
}

test('login registers one client with the exact body, proves PKCE S256 and writes one private record', async () => {
  const { dir, cleanup } = configDir();
  const as = await authorizationServer();
  try {
    let challenge: string | null = null;
    const result = await runMongooseLogin({
      configDir: dir, reference: 'mongoose-knowledge', resourceUrl: `${as.origin}/mcp/knowledge`, endpoint: 'knowledge', account: 'local', redirectPort: 0,
      timeoutMs: 5_000, now: () => NOW,
      openBrowser: url => {
        const authorize = new URL(url);
        challenge = authorize.searchParams.get('code_challenge');
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        // The owner consents: the server redirects to the exact registered loopback callback.
        const callback = new URL(authorize.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'auth-code');
        callback.searchParams.set('state', authorize.searchParams.get('state')!);
        void fetch(callback).then(response => response.text());
      },
    });
    assert.equal(as.redirects.length, 1);
    assert.deepEqual(JSON.parse(as.redirects[0]!), {
      client_name: 'lux-didi',
      redirect_uris: [`http://127.0.0.1:${result.redirectPort}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    });
    assert.equal(as.tokenCalls.length, 1);
    const exchange = as.tokenCalls[0]!.form;
    assert.equal(exchange['grant_type'], 'authorization_code');
    assert.equal(exchange['code'], 'auth-code');
    assert.equal(exchange['client_id'], 'mcp_registered');
    // RFC 8707: the token is bound to this endpoint's audience, never the whole server.
    assert.equal(exchange['resource'], 'mongoose:knowledge');
    const verifier = exchange['code_verifier']!;
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    assert.equal(result.accessToken, 'access-token-new');
    assert.equal(result.refreshToken, 'refresh-token-new');
    assert.equal(result.expiresAt, NOW + 3_600_000);
    assert.equal(result.consentStartedAt, NOW);
    const stored = readMongooseOAuth(dir, 'mongoose-knowledge');
    assert.deepEqual(stored, result);
    assert.equal(stored?.endpoint, 'knowledge');
    assert.equal(stored?.audience, 'mongoose:knowledge');
    assert.deepEqual(Object.keys(stored!).sort(), [...MONGOOSE_OAUTH_KEYS].sort());
    assert.equal(statSync(join(dir, 'mongoose-knowledge.json')).mode & 0o777, 0o600);
    // The S256 challenge that was sent to the server is the hash of the code verifier it received.
    assert.equal(challenge, expected);
    assert.deepEqual(readdirSync(dir), ['mongoose-knowledge.json']);
  } finally { await as.close(); cleanup(); }
});

test('a mismatched state is refused and nothing is written', async () => {
  const { dir, cleanup } = configDir();
  const as = await authorizationServer();
  try {
    await assert.rejects(runMongooseLogin({
      configDir: dir, reference: 'mongoose-knowledge', resourceUrl: `${as.origin}/mcp/knowledge`, endpoint: 'knowledge', account: 'local', redirectPort: 0,
      timeoutMs: 5_000, now: () => NOW,
      openBrowser: url => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'auth-code');
        callback.searchParams.set('state', 'not-the-state');
        void fetch(callback).then(response => response.text());
      },
    }), (error: unknown) => error instanceof MongooseLoginError && error.code === 'state-mismatch');
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined);
    assert.equal(as.tokenCalls.length, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { await as.close(); cleanup(); }
});

test('missing OAuth metadata is one closed code, with no hang', async () => {
  const { dir, cleanup } = configDir();
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  try {
    await assert.rejects(runMongooseLogin({
      configDir: dir, reference: 'mongoose-knowledge', resourceUrl: `http://127.0.0.1:${(address as { port: number }).port}/mcp/knowledge`, endpoint: 'knowledge', account: 'local',
      redirectPort: 0, timeoutMs: 2_000, now: () => NOW,
    }), (error: unknown) => error instanceof MongooseLoginError && error.code === 'metadata-unavailable');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); cleanup(); }
});

test('a cached access token is used until the two minute margin, then one refresh runs', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW + MONGOOSE_REFRESH_MARGIN_MS + 1 }));
    let calls = 0;
    const post = (async () => { calls += 1; return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: post }), 'access-token-old');
    assert.equal(calls, 0);
    const expiring = record({ expiresAt: NOW + MONGOOSE_REFRESH_MARGIN_MS });
    writeMongooseOAuth(dir, 'mongoose-knowledge', expiring);
    assert.equal(await mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: post }), 'access-token-new');
    assert.equal(calls, 1);
  } finally { cleanup(); }
});

test('two concurrent callers make exactly one token request and the rotated refresh token replaces the old one', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW }));
    let calls = 0;
    let release = (): void => { /* replaced below */ };
    const gate = new Promise<void>(resolve => { release = resolve; });
    const post = (async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const firstCall = mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: post });
    const secondCall = mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: post });
    release();
    const [first, second] = await Promise.all([firstCall, secondCall]);
    assert.equal(calls, 1);
    assert.equal(first, 'access-token-new');
    assert.equal(second, 'access-token-new');
    const stored = readMongooseOAuth(dir, 'mongoose-knowledge');
    assert.equal(stored?.refreshToken, 'refresh-token-new');
    assert.equal(stored?.accessToken, 'access-token-new');
    assert.equal(stored?.consentStartedAt, NOW);
    assert.equal(statSync(join(dir, 'mongoose-knowledge.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['mongoose-knowledge.json']);
  } finally { cleanup(); }
});

test('invalid_grant is one closed code and carries no token bytes', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW }));
    const post = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token reuse detected' }), { status: 400 })) as unknown as typeof fetch;
    let failure: unknown;
    try { await mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: post }); } catch (error) { failure = error; }
    assert.ok(failure instanceof MongooseCredentialError);
    assert.equal(failure.code, 'credential-refresh-failed');
    const surface = JSON.stringify({ message: failure.message, code: failure.code });
    assert.doesNotMatch(surface, /refresh-token-old|access-token-old/);
    // The record is untouched, so the next attempt can still be made after a re-consent.
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge')?.refreshToken, 'refresh-token-old');
  } finally { cleanup(); }
});

test('the 90 day consent cap is its own code, and the last days raise one owner notice', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW, consentStartedAt: NOW - MONGOOSE_CONSENT_CAP_MS }));
    let calls = 0;
    const post = (async () => { calls += 1; return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: post }), (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-consent-expired');
    assert.equal(calls, 0);

    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW, consentStartedAt: NOW - MONGOOSE_CONSENT_CAP_MS + 24 * 60 * 60 * 1000 }));
    const notices: string[] = [];
    const ok = (async () => new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    await mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: ok, notify: reason => notices.push(reason) });
    await mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW + 7_200_000, fetch: ok, notify: reason => notices.push(reason) });
    assert.deepEqual(notices, ['consent-expiring']);
  } finally { cleanup(); }
});

test('only a complete v2 record counts as present, and a pasted bearer keeps its own path', () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record());
    assert.equal(mongooseCredentialPresent(dir, 'mongoose-knowledge'), true);
    assert.equal(mongooseCredentialPresent(dir, 'absent'), false);
    writeFileSync(join(dir, 'pasted.json'), JSON.stringify({ schemaVersion: 1, token: 'pasted-bearer' }), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'pasted'), undefined);
    assert.equal(mongooseCredentialPresent(dir, 'pasted'), false);
    assert.equal(readFileSync(join(dir, 'pasted.json'), 'utf8'), JSON.stringify({ schemaVersion: 1, token: 'pasted-bearer' }));
  } finally { cleanup(); }
});

test('the login writer and the runtime reader agree on one exact record key set', () => {
  const { dir, cleanup } = configDir();
  try {
    const full = record();
    writeMongooseOAuth(dir, 'mongoose-knowledge', full);
    assert.deepEqual(Object.keys(readMongooseOAuth(dir, 'mongoose-knowledge')!).sort(), [...MONGOOSE_OAUTH_KEYS].sort());
    // An added or a missing field is refused, never silently ignored: the two sides cannot drift.
    writeFileSync(join(dir, 'mongoose-knowledge.json'), JSON.stringify({ ...full, pastedBearer: 'stale-field' }), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined);
    const { refreshToken: _dropped, ...incomplete } = full;
    writeFileSync(join(dir, 'mongoose-knowledge.json'), JSON.stringify(incomplete), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined);
    writeFileSync(join(dir, 'mongoose-knowledge.json'), JSON.stringify({ ...full, schemaVersion: 1, token: 'pasted' }), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined);
  } finally { cleanup(); }
});

test('a lock held by a live writer refuses, a stale one is reclaimed, and no lock survives', async () => {
  const { dir, cleanup } = configDir();
  try {
    const ok = (async () => new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    const lock = join(dir, '.mongoose-knowledge.json.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    // The record's own clock starts now, so only the lock's age is under test.
    const written = Math.round(statSync(lock).mtimeMs);
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: written, consentStartedAt: written }));
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => written, fetch: ok }), (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-busy');
    // The holder crashed a minute ago: the lock is stale and the next caller takes it.
    await mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => written + MONGOOSE_LOCK_STALE_MS + 1, fetch: ok });
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge')?.accessToken, 'access-token-new');
    assert.equal(readdirSync(dir).includes('.mongoose-knowledge.json.lock'), false);
  } finally { cleanup(); }
});

test('1022: a refresh that cannot reach the network is unavailable, not a refusal that needs a sign-in', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW }));
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: offline }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-unavailable');
  } finally { cleanup(); }
});

test('1022: a 4xx answer to the refresh keeps the refused code, so only a new sign-in fixes it', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW }));
    const refused = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', { now: () => NOW, fetch: refused }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-failed');
  } finally { cleanup(); }
});

test('each endpoint signs in against its own RFC 9728 document and binds its own audience', async () => {
  const { dir, cleanup } = configDir();
  const as = await authorizationServer();
  try {
    const audiences: string[] = [];
    for (const endpoint of ['knowledge', 'data', 'crm'] as const) {
      const result = await runMongooseLogin({
        configDir: dir, reference: `mongoose-${endpoint}`, resourceUrl: `${as.origin}/mcp/${endpoint}`, endpoint, account: 'local', redirectPort: 0,
        timeoutMs: 5_000, now: () => NOW,
        openBrowser: url => {
          const authorize = new URL(url);
          const callback = new URL(authorize.searchParams.get('redirect_uri')!);
          callback.searchParams.set('code', `code-${endpoint}`);
          callback.searchParams.set('state', authorize.searchParams.get('state')!);
          void fetch(callback).then(response => response.text());
        },
      });
      assert.equal(result.endpoint, endpoint);
      assert.equal(result.audience, `mongoose:${endpoint}`);
      audiences.push(as.tokenCalls[as.tokenCalls.length - 1]!.form['resource']!);
    }
    assert.deepEqual(audiences, ['mongoose:knowledge', 'mongoose:data', 'mongoose:crm']);
    assert.deepEqual(readdirSync(dir).sort(), ['mongoose-crm.json', 'mongoose-data.json', 'mongoose-knowledge.json']);
  } finally { await as.close(); cleanup(); }
});

test('a protected-resource document that names another audience is refused, and the refresh keeps the audience', async () => {
  const { dir, cleanup } = configDir();
  const server = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp/data') return json(response, 200, { resource: 'mongoose:knowledge', authorization_servers: [origin] });
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  try {
    assert(address && typeof address !== 'string');
    await assert.rejects(runMongooseLogin({
      configDir: dir, reference: 'mongoose-data', resourceUrl: `http://127.0.0.1:${(address as { port: number }).port}/mcp/data`, endpoint: 'data', account: 'local', redirectPort: 0,
      timeoutMs: 5_000, now: () => NOW, openBrowser: () => {},
    }), (error: unknown) => error instanceof MongooseLoginError && error.code === 'metadata-unavailable');
    writeMongooseOAuth(dir, 'mongoose-data', record({ endpoint: 'data', audience: 'mongoose:data', expiresAt: NOW }));
    let form: Record<string, string> = {};
    const as = (async (input: string | URL | Request, init?: RequestInit) => {
      form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const token = await mongooseAccessToken(dir, 'mongoose-data', { now: () => NOW, fetch: as });
    assert.equal(token, 'access-token-new');
    assert.equal(form['resource'], 'mongoose:data');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); cleanup(); }
});

test('a 401 with resource_metadata is one closed credential reason and names its endpoint', () => {
  assert.equal(mongooseCredentialRefusal(401, 'https://mongoose.dev.peat-cloud.com/.well-known/oauth-protected-resource/mcp/knowledge'), 'credential-unavailable');
  assert.equal(mongooseCredentialRefusal(403, undefined), undefined);
  assert.equal(mongooseCredentialRefusal(401, undefined), undefined);
  assert.equal(mongooseCredentialRefusal(200, 'https://example.invalid/x'), undefined);
});
