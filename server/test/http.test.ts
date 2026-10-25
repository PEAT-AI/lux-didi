import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';
import { createMongooseSignIn } from '../host/runtime.js';
import { MongooseLoginError, runMongooseLogin } from '../host/mongoose-login.js';
import { safeEvent } from '../host/log.js';
import { saveLiveSelection } from '../config/live.js';
import type { DomainPort } from '../contracts/domain.js';
import { ServiceError } from '../contracts/errors.js';
const migrations = [{ owner: 'synthetic', version: 1, statements: ['CREATE TABLE calls(id INTEGER PRIMARY KEY, title TEXT)'] }];
const domain = {
  migrations,
  // These transport-fixture tests never exercise provenance. Fail loudly if
  // label behavior is accidentally routed here; actual SQLite proves labels.
  getRoutingLabel() { throw new Error('Unused synthetic getRoutingLabel'); },
  getRoutingLabelHistory() { throw new Error('Unused synthetic getRoutingLabelHistory'); },
  correctRoutingLabel() { throw new Error('Unused synthetic correctRoutingLabel'); },
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
async function fixture(port?: DomainPort, toolsStatus?: Parameters<typeof listenService>[0]['toolsStatus'], mongooseSignIn?: Parameters<typeof listenService>[0]['mongooseSignIn'], live?: Parameters<typeof listenService>[0]['live'], extra: Partial<Parameters<typeof listenService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-http-'));
  const store = new Store(dir, port?.migrations);
  let time = Date.now();
  const service = await listenService({ store, now: () => time, ...(port ? { domain: port } : {}), port: 0, ...(toolsStatus ? { toolsStatus } : {}), ...(mongooseSignIn ? { mongooseSignIn } : {}), ...(live ? { live } : {}), ...extra });
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

// Per-test timeout: the two npm spawnSync caps below (120s + 180s) must fit inside it, so override the suite default (15s in `npm test`).
test('package installs offline and actual production CLI serves honest runtime-only status', { timeout: 360000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(),'didi-install-'));
  let child: ReturnType<typeof spawn> | undefined;
  let cliStage = 'CLI spawn'; let cliStdout = ''; let cliStderr = ''; let cliError: Error | undefined;
  try {
    const cwd = new URL('../../',import.meta.url);
    const env = {...process.env,npm_config_cache:join(dir,'npm-cache')};
    const packed = spawnSync('npm',['pack','--json','--offline','--ignore-scripts','--pack-destination',dir],{cwd,env,encoding:'utf8',timeout:120000});
    assert.equal(packed.status,0,packed.status === 0 ? '' : packageFailure('npm pack', 'npm', ['pack','--json','--offline','--ignore-scripts','--pack-destination','<owned-temp>'], packed, env.npm_config_cache));
    const filename = (JSON.parse(packed.stdout) as {filename:string}[])[0]!.filename;
    const installed = spawnSync('npm',['install','--prefix',join(dir,'install'),'--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund',join(dir,filename)],{env,encoding:'utf8',timeout:180000});
    assert.equal(installed.status,0,installed.status === 0 ? '' : packageFailure('npm offline install', 'npm', ['install','--prefix','<owned-temp>/install','--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund','<owned-tarball>'], installed, env.npm_config_cache));
    const state = join(dir,'state');
    child = spawn(process.execPath,[join(dir,'install/node_modules/@lux-didi/service/dist/index.js')],{env:{...env,DIDI_STATE_DIR:state,DIDI_PORT:'0'},stdio:['ignore','pipe','pipe']});
    child.stdout!.on('data', data => { cliStdout += data.toString(); });
    child.stderr!.on('data', data => { cliStderr += data.toString(); });
    child.on('error', error => { cliError = error; });
    cliStage = 'CLI startup';
    const exit = once(child,'exit');
    const output = await Promise.race([once(child.stdout!,'data').then(([chunk])=>String(chunk)),exit.then(([code])=>{throw Error(`CLI exited ${String(code)}`);})]);
    const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]; assert.ok(origin,output);
    cliStage = 'CLI runtime';
    const health = await fetch(`${origin}/health`); assert.equal(health.status,200);
    const token = readFileSync(join(state,'admin-credential'),'utf8').trim();
    const status = await (await fetch(`${origin}/api/v1/status`,{headers:{Authorization:`Bearer ${token}`}})).json();
    assert.equal(status.data.capabilities.memory,false); assert.equal(status.data.model.configured,false); assert.deepEqual(status.data.sources,[]);
    assert.ok(!output.includes(token));
    cliStage = 'CLI teardown';
    child.kill('SIGTERM'); const [code] = await exit; assert.equal(code,0); child = undefined;
  } catch (error) {
    if (child) packageFailure(cliStage, process.execPath, ['<installed-service>/dist/index.js'], { status: child.exitCode, signal: child.signalCode, ...(cliError ? { error: cliError } : {}), stdout: cliStdout, stderr: cliStderr });
    throw error;
  } finally { if (child && child.pid && child.exitCode === null) { const exit = once(child,'exit'); child.kill('SIGTERM'); await exit; } rmSync(dir,{recursive:true,force:true}); }
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

test('owner list route returns explicit kind and origin for every entry', async () => {
  const { createDomainPort } = await import('../domain/facade.js');
  const { Outbox } = await import('../runtime/outbox.js');
  const port = createDomainPort({ outbox: Outbox });
  const f = await fixture(port);
  try {
    const ctx = { assistantId: f.store.assistantId, clientId: 'synthetic-host', authorityEpoch: f.store.authorityEpoch, now: new Date(0).toISOString() };
    const session = f.store.transaction(tx => port.execute(tx, 'createSession', { title: 'Origin list', timeZone: 'UTC' }, ctx));
    f.store.transaction(tx => port.execute(tx, 'appendEntry', {
      sessionId: session.id, text: 'A remembered preference', role: 'user', timeZone: 'UTC',
      sourceRef: { id: 'live-1', label: 'live-voice live-1', provider: 'live-voice', sourceTimestamp: null, availability: 'present', note: 'kind:preference' },
    }, ctx));
    f.store.transaction(tx => port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'A bare note', role: 'user', timeZone: 'UTC' }, ctx));
    const posted = await fetch(`${f.service.origin}/api/v1/sessions/${session.id}/entries`, {
      method: 'POST',
      headers: { ...f.auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'page-save', 'X-Didi-Authority-Epoch': f.store.authorityEpoch },
      body: JSON.stringify({ text: 'Saved on the page', role: 'user', timeZone: 'UTC', sourceRef: { id: '11111111-1111-4111-8111-111111111111', label: 'Saved on the page', provider: 'page', sourceTimestamp: null, availability: 'present' } }),
    });
    assert.equal(posted.status, 200);
    const postedBody = await posted.json() as { data: { kind: string; origin: string } };
    assert.deepEqual([postedBody.data.kind, postedBody.data.origin], ['note', 'page']);
    const response = await fetch(`${f.service.origin}/api/v1/sessions/${session.id}`, { headers: f.auth });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { entries: { kind: string; origin: string }[] } };
    assert.deepEqual(body.data.entries.map(e => [e.kind, e.origin]), [
      ['preference', 'live-voice'],
      ['note', 'unknown'],
      ['note', 'page'],
    ]);
  } finally { await f.cleanup(); }
});

