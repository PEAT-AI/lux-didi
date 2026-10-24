import { FRESH_OPENING } from '../adapters/live-voice/openai.js';
import './live-remember.test.js';
import './live-declarations.test.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { GeminiLiveVoiceAdapter, LiveVoiceError } from '../adapters/live-voice/index.js';
import { liveVoiceActivityDefaults } from '../adapters/live-voice/gemini.js';
import { LIVE_RECOVERY_PICKUP } from '../prompt/live-persona.js';
import type { LiveVoiceAdapterOptions, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { CANARY, speechActivityFrames, collect, control, deferred, fixture as providerFixture, options, pcm, ready as providerReady, request } from './live-voice-fixture.js';
import { safeEvent } from '../host/log.js';

const code = (expected: string) => (error: unknown) => error instanceof LiveVoiceError && error.code === expected && error.message === expected;
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } });
function noCanary(value: unknown) { assert.equal(JSON.stringify(value).includes(CANARY), false, 'public serialization is sanitized'); }

for (const frameMode of ['binary', 'text'] as const) describe(`${frameMode} provider frames`, () => {
const fixture = (t: TestContext) => providerFixture(t, frameMode);
const ready = (t: TestContext, overrides: Partial<LiveVoiceAdapterOptions> = {}) => providerReady(t, overrides, frameMode);

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
    assert.deepEqual(f.frames[1], { clientContent: { turns: [
      { role: 'user', parts: [{ text: 'Actual pending job result' }] },
      ...(opening === 'model_first' ? [{ role: 'user', parts: [{ text: FRESH_OPENING }] }] : []),
    ], turnComplete: opening === 'model_first' } });
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
  // 1023-N3: the turn is completed in the same frame, so the provider answers it instead of waiting for VAD.
  assert.deepEqual(f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: FRESH_OPENING }] }], turnComplete: true } });
  assert.equal((await events.next()).value?.type, 'ready');
  assert.equal(f.frames.length, 2, 'exactly one fresh opening directive is sent without PCM');
});

test('empty-history user-first sends no opening turn at all', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({
    ...request(), opening: 'user_first', history: [],
  }, control());
  t.after(() => session.close());
  await f.frame(1);
  f.send({ setupComplete: {} });
  await session.ready;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.frames.length, 1, 'a call the owner opens himself asks the provider for nothing');
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
    if (data.includes(FRESH_OPENING)) throw Error('synthetic opening write failure');
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
    realtimeInputConfig: { automaticActivityDetection: { prefixPaddingMs: 700, silenceDurationMs: 800, startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW' } },
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
  assert.deepEqual(output.pcm, pcm); assert.equal(output.rate, 24000);
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
    assert.throws(() => new GeminiLiveVoiceAdapter({ ...base, route } as LiveVoiceAdapterOptions).open(request(), control()), code('route_denied'));
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
  ['empty object', {}, 'protocol_error'], ['array', [], 'protocol_error'],
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
    f.send(payload);
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

/** A deterministic fake upstream socket: an explicit open, injectable write failures and a settable buffer. */
class FakeUpstream extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  readonly sends: string[] = [];
  failWrites = false;
  open() { this.readyState = 1; this.emit('open'); }
  setup() { this.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); }
  send(frame: string, callback?: (error?: Error) => void) {
    this.sends.push(frame);
    queueMicrotask(() => callback?.(this.failWrites ? Object.assign(new Error('synthetic write failure'), { code: 'ECONNRESET' }) : undefined));
  }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', code)); }
  terminate() { this.close(1006); }
}

async function fakeReady(limits?: Partial<LiveVoiceLimits>) {
  let socket!: FakeUpstream;
  const socketFactory = (() => (socket = new FakeUpstream())) as unknown as NonNullable<LiveVoiceAdapterOptions['socketFactory']>;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory, ...(limits ? { limits } : {}) })).open(request(), control());
  await new Promise<void>(resolve => setImmediate(resolve));
  socket.open(); socket.setup(); await session.ready;
  return { socket, session };
}

