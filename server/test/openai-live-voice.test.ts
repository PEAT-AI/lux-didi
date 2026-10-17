import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LiveVoiceError, OpenAiLiveVoiceAdapter, OPENAI_DEFAULT_VOICE, OPENAI_DELIVERY_SECTION, OPENAI_LANGUAGE_SECTION, OPENAI_TOOLS_SECTION, openAiInstructions } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions, LiveVoiceEvent } from '../adapters/live-voice/index.js';
import { CANARY, collect, control, FakeClock, fixture, options, pcm16, ready, request } from './openai-live-voice-fixture.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await tick();
  assert.ok(predicate(), 'expected event did not arrive');
}
const code = (expected: string) => (error: unknown) => error instanceof LiveVoiceError && error.code === expected;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
type Captured = { events: LiveVoiceEvent[] };
const audioOf = (captured: Captured) => captured.events.flatMap(event => (event.type === 'audio' ? [event.pcm.byteLength] : []));
const audioBytes = (captured: Captured) => audioOf(captured).reduce((sum, bytes) => sum + bytes, 0);
const interruptions = (captured: Captured) => captured.events.filter(event => event.type === 'interrupted').length;
const completions = (captured: Captured) => captured.events.filter(event => event.type === 'turnComplete').length;
/** Let every queued event reach the collector, so a "nothing was emitted" assertion is not a race. */
const quiet = async () => { for (let attempt = 0; attempt < 6; attempt += 1) await tick(); };
const speak = (f: { send: (value: unknown) => void }, samples: number) => f.send({ type: 'session.output_audio.delta', delta: b64(pcm16(samples)) });
const tools = () => [{ name: 'research', description: 'Look something up', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } }];
type Start = { type: string; session: Record<string, unknown> };

