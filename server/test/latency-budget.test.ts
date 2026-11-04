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
import { createMongooseReader } from '../dist/connectors/mongoose.js';
import { safeEvent } from '../dist/host/log.js';
import { attachHostLogSink } from '../dist/tools/host-events.js';
import { FakeClock, fakeReady, pcm16 } from '../dist/test/openai-live-voice-fixture.js';

type Segment = 'speechEndToCreateMs' | 'createToFirstAudioMs' | 'toolOutputToCreateMs' | 'providerOutputAckMs' | 'connectorRequestMs' | 'deadAirRungMs';
const budgets = JSON.parse(readFileSync(join(process.cwd(), '..', 'config', 'latency-budgets.json'), 'utf8')) as
  { segments: Record<Segment, { budgetMs: number; measuredP50Ms: number; basis: string }> };

/** The deliberately slowed fake: the same replay, every recorded delay multiplied, so the gate must breach. */
const SLOW = process.env['LATENCY_BUDGET_SLOW'] === '1';
const fake = (ms: number): number => (SLOW ? ms * 8 : ms);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
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
    // Printed as it is judged, never after: a breaching segment must name itself in the output even though the
    // assertion that follows it ends the test.
    process.stdout.write(`${name}=${value} budget=${budget.budgetMs} ${breach ? 'BREACH' : 'ok'}\n`);
    out.push(`${name}=${value} budget=${budget.budgetMs} ${breach ? 'BREACH' : 'ok'}`);
    assert.equal(breach, false, `${name} ${value} ms breaches the ${budget.budgetMs} ms budget (p50 ${budget.measuredP50Ms})`);
  }
  return out;
}

test('LAT-1022: a plain turn, a one-tool turn, a two-tool batch and a silent continuation stay inside their budgets', async t => {
  const clock = new FakeClock();
  const { lines, detach } = hostLines(); t.after(detach);
  const opened = await fakeReady(t, { clock });
  const segments: Record<string, number> = {};
  // GPT-Live now delegates on the client wire. There is no response.create or
  // response.event envelope: a completed task is session.commentary.append.
  opened.session.sendAudio({ pcm: pcm16(2_400), sampleRateHz: 24_000 });
  opened.socket.deliver({ type: 'session.input_transcript.delta', delta: 'Synthetic plain turn.' });
  clock.advance(700);
  await until(() => lines.some(line => line.event === 'owner_speech_end'));
  const ended = counted(lines.find(line => line.event === 'owner_speech_end')?.monoMs); assert.ok(ended !== undefined);
  clock.advance(fake(1_200));
  opened.socket.deliver({ type: 'session.delegation.created', delegation: { id: 'synthetic-plain' } });
  await until(() => opened.captured.events.some(event => event.type === 'delegation'));
  const plainCommand = opened.session.sendTaskAnswer({ text: 'Synthetic plain answer.', delegationId: 'synthetic-plain' }); assert.ok(plainCommand);
  const plainCreated = clock.now();
  const frame = JSON.parse(opened.socket.sent.at(-1)!);
  assert.equal(frame.type, 'session.commentary.append'); assert.equal(frame.delegation_id, 'synthetic-plain');
  segments.speechEndToCreateMs = plainCreated - ended;
  clock.advance(fake(500));
  const audioBefore = opened.captured.events.filter(event => event.type === 'audio').length;
  opened.socket.deliver({ type: 'session.output_audio.delta', delta: b64(pcm16(2_400)) });
  clock.advance(400);
  await until(() => opened.captured.events.filter(event => event.type === 'audio').length > audioBefore);
  segments.createToFirstAudioMs = clock.now() - plainCreated;

  for (const [index, text] of ['Synthetic one-tool result.', 'Synthetic two-tool batch result.'].entries()) {
    const delegationId = `synthetic-tools-${index}`;
    opened.socket.deliver({ type: 'session.delegation.created', delegation: { id: delegationId } });
    await until(() => opened.captured.events.some(event => event.type === 'delegation' && event.delegationId === delegationId));
    // Task tools execute below delegation. This is the instant their synthetic
    // result becomes available, not a retired provider function_call_output.
    clock.advance(fake(120)); const resultAt = clock.now();
    clock.advance(fake(180));
    const command = opened.session.sendTaskAnswer({ text, delegationId }); assert.ok(command);
    const sentAt = clock.now();
    segments.toolOutputToCreateMs = Math.max(segments.toolOutputToCreateMs ?? 0, sentAt - resultAt);
    const acks = opened.captured.events.filter(event => event.type === 'commentaryAccepted').length;
    clock.advance(fake(350));
    opened.socket.deliver({ type: 'session.commentary.appended', client_event_id: command });
    await until(() => opened.captured.events.filter(event => event.type === 'commentaryAccepted').length > acks);
    segments.providerOutputAckMs = Math.max(segments.providerOutputAckMs ?? 0, clock.now() - sentAt);
    assert.ok(lines.some(line => line.event === 'gptlive_append_ack'));
  }
  // The silent continuation is a completed task answer with no provider audio.
  const silenceAt = clock.now(); clock.advance(fake(2_000));
  segments.deadAirRungMs = clock.now() - silenceAt;
  judge(segments);
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
  const digest = 'synthetic-digest';
  // The grant the reader preflights: a read grant for the one tool this endpoint serves, on this generation.
  const registry = {
    endpoint: () => ({ id: 'mongoose-knowledge' }),
    currentGrant: () => ({ schemaDigest: digest, generation: 1, effect: 'read', toolNames: ['search'] }),
    visibleTools: () => [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }],
  };
  const reader = createMongooseReader({ port: port as never, registry: registry as never,
    config: { endpointId: 'mongoose-knowledge', endpoint: 'knowledge', account: 'synthetic', resource: 'synthetic', schemaDigest: digest,
      generation: 1, maxSearchLimit: 5, maxListLimit: 10, queryChars: 100 } as never, now: () => clock.now() });
  const before = clock.now();
  const result = await reader.call('search', { query: 'synthetic' });
  // The fake connector's own recorded delay: the segment must be exactly what the request took, never a guess.
  const recorded = clock.now() - before;
  const request = lines.find(line => line['event'] === 'connector_request');
  assert.ok(request !== undefined, `the connector request reached the host log (state ${String(result.state)})`);
  assert.equal(request['connector'], 'mongoose-knowledge', 'and it names the connector');
  assert.equal(request['stage'], 'call', 'and the stage it ended in');
  assert.equal(request['outcome'], 'ok', 'and the call\'s own closed state');
  const ms = counted(request['ms']);
  assert.ok(ms !== undefined, 'and a duration, never a null');
  assert.equal(ms, recorded, 'the segment is the request\'s own duration');
  judge({ connectorRequestMs: recorded });
});