// Only caller-owned subprocess output/cache is captured; never the ambient npm cache or environment.
function packageFailure(stage: string, command: string, args: string[], result: {
  status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout: string | null; stderr: string | null;
}, cache?: string): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const evidence = {
    stage, command, args, status: result.status, signal: result.signal,
    error: error ? { name: error.name, message: error.message, stack: error.stack, code: error.code, errno: error.errno, syscall: error.syscall, path: error.path } : null,
    stdout: result.stdout ?? null, stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
    stderr: result.stderr ?? null, stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    npmLogs: [] as { path: string; bytes: number; content: string }[],
  };
  // Write identity/output first so an npm-log read error cannot erase the subprocess failure.
  process.stderr.write(`PACKAGE_FAILURE ${JSON.stringify(evidence)}\n`);
  const logs = cache && join(cache, '_logs');
  if (logs && existsSync(logs)) {
    for (const name of readdirSync(logs).filter(name => name.endsWith('-debug-0.log')).sort()) {
      const path = join(logs, name);
      const bytes = readFileSync(path);
      const log = { path, bytes: bytes.length, content: bytes.toString('utf8') };
      evidence.npmLogs.push(log);
      process.stderr.write(`PACKAGE_NPM_DEBUG ${JSON.stringify(log)}\n`);
    }
  }
  // No display bound: full output/debug text survives owned-temp cleanup in the canonical log.
  return JSON.stringify(evidence);
}