test('the first failed audio write hands a recoverable upstream drop to the owner', async () => {
  const { socket, session } = await fakeReady();
  const before = socket.sends.length;
  socket.failWrites = true;
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  const outcome = await session.done;
  assert.equal(outcome.code, 'transport_error');
  assert.equal(outcome.recoverable, true, 'the owner resumption path must be offered');
  assert.equal(outcome.upstream?.errorKind, 'ECONNRESET');
  assert.equal(outcome.upstream?.writesFailed, 1);
  assert.ok((outcome.upstream?.sessionMs ?? -1) >= 0);
  assert.equal(socket.readyState, 3, 'the dead socket is closed at once');
  // No audio is buffered without bound: every later frame is refused, none reaches the wire.
  assert.throws(() => session.sendAudio({ pcm, dataClass: 'ordinary' }), code('transport_error'));
  assert.equal(socket.sends.length, before + 1);
});

test('a stalled bufferedAmount hands a recoverable upstream drop to the owner', async () => {
  const { socket, session } = await fakeReady({ maxBufferedBytes: 4096, upstreamStallMs: 1 });
  Object.defineProperty(socket, 'bufferedAmount', { get: () => 3000, configurable: true });
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  const outcome = await session.done;
  assert.equal(outcome.code, 'transport_error');
  assert.equal(outcome.recoverable, true);
  assert.equal(outcome.upstream?.errorKind, 'stalled');
  assert.equal(outcome.upstream?.bufferedAmount, 3000);
});

test('live_upstream_drop is a closed metadata-only host log shape', () => {
  const accepted = safeEvent({ event: 'live_upstream_drop', errorKind: 'ECONNRESET', closeCode: 1006, bufferedAmount: 3000, writesFailed: 4, sessionMs: 12_000, rebuilt: true });
  assert.deepEqual(accepted, { event: 'live_upstream_drop', errorKind: 'ECONNRESET', closeCode: 1006, bufferedAmount: 3000, writesFailed: 4, sessionMs: 12_000, rebuilt: true });
  assert.equal(safeEvent({ event: 'live_upstream_drop', errorKind: 'bad kind', closeCode: 1006, bufferedAmount: 3000, writesFailed: 4, sessionMs: 12_000, rebuilt: true }), undefined);
  assert.equal(safeEvent({ event: 'live_upstream_drop', errorKind: 'stalled', closeCode: 1006, bufferedAmount: 3000, writesFailed: 4, sessionMs: 12_000, rebuilt: 'yes' }), undefined);
  assert.equal(safeEvent({ event: 'live_upstream_drop', errorKind: 'stalled', closeCode: 1006, bufferedAmount: 3000, writesFailed: 4, sessionMs: 12_000, rebuilt: true, text: 'leak' }), undefined);
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

test('microphone audio during a pending blocking call is forwarded live and byte-exact', async t => {
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
  assert.deepEqual(setup.realtimeInputConfig, { automaticActivityDetection: { ...liveVoiceActivityDefaults } });
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
  await f.frame(3);
  assert.deepEqual(f.frames[1], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(first).toString('base64') } } }, 'first pending frame reaches the provider');
  assert.deepEqual(f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(second).toString('base64') } } }, 'second pending frame follows byte-exact');
  assert.equal(f.frames.some(frame => 'toolResponse' in (frame as object)), false, 'the batch is still unanswered');
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }, { id: 'c2', name: 'search_knowledge', response: { markdown: 'two' } }] });
  await f.frame(4);
  assert.deepEqual(f.frames[3], { toolResponse: { functionResponses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }, { id: 'c2', name: 'search_knowledge', response: { markdown: 'two' } }] } }, 'one response frame answers both ids');
  session.close();
  const diagnostics = session.diagnostics?.();
  assert.equal(diagnostics?.audioCalls, 2); assert.equal(diagnostics?.audioBytes, first.byteLength + second.byteLength);
});

