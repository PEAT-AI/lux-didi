// LAT-1022: the latency budget eval. It replays four shapes (a plain turn, a one-tool turn, a two-tool batch and a
// silent continuation) through the REAL host path, with a fake realtime transport and a fake connector carrying
// recorded synthetic timings, and asserts the host-side segments against config/latency-budgets.json. No network,
// no model, no clock: the fake clock makes every segment exactly the delay the fake was given, so the run proves
// the instrumentation reports the segments it claims and the budget gate fails a slow path.
//
// `LATENCY_BUDGET_SLOW=1` slows every fake by eight, and the eval then requires a breach: a gate that cannot fail
// proves nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMongooseReader } from '../connectors/mongoose.js';
import { safeEvent } from '../host/log.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { FakeClock, fakeReady, pcm16 } from './openai-live-voice-fixture.js';

type Segment = 'speechEndToCreateMs' | 'createToFirstAudioMs' | 'toolOutputToCreateMs' | 'providerOutputAckMs' | 'connectorRequestMs' | 'deadAirRungMs';
const budgets = JSON.parse(readFileSync(join(process.cwd(), '..', 'config', 'latency-budgets.json'), 'utf8')) as
  { segments: Record<Segment, { budgetMs: number; measuredP50Ms: number; basis: string }> };

/** The deliberately slowed fake: the same replay, every recorded delay multiplied, so the gate must breach. */
const SLOW = process.env['LATENCY_BUDGET_SLOW'] === '1';
const fake = (ms: number): number => (SLOW ? ms * 8 : ms);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const delegated = (type: string, event: Record<string, unknown>, id = 'item_1'): Record<string, unknown> => ({ type: 'response.event', delegation_id: id, event: { type, ...event } });

/** One scenario's host log: the shaped lines the run wrote, and the segments they carry. */
function hostLines(): { lines: Record<string, unknown>[]; detach: () => void } {
  const lines: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: (raw: unknown) => { const shaped = safeEvent(raw); if (shaped !== undefined) lines.push(shaped); } });
  return { lines, detach };
}

/** One turn of the event loop: the fake socket delivers synchronously, the adapter handles it a microtask later. */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await tick();
  assert.ok(predicate(), 'the frame the replay sent reached the adapter');
}

const counted = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** Every segment the run reported, printed and compared: a breach fails, a pass prints the number and its budget. */
function judge(segments: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(segments)) {
    const budget = budgets.segments[name as Segment];
    assert.ok(budget !== undefined, `${name} has a budget`);
    const breach = value > budget.budgetMs;
    out.push(`${name}=${value} budget=${budget.budgetMs} ${breach ? 'BREACH' : 'ok'}`);
    assert.equal(breach, false, `${name} ${value} ms breaches the ${budget.budgetMs} ms budget (p50 ${budget.measuredP50Ms})`);
  }
  return out;
}

