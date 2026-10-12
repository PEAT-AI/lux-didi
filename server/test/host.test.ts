import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pairLocal, startHost, type RuntimeDescriptor } from '../host/runtime.js';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');

test('host serves the accepted build with security policy, never API or private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-static-'));
  const store = new Store(dir);
  const endpoints = [
    { id: 'missing', state: 'missing', tools: 0, lastHandshakeAt: null, error: 'credential private.json missing or invalid', config: 'SECRET CONFIG' },
    { id: 'ready', state: 'configured', tools: 0, lastHandshakeAt: null },
    { id: 'online', state: 'connected', tools: 3, lastHandshakeAt: '2026-10-12T14:52:00.000Z' },
    { id: 'offline', state: 'error', tools: 0, lastHandshakeAt: null, error: 'RAW SECRET https://secret.invalid/?token=PRIVATE' },
  ];
  const service = await listenService({ store, port: 0, webRoot, toolsStatus: () => ({ endpoints }) });
  try {
    const response = await fetch(service.origin);
    assert.equal(response.status, 200, 'the real shell must be available without API authentication');
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.equal(html, await readFile(join(webRoot, 'index.html'), 'utf8'));
    assert.equal((service.server.address() as { address: string }).address, '127.0.0.1');
    const head = await fetch(service.origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]!);
    assert.ok(assetPaths.length >= 2);
    for (const path of assetPaths) {
      const asset = await fetch(service.origin + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
    assert.equal((await fetch(service.origin + '/health')).status, 200);
    const policy = JSON.parse(await readFile(resolve(webRoot, '../security-headers.json'), 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(policy)) assert.equal(response.headers.get(name), value);
    for (const path of ['/manifest.webmanifest', '/icon.svg', '/sw.js']) {
      assert.equal((await fetch(service.origin + path)).status, 200, path);
    }
    for (const path of ['/api/v1/not-real', '/api', '/server/runtime/store.ts', '/.env', '/admin.token', '/%2e%2e%2findex.html', '/%252e%252e%252findex.html', '/assets/%5c..%5csecret']) {
      const denied = await fetch(service.origin + path);
      assert.ok(denied.status >= 400, path);
      assert.doesNotMatch(denied.headers.get('content-type') ?? '', /text\/html/, path);
    }
    // Fetch normalizes Host; exercise the actual wire as the accepted HTTP suite does.
    const hostDenied = await new Promise<number>((resolve, reject) => {
      const req = request(service.origin, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostDenied, 403);
    assert.equal((await fetch(service.origin, { headers: { Origin: 'http://evil.invalid' } })).status, 403);
    const status = await fetch(service.origin + '/api/v1/status');
    assert.equal(status.status, 401, 'static shell must not relax API auth');
    const pairing = await fetch(service.origin + '/api/v1/auth/pairing', { method: 'POST', headers: { Authorization: `Bearer ${store.adminCredential}`, 'Content-Type': 'application/json' }, body: '{}' });
    const { data: { pairingCode } } = await pairing.json();
    const paired = await fetch(service.origin + '/api/v1/auth/pair', { method: 'POST', headers: { Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const { data: { csrfToken } } = await paired.json();
    const connections = await fetch(service.origin + '/api/v1/live/connections', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(connections.status, 200);
    assert.equal(connections.headers.get('cache-control'), 'no-store');
    assert.equal(connections.headers.get('access-control-allow-origin'), null);
    const projection = (await connections.json()).data;
    assert.deepEqual(projection.map((row: { state: string }) => row.state), ['missing', 'configured', 'connected', 'error']);
    assert.deepEqual(projection.map((row: { reasonCode: string | null }) => row.reasonCode), ['credential_missing', null, null, 'unknown']);
    for (const row of projection) assert.deepEqual(Object.keys(row).sort(), ['id', 'lastHandshakeAt', 'reasonCode', 'state', 'tools']);
    assert.doesNotMatch(JSON.stringify(projection), /SECRET|PRIVATE|secret.invalid|private.json/);
    assert.equal((await fetch(service.origin + '/api/v1/live/connections')).status, 401);
    assert.equal((await fetch(service.origin + '/api/v1/live/connections', { headers: { Cookie: cookie, Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(service.origin + '/api/v1/tools/status', { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(service.origin + '/api/v1/live/connections', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(service.origin + '/api/v1/live/connections', { headers: { Authorization: `Bearer ${store.adminCredential}` } })).status, 403);
    const browserStatus = await fetch(service.origin + '/api/v1/status', { headers: { Cookie: cookie } });
    assert.equal(browserStatus.status, 200);
    assert.deepEqual((await browserStatus.json()).data.capabilities, { memory: false, commitments: false, notifications: false, model: false });
    for (const extra of [{}, { 'X-Didi-CSRF': csrfToken }, { Origin: service.origin }]) {
      const denied = await fetch(service.origin + '/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, body: '{}' });
      assert.equal(denied.status, 403, 'static-enabled service must retain browser Origin/CSRF checks');
    }
    assert.equal((await fetch(service.origin + '/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: service.origin, 'X-Didi-CSRF': csrfToken, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  } finally { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('host refuses incomplete builds before listening and denies a symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-invalid-'));
  const store = new Store(join(dir, 'state'));
  try {
    for (const root of [join(dir, 'missing'), dir]) {
      await assert.rejects(async () => {
        const unexpected = await listenService({ store, port: 0, webRoot: root });
        await unexpected.close();
      }, /web|build|ENOENT/i);
    }
    const privateFile = join(dir, 'private.txt');
    await writeFile(privateFile, 'private sentinel');
    const escape = join(webRoot, 'assets/host-escape.js');
    await symlink(privateFile, escape);
    try {
      const service = await listenService({ store, port: 0, webRoot });
      try {
        const denied = await fetch(service.origin + '/assets/host-escape.js');
        assert.ok(denied.status >= 400);
        assert.doesNotMatch(await denied.text(), /private sentinel/);
      } finally { await service.close(); }
    } finally { await rm(escape, { force: true }); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0, 'canonical host must shut down cleanly');
}
async function launch(dataDir: string) {
  const child = spawn('bash', [resolve(import.meta.dirname, '../../../scripts/run-local.sh'), '--run-built', '--data-dir', dataDir, '--web-root', webRoot, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  try {
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(([code]) => { throw new Error(`Host exited ${String(code)}: ${stderr}`); }),
    ]);
    const descriptor = JSON.parse(await readFile(join(dataDir, 'host-runtime.json'), 'utf8')) as RuntimeDescriptor;
    return { child, descriptor };
  } catch (error) { await stopProcess(child); throw error; }
}

test('canonical compiler emits every published production unit and no unpublished unit', async () => {
  const server = resolve(import.meta.dirname, '../..');
  const config = JSON.parse(await readFile(join(server, 'tsconfig.json'), 'utf8')) as { include: string[] };
  assert.deepEqual(config.include.filter(path => !path.startsWith('test/')).sort(), [
    'index.ts', 'runtime/**/*.ts', 'http/**/*.ts', 'contracts/**/*.ts', 'domain/**/*.ts',
    'host/**/*.ts', 'chat/**/*.ts', 'config/**/*.ts', 'adapters/model/**/*.ts', 'adapters/mcp/**/*.ts',
    'adapters/live-voice/**/*.ts', 'connectors/**/*.ts', 'prompt/**/*.ts', 'live/**/*.ts',
  ].sort(), 'canonical production roots must include all accepted units and approved CHAT/config composition');
  for (const entry of ['index', 'runtime/store', 'http/server', 'contracts/index', 'domain/facade',
    'host/index', 'chat/index', 'config/index', 'adapters/model/index', 'adapters/mcp/adapter', 'prompt/index', 'live/index']) {
    for (const suffix of ['.js', '.d.ts', '.js.map']) {
      assert.ok((await stat(join(server, 'dist', entry + suffix))).size > 0, `Missing canonical output ${entry + suffix}`);
    }
  }
  const producer = await readFile(resolve(server, '../scripts/run-local.sh'), 'utf8');
  assert.match(producer, /tsc -p server\/tsconfig\.json/);
  assert.doesNotMatch(producer, /\.host-build-|"extends"|"include"/, 'the wrapper must not substitute a divergent compiler config');
});

test('actual host connects durable domain, supersedes reminders, exposes conflicts and survives process restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-domain-'));
  let host = await startHost({ dataDir: dir, webRoot, port: 0 });
  let child: ChildProcess | undefined;
  try {
    const credential = host.store.adminCredential;
    let origin = host.descriptor.origin;
    const epoch = host.descriptor.authorityEpoch;
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${credential}` };
      if (method !== 'GET') Object.assign(headers, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Didi-Authority-Epoch': epoch });
      const response = await fetch(origin + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, ...(await response.json()) };
    };
    const status = await call('/status');
    assert.deepEqual(status.data.capabilities, { memory: true, commitments: true, notifications: false, model: false });
    assert.equal(status.data.model.configured, false);
    // The MCP composition is exposed on the runtime and reports truthfully, bearer-only.
    const toolsStatus = await call('/tools/status');
    assert.equal(toolsStatus.status, 200);
    assert.deepEqual(toolsStatus.data, { endpoints: [] });
    assert.equal(typeof host.tools.owner, 'object');
    assert.deepEqual(host.tools.connectionIds(), []);
    assert.equal((await fetch(origin + '/api/v1/tools/status')).status, 401);
    // R3: the composition's authority lookup is pluggable; none registered returns null, never fabricated.
    const authority = { ownerId: host.descriptor.assistantId, actorId: 'synthetic', runId: 'run-1', authorityEpoch: epoch, revision: 1, route: { identity: 'synthetic-route', provider: 'gemini' as const, modelId: 'synthetic-model', allowedClasses: ['ordinary'] as const }, allowedClasses: ['ordinary'] as const, connectionIds: [], acceptedRunHash: 'a'.repeat(64) };
    const signal = new AbortController().signal;
    assert.equal(await host.tools.lookupAuthority('run-1', signal), null);
    host.tools.registerAuthoritySource(async () => ({ ...authority }));
    assert.deepEqual(await host.tools.lookupAuthority('run-1', signal), authority);
    const session = (await call('/sessions', 'POST', { title: 'Synthetic host session', timeZone: 'UTC' })).data;
    assert.equal((await call('/chat', 'POST', { sessionId: session.id, text: 'do not fabricate model work', timeZone: 'UTC' })).status, 503);
    const source = { id: randomUUID(), label: 'Synthetic meeting note', sourceTimestamp: new Date().toISOString(), availability: 'present' };
    const entry = (await call(`/sessions/${session.id}/entries`, 'POST', { text: 'Synthetic host kestrel launch: prepare the release checklist.', role: 'user', timeZone: 'UTC', sourceRef: source })).data;
    const recalled = await call('/recall?q=kestrel&limit=10');
    assert.equal(recalled.data.totalMatches, 1);
    assert.equal(recalled.data.hits[0].entryId, entry.id);
    assert.match(recalled.data.hits[0].snippet, /release checklist/);
    assert.ok(recalled.data.hits[0].sourceRefs.some((ref: { id: string; label: string }) => ref.id === source.id && ref.label === source.label));
    const due = new Date(Date.now() + 3_600_000).toISOString();
    let commitment = (await call('/commitments', 'POST', { title: 'Synthetic release checklist', dueAt: due, timeZone: 'UTC', sourceSessionId: session.id, sourceEntryId: entry.id })).data;
    assert.equal(commitment.revision, 1);
    const reminders = () => host.store.transaction(tx => tx.all('SELECT entity_revision, required_grant, state, payload FROM runtime_outbox WHERE entity_id=? ORDER BY entity_revision', [commitment.id]));
    assert.equal(reminders()[0]!.required_grant, 'native.notify.unbound');
    assert.equal(JSON.parse(String(reminders()[0]!.payload)).targetDeviceId, null);
    const nextDue = new Date(Date.now() + 7_200_000).toISOString();
    const revised = await call(`/commitments/${commitment.id}`, 'PATCH', { expectedRevision: 1, dueAt: nextDue, notes: 'Corrected to the later review slot' });
    assert.equal(revised.status, 200);
    commitment = revised.data;
    assert.equal(commitment.revision, 2);
    assert.equal(commitment.dueAt, nextDue);
    assert.deepEqual(reminders().map(row => [row.entity_revision, row.state]), [[1, 'superseded'], [2, 'pending']]);
    const stale = await call(`/commitments/${commitment.id}`, 'PATCH', { expectedRevision: 1, title: 'Stale overwrite must not win' });
    assert.equal(stale.status, 409);
    assert.equal(stale.error.code, 'CONFLICT');
    assert.equal((await call(`/commitments/${commitment.id}`)).data.commitment.title, 'Synthetic release checklist');
    for (const [operation, expectedStatus] of [['complete', 'completed'], ['reopen', 'active'], ['cancel', 'cancelled']] as const) {
      const changed = await call(`/commitments/${commitment.id}/${operation}`, 'POST', { expectedRevision: commitment.revision });
      assert.equal(changed.status, 200);
      commitment = changed.data;
      assert.equal(commitment.status, expectedStatus);
      const pending = reminders().filter(row => row.state === 'pending');
      assert.equal(pending.length, expectedStatus === 'active' ? 1 : 0);
      assert.ok(pending.every(row => row.entity_revision === commitment.revision), 'reopen must not resurrect old revisions');
    }
    const date = due.slice(0, 10);
    const plan = await call(`/plan?date=${date}&timeZone=UTC`);
    assert.equal(plan.status, 200);
    assert.ok(!plan.data.items.some((item: { commitment: { id: string } }) => item.commitment.id === commitment.id));
    const identity = { authorityEpoch: epoch, assistantId: host.descriptor.assistantId };
    assert.equal((await stat(host.descriptorPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'admin-credential'))).mode & 0o777, 0o600);
    assert.ok(!(await readFile(host.descriptorPath, 'utf8')).includes(credential));
    assert.match(await pairLocal(dir), /^[A-Za-z0-9_-]{43}$/);
    await writeFile(host.descriptorPath, JSON.stringify({ ...host.descriptor, authorityEpoch: 'stale' }));
    await assert.rejects(pairLocal(dir), /does not match current service identity/);
    await writeFile(host.descriptorPath, JSON.stringify(host.descriptor));
    await host.close();
    // A deliberately stale descriptor is never trusted for the current authority/origin.
    await writeFile(join(dir, 'host-runtime.json'), JSON.stringify({ schemaVersion: 1, origin: 'http://127.0.0.1:1', authorityEpoch: 'stale', assistantId: 'stale' }));
    const restarted = await launch(dir); child = restarted.child;
    origin = restarted.descriptor.origin;
    assert.equal(restarted.descriptor.authorityEpoch, identity.authorityEpoch);
    assert.equal(restarted.descriptor.assistantId, identity.assistantId);
    const after = await call('/status');
    assert.equal(after.data.authorityEpoch, restarted.descriptor.authorityEpoch);
    assert.equal((await call('/recall?q=kestrel&limit=10')).data.hits[0].entryId, entry.id);
    assert.equal((await call(`/sessions/${session.id}`)).data.entries[0].text, 'Synthetic host kestrel launch: prepare the release checklist.');
    const persisted = (await call(`/commitments/${commitment.id}`)).data;
    assert.equal(persisted.commitment.status, 'cancelled');
    assert.equal(persisted.commitment.revision, 5);
    const second = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--data-dir', dir, '--web-root', webRoot, '--port', '0']);
    let failure = ''; second.stderr!.on('data', chunk => { failure += String(chunk); }); second.stdout!.resume();
    const [exit] = await once(second, 'exit');
    assert.equal(exit, 1);
    assert.match(failure, /Another process owns this state directory/);
    assert.equal((await call('/sessions')).data.items.length, 1, 'second writer must not reseed');
    await stopProcess(child); child = undefined;
    host = await startHost({ dataDir: dir, webRoot, port: 0 });
    assert.equal(host.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM entries')!.n), 1);
    assert.equal(reminders().filter(row => row.state === 'pending').length, 0, 'restart must not resurrect cancelled reminder');
  } finally { if (child) await stopProcess(child); await host.close(); await rm(dir, { recursive: true, force: true }); }
});

test('host fails fatal configuration/listener/descriptor startup and releases its single writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-failure-'));
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(startHost({ dataDir: join(dir, 'state'), webRoot: join(dir, 'absent'), port: 0 }), /ENOENT/);
    await assert.rejects(stat(join(dir, 'state')), /ENOENT/);
    await assert.rejects(startHost({ dataDir: dir, webRoot, port: -1 }), /Invalid local port/);
    const address = blocker.address() as { port: number };
    await assert.rejects(startHost({ dataDir: dir, webRoot, port: address.port }), /EADDRINUSE/);
    const descriptor = join(dir, 'symlink.json');
    await symlink(join(dir, 'admin-credential'), descriptor);
    await assert.rejects(startHost({ dataDir: dir, webRoot, port: 0, descriptor }), /regular file/);
    const recovered = await startHost({ dataDir: dir, webRoot, port: 0 });
    await recovered.close();
    const help = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--help']);
    let text = ''; help.stdout!.on('data', chunk => { text += String(chunk); }); help.stderr!.resume();
    assert.equal((await once(help, 'exit'))[0], 0);
    assert.match(text, /loopback-only/);
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('supervised actual child reports bounded matching readiness, closes on pipe EOF and preserves data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-supervised-'));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--supervised', '--data-dir', dir, '--web-root', webRoot, '--port', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const output = once(child.stdout!, 'data');
    const nonce = randomUUID();
    child.stdin!.write(`${JSON.stringify({ type: 'start', schemaVersion: 1, nonce })}\n`);
    const [buffer] = await Promise.race([output, once(child, 'exit').then(([code]) => { throw new Error(`Supervised startup exited ${String(code)}: ${stderr}`); })]);
    const text = String(buffer);
    assert.ok(Buffer.byteLength(text) <= 1024);
    assert.ok(text.endsWith('\n')); assert.equal(text.split('\n').length, 2);
    const ready = JSON.parse(text);
    assert.deepEqual(Object.keys(ready).sort(), ['assistantId', 'authorityEpoch', 'nonce', 'origin', 'pid', 'schemaVersion', 'type'].sort());
    assert.equal(ready.type, 'ready'); assert.equal(ready.schemaVersion, 1);
    assert.equal(ready.nonce, nonce); assert.equal(ready.pid, child.pid);
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const descriptor = JSON.parse(await readFile(join(dir, 'host-runtime.json'), 'utf8'));
    assert.equal(ready.origin, descriptor.origin); assert.equal(ready.authorityEpoch, descriptor.authorityEpoch);
    const credential = (await readFile(join(dir, 'admin-credential'), 'utf8')).trim();
    assert.ok(!text.includes(credential));
    const status = await fetch(ready.origin + '/api/v1/status', { headers: { Authorization: `Bearer ${credential}` } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.assistantId, ready.assistantId);
    const saved = await fetch(ready.origin + '/api/v1/sessions', { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Didi-Authority-Epoch': ready.authorityEpoch }, body: JSON.stringify({ title: 'Supervision preserves meaningful session', timeZone: 'UTC' }) });
    assert.equal(saved.status, 200); const sessionId = (await saved.json()).data.id;
    const exited = once(child, 'exit'); child.stdin!.end(); assert.equal((await exited)[0], 0); child = undefined;
    await assert.rejects(fetch(ready.origin + '/health', { signal: AbortSignal.timeout(1000) }));
    const restarted = await launch(dir); child = restarted.child;
    assert.equal(restarted.descriptor.authorityEpoch, ready.authorityEpoch);
    const recalled = await fetch(restarted.descriptor.origin + `/api/v1/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${credential}` } });
    assert.equal(recalled.status, 200); assert.equal((await recalled.json()).data.session.title, 'Supervision preserves meaningful session');
    assert.equal((await stat(join(dir, 'host-runtime.json'))).mode & 0o777, 0o600);
  } finally { if (child) await stopProcess(child); await rm(dir, { recursive: true, force: true }); }
});

test('supervised malformed/oversized/incomplete frames fail before readiness or state creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-bad-frames-'));
  try {
    const frames = ['not-json\n', `${JSON.stringify({ type: 'start', schemaVersion: 1, nonce: '' })}\n`, `${JSON.stringify({ type: 'start', schemaVersion: 1, nonce: randomUUID(), extra: 'not-allowed' })}\n`, `${'x'.repeat(1025)}\n`, JSON.stringify({ type: 'start', schemaVersion: 1, nonce: randomUUID() }), ''];
    for (const [index, frame] of frames.entries()) {
      const dataDir = join(dir, String(index));
      const child = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--supervised', '--data-dir', dataDir, '--web-root', webRoot, '--port', '0']);
      let stdout = '', stderr = '';
      child.stdout!.on('data', chunk => { stdout += String(chunk); }); child.stderr!.on('data', chunk => { stderr += String(chunk); });
      const exited = once(child, 'exit'); child.stdin!.end(frame);
      assert.equal((await exited)[0], 1); assert.equal(stdout, ''); assert.match(stderr, /Supervision|supervision/);
      await assert.rejects(stat(dataDir), /ENOENT/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('canonical HOST symlink --help executes and ordinary module import never starts the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-entry-'));
  const entry = resolve(import.meta.dirname, '../host/index.js');
  const alias = join(dir, 'canonical-host.js');
  const run = async (args: string[]) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DIDI_STATE_DIR: join(dir, 'unexpected-state'), DIDI_WEB_ROOT: webRoot, DIDI_PORT: '0' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
    try { const [code, signal] = await once(child, 'exit'); assert.equal(signal, null, 'Harmless invocation must exit without starting a listener'); assert.equal(code, 0, stderr); return stdout; }
    finally { clearTimeout(timer); }
  };
  try {
    await symlink(entry, alias);
    const url = new URL('../host/index.js', import.meta.url).href;
    assert.equal(await run(['--input-type=module', '--eval', `const host = await import(${JSON.stringify(url)}); if(typeof host.main!=='function') throw Error('Missing host export'); console.log('IMPORTED_WITHOUT_START');`]), 'IMPORTED_WITHOUT_START\n');
    assert.match(await run([alias, '--help']), /Usage: node server\/dist\/host\/index\.js/, 'Actual canonical host must execute --help through a symlink spelling');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ['both', 'existing-live', 'default', 'absent'] as const) {
  test(`host seeds effective config directory: ${scenario}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'didi-host-seed-'));
    const defaults = join(dir, 'provider-config');
    const effective = scenario === 'default' ? defaults : join(dir, 'operator');
    const live = JSON.stringify({ schemaVersion: 1, enabled: false, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary', dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } });
    const mcp = JSON.stringify({ schemaVersion: 1, endpoints: [] });
    const logs: string[] = [];
    t.mock.method(console, 'log', (line: string) => logs.push(line));
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      await mkdir(defaults, { mode: 0o700 });
      if (effective !== defaults) await mkdir(effective, { mode: 0o700 });
      if (scenario !== 'absent') {
        await writeFile(join(defaults, 'live.json'), live, { mode: 0o600 });
        await writeFile(join(defaults, 'mcp.json'), mcp, { mode: 0o600 });
        for (const name of ['gemini-primary.json', 'profile.json', 'admin-credential']) await writeFile(join(defaults, name), 'not a seed', { mode: 0o600 });
      }
      const existingLive = live + '\n';
      if (scenario === 'existing-live') await writeFile(join(effective, 'live.json'), existingLive, { mode: 0o600 });
      host = await startHost({ dataDir: dir, webRoot, configDir: effective, port: 0 });
      for (const name of ['live.json', 'mcp.json']) {
        if (scenario === 'absent') await assert.rejects(readFile(join(effective, name)), { code: 'ENOENT' });
        else {
          assert.equal(await readFile(join(effective, name), 'utf8'), name === 'mcp.json' ? mcp : scenario === 'existing-live' ? existingLive : live);
          assert.equal((await stat(join(effective, name))).mode & 0o777, 0o600);
        }
      }
      assert.equal((await stat(effective)).mode & 0o777, 0o700);
      const seeded = scenario === 'both' ? ['live.json', 'mcp.json'] : scenario === 'existing-live' ? ['mcp.json'] : [];
      assert.deepEqual(logs, seeded.map(name => `config_seeded file=${name} from=provider-config`));
      if (effective !== defaults) for (const name of ['gemini-primary.json', 'profile.json', 'admin-credential']) await assert.rejects(readFile(join(effective, name)), { code: 'ENOENT' });
    } finally { await host?.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

// Real installed endpoint identities and connector kinds, with synthetic transports only.
for (const missingMongoose of [true, false]) {
  test(`real five-endpoint host CREATE composes company readers (mongoose missing=${missingMongoose})`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'didi-real-shape-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = join(dir, 'provider-config');
    await mkdir(config, { mode: 0o700 });
    const tools = [
      'search_knowledge', 'get_insight', 'gmail_get_profile', 'gmail_list', 'gmail_read',
      'gcal_calendars', 'gcal_list', 'mattermost_whoami', 'mattermost_get_channel_history',
      'mattermost_get_thread', 'mattermost_search', 'mattermost_list_channels', 'ask_mongoose',
      'search_mongoose', 'get_knowledge_item', 'read_knowledge_body', 'get_company_profile', 'list_tickets', 'get_ticket',
    ].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
    const reply = (message: { id?: unknown; method: string }) => message.id === undefined ? undefined : {
      jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
        : message.method === 'tools/list' ? { tools } : {},
    };
    const endpoint = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = reply(JSON.parse(Buffer.concat(chunks).toString()));
      if (response && req.url && 'tools' in response.result) {
        const family = req.url.slice(1);
        response.result.tools = tools.filter(tool => family === 'gmail' ? tool.name.startsWith('gmail_') : family === 'calendar' ? tool.name.startsWith('gcal_') : family === 'lux-knowledge' ? ['search_knowledge', 'get_insight'].includes(tool.name) : !tool.name.startsWith('mattermost_') && !tool.name.startsWith('gmail_') && !tool.name.startsWith('gcal_') && !['search_knowledge', 'get_insight'].includes(tool.name));
      }
      res.writeHead(response ? 200 : 202, { 'content-type': 'application/json' });
      res.end(response ? JSON.stringify(response) : undefined);
    });
    endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
    t.after(async () => { endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done())); });
    const address = endpoint.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const child = join(dir, 'fake-mattermost.cjs');
    await writeFile(child, `const tools=${JSON.stringify(tools)}; const reply=${reply.toString()}; require('node:readline').createInterface({input:process.stdin}).on('line', line => { const response=reply(JSON.parse(line)); if(response) console.log(JSON.stringify(response)); });`);
    const http = (id: string, connector: string, credentialRef: string | null = null) => ({ id, connector, transport: 'streamable-http', url: url + '/' + id, account: 'synthetic', resource: id, credentialRef, enabled: true, allowEgress: true });
    await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [
      http('lux-knowledge', 'lux-knowledge'), http('gmail', 'google'), http('calendar', 'google'),
      { id: 'mattermost', connector: 'mattermost', transport: 'stdio', command: process.execPath, args: [child], env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'synthetic', resource: 'mattermost', credentialRef: null, enabled: true, allowEgress: true },
      http('mongoose', 'mongoose', missingMongoose ? 'missing-credential' : null),
    ] }), { mode: 0o600 });
    await writeFile(join(config, 'live.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/live-gateway-test', voice: 'LiveVoice', keyReference: 'gemini-primary', dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' } }), { mode: 0o600 });
    await writeFile(join(config, 'gemini-primary.json'), JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: 'synthetic-test-key' }), { mode: 0o600 });
    const host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
    t.after(() => host.close());
    const headers = { Authorization: `Bearer ${host.store.adminCredential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Didi-Authority-Epoch': host.descriptor.authorityEpoch };
    const status = await fetch(host.descriptor.origin + '/api/v1/tools/status', { headers });
    assert.equal(status.status, 200);
    const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string; tools: number }>;
    assert.deepEqual(reports.map(report => [report.id, report.state, report.tools]).sort(), [
      ['lux-knowledge', 'connected', 2], ['gmail', 'connected', 3], ['calendar', 'connected', 2],
      ['mattermost', 'connected', 5], ['mongoose', missingMongoose ? 'error' : 'connected', missingMongoose ? 0 : 7],
    ].sort());
    const response = await fetch(host.descriptor.origin + '/api/v1/live-sessions', { method: 'POST', headers, body: JSON.stringify({ inputClass: 'ordinary' }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.data.liveSessionId);
    assert.equal(body.data.lifecycle, 'accepted');
  });
}

test('host rejects an unknown connector kind before discovery and names it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-unknown-connector-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'provider-config'); await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ id: 'unknown-endpoint', connector: 'unknown-kind', transport: 'streamable-http', url: 'http://127.0.0.1:1/', account: 'synthetic', resource: 'synthetic', credentialRef: null, enabled: true, allowEgress: true }] }), { mode: 0o600 });
  await assert.rejects(async () => {
    const host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
    await host.close();
  }, error => {
    assert(error instanceof Error);
    assert.equal(error.name, 'ConnectorCompositionError');
    assert.match(error.message, /unknown-endpoint/);
    assert.match(error.message, /unknown-kind/);
    return true;
  });
});
