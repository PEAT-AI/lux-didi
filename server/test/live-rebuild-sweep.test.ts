import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { analyse, replay, tone } from './voice-replay/driver.js';
import type { Replay } from './voice-replay/driver.js';
import { NO_LOOKUP_RUNNING_NOTE, REBUILD_AUDIO_HOLD_BYTES } from '../live/index.js';

/**
 * #1024 T3, rebuild-at-every-point sweep. Owner order 2026-10-25: the escapes in the audit class "state across
 * reconnect or rebuild" shipped because every rebuild test started at a clean boundary. This sweep starts the
 * rebuild at every boundary of one scripted call instead, over the existing fakes: the real OpenAI adapter and
 * the real live host on the virtual clock, the scripted owner, the scripted tool and the fixture provider.
 *
 * The script is one ordinary turn: the owner talks, asks, a lookup is delegated, the lookup returns, the model
 * speaks the result, the owner asks where it stands, the model answers that. For each boundary of that script the
 * provider session is killed there, the host rebuilds it, the provider answers again in the new session, and the
 * rest of the script runs.
 *
 * Every boundary asserts the same four things:
 *   1. no tool result is lost: a result submitted into a session that then died reaches the session that replaced
 *      it, or was already spoken, and every batch of the live session gets exactly one continuation;
 *   2. no false status claim: the host never tells a session nothing is searching while a result is outstanding;
 *   3. no owner audio is dropped beyond the documented hold: a frame spoken into the rebuild reaches the new
 *      session, and the sweep stays far under REBUILD_AUDIO_HOLD_BYTES;
 *   4. the call either continues or ends with a closed reason, never as a silent stop.
 */

const DEADLINE_MS = 20_000;
const TOOL_LATENCY_MS = 1_500;
const REBUILD_BUDGET_MS = 20_000;
/** One 30 ms capture frame, the host's own unit: far under the three second hold, so nothing may be dropped. */
const OWNER_FRAME_SAMPLES = 480;
const OWNER_FRAMES = 2;
const startOf = (r: Replay): number => r.clock.now() - r.clock.startedAt;
const starts = (r: Replay) => r.providerFrames.filter(frame => frame.type === 'session.start');
const liveEpoch = (r: Replay): number => starts(r).at(-1)?.epoch ?? 0;
const elapsedBy = async (r: Replay, at: number): Promise<void> => { await r.advance(Math.max(0, at - startOf(r))); };
const audible = (samples = 2_400): string => Buffer.from(tone(samples)).toString('base64');

interface Step {
  /** The boundary this step ends at: the rebuild happens after it ran. */
  readonly name: string;
  /** Virtual milliseconds from the start of the call. */
  readonly at: number;
  readonly run: (r: Replay) => Promise<void>;
}

const delegation = (id: string, response: string) => (r: Replay): Promise<void> =>
  r.deliver({ type: 'session.delegation.created', delegation: { id, response_id: response, offset_ms: 0 } });
const announced = (response: string, id: string) => (r: Replay): Promise<void> =>
  r.deliver({ type: 'response.event', delegation_id: id, event: { type: 'response.created', response: { id: response } } });
const completed = (response: string, id: string) => (r: Replay): Promise<void> =>
  r.deliver({ type: 'response.event', delegation_id: id, event: { type: 'response.done', response: { id: response, status: 'completed' } } });
const spoken = (r: Replay): Promise<void> => r.deliver({ type: 'session.output_audio.delta', delta: audible() });
const ownerSays = (delta: string, from: number) => (r: Replay): Promise<void> =>
  r.deliver({ type: 'session.input_transcript.delta', delta, start_ms: from, end_ms: from + 50 });

