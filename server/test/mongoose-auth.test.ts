import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONGOOSE_CONSENT_CAP_MS, MONGOOSE_LOCK_STALE_MS, MONGOOSE_OAUTH_KEYS, MONGOOSE_REFRESH_MARGIN_MS, MongooseCredentialError,
  mongooseAccessToken, mongooseBinding, mongooseCredentialPresent, mongooseCredentialRefusal, readMongooseOAuth, writeMongooseOAuth, type MongooseOAuthRecord,
} from '../host/mongoose-auth.js';

const NOW = 1_760_000_000_000;
const BINDING = mongooseBinding('https://mongoose.test/mcp/knowledge', 'knowledge');

function configDir(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'didi-mongoose-auth-'));
  const dir = join(root, 'provider-config');
  mkdirSync(dir, { mode: 0o700 });
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function record(overrides: Partial<MongooseOAuthRecord> = {}): MongooseOAuthRecord {
  return {
    schemaVersion: 3, endpoint: 'knowledge', resource: 'https://mongoose.test/mcp/knowledge', issuer: 'https://mongoose.test',
    tokenEndpoint: 'https://mongoose.test/oauth/token', clientId: 'mcp_client', redirectPort: 8768, account: 'local',
    accessToken: 'access-token-old', refreshToken: 'refresh-token-old',
    expiresAt: NOW + 3_600_000, consentStartedAt: NOW, ...overrides,
  };
}

test('a cached access token is used until the two minute margin, then one refresh runs', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW + MONGOOSE_REFRESH_MARGIN_MS + 1 }));
    let calls = 0;
    const post = (async () => { calls += 1; return new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: post }), 'access-token-old');
    assert.equal(calls, 0);
    const expiring = record({ expiresAt: NOW + MONGOOSE_REFRESH_MARGIN_MS });
    writeMongooseOAuth(dir, 'mongoose-knowledge', expiring);
    assert.equal(await mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: post }), 'access-token-new');
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
    const firstCall = mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: post });
    const secondCall = mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: post });
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
    try { await mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: post }); } catch (error) { failure = error; }
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
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: post }), (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-consent-expired');
    assert.equal(calls, 0);

    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW, consentStartedAt: NOW - MONGOOSE_CONSENT_CAP_MS + 24 * 60 * 60 * 1000 }));
    const notices: string[] = [];
    const ok = (async () => new Response(JSON.stringify({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    await mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: ok, notify: reason => notices.push(reason) });
    await mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW + 7_200_000, fetch: ok, notify: reason => notices.push(reason) });
    assert.deepEqual(notices, ['consent-expiring']);
  } finally { cleanup(); }
});

test('only a complete v3 record counts as present, and a pasted bearer keeps its own path', () => {
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

test('a record is read only with a canonical resource for its endpoint and a token endpoint on its issuer; v2 is gone', () => {
  const { dir, cleanup } = configDir();
  try {
    const put = (value: unknown) => writeFileSync(join(dir, 'mongoose-knowledge.json'), JSON.stringify(value), { mode: 0o600 });
    const full = record();
    put(full);
    assert.notEqual(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined);
    for (const change of [
      { resource: 'mongoose:knowledge' }, { resource: 'https://mongoose.test/mcp/data' }, { resource: 'https://mongoose.test/mcp/knowledge/' },
      { resource: 'http://mongoose.test/mcp/knowledge', issuer: 'http://mongoose.test' }, { issuer: 'https://other.test' },
      { tokenEndpoint: 'https://other.test/oauth/token' }, { tokenEndpoint: 'http://mongoose.test/oauth/token' },
    ]) {
      put({ ...full, ...change });
      assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined, JSON.stringify(change));
    }
    // The release-1023b record keyed on an audience string is not read: no compatibility path.
    put({ schemaVersion: 2, base: 'https://mongoose.test', clientId: 'mcp_client', redirectPort: 8768, account: 'local', endpoint: 'knowledge', audience: 'mongoose:knowledge',
      accessToken: 'access-token-old', refreshToken: 'refresh-token-old', expiresAt: NOW, consentStartedAt: NOW });
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge'), undefined);
    assert.equal(mongooseCredentialPresent(dir, 'mongoose-knowledge'), false);
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
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => written, fetch: ok }), (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-busy');
    // The holder crashed a minute ago: the lock is stale and the next caller takes it.
    await mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => written + MONGOOSE_LOCK_STALE_MS + 1, fetch: ok });
    assert.equal(readMongooseOAuth(dir, 'mongoose-knowledge')?.accessToken, 'access-token-new');
    assert.equal(readdirSync(dir).includes('.mongoose-knowledge.json.lock'), false);
  } finally { cleanup(); }
});

test('1022: a refresh that cannot reach the network is unavailable, not a refusal that needs a sign-in', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW }));
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: offline }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-unavailable');
  } finally { cleanup(); }
});

test('1022: a 4xx answer to the refresh keeps the refused code, so only a new sign-in fixes it', async () => {
  const { dir, cleanup } = configDir();
  try {
    writeMongooseOAuth(dir, 'mongoose-knowledge', record({ expiresAt: NOW }));
    const refused = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(mongooseAccessToken(dir, 'mongoose-knowledge', BINDING, { now: () => NOW, fetch: refused }),
      (error: unknown) => error instanceof MongooseCredentialError && error.code === 'credential-refresh-failed');
  } finally { cleanup(); }
});

test('a 401 with resource_metadata is one closed credential reason and names its endpoint', () => {
  assert.equal(mongooseCredentialRefusal(401, 'https://mongoose.dev.peat-cloud.com/.well-known/oauth-protected-resource/mcp/knowledge'), 'credential-unavailable');
  assert.equal(mongooseCredentialRefusal(403, undefined), undefined);
  assert.equal(mongooseCredentialRefusal(401, undefined), undefined);
  assert.equal(mongooseCredentialRefusal(200, 'https://example.invalid/x'), undefined);
});
