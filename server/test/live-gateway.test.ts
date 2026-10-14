import { ConnectorCompositionError } from '../connectors/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { LiveAuthority } from '../tools/types.js';
import type { LiveToolsComposition } from '../live/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, createServer } from 'node:http';
import { composeMcpRuntime } from '../host/mcp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';
import type { Data } from 'ws';
import { ServiceError } from '../contracts/errors.js';
import { composeLive } from '../host/live.js';
import { listenService } from '../http/server.js';
import { LiveError, liveMigrations, type LiveProfile } from '../live/index.js';
import { hostMigrations, startHost } from '../host/runtime.js';
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

interface HarnessOptions { realMcp?: boolean; failedMcp?: boolean; toolsFactory?: (store: Store) => LiveToolsComposition; now?: () => number; config?: unknown; rawLive?: string; profile?: LiveProfile; withKey?: boolean; credentials?: { resolve(reference: string): Promise<string | undefined> } }

interface Harness {
  f: Awaited<ReturnType<typeof fixture>>;
  store: Store;
  live: ReturnType<typeof composeLive>['service'];
  origin: string;
  token: string;
  epoch: string;
  close(): Promise<void>;
}

async function harness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-gateway-'));
  const store = new Store(join(dir, 'state'), [...domainMigrations, ...liveMigrations, ...(options.toolsFactory || options.realMcp ? toolsMigrations : [])]);
  const config = join(dir, 'provider-config');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  chmodSync(config, 0o700);
  if (options.rawLive !== undefined) writePrivate(config, 'live.json', options.rawLive);
  else if (options.config !== undefined) writePrivate(config, 'live.json', `${JSON.stringify(options.config)}\n`);
  if (options.withKey !== false) writePrivate(config, 'gemini-primary.json', `${JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: CANARY })}\n`);
  let tools = options.toolsFactory?.(store);
  if (options.realMcp) {
    // Same SDK endpoint/HTTP bridge as knowledge-connector.test.ts and mcp-config.test.ts.
    const sdk = new Server({ name: 'synthetic-knowledge', version: '1' }, { capabilities: { tools: {} } });
    sdk.setRequestHandler('tools/list', () => ({ tools: [{ name: 'search_knowledge', inputSchema: { type: 'object' } }] }) as never);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    await sdk.connect(transport);
    const endpoint = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'GET', headers, ...(bytes.length ? { body: new Uint8Array(bytes) } : {}) });
        const response = await transport.handleRequest(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) { res.end(); return; }
        const reader = response.body.getReader();
        res.on('close', () => { void reader.cancel().catch(() => {}); });
        while (!res.destroyed) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); }
        res.end();
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
    t.after(async () => { endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); await transport.close(); await sdk.close(); });
    const address = endpoint.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const entry = (id: string, path: string) => ({ id, url: url + path, transport: 'streamable-http', connector: 'lux-knowledge', account: 'fixture', resource: 'knowledge', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' });
    writePrivate(config, 'mcp.json', JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [entry('healthy', '/'), ...(options.failedMcp ? [{ ...entry('failed', '/'), credentialRef: 'missing-credential' }] : [])] }));
    const sources: Array<(runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>> = [];
    const lookupAuthority = async (runId: string, signal: AbortSignal) => {
      for (const source of sources) { const authority = await source(runId, signal); if (authority) return authority; }
      return null;
    };
    const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir: config, lookupAuthority });
    t.after(async () => { await runtime.close(); });
    // Keep the missing-policy regression first: the base reaches attach, then closes internal.
    assert.deepEqual(runtime.connectionIds(), ['healthy'], JSON.stringify(runtime.status()));
    if (options.failedMcp) {
      assert.equal(runtime.status().endpoints.find(e => e.id === 'failed')?.state, 'error');
      assert.equal(runtime.status().endpoints.find(e => e.id === 'failed')?.error, 'credential missing-credential missing or invalid');
    }
    tools = { owner: runtime.owner, connectionIds: () => runtime.connectionIds(), registerAuthoritySource: source => { sources.push(source); } };
  }
  const { service: live } = composeLive(store, config, { socketFactory: f.socketFactory, ...(options.profile ? { profile: options.profile } : {}), ...(options.credentials ? { credentials: options.credentials } : {}) }, options.now, undefined, tools);
  const running = await listenService({ store, live, port: 0 });
  t.after(async () => {
    await running.close();
    await live.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { f, store, live, origin: running.origin, token: store.adminCredential, epoch: store.authorityEpoch, close: () => running.close() };
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

function upgradeResponse(origin: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname, port: url.port, path, method: 'GET',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'), 'sec-websocket-version': '13', ...headers },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: 101, headers: res.headers }); });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }); });
    req.on('error', reject);
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
  assert.deepEqual(ready.body.data.limits, { sessionMs: 3_600_000, idleMs: 300_000 });
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

for (const mode of ['failed', 'healthy', 'fixture-only'] as const) test(`Swift sequence reaches ready (${mode})`, { timeout: 5000 }, async t => {
  const h = await harness(t, { config: configJson(true), realMcp: mode !== 'fixture-only', failedMcp: mode === 'failed' });
  // LiveSessionCoordinator.performCreate: status, create, validate the returned grant, connect.
  const status = await json(h.origin, '/api/v1/live/status', { headers: bearer(h) });
  assert.equal(status.status, 200);
  const created = await createBody(h, 'swift-sequence');
  assert.equal(created.status, 200);
  const snapshot = created.body.data;
  assert.equal(snapshot.lifecycle, 'accepted');
  assert.equal(snapshot.consumerState, 'detached');
  assert.equal(snapshot.dispatchIntent, false);
  assert.equal(snapshot.profileIdentity, status.body.data.profileIdentity);
  assert.equal(snapshot.grant.model, status.body.data.model);
  assert.equal(snapshot.grant.voice, status.body.data.voice);
  assert.deepEqual(snapshot.grant.permittedClasses, status.body.data.dataClasses);
  // LiveSocketTransport.validate: exact path, four identity headers, no query/subprotocol.
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${snapshot.liveSessionId}/audio`, {
    headers: { ...bearer(h), host: new URL(h.origin).host, 'x-didi-live-profile': snapshot.profileIdentity },
  });
  t.after(() => ws.terminate());
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', (code, reason) => reject(new Error(`closed before ready: ${code}:${reason}`)));
    ws.on('message', (data, binary) => { if (!binary && JSON.parse(data.toString()).type === 'ready') resolve(); });
  });
  const setup = (async () => { await h.f.frame(1); h.f.send({ setupComplete: {} }); })();
  await Promise.race([ready, setup.then(() => ready)]);
  // The owner opens model-first, so frame 1 is the greeting text, not capture.
  await h.f.frame(2);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: 'Greet the person briefly to begin the conversation.' } });
  // The coordinator sends capture only after ready; FoundationLiveSocket sends PCM as binary,
  // and endAudioStream as one text JSON control, not a terminal close.
  ws.send(Buffer.from(pcm));
  await h.f.frame(3);
  ws.send(JSON.stringify({ type: 'endAudioStream' }));
  await h.f.frame(4);
  assert.deepEqual(h.f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });
  assert.deepEqual(h.f.frames[3], { realtimeInput: { audioStreamEnd: true } });
  const current = await json(h.origin, `/api/v1/live-sessions/${snapshot.liveSessionId}`, { headers: bearer(h) });
  assert.equal(current.status, 200);
  assert.equal(current.body.data.lifecycle, 'active');
  assert.equal(current.body.data.consumerState, 'attached');
  assert.equal(current.body.data.terminal, null);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

for (const [label, error, code] of [
  ['typed', new LiveError('invalidated', CANARY), 'invalidated'],
  ['pickup', new LiveError('pickup_changed', CANARY), 'pickup_changed'],
  ['authorization', new ServiceError('FORBIDDEN', CANARY, 403), 'FORBIDDEN'],
  ['unknown', new Error(CANARY), 'internal'],
  ['known-code', new Error('connection_policy_missing_or_corrupt'), 'internal'],
] as const) {
  test(`attach rejection reports sanitized ${label} code once`, async t => {
    const h = await harness(t, { config: configJson(true) });
    const created = await createBody(h, `rejection-${label}`);
    assert.equal(created.status, 200);
    const id = created.body.data.liveSessionId;
    const events: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { events.push(args); });
    t.mock.method(h.live, 'attach', () => { throw error; });
    const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, {
      headers: { ...bearer(h), host: new URL(h.origin).host, 'x-didi-live-profile': created.body.data.profileIdentity },
    });
    t.after(() => ws.terminate());
    const [closeCode, reason] = await once(ws, 'close');
    assert.equal(closeCode, 1008);
    assert.equal(reason.toString(), `attach_rejected:${code}`);
    assert.ok(Buffer.byteLength(reason) <= 123);
    assert.deepEqual(events, [[JSON.stringify({ event: 'live_attach_rejected', liveSessionId: id, code, ...(code === 'internal' ? { class: 'Error', ...(label === 'known-code' ? { detail: 'connection_policy_missing_or_corrupt' } : {}) } : {}) })]]);
    assert.equal(JSON.stringify(events).includes(CANARY), false);
    assert.equal(h.f.attempts, 0);
  });
}

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
  // R4: facts after interrupted keep their order; the interrupted marker precedes following audio.
  h.f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } } });
  await waitFor(() => frames.filter(f => f.binary !== undefined).length >= 2);
  const followingAudio = frames.findIndex((f, i) => f.binary !== undefined && i > interrupted);
  assert.ok(followingAudio > interrupted, 'the interrupted marker precedes following audio frames');

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

test('a settled session delivers the typed terminal and closes 1000 while a late mic frame arrives', async t => {
  // The session budget is not reset by client audio, so it settles while the microphone keeps sending frames.
  const h = await harness(t, { config: configJson(true, { limits: { sessionMs: 200, idleMs: 5000, handshakeMs: 1000, closeMs: 50 } }) });
  const created = await createBody(h, 'late-mic');
  const id = created.body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  const frames: Array<{ text?: string }> = [];
  ws.on('message', (data: Data, isBinary: boolean) => { if (!isBinary) frames.push({ text: data.toString() }); });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  await h.f.frame(1); h.f.send({ setupComplete: {} });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'ready'));
  const closed = once(ws, 'close');
  // The provider goes idle, settling the session, while the microphone keeps sending frames.
  const pump = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(pcm)); }, 40);
  t.after(() => clearInterval(pump));
  const [code] = await closed;
  clearInterval(pump);
  const terminal = frames.map(f => f.text).filter((text): text is string => text !== undefined).map(text => JSON.parse(text) as { type: string; state?: string; code?: string | null }).find(frame => frame.type === 'terminal');
  assert.ok(terminal, 'the typed terminal frame is delivered before the close');
  assert.equal(terminal.code, 'session_timeout');
  assert.equal(code, 1000, 'a settled session closes 1000, never a generic 1002');
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

test('an offered subprotocol is refused and an offered extension is never negotiated', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'proto-1');
  const id = created.body.data.liveSessionId;
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), 'sec-websocket-protocol': 'x' }), 400);
  assert.equal(h.f.attempts, 0, 'a subprotocol handshake opens no provider');
  const id2 = (await createBody(h, 'proto-2')).body.data.liveSessionId;
  const accepted = await upgradeResponse(h.origin, `/api/v1/live-sessions/${id2}/audio`, { ...bearer(h), 'sec-websocket-extensions': 'permessage-deflate' });
  assert.equal(accepted.status, 101, 'an extension offer leaves the accepted handshake intact');
  assert.equal(accepted.headers['sec-websocket-extensions'], undefined, 'the fixed no-extensions contract negotiates none');
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
  const web = join(dir, 'web'); mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>live gateway</title><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>\n', { mode: 0o644 });
  writeFileSync(join(web, 'sw.js'), 'self.addEventListener("install", () => {});\n', { mode: 0o644 });
  writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"live gateway"}\n', { mode: 0o644 });
  writeFileSync(join(web, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', { mode: 0o644 });
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log("live");\n', { mode: 0o644 });
  writeFileSync(join(web, 'assets', 'app.css'), 'body{}\n', { mode: 0o644 });

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

  const store = new Store(dir, hostMigrations);
  try { assert.equal(store.assistantId, ready.assistantId, 'the real Store reopens with stable identity'); } finally { store.close(); }
});

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
}
function collect(ws: WebSocket): { frames: Array<{ text?: string; binary?: Buffer }> } {
  const frames: Array<{ text?: string; binary?: Buffer }> = [];
  ws.on('message', (data: Data, isBinary: boolean) => { frames.push(isBinary ? { binary: Buffer.from(data as Buffer) } : { text: data.toString() }); });
  return { frames };
}
function rawMethod(origin: string, path: string, method: string, headers: Record<string, string | string[]>): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

test('strict client controls: endAudioStream accepted, close and unknown controls fail visibly', async t => {
  const h = await harness(t, { config: configJson(true) });
  const id = (await createBody(h, 'ctl-1')).body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  const { frames } = collect(ws);
  await once(ws, 'open');
  await h.f.frame(1); h.f.send({ setupComplete: {} });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'ready'));
  const before = h.f.frames.length;
  ws.send(JSON.stringify({ type: 'endAudioStream' }));
  await waitFor(() => h.f.frames.length > before);
  assert.deepEqual(h.f.frames.at(-1), { realtimeInput: { audioStreamEnd: true } });
  const closed = nextClose(ws);
  ws.send(JSON.stringify({ type: 'nope' }));
  assert.deepEqual(await closed, { code: 1002, reason: 'invalid_control' });

  const id2 = (await createBody(h, 'ctl-2')).body.data.liveSessionId;
  const ws2 = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id2}/audio`, { headers: bearer(h) });
  await once(ws2, 'open');
  const closed2 = nextClose(ws2);
  ws2.send(JSON.stringify({ type: 'close' }));
  assert.deepEqual(await closed2, { code: 1000, reason: 'client_close' });
});

test('malformed and oversize client frames fail visibly', async t => {
  const h = await harness(t, { config: configJson(true) });
  const id = (await createBody(h, 'frm-1')).body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  await once(ws, 'open');
  const closed = nextClose(ws);
  ws.send('not-json');
  assert.deepEqual(await closed, { code: 1002, reason: 'invalid_control' });

  const id2 = (await createBody(h, 'frm-2')).body.data.liveSessionId;
  const ws2 = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id2}/audio`, { headers: bearer(h) });
  await once(ws2, 'open');
  const closed2 = nextClose(ws2);
  ws2.send(Buffer.alloc(64 * 1024 + 4));
  assert.deepEqual(await closed2, { code: 1009, reason: 'frame_too_large' });
});

test('wrong Host and wrong method are refused on Live routes', async t => {
  const h = await harness(t, { config: configJson(true) });
  const id = (await createBody(h, 'host-1')).body.data.liveSessionId;
  assert.equal(await attempt(h.origin, `/api/v1/live-sessions/${id}/audio`, { ...bearer(h), host: 'evil.example' }), 403);
  assert.equal(await rawMethod(h.origin, `/api/v1/live-sessions/${id}/audio`, 'POST', bearer(h)), 405);
  assert.equal(await rawMethod(h.origin, `/api/v1/live-sessions/${id}`, 'POST', bearer(h)), 405);
  assert.equal(h.f.attempts, 0);
});

test('revoke sessionA preserves an active sessionB that still works', async t => {
  const h = await harness(t, { config: configJson(true) });
  const a = (await createBody(h, 'iso-a')).body.data.liveSessionId;
  const b = (await createBody(h, 'iso-b')).body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${b}/audio`, { headers: bearer(h) });
  const { frames } = collect(ws);
  await once(ws, 'open');
  await h.f.frame(1); h.f.send({ setupComplete: {} });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'ready'));
  assert.equal((await json(h.origin, `/api/v1/live-sessions/${a}/revoke`, { method: 'POST', headers: bearer(h) })).status, 200);
  const snapB = await json(h.origin, `/api/v1/live-sessions/${b}`, { headers: bearer(h) });
  assert.equal(snapB.body.data.lifecycle, 'active', 'an attached B stays active across A revoke');
  h.f.send({ serverContent: { outputTranscription: { text: 'still B' } } });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).text === 'still B'));
  ws.close();
});

