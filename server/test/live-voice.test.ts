import './live-remember.test.js';
import './live-declarations.test.js';
import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { GeminiLiveVoiceAdapter, LiveVoiceError } from '../adapters/live-voice/index.js';
import type { GeminiLiveVoiceOptions, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { CANARY, speechActivityFrames, collect, control, deferred, fixture as providerFixture, options, pcm, ready as providerReady, request } from './live-voice-fixture.js';

const code = (expected: string) => (error: unknown) => error instanceof LiveVoiceError && error.code === expected && error.message === expected;
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } });
function noCanary(value: unknown) { assert.equal(JSON.stringify(value).includes(CANARY), false, 'public serialization is sanitized'); }

for (const frameMode of ['binary', 'text'] as const) describe(`${frameMode} provider frames`, () => {
const fixture = (t: TestContext) => providerFixture(t, frameMode);
const ready = (t: TestContext, overrides: Partial<GeminiLiveVoiceOptions> = {}) => providerReady(t, overrides, frameMode);

test('explicit user-first opening preserves incomplete history and model-first opens a spoken turn without user audio', async t => {
  for (const opening of ['user_first', 'model_first'] as const) {
    const f = await fixture(t);
    const input = { ...request(), opening: opening as 'user_first' | 'model_first',
      history: [{ role: 'user' as const, text: 'Actual pending job result', dataClass: 'ordinary' as const }] };
    const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(input, control());
    t.after(() => session.close());
    const events = session.events[Symbol.asyncIterator]();
    input.opening = 'user_first'; // Opening, like history, is captured before credentials or handshake.
    await f.frame(1);
    assert.equal('historyConfig' in (f.frames[0] as { setup: Record<string, unknown> }).setup, false,
      'normal client content never declares a non-generating initial-history phase');
    f.send({ setupComplete: {} }); await session.ready; await f.frame(2);
    assert.deepEqual(f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: 'Actual pending job result' }] }], turnComplete: opening === 'model_first' } });
    assert.equal((await events.next()).value?.type, 'ready');
    if (opening === 'model_first') {
      // The provider fixture responds to the completed opening turn without any microphone frame.
      f.send({ serverContent: { modelTurn: { parts: [audio()] }, outputTranscription: { text: 'Here is the actual result.', finished: true }, generationComplete: true, turnComplete: true } });
      const firstTurn = [];
      for (;;) {
        const next = await events.next(); assert.equal(next.done, false);
        firstTurn.push(next.value);
        if (next.value?.type === 'turnComplete') break;
      }
      assert.ok(firstTurn.some(event => event?.type === 'audio'));
      assert.ok(firstTurn.some(event => event?.type === 'outputTranscription' && event.text === 'Here is the actual result.'));
      assert.equal(f.frames.length, 2, 'no audio input or nudge message starts the opening turn');
    }
  }
});

test('empty-history model-first sends one server-owned Companion greeting without client audio', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({
    ...request(), opening: 'model_first', history: [],
  }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1);
  f.send({ setupComplete: {} });
  await Promise.all([session.ready, f.frame(2)]);
  assert.deepEqual(f.frames[1], { realtimeInput: { text: 'Greet the person briefly to begin the conversation.' } });
  assert.equal((await events.next()).value?.type, 'ready');
  assert.equal(f.frames.length, 2, 'exactly one fresh opening directive is sent without PCM');
});

test('a failed fresh opening write never resolves public ready', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({
    ...request(), opening: 'model_first', history: [],
  }, control());
  t.after(() => session.close());
  const captured = collect(session);
  await f.frame(1);
  const socket = f.clients[0]!;
  const send = socket.send.bind(socket) as (data: string, callback?: (error?: Error) => void) => void;
  t.mock.method(socket, 'send', (data: string, callback?: (error?: Error) => void) => {
    if (data.includes('Greet the person briefly')) throw Error('synthetic opening write failure');
    send(data, callback);
  });
  f.send({ setupComplete: {} });
  await assert.rejects(session.ready, code('provider_error'));
  assert.equal((await session.done).code, 'provider_error');
  await captured.done;
  assert.equal(captured.events.some(event => event.type === 'ready'), false);
});