/** The named steps of the scripted call, in time order. Each one lands on its virtual millisecond. */
const SCRIPT: readonly Step[] = [
  { name: 'the owner opens the microphone', at: 0, run: r => r.speak(OWNER_FRAME_SAMPLES) },
  { name: 'the owner stops speaking', at: 30, run: r => r.endInput() },
  { name: 'the owner question transcribes', at: 950, run: ownerSays('synthetic rebuild question', 900) },
  { name: 'a delegation opens', at: 1_000, run: delegation('d_1', 'resp_1') },
  { name: 'the response is announced', at: 1_010, run: announced('resp_1', 'd_1') },
  {
    name: 'a lookup is delegated', at: 1_200,
    run: r => r.deliver({
      type: 'response.event', delegation_id: 'd_1',
      event: {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'search_knowledge', arguments: JSON.stringify({ query: 'synthetic rebuild sweep', limit: 2 }) },
      },
    }),
  },
  // The scripted tool answers TOOL_LATENCY_MS after its call, so crossing this point is the result landing.
  { name: 'the lookup result returns', at: 1_200 + TOOL_LATENCY_MS + 300, run: async () => {} },
  { name: 'the answer is announced', at: 2_900, run: announced('resp_1b', 'd_1') },
  { name: 'the model speaks the result', at: 3_000, run: spoken },
  { name: 'the answer completes', at: 3_020, run: completed('resp_1b', 'd_1') },
  { name: 'the owner asks where it stands', at: 4_000, run: ownerSays('are you still searching', 3_900) },
  { name: 'a status delegation opens', at: 4_990, run: delegation('d_2', 'resp_2') },
  { name: 'the status answer is announced', at: 5_000, run: announced('resp_2', 'd_2') },
  { name: 'the status answer speaks', at: 5_100, run: spoken },
  { name: 'the status answer completes', at: 5_120, run: completed('resp_2', 'd_2') },
];

/** What the provider does in the session that replaced the killed one, as the replay traces script their recovery. */
const RECOVERY: readonly Step[] = [
  { name: 'the new session delegates', at: 0, run: delegation('d_9', 'resp_9') },
  { name: 'the new session answers', at: 20, run: announced('resp_9', 'd_9') },
  { name: 'the new session speaks', at: 120, run: spoken },
  { name: 'the new session completes', at: 160, run: completed('resp_9', 'd_9') },
];

const BOUNDARIES: readonly { readonly index: number; readonly name: string }[] = [
  { index: 0, name: 'before the call starts' },
  ...SCRIPT.map((step, position) => ({ index: position + 1, name: step.name })),
];

/** Drive the script up to `boundary`, kill the provider session there, then drive the rest of it. */
async function sweep(t: TestContext, boundary: number): Promise<Replay> {
  const r = await replay(t, { tools: true, scripts: [{ latencyMs: TOOL_LATENCY_MS }], callMaxMs: 120_000 });
  await r.ready();
  const run = async (from: number, to: number): Promise<void> => {
    for (const step of SCRIPT.slice(from, to)) {
      await elapsedBy(r, step.at);
      await step.run(r);
    }
  };
  await run(0, boundary);
  // The provider session dies at this boundary: everything after it is the host's rebuild of that session.
  await r.deliver({ type: 'session.closed', session: { id: 'sess_replay', reason: 'synthetic rebuild boundary' } });
  // #656: the owner keeps talking into the gap, and his words are held for the session that replaces this one.
  await r.speak(OWNER_FRAME_SAMPLES);
  // The rebuild is the host's own move, so the sweep lets the host's clock run until the new session starts.
  await r.until(() => starts(r).length >= 2, REBUILD_BUDGET_MS);
  await r.advance(500);
  for (const step of RECOVERY) {
    await r.advance(step.at);
    await step.run(r);
  }
  await r.advance(200);
  await run(boundary, SCRIPT.length);
  const last = SCRIPT.at(-1)?.at ?? 0;
  await elapsedBy(r, last + DEADLINE_MS);
  await r.until(() => r.owner.get(r.liveSessionId).lifecycle === 'terminal', DEADLINE_MS);
  return r;
}

