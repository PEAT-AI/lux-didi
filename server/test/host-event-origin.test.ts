import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/gemini.js';
import { HOST_EVENT_KINDS, hostEventPayload, type HostEvent } from '../adapters/live-voice/types.js';
import { LIVE_DROPPED_LINE_EVENT, LIVE_MUTE_EVENT, LIVE_RECOVERY_EVENT } from '../live/index.js';
import { collect, control, fixture, options, request } from './live-voice-fixture.js';
import { ready } from './openai-live-voice-fixture.js';

/**
 * C-HOSTFACTS BUILD-05: a host event is host data on every provider surface. It never becomes the owner's
 * words, it grants no owner turn, an unknown kind stays metadata, and the stable id survives the wire so a
 * duplicate can be recognised instead of repeated as a new owner statement.
 */

const OPENAI_START = 0;

/** One host event as OpenAI seeds it, read back from the documented session.start items. */
async function openAiSeed(t: Parameters<typeof ready>[0], hostEvent: HostEvent) {
  const { f } = await ready(t, {}, { opening: 'model_first', hostEvent });
  const start = f.frames[OPENAI_START] as unknown as { session: Record<string, { role?: string; content?: { text?: string }[] }[]> };
  return { frame: f.frames[OPENAI_START], input: start.session['input'] ?? [] };
}

test('C-HOSTFACTS the three shipped host events are closed host facts with stable ids', () => {
  for (const event of [LIVE_RECOVERY_EVENT, LIVE_MUTE_EVENT, LIVE_DROPPED_LINE_EVENT]) {
    assert.equal(event.origin, 'host');
    assert.ok((HOST_EVENT_KINDS as readonly string[]).includes(event.kind), `${event.id} names a closed kind`);
    assert.equal(event.id.length > 0, true);
  }
  const ids = [LIVE_RECOVERY_EVENT.id, LIVE_MUTE_EVENT.id, LIVE_DROPPED_LINE_EVENT.id];
  assert.equal(new Set(ids).size, ids.length, 'each event carries its own identity, so a duplicate is detectable');
});

test('C-HOSTFACTS an unknown host event kind travels as metadata and grants nothing', () => {
  const payload = JSON.parse(hostEventPayload({ origin: 'host', kind: 'not_a_closed_kind' as HostEvent['kind'], id: 'synthetic' }));
  assert.deepEqual(payload, { host_event: { origin: 'host', kind: 'unknown', id: 'synthetic' } });
});

test('C-HOSTFACTS the OpenAI seed carries the event on the developer surface, never as owner words', async t => {
  const { frame, input } = await openAiSeed(t, LIVE_RECOVERY_EVENT);
  const seeded = input.at(-1);
  assert.equal(seeded?.role, 'developer', 'the host event rides the developer item');
  assert.equal(seeded?.content?.[0]?.text, hostEventPayload(LIVE_RECOVERY_EVENT));
  // The whole seed contains no user item carrying the event body, so nothing downstream can read it as his.
  const wire = JSON.stringify(frame);
  assert.equal(wire.includes(`"role":"user","content":[{"type":"input_text","text":"${hostEventPayload(LIVE_RECOVERY_EVENT)}`), false,
    'no user item carries the host event body');
  assert.equal(JSON.parse(hostEventPayload(LIVE_RECOVERY_EVENT)).host_event.origin, 'host');
});

test('C-HOSTFACTS the Gemini envelope keeps an explicit application host origin inside the user role', async t => {
  const f = await fixture(t);
  const input = request();
  input.opening = 'model_first';
  input.hostEvent = LIVE_MUTE_EVENT;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(input, control());
  t.after(() => session.close());
  collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await f.frame(2);
  const frame = f.frames[1] as unknown as { clientContent: { turns: { role: string; parts: { text: string }[] }[] } };
  const turn = frame.clientContent.turns.at(-1)!;
  assert.equal(turn.role, 'user', 'this provider requires a user-role envelope');
  // The origin travels inside the payload, so the role is transport, not testimony.
  assert.deepEqual(JSON.parse(turn.parts[0]!.text),
    { host_event: { origin: 'host', kind: 'model_muted', id: 'live-mute-pickup' } });
});

test('C-HOSTFACTS the adapters refuse a host event that is not host origin', async t => {
  const f = await fixture(t);
  const input = request();
  input.opening = 'model_first';
  input.hostEvent = LIVE_RECOVERY_EVENT;
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(input, control());
  t.after(() => session.close());
  collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await f.frame(2);
  assert.throws(() => session.sendHostEvent({ event: { origin: 'owner' as 'host', kind: 'model_muted', id: 'x' } }),
    /invalid_request/u, 'an event claiming another origin is refused, never sent');
});
