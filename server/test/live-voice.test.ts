import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { GeminiLiveVoiceAdapter, LiveVoiceError } from '../adapters/live-voice/index.js';
import type { GeminiLiveVoiceOptions, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { CANARY, collect, control, deferred, fixture, options, pcm, ready, request } from './live-voice-fixture.js';

const code = (expected: string) => (error: unknown) => error instanceof LiveVoiceError && error.code === expected && error.message === expected;
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } });
function noCanary(value: unknown) { assert.equal(JSON.stringify(value).includes(CANARY), false, 'public serialization is sanitized'); }

test('wire setup/history snapshots, readiness, PCM and three independent output boundaries', async t => {
  const f = await fixture(t);
  const settings = options({ socketFactory: f.socketFactory });
  const input = request(); input.history = [{ role: 'user', text: 'Whole history', dataClass: 'ordinary' }];
  const session = new GeminiLiveVoiceAdapter(settings).open(input, control()); t.after(() => session.close());
  const captured = collect(session);
  input.system.text = 'MUTATED'; (settings.route.dataClasses as string[]).push('private');
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'ordinary' }), code('not_ready'));
  await f.frame(1);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.frames[0], { setup: {
    model: 'models/explicit-live-test', generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'ExplicitVoice' } } } },
    systemInstruction: { parts: [{ text: 'Synthetic system' }] }, inputAudioTranscription: {}, outputAudioTranscription: {},
  } });
  const endpoint = new URL(f.destination);
  assert.equal(endpoint.origin, 'wss://generativelanguage.googleapis.com');
  assert.equal(endpoint.pathname, '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
  assert.equal(endpoint.searchParams.get('key'), CANARY);
  f.send({ setupComplete: {} }); await session.ready; await f.frame(2);
  assert.deepEqual(f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: 'Whole history' }] }], turnComplete: false } });
  session.sendAudio({ pcm, dataClass: 'ordinary' }); session.endAudioStream(); await f.frame(4);
  assert.deepEqual(f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });
  assert.deepEqual(f.frames[3], { realtimeInput: { audioStreamEnd: true } });
  f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio(), { text: 'unspoken thought', thought: true }] }, outputTranscription: { text: 'One', finished: true }, generationComplete: true, turnComplete: true } });
  f.send({ serverContent: { interrupted: true, turnComplete: true } });
  f.send({ serverContent: { modelTurn: { parts: [audio()] }, generationComplete: true } });
  f.send({ serverContent: { turnComplete: true, waitingForInput: true, interactionStatus: 'IDLE' } });
  f.send({ serverContent: { inputTranscription: { text: 'late independent input', finished: true } } });
  f.send({ sessionResumptionUpdate: { resumable: true, newHandle: CANARY } });
  f.send({ goAway: { timeLeft: '1s' } });
  assert.deepEqual(await session.done, { status: 'failed', code: 'go_away' }); await captured.done;
  assert.deepEqual(captured.events.map(e => e.type), ['ready', 'audio', 'modelText', 'outputTranscription', 'generationComplete', 'turnComplete', 'interrupted', 'turnComplete', 'audio', 'generationComplete', 'turnComplete', 'waitingForInput', 'interactionStatus', 'inputTranscription', 'resumptionAvailability', 'goAway', 'outcome']);
  assert.deepEqual(captured.events.map(e => e.sequence), captured.events.map((_, i) => i + 1));
  const output = captured.events.find((e): e is Extract<LiveVoiceEvent, { type: 'audio' }> => e.type === 'audio')!;
  assert.deepEqual(output.pcm, pcm); assert.equal(output.mimeType, 'audio/pcm;rate=24000');
  assert.equal(captured.events.some(e => 'turnId' in e || 'heard' in e || 'handle' in e), false); noCanary(captured.events);
  assert.equal(f.attempts, 1); assert.equal(f.frames.length, 4);
});

test('empty history sends no fabricated turn; close has one requested terminal outcome', async t => {
  const { f, session, captured } = await ready(t);
  assert.equal(f.frames.length, 1);
  session.sendAudio({ pcm, dataClass: 'ordinary' }); await f.frame(2);
  session.close(); session.close(); assert.deepEqual(await session.done, { status: 'closed', code: 'closed' }); await captured.done;
  assert.equal(captured.events.filter(e => e.type === 'outcome').length, 1);
  assert.equal(f.frames.length, 2); assert.equal(f.attempts, 1);
});