test('languageCode accepts BCP-47 language-region, keeps ar-XA, and rejects malformed tags', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({ ...request(), languageCode: 'en-IN' }, control());
  t.after(() => session.close());
  await f.frame(1);
  const setup = (f.frames[0] as { setup: Record<string, any> }).setup;
  assert.equal(setup.generationConfig.speechConfig.languageCode, 'en-IN');
  const adapter = new GeminiLiveVoiceAdapter(options());
  for (const bad of ['e', 'english', 'en-IND', 'en_US', 'en-US-extra', '1n', 'EN']) {
    assert.throws(() => adapter.open({ ...request(), languageCode: bad }, control()), code('invalid_request'));
  }
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
  // Golden: the port carries the original schema and this adapter builds the Gemini dialect itself, so the
  // wire payload is exactly what the host used to declare (enum and ARRAY collapsed to STRING, original kept
  // in the description) and the caller's declarations are never rewritten.
  const expectedTools = [{ functionDeclarations: [
    { name: 'first', description: 'First', parameters: { type: 'OBJECT', required: ['query'], properties: { query: { type: 'STRING', description: 'Original schema: {"type":"STRING","enum":["one","two"]}' } } }, behavior: 'BLOCKING' },
    { name: 'second', description: 'Second', parameters: { type: 'OBJECT', properties: { ids: { type: 'STRING', description: 'Original schema: {"type":"ARRAY","items":{"type":"STRING"}}' } } }, behavior: 'BLOCKING' },
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

// Issue 209: the next real call must name the rejected frame without leaking any value.
test('a rejected provider frame reports one shape-only diagnostic with no value or id', async t => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: CANARY } }] } } });
  const outcome = await session.done;
  assert.equal(outcome.code, 'protocol_error');
  const rejected = lines.filter(line => line.includes('"live_frame_rejected"')).map(line => JSON.parse(line));
  assert.equal(rejected.length, 1, 'exactly one rejection diagnostic');
  const diagnostic = rejected[0] as { event: string; code: string; kind: string; bytes: number; keys: string[] };
  assert.equal(diagnostic.event, 'live_frame_rejected');
  assert.equal(diagnostic.code, 'protocol_error');
  assert.equal(diagnostic.kind, 'serverContent');
  assert.ok(Number.isSafeInteger(diagnostic.bytes) && diagnostic.bytes > 0, 'byte length is reported');
  assert.ok(Array.isArray(diagnostic.keys) && diagnostic.keys.includes('serverContent.modelTurn.parts[].inlineData'), 'nested key names are reported');
  assert.equal(lines.some(line => line.includes(CANARY)), false, 'no provider value leaks into the diagnostic');
  assert.equal(JSON.stringify(diagnostic).includes(CANARY), false, 'no provider value leaks into the diagnostic');
  assert.deepEqual(safeEvent(JSON.parse(JSON.stringify(diagnostic))), diagnostic, 'the diagnostic passes the host log whitelist');
  assert.equal(safeEvent({ ...diagnostic, leaked: 'text' }), undefined, 'extra keys are refused');
  assert.equal(safeEvent({ ...diagnostic, keys: ['serverContent', 'bad key name!'] }), undefined, 'a non-key path is refused');
});

test('an original schema with unsupported keys never reaches the wire raw', async t => {
  // The fixture closes 1007 on any additionalProperties in the setup schema, exactly as Gemini does. The port
  // now carries the original schema, so this adapter must build the dialect itself and keep the wire clean.
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options(f)).open({ ...request(), tools: [
    { name: 'invalid', description: 'Invalid original schema', parameters: { type: 'OBJECT', properties: { nested: { type: 'OBJECT', additionalProperties: false } } } },
  ] }, control());
  const captured = collect(session);
  await f.frame(1);
  const declaration = (f.frames[0] as { setup: { tools: { functionDeclarations: { parameters: { properties: { nested: unknown } } }[] }[] } })
    .setup.tools[0]!.functionDeclarations[0]!;
  // The unsupported key survives only inside the description text, never as a schema key the provider rejects.
  assert.deepEqual(declaration.parameters.properties.nested,
    { type: 'OBJECT', description: 'Original schema: {"type":"OBJECT","additionalProperties":false}' });
  f.send({ setupComplete: {} });
  await session.ready;
  session.close(); await captured.done;
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

// The real 08:29 rejection: a large serverContent frame whose audio modelTurn shares the frame with a
// text-less outputTranscription (Gemini Transcription.text is optional). The whole frame, audio
// included, was dropped. The audio must play and the turn must not end.
test('a large serverContent audio frame with a text-less outputTranscription plays its audio', async t => {
  const { f, session, captured } = await providerReady(t);
  const bytes = new Uint8Array(9688);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  const frame = JSON.stringify({ serverContent: {
    modelTurn: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(bytes).toString('base64') } }] },
    outputTranscription: {},
  } });
  assert.equal(Buffer.byteLength(frame), 13064, 'fixture frame of the observed 13 062-byte shape and size');
  f.send(JSON.parse(frame));
  for (let i = 0; i < 50 && !captured.events.some(event => event.type === 'audio'); i++) await new Promise<void>(resolve => setImmediate(resolve));
  const audioEvents = captured.events.filter((event): event is Extract<LiveVoiceEvent, { type: 'audio' }> => event.type === 'audio');
  assert.equal(audioEvents.length, 1, 'the frame is decoded once, not rejected');
  assert.equal(audioEvents[0]!.pcm.byteLength, bytes.byteLength, 'the whole audio part plays, none dropped');
  assert.equal(captured.events.some(event => event.type === 'outcome'), false, 'a text-less transcription must not end the turn');
  assert.equal(session.diagnostics?.().outputAudioFrames, 1);
});

