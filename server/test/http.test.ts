import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';
import type { DomainPort } from '../contracts/domain.js';
import { ServiceError } from '../contracts/errors.js';
const migrations = [{ owner: 'synthetic', version: 1, statements: ['CREATE TABLE calls(id INTEGER PRIMARY KEY, title TEXT)'] }];
const domain = {
  migrations,
  execute(tx, op, input) {
    if (op === 'createSession') {
      const title = (input as { title: string }).title;
      tx.run('INSERT INTO calls(title) VALUES (?)', [title]);
      if (title === 'fail') throw new ServiceError('CONFLICT', 'Synthetic conflict', 409);
      return { id: '00000000-0000-4000-8000-000000000001', title, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, timeZone: 'UTC', revision: 1 };
    }
    if (op === 'listSessions') return { items: [], nextCursor: null };
    throw new ServiceError('NOT_FOUND', 'Synthetic not found', 404);
  }
} as DomainPort;
async function fixture(port?: DomainPort) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-http-'));
  const store = new Store(dir, port?.migrations);
  const service = await listenService({ store, ...(port ? { domain: port } : {}), port: 0 });
  const token = readFileSync(join(dir, 'admin-credential'), 'utf8').trim();
  const auth = { Authorization: `Bearer ${token}` };
  return { dir, store, service, auth, async cleanup() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  const bootstrap = await fetch(`${f.service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bootstrap.status, 200);
  const code = (await bootstrap.json()).data.pairingCode as string;
  const response = await fetch(`${f.service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: f.service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode: code }) });
  assert.equal(response.status, 200);
  return { code, cookie: response.headers.get('set-cookie')!, csrf: (await response.json()).data.csrfToken as string };
}
function raw(origin: string, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => { const req = request(`${origin}${path}`, { headers }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end(); });
}

test('actual loopback health, status authentication and absent domain capabilities', async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.server.address() && typeof f.service.server.address() === 'object' ? (f.service.server.address() as { address: string }).address : '', '127.0.0.1');
    const health = await fetch(`${f.service.origin}/health`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok', version: '0.1.0', serviceMode: 'loopback' });
    assert.equal((await fetch(`${f.service.origin}/api/v1/status`)).status, 401);
    const status = await (await fetch(`${f.service.origin}/api/v1/status`, { headers: f.auth })).json();
    assert.equal(status.data.capabilities.domain, false); assert.equal(status.authorityEpoch, f.store.authorityEpoch);
    const absent = await fetch(`${f.service.origin}/api/v1/sessions`, { headers: f.auth }); assert.equal(absent.status, 503); assert.equal((await absent.json()).error.code, 'DOMAIN_NOT_CONFIGURED');
    const chat = await fetch(`${f.service.origin}/api/v1/chat`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'model', 'X-Didi-Authority-Epoch': f.store.authorityEpoch }, body: '{"sessionId":"00000000-0000-4000-8000-000000000001","text":"Synthetic","timeZone":"UTC"}' });
    assert.equal(chat.status, 503); assert.equal((await chat.json()).error.code, 'MODEL_NOT_CONFIGURED');
  } finally { await f.cleanup(); }
});