test('disabled/mismatched/unknown route and classified request fail before credential/socket', async () => {
  let keys = 0, sockets = 0;
  const base = options({ credentials: { resolve: async () => { keys++; return CANARY; } }, socketFactory: () => { sockets++; throw Error(CANARY); } });
  for (const route of [ { ...base.route, enabled: false }, { ...base.route, modelId: 'models/other' }, { ...base.route, provider: 'unknown' } ]) {
    assert.throws(() => new GeminiLiveVoiceAdapter({ ...base, route } as GeminiLiveVoiceOptions).open(request(), control()), code('route_denied'));
  }
  for (const bad of [ { ...request(), dataClasses: ['private'] }, { ...request(), dataClasses: ['unknown'] }, { ...request(), system: { text: 'x', dataClass: 'private' } }, { ...request(), history: [{ role: 'tool', text: 'x', dataClass: 'ordinary' }] }, { ...request(), history: [{ role: 'user', text: '', dataClass: 'ordinary' }] }, { ...request(), system: null } ]) {
    assert.throws(() => new GeminiLiveVoiceAdapter(base).open(bad as LiveVoiceRequest, control()), e => e instanceof LiveVoiceError);
  }
  assert.equal(keys, 0); assert.equal(sockets, 0);
});

test('all byte/count/time limits reject invalid numeric values and oversized initial history atomically', () => {
  const names: (keyof LiveVoiceLimits)[] = ['maxIncomingBytes', 'maxOutgoingBytes', 'maxBufferedBytes', 'maxEventBytes', 'maxEvents', 'maxRequestBytes', 'maxHistoryTurns', 'handshakeMs', 'idleMs', 'sessionMs', 'closeMs'];
  let keys = 0; const credentials = { resolve: async () => { keys++; return CANARY; } };
  for (const name of names) for (const value of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new GeminiLiveVoiceAdapter(options({ credentials, limits: { [name]: value } })), code('invalid_settings'));
  }
  assert.throws(() => new GeminiLiveVoiceAdapter(options({ limits: { closeMs: 2147483648 } })), code('invalid_settings'));
  for (const value of ['', 'gemini text model', 'https://example.test/model']) {
    assert.throws(() => new GeminiLiveVoiceAdapter(options({ modelId: value })), code('invalid_settings'));
  }
  const adapter = new GeminiLiveVoiceAdapter(options({ credentials, limits: { maxRequestBytes: 8 } }));
  assert.throws(() => adapter.open(request(), control()), code('invalid_request'));
  const counted = new GeminiLiveVoiceAdapter(options({ credentials, limits: { maxHistoryTurns: 1 } }));
  assert.throws(() => counted.open({ ...request(), history: [{ role: 'user', text: '1', dataClass: 'ordinary' }, { role: 'model', text: '2', dataClass: 'ordinary' }] }, control()), code('invalid_request'));
  for (const deadlineMs of [NaN, Infinity, 0, 1.5]) assert.throws(() => counted.open(request(), { ...control(), deadlineMs }), code('invalid_request'));
  assert.equal(keys, 0);
});

test('abort before and after deferred credentials never creates socket or sends prompt', async () => {
  for (const before of [true, false]) {
    const resolver = deferred<string>(); let keys = 0, sockets = 0;
    const abort = new AbortController(); if (before) abort.abort(CANARY);
    const session = new GeminiLiveVoiceAdapter(options({ credentials: { resolve: async reference => { assert.equal(reference, 'test-reference'); keys++; return resolver.promise; } }, socketFactory: () => { sockets++; throw Error(CANARY); } })).open(request(), control(abort.signal));
    const captured = collect(session); if (!before) abort.abort(CANARY);
    resolver.resolve(CANARY); assert.equal((await session.done).code, 'cancelled'); await captured.done;
    await assert.rejects(session.ready, code('cancelled')); await Promise.resolve();
    assert.equal(keys, before ? 0 : 1); assert.equal(sockets, 0); noCanary(captured.events);
  }
});

test('deadline while credentials are deferred closes without socket after resolution', async () => {
  const resolver = deferred<string>(); let sockets = 0;
  const session = new GeminiLiveVoiceAdapter(options({ credentials: { resolve: () => resolver.promise }, socketFactory: () => { sockets++; throw Error(CANARY); } })).open(request(), { ...control(), deadlineMs: Date.now() + 30 });
  assert.equal((await session.done).code, 'deadline'); resolver.resolve(CANARY); await Promise.resolve(); await Promise.resolve();
  assert.equal(sockets, 0); await assert.rejects(session.ready, code('deadline'));
});