// Issue 209 recurrence + OUTCOME 2: a non-LiveVoiceError in the decode path (invalid UTF-8 makes the
// fatal TextDecoder throw a TypeError) names its constructor, is skipped without ending the turn,
// and never carries a value; the next valid frame plays.
test('a non-LiveVoiceError decode failure is classified, skipped, and the next frame plays', async t => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = originalError; });
  const { f, captured } = await providerReady(t);
  f.sendRaw(Buffer.from([0xff, 0xfe, 0xfd]));
  for (let i = 0; i < 50 && !lines.some(line => line.includes('"live_frame_rejected"')); i++) await new Promise<void>(resolve => setImmediate(resolve));
  const rejected = lines.filter(line => line.includes('"live_frame_rejected"')).map(line => JSON.parse(line) as { event: string; error?: string; kind: string });
  assert.equal(rejected.length, 1, 'exactly one rejection diagnostic');
  assert.equal(rejected[0]!.error, 'TypeError', 'the real error constructor is named');
  assert.equal(rejected[0]!.kind, 'invalid_json');
  assert.equal(JSON.stringify(rejected[0]).includes(CANARY), false, 'no value leaks into the classifier');
  assert.equal(captured.events.some(event => event.type === 'outcome'), false, 'the undecodable frame did not end the turn');
  // The next valid frame still plays on the same session.
  f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] }, turnComplete: true } });
  for (let i = 0; i < 50 && !captured.events.some(event => event.type === 'audio'); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(captured.events.some(event => event.type === 'audio'), 'the next valid frame plays');
  assert.equal(captured.events.some(event => event.type === 'outcome'), false);
});

// Ruling L1-R2 is superseded: the per-tool anchor is gone. 3.8 Live still takes the provider-default
// thinking level, and its read-tool response carries the tool data with no accent key.
test('3.8 Live takes the provider-default thinking level and sends tool data with no accent key', async t => {
  const f = await providerFixture(t);
  const modelId = 'models/gemini-3.8-live-test';
  const tools = [{ name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); assert.equal((f.frames[0] as { setup: { generationConfig: { thinkingConfig?: unknown } } }).setup.generationConfig.thinkingConfig, undefined);
  f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }] });
  await f.frame(2);
  const response = (f.frames[1] as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } }).toolResponse.functionResponses[0]!.response;
  assert.deepEqual(Object.keys(response), ['markdown'], 'the response carries the tool data only, no accent key');
  assert.equal(response['_voice_anchor'], undefined, 'no per-tool accent key is present');
});

test('other models keep the exact tool response object with no voice anchor', async t => {
  const f = await providerFixture(t);
  const tools = [{ name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }] });
  await f.frame(2);
  assert.deepEqual(f.frames[1], { toolResponse: { functionResponses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }] } });
});

// Contract P1 (issue 1014): 800 ms silence window and only the memory save is non-blocking and silent.
test('P1: 3.8 Live uses an 800 ms silence window and marks only the memory save NON_BLOCKING', async t => {
  const f = await providerFixture(t);
  const modelId = 'models/gemini-3.8-live-test';
  const tools = [
    { name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } },
    { name: 'remember_note', description: 'Remember', parameters: { type: 'OBJECT' } },
  ];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  await f.frame(1);
  const setup = (f.frames[0] as { setup: {
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: number } };
    tools: { functionDeclarations: { name: string; behavior?: string }[] }[];
  } }).setup;
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 800);
  const declared = setup.tools[0]!.functionDeclarations;
  assert.equal(declared.find(entry => entry.name === 'search_knowledge')?.behavior, 'BLOCKING', 'reads stay BLOCKING');
  assert.equal(declared.find(entry => entry.name === 'remember_note')?.behavior, 'NON_BLOCKING', 'the memory save is NON_BLOCKING');
});

