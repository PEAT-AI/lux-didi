import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { describe, test } from 'node:test';
import { LiveVoiceError, OpenAiLiveVoiceAdapter, OPENAI_DEFAULT_VOICE, OPENAI_DELIVERY_SECTION, OPENAI_TOOLS_SECTION, openAiInstructions } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions, LiveVoiceEvent } from '../adapters/live-voice/index.js';
import { CANARY, collect, control, FakeClock, fakeReady, fixture, options, pcm16, ready, request } from './openai-live-voice-fixture.js';
import { safeEvent } from '../host/log.js';
import { attachHostLogSink } from '../tools/host-events.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** The adapter receipts as the host log receives them: the durable sink captures exactly the emitted record. */
function hostReceipts(t: TestContext): () => Record<string, unknown>[] {
  const captured: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { captured.push(raw as Record<string, unknown>); } });
  t.after(() => detach());
  return () => captured;
}
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
const sendAudio = (f: { send: (value: unknown) => void }, samples: number) => f.send({ type: 'session.output_audio.delta', delta: b64(pcm16(samples)) });
/** 9600 samples at 16 kHz is 19200 bytes of 24 kHz s16 mono, exactly the 400 ms head start a stretch must fill. */
const speak = (f: { send: (value: unknown) => void }, samples = 9_600) => sendAudio(f, samples);
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

  test('the default voice is marin and no OpenAI voice falls back to another name', async t => {
    assert.equal(OPENAI_DEFAULT_VOICE, 'marin');
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ voice: '', socketFactory: f.socketFactory })).open(request(), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    assert.deepEqual((start.session['audio'] as Record<string, unknown>)['output'], { voice: 'marin' });
  });

  test('PV2: nira, the documented Hindi voice, is selectable and travels as a preset string', async t => {
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ voice: 'nira', socketFactory: f.socketFactory })).open(request(), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    assert.deepEqual((start.session['audio'] as Record<string, unknown>)['output'], { voice: 'nira' });
  });

  test('PV2: a custom voice id is sent as an id object, a preset stays a string', async t => {
    const custom = 'voice_0123456789abcdef';
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ voice: custom, socketFactory: f.socketFactory })).open(request(), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    // GPT-Live references a prompt-designed voice as { id }, never as its name.
    assert.deepEqual((start.session['audio'] as Record<string, unknown>)['output'], { voice: { id: custom } });
    // The documented id form is voice_ plus 16 to 64 lowercase hex characters; anything else is refused.
    for (const bad of ['voice_0123456789ABCDEF', 'voice_0123', 'nira2', 'voice-0123456789abcdef', 'voice_0123456789abcdef'.padEnd(71, 'a')]) {
      assert.throws(() => new OpenAiLiveVoiceAdapter(options({ voice: bad })), code('invalid_settings'), bad);
    }
    const preset = await fixture(t);
    const named = new OpenAiLiveVoiceAdapter(options({ voice: 'cinder', socketFactory: preset.socketFactory })).open(request(), control());
    t.after(() => named.close());
    await preset.frame(1);
    assert.deepEqual(((preset.frames[0] as unknown as Start).session['audio'] as Record<string, unknown>)['output'], { voice: 'cinder' });
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
    for (const section of [OPENAI_TOOLS_SECTION, OPENAI_DELIVERY_SECTION]) assert.ok(instructions.includes(section), section);
    // PV1: the wrapper names no language, because the host's accent block carries the accent now.
    assert.ok(!/^Language:/m.test(instructions), 'no Language line');
    assert.ok(!instructions.includes('Language: speak English'), 'no language instruction line');
    assert.ok(instructions.includes('Delivery: confident and warm underneath, dry and a little edgy; never sugary or sing-song; keep the wit.'), 'the delivery line, verbatim');
    for (const line of ['Do not treat a cough, music, or nearby conversation as a new request.', 'Keep listening while the owner pauses to think.']) assert.ok(instructions.includes(line), line);
    assert.deepEqual(start.session['audio'], { format: { type: 'audio/pcm', rate: 24_000 }, output: { voice: 'marin' } });
    const delegation = start.session['delegation'] as { type: string; responses: Record<string, unknown> };
    assert.equal(delegation.type, 'responses');
    assert.deepEqual(delegation.responses['tools'], [{ type: 'function', ...tools()[0] }]);
    assert.equal(delegation.responses['tool_choice'], 'auto');
    // Ruling O1-R1 (delegation-probe-1018.md): both are accepted by delegation.responses and the final answer
    // arrives 1.6 to 2.3 s sooner per tool turn; no other delegation field is pinned.
    assert.equal(delegation.responses['parallel_tool_calls'], true);
    assert.deepEqual(delegation.responses['reasoning'], { effort: 'low' });
    assert.deepEqual(Object.keys(delegation.responses).sort(), ['model', 'parallel_tool_calls', 'reasoning', 'tool_choice', 'tools'], 'no other delegation field');
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
    const pcm = pcm16(9_600);
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
    assert.throws(() => session.sendToolResponse({ responses: [{ id: 'other', name: 'research', response: { ok: true } }] }), code('protocol_error'));
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
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    // The one-word phantom of the field log: a silent mic produced it, and it used to latch the session muted.
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'mm' });
    // Empty and whitespace-only deltas carry no word: they start no episode and never flush either (GL1-R1).
    for (const delta of ['', '   ', '\n\t ']) opened.f.send({ type: 'session.input_transcript.delta', delta });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription' && event.text === '\n\t '));
    const journaled = opened.captured.events.flatMap(event => (event.type === 'inputTranscription' ? [event.text] : []));
    assert.deepEqual(journaled, ['mm', '   ', '\n\t '], 'a whitespace-only fragment is still journaled, an empty one is not');
    for (let index = 0; index < 30; index += 1) { speak(opened.f, 2_400); await quiet(); clock.advance(100); }
    await until(() => audioOf(opened.captured).length === 31);
    assert.equal(audioBytes(opened.captured), (9_600 + 30 * 2_400) * 2, 'every valid output delta is forwarded');
    assert.equal(interruptions(opened.captured), 0, 'one word is not a barge-in');
    // No delegated response.created ever arrives here, which is the shape of a plain spoken reply.
    clock.advance(200);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'the tail of the answer is still queued');
    clock.advance(1_700);
    await until(() => completions(opened.captured) === 1);
  });

  test('a split barge-in flushes once the server stops, and later audio still flows', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold' });
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'nothing is cut in the same breath as the first word');
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 1);
    // A later word of the same episode cannot flush again: the once-per-episode latch holds.
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' please' });
    await quiet();
    clock.advance(350);
    await quiet();
    assert.equal(interruptions(opened.captured), 1, 'one flush per input episode');
    // Frames of the answer the owner just cut arrive inside the bounded post-flush window and are dropped; audio
    // flows again once the window has passed, and the drop never latches.
    clock.advance(2_500);
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 2);
    assert.equal(audioBytes(opened.captured), 192_000 * 2, 'audio flows again after the drop window');
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'stop that' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 2);
  });

  test('the session logs the final instruction size and never the instruction text', async t => {
    const logged = hostReceipts(t);
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
    t.after(() => session.close());
    await until(() => logged().some(entry => entry['event'] === 'openai_instructions_size'));
    const receipt = logged().find(entry => entry['event'] === 'openai_instructions_size');
    assert.ok(receipt, 'the session start sends openai_instructions_size to the host log');
    const instructions = openAiInstructions('Synthetic persona');
    assert.equal(receipt['chars'], instructions.length);
    assert.equal(receipt['bytes'], Buffer.byteLength(instructions));
    assert.deepEqual(Object.keys(receipt).sort(), ['bytes', 'chars', 'event'], 'sizes only, never instruction text');
    assert.ok(safeEvent(receipt), 'the host log whitelist accepts the exact receipt shape');
  });

  test('a backchannel over a stream the server keeps sending cuts nothing and loses no byte', async t => {
    const logged = hostReceipts(t);
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    const before = audioBytes(opened.captured);
    // gpt-live-1 ignores a backchannel and keeps talking: its deltas never let 350 ms of quiet through, so the
    // server has decided this is not an interruption and every byte still reaches the port (N1).
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'mm-hmm' });
    for (let index = 0; index < 2; index += 1) { await quiet(); clock.advance(300); sendAudio(opened.f, 7_200); }
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'a backchannel never cuts her');
    assert.equal(audioBytes(opened.captured) - before, 14_400 * 2, 'every byte of her answer is forwarded');
    clock.advance(100);
    await until(() => logged().some(entry => entry['event'] === 'gptlive_no_flush'));
    const skipped = logged().filter(entry => entry['event'] === 'gptlive_no_flush');
    assert.equal(skipped.length, 1, 'one receipt per episode, not one per word');
    assert.deepEqual(skipped[0], { event: 'gptlive_no_flush', reason: 'server_continued', words: 2 });
    assert.ok(safeEvent(skipped[0]), 'the host log whitelist accepts the no-flush receipt');
  });

  test('a one-word stop cuts her once the server has been quiet for 350 ms', async t => {
    const logged = hostReceipts(t);
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'stop' });
    await quiet();
    clock.advance(349);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'the server has not yielded before the gap');
    clock.advance(1);
    await until(() => interruptions(opened.captured) === 1);
    const flush = logged().find(entry => entry['event'] === 'gptlive_flush');
    assert.ok(flush, 'the flush reaches the host log');
    assert.equal(flush['words'], 1, 'one word is enough: the server decided');
    assert.equal(flush['yieldGapMs'], 350, 'the receipt carries the measured output gap');
    assert.ok((flush['queuedMs'] as number) > 0, 'and what was cut');
    assert.ok(safeEvent(flush), 'the host log whitelist accepts the flush receipt');
  });

  test('an answer the server has finished sending is cut 350 ms after the owner speaks', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    // Long buffered answer, no delta for a second: the yield has already happened, the queue still holds speech.
    clock.advance(1_000);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'wait' });
    await quiet();
    clock.advance(349);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'one quiet millisecond short of the gap');
    clock.advance(1);
    await until(() => interruptions(opened.captured) === 1);
  });

  test('a short output pause under 2000 ms does not complete the turn', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(1_900);
    await quiet();
    assert.equal(completions(opened.captured), 0);
    sendAudio(opened.f, 240);
    // 3o: the pause drained the modelled playback, so the cushion re-arms before the next 20 ms plays.
    await quiet();
    clock.advance(400);
    await until(() => audioOf(opened.captured).length === 2);
    clock.advance(1_900);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'a stop for breath is not the end of the turn');
  });

  test('a long quiet pause completes the turn once, and later audio reopens it', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(2_000);
    await until(() => completions(opened.captured) === 1);
    clock.advance(10_000);
    await quiet();
    assert.equal(completions(opened.captured), 1, 'silence never completes twice');
    speak(opened.f);
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
    speak(opened.f);
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
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 3);
    clock.advance(2_000);
    await until(() => completions(opened.captured) === 2);
  });

  test('a head start of 400 ms is held once, then audio passes through and loses no byte', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    for (let index = 0; index < 3; index += 1) sendAudio(opened.f, 2_400);
    await quiet();
    assert.deepEqual(audioOf(opened.captured), [], 'nothing is forwarded before 400 ms of audio');
    sendAudio(opened.f, 2_400);
    await until(() => audioOf(opened.captured).length === 1);
    assert.deepEqual(audioOf(opened.captured), [19_200], 'the first 400 ms leaves as one event');
    for (let index = 0; index < 3; index += 1) sendAudio(opened.f, 2_400);
    await until(() => audioOf(opened.captured).length === 4);
    assert.deepEqual(audioOf(opened.captured).slice(1), [4_800, 4_800, 4_800], 'then each delta passes through');
    assert.equal(audioBytes(opened.captured), 7 * 4_800, 'the hold never drops a byte');
  });

  test('a head start that never fills is released by the 400 ms clock', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    sendAudio(opened.f, 2_400);
    await quiet();
    assert.deepEqual(audioOf(opened.captured), []);
    clock.advance(400);
    await until(() => audioOf(opened.captured).length === 1);
    assert.deepEqual(audioOf(opened.captured), [4_800], 'the first 100 ms of a slow stretch still plays');
  });

  test('a barge-in during the head start cuts the reply at the yield gap', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    sendAudio(opened.f, 4_800);
    await quiet();
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    // N1 with the 3o cushion: the 400 ms hold is longer than the 350 ms yield gap, so the owner's barge-in lands
    // before her first syllable plays and the held audio is discarded with the rest of the cut answer.
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 1);
    assert.deepEqual(audioOf(opened.captured), [], 'the cut answer plays nothing');
    await quiet();
    clock.advance(2_500);
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    assert.deepEqual(audioOf(opened.captured), [19_200], 'the next stretch starts a fresh head start');
  });

  test('two parallel tool calls are answered one at a time and sent upstream once', async t => {
    const clock = new FakeClock();
    const { f, session, captured } = await ready(t, { clock });
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    for (const call of [{ id: 'call_1', name: 'research' }, { id: 'call_2', name: 'calendar' }]) {
      f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done',
        item: { type: 'function_call', call_id: call.id, name: call.name, arguments: '{}' } } });
    }
    await until(() => captured.events.filter(event => event.type === 'toolCall').length === 2);
    session.sendToolResponse({ responses: [{ id: 'call_1', name: 'research', response: { ok: true } }] });
    await quiet();
    assert.deepEqual(f.frames.slice(1), [], 'nothing goes upstream while a call of the turn is unanswered');
    assert.throws(() => session.sendToolResponse({ responses: [{ id: 'call_1', name: 'research', response: { ok: true } }] }), code('protocol_error'));
    session.sendToolResponse({ responses: [{ id: 'call_2', name: 'calendar', response: { ok: false } }] });
    await f.frame(4);
    assert.deepEqual(f.frames.slice(1), [
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' } },
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_2', output: '{"ok":false}' } },
      { type: 'response.create' },
    ]);
  });

  test('a whitespace-only fragment starts no input episode and postpones no receipt', async t => {
    const logged = hostReceipts(t);
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 1);
    // A separator-only fragment lands 600 ms into the 700 ms quiet window: it is journaled, but it is not a delta of
    // the episode, so the episode still ends on time and its post-flush receipt is not postponed.
    clock.advance(250);
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' ' });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription' && event.text === ' '));
    clock.advance(100);
    await until(() => logged().some(entry => entry['event'] === 'gptlive_post_flush_audio_ms'));
    assert.equal(interruptions(opened.captured), 1, 'the whitespace fragment adds no word and cannot flush');
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 2);
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' ' });
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold' });
    await quiet();
    assert.equal(interruptions(opened.captured), 1, 'a word after a whitespace fragment starts a new episode and cuts nothing yet');
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 2);
  });

  test('every GPT-Live receipt lands in the host log, names and numbers only', async t => {
    const logged = hostReceipts(t);
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 1);
    clock.advance(700);
    await until(() => logged().some(entry => entry['event'] === 'gptlive_post_flush_audio_ms'));
    clock.advance(2_500);
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 2);
    clock.advance(2_000);
    await until(() => logged().some(entry => entry['event'] === 'gptlive_turn_complete'));
    const names = logged().map(entry => entry['event']);
    for (const name of ['openai_instructions_size', 'gptlive_flush', 'gptlive_post_flush_audio_ms', 'gptlive_turn_complete']) {
      assert.ok(names.includes(name), `${name} reached the host log`);
    }
    for (const entry of logged()) {
      assert.ok(safeEvent(entry), `${String(entry['event'])} is accepted by the host log whitelist`);
      assert.deepEqual(Object.values(entry).filter(value => typeof value === 'string' && value.length > 0), [entry['event']],
        'a receipt carries its event name and numbers, never turn text');
    }
  });

  test('a closed session leaks no turn-taking timer or latch into the next one', async t => {
    const clock = new FakeClock();
    const first = await ready(t, { clock });
    speak(first.f, 96_000);
    await until(() => audioOf(first.captured).length === 1);
    first.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(first.captured) === 1);
    first.session.close();
    await first.session.done;
    await quiet();
    assert.equal(clock.timers, 0, 'the episode and idle timers are cleared on close');
    const second = await ready(t, { clock });
    speak(second.f, 96_000);
    await until(() => audioOf(second.captured).length === 1);
    second.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(second.captured) === 1);
    assert.equal(interruptions(second.captured), 1);
    second.session.close();
  });

  test('after a barge-in the finished tool result is recorded without another response.create', async t => {
    const clock = new FakeClock();
    const { f, session, captured } = await ready(t, { clock });
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    f.send({ type: 'session.output_transcript.delta', delta: 'Checking', start_ms: 0, end_ms: 200 });
    speak(f, 96_000);
    f.send({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'research', arguments: '{}' } } });
    await until(() => captured.events.some(event => event.type === 'audio'));
    f.send({ type: 'session.input_transcript.delta', delta: 'stop, something else', start_ms: 200, end_ms: 500 });
    await quiet();
    clock.advance(350);
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
    speak(f);
    await until(() => captured.events.some(event => event.type === 'audio'));
    let settled = false; void session.done.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    session.close();
  });

  test('an unread provider frame is counted and logged once per session', async t => {
    const logged = hostReceipts(t);
    const { f, session } = await ready(t);
    // N1: a frame this adapter has no rule for may be the yield signal it does not read yet, so its name is kept.
    f.send({ type: 'session.output_audio.started', event_id: 'event_1' });
    f.send({ type: 'session.output_audio.started', event_id: 'event_2' });
    f.send({ type: 'response.cancelled', event_id: 'event_3' });
    await quiet();
    assert.deepEqual(logged().filter(entry => entry['event'] === 'gptlive_unknown_frame'), [], 'nothing is logged mid-session');
    session.close();
    await session.done;
    await quiet();
    const unknown = logged().filter(entry => entry['event'] === 'gptlive_unknown_frame');
    assert.deepEqual(unknown, [
      { event: 'gptlive_unknown_frame', type: 'session.output_audio.started', count: 2 },
      { event: 'gptlive_unknown_frame', type: 'response.cancelled', count: 1 },
    ], 'one record per unread type, with its count');
    for (const entry of unknown) assert.ok(safeEvent(entry), 'the host log whitelist accepts the frame receipt');
  });
});

