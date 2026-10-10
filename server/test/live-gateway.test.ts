import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { Data } from 'ws';
import { composeLive } from '../host/live.js';
import { listenService } from '../http/server.js';
import { liveMigrations } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { CANARY, fixture, pcm } from './live-voice-fixture.js';

const MODEL = 'models/live-gateway-test';
const VOICE = 'LiveVoice';

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function configDir(parent: string, live: unknown | null, withKey: boolean): string {
  const dir = join(parent, 'provider-config');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (live !== null) {
    const path = join(dir, 'live.json');
    writeFileSync(path, `${JSON.stringify(live)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  if (withKey) {
    const path = join(dir, 'gemini-primary.json');
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: CANARY })}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return dir;
}

function configured(): unknown {
  return {
    schemaVersion: 1, enabled: true, provider: 'gemini', modelId: MODEL, voice: VOICE, keyReference: 'gemini-primary',
    dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' },
  };
}

interface Harness {
  f: Awaited<ReturnType<typeof fixture>>;
  store: Store;
  origin: string;
  token: string;
  epoch: string;
  live: Awaited<ReturnType<typeof composeLive>>['service'];
  close(): Promise<void>;
}

async function harness(t: TestContext, live: unknown | null, withKey = true): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-gateway-'));
  const store = new Store(join(dir, 'state'), liveMigrations);
  const config = configDir(dir, live, withKey);
  const { service: liveService } = composeLive(store, config, { socketFactory: f.socketFactory });
  const running = await listenService({ store, live: liveService, port: 0 });
  t.after(async () => {
    await running.close();
    await liveService.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    f, store, origin: running.origin, token: store.adminCredential, epoch: store.authorityEpoch, live: liveService,
    close: () => running.close(),
  };
}

function bearer(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.token}`, 'x-didi-authority-epoch': h.epoch };
}

async function json(origin: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function raw(origin: string, path: string, method: string, headers: Record<string, string | string[]>, body?: string): Promise<{ status: number; body: any }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Raw WebSocket upgrade attempt: 101 on success, otherwise the refused HTTP status. */
function attempt(origin: string, path: string, headers: Record<string, string | string[]>): Promise<number> {
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

test('live status is local validation; unconfigured and disabled never read a secret', async t => {
  const missing = await harness(t, null, false);
  const status = await json(missing.origin, '/api/v1/live/status', { headers: bearer(missing) });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.data, { service: 'live', status: 'unconfigured' });
  const create = await json(missing.origin, '/api/v1/live-sessions', {
    method: 'POST', headers: { ...bearer(missing), 'idempotency-key': 'k1', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }),
  });
  assert.equal(create.status, 503);

  const off = await harness(t, { ...(configured() as object), enabled: false }, false);
  const disabled = await json(off.origin, '/api/v1/live/status', { headers: bearer(off) });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.status, 'disabled');
  assert.equal(disabled.body.data.model, MODEL);
  const offCreate = await json(off.origin, '/api/v1/live-sessions', {
    method: 'POST', headers: { ...bearer(off), 'idempotency-key': 'k1', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }),
  });
  assert.equal(offCreate.status, 503);

  const broken = await harness(t, { ...(configured() as object), surprise: true }, false);
  const errored = await json(broken.origin, '/api/v1/live/status', { headers: bearer(broken) });
  assert.equal(errored.status, 200);
  assert.equal(errored.body.data.status, 'error');
  assert.equal(errored.body.data.code, 'invalid_profile');
  assert.equal(JSON.stringify(errored.body).includes('surprise'), false);
});