test('P1: the memory save response is scheduled SILENT', async t => {
  const f = await providerFixture(t);
  const modelId = 'models/gemini-3.8-live-test';
  const tools = [{ name: 'remember_note', description: 'Remember', parameters: { type: 'OBJECT' } }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'r1', name: 'remember_note', args: { text: 'x', kind: 'fact' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  session.sendToolResponse({ responses: [{ id: 'r1', name: 'remember_note', response: { remembered: true } }] });
  await f.frame(2);
  const frame = (f.frames[1] as { toolResponse: { functionResponses: { scheduling?: string; response: Record<string, unknown> }[] } }).toolResponse.functionResponses[0]!;
  assert.equal(frame.scheduling, 'SILENT', 'the memory save reply is scheduled SILENT');
});

test('P1: a read tool response carries no scheduling and only the tool data', async t => {
  const f = await providerFixture(t);
  const modelId = 'models/gemini-3.8-live-test';
  const tools = [{ name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }] });
  await f.frame(2);
  const frame = (f.frames[1] as { toolResponse: { functionResponses: { scheduling?: string; response: Record<string, unknown> }[] } }).toolResponse.functionResponses[0]!;
  assert.equal(frame.scheduling, undefined, 'a read response is not scheduled SILENT');
  assert.deepEqual(Object.keys(frame.response), ['markdown'], 'the response carries the tool data only, no accent key');
});

test('P3: a tool response serialises only the tool data and a memory save is still scheduled SILENT', async t => {
  const f = await providerFixture(t);
  const modelId = 'models/gemini-3.8-live-test';
  const tools = [{ name: 'remember_note', description: 'Remember', parameters: { type: 'OBJECT' } }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'r1', name: 'remember_note', args: { text: 'x', kind: 'fact' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  session.sendToolResponse({ responses: [{ id: 'r1', name: 'remember_note', response: { remembered: true } }] });
  await f.frame(2);
  const serialised = JSON.stringify(f.frames[1]);
  const entry = JSON.parse(serialised).toolResponse.functionResponses[0] as { scheduling?: string; response: Record<string, unknown> };
  assert.deepEqual(Object.keys(entry), ['id', 'name', 'scheduling', 'response'], 'scheduling sits before the response object');
  assert.deepEqual(Object.keys(entry.response), ['remembered'], 'the response carries the tool data only, no accent key');
  assert.equal(serialised.includes('_voice_anchor'), false, 'no per-tool accent key is serialised');
  assert.equal(serialised.includes('Do not read raw text'), false, 'no accent text is serialised in a function response');
});

test('AC2: the adapter no longer reports a tool-anchor count, and a function response carries no accent key', async t => {
  const f = await providerFixture(t);
  const modelId = 'models/gemini-3.8-live-test';
  const tools = [{ name: 'search_knowledge', description: 'Search', parameters: { type: 'OBJECT' } }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId,
    route: { enabled: true, provider: 'gemini', modelId, dataClasses: ['ordinary'] } })).open({ ...request(), tools }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await events.next()).value?.type, 'ready');
  f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }] } });
  assert.equal((await events.next()).value?.type, 'modelTurnStarted');
  assert.equal((await events.next()).value?.type, 'toolCall');
  session.sendToolResponse({ responses: [{ id: 'c1', name: 'search_knowledge', response: { markdown: 'one' } }] });
  await f.frame(2);
  assert.equal('toolAnchorChars' in (session.diagnostics?.() ?? {}), false, 'the tool-anchor diagnostic is gone');
  const frame = (f.frames[1] as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } }).toolResponse.functionResponses[0]!;
  assert.equal('_voice_anchor' in frame.response, false, 'the response carries no per-tool accent key');
});

test('the adapter declares its capabilities per model, never a name lookup at the wire', async t => {
  const f = await providerFixture(t);
  const modern = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId: 'models/gemini-3.8-live-test',
    route: { enabled: true, provider: 'gemini', modelId: 'models/gemini-3.8-live-test', dataClasses: ['ordinary'] } }));
  const older = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, modelId: 'models/gemini-3.1-flash-live-preview',
    route: { enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', dataClasses: ['ordinary'] } }));
  assert.equal(modern.capabilities.provider, 'gemini');
  assert.equal(modern.capabilities.thinking, 'provider_default');
  assert.equal(older.capabilities.thinking, 'minimal');
  assert.equal(modern.capabilities.supportsToolScheduling, true);
  assert.equal(older.capabilities.supportsToolScheduling, false);
  assert.deepEqual(modern.capabilities.inputRates, [16000]);
  assert.deepEqual(modern.capabilities.outputRates, [24000]);
  assert.deepEqual(modern.capabilities.outputModalities, ['audio']);
  assert.ok(modern.capabilities.supportsResumption && modern.capabilities.supportsGoAway
    && modern.capabilities.supportsInterruption && modern.capabilities.supportsServerVadConfig);
});