test('invalid opening modes are refused before credentials or dispatch', t => {
  let credentials = 0;
  const adapter = new GeminiLiveVoiceAdapter(options({ credentials: { resolve: async () => { credentials++; return CANARY; } }, socketFactory: () => { throw new Error('Unexpected invalid-opening dispatch'); } }));
  for (const opening of ['invalid', null, false]) {
    assert.throws(() => {
      const session = adapter.open({ ...request(), opening } as unknown as ReturnType<typeof request>, control());
      t.after(() => session.close());
    }, code('invalid_request'));
  }
  assert.equal(credentials, 0);
});

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
    sessionResumption: {},
    model: 'models/explicit-live-test', generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'ExplicitVoice' } } }, thinkingConfig: { thinkingLevel: 'minimal' } },
    contextWindowCompression: { slidingWindow: { targetTokens: 32000 } },
    realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' } },
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
  f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-adapter-resumption-secret' } });
  f.send({ goAway: { timeLeft: '1s' } });
  while (!captured.events.some(event => event.type === 'goAway')) await new Promise<void>(resolve => setImmediate(resolve));
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  f.remoteClose('', 1000);
  assert.deepEqual(await session.done, { status: 'failed', code: 'go_away', recoverable: true }); await captured.done;
  assert.deepEqual(captured.events.map(e => e.type), ['ready', 'audio', 'modelText', 'outputTranscription', 'modelTurnStarted', 'generationComplete', 'turnComplete', 'interrupted', 'turnComplete', 'audio', 'modelTurnStarted', 'generationComplete', 'turnComplete', 'waitingForInput', 'interactionStatus', 'inputTranscription', 'resumptionHandle', 'goAway', 'outcome']);
  assert.deepEqual(captured.events.map(e => e.sequence), captured.events.map((_, i) => i + 1));
  const output = captured.events.find((e): e is Extract<LiveVoiceEvent, { type: 'audio' }> => e.type === 'audio')!;
  assert.deepEqual(output.pcm, pcm); assert.equal(output.mimeType, 'audio/pcm;rate=24000');
  assert.ok(captured.events.some(e => e.type === 'resumptionHandle' && e.handle === 'synthetic-adapter-resumption-secret'));
  assert.equal(captured.events.some(e => 'turnId' in e || 'heard' in e), false); noCanary(captured.events);
  assert.equal(f.attempts, 1); assert.equal(f.frames.length, 4);
  assert.deepEqual(session.diagnostics?.(), {
    audioCalls: 1, audioBytes: pcm.byteLength,
    drainingDropCalls: 1, drainingDropBytes: pcm.byteLength,
    localWriteEnqueuedCalls: 1, localWriteEnqueuedPCMBytes: pcm.byteLength,
    localWriteCallbackSuccessCalls: 1, localWriteCallbackSuccessPCMBytes: pcm.byteLength,
    localWriteCallbackErrorCalls: 0, localWriteCallbackErrorPCMBytes: 0,
    localWriteCallbackPendingCalls: 0, localWriteCallbackPendingPCMBytes: 0,
    inputTranscriptionEvents: 1, inputTranscriptionCharacters: 'late independent input'.length,
    generationCompleteEvents: 2, turnCompleteEvents: 3,
    outputAudioFrames: 2, outputAudioPCMBytes: pcm.byteLength * 2,
    outputAudioAfterInitialTurnFrames: 1, outputAudioAfterInitialTurnPCMBytes: pcm.byteLength,
  });
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
  const ownedInput = new Uint8Array(pcm);
  session.sendAudio({ pcm: ownedInput, dataClass: 'ordinary' }); ownedInput.fill(99);
  await f.frame(2); session.close(); await session.done; await captured.done;
  assert.deepEqual(f.frames[1], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });
  assert.equal(f.frames.length, 2); assert.equal(f.attempts, 1);
});