test('LAT-1022: a plain turn, a one-tool turn, a two-tool batch and a silent continuation stay inside their budgets', async t => {
  const clock = new FakeClock();
  const opened = await fakeReady(t, { clock });
  const { lines, detach } = hostLines();
  t.after(detach);
  const toolCall = (id: string): Record<string, unknown> => delegated('response.output_item.done', { item: { type: 'function_call', call_id: id, name: 'research', arguments: '{"q":"synthetic"}' } });

  // A plain turn: the owner speaks, the capture path's quiet rule declares the end of speech, the provider answers.
  opened.socket.deliver({ type: 'session.input_transcript.delta', delta: 'synthetic question' });
  clock.advance(700);
  opened.socket.deliver(delegated('response.created', { response: { id: 'resp_1' } }));
  clock.advance(fake(1_200));
  const afterCreate = clock.now();
  opened.socket.deliver({ type: 'session.output_audio.delta', delta: b64(pcm16(2_400)) });
  clock.advance(fake(400));
  opened.socket.deliver(delegated('response.done', { response: { id: 'resp_1' } }));

  // A one-tool turn: the call is announced, the host answers it, and the provider opens the continuation.
  opened.socket.deliver(delegated('response.created', { response: { id: 'resp_2' } }));
  opened.socket.deliver(toolCall('call_1'));
  opened.socket.deliver(delegated('response.done', { response: { id: 'resp_2' } }));
  clock.advance(fake(120));
  const writtenAt = clock.now();
  opened.session.sendToolResponse({ responses: [{ id: 'call_1', name: 'research', response: { ok: true } }] });
  opened.socket.deliver(delegated('response.created', { response: { id: 'resp_3' } }));

  // A two-tool batch: one continuation answers both.
  opened.socket.deliver(delegated('response.created', { response: { id: 'resp_4' } }));
  opened.socket.deliver(toolCall('call_2'));
  opened.socket.deliver(toolCall('call_3'));
  opened.socket.deliver(delegated('response.done', { response: { id: 'resp_4' } }));
  clock.advance(fake(60));
  opened.session.sendToolResponse({ responses: [{ id: 'call_2', name: 'research', response: { ok: true } }, { id: 'call_3', name: 'research', response: { ok: true } }] });
  opened.socket.deliver(delegated('response.created', { response: { id: 'resp_5' } }));

  // A silent continuation: the provider opens a response and never sends audio; the host's rung is the bound.
  opened.socket.deliver(delegated('response.created', { response: { id: 'resp_6' } }));
  clock.advance(fake(2_000));
  opened.socket.deliver(delegated('response.done', { response: { id: 'resp_6' } }));
  await until(() => lines.some(line => line['event'] === 'provider_output_ack'));

  const names = lines.map(line => line['event']);
  for (const name of ['owner_speech_end', 'response_first_audio', 'provider_output_ack']) assert.ok(names.includes(name), `${name} reached the host log`);

  const speechEnd = lines.find(line => line['event'] === 'owner_speech_end');
  const firstAudio = lines.find(line => line['event'] === 'response_first_audio' && line['kind'] === 'first');
  assert.ok(speechEnd !== undefined && firstAudio !== undefined, 'the plain turn wrote its end of speech and its first audio');
  const speechEndMono = counted(speechEnd['monoMs']);
  const createdAt = counted(firstAudio['createdAt']);
  const firstAudioAt = counted(firstAudio['firstAudioAt']);
  assert.ok(speechEndMono !== undefined && createdAt !== undefined && firstAudioAt !== undefined, 'the plain turn carries instants, never nulls');
  assert.ok(createdAt >= afterCreate - fake(1_200), 'the create is the instant the adapter asked, not an invented one');

  const continuation = lines.find(line => line['event'] === 'response_first_audio' && line['kind'] === 'continuation');
  assert.ok(continuation !== undefined, 'the continuation wrote its own first-audio line');
  const continuationCreatedAt = counted(continuation['createdAt']);
  assert.ok(continuationCreatedAt !== undefined, 'the continuation names its create instant');

  const acks = lines.filter(line => line['event'] === 'provider_output_ack').map(line => counted(line['ms']));
  assert.equal(acks.length, 3, 'one acknowledgement per function output, the batch included');
  assert.ok(acks.every(ms => ms !== undefined), 'every acknowledgement is a count');

  const segments: Record<string, number> = {
    speechEndToCreateMs: createdAt - speechEndMono,
    createToFirstAudioMs: firstAudioAt - createdAt,
    toolOutputToCreateMs: continuationCreatedAt - writtenAt,
    providerOutputAckMs: Math.max(...(acks as number[])),
    deadAirRungMs: fake(2_000),
  };
  const printed = judge(segments);
  assert.ok(printed.length === 5, 'every budgeted segment was judged');
  // LAT-1022: the slowed fake is the gate's own proof: the same replay must breach, or the eval proves nothing.
  if (SLOW) assert.fail('a slowed fake must breach a budget, and every segment passed');
});

test('LAT-1022: a connector request reports its own duration through the real mongoose reader', async t => {
  const clock = new FakeClock();
  const { lines, detach } = hostLines();
  t.after(detach);
  // A fake connector: its port answers after the recorded synthetic delay, and the reader is the real one.
  const port = {
    visibleTools: () => [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }],
    call: async () => {
      clock.advance(fake(900));
      return { state: 'completed', tool: 'search', source: { endpointId: 'mongoose-knowledge' }, freshness: { receivedAt: clock.now() },
        coverage: {}, decodedResult: { ok: true }, projection: {}, payload: { ok: true } } as unknown as never;
    },
  };
  const reader = createMongooseReader({ port: port as never, registry: { visibleTools: () => [] } as never,
    config: { endpointId: 'mongoose-knowledge', endpoint: 'knowledge', account: 'synthetic', resource: 'synthetic', schemaDigest: 'synthetic',
      generation: 1, maxSearchLimit: 5, maxListLimit: 10, queryChars: 100 } as never, now: () => clock.now() });
  const result = await reader.call('search', { query: 'synthetic' });
  const request = lines.find(line => line['event'] === 'connector_request');
  assert.ok(request !== undefined, `the connector request reached the host log (state ${String(result.state)})`);
  assert.equal(request['connector'], 'mongoose-knowledge', 'and it names the connector');
  assert.equal(request['stage'], 'call', 'and the stage it ended in');
  assert.equal(request['outcome'], 'ok', 'and the call\'s own closed state');
  const ms = counted(request['ms']);
  assert.ok(ms !== undefined, 'and a duration, never a null');
  judge({ connectorRequestMs: ms });
});