test('P2: the model-first opening nudge carries no accent text', async t => {
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open({
    ...request(), opening: 'model_first', history: [],
  }, control());
  t.after(() => session.close());
  const events = session.events[Symbol.asyncIterator]();
  await f.frame(1); f.send({ setupComplete: {} }); await Promise.all([session.ready, f.frame(2)]);
  assert.deepEqual(f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: FRESH_OPENING }] }], turnComplete: true } });
  assert.equal(JSON.stringify(f.frames[1]).includes('voice and accent'), false, 'the opening trigger carries no accent text');
  void events;
});

test('a fresh seeded opening sends the journal history then the pickup line as the opening input', async t => {
  const f = await providerFixture(t);
  const settings = options({ socketFactory: f.socketFactory });
  const input = request();
  input.opening = 'model_first';
  input.history = [{ role: 'user', text: 'earlier question', dataClass: 'ordinary' }];
  input.openingText = LIVE_RECOVERY_PICKUP;
  const session = new GeminiLiveVoiceAdapter(settings).open(input, control()); t.after(() => session.close());
  collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await f.frame(2);
  assert.deepEqual(f.frames[1], { clientContent: { turns: [
    { role: 'user', parts: [{ text: 'earlier question' }] },
    { role: 'user', parts: [{ text: LIVE_RECOVERY_PICKUP }] },
  ], turnComplete: true } }, 'the history turns precede the pickup line as the opening input');
});

test('#1023: a new call with seeded history still sends the fresh opening directive', async t => {
  const f = await providerFixture(t);
  const input = request();
  input.opening = 'model_first';
  input.history = [{ role: 'user', text: 'earlier question', dataClass: 'ordinary' }];
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(input, control());
  t.after(() => session.close());
  collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await f.frame(2);
  assert.deepEqual(f.frames[1], { clientContent: { turns: [
    { role: 'user', parts: [{ text: 'earlier question' }] },
    { role: 'user', parts: [{ text: FRESH_OPENING }] },
  ], turnComplete: true } }, 'the seeded history is followed by the opening directive');
});

test('#1023: a silent start keeps its own marker and never adds the fresh opening directive', async t => {
  const f = await providerFixture(t);
  const input = request();
  input.opening = 'model_first';
  input.history = [{ role: 'user', text: 'earlier question', dataClass: 'ordinary' }];
  input.openingText = 'SILENT_START_MARK';
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(input, control());
  t.after(() => session.close());
  collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await f.frame(2);
  assert.deepEqual(f.frames[1], { clientContent: { turns: [
    { role: 'user', parts: [{ text: 'earlier question' }] },
    { role: 'user', parts: [{ text: 'SILENT_START_MARK' }] },
  ], turnComplete: true } }, 'the silent-start marker alone opens the call');
  assert.equal(JSON.stringify(f.frames[1]).includes(FRESH_OPENING), false);
});

test('provider usage metadata is decoded into a provider-neutral contextUsage event', async t => {
  const f = await providerFixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  const captured = collect(session); t.after(() => session.close());
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  f.send({ usageMetadata: { promptTokenCount: 3, responseTokenCount: 4, totalTokenCount: 7 } });
  for (let i = 0; i < 50 && !captured.events.some(event => event.type === 'contextUsage'); i++) await new Promise<void>(resolve => setImmediate(resolve));
  const usage = captured.events.filter(event => event.type === 'contextUsage') as { type: 'contextUsage'; totalTokens: number; promptTokens?: number; responseTokens?: number }[];
  assert.equal(usage.length, 1);
  assert.deepEqual({ totalTokens: usage[0]!.totalTokens, promptTokens: usage[0]!.promptTokens, responseTokens: usage[0]!.responseTokens }, { totalTokens: 7, promptTokens: 3, responseTokens: 4 });
});