test('socket backpressure persists consumer_backpressure before the 1013 close', async t => {
  const h = await harness(t, { config: configJson(true, { limits: { consumerQueueEvents: 65536, consumerQueueBytes: 8 * 1024 * 1024, wsBufferedBytes: 1024 } }) });
  const id = (await createBody(h, 'bp-1')).body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  await once(ws, 'open');
  await h.f.connected;
  await h.f.frame(1); h.f.send({ setupComplete: {} });
  await new Promise(resolve => setTimeout(resolve, 40));
  const socket = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  socket.pause();
  const audioFrame = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(8192).toString('base64') } }] } } };
  const closed = nextClose(ws);
  for (let i = 0; i < 400; i++) h.f.send(audioFrame);
  await new Promise(resolve => setTimeout(resolve, 200));
  socket.resume();
  assert.equal((await closed).code, 1013);
  const snap = await json(h.origin, `/api/v1/live-sessions/${id}`, { headers: bearer(h) });
  assert.equal(snap.body.data.terminal.state, 'consumer_backpressure', 'the durable fact predates the close');
});

test('a client that disconnects after 101 records a truthful terminal and never retries', async t => {
  const h = await harness(t, { config: configJson(true) });
  const id = (await createBody(h, 'disc-1')).body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  await once(ws, 'open');
  await h.f.connected;
  ws.terminate();
  h.f.remoteClose();
  const deadline = Date.now() + 5000;
  let terminal: unknown = null;
  while (!terminal && Date.now() < deadline) {
    const s = await json(h.origin, `/api/v1/live-sessions/${id}`, { headers: bearer(h) });
    if (s.body.data.terminal) terminal = s.body.data.terminal;
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(terminal, 'a truthful terminal is recorded');
  assert.equal(h.f.attempts, 1, 'the one-shot session is never re-dispatched');
});

test('revoke while receiving output sends no later PCM on the wire', async t => {
  const h = await harness(t, { config: configJson(true) });
  const id = (await createBody(h, 'revout-1')).body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  const { frames } = collect(ws);
  await once(ws, 'open');
  await h.f.frame(1); h.f.send({ setupComplete: {} });
  await waitFor(() => frames.some(f => f.text && JSON.parse(f.text).type === 'ready'));
  const audioFrame = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } } };
  h.f.send(audioFrame);
  await waitFor(() => frames.some(f => f.binary));
  const before = frames.filter(f => f.binary).length;
  assert.equal((await json(h.origin, `/api/v1/live-sessions/${id}/revoke`, { method: 'POST', headers: bearer(h) })).status, 200);
  h.f.send(audioFrame);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(frames.filter(f => f.binary).length, before, 'no later PCM egress after revoke');
});