test('diagnostics retain an outstanding local audio write callback without delaying close', async t => {
  const { f, session, captured } = await ready(t);
  const socket = f.clients[0]!;
  const send = socket.send.bind(socket) as (data: string, callback?: (error?: Error) => void) => void;
  t.mock.method(socket, 'send', (data: string, callback?: (error?: Error) => void) => {
    if (data.includes('realtimeInput') && data.includes('audio/pcm')) return;
    send(data, callback);
  });
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  assert.equal(session.diagnostics?.().localWriteCallbackPendingCalls, 1);
  session.close(); assert.deepEqual(await session.done, { status: 'closed', code: 'closed' }); await captured.done;
  const diagnostics = session.diagnostics?.();
  assert.equal(diagnostics?.localWriteEnqueuedCalls, 1); assert.equal(diagnostics?.localWriteEnqueuedPCMBytes, pcm.byteLength);
  assert.equal(diagnostics?.localWriteCallbackPendingCalls, 1); assert.equal(diagnostics?.localWriteCallbackPendingPCMBytes, pcm.byteLength);
  assert.equal(diagnostics?.localWriteCallbackSuccessCalls, 0); assert.equal(diagnostics?.localWriteCallbackErrorCalls, 0);
});

test('split and combined protocol fields preserve late input, thought and unknown additions', async t => {
  const { f, session, captured } = await ready(t);
  f.send({ harmlessFutureField: { value: 1 } });
  f.send({ serverContent: { generationComplete: true } });
  f.send({ serverContent: { interrupted: true, turnComplete: true, inputTranscription: { text: 'late' }, outputTranscription: { text: 'out' }, modelTurn: { parts: [{ text: 'text only' }] } } });
  f.send({ goAway: { timeLeft: '0.5s' } }); f.remoteClose('', 1000); await session.done; await captured.done;
  assert.deepEqual(captured.events.map(e => e.type), ['ready', 'generationComplete', 'modelText', 'inputTranscription', 'outputTranscription', 'modelTurnStarted', 'interrupted', 'turnComplete', 'goAway', 'outcome']);
});

test('Gemini 3.8 ignores empty lifecycle envelopes only after setup', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.8-live';
  const session = new GeminiLiveVoiceAdapter(options({
    modelId, socketFactory: f.socketFactory,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] },
  })).open(request(), control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-3.8-handle' } });
  f.sendRaw('{}\n');
  f.send({ serverContent: {} });
  f.send({ serverContent: { modelTurn: { parts: [audio()] } } });
  assert.equal((await events.next()).value?.type, 'ready');
  assert.equal((await events.next()).value?.type, 'resumptionHandle');
  assert.equal((await events.next()).value?.type, 'audio');
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  session.close();
  assert.deepEqual(await session.done, { status: 'closed', code: 'closed' });
  assert.equal((await events.next()).value?.type, 'outcome');
  assert.equal((await events.next()).done, true);
});

test('Gemini 3.8 still rejects an empty envelope before setup', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.8-live';
  const session = new GeminiLiveVoiceAdapter(options({
    modelId, socketFactory: f.socketFactory,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] },
  })).open(request(), control());
  t.after(() => session.close());
  const captured = collect(session);
  await f.frame(1); f.sendRaw('{}\n');
  assert.equal((await session.done).code, 'protocol_error');
  await captured.done;
});

for (const [name, payload, expected] of [
  ['empty object', {}, 'protocol_error'], ['invalid JSON', 'raw', 'protocol_error'], ['array', [], 'protocol_error'],
  ['null content', { serverContent: null }, 'protocol_error'], ['null transcription', { serverContent: { inputTranscription: null } }, 'protocol_error'],
  ['bad completion flag', { serverContent: { turnComplete: 'true' } }, 'protocol_error'], ['bad text', { serverContent: { outputTranscription: { text: 3 } } }, 'protocol_error'],
  ['bad rate', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: 'AAA=' } }] } } }, 'protocol_error'],
  ['bad base64', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: '!!' } }] } } }, 'protocol_error'],
  ['odd PCM', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] } } }, 'protocol_error'],
  ['malformed tool call', { toolCall: { functionCalls: [{ name: CANARY, args: { secret: CANARY } }] } }, 'protocol_error'],
  ['provider error', { error: { code: 401, message: CANARY } }, 'provider_error'],
  ['invalid goAway', { goAway: { timeLeft: CANARY } }, 'protocol_error'],
  ['key in model text', { serverContent: { modelTurn: { parts: [{ text: `wss://example.test/?key=${CANARY}` }] } } }, 'protocol_error'],
  ['key in transcription', { serverContent: { inputTranscription: { text: CANARY } } }, 'protocol_error'],
  ['bad activity', { serverContent: { waitingForInput: CANARY } }, 'protocol_error'],
] as const) {
  test(`recognized payload fails closed: ${name}`, async t => {
    const { f, session, captured } = await ready(t);
    if (payload === 'raw') f.sendRaw(CANARY); else f.send(payload);
    assert.equal((await session.done).code, expected); await captured.done; noCanary(captured.events);
  });
}