test('exact Host/Origin, no CORS, unknown routes/methods/queries and credentials in URL denied', async () => {
  const f = await fixture();
  try {
    for (const host of ['evil.test', 'localhost', '127.0.0.1', '127.0.0.1:1', `${new URL(f.service.origin).host}.evil.test`]) assert.equal(await raw(f.service.origin, '/health', { Host: host }), 403);
    for (const origin of ['http://evil.test', 'null', `${f.service.origin}.evil.test`]) assert.equal((await fetch(`${f.service.origin}/health`, { headers: { Origin: origin } })).status, 403);
    assert.equal((await fetch(`${f.service.origin}/health?token=synthetic`)).status, 400);
    assert.equal((await fetch(`${f.service.origin}/api/v1/shell`, { method: 'POST', headers: f.auth })).status, 404);
    assert.equal((await fetch(`${f.service.origin}/api/v1/status`, { method: 'DELETE', headers: f.auth })).status, 405);
    assert.equal((await fetch(`${f.service.origin}/health`, { headers: { Origin: f.service.origin } })).headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${f.service.origin}/api/v1/sessions?accountId=evil`, { headers: f.auth })).status, 400);
  } finally { await f.cleanup(); }
});

test('one-time pairing, HttpOnly Strict cookies, CSRF denial, session reload and logout', async () => {
  const f = await fixture(domain);
  try {
    assert.equal((await fetch(`${f.service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const browser = await pair(f);
    assert.match(browser.cookie, /HttpOnly/i); assert.match(browser.cookie, /SameSite=Strict/i);
    assert.equal((await fetch(`${f.service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: f.service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode: browser.code }) })).status, 401);
    const headers = { Cookie: browser.cookie.split(';')[0]!, 'Content-Type': 'application/json', 'Idempotency-Key': 'browser-key', 'X-Didi-Authority-Epoch': f.store.authorityEpoch };
    for (const extra of [{}, { Origin: f.service.origin }, { Origin: f.service.origin, 'X-Didi-CSRF': 'bad' }]) {
      assert.equal((await fetch(`${f.service.origin}/api/v1/sessions`, { method: 'POST', headers: { ...headers, ...extra }, body: '{"title":"Synthetic","timeZone":"UTC"}' })).status, 403);
    }
    const session = await (await fetch(`${f.service.origin}/api/v1/auth/session`, { headers: { Cookie: headers.Cookie } })).json(); assert.equal(session.data.csrfToken, browser.csrf);
    assert.equal((await fetch(`${f.service.origin}/api/v1/sessions`, { method: 'POST', headers: { ...headers, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf }, body: '{"title":"Synthetic","timeZone":"UTC"}' })).status, 200);
    assert.equal((await fetch(`${f.service.origin}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: headers.Cookie, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${f.service.origin}/api/v1/status`, { headers: { Cookie: headers.Cookie } })).status, 401);
  } finally { await f.cleanup(); }
});

test('canonical duplicate request replay, conflicting keys, rollback and stale epoch', async () => {
  const f = await fixture(domain);
  try {
    const mutate = (body: string, key = 'one', epoch = f.store.authorityEpoch) => fetch(`${f.service.origin}/api/v1/sessions`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Didi-Authority-Epoch': epoch }, body });
    const first = await mutate('{"title":"Synthetic","timeZone":"UTC"}'); assert.equal(first.status, 200); const result = await first.json();
    const second = await mutate('{"timeZone":"UTC","title":"Synthetic"}'); assert.equal(second.status, 200); assert.deepEqual(await second.json(), result);
    assert.equal((await mutate('{"title":"Different","timeZone":"UTC"}')).status, 409);
    assert.equal((await mutate('{"title":"fail","timeZone":"UTC"}', 'rollback')).status, 409);
    assert.equal((await mutate('{"title":"Recovered","timeZone":"UTC"}', 'rollback')).status, 200);
    assert.equal((await mutate('{"title":"Synthetic","timeZone":"UTC"}', 'stale', 'other')).status, 409);
    assert.equal(f.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM calls'))!.n, 2);
  } finally { await f.cleanup(); }
});

test('body boundary refuses unknown fields, identities, wrong types, malformed JSON and oversized payloads', async () => {
  const f = await fixture(domain);
  try {
    const headers = { ...f.auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'bad', 'X-Didi-Authority-Epoch': f.store.authorityEpoch };
    for (const body of ['{', 'null', '[]', '{"title":1,"timeZone":"UTC"}', '{"title":"x","timeZone":"Not/AZone"}', '{"title":"x","timeZone":"UTC","assistantId":"evil"}']) assert.equal((await fetch(`${f.service.origin}/api/v1/sessions`, { method: 'POST', headers, body })).status, 400);
    assert.equal((await fetch(`${f.service.origin}/api/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ title: 'x'.repeat(70_000), timeZone: 'UTC' }) })).status, 413);
    assert.equal((await fetch(`${f.service.origin}/api/v1/sessions`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'text/plain' }, body: '{}' })).status, 400);
    assert.equal(f.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM calls'))!.n, 0);
  } finally { await f.cleanup(); }
});