describe('openai gpt-live turn states', () => {
  /** The live state the host projects from the port's own events: the orb's sequence, in order. */
  const project = (events: readonly LiveVoiceEvent[]): string[] => {
    let thinking = false, speaking = false;
    const states = ['listening'];
    for (const event of events) {
      if (event.type === 'modelTurnStarted' && !speaking) thinking = true;
      else if (event.type === 'audio') { thinking = false; speaking = true; }
      else if (event.type === 'waitingForInput' && event.value) { thinking = false; speaking = false; }
      else if (event.type === 'turnComplete' || event.type === 'interrupted') { thinking = false; speaking = false; }
      const state = thinking ? 'thinking' : speaking ? 'speaking' : 'listening';
      if (states[states.length - 1] !== state) states.push(state);
    }
    return states;
  };
  const waiting = (captured: Captured) => captured.events.filter(event => event.type === 'waitingForInput' && event.value === true).length;
  const starts = (captured: Captured) => captured.events.filter(event => event.type === 'modelTurnStarted').length;
  const inputFinals = (captured: Captured) => captured.events.filter(event => event.type === 'inputTranscription' && event.finished === true).length;

  test('a plain answer goes listening, thinking, speaking, listening, and completes at two seconds', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'What is on' });
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' my plate' });
    await until(() => opened.captured.events.filter(event => event.type === 'inputTranscription').length === 2);
    clock.advance(699);
    await quiet();
    assert.equal(starts(opened.captured), 0, 'the owner is still mid-episode');
    clock.advance(1);
    await until(() => starts(opened.captured) === 1);
    assert.equal(inputFinals(opened.captured), 1, 'the ended episode finishes the owner transcript');
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(500);
    await until(() => waiting(opened.captured) === 1);
    clock.advance(1_000);
    await quiet();
    assert.equal(completions(opened.captured), 0, 'audible silence is not the semantic end of the turn');
    clock.advance(500);
    await until(() => completions(opened.captured) === 1);
    assert.deepEqual(project(opened.captured.events), ['listening', 'thinking', 'speaking', 'listening']);
  });

  test('audio before the completion re-enters SPEAKING', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(600);
    await until(() => waiting(opened.captured) === 1);
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 2);
    clock.advance(500);
    await until(() => waiting(opened.captured) === 2);
    assert.equal(waiting(opened.captured), 2, 'the new audio earns its own silence receipt');
    assert.equal(completions(opened.captured), 0);
    assert.deepEqual(project(opened.captured.events), ['listening', 'speaking', 'listening', 'speaking', 'listening']);
  });

  test('a five second silent think shows thinking and never completes', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'Plan my week' });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription'));
    clock.advance(700);
    await until(() => starts(opened.captured) === 1);
    clock.advance(5_000);
    await quiet();
    assert.equal(completions(opened.captured), 0);
    assert.equal(audioOf(opened.captured).length, 0);
    assert.deepEqual(project(opened.captured.events), ['listening', 'thinking']);
  });

  test('background speech while the server keeps talking flips no state and forwards every byte', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'mm' });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription'));
    // The server answers this background speech by carrying on, so no 350 ms gap ever opens and nothing is cut.
    for (let index = 0; index < 2; index += 1) { clock.advance(300); sendAudio(opened.f, 7_200); await quiet(); }
    clock.advance(100);
    await quiet();
    assert.equal(starts(opened.captured), 0, 'her audio is playing, so this is not a think time');
    assert.equal(interruptions(opened.captured), 0, 'the server talked over the background speech');
    assert.equal(audioBytes(opened.captured), 192_000 + 14_400 * 2, 'every frame reached the port');
    assert.deepEqual(project(opened.captured.events), ['listening', 'speaking']);
  });

  test('a continuous stream of a cut answer is dropped until the 2500 ms bound, then plays', async t => {
    const logged = hostReceipts(t);
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 1);
    const before = audioOf(opened.captured).length;
    // Every frame is delivered before the clock moves, so the arrival gap is read the way the adapter reads it.
    for (let index = 0; index < 20; index += 1) { sendAudio(opened.f, 7_200); await quiet(); clock.advance(100); }
    assert.equal(audioOf(opened.captured).length, before, 'the cut answer never replays inside the window');
    clock.advance(600);
    sendAudio(opened.f, 7_200);
    await quiet();
    // 3o: the cut drained the modelled playback, so the standing cushion re-arms before this frame plays.
    clock.advance(400);
    await until(() => audioOf(opened.captured).length >= before + 1);
    await quiet();
    assert.equal(audioOf(opened.captured).length, before + 1, 'exactly one frame plays after the bound');
    const dropped = logged().filter(entry => entry['event'] === 'gptlive_post_flush_dropped_ms');
    assert.equal(dropped.length, 1, 'one receipt for the dropped window');
    assert.ok((dropped[0]!['ms'] as number) >= 2_000, 'the bound is what ended the drop');
    assert.ok(safeEvent(dropped[0]), 'the host log whitelist accepts the dropped-window receipt');
  });

  test('a straggler after a yield flush is dropped until a 400 ms output gap', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await until(() => interruptions(opened.captured) === 1);
    const before = audioOf(opened.captured).length;
    sendAudio(opened.f, 7_200);
    await quiet();
    clock.advance(400);
    sendAudio(opened.f, 7_200);
    await quiet();
    clock.advance(400);
    await until(() => audioOf(opened.captured).length >= before + 1);
    await quiet();
    assert.equal(audioOf(opened.captured).length, before + 1, 'only the frame after the gap plays');
  });

  // 3o: the mic path. A slow uplink sheds the oldest queued mic frames, so the model hears the newest speech
  // instead of a backlog of seconds, and the capture path never waits.
  test('a backed-up uplink sheds the oldest mic frames and hands the socket no backlog', async t => {
    const receipts = hostReceipts(t);
    const { socket, session } = await fakeReady(t);
    socket.bufferedAmount = 96 * 1024;
    for (let index = 0; index < 12; index += 1) session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    assert.deepEqual(socket.micFrames(), [], 'a backlogged uplink is never handed more mic audio');
    const shed = receipts().filter(record => record.event === 'uplink_shed');
    assert.equal(shed.length, 1, 'the shed receipt is bounded to one per window');
    assert.ok(Number(shed[0]!.bytes) > 0, 'the receipt counts the shed bytes');
    assert.ok(Number(shed[0]!.bufferedPeak) >= 96 * 1024, 'and the peak backlog it was shed against');
    assert.ok(safeEvent(shed[0]), 'the host log whitelist accepts the shed receipt');
    // The uplink recovers: eleven of the twelve frames are gone, so what the model gets is the newest speech.
    socket.bufferedAmount = 0;
    session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    assert.equal(socket.micFrames().length, 2, 'only the newest frames are left to send');
  });

  // 3o: a stall is inbound silence, never an upload queue. Both halves of the measured session are pinned here.
  test('inbound frames keep arriving while the upload is backed up: the session is not stalled', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const receipts = hostReceipts(t);
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 10; step += 1) {
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(2_000);
      // Let the peer's pongs land before the next tick, exactly as a live socket would.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captured.events.some(event => event.type === 'outcome'), false, 'a lossy uplink is not a teardown');
    assert.equal(receipts().filter(record => record.event === 'live_stall').length, 0, 'and never writes a stall receipt');
    session.close();
  });

  test('no inbound frame and no pong for eight seconds is a stall on the existing recovery path', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const receipts = hostReceipts(t);
    const { socket, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    // A dead transport answers nothing: no inbound frame and no pong, which is the only shape that stalls.
    socket.answersPings = false;
    t.mock.timers.tick(10_000);
    await until(() => captured.events.some(event => event.type === 'outcome'));
    const outcome = captured.events.find(event => event.type === 'outcome');
    assert.ok(outcome && outcome.type === 'outcome');
    if (outcome.type !== 'outcome') return;
    assert.equal(outcome.outcome.status, 'failed');
    assert.equal(outcome.outcome.code, 'transport_error');
    assert.equal(outcome.outcome.recoverable, true, 'the R1F rebuild still owns the recovery');
    assert.equal(outcome.outcome.upstream?.errorKind, 'stalled');
    const stall = receipts().filter(record => record.event === 'live_stall');
    assert.equal(stall.length, 1, 'one stall receipt');
    assert.ok(Number(stall[0]!.silentMs) >= 8_000, 'and it carries the inbound silence that ended the transport');
    assert.ok(safeEvent(stall[0]), 'the host log whitelist accepts the stall receipt');
  });

  // 3o: the standing cushion. After any dry the native 80 ms prebuffer is below one 100 ms delta, so the hold
  // comes back whenever the modelled playback has drained, not only at the start of a stretch.
  test('a drained playback re-arms a 400 ms head start, and no byte is lost', async t => {
    const clock = new FakeClock();
    const receipts = hostReceipts(t);
    const opened = await ready(t, { clock });
    sendAudio(opened.f, 2_400);
    await quiet();
    clock.advance(400);
    await until(() => audioOf(opened.captured).length === 1);
    assert.deepEqual(audioOf(opened.captured), [4_800], 'the first stretch is held for 400 ms');
    clock.advance(150);
    await quiet();
    sendAudio(opened.f, 2_400);
    await quiet();
    assert.equal(audioOf(opened.captured).length, 1, 'the drained playback re-arms the hold');
    clock.advance(399);
    await quiet();
    assert.equal(audioOf(opened.captured).length, 1, '399 ms is not the cushion');
    clock.advance(1);
    await until(() => audioOf(opened.captured).length === 2);
    assert.equal(audioBytes(opened.captured), 9_600, 'no byte is lost across the re-arm');
    clock.advance(5_000);
    await quiet();
    const rearm = receipts().filter(record => record.event === 'playback_rearm');
    assert.equal(rearm.length, 1, 'the turn reports its re-arm count once');
    assert.equal(rearm[0]!.count, 1);
    assert.ok(safeEvent(rearm[0]), 'the host log whitelist accepts the re-arm receipt');
  });
});
