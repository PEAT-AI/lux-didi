import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import { collect, control, fixture, options, pcm, request } from './live-voice-fixture.js';

// Synthetic provider-only secret; assertions never print it in captured production output.
const HANDLE = 'synthetic-resumption-secret';

test('resumption setup requests updates and forwards a usable handle without finishing on goAway', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  const captured = collect(session);
  await f.frame(1);
  assert.deepEqual((f.frames[0] as { setup: { sessionResumption?: unknown } }).setup.sessionResumption, {});
  assert.equal('historyConfig' in (f.frames[0] as { setup: Record<string, unknown> }).setup, false,
    'a new resumable session does not declare an unclosed initial-history phase');
  f.send({ setupComplete: {} }); await session.ready;
  f.send({ sessionResumptionUpdate: { resumable: true, newHandle: HANDLE }, goAway: { timeLeft: '1s' } });
  // Waiting for an emitted frame rather than a real timer keeps this test deterministic.
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  f.terminate();
  const outcome = await session.done; await captured.done;
  assert.ok(captured.events.some(e => e.type === ('resumptionHandle' as string) && 'handle' in e && e.handle === HANDLE));
  assert.ok(captured.events.some(e => e.type === 'goAway' && 'timeLeftMs' in e && e.timeLeftMs === 1000));
  assert.equal('recoverable' in outcome && outcome.recoverable, true);
  assert.equal(f.frames.length, 1, 'goAway stops outbound admission');
});

test('resumption transport policy failures are final while a network cut is recoverable', async t => {
  for (const code of [1008, 1011]) {
    const f = await fixture(t);
    const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
    collect(session);
    await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
    f.remoteClose('', code);
    const outcome = await session.done;
    assert.equal('recoverable' in outcome && outcome.recoverable, code === 1011);
  }
});

test('a resumed connection uses the remaining idle budget once, then the full activity interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Peer extends EventEmitter {
    readyState = WebSocket.CONNECTING as number;
    bufferedAmount = 0;
    send(_frame: string, callback: (error?: Error) => void) { callback(); }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); }
    terminate() { this.close(); }
  }
  const peer = new Peer();
  const session = new GeminiLiveVoiceAdapter(options({ limits: { idleMs: 40 }, socketFactory: () => {
    queueMicrotask(() => { peer.readyState = WebSocket.OPEN; peer.emit('open'); peer.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); });
    return peer as unknown as WebSocket;
  } })).open(request(), { ...control(), idleResetMs: 100 });
  const captured = collect(session);
  await session.ready;
  t.mock.timers.tick(30);
  peer.emit('message', Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: 'new activity' } } })));
  t.mock.timers.tick(40);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(captured.events.some(e => e.type === 'outcome'), false, 'activity refreshes the configured interval, not the reduced rebuild budget');
  t.mock.timers.tick(60);
  assert.equal((await session.done).code, 'idle_timeout'); await captured.done;
});

test('network socket creation errors are recoverable but missing credentials are final', async () => {
  for (const credential of [undefined, 'synthetic-key']) {
    const session = new GeminiLiveVoiceAdapter(options({ credentials: { resolve: async () => credential }, socketFactory: () => { throw Object.assign(Error('synthetic-network-error'), { code: 'ECONNRESET' }); } })).open(request(), control());
    const captured = collect(session);
    const outcome = await session.done; await captured.done;
    assert.equal(Boolean(outcome.recoverable), credential !== undefined);
  }
});

test('resumed setup does not replay original history or the model-first opening turn', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({ ...request(), resumptionHandle: HANDLE, opening: 'model_first', history: [{ role: 'user', text: 'Original accepted pickup', dataClass: 'ordinary' }] }, control());
  const captured = collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  session.close(); await session.done; await captured.done;
  assert.equal(f.frames.length, 1, 'resume sends setup only, never a reconstructed history or opening turn');
  assert.equal('historyConfig' in (f.frames[0] as { setup: Record<string, unknown> }).setup, false,
    'resumption does not open a second initial-history phase');
  assert.equal((f.frames[0] as { setup: { sessionResumption: { handle: string } } }).setup.sessionResumption.handle === HANDLE, true);
});


for (const status of [301, 400, 401, 403, 429, 500]) test(`HTTP upgrade refusal ${status} is a final setup rejection`, async t => {
  const f = await fixture(t); f.refuseUpgrades(status);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({ ...request(), resumptionHandle: HANDLE }, control());
  const readiness = session.ready.then(() => 'ready', error => error.code);
  const captured = collect(session);
  const outcome = await session.done; await captured.done;
  assert.equal(outcome.code, 'provider_setup_rejected');
  assert.equal(Boolean(outcome.recoverable), false);
  assert.equal(await readiness, 'provider_setup_rejected');
  assert.equal(f.attempts, 1); assert.equal(f.connections, 0); assert.equal(f.frames.length, 0);
});

test('a real WebSocket protocol violation after setupComplete is final', async t => {
  const f = await fixture(t);
  const errors: unknown[] = [];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: (url, config) => {
    const client = f.socketFactory(url, config);
    client.on('error', error => errors.push((error as Error & { code?: unknown }).code));
    return client;
  } })).open(request(), control());
  const captured = collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  f.invalidOpcode();
  const outcome = await session.done; await captured.done;
  assert.ok(errors.includes('WS_ERR_INVALID_OPCODE'), 'the real receiver, not JSON parsing, detected the violation');
  assert.equal(outcome.code, 'protocol_error'); assert.equal(Boolean(outcome.recoverable), false);
  assert.equal(f.attempts, 1);
});

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', undefined]) test(`socket error ${code ?? 'unclassified'} is recoverable only with genuine network evidence`, async t => {
  const f = await fixture(t); let fail: () => void = () => {};
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: (url, config) => {
    const client = f.socketFactory(url, config);
    fail = () => client.emit('error', Object.assign(Error('Synthetic socket failure'), code === undefined ? {} : { code }));
    return client;
  } })).open(request(), control());
  const captured = collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready; fail();
  const outcome = await session.done; await captured.done;
  assert.equal(Boolean(outcome.recoverable), code !== undefined);
  assert.equal(outcome.code, code === undefined ? 'provider_error' : 'transport_error');
});