test('live operator routes reject browsers, origins and duplicate headers before the owner', async t => {
  const h = await harness(t, configured());
  const status = await json(h.origin, '/api/v1/live/status', { headers: bearer(h) });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.status, 'configured');
  assert.equal(status.body.data.model, MODEL);
  assert.equal(status.body.data.voice, VOICE);

  const create = { method: 'POST', 'content-type': 'application/json', body: JSON.stringify({ inputClass: 'ordinary' }) } as const;
  assert.equal((await json(h.origin, '/api/v1/live-sessions', { ...create, headers: {} })).status, 401);
  assert.equal((await json(h.origin, '/api/v1/live-sessions', { ...create, headers: { ...bearer(h), 'idempotency-key': 'a', cookie: 'didi_session=' + 'x'.repeat(43) } })).status, 403);
  assert.equal((await json(h.origin, '/api/v1/live-sessions', { ...create, headers: { ...bearer(h), 'idempotency-key': 'b', origin: h.origin } })).status, 403);
  assert.equal((await json(h.origin, '/api/v1/live-sessions', { ...create, headers: { ...bearer(h), 'idempotency-key': 'c', 'x-didi-authority-epoch': 'stale' } })).status, 409);
  const dup = await raw(h.origin, '/api/v1/live-sessions', 'POST', { authorization: [`Bearer ${h.token}`, 'Bearer other'], 'content-type': 'application/json' }, JSON.stringify({ inputClass: 'ordinary' }));
  assert.equal(dup.status, 400);
});

test('one ordered authenticated audio upgrade carries PCM, markers and the terminal fact', async t => {
  const h = await harness(t, configured());
  const created = await json(h.origin, '/api/v1/live-sessions', {
    method: 'POST', headers: { ...bearer(h), 'idempotency-key': 'flow-1', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }),
  });
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
  const ready = JSON.parse(frames.find(f => f.text && JSON.parse(f.text).type === 'ready')!.text!);
  assert.equal(typeof ready.journalSequence, 'number');

  const before = h.f.frames.length;
  ws.send(Buffer.from(pcm));
  await waitFor(() => h.f.frames.length > before);
  assert.deepEqual(h.f.frames.at(-1), { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });

  h.f.send({ serverContent: { outputTranscription: { text: 'late fact', finished: true } } });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'outputTranscription'));
  const transcript = JSON.parse(frames.find(f => f.text && JSON.parse(f.text).type === 'outputTranscription')!.text!);
  assert.equal(transcript.text, 'late fact');

  h.f.send({ serverContent: { interrupted: true, turnComplete: true } });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'interrupted'));

  const closed = once(ws, 'close');
  h.f.send({ serverContent: { turnComplete: true } });
  h.f.remoteClose();
  await closed;
  const final = frames.filter(f => f.text).map(f => JSON.parse(f.text!)).find(frame => frame.type === 'terminal');
  assert.ok(final, 'terminal frame must be emitted');
  assert.equal(final.state, 'closed');
  const journal = await json(h.origin, `/api/v1/live-sessions/${snapshot.liveSessionId}/journal`, { headers: bearer(h) });
  assert.equal(journal.body.data.terminal.outcome.state, 'closed');
  assert.ok(journal.body.data.fragments.some((f: { kind: string }) => f.kind === 'interrupted'));
});

test('malformed handshakes never consume the grant or open a provider', async t => {
  const h = await harness(t, configured());
  const created = await json(h.origin, '/api/v1/live-sessions', {
    method: 'POST', headers: { ...bearer(h), 'idempotency-key': 'neg-1', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }),
  });
  const id = created.body.data.liveSessionId;

  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio?x=1`, bearer(h)), 400);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/other`, bearer(h)), 404);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, {}), 401);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), cookie: 'didi_session=' + 'x'.repeat(43) }), 403);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), origin: h.origin }), 403);
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), 'x-didi-live-profile': 'stale' }), 403);
  assert.equal(h.f.attempts, 0, 'no provider open before a valid handshake');

  const snapshot = await json(h.origin, `/api/v1/live-sessions/${id}`, { headers: bearer(h) });
  assert.equal(snapshot.body.data.lifecycle, 'accepted', 'grant is not consumed by a malformed handshake');
});
