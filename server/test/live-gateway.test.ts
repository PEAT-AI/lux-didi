import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { Data } from 'ws';
import { composeLive } from '../host/live.js';
import { listenService } from '../http/server.js';
import { liveMigrations, type LiveProfile } from '../live/index.js';
import { createDomainPort } from '../domain/facade.js';
import { chatMigrations } from '../chat/index.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { CANARY, fixture, pcm } from './live-voice-fixture.js';

const MODEL = 'models/live-gateway-test';
const VOICE = 'LiveVoice';

function configJson(enabled: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, enabled, provider: 'gemini', modelId: MODEL, voice: VOICE, keyReference: 'gemini-primary',
    dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' },
    ...extra,
  };
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function writePrivate(dir: string, name: string, text: string): void {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface HarnessOptions { config?: unknown; rawLive?: string; profile?: LiveProfile; withKey?: boolean; credentials?: { resolve(reference: string): Promise<string | undefined> } }

interface Harness {
  f: Awaited<ReturnType<typeof fixture>>;
  store: Store;
  origin: string;
  token: string;
  epoch: string;
  close(): Promise<void>;
}

async function harness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-gateway-'));
  const store = new Store(join(dir, 'state'), liveMigrations);
  const config = join(dir, 'provider-config');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  chmodSync(config, 0o700);
  if (options.rawLive !== undefined) writePrivate(config, 'live.json', options.rawLive);
  else if (options.config !== undefined) writePrivate(config, 'live.json', `${JSON.stringify(options.config)}\n`);
  if (options.withKey !== false) writePrivate(config, 'gemini-primary.json', `${JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: CANARY })}\n`);
  const { service: live } = composeLive(store, config, { socketFactory: f.socketFactory, ...(options.profile ? { profile: options.profile } : {}), ...(options.credentials ? { credentials: options.credentials } : {}) });
  const running = await listenService({ store, live, port: 0 });
  t.after(async () => {
    await running.close();
    await live.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { f, store, origin: running.origin, token: store.adminCredential, epoch: store.authorityEpoch, close: () => running.close() };
}

function bearer(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.token}`, 'x-didi-authority-epoch': h.epoch };
}

async function json(origin: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createBody(h: Harness, key: string, headers: Record<string, string | string[]> = {}): Promise<{ status: number; body: any }> {
  const url = new URL(h.origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: '/api/v1/live-sessions', method: 'POST', headers: { ...bearer(h), 'idempotency-key': key, 'content-type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ inputClass: 'ordinary' }));
    req.end();
  });
}

function attempt(origin: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname, port: url.port, path, method: 'GET',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'), 'sec-websocket-version': '13', ...headers },
    });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

test('live status is local validation; absent, disabled and malformed files never read a secret', async t => {
  const missing = await harness(t, { withKey: false });
  const status = await json(missing.origin, '/api/v1/live/status', { headers: bearer(missing) });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.data, { service: 'live', status: 'unconfigured' });
  assert.equal((await createBody(missing, 'k1')).status, 503);

  const off = await harness(t, { config: configJson(false), withKey: false });
  const disabled = await json(off.origin, '/api/v1/live/status', { headers: bearer(off) });
  assert.equal(disabled.body.data.status, 'disabled');
  assert.equal(disabled.body.data.model, MODEL);
  assert.equal((await createBody(off, 'k1')).status, 503);

  const unknown = await harness(t, { config: configJson(true, { surprise: true }), withKey: false });
  const errored = await json(unknown.origin, '/api/v1/live/status', { headers: bearer(unknown) });
  assert.equal(errored.body.data.status, 'error');
  assert.equal(errored.body.data.code, 'invalid_profile');
  assert.equal(JSON.stringify(errored.body).includes('surprise'), false);

  // Strict duplicate object keys: the canonical files.ts parseJson rejects them as invalid_json.
  const duplicate = `{"schemaVersion":1,"schemaVersion":1,"enabled":false,"provider":"gemini","modelId":"${MODEL}","voice":"${VOICE}","keyReference":"gemini-primary","dataClasses":["ordinary"],"preferences":{"dataClass":"ordinary","language":"en-US","register":"plain","humor":"dry","verbosity":"balanced"}}`;
  const dup = await harness(t, { rawLive: duplicate, withKey: false });
  const dupStatus = await json(dup.origin, '/api/v1/live/status', { headers: bearer(dup) });
  assert.equal(dupStatus.body.data.status, 'error');
  assert.equal(dupStatus.body.data.code, 'invalid_json');

  // R1 approved: a valid enabled file builds its profile through the shared turn-less assembly.
  const enabled = await harness(t, { config: configJson(true), withKey: false });
  const ready = await json(enabled.origin, '/api/v1/live/status', { headers: bearer(enabled) });
  assert.equal(ready.body.data.status, 'configured');
  assert.equal(ready.body.data.model, MODEL);
});

test('live operator routes reject browsers, origins and duplicate headers before the owner', async t => {
  const h = await harness(t, { config: configJson(true) });
  const status = await json(h.origin, '/api/v1/live/status', { headers: bearer(h) });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.status, 'configured');
  assert.equal(status.body.data.model, MODEL);
  assert.equal(status.body.data.voice, VOICE);

  assert.equal((await createBody(h, 'a', { authorization: '' })).status, 401);
  assert.equal((await createBody(h, 'b', { cookie: `didi_session=${'x'.repeat(43)}` })).status, 403);
  assert.equal((await createBody(h, 'c', { origin: h.origin })).status, 403);
  assert.equal((await createBody(h, 'd', { 'x-didi-authority-epoch': 'stale' })).status, 409);
  assert.equal((await createBody(h, 'e', { authorization: [`Bearer ${h.token}`, 'Bearer other'] })).status, 400);
  assert.equal(h.f.attempts, 0, 'guards run before any provider open');
});

test('one ordered authenticated audio upgrade carries PCM, markers and the terminal fact', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'flow-1');
  assert.equal(created.status, 200);
  const snapshot = created.body.data;
  assert.equal(snapshot.grant.model, MODEL);
  assert.equal(snapshot.grant.voice, VOICE);
  assert.equal(snapshot.lifecycle, 'accepted');

  const wsUrl = `${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${snapshot.liveSessionId}/audio`;
  const ws = new WebSocket(wsUrl, { headers: bearer(h) });
  const frames: Array<{ text?: string; binary?: Buffer }> = [];
  ws.on('message', (data: Data, isBinary: boolean) => { frames.push(isBinary ? { binary: Buffer.from(data as Buffer) } : { text: data.toString() }); });
  await once(ws, 'open');

  await h.f.frame(1); h.f.send({ setupComplete: {} });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'ready'));

  const before = h.f.frames.length;
  ws.send(Buffer.from(pcm));
  await waitFor(() => h.f.frames.length > before);
  assert.deepEqual(h.f.frames.at(-1), { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });

  h.f.send({ serverContent: { outputTranscription: { text: 'late fact', finished: true } } });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'outputTranscription'));
  assert.equal(JSON.parse(frames.find(f => f.text && JSON.parse(f.text).type === 'outputTranscription')!.text!).text, 'late fact');

  h.f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } } });
  await waitFor(() => frames.some(f => f.binary));
  assert.deepEqual(frames.find(f => f.binary)!.binary, Buffer.from(pcm), 'binary frames are the ephemeral output PCM');

  h.f.send({ serverContent: { interrupted: true, turnComplete: true } });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'interrupted'));
  const indexOf = (predicate: (f: { text?: string; binary?: Buffer }) => boolean): number => frames.findIndex(predicate);
  const marker = indexOf(f => Boolean(f.text && JSON.parse(f.text).type === 'outputTranscription'));
  const pcmIndex = indexOf(f => f.binary !== undefined);
  const interrupted = indexOf(f => Boolean(f.text && JSON.parse(f.text).type === 'interrupted'));
  assert.ok(marker < pcmIndex && pcmIndex < interrupted, 'one ordered stream: committed marker, PCM, committed marker');

  const closed = once(ws, 'close');
  h.f.remoteClose();
  await closed;
  const terminal = frames.filter(f => f.text).map(f => JSON.parse(f.text!)).find(frame => frame.type === 'terminal');
  assert.ok(terminal, 'terminal frame must be emitted');
  assert.equal(terminal.state, 'failed', 'an unexpected transport close is a truthful failed terminal');
  const journal = await json(h.origin, `/api/v1/live-sessions/${snapshot.liveSessionId}/journal`, { headers: bearer(h) });
  assert.equal(journal.body.data.terminal.outcome.state, 'failed');
  assert.ok(journal.body.data.fragments.some((f: { kind: string }) => f.kind === 'interrupted'));
});

test('malformed handshakes never consume the grant or open a provider', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'neg-1');
  const id = created.body.data.liveSessionId;

  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio?x=1`, bearer(h)), 400);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/other`, bearer(h)), 404);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, {}), 401);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), cookie: `didi_session=${'x'.repeat(43)}` }), 403);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), origin: h.origin }), 403);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), 'x-didi-live-profile': 'stale' }), 403);
  assert.equal(h.f.attempts, 0, 'no provider open before a valid handshake');

  const snapshot = await json(h.origin, `/api/v1/live-sessions/${id}`, { headers: bearer(h) });
  assert.equal(snapshot.body.data.lifecycle, 'accepted', 'grant is not consumed by a malformed handshake');
});

test('two simultaneous attaches open at most one provider, and revoke is isolated', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'race-1');
  const id = created.body.data.liveSessionId;
  const results = await Promise.all([
    attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, bearer(h)),
    attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, bearer(h)),
  ]);
  assert.ok(results.every(status => status === 101 || status === 409), `unexpected statuses ${results}`);
  await waitFor(() => h.f.attempts >= 1, 2000);
  assert.equal(h.f.attempts, 1, 'two simultaneous attaches open at most one provider');

  const a = await createBody(h, 'rev-a');
  const b = await createBody(h, 'rev-b');
  const idA = a.body.data.liveSessionId, idB = b.body.data.liveSessionId;
  const revoked = await json(h.origin, `/api/v1/live-sessions/${idA}/revoke`, { method: 'POST', headers: bearer(h) });
  assert.equal(revoked.status, 200);
  const snapA = await json(h.origin, `/api/v1/live-sessions/${idA}`, { headers: bearer(h) });
  assert.equal(snapA.body.data.lifecycle, 'terminal');
  assert.equal(snapA.body.data.terminal.state, 'revoked');
  const snapB = await json(h.origin, `/api/v1/live-sessions/${idB}`, { headers: bearer(h) });
  assert.equal(snapB.body.data.lifecycle, 'accepted', 'revoke leaves other sessions unaffected');
  const before = h.f.attempts;
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${idA}/audio`, bearer(h)), 101);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.f.attempts, before, 'a revoked grant opens no provider');
});