class StallPeer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  pings = 0;
  send(_frame: string, callback?: (error?: Error) => void) { callback?.(); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.close(); }
  ping() { this.pings += 1; }
}
function stallSession(peer: StallPeer) {
  return new GeminiLiveVoiceAdapter(options({ limits: { upstreamStallMs: 400, maxBufferedBytes: 2 * 1024 * 1024 }, socketFactory: () => {
    queueMicrotask(() => { peer.readyState = 1; peer.emit('open'); peer.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); });
    return peer as unknown as WebSocket;
  } })).open(request(), { ...control(), deadlineMs: Date.now() + 600_000 });
}

test('an upstream queue held above 128 KB for two seconds is a stalled transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const peer = new StallPeer();
  const session = stallSession(peer);
  const captured = collect(session);
  await session.ready;
  peer.bufferedAmount = 200 * 1024;
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  t.mock.timers.tick(2000);
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  const outcome = await session.done; await captured.done;
  assert.equal(outcome.code, 'transport_error');
  assert.equal(outcome.recoverable, true);
  assert.equal(outcome.upstream!.errorKind, 'queue_stalled');
});

test('an idle queue of one audio frame for a minute is not a stalled transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const peer = new StallPeer();
  const session = stallSession(peer);
  const captured = collect(session);
  await session.ready;
  // The 3h-b smoke shape: an idle session whose local queue holds one audio frame while the socket is healthy.
  peer.bufferedAmount = 2217;
  let settled = false;
  void session.done.then(() => { settled = true; });
  for (let second = 0; second < 60; second += 1) {
    session.sendAudio({ pcm, dataClass: 'ordinary' });
    t.mock.timers.tick(1000);
    peer.emit('pong'); // the socket answers every ping: it is alive, just not draining a frame per tick
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a small idle queue never counts as a stall (#291)');
  assert.equal(peer.readyState, 1, 'the socket stays open');
  assert.equal(captured.events.some(event => event.type === 'outcome'), false);
  session.close(); await captured.done;
});

test('a backlog that grows past 64 KB without draining is one stalled transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const peer = new StallPeer();
  const session = stallSession(peer);
  const captured = collect(session);
  await session.ready;
  for (let step = 1; step <= 12; step += 1) {
    peer.bufferedAmount = step * 8 * 1024; // never drains, so the backlog only grows
    session.sendAudio({ pcm, dataClass: 'ordinary' });
    t.mock.timers.tick(1000);
    peer.emit('pong');
  }
  const outcome = await session.done; await captured.done;
  assert.equal(outcome.code, 'transport_error');
  assert.equal(outcome.recoverable, true);
  assert.equal(outcome.upstream!.errorKind, 'no_drain');
  assert.ok(outcome.upstream!.bufferedAmount > 64 * 1024, 'the drop needs a real backlog behind it');
  assert.ok(outcome.upstream!.sessionMs >= 4_000, 'and a sustained no-drain window, not the first flat tick');
});

test('two missed websocket pongs are a stalled transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const peer = new StallPeer();
  const session = stallSession(peer);
  const captured = collect(session);
  await session.ready;
  t.mock.timers.tick(5000); t.mock.timers.tick(5000); t.mock.timers.tick(5000);
  const outcome = await session.done; await captured.done;
  assert.equal(peer.pings, 3, 'a ping every five seconds, two missed before the drop');
  assert.equal(outcome.code, 'transport_error');
  assert.equal(outcome.upstream!.errorKind, 'no_pong');
});

test('an elevated upstream queue is surfaced once, above 64 KB', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const peer = new StallPeer();
  const session = stallSession(peer);
  const captured = collect(session);
  await session.ready;
  peer.bufferedAmount = 100 * 1024;
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  await new Promise<void>(resolve => setImmediate(resolve));
  const queued = captured.events.filter(event => event.type === 'upstreamQueue') as { type: 'upstreamQueue'; bufferedBytes: number }[];
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.bufferedBytes, 100 * 1024);
  session.close();
  await captured.done;
});

test('#606 Gemini preserves a text-less owner final after transcript fragments', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  t.after(() => session.close());
  const captured = collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  f.send({ serverContent: { inputTranscription: { text: 'Naya', finished: false } } });
  f.send({ serverContent: { inputTranscription: { finished: true } } });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(captured.events.filter(event => event.type === 'inputTranscription').map(event => ({ text: event.text, finished: event.finished })),
    [{ text: 'Naya', finished: false }, { text: '', finished: true }]);
});