test('HTTP snapshot and same-key replay expire accepted unused sessions without audio or credentials', async t => {
  let now = 1_700_000_000_000, credentials = 0;
  const h = await harness(t, { now: () => now, config: configJson(true, { limits: { unusedMs: 20 } }), credentials: { resolve: async () => { credentials++; return CANARY; } } });
  const first = await createBody(h, 'http-unused-get');
  const second = await createBody(h, 'http-unused-replay');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  now += 20;
  const boundary = await json(h.origin, `/api/v1/live-sessions/${first.body.data.liveSessionId}`, { headers: bearer(h) });
  assert.equal(boundary.status, 200);
  assert.equal(boundary.body.data.lifecycle, 'accepted');
  now++;
  const expired = await json(h.origin, `/api/v1/live-sessions/${first.body.data.liveSessionId}`, { headers: bearer(h) });
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.body.data.terminal, { state: 'expired' });
  const replay = await createBody(h, 'http-unused-replay');
  assert.equal(replay.body.data.liveSessionId, second.body.data.liveSessionId);
  assert.deepEqual(replay.body.data.terminal, { state: 'expired' });
  assert.equal(credentials, 0);
  assert.equal(h.f.attempts, 0);
});


test('canonical host applies configured idle deadline and persists idle_timeout across replay and restart', async t => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-host-idle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  writePrivate(configDir, 'live.json', `${JSON.stringify(configJson(true, { limits: { idleMs: 200, sessionMs: 10_000, handshakeMs: 1000, closeMs: 50, wsBufferedBytes: 1024 } }))}\n`);
  const hostConfig = { dataDir: join(dir, 'state'), configDir, webRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)), port: 0,
    liveTesting: { socketFactory: f.socketFactory, credentials: { resolve: async () => CANARY } } };
  const host = await startHost(hostConfig);
  t.after(() => host.close());
  const headers = { authorization: `Bearer ${host.store.adminCredential}`, 'x-didi-authority-epoch': host.store.authorityEpoch };
  const create = (origin: string) => json(origin, '/api/v1/live-sessions', { method: 'POST', headers: { ...headers, 'idempotency-key': 'host-idle', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }) });
  const created = await create(host.service.origin);
  assert.equal(created.status, 200);
  const id = created.body.data.liveSessionId;
  const ws = new WebSocket(`${host.service.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers });
  const frames: any[] = [];
  ws.on('message', (data: Data, binary: boolean) => { if (!binary) frames.push(JSON.parse(data.toString())); });
  const closed = once(ws, 'close');
  await once(ws, 'open');
  await f.frame(1);
  t.diagnostic(`provider setup bytes=${Buffer.byteLength(JSON.stringify(f.frames[0]))}; gateway consumer bound=1024, independent adapter provider bound`);
  f.send({ setupComplete: {} });
  // Bounded observation of the actual terminal, not a sleep or the hard session deadline.
  await waitFor(() => frames.some(frame => frame.type === 'terminal'), 1500);
  await closed;
  const snapshot = await json(host.service.origin, `/api/v1/live-sessions/${id}`, { headers });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.body.data.terminal, { state: 'failed', code: 'idle_timeout' });
  assert.equal(f.attempts, 1);
  const replay = await create(host.service.origin);
  assert.deepEqual(replay.body.data.terminal, snapshot.body.data.terminal);
  assert.equal(replay.body.data.liveSessionId, id);
  assert.equal(f.attempts, 1);
  await host.close();
  const restarted = await startHost(hostConfig);
  t.after(() => restarted.close());
  const recovered = await create(restarted.service.origin);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.data.terminal, { state: 'failed', code: 'idle_timeout' });
  assert.equal(recovered.body.data.liveSessionId, id);
  assert.equal(f.attempts, 1, 'restart/replay never reopens the adapter');
  t.diagnostic('actual host idleMs=200, sessionMs=10000: observed persisted idle_timeout; replay/restart opens remain1');
});

test('page Live projection is cookie-only, same-origin, read-only and no-store', async t => {
  const h = await harness(t, { config: configJson(true) });
  const token = 'p'.repeat(43);
  h.store.transaction(tx => tx.run('INSERT INTO runtime_sessions VALUES (?,?,?,?)', [createHash('sha256').update(token).digest('hex'), 'page-client', 'csrf', Date.now() + 60_000]));
  const headers = { cookie: `didi_session=${token}` };
  const response = await fetch(`${h.origin}/api/v1/live/current`, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.json() as { data: { state: string; entries: unknown[]; cursor: number } };
  assert.deepEqual(body.data, { state: 'idle', since: null, entries: [], cursor: 0 });
  assert.equal((await fetch(`${h.origin}/api/v1/live/current`, { headers: bearer(h) })).status, 403);
  assert.equal((await fetch(`${h.origin}/api/v1/live/current`, { headers: { ...headers, origin: 'https://other.test' } })).status, 403);
  assert.equal((await fetch(`${h.origin}/api/v1/live/current`, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${h.origin}/api/v1/live/current?cursor=-1`, { headers })).status, 400);
  for (const name of ['liveSessionId', 'args', 'key', 'grants', 'pcm', 'thoughts']) assert.equal(JSON.stringify(body).includes(name), false);
});

