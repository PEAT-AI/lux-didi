import { ALARM_MODE_MARKER } from '../live/types.js';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { describe, test } from 'node:test';
import { LiveVoiceError, OpenAiLiveVoiceAdapter, OPENAI_DEFAULT_VOICE, OPENAI_DELIVERY_SECTION, OPENAI_TOOLS_SECTION, openAiInstructions } from '../adapters/live-voice/index.js';
import { FRESH_OPENING, OPENAI_BACKEND_TEMPLATE } from '../adapters/live-voice/openai.js';
import { AUDIBLE_RMS_DBFS, SILENT_RMS_DBFS, pcm16RmsDbfs } from '../adapters/live-voice/audio-level.js';
import type { LiveVoiceAdapterOptions, LiveVoiceEvent } from '../adapters/live-voice/index.js';
import { CANARY, collect, control, FakeClock, FakeSocket, fakeReady, fixture, options, pcm16, ready, request, silence } from './openai-live-voice-fixture.js';
import { Pcm16Upsampler } from '../adapters/live-voice/resample.js';
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
/** The mic payloads the adapter handed the socket, in send order, as the base64 it put on the wire. */
function micAudio(socket: FakeSocket): string[] {
  return socket.sent.flatMap(frame => {
    const parsed = JSON.parse(frame) as { type?: string; audio?: string };
    return parsed.type === 'session.input_audio.append' && parsed.audio ? [parsed.audio] : [];
  });
}
/** The frame the adapter's upsampler produces for one host capture frame, from a stream built the same way. */
function upsampled(frames: Uint8Array[]): string[] {
  const upsampler = new Pcm16Upsampler();
  return frames.map(pcm => Buffer.from(upsampler.process(pcm)).toString('base64'));
}
/** Wait for the outbound socket to hold this many frames. */
async function tally(frames: { length: number }, count: number): Promise<void> {
  await until(() => frames.length >= count);
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
/** One 100 ms frame of the provider's continuous silent output fill, 4800 bytes of 24 kHz s16 mono. */
const silentFrame = (f: { send: (value: unknown) => void }) => f.send({ type: 'session.output_audio.delta', delta: b64(silence(2_400)) });
/** 9600 samples at 16 kHz is 19200 bytes of 24 kHz s16 mono, exactly the 400 ms head start a stretch must fill. */
const speak = (f: { send: (value: unknown) => void }, samples = 9_600) => sendAudio(f, samples);
const delegated = (type: string, event: Record<string, unknown>, id = 'item_1') => ({ type: 'response.event', delegation_id: id, event: { type, ...event } });
/** #924: every report of an opened response that made no audible output. */
const silentContinuations = (opened: { captured: { events: { type: string }[] } }) =>
  opened.captured.events.filter(event => event.type === 'interactionStatus' && (event as { value?: string }).value === 'post_tool_no_output');
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
    // The documented id form is voice_ plus 16 to 64 lowercase hex characters; a `voice_` name that is
    // not one is refused rather than sent as a preset.
    for (const bad of ['voice_0123456789ABCDEF', 'voice_0123', 'voice_0123456789abcdef'.padEnd(71, 'a')]) {
      assert.throws(() => new OpenAiLiveVoiceAdapter(options({ voice: bad })), code('invalid_settings'), bad);
    }
    const preset = await fixture(t);
    const named = new OpenAiLiveVoiceAdapter(options({ voice: 'cinder', socketFactory: preset.socketFactory })).open(request(), control());
    t.after(() => named.close());
    await preset.frame(1);
    assert.deepEqual(((preset.frames[0] as unknown as Start).session['audio'] as Record<string, unknown>)['output'], { voice: 'cinder' });
  });

  test('a custom voice leaves every other start-frame field identical to the preset frame', async t => {
    // The bisection (q6-author.md) accepted the whole app frame with a custom voice: the id changes the
    // audio.output.voice leaf and nothing else, so no tools, seed, delegation or instruction field moves.
    const custom = await fixture(t);
    const preset = await fixture(t);
    const customSession = new OpenAiLiveVoiceAdapter(options({ voice: 'voice_0123456789abcdef', socketFactory: custom.socketFactory })).open(request({ tools: tools() }), control());
    t.after(() => customSession.close());
    const presetSession = new OpenAiLiveVoiceAdapter(options({ voice: OPENAI_DEFAULT_VOICE, socketFactory: preset.socketFactory })).open(request({ tools: tools() }), control());
    t.after(() => presetSession.close());
    await custom.frame(1);
    await preset.frame(1);
    const withCustom = custom.frames[0] as unknown as Start;
    const withPreset = preset.frames[0] as unknown as Start;
    assert.deepEqual((withCustom.session['audio'] as Record<string, unknown>)['output'], { voice: { id: 'voice_0123456789abcdef' } });
    assert.deepEqual((withPreset.session['audio'] as Record<string, unknown>)['output'], { voice: OPENAI_DEFAULT_VOICE });
    assert.deepEqual(withCustom.session['audio'], { ...(withPreset.session['audio'] as Record<string, unknown>), output: { voice: { id: 'voice_0123456789abcdef' } } });
    const { audio: customAudio, ...customRest } = withCustom.session as Record<string, unknown>;
    const { audio: presetAudio, ...presetRest } = withPreset.session as Record<string, unknown>;
    assert.deepEqual(customRest, presetRest, 'every non-voice field is byte-identical between the two frames');
    assert.equal(JSON.stringify(withCustom).replace(JSON.stringify({ voice: { id: 'voice_0123456789abcdef' } }), JSON.stringify({ voice: OPENAI_DEFAULT_VOICE })), JSON.stringify(withPreset), 'the frames differ only in the voice leaf');
  });


  test('S4A-R1: delegation is client-owned with no provider Responses configuration', async t => {
const f = await fixture(t);
const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request({ tools: tools() }), control());
t.after(() => session.close());
await f.frame(1);
const start = f.frames[0] as unknown as Start;
assert.deepEqual(start.session['delegation'], { type: 'client' });
assert.equal(start.session['tools'], undefined);
assert.equal(JSON.stringify(start).includes(OPENAI_BACKEND_TEMPLATE), false);
});



  test('S4A-R1: legacy backendProcedure cannot enter voice instructions or client delegation', async t => {
    const plain = await fixture(t);
    const withProcedure = await fixture(t);
    const plainSession = new OpenAiLiveVoiceAdapter(options({ voice: 'voice_0123456789abcdef', socketFactory: plain.socketFactory })).open(request({ tools: tools() }), control());
    t.after(() => plainSession.close());
    const procedure = 'Procedure: read the calendar first, then the mail.';
    const procedureSession = new OpenAiLiveVoiceAdapter(options({ voice: 'voice_0123456789abcdef', backendProcedure: procedure, socketFactory: withProcedure.socketFactory })).open(request({ tools: tools() }), control());
    t.after(() => procedureSession.close());
    await plain.frame(1);
    await withProcedure.frame(1);
    const before = plain.frames[0] as unknown as Start;
    const after = withProcedure.frames[0] as unknown as Start;
    assert.deepEqual(after.session['delegation'], { type: 'client' });
    assert.deepEqual(after.session['audio'], before.session['audio'], 'the preset and custom voice parts are untouched');
    assert.equal(after.session['instructions'], before.session['instructions'], 'the live instructions are untouched');
    assert.deepEqual(after, before, 'legacy backend options cannot alter the client session');
  });



  test('C-REBUILD8: a commentary append names the delegation in flight, and is skipped with none open', async t => {
 const { f, session, captured } = await ready(t);
 assert.equal(session.sendTaskAnswer!({ delegationId: 'missing', text: 'Synthetic answer' }), undefined);
 assert.equal(f.frames.length, 1);
 f.send({ type: 'session.delegation.created', delegation: { id: 'synthetic-current' } });
 await until(() => captured.events.some(event => event.type === 'delegation'));
 assert.equal(session.sendTaskAnswer!({ delegationId: 'stale', text: 'Synthetic answer' }), undefined);
 const commandId = session.sendTaskAnswer!({ delegationId: 'synthetic-current', text: 'Synthetic answer' });
 assert.equal(typeof commandId, 'string'); await tally(f.frames, 2);
 assert.deepEqual(f.frames[1], { type: 'session.commentary.append', event_id: commandId, delegation_id: 'synthetic-current', content: 'Synthetic answer' });
 session.close();
 });

  test('S4A-R2 (c): a rejected command is a receipt with its kind, never an interruption', async t => {
    const logged = hostReceipts(t);
    const { f, session, captured } = await ready(t);
    f.send({ type: 'session.delegation.created', delegation: { id: 'dlg_reject', response_id: 'resp_reject', offset_ms: 0 } });
    await until(() => captured.events.some(event => event.type === 'delegation'));
    session.sendCommentary!({ text: 'Still reading the mail.' });
    await tally(f.frames, 2);
    f.send({ type: 'error', event_id: 'event_1', error: { type: 'invalid_request_error', code: 'invalid_value', param: 'content', message: 'bad content', client_event_id: 'cmt_1' } });
    // The frame crosses the socket, so wait for its receipt rather than for one scheduler tick.
    await until(() => logged().some(entry => entry['event'] === 'command_rejected'));
    assert.equal(captured.events.some(event => event.type === 'interrupted'), false, 'a rejected command cuts nothing');
    const rejected = logged().filter(entry => entry['event'] === 'command_rejected');
    assert.deepEqual(rejected, [{ event: 'command_rejected', code: 'invalid_value', param: 'content', kind: 'cmt' }]);
    for (const entry of rejected) assert.ok(safeEvent(entry), 'the host log whitelist accepts the rejection receipt');
    session.close();
  });

  // #677 / L8-05: at 10:24:43 a host line (sendText, the late-findings path) wrote a `response.create` while a
  // delegated call still owed its output; the provider refused it with function_call_outputs_required and the turn
  // fell to a dead-air rebuild. A continuation the wire would refuse is never written: the line waits as owed, and
  // the one continuation follows the owed output.






  test('S4A-R2 (c): an unknown provider code is a diagnostic trap, never an interruption and never a retry', async t => {
    const logged = hostReceipts(t);
    const { f, captured } = await ready(t);
    const before = f.frames.length;
    f.send({ type: 'error', event_id: 'event_1', error: { type: 'mystery_error', code: 'something_new', param: 'field', message: 'unknown', client_event_id: 'cmt_1' } });
    await until(() => logged().some(entry => entry['event'] === 'provider_error_unclassified'));
    assert.equal(captured.events.some(event => event.type === 'interrupted'), false, 'an unknown code cuts nothing');
    assert.equal(f.frames.length, before, 'and is never retried');
    const trapped = logged().filter(entry => entry['event'] === 'provider_error_unclassified');
    assert.deepEqual(trapped, [{ event: 'provider_error_unclassified', type: 'mystery_error', code: 'something_new', param: 'field' }]);
    assert.equal(logged().filter(entry => entry['event'] === 'command_rejected').length, 0, 'and is not read as a rejection');
  });

  test('a refused setup records the provider error, redacted and bounded, and never the instructions', async t => {
    const logged = hostReceipts(t);
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ voice: 'voice_0123456789abcdef', socketFactory: f.socketFactory })).open(request(), control());
    t.after(() => session.close());
    await f.frame(1);
    // An error frame before session.started is a refused setup; the provider's words are the whole evidence.
    f.send({ type: 'error', event_id: 'event_setup', error: {
      type: 'invalid_request_error', code: 'invalid_value', param: 'session.audio.output.voice',
      message: `Invalid value for voice: key sk-${CANARY} rejected\n${'x'.repeat(400)}`, client_event_id: null } });
    assert.deepEqual(await session.done, { status: 'failed', code: 'provider_setup_rejected' });
    await until(() => logged().some(entry => entry['event'] === 'gptlive_setup_error'));
    const receipt = logged().find(entry => entry['event'] === 'gptlive_setup_error')!;
    assert.deepEqual(Object.keys(receipt).sort(), ['code', 'event', 'message', 'param', 'type'], 'the provider fields only, no other field');
    assert.equal(receipt['type'], 'invalid_request_error');
    assert.equal(receipt['code'], 'invalid_value');
    assert.equal(receipt['param'], 'session.audio.output.voice');
    const message = String(receipt['message']);
    assert.equal(message.length, 300, 'the message is truncated to 300 characters');
    assert.ok(!message.includes(CANARY), 'nothing that looks like a key survives');
    assert.ok(!message.includes('\n'), 'the message is one line');
    assert.ok(!message.includes(openAiInstructions('Synthetic persona')), 'never the instructions');
    assert.ok(safeEvent(receipt), 'the host log whitelist accepts the refusal receipt');
    assert.ok(!logged().some(entry => JSON.stringify(entry).includes('Synthetic persona')), 'no receipt carries instruction text');
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
    assert.deepEqual(start.session['delegation'], { type: 'client' });
    assert.equal('tools' in start.session, false, 'client delegation exposes no session tools');
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
    const seeded = start.session['input'] as { role?: string; content: { text: string }[] }[];
    // C-RECONNECT #1072: the seed is framed before it is read, so the rebuilt session knows the user turns are the
    // owner speaking to her rather than a transcript about a third party.
    assert.equal(seeded[0]?.role, 'developer', 'the framing is host guidance, never the owner\u2019s words');
    assert.match(seeded[0]!.content[0]!.text, /owner speaking to you directly/u, 'and it marks his turns as his own');
    assert.deepEqual(seeded.slice(1), [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plan the week' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Monday first' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Pick up where we left off.' }] },
    ], 'the framed seeded conversation, then the pickup line');
  });

  // C-RECONNECT #1072: a rebuilt session reads this call's own transcript, and without a word about whose words are
  // whose it narrates the owner in the third person ("he asked") instead of answering him. The seed text marks the
  // owner's turns as the owner speaking to her, in the second person, and leaves his own words untouched.
  test('#1072: a seeded open tells the new session whose words are whose, so it answers the owner in the second person', async t => {
    const f = await fixture(t);
    const history = [
      { role: 'user' as const, text: 'What did we settle about the bridge?', dataClass: 'ordinary' as const },
      { role: 'model' as const, text: 'Monday, after the inspection.', dataClass: 'ordinary' as const },
    ];
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }))
      .open(request({ history, openingText: 'Pick up where we left off.', opening: 'model_first' }), control());
    t.after(() => session.close());
    await f.frame(1);
    const input = (f.frames[0] as unknown as Start).session['input'] as { role?: string; content: { text: string }[] }[];
    assert.equal(input[0]?.role, 'developer', 'the framing is host guidance, never the owner\u2019s words');
    const framing = input[0]!.content[0]!.text;
    assert.match(framing, /owner speaking to you directly/u, 'the owner\u2019s turns are marked as him speaking to her');
    assert.match(framing, /your own earlier speech/u, 'and her turns are marked as her own');
    assert.match(framing, /\byou\b/u, 'the framing is second person');
    assert.doesNotMatch(framing, /\b(?:he|him|his)\b/u, 'never a third-person narration of the owner');
    // His own words ride unchanged: the framing marks them, the host never re-narrates them.
    assert.deepEqual(input.slice(1).map(item => item.content[0]!.text),
      ['What did we settle about the bridge?', 'Monday, after the inspection.', 'Pick up where we left off.']);
    assert.equal(input.slice(1).some(item => item.role === 'user' && /^(?:the |he |his )/iu.test(item.content[0]!.text)), false,
      'no owner turn is rewritten into third-person narration');
  });

  // B1 (review of 76cd18b3): the framing shares the documented 8,192-token proxy with the turns it introduces. A seed
  // whose turns fill that proxy exactly is not trimmed, so charging the framing on top of it refused the open that a
  // long call needs most: the recovery rebuild. The trim reserves the framing instead.
  test('#1072 B1: a seed that fills the character ceiling still opens, framing first', async t => {
    const f = await fixture(t);
    const chunk = 'x'.repeat(8_191);
    const history = Array.from({ length: 4 }, (_, index) => ({
      role: (index % 2 ? 'model' : 'user') as 'user' | 'model', text: `${index}${chunk}`, dataClass: 'ordinary' as const }));
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }))
      .open(request({ history }), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    const input = start.session['input'] as { role?: string; content: { text: string }[] }[];
    assert.equal(input[0]!.role, 'developer', 'the framing takes the first slot');
    const characters = input.reduce((sum, item) => sum + item.content[0]!.text.length, 0);
    assert.ok(characters <= 8_192 * 4, `the seed and its framing stay inside the ceiling (${characters})`);
    assert.ok(input.length > 1, 'the newest turns are kept and condensed, never dropped for the framing');
  });

  // C-RECOVERY (a): a long call must still reopen. The adapter keeps the newest turns and the pickup line's slot
  // instead of refusing the whole open, which is what lost the 2026-10-27 call.
  test('C-RECOVERY (a): a history over the 128-message ceiling is trimmed to its newest turns and still opens', async t => {
    const f = await fixture(t);
    const history = Array.from({ length: 140 }, (_, index) => ({
      role: (index % 2 ? 'model' : 'user') as 'user' | 'model', text: `turn ${index}`, dataClass: 'ordinary' as const }));
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }))
      .open(request({ history, openingText: 'Pick up where we left off.' }), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    const input = start.session['input'] as { role?: string; content: { text: string }[] }[];
    assert.equal(input.length, 128, 'the trimmed history, its framing and the pickup line stay at the documented 128 messages');
    assert.equal(input[0]!.role, 'developer', 'the framing takes the first slot');
    assert.equal(input[1]!.content[0]!.text, 'turn 14', 'the oldest turns are the ones that go, and the framing costs one slot');
    assert.equal(input[126]!.content[0]!.text, 'turn 139', 'the newest turn is always kept');
    assert.equal(input[127]!.content[0]!.text, 'Pick up where we left off.', 'and the pickup line keeps its slot');
  });

  test('#1023: a new call with seeded history still seeds the fresh opening directive', async t => {
    const f = await fixture(t);
    const history = [{ role: 'user' as const, text: 'Plan the week', dataClass: 'ordinary' as const }];
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }))
      .open(request({ history, opening: 'model_first' }), control());
    t.after(() => session.close());
    await f.frame(1);
    const start = f.frames[0] as unknown as Start;
    const input = start.session['input'] as { role?: string; content: { text: string }[] }[];
    assert.deepEqual(input.slice(1), [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plan the week' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: FRESH_OPENING }] },
    ], 'the seeded history is followed by the opening directive');
    assert.equal(input[0]?.role, 'developer', 'and the seed is framed before it is read');
  });

  test('#1023: the opening directive asks for one short dry line, never a canned greeting', () => {
    assert.match(FRESH_OPENING, /twelve words at most/);
    assert.match(FRESH_OPENING, /^Speak one original opening line now/);
    assert.doesNotMatch(FRESH_OPENING, /\b(?:say|speak|tell him)\s+["“]/i, 'never quote a fixed speakable instruction as the opener');
    assert.match(FRESH_OPENING, /No greeting formula/);
    assert.match(FRESH_OPENING, /offer of help/);
    assert.match(FRESH_OPENING, /tool call precedes it/);
    assert.match(FRESH_OPENING, /subject comes from an opening option or earlier conversation, in new words/,
      'the seed history is an allowed subject, so a pending summary still grounds the line');
    assert.doesNotMatch(FRESH_OPENING, /\b(hello|hi|hey|good morning|good evening|how can i help|what can i do)\b/i);
  });

  test('L8-09/L11-05: the opening directive never asks for the earlier call\'s closing words or a stop line', () => {
    // The stop-and-listen clause came back as a spoken stop line, and the last-thing clause as the earlier
    // call's closing line.
    assert.doesNotMatch(FRESH_OPENING, /stop and listen/u);
    assert.doesNotMatch(FRESH_OPENING, /the last thing you and the owner were on/u);
    assert.match(FRESH_OPENING, /never the closing lines/u);
    assert.match(FRESH_OPENING, /or stopping, ending or listening/u);
    assert.match(FRESH_OPENING, /owner speech arriving first takes priority/u);
    assert.doesNotMatch(FRESH_OPENING, /[\u2013\u2014]/u);
  });



  test('D1: a normal connect with history seeds the opening directive inside the start', async t => {
    const history = [{ role: 'user' as const, text: 'Plan the week', dataClass: 'ordinary' as const }, { role: 'model' as const, text: 'Monday first', dataClass: 'ordinary' as const }];
    const { f } = await ready(t, {}, { history, opening: 'model_first' });
    const input = (f.frames[0] as unknown as Start).session['input'] as { role?: string }[];
    assert.equal(input.at(-1)?.role, 'developer', 'the opening directive rides in the start');
  });



  test('1023-N3: owner speech cannot reach the provider before the ready settle, so the opener never races him', async t => {
    const f = await fixture(t);
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request({ opening: 'model_first' }), control());
    t.after(() => session.close());
    await f.frame(1);
    // Every owner byte goes through sendAudio, and sendAudio refuses until session.started, so the opener request
    // below is the first thing the provider hears on a fresh call: there is no window in which he can speak first.
    assert.throws(() => session.sendAudio({ pcm: pcm16(), dataClass: 'ordinary' }), code('not_ready'),
      'the microphone is closed before the ready settle');
    f.send({ type: 'session.started', session: { id: 'sess_opener_race' } });
    await session.ready;
    await quiet();
    assert.deepEqual(f.frames.map(frame => (frame as unknown as Start).type), ['session.start'], 'ready never sends a forbidden response command');
    session.sendAudio({ pcm: pcm16(), dataClass: 'ordinary' });
    await quiet();
    assert.equal(f.frames.some(frame => (frame as unknown as Start).type === 'session.input_audio.append'), true,
      'the same call accepts owner audio once it is ready');
  });

  test('1023-N3: the owner speaking first asks for no opener at all', async t => {
    const { f } = await ready(t, {}, { opening: 'user_first' });
    await quiet();
    assert.deepEqual(f.frames.map(frame => (frame as unknown as Start).type), ['session.start'], 'no opener is requested before the owner speaks');
  });



  test('#1023: a 128-turn warm history still starts, the directive costs the oldest turn', async t => {
    const history = Array.from({ length: 128 }, (_, index) => ({
      role: (index % 2 ? 'model' : 'user') as 'user' | 'model', text: `turn ${index}`, dataClass: 'ordinary' as const }));
    const { f } = await ready(t, {}, { history, opening: 'model_first' });
    const input = (f.frames[0] as unknown as Start).session['input'] as { role?: string; content: { text: string }[] }[];
    assert.equal(input.length, 128, 'the seed stays within the documented 128 messages');
    assert.equal(input[0]!.role, 'developer', 'the framing takes the first slot');
    assert.equal(input[1]!.content[0]!.text, 'turn 2', 'the oldest turns make room for the framing and the directive');
    assert.deepEqual(input.at(-1), { type: 'message', role: 'developer', content: [{ type: 'input_text', text: FRESH_OPENING }] });
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

  test('behaviour (c): her output audio after an input episode still plays, in order', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    for (const word of ['hold', ' on', ' for', ' a', ' moment']) {
      opened.f.send({ type: 'session.input_transcript.delta', delta: word });
      await quiet();
      clock.advance(300);
      await quiet();
    }
    // The owner has stopped and the server has been quiet far longer than the old 350 ms yield gap.
    clock.advance(500);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'sustained owner speech cuts nothing either');
    for (const samples of [2_400, 4_800, 7_200]) { sendAudio(opened.f, samples); await quiet(); }
    await quiet();
    assert.deepEqual(audioOf(opened.captured), [192_000, 4_800, 9_600, 14_400],
      'every chunk after the episode plays, in the order the provider sent it');
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

  test('behaviour (a): one transcribed word never cuts her at any output gap', async t => {
    for (const gap of [350, 1_200, 3_000]) {
      const clock = new FakeClock();
      const opened = await ready(t, { clock });
      speak(opened.f, 96_000);
      await until(() => audioOf(opened.captured).length === 1);
      const before = audioBytes(opened.captured);
      // gpt-live-1 ignores a backchannel and keeps talking: no gap in its stream is a decision to stop (N1).
      opened.f.send({ type: 'session.input_transcript.delta', delta: 'mm-hmm' });
      await quiet();
      clock.advance(gap);
      await quiet();
      assert.equal(interruptions(opened.captured), 0, `one word and a ${gap} ms gap cut nothing`);
      sendAudio(opened.f, 7_200);
      await quiet();
      clock.advance(100);
      await quiet();
      assert.equal(audioBytes(opened.captured) - before, 14_400, `every byte of her answer still plays after ${gap} ms of quiet`);
      assert.equal(interruptions(opened.captured), 0, `and nothing was cut at ${gap} ms`);
    }
  });
  test('behaviour (b): the 2026-10-20 06:26:04 cut cannot happen, one word and 51 ms still queued', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    // 402 ms of her answer queued, then one transcribed word and the 351 ms gap of the field receipt.
    sendAudio(opened.f, 9_648);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'avellianism' });
    await quiet();
    clock.advance(350);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'one word with 52 ms still queued cut nothing');
    clock.advance(1);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'the exact 351 ms gap of the field cut brought no interruption');
    assert.equal(audioBytes(opened.captured), 19_296, 'her whole answer reached the port');
  });
  test('behaviour (b): the 2026-10-19 stale episode never cuts the reply she just started', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    // "Naya, Naya, Naya" is transcribed before her first audible output of the turn.
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'Naya, Naya, Naya' });
    await quiet();
    clock.advance(300);
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(830);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'words that began before her reply cut nothing 830 ms in');
    clock.advance(3_000);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'and nothing later in that reply was cut by them');
    assert.equal(audioBytes(opened.captured), 192_000, 'every byte of the reply still reached the port');
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

  test('a barge-in during the head start never cuts her first syllable', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    sendAudio(opened.f, 4_800);
    await quiet();
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(400);
    await until(() => audioOf(opened.captured).length === 1);
    assert.deepEqual(audioOf(opened.captured), [9_600], 'the held first syllable still plays');
    clock.advance(3_000);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'a barge-in over the head start cut nothing');
  });










  test('a whitespace-only fragment is journaled and cuts nothing', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 1);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await quiet();
    clock.advance(250);
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' ' });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription' && event.text === ' '));
    clock.advance(1_000);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'a separator-only fragment adds no word and cuts nothing');
  });
  test('every GPT-Live receipt lands in the host log, names and numbers only', async t => {
    const logged = hostReceipts(t);
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f, 100_000);
    await until(() => audioOf(opened.captured).length === 1);
    // The answer drains, then 2000 ms of presentation idle ends the turn.
    clock.advance(7_000);
    await until(() => logged().some(entry => entry['event'] === 'gptlive_turn_complete'));
    const names = logged().map(entry => entry['event']);
    for (const name of ['openai_instructions_size', 'gptlive_turn_complete']) {
      assert.ok(names.includes(name), `${name} reached the host log`);
    }
    for (const entry of logged()) {
      assert.ok(safeEvent(entry), `${String(entry['event'])} is accepted by the host log whitelist`);
      const strings = Object.values(entry).filter(value => typeof value === 'string' && value.length > 0);
      // #451: a handshake receipt also names its closed-set step, which is a protocol token, never turn text.
      assert.deepEqual(strings, entry['event'] === 'live_handshake' ? [entry['event'], entry['step']] : [entry['event']],
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
    await quiet();
    first.session.close();
    await first.session.done;
    await quiet();
    assert.equal(clock.timers, 0, 'the episode and idle timers are cleared on close');
    assert.equal(interruptions(first.captured), 0, 'an owner word cut nothing');
    const second = await ready(t, { clock });
    speak(second.f, 96_000);
    await until(() => audioOf(second.captured).length === 1);
    second.f.send({ type: 'session.input_transcript.delta', delta: 'hold on' });
    await quiet();
    clock.advance(350);
    await quiet();
    assert.equal(interruptions(second.captured), 0, 'and the next session inherits no way to be cut');
    second.session.close();
  });
















  test('3r D2: 10 s of silent fill frames plus owner words cut nothing and re-arm nothing', async t => {
    const clock = new FakeClock();
    const logged = hostReceipts(t);
    const opened = await ready(t, { clock });
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'are you there' });
    await quiet();
    for (let step = 0; step < 100; step += 1) { clock.advance(100); silentFrame(opened.f); }
    await quiet();
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'still there' });
    await quiet();
    clock.advance(700);
    await until(() => opened.captured.events.some(event => event.type === 'modelTurnStarted'));
    assert.equal(interruptions(opened.captured), 0, 'fill is not speech to talk over');
    assert.equal(audioBytes(opened.captured), 100 * 4_800, 'every fill byte is still forwarded');
    // A real answer then plays and completes the turn, and no head start was ever re-armed by a fill frame.
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 101);
    clock.advance(5_000);
    await until(() => completions(opened.captured) === 1);
    assert.deepEqual(logged().filter(entry => entry['event'] === 'playback_rearm'), [{ event: 'playback_rearm', count: 0 }]);
  });

  test('3r D2: fill frames before an audible answer are forwarded and cut nothing', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    for (let step = 0; step < 20; step += 1) { clock.advance(100); silentFrame(opened.f); }
    speak(opened.f, 96_000);
    await until(() => audioOf(opened.captured).length === 21);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'stop' });
    await quiet();
    clock.advance(350);
    await quiet();
    assert.equal(interruptions(opened.captured), 0, 'one word over a real answer still cuts nothing');
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
      else if (event.type === 'audio' && event.audible !== false) { thinking = false; speaking = true; }
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

  test('C-LOG-ENVELOPE: the journal keeps its empty closing row and no log line carries the words', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    const logged: unknown[] = [];
    const detach = attachHostLogSink({ event: raw => logged.push(raw) });
    t.after(detach);
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'What is on' });
    opened.f.send({ type: 'session.input_transcript.delta', delta: ' my plate' });
    await until(() => opened.captured.events.filter(event => event.type === 'inputTranscription').length === 2);
    clock.advance(700);
    await until(() => starts(opened.captured) === 1);
    const inputFinal = opened.captured.events.filter(event => event.type === 'inputTranscription' && event.finished === true);
    assert.equal(inputFinal.length, 1, 'the ended episode closes the owner transcript once');
    assert.equal(inputFinal[0]!.type === 'inputTranscription' && inputFinal[0]!.text, '', 'the journal closing row stays empty (L2-R1)');
    opened.f.send({ type: 'session.output_transcript.delta', delta: 'A cheese' });
    opened.f.send({ type: 'session.output_transcript.delta', delta: ' sandwich.' });
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    clock.advance(500);
    await until(() => waiting(opened.captured) === 1);
    clock.advance(1_000);
    await quiet();
    clock.advance(500);
    await until(() => completions(opened.captured) === 1);
    const outputFinal = opened.captured.events.filter(event => event.type === 'outputTranscription' && event.finished === true);
    assert.equal(outputFinal.length, 1, 'the end of the turn closes the answer transcript once');
    assert.equal(outputFinal[0]!.type === 'outputTranscription' && outputFinal[0]!.text, '', 'the journal closing row stays empty (L2-R1)');
    // The same turn's host lines stay metadata: ids and counts only, never the utterance.
    assert.equal(JSON.stringify(logged).includes('sandwich'), false);
    assert.equal(JSON.stringify(logged).includes(' my plate'), false);
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

  test('the output level puts digital silence and near-silent fill below the audible threshold, and speech above it', () => {
    assert.equal(pcm16RmsDbfs(silence(2_400)), SILENT_RMS_DBFS, 'digital silence is the floor, never -Infinity');
    const speech = pcm16RmsDbfs(pcm16(2_400));
    assert.ok(speech > -20, `a conversational tone is well above the threshold, measured ${speech.toFixed(1)} dBFS`);
    assert.ok(speech > AUDIBLE_RMS_DBFS, 'and the same fixture counts as audible');
    // The fill a provider can stream for minutes: 30 counts of 32767, about -68 dBFS, heard as nothing.
    const fill = pcm16RmsDbfs(pcm16(2_400, 30));
    assert.ok(fill < AUDIBLE_RMS_DBFS, `near-silent fill stays inaudible, measured ${fill.toFixed(1)} dBFS`);
    assert.ok(fill > SILENT_RMS_DBFS, 'and is still not digital silence');
  });

  test('a stream of silent frames after her last word ends SPEAKING on the silence rule, and every byte plays', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    speak(opened.f);
    await until(() => audioOf(opened.captured).length === 1);
    // gpt-live-1 keeps sending output frames at 48 kB/s; after the last word they are all digital silence.
    for (let index = 0; index < 12; index += 1) { clock.advance(100); silentFrame(opened.f); await quiet(); }
    // The last stretch may still be inside the 400 ms head start: the cushion times out and plays it too.
    clock.advance(400);
    await until(() => audioBytes(opened.captured) === 19_200 + 12 * 4_800);
    assert.deepEqual(project(opened.captured.events), ['listening', 'speaking', 'listening'], 'silence ends SPEAKING');
    assert.equal(audioBytes(opened.captured), 19_200 + 12 * 4_800, 'not one silent byte is dropped');
    const audio = opened.captured.events.filter(event => event.type === 'audio');
    assert.equal(audio[0]!.audible, true, 'her words are audible');
    assert.ok(audio.slice(1).every(event => event.audible === false), 'the fill frames are not');
  });

  test('three silent seconds after her question stay THINKING until the first audible frame', async t => {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'what is on my plate' });
    await until(() => opened.captured.events.some(event => event.type === 'inputTranscription'));
    clock.advance(700);
    await until(() => starts(opened.captured) === 1);
    assert.deepEqual(project(opened.captured.events), ['listening', 'thinking']);
    for (let index = 0; index < 30; index += 1) { clock.advance(100); silentFrame(opened.f); await quiet(); }
    assert.deepEqual(project(opened.captured.events), ['listening', 'thinking'], 'three silent seconds are still think time');
    const fill = opened.captured.events.filter(event => event.type === 'audio');
    assert.ok(fill.length > 0, 'the fill frames still reach playback');
    assert.ok(fill.every(event => event.audible === false), 'and none of them counts as speech');
    assert.equal(completions(opened.captured), 0, 'a silent stream never completes the turn');
    speak(opened.f);
    await until(() => audioBytes(opened.captured) === 30 * 4_800 + 19_200);
    assert.deepEqual(project(opened.captured.events), ['listening', 'thinking', 'speaking'], 'her first audible frame is the start');
    assert.equal(audioBytes(opened.captured), 30 * 4_800 + 19_200, 'every byte of the stream is conserved');
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

  test('a backed-up uplink sheds the oldest mic frames and hands the socket no backlog', async t => {
    const receipts = hostReceipts(t);
    const { socket, session } = await fakeReady(t);
    socket.bufferedAmount = 96 * 1024;
    for (let index = 0; index < 40; index += 1) session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    assert.deepEqual(socket.micFrames(), [], 'a backlogged uplink is never handed more mic audio');
    const shed = receipts().filter(record => record.event === 'uplink_shed');
    assert.equal(shed.length, 1, 'the shed receipt is bounded to one per window');
    assert.ok(Number(shed[0]!.bytes) > 0, 'the receipt counts the shed bytes');
    assert.ok(Number(shed[0]!.bufferedPeak) >= 96 * 1024, 'and the peak backlog it was shed against');
    assert.ok(safeEvent(shed[0]), 'the host log whitelist accepts the shed receipt');
    // The uplink recovers and the queued run goes out: the queue was shed down to half the cap, so the frames
    // that reach the model are a run of consecutive speech, never the newest frame on its own.
    socket.bufferedAmount = 0;
    session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    const kept = socket.micFrames().length;
    assert.ok(kept > 1, `a run of the kept frames goes out, got ${kept}`);
  });

  // Release 3: the shed protects the owner's speech. Silence goes first and one frame of every 200 ms of dropped
  // silence stays queued as a heartbeat, so the provider's silence timing still advances while the words get out.
  test('a backed-up uplink sheds silence first, keeps a heartbeat per 200 ms, and delivers every speech frame', async t => {
    const receipts = hostReceipts(t);
    const { socket, session } = await fakeReady(t);
    const pushed: Uint8Array[] = [];
    const push = (pcm: Uint8Array) => { pushed.push(pcm); session.sendAudio({ pcm, dataClass: 'ordinary' }); };
    socket.bufferedAmount = 96 * 1024;
    for (let index = 0; index < 36; index += 1) push(pcm16(320, 0));
    for (let index = 0; index < 25; index += 1) push(pcm16(320, 8_000));
    assert.deepEqual(socket.micFrames(), [], 'a backlogged uplink is handed no mic audio');
    const shed = receipts().filter(record => record.event === 'uplink_shed');
    assert.equal(shed.length, 1, 'the shed receipt is still bounded to one per window');
    const record = shed[0]!;
    assert.equal(Number(record.speechShedMs), 0, 'no speech went');
    assert.equal(Number(record.speechShedBytes), 0, 'and no speech byte went');
    assert.ok(Number(record.silenceShedMs) > 0, 'the dropped silence is counted on its own');
    assert.ok(Number(record.silenceShedBytes) > 0, 'and its bytes are too');
    assert.equal(Number(record.lostMs), Number(record.speechShedMs) + Number(record.silenceShedMs), 'lost is the two halves');
    assert.ok(safeEvent(record), 'the host log whitelist accepts the split receipt');
    socket.bufferedAmount = 0;
    push(pcm16(320, 0));
    const audio = micAudio(socket);
    const expected = upsampled(pushed);
    assert.deepEqual(audio.slice(0, 3), [expected[9], expected[19], expected[29]], 'one silence heartbeat per 200 ms');
    assert.deepEqual(audio.slice(3, 28), expected.slice(36, 61), 'every loud frame reaches the model, in capture order');
    assert.deepEqual(audio.slice(28), [expected[61]], 'and the frame that triggered the drain follows it');
  });

  test('a backed-up uplink keeps the one speech frame behind a silent backlog for the next drain', async t => {
    const receipts = hostReceipts(t);
    const { socket, session } = await fakeReady(t);
    const pushed: Uint8Array[] = [];
    const push = (pcm: Uint8Array) => { pushed.push(pcm); session.sendAudio({ pcm, dataClass: 'ordinary' }); };
    socket.bufferedAmount = 96 * 1024;
    for (let index = 0; index < 36; index += 1) push(pcm16(320, 0));
    const loud = pcm16(320, 8_000);
    push(loud);
    assert.deepEqual(socket.micFrames(), [], 'a backlogged uplink is handed no mic audio');
    socket.bufferedAmount = 0;
    push(pcm16(320, 0));
    const expected = upsampled(pushed);
    const audio = micAudio(socket);
    assert.ok(audio.includes(expected[36]!), 'the one loud frame is delivered on the next drain');
    assert.equal(audio.filter(frame => frame === expected[36]).length, 1, 'and exactly once');
    assert.equal(Number(receipts().filter(record => record.event === 'uplink_shed')[0]!.speechShedMs), 0, 'no speech went in the shed');
  });

  // Release 3: with nothing silent to drop, the oldest speech goes as one run and the newest 500 ms (25 frames)
  // of a pinned uplink always stays, so the model hears the end of the sentence rather than one island of it.
  test('forty speech frames under a pinned uplink keep the newest 500 ms as one consecutive run', async t => {
    const receipts = hostReceipts(t);
    const { socket, session } = await fakeReady(t);
    const pushed: Uint8Array[] = [];
    socket.bufferedAmount = 96 * 1024;
    for (let index = 0; index < 40; index += 1) {
      const pcm = pcm16(320, 4_000 + index * 700);
      pushed.push(pcm);
      session.sendAudio({ pcm, dataClass: 'ordinary' });
    }
    const record = receipts().filter(entry => entry.event === 'uplink_shed')[0]!;
    const shedFrames = Number(record.speechShedMs) / 20;
    assert.ok(shedFrames > 0, `the oldest speech run went, got ${String(record.speechShedMs)} ms`);
    assert.ok(Number(record.speechShedBytes) > 0, 'and its bytes are counted as speech');
    assert.equal(Number(record.silenceShedMs), 0, 'nothing silent was queued');
    socket.bufferedAmount = 0;
    pushed.push(pcm16(320, 7_000));
    session.sendAudio({ pcm: pushed[40]!, dataClass: 'ordinary' });
    const expected = upsampled(pushed);
    const audio = micAudio(socket);
    assert.deepEqual(audio.slice(0, -1), expected.slice(shedFrames, 40), 'the kept speech is consecutive and in capture order');
    assert.ok(audio.length - 1 >= 25, `the newest 500 ms of speech is kept, got ${audio.length - 1} frames`);
  });

  // W3: the owner is told when the internet is the reason. Quality is derived from what the adapter already
  // measures (capture against discards, persistent backlog), and the upload figure is what the socket drained.
  test('a link that drains 20 KB/s reads weak with the measured upload, and ok again after 5 s of health', async t => {
    const receipts = hostReceipts(t);
    const clock = new FakeClock();
    const { socket, session } = await fakeReady(t, { clock });
    socket.trackBuffer = true;
    const connection = () => (session.diagnostics?.() as { connection?: { quality: string; uploadKbps?: number } } | undefined)?.connection;
    for (let index = 0; index < 160; index += 1) {
      socket.drain(400); // 400 B per 20 ms frame is 20 KB/s, well under the 66.4 KB/s the capture demands
      session.sendAudio({ pcm: pcm16(320), dataClass: 'ordinary' });
      clock.advance(20);
    }
    assert.equal(connection()?.quality, 'weak', 'more than a fifth of the captured bytes were discarded');
    const measured = Number(connection()?.uploadKbps);
    assert.ok(measured >= 140 && measured <= 180, `about 160 kbit/s of drain, got ${measured}`);
    for (let index = 0; index < 260; index += 1) {
      socket.drain(20_000); // the link keeps up again: the socket buffer stays well below the cap
      session.sendAudio({ pcm: pcm16(320), dataClass: 'ordinary' });
      clock.advance(20);
    }
    assert.equal(connection()?.quality, 'ok', 'five quiet seconds make it ok again');
    const transitions = receipts().filter(record => record.event === 'connection_quality');
    assert.ok(transitions.length >= 2, 'one host record per transition, never per frame');
    assert.ok(transitions.every(safeEvent), 'the host log whitelist accepts the quality record');
  });

  // W3-R2(a): the measured regime, four tenths of the capture shed over three seconds with the socket
  // backlogged but not pinned, is the case the owner's link actually ran.
  test('a link that sheds four tenths of the capture reads weak at its own rate', async t => {
    const clock = new FakeClock();
    const { socket, session } = await fakeReady(t, { clock });
    socket.trackBuffer = true;
    const connection = () => (session.diagnostics?.() as { connection?: { quality: string; uploadKbps?: number } } | undefined)?.connection;
    for (let index = 0; index < 300; index += 1) {
      socket.drain(797); // 39.9 KB/s accepted against the 66.4 KB/s capture: about 40% discarded
      session.sendAudio({ pcm: pcm16(320), dataClass: 'ordinary' });
      clock.advance(20);
    }
    assert.equal(connection()?.quality, 'weak', 'two fifths of the capture did not reach the wire');
    const measured = Number(connection()?.uploadKbps);
    assert.ok(measured >= 290 && measured <= 350, `about 319 kbit/s of drain, got ${measured}`);
  });

  // W3-R2(a): the trigger's lower side, a link that keeps up but loses one frame in seven to a short
  // reconnect, is not weak: the caption must not cry wolf on a healthy call.
  test('a link that loses a seventh of the capture to a short reconnect stays ok', async t => {
    const clock = new FakeClock();
    const { socket, session } = await fakeReady(t, { clock });
    socket.trackBuffer = true;
    const connection = () => (session.diagnostics?.() as { connection?: { quality: string; uploadKbps?: number } } | undefined)?.connection;
    for (let index = 0; index < 300; index += 1) {
      socket.drain(20_000); // the link keeps up: the socket buffer stays far below the cap
      socket.readyState = index % 20 < 3 ? 2 : 1; // three frames in twenty land while the socket is reconnecting
      session.sendAudio({ pcm: pcm16(320), dataClass: 'ordinary' });
      clock.advance(20);
    }
    assert.equal(connection()?.quality, 'ok', 'a seventh of the capture lost is under the weak share');
  });

  // W3 requirement 1: the wire carries runs of consecutive frames, never 20 ms islands, and the receipt says
  // how many runs went and how fast the socket was draining.
  test('a slow uplink sheds whole runs of the oldest frames and reports the run count and the drain', async t => {
    const receipts = hostReceipts(t);
    const clock = new FakeClock();
    const { socket, session } = await fakeReady(t, { clock });
    socket.trackBuffer = true;
    // Every frame carries its own level, so the delivered audio itself says which frames arrived and which gap
    // a shed left between them.
    const level = (index: number) => 500 + 50 * index;
    for (let index = 0; index < 500; index += 1) {
      socket.drain(400);
      session.sendAudio({ pcm: pcm16(320, level(index)), dataClass: 'ordinary' });
      clock.advance(20);
    }
    const arrived: number[] = [];
    for (const frame of socket.sent) {
      const parsed = JSON.parse(frame) as { type?: string; audio?: string };
      if (parsed.type !== 'session.input_audio.append' || !parsed.audio) continue;
      const pcm = Buffer.from(parsed.audio, 'base64');
      let peak = 0;
      for (let at = 0; at + 1 < pcm.byteLength; at += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(at)));
      arrived.push(Math.round((peak - 500) / 50));
    }
    const runs: number[] = [];
    let run = 0;
    for (let at = 0; at < arrived.length; at += 1) {
      if (at > 0 && arrived[at] === arrived[at - 1]! + 1) run += 1;
      else { if (run) runs.push(run); run = 1; }
    }
    if (run) runs.push(run);
    // The last run is cut off by the end of the capture, not by a shed: only the runs a shed closed are judged.
    const closed = runs.slice(0, -1);
    assert.ok(closed.length >= 4, `the session went out in consecutive runs, got ${closed.length}`);
    // Release 3: the newest 500 ms (25 frames) of speech is never shed, so here a shed can clear at most 13 of the
    // 38 frames the cap allows and the run between two sheds is shorter than the ten frames release 3o asked for.
    // The islands that rule was written against are still gone, and the tail of a sentence now always survives.
    assert.ok(Math.min(...closed) >= 2, `no delivered run is a 20 ms island, shortest ${Math.min(...closed)} of ${closed.join(',')}`);
    const shed = receipts().filter(record => record.event === 'uplink_shed');
    assert.equal(shed.length, 1, 'the shed receipt is bounded to one per window');
    assert.ok(Number(shed[0]!.shedRuns) >= 1, 'the receipt counts shed runs, not shed frames');
    assert.ok(Number(shed[0]!.bytes) >= Number(shed[0]!.shedRuns) * 1_280, 'and each run is whole frames, not thin ones');
    const drain = Number(shed[0]!.drainBytesPerSec);
    assert.ok(drain >= 15_000 && drain <= 25_000, `about 20 KB/s accepted, got ${drain}`);
    assert.ok(safeEvent(shed[0]), 'the host log whitelist accepts the widened shed receipt');
  });

  // W3 requirement 2: a frame lost because the socket is not open is counted too, in its own field.
  test('frames discarded while the socket is not open are counted apart from queue-overflow sheds', async t => {
    for (const state of [2, 3]) {
      const receipts = hostReceipts(t);
      const { socket, session } = await fakeReady(t);
      socket.readyState = state; // CONNECTING (2) or CLOSED (3): the frame never reaches the wire
      for (let index = 0; index < 3; index += 1) session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      const shed = receipts().filter(record => record.event === 'uplink_shed');
      assert.equal(shed.length, 1, 'lost frames are a receipt');
      assert.equal(Number(shed[0]!.bytes), 0, 'nothing was shed from a queue overflow');
      assert.ok(Number(shed[0]!.notOpenBytes) >= 1_280, `a whole lost frame is counted, got ${shed[0]!.notOpenBytes}`);
      assert.ok(safeEvent(shed[0]), 'the host log whitelist accepts the not-open count');
    }
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

  test('pending mic writes with no completed upload progress eventually use the recoverable stall path', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const receipts = hostReceipts(t);
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    socket.completeWrites = false;
    session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 20 && !captured.events.some(event => event.type === 'outcome'); step += 1) {
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(2_000);
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const outcome = captured.events.find(event => event.type === 'outcome');
    assert.ok(outcome && outcome.type === 'outcome', 'forty seconds without a completed mic write ends the transport');
    if (outcome.type !== 'outcome') return;
    assert.equal(outcome.outcome.code, 'transport_error');
    assert.equal(outcome.outcome.recoverable, true, 'the existing recovery path still owns the rebuild');
    assert.equal(outcome.outcome.upstream?.errorKind, 'stalled');
    const stall = receipts().filter(record => record.event === 'live_stall');
    assert.equal(stall.length, 1, 'one stall receipt');
    assert.ok(Number(stall[0]!.noProgressMs) >= 30_000, 'the receipt names the bounded local no-progress window');
    socket.completePendingWrites();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(captured.events.filter(event => event.type === 'outcome').length, 1, 'a callback after teardown creates no second terminal');
    assert.equal(receipts().filter(record => record.event === 'live_stall').length, 1, 'and no second stall receipt');
  });

  test('a full upload queue before a mic write cannot shed forever without an outbound callback', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 20 && !captured.events.some(event => event.type === 'outcome'); step += 1) {
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(2_000);
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captured.events.some(event => event.type === 'outcome'), true, 'blocked demand is bounded even when no send callback exists yet');
  });

  test('a queue that drains before thirty seconds starts a fresh blocked episode', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 5; step += 1) {
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(5_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    socket.bufferedAmount = 0;
    session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 4; step += 1) {
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(5_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captured.events.some(event => event.type === 'outcome'), false, 'the drained queue cleared the first episode instead of carrying its age forward');
    session.close();
  });

  test('a completed local write never refreshes the deadline while the socket stays high (#475)', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const receipts = hostReceipts(t);
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    socket.completeWrites = false;
    session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 5; step += 1) {
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(5_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    socket.completePendingWrites();
    for (let step = 0; step < 4 && !captured.events.some(event => event.type === 'outcome'); step += 1) {
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(5_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    // A local send callback says the kernel took the bytes, never that the provider did: with the demand
    // still blocked at the high-water mark the bounded window elapses and the recoverable stall fires.
    const stall = receipts().filter(record => record.event === 'live_stall');
    assert.equal(stall.length, 1, 'the blocked demand stalls even though every local write completed');
    assert.ok(Number(stall[0]!.noProgressMs) >= 30_000, 'and the receipt names the bounded no-progress window');
    session.close();
  });

  test('#475: a slow drain that never leaves the blocked band still reaches the stall window', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const receipts = hostReceipts(t);
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    // The measured shape: the socket accepts every write and drains a kilobyte every two seconds against a
    // demand of megabytes, so the buffer falls but never leaves the blocked band.
    let buffered = 400 * 1024;
    for (let step = 0; step < 20 && !captured.events.some(event => event.type === 'outcome'); step += 1) {
      buffered -= 1024;
      socket.bufferedAmount = buffered;
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(2_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const stall = receipts().filter(record => record.event === 'live_stall');
    assert.equal(stall.length, 1, 'a slow drain is a stall, not progress');
    assert.ok(Number(stall[0]!.noProgressMs) >= 30_000, 'the window is the bounded no-progress one');
    assert.equal(captured.events.filter(event => event.type === 'outcome').length, 1, 'and the session ends once');
  });

  test('buffer oscillation above the prior low cannot refresh upload progress forever', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    for (let step = 0; step < 20 && !captured.events.some(event => event.type === 'outcome'); step += 1) {
      socket.bufferedAmount = step % 2 === 0 ? 400 * 1024 : 390 * 1024;
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(2_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captured.events.some(event => event.type === 'outcome'), true, 'only a new episode low is progress');
  });

  test('a blocked mic demand after a long idle receives its own full budget', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    for (let step = 0; step < 8; step += 1) {
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(5_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    socket.bufferedAmount = 400 * 1024;
    for (let step = 0; step < 4; step += 1) {
      session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      socket.deliver({ type: 'session.keepalive' });
      t.mock.timers.tick(5_000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captured.events.some(event => event.type === 'outcome'), false, 'idle time before blocked demand is not charged to the upload budget');
    session.close();
  });

  test('a real local websocket with paused upload and continuing inbound frames takes the bounded recovery path', { timeout: 10_000 }, async t => {
    const receipts = hostReceipts(t);
    const opened = await ready(t, { limits: { handshakeMs: 1_000, idleMs: 10_000, sessionMs: 10_000, closeMs: 50, upstreamStallMs: 1_000 } });
    opened.f.corkUpload();
    for (let frame = 0; frame < 5_000 && opened.f.clientBufferedAmount < 64 * 1024; frame += 1) {
      opened.session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
    }
    assert.ok(opened.f.clientBufferedAmount >= 48 * 1024, 'the actual ws client reached the adapter high-water mark');
    const drive = setInterval(() => {
      try {
        opened.f.send({ type: 'session.keepalive' });
        opened.session.sendAudio({ pcm: pcm16(480), dataClass: 'ordinary' });
      } catch {}
    }, 100);
    try {
      const outcome = await opened.session.done;
      await opened.captured.done;
      assert.equal(outcome.code, 'transport_error');
      assert.equal(outcome.recoverable, true);
      assert.equal(outcome.upstream?.errorKind, 'stalled');
      const stall = receipts().filter(record => record.event === 'live_stall');
      assert.equal(stall.length, 1);
      assert.ok(Number(stall[0]!.noProgressMs) >= 1_000, 'the test override bounds the real local socket wait');
    } finally {
      clearInterval(drive);
    }
  });

  test('pongs go missing while provider frames keep arriving: the session is not dropped', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const receipts = hostReceipts(t);
    const { socket, session, captured } = await fakeReady(t, { limits: { handshakeMs: 1_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 50 } });
    // 3o: the peer answered no ping for the whole call while the provider never stopped sending, which is
    // inbound traffic and not a dead transport.
    socket.answersPings = false;
    for (let window = 0; window < 3; window += 1) {
      t.mock.timers.tick(5_000);
      socket.deliver({ type: 'session.usage.updated' });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(socket.pings, 3, 'a ping every five seconds');
    assert.equal(captured.events.some(event => event.type === 'outcome'), false, 'inbound frames are a live transport');
    assert.equal(receipts().filter(record => record.event === 'live_upstream_drop').length, 0, 'and no drop receipt');
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

describe('openai gpt-live receipts', () => {





});




test('#606 owner finalization is independent of queued or held playback and exactly once', async t => {
  for (const samples of [2_400, 36_000]) {
    const clock = new FakeClock();
    const opened = await ready(t, { clock });
    sendAudio(opened.f, samples);
    await quiet();
    opened.f.send({ type: 'session.input_transcript.delta', delta: 'Naya stop listening' });
    await quiet();
    clock.advance(700);
    await quiet();
    const finals = () => opened.captured.events.filter(event => event.type === 'inputTranscription' && event.finished === true);
    assert.equal(finals().length, 1, 'the owner is final within 700 ms even during playback');
    clock.advance(3_000);
    await quiet();
    assert.equal(finals().length, 1, 'the deferred think transition never repeats the final');
  }
});

test('R4 GPT close purges held audio and closes the socket without a cancel command or acknowledgement', async t => {
  const clock = new FakeClock();
  const opened = await fakeReady(t, { clock });
  opened.socket.deliver(delegated('response.created', { response: { id: 'synthetic-stop-response' } }));
  opened.socket.deliver({ type: 'session.output_audio.delta', delta: b64(pcm16(2_400)) });
  await quiet();
  assert.equal(audioBytes(opened.captured), 0, 'the short audible stretch is still held');
  opened.session.close();
  assert.equal(opened.socket.readyState, 3, 'provider close is synchronous and requires no acknowledgement');
  assert.equal(opened.socket.sent.some(frame => JSON.parse(frame).type === 'response.cancel'), false, 'GPT Live has no cancel command');
  clock.advance(5_000);
  opened.socket.deliver({ type: 'session.output_audio.delta', delta: b64(pcm16(2_400)) });
  await quiet();
  assert.equal(audioBytes(opened.captured), 0, 'held and late audio never plays after close');
  assert.equal((await opened.session.done).status, 'closed');
});

// C-CONTINUITY R-09/R-08: every provider socket close leaves its close code and a sanitized reason on the
// outcome, so the next rebuild or recovery line can say how the session really ended.
test('C-CONTINUITY R-09: a remote close keeps its code and sanitized reason in the outcome', async t => {
  const { socket, session } = await fakeReady(t);
  socket.emit('close', 1011, Buffer.from('provider overload: https://api.openai.com/v1?key=sk-live-secret-token'));
  const outcome = await session.done;
  assert.equal(outcome.code, 'remote_closed');
  assert.equal(outcome.upstream?.closeCode, 1011, 'the socket code is recorded');
  const reason = String(outcome.upstream?.closeReason ?? '');
  assert.match(reason, /provider overload/u, 'the reason is carried');
  assert.ok(!/https?:\/\//u.test(reason), 'no URL reaches the record');
  assert.ok(!reason.includes('sk-live-secret-token'), 'no token reaches the record');
});





test('C-AUDIO10: speech loss sends one repeat-end host note and one receipt per weak episode', async t => {
  const receipts = hostReceipts(t);
  const clock = new FakeClock();
  const { socket, session } = await fakeReady(t, { clock });
  socket.trackBuffer = true;
  for (let index = 0; index < 400; index += 1) {
    session.sendAudio({ pcm: pcm16(320, index % 3 === 0 ? 0 : 1200), dataClass: 'ordinary' });
    clock.advance(20);
  }
  const notes = socket.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === 'response.item.create'
    && JSON.stringify(frame).includes('weak connection'));
  assert.equal(notes.length, 1);
  assert.match(JSON.stringify(notes[0]), /ask.*repeat.*end/i);
  assert.equal(receipts().filter(row => row.event === 'uplink_speech_shed').length, 1);
  assert.equal(session.diagnostics?.().connection?.quality, 'weak');
});

test('C-AUDIO10: overflowing speech never retains silence heartbeats ahead of speech', async t => {
  const receipts = hostReceipts(t);
  const clock = new FakeClock();
  const { socket, session } = await fakeReady(t, { clock });
  socket.bufferedAmount = 100_000;
  // A queue contains both speech and silence, including the 400 ms silence heartbeat boundary.
  for (let index = 0; index < 200; index += 1) {
    session.sendAudio({ pcm: pcm16(320, index % 2 ? 1200 : 0), dataClass: 'ordinary' });
    clock.advance(20);
  }
  const speechLoss = receipts().filter(row => row.event === 'uplink_speech_shed');
  assert.equal(speechLoss.length, 1);
  assert.equal(speechLoss[0]!.silenceFramesBeforeSpeechShed, 0,
    'at the speech-shed decision every non-speech frame, including heartbeats, is already gone');
  assert.ok(safeEvent(speechLoss[0]!), 'the ordering receipt is a closed counts-only event');
  // End with speech and trigger the next overflow; any surviving silence would be an older heartbeat.
  for (let index = 0; index < 60; index += 1) {
    session.sendAudio({ pcm: pcm16(320, 1200), dataClass: 'ordinary' });
    clock.advance(20);
  }
  const before = micAudio(socket).length;
  socket.drain(1_000_000);
  clock.advance(100);
  session.sendAudio({ pcm: pcm16(320, 1200), dataClass: 'ordinary' });
  const drained = micAudio(socket).slice(before).map(encoded => Buffer.from(encoded, 'base64'));
  assert.ok(drained.length > 0, 'retained speech actually drains onto the wire');
  assert.ok(drained.every(pcm => pcm.readInt16LE(0) !== 0), 'all older silence is gone before speech is discarded');
});

test('direct102 fresh opening demands speech itself, not an acknowledgment of startup directions', () => {
  assert.match(FRESH_OPENING, /Speak one original opening line now/);
  assert.match(FRESH_OPENING, /Do not acknowledge/);
  assert.doesNotMatch(FRESH_OPENING, /Internal startup direction/);
});







test('alarm sessions seed no fresh-opening direction', async t => {
  const f = await fixture(t);
  const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory }))
    .open(request({ system: { text: `Synthetic normal persona\n${ALARM_MODE_MARKER} call the bank`, dataClass: 'ordinary' }, opening: 'model_first' }), control());
  t.after(() => session.close());
  await f.frame(1);
  const start = f.frames[0] as unknown as Start;
  assert.ok(!JSON.stringify(start.session['input'] ?? []).includes(FRESH_OPENING));
  assert.match(JSON.stringify(start.session), /call the bank/);
});



async function continuation(t: TestContext, accepted = true, overrides: Partial<LiveVoiceAdapterOptions> = {}) {
  const clock = new FakeClock();
  const opened = await fakeReady(t, { clock, ...overrides });
  opened.socket.deliver(delegated('response.created', { response: { id: 'synthetic-initial' } }));
  opened.socket.deliver(delegated('response.output_item.done', { item: { type: 'function_call', call_id: 'synthetic-call', name: 'research', arguments: '{}' } }));
  opened.socket.deliver(delegated('response.done', { response: { id: 'synthetic-initial', status: 'completed' } }));
  await quiet();
  opened.session.sendToolResponse({ responses: [{ id: 'synthetic-call', name: 'research', response: { ok: true } }] });
  if (accepted) opened.socket.deliver(delegated('response.created', { response: { id: 'synthetic-continuation' } }));
  await quiet();
  return { ...opened, clock };
}





test('SILENCE c: an output item at 4.5 seconds never satisfies the silent-continuation deadline (#924)', async t => {
  const opened = await continuation(t);
  opened.clock.advance(4_500);
  opened.socket.deliver(delegated('response.output_item.added', { item: { type: 'message', id: 'synthetic-message' } }));
  opened.clock.advance(3_500);
  await quiet();
  assert.equal(silentContinuations(opened).length, 1, 'text the owner cannot hear is not an answer, so the open response is reported silent once');
});
test('SILENCE c: an audible frame stands the silent-continuation deadline down', async t => {
  const opened = await continuation(t);
  opened.clock.advance(1_000);
  opened.socket.deliver({ type: 'session.output_audio.delta', delta: b64(pcm16(2_400)) });
  opened.clock.advance(5_000);
  await quiet();
  assert.equal(silentContinuations(opened).length, 0, 'the response is answering, so nothing is stuck');
});

test('SILENCE #924/#802: the silent-continuation window is 1.5 seconds, not the old dead-air rung', async t => {
  const opened = await continuation(t);
  opened.clock.advance(1_400);
  await quiet();
  assert.equal(silentContinuations(opened).length, 0, '1.4 s of open silence is still inside the window');
  opened.clock.advance(100);
  await quiet();
  assert.equal(silentContinuations(opened).length, 1, 'the report lands at 1.5 s, not at the 7 s or 8 s wait Rob hears');
});






















// F4: on 10-30 a silent completed continuation set the answer-now lock, and the corrected retry after an
// invalid_arguments refusal was refused as `research_cap_reached`. The rescue asks for speech only; the cap is
// research's own and keeps its code.


// C-DELIVERY: episode quiet has no lexical exceptions. Helper quiet belongs to the host.
test('input episode finalization uses the same quiet for fragments and sentences', async t => {
  for (const words of ['Synthetic words with', 'Synthetic sentence.']) {
    const clock = new FakeClock(); const opened = await fakeReady(t, { clock });
    opened.socket.deliver({ type: 'session.input_transcript.delta', delta: words });
    const starts = () => opened.captured.events.filter(event => event.type === 'modelTurnStarted').length;
    clock.advance(699); await quiet(); assert.equal(starts(), 0);
    clock.advance(1); await quiet(); assert.equal(starts(), 1);
  }
});

// C-POSTTOOL fallback (#868): generic speech is not proof of an answer for a tool batch. The first audible
// frame of the active response clears an owed continuation. The replay is event ordered, because the guard is
// about the order of audio and terminal events within one response.







// C-POSTTOOL 2: switch a. The wire fixture records the provider refusing any create field beyond type and
// event_id (10.5.1, unknown_parameter param=response), so the audio request rides on the delegation's response
// settings at session start, and the create stays exactly as the fixture pins it.




// C-POSTTOOL 3: switch b. The tighter brevity line changes the delegated instructions and nothing else.


test('client delegation starts without session tools or Responses configuration', async t => {
  const f = await fakeReady(t);
  const start = f.socket.sent.map(frame => JSON.parse(frame as string) as Record<string, any>).find(frame => frame.type === 'session.start');
  assert.deepEqual(start?.session.delegation, { type: 'client' });
  assert.equal(start?.session.tools, undefined);
});

test('task commentary without a delegation sends null and receives a provider acknowledgement', async t => {
  const f = await fakeReady(t);
  assert.equal(f.session.sendTaskAnswer?.({ text: 'Synthetic answer.', delegationId: 'missing' }), undefined);
  const command = f.session.sendTaskAnswer?.({ text: 'Synthetic answer.', delegationId: null });
  assert.equal(typeof command, 'string');
  const frame = JSON.parse(f.socket.sent.at(-1)!);
  assert.equal(frame.type, 'session.commentary.append'); assert.equal(frame.delegation_id, null);
  f.socket.deliver({ type: 'session.commentary.appended', client_event_id: command }); await quiet();
  assert.ok(f.captured.events.some(event => event.type === 'commentaryAccepted' && event.commandId === command));
});

test('client delegation carries task answers on its latest id with separate acknowledgments', async t => {
  const f = await fakeReady(t);
  assert.equal(f.session.sendTaskAnswer?.({ text: 'Synthetic answer.', delegationId: 'missing' }), undefined);
  f.socket.deliver({ type: 'session.delegation.created', delegation: { id: 'd1' } });
  f.socket.deliver({ type: 'session.delegation.created', delegation: { id: 'd2' } });
  assert.equal(f.session.sendTaskAnswer?.({ text: 'Old answer.', delegationId: 'd1' }), undefined);
  const command = f.session.sendTaskAnswer?.({ text: 'Synthetic answer.', delegationId: 'd2' });
  assert.equal(typeof command, 'string');
  const frame = JSON.parse(f.socket.sent.at(-1)! as string);
  assert.deepEqual(frame, { type: 'session.commentary.append', event_id: command, delegation_id: 'd2', content: 'Synthetic answer.' });
  f.socket.deliver({ type: 'session.commentary.appended', client_event_id: command });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(f.captured.events.some(event => event.type === 'commentaryAccepted' && event.commandId === command));
  const rejected = f.session.sendTaskAnswer?.({ text: 'Another answer.', delegationId: 'd2' });
  f.socket.deliver({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_delegation', client_event_id: rejected } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(f.captured.events.some(event => event.type === 'commentaryRejected' && event.commandId === rejected));
  assert.equal(f.socket.sent.some(sent => JSON.parse(sent as string).type === 'response.create'), false);
});

test('FR1-R1: general session commentary keeps a null delegation id while a delegation is current', async t => {
  const f = await fakeReady(t);
  f.socket.deliver({ type: 'session.delegation.created', delegation: { id: 'd-current' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.session.sendTaskAnswer?.({ text: 'Synthetic answer.', delegationId: null }), undefined,
    'the task answer still refuses a null id once a delegation exists');
  const command = f.session.sendSessionCommentary?.({ text: 'Synthetic local recall.' });
  assert.equal(typeof command, 'string');
  assert.deepEqual(JSON.parse(f.socket.sent.at(-1)! as string),
    { type: 'session.commentary.append', event_id: command, delegation_id: null, content: 'Synthetic local recall.' });
  assert.equal(f.session.sendSessionCommentary?.({ text: '' }), undefined, 'an empty line is never written');
  assert.equal(f.session.sendSessionCommentary?.({ text: 'x'.repeat(451) }), undefined, 'an item over 450 characters is never written');
  f.socket.deliver({ type: 'session.commentary.appended', client_event_id: command });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(f.captured.events.some(event => event.type === 'commentaryAccepted' && event.commandId === command));
});

for (const rejected of [false, true]) {
  test(`client commentary acknowledgement preserves command identity; rejected=${rejected}`, async t => {
    const receipts = hostReceipts(t);
    const { socket, session, captured } = await fakeReady(t);
    socket.deliver({ type: 'session.delegation.created', delegation: { id: 'synthetic-binding' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(session.sendTaskAnswer!({ delegationId: 'stale-binding', text: 'Do not say this.' }), undefined);
    const text = 'The synthetic exact answer is 17.';
    const commandId = session.sendTaskAnswer!({ delegationId: 'synthetic-binding', text });
    assert.equal(typeof commandId, 'string');
    if (rejected) socket.deliver({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', param: 'content', client_event_id: commandId } });
    else socket.deliver({ type: 'session.commentary.appended', client_event_id: commandId });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(captured.events.some(event => event.type === (rejected ? 'commentaryRejected' : 'commentaryAccepted') && 'commandId' in event && event.commandId === commandId), true);
    if (rejected) {
      assert.equal(receipts().some(event => event.event === 'command_rejected' && event.kind === 'cmt'), true);
      assert.equal(JSON.stringify(receipts()).includes(text), false, 'command rejection logs metadata, never answer content');
    }
    assert.equal(socket.sent.map(frame => JSON.parse(frame)).some(frame => frame.type === 'response.create' || frame.type === 'response.item.create'), false);
  });
}

for (const opening of ['model_first', 'user_first'] as const) {
  test(`audio input does not create text items after readiness; opening=${opening}`, async t => {
    const { f, session } = await ready(t, {}, { opening });
    session.sendAudio({ pcm: pcm16(), dataClass: 'ordinary' });
    await quiet();
    const frames = f.frames.map(frame => frame as Record<string, unknown>);
    assert.equal(frames.some(frame => frame.type === 'session.input_audio.append'), true);
    assert.equal(frames.some(frame => frame.type === 'response.create' || frame.type === 'response.item.create'), false);
  });
}


test('typed owner text sends a user input item then response.create on a ready session', async t => {
  const opened = await fakeReady(t);
  const before = opened.socket.sent.length;
  opened.session.sendText({ text: 'Synthetic typed owner request' });
  const frames = opened.socket.sent.slice(before).map(frame => JSON.parse(frame));
  assert.deepEqual(frames.map(frame => frame.type), ['response.item.create', 'response.create']);
  assert.deepEqual(frames[0].item, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic typed owner request' }] });
  await tick();
  assert.ok(opened.captured.events.some(event => event.type === 'inputTranscription' && event.text === 'Synthetic typed owner request' && event.finished === true && event.finalOrigin === 'typed'));
});

test('typed owner text is refused before provider readiness without sending items', async t => {
  const f = await fixture(t);
  const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  t.after(() => session.close());
  await f.frame(1);
  assert.throws(() => session.sendText({ text: 'Synthetic typed owner request' }), error => (error as { code?: string }).code === 'not_ready');
  assert.equal(f.frames.length, 1);
});