/** The four assertions every boundary owes, named so a failure says which boundary and which clause. */
function judge(r: Replay, label: string): void {
  const states = r.projections.map(entry => `${entry.state}/${entry.lifecycle}`).join(' > ');
  const epoch = liveEpoch(r);
  // 1. No result lost. A result submitted into a session that then died was either already spoken or handed to
  //    the session that replaced it (#660). analyse carries invariants 1, 3, 4, 5 and 6; its invariant 2 is
  //    replaced below, because a batch whose session died cannot be continued and the live batch is the one
  //    the owner hears.
  const violations = analyse({
    calls: r.calls, batches: [], commands: r.commands, projections: r.projections,
    receipts: r.receipts, dispositions: r.dispositions, deadlineMs: DEADLINE_MS,
  }).list;
  assert.deepEqual([...violations], [], `${label}: ${violations.join(' | ')}`);

  for (const call of r.calls) {
    assert.ok(call.outputs.length <= 1,
      `${label}: call ${call.callId} (${call.name}) was submitted to a session ${call.outputs.length} times, not once (${states})`);
    const output = call.outputs[0];
    if (output === undefined) {
      assert.equal(r.dispositions.some(entry => entry.callId === call.callId), true,
        `${label}: call ${call.callId} (${call.name}) returned a result that reached no session and got no typed disposition (${states})`);
      continue;
    }
    if (output.epoch >= epoch) continue;
    // Its session died after the result was submitted: the owner must still get it, spoken then or handed over.
    const spokeIt = r.receipts.some(receipt => receipt.at >= output.at);
    const handedOver = r.providerFrames.some(frame => frame.epoch > output.epoch && frame.type === 'response.item.create'
      && (frame.frame['item'] as Record<string, unknown> | undefined)?.['type'] === 'message');
    assert.equal(spokeIt || handedOver, true,
      `${label}: call ${call.callId} (${call.name}) was submitted into generation ${output.epoch} at ${output.at} ms, that session died and nothing was spoken and nothing was handed to generation ${epoch} (${states})`);
  }

  // The live session's batches each get exactly one continuation decision: a result the host submits to the
  // session that is open now must be followed by one `response.create`, never none and never two.
  for (const batch of r.batches) {
    if (batch.epoch < epoch) continue;
    assert.equal(batch.creates.length, 1,
      `${label}: the batch ${batch.callIds.join(',')} of generation ${batch.epoch} got ${batch.creates.length} continuations, not one (${states})`);
  }

  // 2. No false status claim: "nothing is searching" is never said while a result is still outstanding.
  for (const frame of r.providerFrames) {
    if (frame.type !== 'session.commentary.append') continue;
    if (String(frame.frame['content'] ?? '') !== NO_LOOKUP_RUNNING_NOTE) continue;
    const outstanding = r.calls.filter(call => call.at <= frame.at && call.outputs.length === 0
      && !r.dispositions.some(entry => entry.callId === call.callId && entry.at <= frame.at));
    assert.deepEqual(outstanding.map(call => call.callId), [],
      `${label}: the host said nothing was searching at ${frame.at} ms while ${outstanding.map(call => call.callId).join(', ')} was still out (${states})`);
  }

  // 3. The owner's words spoken into the rebuild reach a session: far under the hold cap, nothing may be dropped.
  const received = r.providerFrames.filter(frame => frame.type === 'session.input_audio.append').length;
  assert.ok(OWNER_FRAMES * OWNER_FRAME_SAMPLES * 2 <= REBUILD_AUDIO_HOLD_BYTES, `${label}: the sweep spoke past the documented hold`);
  assert.equal(received, OWNER_FRAMES,
    `${label}: the owner spoke ${OWNER_FRAMES} frames and the provider sessions received ${received} of them (${states})`);

  // 4. The call either continues or ends with a closed reason.
  const lifecycle = r.owner.get(r.liveSessionId).lifecycle;
  assert.ok(lifecycle === 'active' || lifecycle === 'terminal',
    `${label}: the call is ${lifecycle}, it neither continues nor closes (${states})`);
  if (lifecycle === 'terminal') {
    assert.equal(r.projections.some(entry => entry.lifecycle === 'terminal' && entry.terminal !== null), true,
      `${label}: the call ended with no terminal reason (${states})`);
  }
}

test('rebuild sweep: a provider rebuild at every boundary of a call loses nothing', async t => {
  t.diagnostic(`rebuild sweep boundaries: ${BOUNDARIES.length}`);
  for (const boundary of BOUNDARIES) {
    await t.test(`boundary ${boundary.index}: ${boundary.name}`, async sub => {
      sub.diagnostic(`rebuild boundary ${boundary.index} of ${BOUNDARIES.length - 1}: ${boundary.name}`);
      const r = await sweep(sub, boundary.index);
      try {
        assert.equal(starts(r).length >= 2, true,
          `boundary ${boundary.index} (${boundary.name}): the provider was never rebuilt, the call ran on one session`);
        judge(r, `boundary ${boundary.index} (${boundary.name})`);
      } finally {
        await r.release();
      }
    });
  }
});