test('gateway forwards safe tool-call/result markers and keeps a refused tool batch alive', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'tool-markers');
  const ws = new WebSocket(`${h.origin.replace('http:', 'ws:')}/api/v1/live-sessions/${created.body.data.liveSessionId}/audio`, { headers: bearer(h) });
  t.after(() => ws.terminate());
  const markers: Record<string, any>[] = [];
  let readyResolve!: () => void, resultResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const result = new Promise<void>(resolve => { resultResolve = resolve; });
  ws.on('message', (data, binary) => {
    if (binary) return;
    const frame = JSON.parse(data.toString()) as Record<string, any>; markers.push(frame);
    if (frame.type === 'ready') readyResolve();
    if (frame.type === 'toolResult') resultResolve();
  });
  await once(ws, 'open'); await h.f.frame(1); h.f.send({ setupComplete: {} }); await ready;
  h.f.send({ toolCall: { functionCalls: [{ id: 'refused', name: 'not_granted', args: { secret: CANARY } }] } });
  await h.f.frame(2); await result;
  assert.equal(markers.some(marker => marker.type === 'toolCall'), true);
  const projected = markers.find(marker => marker.type === 'toolResult')!;
  assert.equal(projected.tool.status, 'error'); assert.equal(projected.tool.markdown, 'Tool not granted');
  assert.deepEqual(projected.tool.sources, []);
  assert.equal(JSON.stringify(markers).includes(CANARY), false); assert.equal(JSON.stringify(markers).includes('args'), false);
  assert.equal(ws.readyState, WebSocket.OPEN);
  const token = 'q'.repeat(43);
  h.store.transaction(tx => tx.run('INSERT INTO runtime_sessions VALUES (?,?,?,?)', [createHash('sha256').update(token).digest('hex'), 'active-page-client', 'csrf', Date.now() + 60_000]));
  const headers = { cookie: `didi_session=${token}` };
  const page = await json(h.origin, '/api/v1/live/current', { headers });
  assert.equal(page.body.data.state, 'listening');
  assert.equal(page.body.data.entries.some((entry: any) => entry.kind === 'toolResult' && entry.tool.status === 'error'), true);
  for (const forbidden of ['liveSessionId', 'args', 'key', 'grants', 'pcm', 'thoughts']) assert.equal(JSON.stringify(page.body).includes(forbidden), false);
  // Input resumes without requiring an audioStreamEnd turn boundary.
  ws.send(pcm, { binary: true }); await h.f.frame(3);
  const modelAudio = once(ws, 'message');
  h.f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } } });
  const [, binary] = await modelAudio; assert.equal(binary, true);
  assert.equal((await json(h.origin, '/api/v1/live/current', { headers })).body.data.state, 'speaking');
  const interruption = once(ws, 'message'); h.f.send({ serverContent: { interrupted: true } });
  const [boundary] = await interruption; assert.equal(JSON.parse(boundary.toString()).type, 'interrupted');
  assert.equal((await json(h.origin, '/api/v1/live/current', { headers })).body.data.state, 'listening');
  ws.send(JSON.stringify({ type: 'close' })); await once(ws, 'close');
});