test('duplicate setupComplete and server content before setup fail closed', async t => {
  for (const variant of ['duplicate', 'content', 'empty']) {
    const duplicate = variant === 'duplicate';
    const f = await fixture(t); const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
    await f.frame(1); if (duplicate) { f.send({ setupComplete: {} }); await session.ready; }
    f.send(duplicate ? { setupComplete: {} } : { serverContent: variant === 'empty' ? {} : { turnComplete: true } });
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
  client.emit('error', Object.assign(Error(CANARY), { code: 'ECONNRESET' })); assert.equal((await session.done).code, 'transport_error'); await captured.done;
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
  const second = await ready(t, { limits: { maxOutgoingBytes: 1024, closeMs: 30 } });
  assert.throws(() => second.session.sendAudio({ pcm: new Uint8Array(1024), dataClass: 'ordinary' }), code('outgoing_limit'));
  assert.equal((await second.session.done).code, 'outgoing_limit'); assert.equal(second.f.frames.length, 1); await second.captured.done;
});

test('socket bufferedAmount backpressure is checked before any audio write', async t => {
  const f = await fixture(t); let client!: WebSocket;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: (url, config) => { client = f.socketFactory(url, config); return client; }, limits: { maxBufferedBytes: 1024, closeMs: 30 } })).open(request(), control());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  // Deterministic congestion seam on the actual ws instance; no synthetic host load.
  Object.defineProperty(client, 'bufferedAmount', { get: () => 1025 });
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

test('abort invalidation inside trusted socket factory closes real socket without setup', async t => {
  const f = await fixture(t); const abort = new AbortController(); let client!: WebSocket;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: (url, config) => {
    client = f.socketFactory(url, config); abort.abort(CANARY); return client;
  } })).open(request(), control(abort.signal));
  const captured = collect(session);
  assert.equal((await session.done).code, 'cancelled'); await captured.done;
  assert.equal(client.readyState, WebSocket.CLOSED);
  assert.equal(f.frames.length, 0); assert.equal(f.attempts, 1); noCanary(captured.events);
});

test('unsolicited disconnect has one remote outcome and no audio resend', async t => {
  const { f, session, captured } = await ready(t);
  session.sendAudio({ pcm, dataClass: 'ordinary' }); await f.frame(2); f.terminate();
  assert.equal((await session.done).code, 'remote_closed'); await captured.done;
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'ordinary' }), code('remote_closed'));
  assert.equal(f.frames.length, 2); assert.equal(f.attempts, 1);
});

test('expired deadline and unrepresentable initial frame have zero credential/socket calls', async () => {
  let keys = 0, sockets = 0;
  const settings = options({ credentials: { resolve: async () => { keys++; return CANARY; } }, socketFactory: () => { sockets++; throw Error(CANARY); } });
  const expired = new GeminiLiveVoiceAdapter(settings).open(request(), { ...control(), deadlineMs: Date.now() - 1 });
  assert.equal((await expired.done).code, 'deadline');
  assert.throws(() => new GeminiLiveVoiceAdapter({ ...settings, limits: { maxOutgoingBytes: 1 } }).open(request(), control()), code('outgoing_limit'));
  assert.equal(keys, 0); assert.equal(sockets, 0);
});

