import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONGOOSE_CONSENT_CAP_MS, MONGOOSE_LOCK_STALE_MS, MONGOOSE_OAUTH_KEYS, MONGOOSE_REFRESH_MARGIN_MS, MongooseCredentialError,
  mongooseAccessToken, mongooseCredentialPresent, readMongooseOAuth, writeMongooseOAuth, type MongooseOAuthRecord,
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
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
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
      configDir: dir, reference: 'mongoose-mcp', resourceUrl: `${as.origin}/mcp/`, account: 'local', redirectPort: 0,
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
    const verifier = exchange['code_verifier']!;
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    assert.equal(result.accessToken, 'access-token-new');
    assert.equal(result.refreshToken, 'refresh-token-new');
    assert.equal(result.expiresAt, NOW + 3_600_000);
    assert.equal(result.consentStartedAt, NOW);
    const stored = readMongooseOAuth(dir, 'mongoose-mcp');
    assert.deepEqual(stored, result);
    assert.deepEqual(Object.keys(stored!).sort(), [...MONGOOSE_OAUTH_KEYS].sort());
    assert.equal(statSync(join(dir, 'mongoose-mcp.json')).mode & 0o777, 0o600);
    // The S256 challenge that was sent to the server is the hash of the code verifier it received.
    assert.equal(challenge, expected);
    assert.deepEqual(readdirSync(dir), ['mongoose-mcp.json']);
  } finally { await as.close(); cleanup(); }
});

test('a mismatched state is refused and nothing is written', async () => {
  const { dir, cleanup } = configDir();
  const as = await authorizationServer();
  try {
    await assert.rejects(runMongooseLogin({
      configDir: dir, reference: 'mongoose-mcp', resourceUrl: `${as.origin}/mcp/`, account: 'local', redirectPort: 0,
      timeoutMs: 5_000, now: () => NOW,
      openBrowser: url => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'auth-code');
        callback.searchParams.set('state', 'not-the-state');
        void fetch(callback).then(response => response.text());
      },
    }), (error: unknown) => error instanceof MongooseLoginError && error.code === 'state-mismatch');
    assert.equal(readMongooseOAuth(dir, 'mongoose-mcp'), undefined);
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
      configDir: dir, reference: 'mongoose-mcp', resourceUrl: `http://127.0.0.1:${(address as { port: number }).port}/mcp/`, account: 'local',
      redirectPort: 0, timeoutMs: 2_000, now: () => NOW,
    }), (error: unknown) => error instanceof MongooseLoginError && error.code === 'metadata-unavailable');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); cleanup(); }
});

test('a cached access token is used until the two minute margin, then one refresh runs', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-mcp', record({ expiresAt: NOW + MONGOOSE_REFRESH_MARGIN_MS + 1 }));
    let calls = 0;
    const post = (async () => { calls += 1; return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: post }), 'access-token-old');
    assert.equal(calls, 0);
    const expiring = record({ expiresAt: NOW + MONGOOSE_REFRESH_MARGIN_MS });
    writeMongooseOAuth(dir, 'mongoose-mcp', expiring);
    assert.equal(await mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: post }), 'access-token-new');
    assert.equal(calls, 1);
  } finally { cleanup(); }
});

test('two concurrent callers make exactly one token request and the rotated refresh token replaces the old one', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-mcp', record({ expiresAt: NOW }));
    let calls = 0;
    let release = (): void => { /* replaced below */ };
    const gate = new Promise<void>(resolve => { release = resolve; });
    const post = (async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const firstCall = mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: post });
    const secondCall = mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: post });
    release();
    const [first, second] = await Promise.all([firstCall, secondCall]);
    assert.equal(calls, 1);
    assert.equal(first, 'access-token-new');
    assert.equal(second, 'access-token-new');
    const stored = readMongooseOAuth(dir, 'mongoose-mcp');
    assert.equal(stored?.refreshToken, 'refresh-token-new');
    assert.equal(stored?.accessToken, 'access-token-new');
    assert.equal(stored?.consentStartedAt, NOW);
    assert.equal(statSync(join(dir, 'mongoose-mcp.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['mongoose-mcp.json']);
  } finally { cleanup(); }
});