test('package diagnostics retain actual stdout-only exit failure and full owned npm debug evidence before cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-package-diagnostics-'));
  const cache = join(dir, 'npm-cache');
  const debug = join(cache, '_logs', 'synthetic-debug-0.log');
  const stdout = 'synthetic stdout ' + 'x'.repeat(6000) + ' STDOUT-END';
  const log = 'synthetic npm debug ' + 'y'.repeat(12000) + ' DEBUG-END';
  try {
    mkdirSync(join(cache, '_logs'), { recursive: true });
    writeFileSync(debug, log);
    const args = ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.exit(7)`];
    const failed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(failed.status, 7);
    assert.equal(failed.stderr, '');
    const evidence = JSON.parse(packageFailure('synthetic offline install', process.execPath, ['-e', '<synthetic fixture>'], failed, cache));
    assert.equal(evidence.stage, 'synthetic offline install');
    assert.equal(evidence.command, process.execPath);
    assert.deepEqual(evidence.args, ['-e', '<synthetic fixture>']);
    assert.equal(evidence.status, 7);
    assert.equal(evidence.signal, null);
    assert.equal(evidence.error, null);
    assert.equal(evidence.stdout, stdout);
    assert.equal(evidence.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(evidence.stderr, '');
    assert.deepEqual(evidence.npmLogs, [{ path: debug, bytes: Buffer.byteLength(log), content: log }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(existsSync(dir), false);
});

test('package diagnostics distinguish actual spawn error and signal from install exit failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-package-diagnostics-'));
  try {
    const command = join(dir, 'missing-executable');
    const missing = spawnSync(command, [], { encoding: 'utf8' });
    assert.equal((missing.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
    const spawnEvidence = JSON.parse(packageFailure('synthetic CLI spawn', command, [], missing, join(dir, 'npm-cache')));
    assert.equal(spawnEvidence.status, null);
    assert.equal(spawnEvidence.error.code, 'ENOENT');
    assert.equal(spawnEvidence.error.message, missing.error!.message);
    assert.equal(spawnEvidence.stdout, missing.stdout ?? null);
    assert.equal(spawnEvidence.stderr, missing.stderr ?? null);
    assert.equal(spawnEvidence.stdoutBytes, 0);
    assert.equal(spawnEvidence.stderrBytes, 0);
    assert.deepEqual(spawnEvidence.npmLogs, []);
    const signalled = spawnSync(process.execPath, ['-e', 'process.stderr.write("synthetic teardown stderr"); process.kill(process.pid, "SIGTERM")'], { encoding: 'utf8' });
    assert.equal(signalled.signal, 'SIGTERM');
    const signalEvidence = JSON.parse(packageFailure('synthetic CLI teardown', process.execPath, ['-e', '<synthetic fixture>'], signalled));
    assert.equal(signalEvidence.status, null);
    assert.equal(signalEvidence.signal, 'SIGTERM');
    assert.equal(signalEvidence.stderr, 'synthetic teardown stderr');
    assert.equal(signalEvidence.error, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(existsSync(dir), false);
});


test('owner memory delete requires a principal, is idempotent and reports unknown ids', async () => {
  const port = createDomainPort({ outbox: Outbox });
  const f = await fixture(port);
  try {
    const ctx = { assistantId: f.store.assistantId, clientId: 'fixture-owner', authorityEpoch: f.store.authorityEpoch, now: new Date().toISOString() };
    const session = f.store.transaction(tx => port.execute(tx, 'createSession', { title: 'Delete fixture', timeZone: 'UTC' }, ctx));
    const entry = f.store.transaction(tx => port.execute(tx, 'appendEntry', { sessionId: session.id, text: 'synthetic HTTP deletion note', role: 'user', timeZone: 'UTC' }, ctx));
    const path = `${f.service.origin}/api/v1/entries/${entry.id}`;
    assert.equal((await fetch(path, { method: 'DELETE' })).status, 401);
    const browser = await pair(f);
    const headers = { Cookie: browser.cookie.split(';')[0]!, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf, 'X-Didi-Authority-Epoch': f.store.authorityEpoch, 'Idempotency-Key': 'delete-one', 'Content-Type': 'application/json' };
    const first = await fetch(path, { method: 'DELETE', headers, body: '{}' });
    assert.equal(first.status, 200);
    const deleted = await first.json();
    const second = await fetch(path, { method: 'DELETE', headers: { ...headers, 'Idempotency-Key': 'delete-again' }, body: '{}' });
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).data, deleted.data);
    const unknown = await fetch(`${f.service.origin}/api/v1/entries/00000000-0000-4000-8000-000000000000`, { method: 'DELETE', headers: { ...headers, 'Idempotency-Key': 'delete-unknown' }, body: '{}' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
  } finally { await f.cleanup(); }
});

test('the Mongoose sign-in route starts only on an explicit owner click and carries the endpoint name', async () => {
  const requested: (string | undefined)[] = [];
  const f = await fixture(undefined, undefined, async (endpoint?: string) => {
    requested.push(endpoint);
    return { status: 'started' as const, attemptId: '0123456789abcdef' };
  });
  try {
    const browser = await pair(f);
    assert.deepEqual(requested, [], 'pairing a browser never opens a sign-in');
    const headers = { Cookie: browser.cookie.split(';')[0]!, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf, 'Content-Type': 'application/json' };
    const refused = await fetch(`${f.service.origin}/api/v1/connectors/mongoose/sign-in`, { method: 'POST', headers: { ...headers, 'X-Didi-CSRF': 'stale', 'Idempotency-Key': 'mongoose-sign-in-1' }, body: '{"endpoint":"data"}' });
    assert.equal(refused.status, 403, 'the click needs this browser authority');
    const response = await fetch(`${f.service.origin}/api/v1/connectors/mongoose/sign-in`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'mongoose-sign-in-1' }, body: '{"endpoint":"data"}' });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Record<string, unknown> };
    assert.deepEqual(body.data, { status: 'started', attemptId: '0123456789abcdef' }, 'the reply names the attempt, never an authorize URL');
    assert.deepEqual(requested, ['data'], 'the click names the one endpoint it signs in');
  } finally { await f.cleanup(); }
});

test('a sign-in that cannot start answers with a named reason, never unknown', async () => {
  const f = await fixture(undefined, undefined, async () => ({ status: 'failed' as const, reason: 'port-in-use' }));
  try {
    const browser = await pair(f);
    const response = await fetch(`${f.service.origin}/api/v1/connectors/mongoose/sign-in`, { method: 'POST', headers: { Cookie: browser.cookie.split(';')[0]!, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf, 'Content-Type': 'application/json', 'Idempotency-Key': 'mongoose-sign-in-2' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { status: 'failed', reason: 'port-in-use' });
  } finally { await f.cleanup(); }
});

test('T13b a pending connector is projected as connecting, never error', async () => {
  const f = await fixture(undefined, () => ({ endpoints: [
    { id: 'gmail', state: 'connecting', tools: 0, lastHandshakeAt: null },
    { id: 'bogus', state: 'not-a-state', tools: 0, lastHandshakeAt: null },
  ] }));
  try {
    const browser = await pair(f);
    const response = await fetch(`${f.service.origin}/api/v1/live/connections`, { headers: { Cookie: browser.cookie.split(';')[0]!, 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ state: string; reasonCode: string | null }> };
    assert.equal(body.data[0]!.state, 'connecting');
    assert.equal(body.data[0]!.reasonCode, null);
    assert.equal(body.data[1]!.state, 'error');
    assert.equal(body.data[1]!.reasonCode, 'unknown');
  } finally { await f.cleanup(); }
});

test('sign-in reasons the owner can act on project as needs_sign_in, never unknown', async () => {
  const f = await fixture(undefined, () => ({ endpoints: [
    { id: 'mongoose-knowledge', connector: 'mongoose', state: 'error', tools: 0, lastHandshakeAt: null, error: 'not_signed_in' },
    { id: 'mongoose-data', connector: 'mongoose', state: 'error', tools: 0, lastHandshakeAt: null, error: 'not_signed_in' },
    { id: 'mongoose-crm', connector: 'mongoose', state: 'error', tools: 0, lastHandshakeAt: null, error: 'credential-refresh-failed' },
    { id: 'mongoose-busy', connector: 'mongoose', state: 'error', tools: 0, lastHandshakeAt: null, error: 'credential-refresh-busy' },
    { id: 'gmail', connector: 'google', state: 'error', tools: 0, lastHandshakeAt: null, error: 'credential-refresh-failed' },
    { id: 'mattermost', connector: 'mattermost', state: 'error', tools: 0, lastHandshakeAt: null, error: 'not_signed_in' },
  ] }));
  try {
    const browser = await pair(f);
    const response = await fetch(`${f.service.origin}/api/v1/live/connections`, { headers: { Cookie: browser.cookie.split(';')[0]!, 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ reasonCode: string | null }> };
    assert.deepEqual(body.data.map(row => row.reasonCode), ['needs_sign_in', 'needs_sign_in', 'needs_sign_in', 'unknown', 'unknown', 'not_signed_in'],
      'every Mongoose endpoint row that needs a sign-in says so; a busy refresh is not one, and no other connector changes');
  } finally { await f.cleanup(); }
});

test('T13 connections preserve bounded typed configuration errors', async () => {
  const f = await fixture(undefined, () => ({ endpoints: [
    { id: 'missing-class', state: 'error', tools: 0, lastHandshakeAt: null, error: 'unknown-class-missing', configurationError: 'unknown-class-missing' },
    { id: 'untrusted-code', state: 'error', tools: 0, lastHandshakeAt: null, error: 'private diagnostic', configurationError: 'private diagnostic' },
  ] }));
  try {
    const browser = await pair(f);
    const response = await fetch(`${f.service.origin}/api/v1/live/connections`, { headers: { Cookie: browser.cookie.split(';')[0]!, 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ reasonCode: string; configurationError?: string }> };
    assert.equal(body.data[0]!.reasonCode, 'configuration_error');
    assert.equal(body.data[0]!.configurationError, 'unknown-class-missing');
    assert.equal(body.data[1]!.configurationError, undefined);
    assert.equal(JSON.stringify(body).includes('private diagnostic'), false);
  } finally { await f.cleanup(); }
});

// --- #649: the button and the CLI sign in one Mongoose endpoint, and only that one. ---

/** The installed three-endpoint Mongoose catalogue, values replaced by synthetic ones. */
function mongooseCatalogue(): Record<string, unknown>[] {
  return ['knowledge', 'data', 'crm'].map(name => ({
    id: `mongoose-${name}`, unknownClass: 'sensitive', transport: 'streamable-http', connector: 'mongoose',
    account: 'local', resource: `mongoose:${name}`, credentialRef: `mongoose-${name}`, enabled: true, allowEgress: true,
    url: `https://mongoose.example.invalid/mcp/${name}`,
  }));
}