test('Live tool batches buffer microphone audio in order behind one response frame, zero dropped', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.1-flash-live-preview';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } })).open({ ...request(), languageCode: 'ar', tools: [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
  ] }, control());
  const events = session.events[Symbol.asyncIterator](); t.after(() => session.close());
  await f.frame(1);
  const setup = (f.frames[0] as { setup: Record<string, any> }).setup;
  assert.deepEqual(setup.tools, [{ functionDeclarations: [{ name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } }] }]);
  assert.equal(setup.generationConfig.speechConfig.languageCode, 'ar-XA');
  assert.deepEqual(setup.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.equal(setup.historyConfig, undefined);
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: { targetTokens: 32000 } });
  assert.deepEqual(setup.realtimeInputConfig, { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' } });
  f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }, { id: 'c2', name: 'search_knowledge', args: { query: 'y' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  const event: LiveVoiceEvent | undefined = (await events.next()).value;
  assert.equal(event?.type, 'toolCall');
  if (event?.type !== 'toolCall') throw Error('missing tool call');
  assert.deepEqual(event.calls.map(c => c.id), ['c1', 'c2']);
  const first = new Uint8Array([1, 0, 2, 0]); const second = new Uint8Array([3, 0, 4, 0]);
  session.sendAudio({ pcm: first, dataClass: 'ordinary' });
  session.sendAudio({ pcm: second, dataClass: 'ordinary' });
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }, { id: 'c2', name: 'search_knowledge', response: { error: 'denied' } }] });
  await f.frame(2);
  assert.deepEqual(f.frames[1], { toolResponse: { functionResponses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }, { id: 'c2', name: 'search_knowledge', response: { error: 'denied' } }] } });
  await f.frame(4);
  assert.deepEqual(f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(first).toString('base64') } } });
  assert.deepEqual(f.frames[3], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(second).toString('base64') } } });
  session.close(); assert.equal((await session.done).status, 'closed');
  const diagnostics = session.diagnostics?.();
  assert.equal(diagnostics?.audioCalls, 2); assert.equal(diagnostics?.audioBytes, first.byteLength + second.byteLength);
  assert.equal(diagnostics?.localWriteEnqueuedCalls, 2); assert.equal(diagnostics?.localWriteCallbackPendingCalls, 0);
});

test('sustained speech while a tool batch is pending supersedes it behind a neutral response', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.1-flash-live-preview';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } })).open({ ...request(), tools: [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
  ] }, control());
  const events = session.events[Symbol.asyncIterator](); t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  const loud = new Uint8Array(16_000); for (let i = 0; i < loud.length; i += 2) { loud[i] = 0xff; loud[i + 1] = 0x7f; }
  session.sendAudio({ pcm: loud, dataClass: 'ordinary' });
  assert.equal((await events.next()).value?.type, 'toolCallSuperseded');
  await f.frame(2);
  const neutral = (f.frames[1] as { toolResponse: { functionResponses: { id: string; name: string; response: { result?: string } }[] } }).toolResponse.functionResponses;
  assert.deepEqual(neutral.map(response => response.id), ['c1']);
  assert.match(String(neutral[0]!.response.result), /set aside/);
  await f.frame(3);
  assert.deepEqual(f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(loud).toString('base64') } } }, 'the buffered speech is forwarded whole and in order');
  assert.throws(() => session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'late' } }] }), code('invalid_request'));
  session.sendAudio({ pcm: new Uint8Array([9, 0]), dataClass: 'ordinary' }); await f.frame(4);
  assert.equal('realtimeInput' in (f.frames[3] as object), true);
  session.close();
});

test('a speech-superseded multi-call batch sends exactly one terminal response per id', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.1-flash-live-preview';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } })).open({ ...request(), tools: [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
  ] }, control());
  const events = session.events[Symbol.asyncIterator](); t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }, { id: 'c2', name: 'search_knowledge', args: { query: 'y' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  const loud = new Uint8Array(16_000); for (let i = 0; i < loud.length; i += 2) { loud[i] = 0xff; loud[i + 1] = 0x7f; }
  session.sendAudio({ pcm: loud, dataClass: 'ordinary' });
  assert.equal((await events.next()).value?.type, 'toolCallSuperseded');
  await f.frame(2);
  const terminal = f.frames.filter(frame => 'toolResponse' in (frame as object));
  assert.equal(terminal.length, 1, 'supersession is the only terminal response');
  const responses = (terminal[0] as { toolResponse: { functionResponses: { id: string; response: { result?: string } }[] } }).toolResponse.functionResponses;
  assert.deepEqual(responses.map(response => response.id), ['c1', 'c2'], 'one neutral response per outstanding id');
  assert.throws(() => session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'late' } }, { id: 'c2', name: 'search_knowledge', response: { markdown: 'late' } }] }), code('invalid_request'));
  await f.frame(3);
  assert.equal(f.frames.filter(frame => 'toolResponse' in (frame as object)).length, 1, 'a late completion cannot add a second response');
  session.close();
});

