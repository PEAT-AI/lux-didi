import './memory-eligibility-integration.js';
import './memory-startup-integration.js';
// The declared host check also exercises the real installer's isolated seed block (R5).
import './install-template.test.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostMigrations, installedConfigDirRefusal, pairLocal, selectCalendarEndpoint, startHost, type RuntimeDescriptor } from '../host/runtime.js';
import { createDispatchOwner } from '../tools/dispatch.js';
import { toolsMigrations } from '../tools/schema.js';
import { SUPERVISION_FLAG, supervisionRequested } from '../host/supervision.js';
import { HostLog, safeEvent } from '../host/log.js';
import { Store } from '../runtime/store.js';
import { CalendarDigestCache, WarmContextCache, chooseStartContext, withProvenance } from '../live/warm-context.js';
import { createLiveSessionOwner } from '../live/index.js';
import { loadLiveConfig } from '../config/live.js';
import type { LiveVoicePort } from '../adapters/live-voice/index.js';
import { buildCalendarDigest, CALENDAR_DIGEST_CHARS, type GcalListInput } from '../connectors/google.js';
import type { GoogleEvidence, GoogleResult } from '../connectors/google.js';
import { listenService } from '../http/server.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { EndpointConfig, McpPort } from '../adapters/mcp/port.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

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
    'host/**/*.ts', 'memory/**/*.ts', 'chat/**/*.ts', 'config/**/*.ts', 'adapters/model/**/*.ts', 'adapters/mcp/**/*.ts',
    'adapters/live-voice/**/*.ts', 'connectors/**/*.ts', 'prompt/**/*.ts', 'live/**/*.ts',
    'trace/**/*.ts',
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
  const startup = JSON.parse((await readFile(join(dir, 'logs', 'host.log'), 'utf8')).split('\n')[0]!);
  assert.deepEqual(Object.keys(startup).sort(), ['configDir', 'endpoints', 'event', 'pid', 'releaseCommit', 'timestamp']);
  assert.equal(startup.event, 'host_started');
  assert.equal(startup.releaseCommit, 'unknown');
  assert.equal(startup.configDir, 'seeded');
  assert.equal(startup.endpoints, 0);
  assert.equal(JSON.stringify(startup).includes(dir), false);
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