/** A private configuration directory holding the three catalogue entries and one synthetic record each. */
function mongooseConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-signin-'));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: 'owner@example.invalid', endpoints: mongooseCatalogue() }), { mode: 0o600 });
  for (const name of ['knowledge', 'data', 'crm']) writeFileSync(join(dir, `mongoose-${name}.json`), JSON.stringify({ schemaVersion: 1, token: `synthetic-${name}` }), { mode: 0o600 });
  return dir;
}

/** The synthetic record a fake login writes: a schemaVersion 3 session for one endpoint, never a real token. */
function syntheticSession(name: string): string {
  return JSON.stringify({ schemaVersion: 3, endpoint: name, resource: `https://mongoose.example.invalid/mcp/${name}`, issuer: 'https://mongoose.example.invalid', tokenEndpoint: 'https://mongoose.example.invalid/oauth/token', clientId: 'synthetic-client', redirectPort: 8768, account: 'local', accessToken: `synthetic-access-${name}`, refreshToken: `synthetic-refresh-${name}`, expiresAt: 1, consentStartedAt: 1 });
}

test('#649: a sign-in for data leaves the knowledge and crm records untouched', async () => {
  const configDir = mongooseConfigDir();
  try {
    const opened: string[] = [];
    const signed: string[] = [];
    let recovered = 0;
    const signIn = createMongooseSignIn({
      configDir,
      recover: async () => { recovered += 1; },
      open: url => { opened.push(url); },
      login: async options => {
        signed.push(`${options.endpoint}:${options.reference}`);
        writeFileSync(join(configDir, `${options.reference}.json`), syntheticSession(options.endpoint), { mode: 0o600 });
        await options.openBrowser?.('http://127.0.0.1:8768/authorize?state=synthetic');
      },
    });
    const started = await signIn('data');
    assert.equal(started.status, 'started');
    // The recovery follows the login on its own chain, so let the microtask queue drain before reading it.
    for (let tick = 0; tick < 20 && recovered === 0; tick += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(signed, ['data:mongoose-data'], 'only the requested endpoint signs in');
    assert.deepEqual(opened, ['http://127.0.0.1:8768/authorize?state=synthetic'], 'one browser consent, for that endpoint');
    assert.equal(recovered, 1, 'the connector reconnects once the record lands');
    assert.equal(readFileSync(join(configDir, 'mongoose-data.json'), 'utf8'), syntheticSession('data'));
    for (const name of ['knowledge', 'crm']) {
      assert.equal(readFileSync(join(configDir, `mongoose-${name}.json`), 'utf8'), JSON.stringify({ schemaVersion: 1, token: `synthetic-${name}` }), `${name} is untouched`);
    }
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});

test('#649: an unknown endpoint name is a closed failure, and one sign-in runs at a time', async () => {
  const configDir = mongooseConfigDir();
  try {
    const signed: string[] = [];
    let finish: () => void = () => {};
    let gate = Promise.resolve();
    const signIn = createMongooseSignIn({
      configDir,
      recover: async () => {},
      open: () => {},
      login: async options => {
        signed.push(options.endpoint);
        await options.openBrowser?.('http://127.0.0.1:8768/authorize?state=synthetic');
        await gate;
      },
    });
    assert.deepEqual(await signIn(), { status: 'failed', reason: 'not-configured' }, 'a click with no endpoint name never opens a browser');
    assert.deepEqual(signed, [], 'and never runs a login');
    assert.deepEqual(await signIn('admin'), { status: 'failed', reason: 'not-configured' }, 'an unknown name never opens a browser');
    assert.deepEqual(signed, [], 'and never runs a login');
    gate = new Promise<void>(resolve => { finish = resolve; });
    const first = signIn('knowledge');
    const second = signIn('data');
    assert.deepEqual(await second, { status: 'failed', reason: 'sign-in-in-progress' }, 'a click for another endpoint is told to finish the open one first');
    assert.equal((await first).status, 'started');
    finish();
    await gate;
    assert.deepEqual(signed, ['knowledge'], 'the second click never signs a second endpoint');
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});

/** A private config dir with both credential slots seeded, and a Live service that really saves. */
function liveSettings() {
  const root = mkdtempSync(join(tmpdir(), 'didi-live-settings-')); chmodSync(root, 0o700);
  const configDir = join(root, 'config'); mkdirSync(configDir, { mode: 0o700 }); chmodSync(configDir, 0o700);
  const put = (name: string, value: unknown) => writeFileSync(join(configDir, name), JSON.stringify(value), { mode: 0o600 });
  put('live.json', {
    schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.8-live', voice: 'Aoede',
    keyReference: 'gemini-primary', dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' },
    limits: { sessionMs: 900000 },
  });
  put('gemini-primary.json', { schemaVersion: 1, keyReference: 'gemini-primary', key: 'gemini_NEVER_PRINT' });
  put('openai-primary.json', { schemaVersion: 1, keyReference: 'openai-primary', key: 'openai_NEVER_PRINT' });
  const saved = () => JSON.parse(readFileSync(join(configDir, 'live.json'), 'utf8')) as Record<string, unknown>;
  const live = {
    enabled: true, profileIdentity: 'synthetic-profile-identity', maxIncomingBytes: 1, maxBufferedBytes: 1,
    status: () => ({
      service: 'live' as const, status: 'configured' as const, provider: 'gemini' as const, model: 'gemini-synthetic-live',
      voice: 'Aoede', dataClasses: ['ordinary' as const], profileIdentity: 'synthetic-profile-identity',
      limits: { sessionMs: 900000, idleMs: 300000 },
    }),
    saveSelection: (input: { provider: unknown; voice?: unknown; accent?: unknown }) => saveLiveSelection({
      configDir, provider: input.provider,
      ...(input.voice !== undefined ? { voice: input.voice } : {}),
      ...(input.accent !== undefined ? { accent: input.accent } : {}),
    }),
  } as unknown as Parameters<typeof listenService>[0]['live'];
  return { live, saved, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('a settings save reaches the Live service with its body and stores provider, voice and accent', async () => {
  const live = liveSettings();
  const f = await fixture(undefined, undefined, undefined, live.live);
  try {
    // The owner's Settings page is a browser: same cookie, CSRF token and authority epoch as any mutation.
    const browser = await pair(f);
    const headers = { Cookie: browser.cookie.split(';')[0]!, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf,
      'X-Didi-Authority-Epoch': f.store.authorityEpoch, 'Idempotency-Key': 'settings-one', 'Content-Type': 'application/json' };
    const response = await fetch(`${f.service.origin}/api/v1/live/settings`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'openai', voice: 'marin', accent: 'indian-light' }),
    });
    assert.equal(response.status, 200, 'the owner Save button succeeds');
    const selection = (await response.json()).data as Record<string, unknown>;
    assert.equal(selection.provider, 'openai');
    assert.equal(selection.voice, 'marin');
    assert.equal(selection.accent, 'indian-light');
    assert.equal(live.saved()['provider'], 'openai', 'the choice is stored, not only echoed');
    assert.equal(live.saved()['voice'], 'marin');
    assert.equal(live.saved()['accent'], 'indian-light');
  } finally { await f.cleanup(); live.cleanup(); }
});

test('a refused voice is answered with the field named and stores nothing', async () => {
  const live = liveSettings();
  const f = await fixture(undefined, undefined, undefined, live.live);
  try {
    const browser = await pair(f);
    const headers = { Cookie: browser.cookie.split(';')[0]!, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf,
      'X-Didi-Authority-Epoch': f.store.authorityEpoch, 'Idempotency-Key': 'settings-bad', 'Content-Type': 'application/json' };
    const refused = await fetch(`${f.service.origin}/api/v1/live/settings`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'gemini', voice: 'marin' }),
    });
    assert.equal(refused.status, 400);
    const failure = (await refused.json()).error as { code: string; message: string };
    assert.match(failure.message, /voice/, 'the refusal names the voice, never a generic settings error');
    assert.equal(live.saved()['voice'], 'Aoede', 'a refused save writes nothing');
    const empty = await fetch(`${f.service.origin}/api/v1/live/settings`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'settings-empty' }, body: JSON.stringify({ provider: 'gemini', voice: '' }),
    });
    assert.equal(empty.status, 400);
    assert.match(((await empty.json()).error as { message: string }).message, /voice/);
  } finally { await f.cleanup(); live.cleanup(); }
});