test('a multi-call completion answering before supersession keeps exactly one terminal response per id', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.1-flash-live-preview';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } })).open({ ...request(), tools: [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
  ] }, control());
  const events = session.events[Symbol.asyncIterator](); t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }, { id: 'c2', name: 'search_knowledge', args: { query: 'y' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  const buffered = new Uint8Array([5, 0, 6, 0]);
  session.sendAudio({ pcm: buffered, dataClass: 'ordinary' });
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }, { id: 'c2', name: 'search_knowledge', response: { markdown: 'two' } }] });
  await f.frame(2);
  assert.deepEqual(f.frames[1], { toolResponse: { functionResponses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }, { id: 'c2', name: 'search_knowledge', response: { markdown: 'two' } }] } });
  await f.frame(3);
  assert.deepEqual(f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(buffered).toString('base64') } } }, 'audio buffered before the completion follows it in order');
  assert.equal(f.frames.filter(frame => 'toolResponse' in (frame as object)).length, 1, 'completion is the only terminal response');
  session.close();
});

test('the audio buffer high-water mark supersedes a pending batch with no eviction or reorder', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.1-flash-live-preview';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } })).open({ ...request(), tools: [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
  ] }, control());
  const events = session.events[Symbol.asyncIterator](); t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  const chunk = new Uint8Array(64_000);
  for (let i = 0; i < 5; i++) session.sendAudio({ pcm: chunk, dataClass: 'ordinary' });
  assert.equal((await events.next()).value?.type, 'toolCallSuperseded');
  await f.frame(7);
  assert.equal('toolResponse' in (f.frames[1] as object), true);
  for (let i = 0; i < 5; i++) {
    const frame = f.frames[2 + i] as { realtimeInput: { audio: { data: string } } };
    assert.equal(Buffer.from(frame.realtimeInput.audio.data, 'base64').equals(Buffer.from(chunk)), true, `frame ${i} preserved in order`);
  }
  session.close();
});

test('a cancelled batch still flushes audio buffered while it was pending', async t => {
  const f = await fixture(t);
  const modelId = 'models/gemini-3.1-flash-live-preview';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } })).open({ ...request(), tools: [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
  ] }, control());
  const events = session.events[Symbol.asyncIterator](); t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  const pending = new Uint8Array([7, 0, 8, 0]);
  session.sendAudio({ pcm: pending, dataClass: 'ordinary' });
  f.send({ toolCallCancellation: { ids: ['c1'] } });
  assert.equal((await events.next()).value?.type, 'toolCallCancellation');
  await f.frame(2);
  assert.deepEqual(f.frames[1], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pending).toString('base64') } } });
  assert.equal(f.frames.some(frame => 'toolResponse' in (frame as object)), false, 'no response for a cancelled id');
  session.close();
});