test('actual connected abort refuses later audio and never queues pre-setup input', async t => {
  const f = await fixture(t); const abort = new AbortController();
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control(abort.signal));
  const captured = collect(session); await f.frame(1);
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'ordinary' }), code('not_ready'));
  f.send({ setupComplete: {} }); await session.ready;
  abort.abort(CANARY);
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'ordinary' }), code('cancelled'));
  assert.equal((await session.done).code, 'cancelled'); await captured.done;
  assert.equal(f.frames.length, 1); noCanary(captured.events);
});

test('permission/settings snapshots resist mutation and no-revoke control sends exact audio once', async t => {
  const f = await fixture(t); const settings = options({ socketFactory: f.socketFactory });
  const adapter = new GeminiLiveVoiceAdapter(settings);
  settings.route.enabled = false; settings.modelId = 'models/mutated'; settings.limits!.maxOutgoingBytes = 1;
  const req = request(); const session = adapter.open(req, control()); const captured = collect(session);
  (req.dataClasses as string[]).push('private'); req.system.text = 'mutated';
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'private' }), code('route_denied'));
  for (const invalid of [new Uint8Array(), new Uint8Array([0])]) assert.throws(() => session.sendAudio({ pcm: invalid, dataClass: 'ordinary' }), code('invalid_audio'));
  session.sendAudio({ pcm, dataClass: 'ordinary' }); await f.frame(2); session.close(); await session.done; await captured.done;
  assert.equal(f.frames.length, 2); assert.equal(f.attempts, 1);
});

test('split and combined protocol fields preserve late input, thought and unknown additions', async t => {
  const { f, session, captured } = await ready(t);
  f.send({ harmlessFutureField: { value: 1 } });
  f.send({ serverContent: { generationComplete: true } });
  f.send({ serverContent: { interrupted: true, turnComplete: true, inputTranscription: { text: 'late' }, outputTranscription: { text: 'out' }, modelTurn: { parts: [{ text: 'text only' }] } } });
  f.send({ goAway: { timeLeft: '0.5s' } }); await session.done; await captured.done;
  assert.deepEqual(captured.events.map(e => e.type), ['ready', 'generationComplete', 'modelText', 'inputTranscription', 'outputTranscription', 'interrupted', 'turnComplete', 'goAway', 'outcome']);
});

for (const [name, payload, expected] of [
  ['empty object', {}, 'protocol_error'], ['invalid JSON', 'raw', 'protocol_error'], ['array', [], 'protocol_error'],
  ['empty content', { serverContent: {} }, 'protocol_error'], ['null transcription', { serverContent: { inputTranscription: null } }, 'protocol_error'],
  ['bad completion flag', { serverContent: { turnComplete: 'true' } }, 'protocol_error'], ['bad text', { serverContent: { outputTranscription: { text: 3 } } }, 'protocol_error'],
  ['bad rate', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: 'AAA=' } }] } } }, 'protocol_error'],
  ['bad base64', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: '!!' } }] } } }, 'protocol_error'],
  ['odd PCM', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] } } }, 'protocol_error'],
  ['unsupported tool', { toolCall: { functionCalls: [{ name: CANARY, args: { secret: CANARY } }] } }, 'unsupported_tool'],
  ['provider error', { error: { code: 401, message: CANARY } }, 'provider_error'],
  ['invalid goAway', { goAway: { timeLeft: CANARY } }, 'protocol_error'],
] as const) {
  test(`recognized payload fails closed: ${name}`, async t => {
    const { f, session, captured } = await ready(t);
    if (payload === 'raw') f.sendRaw(CANARY); else f.send(payload);
    assert.equal((await session.done).code, expected); await captured.done; noCanary(captured.events);
  });
}

test('duplicate setupComplete and server content before setup fail closed', async t => {
  for (const duplicate of [true, false]) {
    const f = await fixture(t); const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
    await f.frame(1); if (duplicate) { f.send({ setupComplete: {} }); await session.ready; }
    f.send(duplicate ? { setupComplete: {} } : { serverContent: { turnComplete: true } });
    assert.equal((await session.done).code, 'protocol_error');
  }
});