test('subprotocols and extensions are refused before the provider', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'proto-1');
  const id = created.body.data.liveSessionId;
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), 'sec-websocket-protocol': 'x' }), 400);
  assert.equal(h.f.attempts, 0, 'a subprotocol handshake opens no provider');
});

test('revoke during deferred credential resolution ends durably and opens no provider', async t => {
  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const deferredCredentials = { resolve: async (_reference: string): Promise<string> => gate };
  const h = await harness(t, { config: configJson(true), credentials: deferredCredentials });
  const a = await createBody(h, 'def-a');
  const b = await createBody(h, 'def-b');
  const idA = a.body.data.liveSessionId, idB = b.body.data.liveSessionId;

  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${idA}/audio`, { headers: bearer(h) });
  await once(ws, 'open');
  await new Promise(resolve => setTimeout(resolve, 30)); // attachment is now parked on credential resolution
  assert.equal(h.f.attempts, 0, 'credentials are still deferred');
  assert.equal((await json(h.origin, `/api/v1/live-sessions/${idA}/revoke`, { method: 'POST', headers: bearer(h) })).status, 200);
  release(CANARY);
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(h.f.attempts, 0, 'a revoked deferred credential opens no provider');
  const snapA = await json(h.origin, `/api/v1/live-sessions/${idA}`, { headers: bearer(h) });
  assert.equal(snapA.body.data.lifecycle, 'terminal');
  assert.equal(snapA.body.data.terminal.state, 'revoked');
  const snapB = await json(h.origin, `/api/v1/live-sessions/${idB}`, { headers: bearer(h) });
  assert.equal(snapB.body.data.lifecycle, 'accepted', 'sessionB stays isolated');
  ws.close();
});

test('supervised host composes Live, closes owned sockets on EOF, and the Store reopens', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-host-'));
  const config = join(dir, 'provider-config'); mkdirSync(config, { recursive: true, mode: 0o700 }); chmodSync(config, 0o700);
  writePrivate(config, 'live.json', `${JSON.stringify(configJson(true))}\n`);
  writePrivate(config, 'gemini-primary.json', `${JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: CANARY })}\n`);
  const web = join(dir, 'web'); mkdirSync(web, { recursive: true });

  const child = fork(join(import.meta.dirname, 'live-gateway-process.js'), ['host', dir, config, web], { stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  const ready = await new Promise<{ origin: string; authorityEpoch: string; assistantId: string }>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('host did not become ready')), 10000);
    child.stdout!.on('data', (chunk: Buffer) => { buffer += chunk.toString(); const nl = buffer.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, nl))); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`host exited ${code}`)); });
  });

  const token = readFileSync(join(dir, 'admin-credential'), 'utf8').trim();
  const headers = { authorization: `Bearer ${token}`, 'x-didi-authority-epoch': ready.authorityEpoch };
  const status = await json(ready.origin, '/api/v1/live/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.status, 'configured', 'host composes Live on the same Store with no text profile');

  const created = await json(ready.origin, '/api/v1/live-sessions', { method: 'POST', headers: { ...headers, 'idempotency-key': 'proc-1', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }) });
  assert.equal(created.status, 200);
  const ws = new WebSocket(`${ready.origin.replace('http', 'ws')}/api/v1/live-sessions/${created.body.data.liveSessionId}/audio`, { headers });
  await once(ws, 'open');
  const closed = once(ws, 'close');

  child.stdin!.end();
  const exit = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  assert.equal(exit, 0, 'supervised host exits cleanly on stdin EOF');
  await closed;
  assert.equal(ws.readyState, ws.CLOSED, 'owned socket is closed on shutdown');
  await assert.rejects(fetch(`${ready.origin}/api/v1/status`, { signal: AbortSignal.timeout(2000) }));

  const store = new Store(dir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
  try { assert.equal(store.assistantId, ready.assistantId, 'the real Store reopens with stable identity'); } finally { store.close(); }
});