test('3.8 Live omits thinking config and cancellation releases an unanswered batch', async t => {
  const f = await fixture(t);
  const tools = [
    { name: 'first', description: 'First', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', enum: ['one', 'two'] } }, required: ['query'] } },
    { name: 'second', description: 'Second', parameters: { type: 'OBJECT', properties: { ids: { type: 'ARRAY', items: { type: 'STRING' } } } } },
  ];
  const originalTools = structuredClone(tools);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId: 'models/gemini-3.8-live-test', route: { enabled: true, provider: 'gemini', modelId: 'models/gemini-3.8-live-test', dataClasses: ['ordinary', 'private'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close()); const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); const setup = (f.frames[0] as { setup: { generationConfig: object; tools: unknown } }).setup;
  assert.equal('thinkingConfig' in setup.generationConfig, false);
  const expectedTools = [{ functionDeclarations: [
    { name: 'first', description: 'First', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', enum: ['one', 'two'] } }, required: ['query'] }, behavior: 'BLOCKING' },
    { name: 'second', description: 'Second', parameters: { type: 'OBJECT', properties: { ids: { type: 'ARRAY', items: { type: 'STRING' } } } }, behavior: 'BLOCKING' },
  ] }];
  assert.deepEqual(setup.tools, expectedTools);
  assert.equal(JSON.stringify(setup.tools), JSON.stringify(expectedTools), 'serialized declaration and nested schema order is exact');
  assert.deepEqual(tools, originalTools, 'provider setup never mutates caller declarations');
  f.send({ setupComplete: {} }); await session.ready; await events.next();
  f.send({ toolCall: { functionCalls: [{ id: 'one', name: 'test', args: {} }, { id: 'two', name: 'test', args: {} }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  assert.throws(() => session.sendToolResponse({ responses: [{ id: 'one', name: 'test', response: {} }] }), code('invalid_request'));
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  f.send({ serverContent: { modelTurn: { parts: [audio()] } } });
  assert.equal((await events.next()).value?.type, 'audio', 'provider output remains admitted while a tool batch is pending');
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  f.send({ toolCallCancellation: { ids: ['one', 'two'] } });
  assert.equal((await events.next()).value?.type, 'toolCallCancellation');
  session.sendAudio({ pcm, dataClass: 'ordinary' }); await f.frame(2);
  assert.equal('realtimeInput' in (f.frames[1] as object), true);
  session.close();
});

test('3.8 Live retains the single pending tool batch protocol guard', async t => {
  const modelId = 'models/gemini-3.8-live';
  const { f, session, captured } = await ready(t, { modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } });
  f.send({ toolCall: { functionCalls: [{ id: 'one', name: 'test', args: {} }] } });
  f.send({ toolCall: { functionCalls: [{ id: 'two', name: 'test', args: {} }] } });
  assert.equal((await session.done).code, 'protocol_error'); await captured.done;
});


test('only a 3.8 Live model id suppresses minimal thinking configuration', async t => {
  const modelId = 'models/synthetic-3.8-test';
  const { f, session, captured } = await ready(t, { modelId, route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary', 'private'] } });
  const setup = (f.frames[0] as { setup: { generationConfig: { thinkingConfig: unknown } } }).setup;
  assert.deepEqual(setup.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  session.close(); await captured.done;
});

});

test('binary invalid UTF-8 inside otherwise valid JSON is protocol_error', async t => {
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  t.after(() => session.close());
  await f.frame(1);
  f.sendRaw(Buffer.concat([Buffer.from('{"futureField":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
  await assert.rejects(session.ready, code('protocol_error'));
  await session.done;
});

test('provider fixture rejects unsupported setup schema with 1007 before ready', async t => {
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options(f)).open({ ...request(), tools: [
    { name: 'invalid', description: 'Invalid original schema', parameters: { type: 'OBJECT', properties: { nested: { type: 'OBJECT', additionalProperties: false } } } },
  ] }, control());
  const captured = collect(session);
  await assert.rejects(session.ready, code('provider_setup_rejected'));
  assert.equal((await session.done).code, 'provider_setup_rejected');
  await captured.done;
  assert.equal(captured.events.some(event => event.type === 'ready'), false);
  noCanary(captured.events);
});

test('provider 1007 after ready remains remote_closed, not setup rejection', async t => {
  const { f, session, captured } = await providerReady(t);
  f.remoteClose(CANARY, 1007);
  assert.deepEqual(await session.done, { status: 'failed', code: 'remote_closed' });
  await captured.done;
  noCanary(captured.events);
});

test('speech activity siblings and informational keys preserve the next audio frame', async t => {
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  // Read directly so a terminal before audio fails instead of looking like success.
  const events = session.events[Symbol.asyncIterator]();
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  await f.frame(2);
  // Informational keys must be consumed before audio makes the reader return.
  f.send({ usageMetadata: { synthetic: true } });
  speechActivityFrames(value => f.send(value));
  const observed: LiveVoiceEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const next = await events.next();
    assert.equal(next.done, false);
    observed.push(next.value!);
    assert.notEqual(next.value!.type, 'outcome');
    if (next.value!.type === 'audio') break;
  }
  assert.ok(observed.some(e => e.type === 'audio'));
  assert.equal(session.unknownTopLevelKeys, 4);
  assert.deepEqual(observed.filter(e => e.type === 'waitingForInput').map(e => e.value), [true, false]);
  session.close();
});