test('remote close reason and thrown resolver/socket errors are sanitized, distinct from close', async t => {
  const { f, session, captured } = await ready(t); f.remoteClose(CANARY);
  assert.deepEqual(await session.done, { status: 'failed', code: 'remote_closed' }); await captured.done; noCanary(captured.events);
  const logs: string[] = []; const old = console.error; console.error = (...args) => logs.push(JSON.stringify(args));
  try {
    for (const credentials of [ { resolve: async () => { throw Error(`wss://${CANARY}/?key=${CANARY}`); } }, { resolve: async () => CANARY } ]) {
      const s = new GeminiLiveVoiceAdapter(options({ credentials, socketFactory: () => { throw Error(CANARY); } })).open(request(), control());
      const c = collect(s); const result = await s.done; await c.done;
      assert.equal(result.status, 'failed'); await assert.rejects(s.ready, e => { assert.ok(e instanceof LiveVoiceError); noCanary({ name: e.name, message: e.message, stack: e.stack }); return true; }); noCanary(c.events);
    }
  } finally { console.error = old; }
  noCanary(logs);
});

test('actual ws error and disconnect have no replay', async t => {
  const f = await fixture(t); let client!: WebSocket;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: (url, config) => { client = f.socketFactory(url, config); return client; } })).open(request(), control());
  const captured = collect(session); await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  client.emit('error', Error(CANARY)); assert.equal((await session.done).code, 'transport_error'); await captured.done;
  assert.equal(f.attempts, 1); noCanary(captured.events);
});

test('real maxPayload rejects oversized ws message before application parsing', async t => {
  const { f, session, captured } = await ready(t, { limits: { maxIncomingBytes: 256, closeMs: 30 } });
  f.sendRaw('x'.repeat(1024)); assert.equal((await session.done).code, 'incoming_limit'); await captured.done; noCanary(captured.events);
});

test('bounded event retention fails explicitly rather than dropping speech', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, limits: { maxEvents: 2, maxEventBytes: 1024, closeMs: 30 } })).open(request(), control());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  f.send({ serverContent: { inputTranscription: { text: 'one' }, outputTranscription: { text: 'two' }, turnComplete: true } });
  assert.equal((await session.done).code, 'event_limit');
  const captured = collect(session); await captured.done;
  assert.equal(captured.events.at(-1)?.type, 'outcome'); assert.ok(captured.events.length <= 3);
});

test('bounded event bytes and outgoing frame fail explicitly', async t => {
  const { f, session, captured } = await ready(t, { limits: { maxEventBytes: 80, closeMs: 30 } });
  f.send({ serverContent: { inputTranscription: { text: 'x'.repeat(256) } } }); assert.equal((await session.done).code, 'event_limit'); await captured.done;
  const second = await ready(t, { limits: { maxOutgoingBytes: 512, closeMs: 30 } });
  assert.throws(() => second.session.sendAudio({ pcm: new Uint8Array(1024), dataClass: 'ordinary' }), code('outgoing_limit'));
  assert.equal((await second.session.done).code, 'outgoing_limit'); assert.equal(second.f.frames.length, 1); await second.captured.done;
});

test('socket bufferedAmount backpressure is checked before any audio write', async t => {
  const f = await fixture(t); let client!: WebSocket;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: (url, config) => { client = f.socketFactory(url, config); return client; }, limits: { maxBufferedBytes: 512, closeMs: 30 } })).open(request(), control());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  // Deterministic congestion seam on the actual ws instance; no synthetic host load.
  Object.defineProperty(client, 'bufferedAmount', { get: () => 513 });
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'ordinary' }), code('backpressure'));
  assert.equal((await session.done).code, 'backpressure'); assert.equal(f.frames.length, 1);
});

test('handshake, idle, session and deadline timers bound cleanup', async t => {
  for (const expected of ['handshake_timeout', 'idle_timeout', 'session_timeout', 'deadline'] as const) {
    const f = await fixture(t);
    const limits = { handshakeMs: expected === 'handshake_timeout' ? 30 : 1000, idleMs: expected === 'idle_timeout' ? 30 : 1000, sessionMs: expected === 'session_timeout' ? 30 : 3000, closeMs: 20 };
    const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, limits })).open(request(), { ...control(), deadlineMs: Date.now() + (expected === 'deadline' ? 30 : 4000) });
    await f.frame(1); if (expected !== 'handshake_timeout') { f.send({ setupComplete: {} }); await session.ready; }
    assert.equal((await session.done).code, expected);
    assert.equal(f.attempts, 1);
  }
});

test('close cleanup terminates a peer that never completes close handshake', async t => {
  const f = await fixture(t); const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, limits: { closeMs: 30 } })).open(request(), control());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  // Pause the real peer socket before it can read the close frame.
  f.peer.pause(); const start = Date.now(); session.close(); assert.equal((await session.done).code, 'closed');
  assert.ok(Date.now() - start < 1000); f.peer.resume();
});
