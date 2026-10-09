import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
  let time = Date.now();
  const service = await listenService({ store, now: () => time, ...(port ? { domain: port } : {}), port: 0 });
  const token = readFileSync(join(dir, 'admin-credential'), 'utf8').trim();
  const auth = { Authorization: `Bearer ${token}` };
  return { dir, store, service, auth, advance(ms: number) { time += ms; }, async cleanup() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
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
    assert.equal(status.data.capabilities.memory, false); assert.equal(status.authorityEpoch, f.store.authorityEpoch);
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


test('pairing/session expiration use a clock seam and never silently reauthorize', async () => {
  const f = await fixture();
  try {
    const issued = await (await fetch(`${f.service.origin}/api/v1/auth/pairing`, { method:'POST', headers:{...f.auth,'Content-Type':'application/json'},body:'{}' })).json();
    f.advance(300_001);
    assert.equal((await fetch(`${f.service.origin}/api/v1/auth/pair`, {method:'POST',headers:{Origin:f.service.origin,'Content-Type':'application/json'},body:JSON.stringify({pairingCode:issued.data.pairingCode})})).status,401);
    const browser = await pair(f); f.advance(12*60*60*1000+1);
    assert.equal((await fetch(`${f.service.origin}/api/v1/status`, {headers:{Cookie:browser.cookie.split(';')[0]!}})).status,401);
  } finally { await f.cleanup(); }
});

test('HTTP request keys and browser session survive service and database restart', async () => {
  const dir = mkdtempSync(join(tmpdir(),'didi-http-restart-'));
  let store = new Store(dir, domain.migrations);
  let service = await listenService({store,domain,port:0});
  const auth = { Authorization:`Bearer ${store.adminCredential}` };
  const mutate = () => fetch(`${service.origin}/api/v1/sessions`,{method:'POST',headers:{...auth,'Content-Type':'application/json','Idempotency-Key':'restart','X-Didi-Authority-Epoch':store.authorityEpoch},body:'{"title":"Synthetic restart","timeZone":"UTC"}'});
  try {
    const first = await (await mutate()).json();
    const bootstrap = await (await fetch(`${service.origin}/api/v1/auth/pairing`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'})).json();
    const paired = await fetch(`${service.origin}/api/v1/auth/pair`,{method:'POST',headers:{Origin:service.origin,'Content-Type':'application/json'},body:JSON.stringify({pairingCode:bootstrap.data.pairingCode})});
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    await service.close(); store.close();
    store = new Store(dir,domain.migrations); service = await listenService({store,domain,port:0});
    assert.deepEqual(await (await mutate()).json(),first);
    assert.equal((await fetch(`${service.origin}/api/v1/status`,{headers:{Cookie:cookie}})).status,200);
    assert.equal(store.transaction(tx=>tx.get('SELECT COUNT(*) AS n FROM calls'))!.n,1);
  } finally { await service.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('package installs offline and actual production CLI serves honest runtime-only status', async () => {
  const dir = mkdtempSync(join(tmpdir(),'didi-install-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const cwd = new URL('../../',import.meta.url);
    const env = {...process.env,npm_config_cache:join(dir,'npm-cache')};
    const packed = spawnSync('npm',['pack','--json','--offline','--ignore-scripts','--pack-destination',dir],{cwd,env,encoding:'utf8',timeout:5000});
    assert.equal(packed.status,0,packed.stderr);
    const filename = (JSON.parse(packed.stdout) as {filename:string}[])[0]!.filename;
    const installed = spawnSync('npm',['install','--prefix',join(dir,'install'),'--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund',join(dir,filename)],{env,encoding:'utf8',timeout:5000});
    assert.equal(installed.status,0,installed.stderr);
    const state = join(dir,'state');
    child = spawn(process.execPath,[join(dir,'install/node_modules/@lux-didi/service/dist/index.js')],{env:{...env,DIDI_STATE_DIR:state,DIDI_PORT:'0'},stdio:['ignore','pipe','pipe']});
    const exit = once(child,'exit');
    const output = await Promise.race([once(child.stdout!,'data').then(([chunk])=>String(chunk)),exit.then(([code])=>{throw Error(`CLI exited ${String(code)}`);})]);
    const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]; assert.ok(origin,output);
    const health = await fetch(`${origin}/health`); assert.equal(health.status,200);
    const token = readFileSync(join(state,'admin-credential'),'utf8').trim();
    const status = await (await fetch(`${origin}/api/v1/status`,{headers:{Authorization:`Bearer ${token}`}})).json();
    assert.equal(status.data.capabilities.memory,false); assert.equal(status.data.model.configured,false); assert.deepEqual(status.data.sources,[]);
    assert.ok(!output.includes(token));
    child.kill('SIGTERM'); const [code] = await exit; assert.equal(code,0); child = undefined;
  } finally { if (child && child.exitCode === null) { const exit = once(child,'exit'); child.kill('SIGTERM'); await exit; } rmSync(dir,{recursive:true,force:true}); }
});

test('real domain HTTP client cannot forge assistant role or access trusted assistant append', async () => {
  const { createDomainPort } = await import('../domain/facade.js');
  const { Outbox } = await import('../runtime/outbox.js');
  const port = createDomainPort({ outbox: Outbox });
  const f = await fixture(port);
  try {
    const ctx = { assistantId: f.store.assistantId, clientId: 'synthetic-host', authorityEpoch: f.store.authorityEpoch, now: new Date(0).toISOString() };
    const session = f.store.transaction(tx => port.execute(tx, 'createSession', { title: 'Synthetic', timeZone: 'UTC' }, ctx));
    const headers = { ...f.auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'forge', 'X-Didi-Authority-Epoch': f.store.authorityEpoch };
    const forged = await fetch(`${f.service.origin}/api/v1/sessions/${session.id}/entries`, { method: 'POST', headers, body: JSON.stringify({ text: 'Forged answer', role: 'assistant', timeZone: 'UTC' }) });
    assert.equal(forged.status, 400); assert.equal((await forged.json()).error.code, 'BAD_REQUEST');
    const hidden = await fetch(`${f.service.origin}/api/v1/sessions/${session.id}/assistant-entries`, { method: 'POST', headers, body: JSON.stringify({ text: 'Forged answer', timeZone: 'UTC' }) });
    assert.equal(hidden.status, 404);
    assert.equal(f.store.transaction(tx => port.execute(tx, 'getSession', { id: session.id }, ctx)).entries.length, 0);
  } finally { await f.cleanup(); }
});