describe('openai gpt-live adapter', () => {
  test('capabilities declare 16 kHz in, 24 kHz out and no resumption', () => {
    const adapter = new OpenAiLiveVoiceAdapter(options());
    assert.equal(adapter.capabilities.provider, 'openai');
    assert.deepEqual([...adapter.capabilities.inputRates], [16_000]);
    assert.deepEqual([...adapter.capabilities.outputRates], [24_000]);
    assert.equal(adapter.capabilities.supportsResumption, false);
    assert.equal(adapter.capabilities.supportsInterruption, true);
    assert.equal(adapter.capabilities.supportsServerVadConfig, false);
    assert.equal(adapter.capabilities.thinking, 'provider_default');
  });

  test('the default voice is marin, the Hindi voice is refused, and no OpenAI voice falls back to marin', async t => {
    assert.equal(OPENAI_DEFAULT_VOICE, 'marin');
    assert.throws(() => new OpenAiLiveVoiceAdapter(options({ voice: 'nira' })), code('invalid_settings'));
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ voice: '', socketFactory: f.socketFactory })).open(request(), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    assert.deepEqual((start.session['audio'] as Record<string, unknown>)['output'], { voice: 'marin' });
  });

  test('the start barrier sends session.start before any audio, with the persona wrapper and wire facts', async t => {
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request({ tools: tools() }), control());
    t.after(() => session.close());
    const captured = collect(session);
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    assert.equal(start.type, 'session.start');
    assert.equal(start.session['model'], 'gpt-live-1');
    const instructions = start.session['instructions'] as string;
    assert.equal(instructions, openAiInstructions('Synthetic persona'));
    assert.ok(instructions.startsWith('Synthetic persona'), 'the shared persona is sent unchanged first');
    for (const section of [OPENAI_LANGUAGE_SECTION, OPENAI_TOOLS_SECTION, OPENAI_DELIVERY_SECTION]) assert.ok(instructions.includes(section), section);
    for (const line of ['Do not treat a cough, music, or nearby conversation as a new request.', 'Keep listening while the owner pauses to think.']) assert.ok(instructions.includes(line), line);
    assert.deepEqual(start.session['audio'], { format: { type: 'audio/pcm', rate: 24_000 }, output: { voice: 'marin' } });
    const delegation = start.session['delegation'] as { type: string; responses: Record<string, unknown> };
    assert.equal(delegation.type, 'responses');
    assert.deepEqual(delegation.responses['tools'], [{ type: 'function', ...tools()[0] }]);
    assert.equal(delegation.responses['tool_choice'], 'auto');
    assert.equal('max_output_tokens' in delegation.responses, false, 'no output cap below the provider default');
    assert.equal(start.session['input'], undefined);
    // The key is a header on the documented endpoint, never a query parameter.
    assert.equal(f.destination, 'wss://api.openai.com/v1/live/sessions');
    assert.equal(f.requestPath, '/');
    assert.equal(f.authorization, `Bearer ${CANARY}`);
    // Nothing may follow before the provider acknowledges the start.
    assert.throws(() => session.sendAudio({ pcm: pcm16(), dataClass: 'ordinary' }), code('not_ready'));
    assert.deepEqual(f.frames.map(frame => frame.type), ['session.start']);
    assert.equal(JSON.stringify(f.frames).includes(CANARY), false, 'the key never reaches the wire or the events');
    f.send({ type: 'session.started', session: { id: 'sess_1' } });
    await session.ready;
    await until(() => captured.events.some(event => event.type === 'ready'));
    assert.equal(JSON.stringify(captured.events).includes(CANARY), false);
  });

  test('startup history and the opening line are seeded in session.input, bounded by the documented 128 messages', async t => {
    const f = await fixture(t);
    const history = [{ role: 'user' as const, text: 'Plan the week', dataClass: 'ordinary' as const }, { role: 'model' as const, text: 'Monday first', dataClass: 'ordinary' as const }];
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }))
      .open(request({ history, openingText: 'Pick up where we left off.', opening: 'model_first' }), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    assert.deepEqual(start.session['input'], [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plan the week' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Monday first' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Pick up where we left off.' }] },
    ]);
    const seeded = Array.from({ length: 200 }, (_, index) => ({ role: 'user' as const, text: `turn ${index}`, dataClass: 'ordinary' as const }));
    assert.throws(() => new OpenAiLiveVoiceAdapter(options()).open(request({ history: seeded }), control()), code('invalid_request'));
  });

  test('input audio is upsampled from 16 kHz to 24 kHz inside the adapter', async t => {
    const { f, session } = await ready(t);
    for (let frame = 0; frame < 3; frame += 1) session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    await f.frame(4);
    const frames = f.frames.slice(1) as { type: string; audio: string }[];
    assert.equal(frames.length, 3);
    for (const frame of frames) assert.equal(frame.type, 'session.input_audio.append');
    const sizes = frames.map(frame => Buffer.from(frame.audio, 'base64').byteLength);
    // 480 samples in, 720 samples out (1.5x) once the one-sample lookahead is warm.
    assert.deepEqual(sizes, [1_438, 1_440, 1_440]);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), 1_440 * 3 - 2);
  });

  test('provider audio passes through at 24 kHz and both transcripts map onto the union', async t => {
    const { f, session, captured } = await ready(t);
    const pcm = pcm16(240);
    f.send({ type: 'session.output_audio.delta', delta: b64(pcm) });
    f.send({ type: 'session.input_transcript.delta', delta: 'What is', start_ms: 1_000, end_ms: 1_200 });
    f.send({ type: 'session.output_transcript.delta', delta: 'Checking', start_ms: 1_200, end_ms: 1_400 });
    await until(() => captured.events.filter(event => event.type === 'audio' || event.type.includes('ranscription')).length >= 3);
    const audio = captured.events.find(event => event.type === 'audio');
    assert.ok(audio && audio.type === 'audio');
    assert.equal(audio.rate, 24_000);
    assert.deepEqual(Buffer.from(audio.pcm), Buffer.from(pcm));
    const input = captured.events.find(event => event.type === 'inputTranscription');
    assert.ok(input && input.type === 'inputTranscription' && input.text === 'What is' && input.finished === false);
    const output = captured.events.find(event => event.type === 'outputTranscription');
    assert.ok(output && output.type === 'outputTranscription' && output.text === 'Checking');
    assert.deepEqual(captured.events.map(event => event.sequence), captured.events.map((_, index) => index + 1));
    session.close();
    const outcome = await session.done;
    assert.equal(outcome.status, 'closed');
  });

  test('a delegated function call becomes toolCall and sendToolResponse answers it then continues', async t => {
    const { f, session, captured } = await ready(t);
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'research', arguments: '{"q":"india weather"}' } } });
    await until(() => captured.events.some(event => event.type === 'toolCall'));
    const call = captured.events.find(event => event.type === 'toolCall');
    assert.ok(call && call.type === 'toolCall');
    assert.deepEqual(call.calls, [{ id: 'call_1', name: 'research', args: { q: 'india weather' } }]);
    assert.throws(() => session.sendToolResponse({ responses: [{ id: 'other', name: 'research', response: { ok: true } }] }), code('invalid_request'));
    session.sendToolResponse({ responses: [{ id: 'call_1', name: 'research', response: { ok: true } }] });
    await f.frame(3);
    assert.deepEqual(f.frames.slice(1), [
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' } },
      { type: 'response.create' },
    ]);
  });

  test('the 3j reproduction: an input transcript never silences the rest of the session', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 240);
    await until(() => audioOf(opened.captured).length === 1);
    // The one-word phantom of the field log: a silent mic produced it, and it used to latch the session muted.
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'mm' });
    // Empty and whitespace-only deltas carry no word: they start no episode and never flush either (GL1-R1).
    for (const delta of ['', '   ', '\n\t ']) opened.f.send({ type: 'session.input_transcript.delta', delta });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription' && event.text === '\n\t '));
    const journaled = opened.captured.events.flatMap(event => (event.type === 'inputTranscription' ? [event.text] : []));
    assert.deepEqual(journaled, ['mm', '   ', '\n\t '], 'a whitespace-only fragment is journaled, an empty one is not');
    // It carries no word either: one word after a separator is still one word, so nothing flushes.
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold' });
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'a whitespace fragment leaves one word one word');
    for (let index = 0; index < 30; index += 1) speak(opened.f, 2_400);
    await until(() => audioOf(opened.captured).length === 31);
    assert.equal(audioBytes(opened.captured), (240 + 30 * 2_400) * 2, 'every valid output delta is forwarded');
    assert.equal(interruptions(opened.captured), 0, 'one word is not a barge-in');
    // No delegated response.created ever arrives here, which is the shape of a plain spoken reply.
    clock.advance(2_000);
    await quiet();
    assert.equal(completions(opened.captured), 0, '1.1 s of playback is still queued');
    clock.advance(1_200);
    await until(() => completions(opened.captured) === 1);
  });

  test('a real two-word barge-in from split deltas flushes once and later audio still flows', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 4_800);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold' });
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'the first half of one word is one word');
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' on' });
    await until(() => interruptions(opened.captured) === 1);
    speak(opened.f, 4_800);
    await until(() => audioOf(opened.captured).length === 2);
    assert.equal(audioBytes(opened.captured), (4_800 + 4_800) * 2, 'no frame dropping after the flush');
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' please' });
    await quiet();
    assert.equal(interruptions(opened.captured), 1, 'one flush per input episode');
    clock.advance(700);
    speak(opened.f, 4_800);
    await until(() => audioOf(opened.captured).length === 3);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'stop that' });
    await until(() => interruptions(opened.captured) === 2);
  });

  test('the session logs the final instruction size and never the instruction text', async t => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const f = await fixture(t);
      const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
      t.after(() => session.close());
    } finally { console.error = original; }
    const receipt = logged.map(text => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; } })
      .find(entry => entry !== undefined && entry['event'] === 'openai_instructions_size');
    assert.ok(receipt, 'the session start logs openai_instructions_size');
    const instructions = openAiInstructions('Synthetic persona');
    assert.equal(receipt['chars'], instructions.length);
    assert.equal(receipt['bytes'], Buffer.byteLength(instructions));
    assert.deepEqual(Object.keys(receipt).sort(), ['bytes', 'chars', 'event'], 'sizes only, never instruction text');
  });

  test('backchannels and a one-word stop never flush, and separate one-word episodes do not add up', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 4_800);
    await until(() => audioOf(opened.captured).length === 1);
    for (const delta of ['mm', 'mm-hm', '...']) {
      opened.f.send({ type: 'session.input_transcript.delta', delta });
      await quiet();
      clock.advance(700);
    }
    for (const delta of ['stop', 'wait', 'no']) {
      opened.f.send({ type: 'session.input_transcript.delta', delta });
      await quiet();
      clock.advance(700);
    }
    assert.equal(interruptions(opened.captured), 0, 'a deliberate one-word utterance does not cut the reply');
    assert.equal(audioOf(opened.captured).length, 1);
  });

  test('a short output pause under 2000 ms does not complete the turn', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 240);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(1_900);
    await quiet();
    assert.equal(completions(opened.captured), 0);
    speak(opened.f, 240);
    await until(() => audioOf(opened.captured).length === 2);
    clock.advance(1_900);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'a stop for breath is not the end of the turn');
  });

  test('a long quiet pause completes the turn once, and later audio reopens it', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 240);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(2_000);
    await until(() => completions(opened.captured) === 1);
    clock.advance(10_000);
    await quiet();
    assert.equal(completions(opened.captured), 1, 'silence never completes twice');
    speak(opened.f, 240);
    await until(() => audioOf(opened.captured).length === 2);
    clock.advance(2_000);
    await until(() => completions(opened.captured) === 2);
  });

  test('the server stopping while playback is still queued completes only after the queue drains', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(2_500);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'the queue still holds 1.5 s of playback');
    clock.advance(1_500);
    await until(() => completions(opened.captured) === 1);
  });

  test('a tool turn: silence never completes it and response.done does not bypass queued playback', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    opened.f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    speak(opened.f, 4_800);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(10_000);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'a delegated response is outstanding');
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 2);
    opened.f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.done', response: { id: 'resp_1', status: 'completed' } } });
    clock.advance(2_500);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'four seconds of playback are still queued');
    clock.advance(1_500);
    await until(() => completions(opened.captured) === 1);
    speak(opened.f, 240);
    await until(() => audioOf(opened.captured).length === 3);
    clock.advance(2_000);
    await until(() => completions(opened.captured) === 2);
  });

  test('a closed session leaks no turn-taking timer or latch into the next one', async t => {
    const clock = new FakeClock();
    const first = await ready(t, { clock });
    speak(first.f, 4_800);
    await until(() => audioOf(first.captured).length === 1);
    first.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await until(() => interruptions(first.captured) === 1);
    first.session.close();
    await first.session.done;
    await quiet();
    assert.equal(clock.timers, 0, 'the episode and idle timers are cleared on close');
    const second = await ready(t, { clock });
    speak(second.f, 4_800);
    await until(() => audioOf(second.captured).length === 1);
    second.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await until(() => interruptions(second.captured) === 1);
    assert.equal(interruptions(second.captured), 1);
    second.session.close();
  });

  test('after a barge-in the finished tool result is recorded without another response.create', async t => {
    const clock = new FakeClock();
    const { f, session, captured } = await ready(t, { clock });
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    f.send({ type: 'session.output_transcript.delta', delta: 'Checking', start_ms: 0, end_ms: 200 });
    speak(f, 4_800);
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'research', arguments: '{}' } } });
    await until(() => captured.events.some(event => event.type === 'audio'));
    f.send({ type: 'session.input_transcript.delta', delta: 'stop, something else', start_ms: 200, end_ms: 500 });
    await until(() => captured.events.some(event => event.type === 'interrupted') && captured.events.some(event => event.type === 'toolCall'));
    session.sendToolResponse({ responses: [{ id: 'call_1', name: 'research', response: { ok: true } }] });
    await f.frame(2);
    assert.deepEqual(f.frames.slice(1), [
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' } },
    ]);
    session.close();
  });

  test('a provider error cuts the response without ending the session, and session.closed maps the outcome', async t => {
    const { f, session, captured } = await ready(t);
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    f.send({ type: 'session.output_transcript.delta', delta: 'Long answer', start_ms: 0, end_ms: 300 });
    f.send({ type: 'error', event_id: 'event_error', error: { type: 'moderation_error', code: null, message: 'cut', client_event_id: null } });
    await until(() => captured.events.some(event => event.type === 'interrupted'));
    assert.equal(session.done === undefined, false);
    let settled = false; void session.done.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false, 'the session outlives an error that only cuts audio');
    f.send({ type: 'session.closed', reason: 'connection_lost', usage: { seconds: 12 } });
    const outcome = await session.done;
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.code, 'remote_closed');
    assert.equal(outcome.recoverable, true);
  });

  test('the session duration limit is recoverable and a requested close is not a failure', async t => {
    const expired = await ready(t);
    expired.f.send({ type: 'session.closed', reason: 'expired' });
    const outcome = await expired.session.done;
    assert.deepEqual(outcome, { status: 'failed', code: 'session_timeout', recoverable: true });

    const asked = await ready(t);
    asked.session.close();
    const closed = await asked.session.done;
    assert.deepEqual(closed, { status: 'closed', code: 'closed' });
  });

  test('a rejected request never opens a socket', async t => {
    const f = await fixture(t);
    const adapter = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }));
    assert.throws(() => adapter.open(request({ resumptionHandle: 'handle_1' }), control()), code('invalid_request'));
    assert.throws(() => adapter.open(request({ history: [{ role: 'user', text: 'x', dataClass: 'sensitive' }] }), control()), code('route_denied'));
    assert.throws(() => new OpenAiLiveVoiceAdapter(options({ route: { enabled: true, provider: 'gemini', modelId: 'gpt-live-1', dataClasses: ['ordinary'] } as unknown as LiveVoiceAdapterOptions['route'] })), code('route_denied'));
    await tick();
    assert.deepEqual(f.frames, []);
    assert.equal(f.connections, 0);
  });

  test('audio bytes are validated before the wire', async t => {
    const { session } = await ready(t);
    assert.throws(() => session.sendAudio({ pcm: new Uint8Array(3), dataClass: 'ordinary' }), code('invalid_audio'));
    assert.throws(() => session.sendAudio({ pcm: new Uint8Array(0), dataClass: 'ordinary' }), code('invalid_audio'));
    assert.throws(() => session.sendAudio({ pcm: new Uint8Array(4), dataClass: 'sensitive' }), code('route_denied'));
  });

  test('a malformed provider frame ends the session as a protocol error', async t => {
    const { f, session } = await ready(t);
    f.send({ type: 'session.output_audio.delta', delta: 42 });
    const outcome = await session.done;
    assert.equal(outcome.code, 'protocol_error');
    assert.equal(outcome.recoverable, true);
    assert.ok(session.events[Symbol.asyncIterator] instanceof Function);
  });

  test('an unknown frame type is ignored rather than fatal', async t => {
    const { f, session, captured } = await ready(t);
    f.send({ type: 'session.commentary.appended', event_id: 'event_1' });
    f.send({ type: 'session.output_audio.delta', delta: b64(pcm16(8)) });
    await until(() => captured.events.some(event => event.type === 'audio'));
    let settled = false; void session.done.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    session.close();
  });
});