// LAT-1022 (L-R2 F1): the meter names the stage the request ENDED in, not a constant. A request that dies before
// the connector answered reports the connect stage its closed failure token names, so a slow or dead connector is
// attributable to spawn, handshake or the first call instead of hiding behind one word.
test('LAT-1022: a connector request that dies in the connect phase names that stage', async t => {
  const clock = new FakeClock();
  const { lines, detach } = hostLines();
  t.after(detach);
  const digest = 'synthetic-digest';
  const registry = {
    endpoint: () => ({ id: 'mongoose-knowledge' }),
    currentGrant: () => ({ schemaDigest: digest, generation: 1, effect: 'read', toolNames: ['search'] }),
    visibleTools: () => [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }],
  };
  const readerFor = (reason: string) => createMongooseReader({
    port: {
      visibleTools: () => [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }],
      call: async () => ({ state: 'unknown', reason }),
    } as never,
    registry: registry as never,
    config: { endpointId: 'mongoose-knowledge', endpoint: 'knowledge', account: 'synthetic', resource: 'synthetic', schemaDigest: digest,
      generation: 1, maxSearchLimit: 5, maxListLimit: 10, queryChars: 100 } as never,
    now: () => clock.now(),
  });
  const stageOf = async (reason: string): Promise<unknown> => {
    lines.length = 0;
    await readerFor(reason).call('search', { query: 'synthetic' });
    return lines.find(line => line['event'] === 'connector_request')?.['stage'];
  };
  assert.equal(await stageOf('pipe_closed'), 'spawn', 'a closed pipe is the spawn stage');
  assert.equal(await stageOf('child_exited'), 'spawn', 'a dead child is the spawn stage');
  assert.equal(await stageOf('connect_timeout'), 'handshake', 'a connect timeout is the handshake stage');
  assert.equal(await stageOf('original-schema-arguments-refused'), 'first_call', 'a local refusal is the first call');
});