// --- #659: a repeat click reaches the browser again, and another endpoint is told plainly. ---

const AUTHORIZE = 'http://127.0.0.1:8768/authorize?state=synthetic';

test('#659: a second click on the same endpoint opens the browser again at the URL already issued', async () => {
  const dir = mongooseConfigDir();
  try {
    const opened: string[] = [];
    const signed: string[] = [];
    let finish: () => void = () => {};
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const signIn = createMongooseSignIn({
      configDir: dir,
      recover: async () => {},
      open: url => { opened.push(url); },
      login: async options => {
        signed.push(`${options.endpoint}:${options.reference}`);
        await options.openBrowser?.(AUTHORIZE);
        await gate;
      },
    });
    const first = await signIn('knowledge');
    for (let tick = 0; tick < 20 && opened.length === 0; tick += 1) await new Promise(resolve => setImmediate(resolve));
    const again = await signIn('knowledge');
    assert.equal(first.status, 'started', 'the first click answers started');
    assert.deepEqual(again, first, 'the repeat click answers the same attempt, not silence');
    assert.deepEqual(opened, [AUTHORIZE, AUTHORIZE], 'the browser is asked twice, at the one URL already issued');
    assert.deepEqual(signed, ['knowledge:mongoose-knowledge'], 'no second login runs');
    finish();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#659: a click for another endpoint while one sign-in is pending says to finish the open one first', async () => {
  const dir = mongooseConfigDir();
  try {
    const opened: string[] = [];
    const signed: string[] = [];
    let finish: () => void = () => {};
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const signIn = createMongooseSignIn({
      configDir: dir,
      recover: async () => {},
      open: url => { opened.push(url); },
      login: async options => {
        signed.push(options.endpoint);
        await options.openBrowser?.(AUTHORIZE);
        await gate;
      },
    });
    const first = signIn('knowledge');
    for (let tick = 0; tick < 20 && opened.length === 0; tick += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await signIn('data'), { status: 'failed', reason: 'sign-in-in-progress' }, 'the other endpoint is told, not joined');
    assert.deepEqual(signed, ['knowledge'], 'the second click never runs a second login');
    assert.deepEqual(opened, [AUTHORIZE], 'and never opens a second sign-in page');
    assert.equal((await first).status, 'started');
    finish();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#659: a browser that cannot open reaches the Settings row as browser-unavailable, never an uncaught error', async () => {
  const dir = mongooseConfigDir();
  try {
    for (const open of [() => { throw new Error('spawn open ENOENT'); }, async () => { throw new Error('spawn open ENOENT'); }]) {
      const signIn = createMongooseSignIn({
        configDir: dir,
        recover: async () => {},
        open,
        login: async options => {
          try { await options.openBrowser?.(AUTHORIZE); }
          catch { options.onHop?.({ hop: 'browser_handoff', outcome: 'unavailable' }); throw new MongooseLoginError('browser-unavailable'); }
        },
      });
      const started = await signIn('knowledge');
      assert.equal(started.status, 'started', 'the click answers at once');
      for (let tick = 0; tick < 20 && signIn.attempt('mongoose-knowledge')?.phase !== 'failed'; tick += 1) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(signIn.attempt('mongoose-knowledge'), { attemptId: (started as { attemptId: string }).attemptId, phase: 'failed', reason: 'browser_unavailable' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W1-R1: a finished attempt is dropped once its row connects, so a later failure shows its own reason', async () => {
  const dir = mongooseConfigDir();
  let state = 'error';
  const signIn = createMongooseSignIn({
    configDir: dir, recover: async () => {}, open: () => {},
    login: async options => {
      await options.openBrowser?.(AUTHORIZE);
      for (const hop of ['discovery', 'registration', 'browser_handoff', 'callback', 'token', 'stored'] as const) options.onHop?.({ hop, outcome: 'ok' } as never);
    },
  });
  const rows = () => ({ endpoints: [{ id: 'mongoose-knowledge', connector: 'mongoose', state, tools: state === 'connected' ? 3 : 0, lastHandshakeAt: null, ...(state === 'connected' ? {} : { error: 'not_signed_in' }) }] });
  const f = await fixture(undefined, rows, signIn, undefined, { mongooseSignInAttempt: (id, connected) => signIn.attempt(id, connected) });
  try {
    const browser = await pair(f);
    const cookie = browser.cookie.split(';')[0]!;
    const poll = async () => ((await (await fetch(`${f.service.origin}/api/v1/live/connections`, { headers: { Cookie: cookie, 'sec-fetch-site': 'same-origin' } })).json()).data as Array<Record<string, unknown>>)[0]!;
    const started = await signIn('knowledge');
    for (let tick = 0; tick < 20 && signIn.attempt('mongoose-knowledge')?.phase !== 'signed_in'; tick += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await poll())['signIn'], { attemptId: (started as { attemptId: string }).attemptId, phase: 'signed_in' });
    state = 'connected';
    assert.equal((await poll())['signIn'], undefined, 'a connected row carries no finished attempt');
    state = 'error';
    assert.equal((await poll())['signIn'], undefined, 'and a later failure shows only its own reason');
    assert.equal(signIn.attempt('mongoose-knowledge'), undefined);
  } finally { await f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('W1: the click route answers started at once while discovery is still pending, and the row shows the outcome', async () => {
  const dir = mongooseConfigDir();
  const events: Record<string, unknown>[] = [];
  let discoveryRequests = 0;
  // Discovery never answers: the reply must not wait for it.
  const hanging = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    discoveryRequests += 1;
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;
  const signIn = createMongooseSignIn({
    configDir: dir, recover: async () => {}, open: () => {}, log: event => { events.push(event); },
    login: options => runMongooseLogin({ ...options, fetch: hanging, timeoutMs: 400 }).then(() => undefined),
  });
  const rows = () => ({ endpoints: [{ id: 'mongoose-knowledge', connector: 'mongoose', state: 'error', tools: 0, lastHandshakeAt: null, error: 'not_signed_in' }] });
  const f = await fixture(undefined, rows, signIn, undefined, { mongooseSignInAttempt: (id, connected) => signIn.attempt(id, connected) });
  try {
    const browser = await pair(f);
    const cookie = browser.cookie.split(';')[0]!;
    const started = Date.now();
    const response = await fetch(`${f.service.origin}/api/v1/connectors/mongoose/sign-in`, { method: 'POST', headers: { Cookie: cookie, Origin: f.service.origin, 'X-Didi-CSRF': browser.csrf, 'Content-Type': 'application/json', 'Idempotency-Key': 'mongoose-sign-in-pending' }, body: '{"endpoint":"knowledge"}' });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    const data = (await response.json()).data as { status: string; attemptId: string };
    assert.equal(data.status, 'started');
    assert.match(data.attemptId, /^[0-9a-f]{16}$/);
    assert.ok(elapsed < 1000, `the click answered in ${elapsed} ms`);
    assert.equal(discoveryRequests, 1, 'discovery is still in flight');
    const poll = async () => ((await (await fetch(`${f.service.origin}/api/v1/live/connections`, { headers: { Cookie: cookie, 'sec-fetch-site': 'same-origin' } })).json()).data as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual((await poll())['signIn'], { attemptId: data.attemptId, phase: 'running' });
    let row = await poll();
    for (let wait = 0; wait < 40 && (row['signIn'] as { phase: string }).phase === 'running'; wait += 1) { await new Promise(resolve => setTimeout(resolve, 50)); row = await poll(); }
    assert.deepEqual(row['signIn'], { attemptId: data.attemptId, phase: 'failed', reason: 'discovery_refused' });
    assert.deepEqual(events.map(event => `${event['event']}:${event['outcome']}`), ['signin_requested:started', 'signin_discovery:timeout']);
    for (const event of events) {
      assert.deepEqual(safeEvent(event), event, 'the host log keeps every sign-in line unchanged');
      assert.equal(event['endpoint'], 'knowledge');
      assert.equal(event['attemptId'], data.attemptId);
    }
  } finally { await f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