test('invalid_grant is one closed code and carries no token bytes', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-mcp', record({ expiresAt: NOW }));
    const post = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token reuse detected' }), { status: 400 })) as unknown as typeof fetch;
    let failure: unknown;
    try { await mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: post }); } catch (error) { failure = error; }
    assert.ok(failure instanceof MongooseCredentialError);
    assert.equal(failure.code, 'credential-refresh-failed');
    const surface = JSON.stringify({ message: failure.message, code: failure.code });
    assert.doesNotMatch(surface, /refresh-token-old|access-token-old/);
    // The record is untouched, so the next attempt can still be made after a re-consent.
    assert.equal(readMongooseOAuth(dir, 'mongoose-mcp')?.refreshToken, 'refresh-token-old');
  } finally { cleanup(); }
});

test('the 90 day consent cap is its own code, and the last days raise one owner notice', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-mcp', record({ expiresAt: NOW, consentStartedAt: NOW - MONGOOSE_CONSENT_CAP_MS }));
    let calls = 0;
    const post = (async () => { calls += 1; return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: post }), (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-consent-expired');
    assert.equal(calls, 0);

    writeMongooseOAuth(dir, 'mongoose-mcp', record({ expiresAt: NOW, consentStartedAt: NOW - MONGOOSE_CONSENT_CAP_MS + 24 * 60 * 60 * 1000 }));
    const notices: string[] = [];
    const ok = (async () => new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    await mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: ok, notify: reason => notices.push(reason) });
    await mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW + 7_200_000, fetch: ok, notify: reason => notices.push(reason) });
    assert.deepEqual(notices, ['consent-expiring']);
  } finally { cleanup(); }
});

test('only a complete v2 record counts as present, and a pasted bearer keeps its own path', () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-mcp', record());
    assert.equal(mongooseCredentialPresent(dir, 'mongoose-mcp'), true);
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
    writeMongooseOAuth(dir, 'mongoose-mcp', full);
    assert.deepEqual(Object.keys(readMongooseOAuth(dir, 'mongoose-mcp')!).sort(), [...MONGOOSE_OAUTH_KEYS].sort());
    // An added or a missing field is refused, never silently ignored: the two sides cannot drift.
    writeFileSync(join(dir, 'mongoose-mcp.json'), JSON.stringify({ ...full, pastedBearer: 'stale-field' }), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'mongoose-mcp'), undefined);
    const { refreshToken: _dropped, ...incomplete } = full;
    writeFileSync(join(dir, 'mongoose-mcp.json'), JSON.stringify(incomplete), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'mongoose-mcp'), undefined);
    writeFileSync(join(dir, 'mongoose-mcp.json'), JSON.stringify({ ...full, schemaVersion: 1, token: 'pasted' }), { mode: 0o600 });
    assert.equal(readMongooseOAuth(dir, 'mongoose-mcp'), undefined);
  } finally { cleanup(); }
});

test('a lock held by a live writer refuses, a stale one is reclaimed, and no lock survives', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-mcp', record({ expiresAt: NOW }));
    const ok = (async () => new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    writeFileSync(join(dir, '.mongoose-mcp.json.lock'), '', { mode: 0o600 });
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW, fetch: ok }), (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-busy');
    // The holder crashed a minute ago: the lock is stale and the next caller takes it.
    await mongooseAccessToken(dir, 'mongoose-mcp', { now: () => NOW + MONGOOSE_LOCK_STALE_MS + 1, fetch: ok });
    assert.equal(readMongooseOAuth(dir, 'mongoose-mcp')?.accessToken, 'access-token-new');
    assert.equal(readdirSync(dir).includes('.mongoose-mcp.json.lock'), false);
  } finally { cleanup(); }
});