test('supervised readiness is written before a connector handshake completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-deferred-'));
  let child: ChildProcess | undefined;
  // Accept the connection and never answer: the connector handshake stays blocked for the full
  // discovery budget, so only a host that publishes readiness first can pass the 3 s race.
  const endpoint = createServer(() => { /* deliberately no response */ });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('no port');
  try {
    const config = join(dir, 'provider-config'); await mkdir(config, { mode: 0o700 });
    await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [
      { id: 'gmail', connector: 'google', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/gmail`, account: 'synthetic', resource: 'gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' },
    ] }), { mode: 0o600 });
    child = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--supervised', '--data-dir', dir, '--config-dir', config, '--web-root', webRoot, '--port', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const output = once(child.stdout!, 'data');
    child.stdin!.write(`${JSON.stringify({ type: 'start', schemaVersion: 1, nonce: randomUUID() })}\n`);
    const budget = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('readiness frame missed the 3 s budget')), 3_000); });
    const [buffer] = await Promise.race([output, once(child, 'exit').then(([code]) => { throw new Error(`Supervised startup exited ${String(code)}: ${stderr}`); }), budget]);
    const ready = JSON.parse(String(buffer).trim()) as { type: string };
    assert.equal(ready.type, 'ready');
  } finally {
    if (child) await stopProcess(child);
    await new Promise<void>(resolveClose => endpoint.close(() => resolveClose()));
    await rm(dir, { recursive: true, force: true });
  }
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
      if (scenario === 'both' || scenario === 'existing-live') {
        const diagnostics = await readFile(join(dir, 'logs', 'host.log'), 'utf8');
        assert.match(diagnostics, /"event":"config_seeded"/);
        assert.ok(!diagnostics.includes('SECRET'));
      }

      for (const name of ['live.json', 'mcp.json']) {
        if (scenario === 'absent') await assert.rejects(readFile(join(effective, name)), { code: 'ENOENT' });
        else {
          assert.equal(await readFile(join(effective, name), 'utf8'), name === 'mcp.json' ? mcp : scenario === 'existing-live' ? existingLive : live);
          assert.equal((await stat(join(effective, name))).mode & 0o777, 0o600);
        }
      }
      assert.equal((await stat(effective)).mode & 0o777, 0o700);
      const seeded = scenario === 'both' ? ['live.json', 'mcp.json'] : scenario === 'existing-live' ? ['mcp.json'] : [];
      const seedRecords = (await readFile(join(dir, 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.includes('config_seeded')).map(line => JSON.parse(line).file);
      assert.deepEqual(seedRecords, seeded);
      assert.deepEqual(logs, [], 'host stdout is reserved for JSON protocol frames');
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
    const http = (id: string, connector: string, credentialRef: string | null = null) => ({ id, connector, transport: 'streamable-http', url: url + '/' + id, account: 'synthetic', resource: id, credentialRef, enabled: true, allowEgress: true, unknownClass: 'ordinary' });
    await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [
      http('lux-knowledge', 'lux-knowledge'), http('gmail', 'google'), http('calendar', 'google'),
      { id: 'mattermost', connector: 'mattermost', transport: 'stdio', command: process.execPath, args: [child], env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'synthetic', resource: 'mattermost', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' },
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
  await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ id: 'unknown-endpoint', connector: 'unknown-kind', transport: 'streamable-http', url: 'http://127.0.0.1:1/', account: 'synthetic', resource: 'synthetic', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }] }), { mode: 0o600 });
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

// Small limits exercise the production rotation algorithm without producing host load.
test('durable diagnostics rotate privately and persist only safe structured events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'didi-log-'));
  try {
    const log = new HostLog(root, 220);
    for (let n = 0; n < 12; n++) log.event({ event: 'config_seeded', file: 'providers.json', from: 'provider-config' });
    log.event({ event: 'live_attach_rejected', code: 'internal', message: 'SECRET-message', bearer: 'SECRET-bearer', key: 'SECRET-key' });
    for (const name of ['host.log', 'host.log.1', 'host.log.2']) {
      const path = join(root, 'logs', name);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const text = await readFile(path, 'utf8');
      assert.ok(!text.includes('SECRET'));
      for (const line of text.trim().split('\n')) {
        const record = JSON.parse(line);
        assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
        assert.equal(record.pid, process.pid);
        assert.ok(['config_seeded', 'live_attach_rejected'].includes(record.event));
      }
      assert.ok(Buffer.byteLength(text) <= 220);
    }
    const newest = await readFile(join(root, 'logs', 'host.log'), 'utf8');
    assert.match(newest, /live_attach_rejected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host diagnostics admit the release 3c metadata-only events and strip free text', () => {
  const researchId = '3f2a9c1e-0b7d-4a2f-9c3e-1d2b3a4c5d6e';
  const run = { event: 'research_run', researchId, questionClass: 'quick_fact', rounds: 2, perRound: [{ candidates: [{ kind: 'calendar_window', pUseful: 0.6 }], chosen: ['calendar_window'] }], stopReason: 'answered', status: 'answered', ops: 3, sources: [{ kind: 'calendar', disposition: 'completed', latencyMs: 12 }], elapsedMs: 120, deadAirMs: 5, selectorMs: 20, fallbackUsed: false, replyBytes: 340, driver: 'selector', unchecked: ['mail'], canContinue: true, findingChars: [12] };
  assert.deepEqual(safeEvent(run), run);
  // #260: the three drivers are admitted as an enum; the run line keeps the field it was given.
  for (const driver of ['selector', 'fallback', 'single-source-hint']) {
    assert.deepEqual(safeEvent({ ...run, driver }), { ...run, driver });
  }
  assert.deepEqual(safeEvent({ event: 'research_progress', researchId, phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail'], elapsedMs: 9 }), { event: 'research_progress', researchId, phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail'], elapsedMs: 9 });
  assert.deepEqual(safeEvent({ event: 'live_interrupted', liveSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', turnCompleteSeen: true, msSinceLastModelAudio: 42 }), { event: 'live_interrupted', liveSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', turnCompleteSeen: true, msSinceLastModelAudio: 42 });
  assert.deepEqual(safeEvent({ event: 'live_dead_air', deadAirMs: 1500 }), { event: 'live_dead_air', deadAirMs: 1500 });
  assert.deepEqual(safeEvent({ event: 'live_tool_turn', sequence: 3, toolCallsThisTurn: 2, toolLatencyMs: [{ tool: 'research', ms: 30 }], toolResponseWhileGenerating: false }), { event: 'live_tool_turn', sequence: 3, toolCallsThisTurn: 2, toolLatencyMs: [{ tool: 'research', ms: 30 }], toolResponseWhileGenerating: false });
  assert.deepEqual(safeEvent({ event: 'tool_cancelled', tool: 'research', id: 'r1~0~calendar_window', msInFlight: null }), { event: 'tool_cancelled', tool: 'research', id: 'r1~0~calendar_window', msInFlight: null });
  // Each closed case refuses a free-text field instead of forwarding it.
  assert.equal(safeEvent({ ...run, question: 'owner secret' }), undefined);
  assert.equal(safeEvent({ ...run, stopReason: 'owner secret' }), undefined);
  assert.equal(safeEvent({ ...run, driver: 'owner secret' }), undefined);
  assert.equal(safeEvent({ ...run, driver: 'single_source_hint' }), undefined);
  const withoutDriver: Record<string, unknown> = { ...run };
  delete withoutDriver.driver;
  assert.deepEqual(safeEvent(withoutDriver), withoutDriver);
  assert.equal(safeEvent({ event: 'research_progress', researchId, phase: 'round', sourcesDone: ['calendar'], sourcesPending: [], elapsedMs: 9, summary: 'owner secret' }), undefined);
  assert.equal(safeEvent({ event: 'live_dead_air', deadAirMs: 1500, text: 'owner secret' }), undefined);
  assert.equal(safeEvent({ event: 'live_tool_turn', sequence: 3, toolCallsThisTurn: 2, toolLatencyMs: [{ tool: 'research', ms: 30, args: 'owner secret' }], toolResponseWhileGenerating: false }), undefined);
  assert.equal(safeEvent({ event: 'live_interrupted', liveSessionId: 'owner secret', turnCompleteSeen: true, msSinceLastModelAudio: 42 }), undefined);
});

test('provider terminal diagnostics retain only bounded class and code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'didi-terminal-log-'));
  try {
    const log = new HostLog(root);
    log.terminal({ state: 'closed', code: 'closed', message: 'SECRET-clean-close' });
    for (const code of ['provider_setup_rejected', 'protocol_error']) log.terminal({ state: 'failed', code, message: 'SECRET-provider' });
    log.terminal({ state: 'failed', code: 'SECRET invalid code' });
    const text = await readFile(join(root, 'logs', 'host.log'), 'utf8');
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.map(({ event, class: kind, state, code }) => ({ event, ...(kind === undefined ? {} : { class: kind }), ...(state === undefined ? {} : { state }), code })), [
      { event: 'live_terminal', state: 'closed', code: 'closed' },
      ...['provider_setup_rejected', 'protocol_error'].map(code => ({ event: 'host_error', class: 'LiveTerminal', code })),
    ]);
    assert.ok(!text.includes('SECRET'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Live session diagnostics persist only the closed content-free counter schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'didi-live-diagnostics-log-'));
  try {
    const log = new HostLog(root);
    const numeric = ['adapterGenerations','ownerAudioCalls','ownerAudioBytes','ownerRebuildingDropCalls','ownerRebuildingDropBytes',
      'adapterAudioCalls','adapterAudioBytes','drainingDropCalls','drainingDropBytes',
      'localWriteEnqueuedCalls','localWriteEnqueuedPCMBytes','localWriteCallbackSuccessCalls','localWriteCallbackSuccessPCMBytes',
      'localWriteCallbackErrorCalls','localWriteCallbackErrorPCMBytes','localWriteCallbackPendingCalls','localWriteCallbackPendingPCMBytes',
      'inputTranscriptionEvents','inputTranscriptionCharacters','generationCompleteEvents','turnCompleteEvents','outputAudioFrames','outputAudioPCMBytes',
      'outputAudioAfterInitialTurnFrames','outputAudioAfterInitialTurnPCMBytes','headVoiceChars','terminalVoiceChars'];
    const event = Object.fromEntries(numeric.map((key, index) => [key, index]));
    log.event({ event: 'live_session_diagnostics', terminalCode: 'client_closed', ...event });
    log.event({ event: 'live_session_diagnostics', terminalCode: 'client_closed', ...event, text: 'SECRET-transcript' });
    const text = await readFile(join(root, 'logs', 'host.log'), 'utf8');
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1); assert.equal(records[0].event, 'live_session_diagnostics');
    assert.equal(records[0].terminalCode, 'client_closed'); assert.equal(records[0].outputAudioPCMBytes, numeric.indexOf('outputAudioPCMBytes'));
    assert.equal(text.includes('SECRET'), false); assert.equal('liveSessionId' in records[0], false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connector failure stages persist as one closed safe event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'didi-log-'));
  try {
    const log = new HostLog(root);
    log.event({ event: 'connector_failure', connector: 'mongoose', stage: 'handshake' });
    log.event({ event: 'connector_failure', connector: 'mongoose', stage: 'SECRET-stage' });
    log.event({ event: 'connector_failure', connector: 'mongoose', stage: 'handshake', message: 'SECRET-message' });
    const text = await readFile(join(root, 'logs', 'host.log'), 'utf8');
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'connector_failure');
    assert.equal(records[0].connector, 'mongoose');
    assert.equal(records[0].stage, 'handshake');
    assert.equal(text.includes('SECRET'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A stdio MCP child that answers initialize/tools/list, then ignores the MCP close and stdin EOF.
const IGNORE_CLOSE_CHILD = [
  "import readline from 'node:readline';",
  "import { writeFileSync } from 'node:fs';",
  "const pidFile = process.argv[2];",
  "if (pidFile) writeFileSync(pidFile, String(process.pid));",
  "const rl = readline.createInterface({ input: process.stdin });",
  "rl.on('line', line => {",
  "  let msg; try { msg = JSON.parse(line); } catch { return; }",
  "  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
  "  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ignore-close', version: '1' } } });",
  "  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object' } }] } });",
  "  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });",
  "});",
  "setInterval(() => {}, 1000);",
].join('\n');

function childAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function childDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!childAlive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  return !childAlive(pid);
}

test('host close kills a stdio MCP child that ignores close within the bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-host-mcp-kill-'));
  const script = join(dir, 'ignore-close.mjs');
  const pidFile = join(dir, 'child.pid');
  writeFileSync(script, IGNORE_CLOSE_CHILD);
  const registry = new McpRegistry();
  const endpoint = {
    id: 'local-stdio', transport: 'stdio', command: process.execPath, args: [script, pidFile],
    env: { PATH: process.env.PATH ?? '/usr/bin', HOME: dir, LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    account: 'local', resource: 'stdio-fixture',
  } as unknown as EndpointConfig;
  registry.register(endpoint); registry.enable('local-stdio'); registry.allowEgress('local-stdio');
  const adapter: McpPort = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 2000 } });
  try {
    assert.equal((await adapter.discover('local-stdio')).state, 'discovered');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(childAlive(pid), true, 'the child is alive while the endpoint is in use');
    const started = Date.now();
    await adapter.close();
    assert.ok(Date.now() - started < 1500, 'close must return within its bound even when the child ignores it');
    assert.equal(await childDead(pid, 800), true, 'the child is killed after the bound, so the host can exit');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

// #397: a host started with another --config-dir must journal into its own --data-dir, and a host outside
// the installed app must never adopt the installed app's folder as its config source.
test('a host writes no debug journal under any data dir or config dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-journal-root-'));
  const dataDir = join(dir, 'state');
  const configDir = join(dir, 'other-install', 'provider-config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  const host = await startHost({ dataDir, configDir, webRoot, port: 0 });
  try {
    // O1b-A: the JSONL debug journal is gone, so a host start creates no debug/ directory anywhere; the
    // per-turn record lives in state.sqlite's trace tables.
    await assert.rejects(stat(join(dataDir, 'debug')), /ENOENT/, 'no journal root under the data dir');
    await assert.rejects(stat(join(dir, 'other-install', 'debug')), /ENOENT/, 'nothing is written beside the borrowed config dir');
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});

// #487: the retired JSONL debug journal is unread and unremoved on 4282b639 (282 files, 8.2 MB of transcripts).
// One bounded start-up step removes exactly `<dataDir>/debug` and logs one byte-counted receipt; the second
// start finds nothing and logs nothing.
test('a start removes the retired debug journal once and logs one byte-counted receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-debug-retired-'));
  const dataDir = join(dir, 'state');
  const journal = join(dataDir, 'debug', '2026-10-17');
  await mkdir(journal, { recursive: true, mode: 0o700 });
  await writeFile(join(journal, 'session-a.jsonl'), 'x'.repeat(700));
  await writeFile(join(journal, 'session-b.jsonl'), 'y'.repeat(300));
  await writeFile(join(dataDir, 'keep-me.txt'), 'kept');
  try {
    const first = await startHost({ dataDir, webRoot, port: 0 });
    const receipts = async (): Promise<Record<string, unknown>[]> =>
      (await readFile(join(dataDir, 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'debug_journal_removed')
        .map(line => ({ bytes: line.bytes, event: line.event }));
    try {
      await assert.rejects(stat(join(dataDir, 'debug')), /ENOENT/, 'the retired journal is gone');
      assert.equal(await readFile(join(dataDir, 'keep-me.txt'), 'utf8'), 'kept', 'nothing else in the data dir is touched');
      assert.deepEqual(await receipts(), [{ event: 'debug_journal_removed', bytes: 1000 }], 'one receipt carries the byte count');
    } finally { await first.close(); }

    const second = await startHost({ dataDir, webRoot, port: 0 });
    try {
      assert.equal((await receipts()).length, 1, 'a second start finds no journal and writes no second receipt');
    } finally { await second.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Reviewer R1: a sweep the host cannot finish is one closed receipt and never a refused start. A
// read-only directory under debug/ is the owner's file system, not a reason to keep the app closed.
test('an unremovable debug directory logs one closed receipt and never aborts the start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-debug-stuck-'));
  const dataDir = join(dir, 'state');
  const stuck = join(dataDir, 'debug', 'locked');
  await mkdir(stuck, { recursive: true, mode: 0o700 });
  await writeFile(join(stuck, 'session.jsonl'), 'x'.repeat(10));
  await chmod(stuck, 0o500);
  try {
    const host = await startHost({ dataDir, webRoot, port: 0 });
    try {
      const lines = (await readFile(join(dataDir, 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      const failed = lines.filter(line => line.event === 'debug_journal_removal_failed').map(line => ({ code: line.code, event: line.event }));
      assert.deepEqual(failed, [{ code: 'eacces', event: 'debug_journal_removal_failed' }], 'one closed receipt names the errno token');
      await stat(join(dataDir, 'debug'));
      assert.equal(lines.filter(line => line.event === 'host_started').length, 1, 'the start itself went ahead');
    } finally { await host.close(); }
  } finally {
    await chmod(stuck, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// #479 / H4: a call made with no tool context (the start-up connector probes) used to arm a diagnostic
// capture, so every start wrote four `context_absent` and four `wire_observed_context_absent` receipts,
// three of them byte-identical. The audit row stays; the receipt is armed only with a real run context.
test('a tool call with no run context arms no diagnostic capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-no-context-'));
  const store = new Store(dir, [...toolsMigrations]);
  try {
    const captured: string[] = [];
    const port = {
      async call() { return { state: 'completed' as const, content: [{ type: 'text' as const, text: 'ok' }], isError: false }; },
    };
    const owner = createDispatchOwner({
      store, port: port as never, ownerId: store.assistantId,
      current: () => true, failure: reason => { captured.push(reason); },
    });
    const result = await owner.port.call({ toolName: 'gmail_get_profile', arguments: {}, connectionId: 'gmail', class: 'ordinary' } as never);
    assert.equal((result as { state?: string }).state, 'completed', 'the probe still reaches the connector');
    assert.deepEqual(captured, [], 'no diagnostic capture without a context');
    const coverage = store.transaction(tx => tx.all('SELECT kind, reason, run_id FROM tool_dispatch_coverage'));
    assert.deepEqual(coverage.map(row => [row.kind, row.reason, row.run_id]), [['unattributed', 'dispatch_unknown_context_absent', null]], 'the audit row still records the context-free call');
    owner.reuse(undefined);
    assert.deepEqual(captured, [], 'reuse without a context captures nothing either');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the installed app config dir is refused with one line naming --data-dir, and supervision lifts it', () => {
  const installed = join(homedir(), 'Library', 'Application Support', 'ai.peat.lux-didi', 'provider-38');
  const refusal = installedConfigDirRefusal(installed, false);
  assert.equal(typeof refusal, 'string');
  assert.ok(!refusal!.includes('\n'), 'one line, not a paragraph');
  assert.match(refusal!, /--data-dir/);
  assert.match(refusal!, /installed app/);
  assert.equal(installedConfigDirRefusal(join(installed, 'nested'), false), refusal!.replace(installed, join(installed, 'nested')));
  assert.equal(installedConfigDirRefusal(installed, true), undefined, 'the installed app supervised host keeps its own config dir');
  assert.equal(installedConfigDirRefusal('/tmp/synthetic/provider-config', false), undefined, 'any other config dir stays allowed');
  assert.equal(installedConfigDirRefusal(join(homedir(), 'Library', 'Application Support', 'ai.peat.lux-didi-other'), false), undefined);
  // The refusal is keyed off the named supervision marker, not a literal repeated in this file.
  assert.equal(supervisionRequested(['node', 'host/index.js', SUPERVISION_FLAG]), true);
  assert.equal(supervisionRequested(['node', 'host/index.js', '--data-dir', '/tmp/x']), false);
});

test('the entry refuses to start an unsupervised host on the installed app config dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-refuse-'));
  const dataDir = join(dir, 'state');
  try {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--data-dir', dataDir, '--web-root', webRoot, '--port', '0',
      '--config-dir', join(homedir(), 'Library', 'Application Support', 'ai.peat.lux-didi', 'provider-38')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /--data-dir/, 'the refusal names the flag to use instead');
    assert.match(stderr, /installed app/);
    assert.equal(stderr.trimEnd().split('\n').length, 1, 'the refusal is one loud line');
    await assert.rejects(stat(join(dataDir, 'state.sqlite')), /ENOENT/, 'the refused start opens no state');
    await assert.rejects(stat(join(dataDir, 'debug')), /ENOENT/, 'the refused start installs no journal');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 338: the owner prewarm instruction. The handle answers the receipt the app records, and the closed
// host-log line is the live owner's, so an unconfigured Live writes none.
test('the host owner prewarm answers the quiet receipt when Live is unconfigured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-prewarm-'));
  const host = await startHost({ dataDir: dir, webRoot, port: 0 });
  try {
    const receipt = await host.prewarm();
    assert.deepEqual(receipt, { ageBeforeMs: null, ageAfterMs: null, assembled: false, reason: 'unconfigured' }, 'no session has prepared sections yet');
    const lines = (await readFile(join(dir, 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.filter(line => line['event'] === 'warm_prewarm').length, 0, 'no warm owner, so no receipt line');
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});

// 338: the owner's HTTP route for the same instruction (R3-R1). A wake belongs to no session, so it is
// answered before the enabled gate; only the operator bearer may ask, and the body names no field.
test('POST api/v1/live/prewarm answers the receipt and refuses a body field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-prewarm-route-'));
  const host = await startHost({ dataDir: dir, webRoot, port: 0 });
  const credential = (await readFile(join(dir, 'admin-credential'), 'utf8')).trim();
  const headers = { Authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'x-didi-authority-epoch': host.store.authorityEpoch };
  try {
    const url = `${host.service.origin}/api/v1/live/prewarm`;
    const asked = await fetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal(asked.status, 200);
    const answered = await asked.json() as { data: unknown };
    assert.deepEqual(answered.data, { ageBeforeMs: null, ageAfterMs: null, assembled: false });
    const unknown = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ digest: 'x' }) });
    assert.equal(unknown.status, 400, 'the body is closed: it names no field');
    const read = await fetch(url, { method: 'GET', headers });
    assert.equal(read.status, 405, 'it is a mutation, never a read');
    const anonymous = await fetch(url, { method: 'POST' });
    assert.equal(anonymous.status, 401, 'only the operator may ask');
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a forced warm refresh carries the calendar digest and the next start reads no source again', () => {
  const sections = { persona: 'Naya is the owner\'s assistant.', memory: ['Prefers morning calls'],
    summary: 'Yesterday: release planning.', calendar: '10:00 standup, 15:00 review.' };
  const calls = { persona: 0, memory: 0, summary: 0, calendar: 0 };
  let now = 1_000;
  const cache = new WarmContextCache({ budget: 4_000, now: () => now, sources: {
    persona: () => { calls.persona += 1; return sections.persona; },
    memory: () => { calls.memory += 1; return sections.memory; },
    summary: () => { calls.summary += 1; return sections.summary; },
    calendar: () => { calls.calendar += 1; return sections.calendar; },
  } });
  assert.equal(cache.ageMs, undefined, 'nothing is assembled until a refresh asks for it');
  const forced = cache.refresh(true);
  assert.equal(forced?.sections.calendar, sections.calendar, 'the digest the owner read is in the assembly');
  assert.match(forced?.text ?? '', /Today: 10:00 standup, 15:00 review\./);
  assert.deepEqual(calls, { persona: 1, memory: 1, summary: 1, calendar: 1 }, 'one read per source per assembly');
  now += 5;
  cache.refresh(true);
  assert.deepEqual(calls, { persona: 2, memory: 2, summary: 2, calendar: 2 }, 'a forced refresh assembles again');
  assert.equal(cache.ageMs, 0, 'the receipt ages run from the forced assembly');
  let assembled = 0;
  const start = chooseStartContext(cache.take(), () => { assembled += 1; return { ...sections, summaryIds: [], summaryOmitted: [] }; });
  assert.equal(start.warm, true, 'the forced assembly is what the next start takes');
  assert.equal(assembled, 0, 'the store is not read a second time');
  assert.equal(start.sections.calendar, sections.calendar);
});

// 339: the warm context's calendar digest. One bounded primary-calendar read, local host time, no
// model call; unconfigured, empty or failed leaves the slot out so a session start never fails.
type DigestReader = { calls: GcalListInput[]; gcalList(input: GcalListInput): Promise<GoogleResult> };
function digestReader(events: readonly Record<string, unknown>[] | 'refused'): DigestReader {
  const calls: GcalListInput[] = [];
  return {
    calls,
    async gcalList(input: GcalListInput): Promise<GoogleResult> {
      calls.push(input);
      if (events === 'refused') return { state: 'refused', reason: 'tool-not-granted' };
      const evidence: GoogleEvidence = {
        state: 'completed', tool: 'gcal_list', observedAt: 1_760_000_000_000,
        decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data: { events: [...events] } }) }] },
        source: {} as GoogleEvidence['source'], coverage: {} as GoogleEvidence['coverage'],
        projection: {} as GoogleEvidence['projection'], response: {} as GoogleEvidence['response'],
      };
      return evidence;
    },
  };
}
const digestNow = Date.parse('2026-10-18T10:00:00Z');
const digestEvent = { id: 'e1', summary: 'standup', start: { dateTime: '2026-10-18T09:00:00Z' }, end: { dateTime: '2026-10-18T09:15:00Z' } };

test('the warm calendar digest leaves the slot out when the connector is unconfigured', async () => {
  assert.equal(await buildCalendarDigest(undefined, { now: digestNow, timeZone: 'UTC' }), undefined);
});

test('the warm calendar digest reads the primary calendar once and renders the empty day as absent', async () => {
  const read = digestReader([]);
  assert.equal(await buildCalendarDigest(read, { now: digestNow, timeZone: 'UTC' }), undefined);
  assert.equal(read.calls.length, 1, 'exactly one bounded read');
  assert.equal(read.calls[0]!.calendarId, 'primary', 'the primary calendar only');
  assert.equal(read.calls[0]!.timeMin, '2026-10-18T00:00:00+00:00');
  assert.equal(read.calls[0]!.timeMax, '2026-10-19T00:00:00+00:00');
  assert.equal(read.calls[0]!.maxResults, 10);
});

test('the warm calendar digest keeps one bounded line and trims a day that does not fit', async () => {
  const busy = Array.from({ length: 30 }, (_, index) => ({ id: 'e' + index, summary: 'review with the whole team ' + index, start: { dateTime: '2026-10-18T0' + (index % 10) + ':00:00Z' } }));
  const digest = await buildCalendarDigest(digestReader(busy), { now: digestNow, timeZone: 'UTC' });
  assert.equal(typeof digest, 'string');
  assert.ok((digest ?? '').length <= CALENDAR_DIGEST_CHARS, 'the digest never exceeds the bound');
  assert.match(digest ?? '', /^00:00 review with the whole team 0/, 'the first event keeps its local clock time');
  assert.match(digest ?? '', /team 10$/, 'the last event that fits is kept whole');
  assert.equal((digest ?? '').endsWith(', '), false, 'a trimmed digest never ends on a separator');
});

test('the warm calendar digest renders the day in the host time zone', async () => {
  const utc = await buildCalendarDigest(digestReader([digestEvent]), { now: digestNow, timeZone: 'UTC' });
  const kolkata = await buildCalendarDigest(digestReader([digestEvent]), { now: digestNow, timeZone: 'Asia/Kolkata' });
  assert.equal(utc, '09:00 standup');
  assert.equal(kolkata, '14:30 standup', 'the same instant, the host zone');
  assert.equal(await buildCalendarDigest(digestReader('refused'), { now: digestNow, timeZone: 'UTC' }), undefined,
    'a refused read leaves the slot out rather than failing the start');
});

// 338: the receipt the host log keeps is two ages and one flag, never the calendar it read.
test('warm_prewarm keeps two ages and one flag, and nothing the calendar carried', () => {
  const receipt = { event: 'warm_prewarm', ageBeforeMs: 1_000, ageAfterMs: 0, assembled: true };
  assert.deepEqual(safeEvent(receipt), receipt);
  assert.deepEqual(safeEvent({ event: 'warm_prewarm', ageBeforeMs: null, ageAfterMs: null, assembled: false }),
    { event: 'warm_prewarm', ageBeforeMs: null, ageAfterMs: null, assembled: false }, 'no assembly yet is a valid receipt');
  assert.equal(safeEvent({ event: 'warm_prewarm', ageBeforeMs: 1_000, ageAfterMs: 0, assembled: true, reason: 'sources' }), undefined,
    'the closed reason is on the receipt the caller holds, not on this line');
  assert.equal(safeEvent({ ...receipt, digest: '10:00 standup with the board' }), undefined, 'the calendar text never reaches the log');
  assert.equal(safeEvent({ ...receipt, ageAfterMs: -1 }), undefined, 'a negative age is refused');
  assert.equal(safeEvent({ ...receipt, assembled: 'yes' }), undefined, 'the flag is a boolean');
  assert.equal(safeEvent({ event: 'warm_prewarm', assembled: true }), undefined, 'both ages are always present');
});

// F9: a forced refresh of the sections a start chose keeps the summary provenance they were chosen
// with, so `conversation_summary_injection` still accounts for what the start injected.
test('a forced refresh keeps the summary provenance the start recorded', () => {
  const previous = { persona: 'Naya is the owner\'s assistant.', memory: [] as readonly string[],
    summary: 'Yesterday: release planning.', summaryIds: ['summary-17'] as readonly string[],
    summaryOmitted: [{ id: 'summary-03', reason: 'budget' as const }], calendar: '09:00 old window' };
  const cache = new WarmContextCache({ budget: 4_000, now: () => 0 });
  const refreshed = cache.adopt(withProvenance({ ...previous, calendar: '10:00 standup' }, previous));
  assert.deepEqual(refreshed?.sections.summaryIds, ['summary-17'], 'the injected ids survive the refresh');
  assert.deepEqual(refreshed?.sections.summaryOmitted, [{ id: 'summary-03', reason: 'budget' }]);
  assert.match(refreshed?.text ?? '', /Today: 10:00 standup/, 'the digest the owner read replaces the old one');
  assert.match(refreshed?.text ?? '', /Recent conversation: Yesterday: release planning\./);
});

// 1015: the host's digest owner as the live owner sees it, backed by a fake and counting the refreshes a
// wake asks for. A start answers from the cache it already holds, so it dispatches nothing.
function digestPort(now: () => number, onRead: () => void) {
  return {
    forStart: async () => ({ state: 'present' as const, text: '10:00 standup, 15:00 review', items: 2, fetchedAt: now() }),
    refresh: onRead,
  };
}

// F4 and R3-R5 at the owner: the digest is read once for each assembly, the prewarm assembles the
// sections a start prepared, and the receipt carries the real ages instead of the degenerate nulls.
test('the owner prewarm assembles after a start without forcing a cached digest read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-owner-prewarm-'));
  const store = new Store(dir, hostMigrations);
  const configDir = join(dir, 'provider-config');
  let clock = 1_760_000_000_000;
  let reads = 0;
  const cleanup = async () => { store.close(); await rm(dir, { recursive: true, force: true }); };
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
      dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } };
    await writeFile(join(configDir, 'live.json'), `${JSON.stringify(live)}\n`, { mode: 0o600 });
    const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId });
    assert.equal(loaded.status, 'configured');
    if (loaded.status !== 'configured') throw new Error('live.json must configure');
    const owner = createLiveSessionOwner({
      store, voice: {} as LiveVoicePort, profile: loaded.config.profile, now: () => clock, timeZone: 'UTC',
      calendarDigest: digestPort(() => clock, () => { reads += 1; }),
    } as unknown as Parameters<typeof createLiveSessionOwner>[0]);
    const context = { clientId: 'owner-fixture', auditId: randomUUID(), authorityEpoch: store.authorityEpoch };
    await owner.prepareCalendar();
    assert.equal(reads, 0, '1015: a start answers from the cached digest and dispatches no read');
    owner.create({ idempotencyKey: 'k1', inputClass: 'ordinary' }, context);
    clock += 60_000;
    const receipt = await owner.prewarm();
    assert.equal(reads, 0, 'the wake uses the existing digest freshness owner');
    assert.deepEqual(receipt, { ageBeforeMs: 60_000, ageAfterMs: 0, assembled: true, reason: 'sections' }, 'the receipt carries the real ages');
    await owner.shutdown();
  } finally { await cleanup(); }
});

// 1015: the state the host's cache reached is what a call start reports. A failing or cut-off read used to
// reach the assembly as an empty day, which is why every state below is asserted separately.
test('1015: a start reports the digest state the cache reached and never folds a failure into empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-digest-state-'));
  const store = new Store(dir, hostMigrations);
  const configDir = join(dir, 'provider-config');
  const clock = { now: Date.parse('2026-10-19T04:00:00Z') };
  const cleanup = async () => { store.close(); await rm(dir, { recursive: true, force: true }); };
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
      dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } };
    await writeFile(join(configDir, 'live.json'), `${JSON.stringify(live)}\n`, { mode: 0o600 });
    const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId });
    if (loaded.status !== 'configured') throw new Error('live.json must configure');
    const start = async (read: () => Promise<{ state: 'present' | 'empty' | 'failed' | 'timeout' | 'unconfigured'; text: string | undefined; items: number; fetchedAt: number }>) => {
      const cache = new CalendarDigestCache(read, { now: () => clock.now, timeZone: 'UTC' });
      const owner = createLiveSessionOwner({ store, voice: {} as LiveVoicePort, profile: loaded.config.profile,
        now: () => clock.now, timeZone: 'UTC', calendarDigest: cache } as unknown as Parameters<typeof createLiveSessionOwner>[0]);
      try { await cache.refresh(); return { snapshot: await owner.prepareCalendar(), cache }; } finally { await owner.shutdown(); }
    };
    const present = await start(async () => ({ state: 'present', text: '09:30 standup', items: 1, fetchedAt: clock.now }));
    assert.equal(present.snapshot.state, 'present');
    assert.equal(present.snapshot.text, '09:30 standup', 'a present digest is what the assembly carries');
    assert.equal(present.snapshot.items, 1);
    assert.equal((await start(async () => ({ state: 'empty', text: undefined, items: 0, fetchedAt: clock.now }))).snapshot.state, 'empty', 'a truly empty day is empty');
    assert.equal((await start(async () => { throw new Error('connector down'); })).snapshot.state, 'failed', 'a failed read is not an empty day');
    assert.equal((await start(async () => ({ state: 'timeout', text: undefined, items: 0, fetchedAt: clock.now }))).snapshot.state, 'timeout', 'nor is a cut-off one');
    // A digest over 30 minutes old answers a start as stale, with its own age and no text. The owner stores
    // the snapshot state verbatim, which is what puts stale on the receipt; the cache mechanics that
    // produce it are pinned in warm-context.test.ts through forStart, the same call this path makes.
    const stalePort = { forStart: async () => ({ state: 'stale' as const, text: undefined, items: 0, fetchedAt: clock.now - 31 * 60 * 1000 }),
      refresh: () => {} };
    const staleOwner = createLiveSessionOwner({ store, voice: {} as LiveVoicePort, profile: loaded.config.profile,
      now: () => clock.now, timeZone: 'UTC', calendarDigest: stalePort } as unknown as Parameters<typeof createLiveSessionOwner>[0]);
    try {
      const aged = await staleOwner.prepareCalendar();
      assert.equal(aged.state, 'stale', 'a digest over 30 minutes old reaches the receipt as stale');
      assert.equal(aged.text, undefined, 'and its text never rides the assembly');
    } finally { await staleOwner.shutdown(); }
  } finally { await cleanup(); }
});
// R7: mail and calendar are both `connector: google`, so the first google endpoint is not the calendar
// endpoint. The digest reads the endpoint whose current grant carries gcal_list.
test('R7: the calendar digest selects the google endpoint by its gcal_list grant', () => {
  const grant = { endpointId: 'gmail', account: 'owner@example.test', resource: 'mail', schemaDigest: 's', toolNames: ['gmail_search'], effect: 'read' as const, generation: 1 };
  const grants: Record<string, typeof grant> = { gmail: grant, gcal: { ...grant, endpointId: 'gcal', resource: 'calendar', toolNames: ['gcal_list'] } };
  const both = [{ id: 'gmail', connector: 'google' }, { id: 'gcal', connector: 'google' }];
  assert.equal(selectCalendarEndpoint(both, id => grants[id])?.endpointId, 'gcal', 'mail listed first never wins');
  assert.equal(selectCalendarEndpoint([...both].reverse(), id => grants[id])?.endpointId, 'gcal', 'and the order does not matter');
  assert.equal(selectCalendarEndpoint(both, () => undefined), undefined, 'no current grant, no reader');
  assert.equal(selectCalendarEndpoint([{ id: 'gmail', connector: 'google' }], id => grants[id]), undefined,
    'a mail-only google connector leaves the slot out');
  assert.equal(selectCalendarEndpoint([{ id: 'gcal', connector: 'calendar' }], id => grants[id]), undefined,
    'a non-google connector is never the digest reader');
});

// R7, 1015: a suppressed, failed, cut-off or old digest used to be silent or read as an empty day. The
// receipt is closed over the six states and carries no event text.
test('R7: calendar_digest is one closed receipt over six states, with no event text', () => {
  const receipt = { event: 'calendar_digest', state: 'present', items: 2, ageMs: 60_000 };
  assert.deepEqual(safeEvent(receipt), receipt);
  for (const state of ['present', 'empty', 'failed', 'timeout', 'unconfigured', 'stale']) assert.ok(safeEvent({ ...receipt, state }) !== undefined, `${state} is a state`);
  assert.equal(safeEvent({ ...receipt, state: 'silent' }), undefined, 'the state set is closed');
  assert.equal(safeEvent({ ...receipt, digest: '10:00 standup with the board' }), undefined, 'no event text rides the receipt');
  assert.equal(safeEvent({ ...receipt, items: -1 }), undefined, 'a negative count is refused');
  assert.equal(safeEvent({ ...receipt, ageMs: null }), undefined, 'the age is a count, never null');
  assert.equal(safeEvent({ event: 'calendar_digest', state: 'present', items: 0 }), undefined, 'the age is always present');
});

// R7: a wake prewarm before the first start used to adopt nothing, so the first call never opened on a
// digest the app had just read. It now assembles from its sources and says which.
test('R7: a prewarm before the first start assembles from sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-prewarm-first-'));
  const store = new Store(dir, hostMigrations);
  const configDir = join(dir, 'provider-config');
  let reads = 0;
  const cleanup = async () => { store.close(); await rm(dir, { recursive: true, force: true }); };
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
      dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } };
    await writeFile(join(configDir, 'live.json'), `${JSON.stringify(live)}\n`, { mode: 0o600 });
    const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId });
    assert.equal(loaded.status, 'configured');
    if (loaded.status !== 'configured') throw new Error('live.json must configure');
    const owner = createLiveSessionOwner({
      store, voice: {} as LiveVoicePort, profile: loaded.config.profile, now: () => 1_760_000_000_000, timeZone: 'UTC',
      calendarDigest: digestPort(() => 1_760_000_000_000, () => { reads += 1; }),
    } as unknown as Parameters<typeof createLiveSessionOwner>[0]);
    const receipt = await owner.prewarm();
    assert.equal(reads, 0, 'a cached first wake forces no reader call');
    assert.deepEqual(receipt, { ageBeforeMs: null, ageAfterMs: 0, assembled: true, reason: 'sources' },
      'the first prewarm assembles from sources and says so');
    const second = await owner.prewarm();
    assert.equal(second.reason, 'sections', 'a later wake refreshes the sections an assembly already holds');
    await owner.shutdown();
  } finally { await cleanup(); }
});