test('trusted composition registers current Live authority and refuses after terminal/revoke', async t => {
  let gateOwner: ReturnType<typeof createToolsOwner>;
  let lookup: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const h = await harness(t, { config: configJson(true), toolsFactory: store => {
    const registry = new McpRegistry();
    const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token' });
    t.after(() => port.close());
    const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, lookupAuthority: async (runId, signal) => lookup ? lookup(runId, signal) : null });
    gateOwner = owner;
    return { owner, connectionIds: () => [], registerAuthoritySource: source => { lookup = source; } };
  } });
  assert.equal(typeof lookup, 'function');
  const created = await createBody(h, 'registered-authority'); const id = created.body.data.liveSessionId;
  const signal = new AbortController().signal;
  assert.equal(await lookup!(id, signal), null);
  const ws = new WebSocket(`${h.origin.replace('http:', 'ws:')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  t.after(() => ws.terminate()); await once(ws, 'open');
  await h.f.frame(1); h.f.send({ setupComplete: {} }); await once(ws, 'message');
  const active = await lookup!(id, signal); assert.equal(active?.runId, id); assert.match(active!.acceptedRunHash, /^[a-f0-9]{64}$/);
  const host = { runId: id, actorId: active!.actorId, authorityEpoch: active!.authorityEpoch, revision: active!.revision, grants: [] };
  assert.equal((await gateOwner!.resultGate.authorize(host, [], ['ordinary'], signal)).state, 'allowed');
  const aborted = new AbortController(); aborted.abort(); assert.equal(await lookup!(id, aborted.signal), null);
  assert.equal((await json(h.origin, `/api/v1/live-sessions/${id}/revoke`, { method: 'POST', headers: bearer(h) })).status, 200);
  assert.equal(await lookup!(id, signal), null);
  assert.equal((await gateOwner!.resultGate.authorize(host, [], ['ordinary'], signal)).state, 'refused');
  ws.close(); if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close');
  const again = await createBody(h, 'registered-terminal'); const secondId = again.body.data.liveSessionId;
  const second = new WebSocket(`${h.origin.replace('http:', 'ws:')}/api/v1/live-sessions/${secondId}/audio`, { headers: bearer(h) });
  t.after(() => second.terminate()); await once(second, 'open'); await h.f.frame(3); h.f.send({ setupComplete: {} }); await once(second, 'message');
  assert.notEqual(await lookup!(secondId, signal), null);
  second.send(JSON.stringify({ type: 'close' })); await once(second, 'close'); assert.equal(await lookup!(secondId, signal), null);
});


test('host Live status exposes only counts from the committed memory snapshot', async t => {
  const h = await harness(t, { config: configJson(true), withKey: false });
  h.store.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', ['memory-session', 'Fixture', 1, 'UTC', 1, 1]);
    tx.run('INSERT INTO entries VALUES (?,?,1,?,?,?, ?,1)', ['memory-entry', 'memory-session', 'user', 'Fixture durable owner note', 1, 'UTC']);
    for (const [kind, id] of [['session', 'memory-session'], ['entry', 'memory-entry']]) tx.run('INSERT INTO routing_labels VALUES (?,?,1,?,?,?)', [kind!, id!, 'ordinary', 'owner_review', 1]);
  });
  const created = await createBody(h, 'memory-wire');
  assert.equal(created.status, 200);
  const status = await json(h.origin, '/api/v1/live/status', { headers: bearer(h) });
  assert.deepEqual(status.body.data.memory, { status: 'selected', selected: 1, omitted: 0 });
  assert.ok(!JSON.stringify(status.body).includes('Fixture durable owner note'));
  assert.ok(!JSON.stringify(status.body).includes('memory-entry'));
  const id = created.body.data.liveSessionId;
  const stored = h.store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [id])!['accepted_prompt_snapshot'])));
  assert.match(stored.system, /Fixture durable owner note/);
});

test('CREATE maps a typed connector composition defect to a bounded visible envelope', async t => {
  const h = await harness(t, { config: configJson(true), toolsFactory: store => {
    const registry = new McpRegistry();
    const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token' });
    t.after(() => port.close());
    const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, lookupAuthority: async () => null });
    owner.snapshotRun = () => { throw new ConnectorCompositionError('unknown_connector', 'missing-endpoint', 'missing-kind'); };
    return { owner, connectionIds: () => [], registerAuthoritySource: () => {} };
  } });
  const created = await createBody(h, 'composition-error');
  assert.equal(created.status, 503);
  assert.equal(created.body.error.code, 'CONNECTOR_COMPOSITION_ERROR');
  assert.equal(created.body.error.message, 'Connector composition failed');
  assert.ok(created.body.requestId);
});

test('pre-ready provider 1007 is journaled and closes with typed attach rejection', async t => {
  const h = await harness(t, { config: configJson(true) });
  const created = await createBody(h, 'setup-rejected');
  assert.equal(created.status, 200);
  const id = created.body.data.liveSessionId;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: bearer(h) });
  const frames: string[] = [];
  ws.on('message', bytes => frames.push(bytes.toString()));
  const closed = once(ws, 'close');
  await once(ws, 'open');
  await h.f.frame(1);
  h.f.remoteClose(CANARY, 1007);
  const [closeCode, reason] = await closed;
  assert.equal(closeCode, 1008);
  assert.equal(reason.toString(), 'attach_rejected:provider_setup_rejected');
  const snapshot = h.live.snapshot(id);
  assert.equal(snapshot.ready, false);
  assert.deepEqual(snapshot.terminal, { state: 'failed', code: 'provider_setup_rejected' });
  assert.equal(JSON.stringify(snapshot).includes(CANARY), false);
  assert.equal(frames.some(frame => JSON.parse(frame).code === 'provider_setup_rejected'), true);
});

test('canonical host resumes one journal and never exposes the handle on the wire or host log', async t => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-host-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  writePrivate(configDir, 'live.json', `${JSON.stringify(configJson(true, { limits: { idleMs: 2000, sessionMs: 4000, handshakeMs: 1000, closeMs: 50 } }))}\n`);
  const dataDir = join(dir, 'state');
  const host = await startHost({ dataDir, configDir, webRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)), port: 0,
    liveTesting: { socketFactory: f.socketFactory, credentials: { resolve: async () => CANARY } } });
  t.after(() => host.close());
  const headers = { authorization: `Bearer ${host.store.adminCredential}`, 'x-didi-authority-epoch': host.store.authorityEpoch };
  const created = await json(host.service.origin, '/api/v1/live-sessions', { method: 'POST', headers: { ...headers, 'idempotency-key': 'host-resume', 'content-type': 'application/json' }, body: JSON.stringify({ inputClass: 'ordinary' }) });
  assert.equal(created.status, 200);
  const id = created.body.data.liveSessionId;
  const frozen = host.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,memory_provenance FROM live_sessions WHERE live_session_id=?', [id]));
  const ws = new WebSocket(`${host.service.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers: { ...headers, 'x-didi-live-profile': created.body.data.profileIdentity } });
  t.after(() => ws.terminate());
  const frames: Record<string, unknown>[] = [];
  const waiters = new Map<string, (frame: Record<string, unknown>) => void>();
  const key = (frame: Record<string, unknown>) => `${frame.type}:${frame.event ?? ''}`;
  ws.on('message', (bytes: Data, binary: boolean) => {
    if (binary) return;
    const frame = JSON.parse(bytes.toString()) as Record<string, unknown>;
    frames.push(frame); const waitKey = waiters.has(key(frame)) ? key(frame) : `${frame.type}:*`;
    const notify = waiters.get(waitKey);
    if (notify) { waiters.delete(waitKey); notify(frame); }
  });
  const next = (type: string, event?: string) => {
    const waitKey = event === undefined ? `${type}:*` : `${type}:${event}`;
    const found = frames.find(frame => frame.type === type && (event === undefined || frame.event === event));
    return found ? Promise.resolve(found) : new Promise<Record<string, unknown>>(resolve => waiters.set(waitKey, resolve));
  };
  const closed = once(ws, 'close');
  await f.frame(1); f.send({ setupComplete: {} }); await next('ready');
  const handle = 'synthetic-canonical-host-resumption-secret';
  f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle }, goAway: { timeLeft: '10s' } });
  await f.frame(2);
  // Assert the actual serialized shape before waiting on resumed: missing fields fail promptly.
  const rebuilding = await next('continuity');
  assert.deepEqual(rebuilding, { type: 'continuity', event: 'rebuilding', reason: 'go_away', sequence: null, journalSequence: rebuilding.journalSequence });
  assert.equal(typeof rebuilding.journalSequence, 'number');
  const pageToken = 'r'.repeat(43);
  host.store.transaction(tx => tx.run('INSERT INTO runtime_sessions VALUES (?,?,?,?)', [createHash('sha256').update(pageToken).digest('hex'), 'resume-page', 'csrf', Date.now() + 60_000]));
  const projection = await json(host.service.origin, '/api/v1/live/current', { headers: { cookie: `didi_session=${pageToken}` } });
  assert.equal(projection.status, 200);
  assert.equal(projection.body.data.state, 'rebuilding');
  const status = await json(host.service.origin, '/api/v1/live/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.status, 'configured');
  const snapshot = await json(host.service.origin, `/api/v1/live-sessions/${id}`, { headers });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.data.liveSessionId, id);
  assert.equal(JSON.stringify([frames, projection.body, status.body, snapshot.body]).includes(handle), false);
  assert.equal(readFileSync(join(dataDir, 'logs', 'host.log'), 'utf8').includes(handle), false);
  f.send({ setupComplete: {} });
  const resumed = await next('continuity', 'resumed');
  assert.deepEqual(resumed, { type: 'continuity', event: 'resumed', sequence: null, journalSequence: resumed.journalSequence });
  assert.ok(Number(resumed.journalSequence) > Number(rebuilding.journalSequence));
  assert.deepEqual(host.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,memory_provenance FROM live_sessions WHERE live_session_id=?', [id])), frozen);
  // The explicit client close control intentionally closes before terminal delivery.
  // End from the provider instead, keeping the consumer attached for the terminal fact.
  f.remoteClose('', 1000); await closed;
  assert.equal(frames.filter(frame => frame.type === 'terminal').length, 1);
  assert.equal(frames.find(frame => frame.type === 'terminal')!.code, 'remote_closed');
  const rows = host.store.transaction(tx => tx.all('SELECT journal_id,kind FROM live_journal WHERE live_session_id=? ORDER BY journal_id', [id]));
  assert.equal(rows.filter(row => row.kind === 'terminal').length, 1);
  assert.equal(new Set(rows.map(row => row.journal_id)).size, rows.length);
  assert.ok(rows.every((row, index) => index === 0 || Number(rows[index - 1]!.journal_id) < Number(row.journal_id)));
  assert.equal(readFileSync(join(dataDir, 'logs', 'host.log'), 'utf8').includes(handle), false);
  assert.equal(JSON.stringify(frames).includes(handle), false);
});
