import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectCommands, play, trace as describe } from './voice-replay/driver.js';
import type { Played } from './voice-replay/driver.js';
import { sanitize } from './voice-replay/sanitize.js';

/**
 * The twelve council scenarios (council-orchestration-1018N, release gate F1). Each drives the real OpenAI
 * adapter and the real host live session together over a virtual clock and asserts the six invariants the
 * council named, plus the scenario's own fault.
 *
 * A scenario the current code fails is marked `todo` with the falsified assertion and the wagon that owes the
 * fix quoted in its own message, and the same four are named in docs/debugging.md under "Release gates". The
 * suite runs inside the voice release gate, `scripts/check-live-session.sh`. An invariant is never softened to
 * make a scenario pass.
 */

const invariants = (played: Played, options: { allowUnanswered?: boolean } = {}): void => {
  const violations = played.violations(options).list;
  assert.deepEqual(violations, [], `invariants broken for "${played.trace.scenario}": ${violations.join('; ')}${describe(played.replay)}`);
};
const types = (played: Played): string[] => played.replay.commands.map(command => command.type);
/** The provider JSON the host submitted for one call: the tool's own outcome, as the backend would read it. */
const outputOf = (played: Played, callId: string): string => {
  const command = played.replay.commands.find(entry => entry.type === 'response.item.create'
    && (entry.frame['item'] as Record<string, unknown> | undefined)?.['call_id'] === callId);
  return String((command?.frame['item'] as Record<string, unknown> | undefined)?.['output'] ?? '');
};
const countOf = (played: Played, type: string): number => types(played).filter(entry => entry === type).length;

test('scenario 1: silent fill frames through a call keep the obligation and the continuation', async t => {
  const played = await play(t, 'scenario-01-silent-fill', { tools: true, scripts: [{ latencyMs: 3_000 }] });
  invariants(played);
  const { replay } = played;
  assert.equal(replay.calls.length, 1, `one call was observed: ${describe(replay)}`);
  // The wire order the docs require: submit the result, then continue. Fill frames change nothing.
  expectCommands(replay.commands, ['session.start', 'response.item.create', 'response.create']);
  assert.equal(countOf(played, 'response.item.create'), 1, 'one function_call_output for the call');
  assert.equal(countOf(played, 'response.create'), 1, 'the continuation is not withheld by fill frames');
  assert.equal(replay.receipts.length > 0, true, 'the answer became audible');
  assert.notEqual(replay.calls[0]!.deliveryAt, undefined, 'the turn disposition is delivery, not silence');
  await replay.release();
});

test('scenario 2: a barge-in before tool completion still answers and continues', async t => {
  const played = await play(t, 'scenario-02-barge-in-before-completion', { tools: true, scripts: [{ latencyMs: 3_000 }] });
  const { replay } = played;
  // The orb must not read listening while the call is unanswered: that is the phantom barge-in of the 77 s
  // stall, where a flush mid-tool dropped THINKING to LISTENING and the continuation was withheld. Invariant 5
  // is that assertion; the barge-in must not add a second failure of its own.
  assert.equal(countOf(played, 'response.create') >= 1, true, `the continuation was withheld after a barge-in: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 3: a late output after a timeout is not repeated and does not revive a settled turn', { todo: 'current code submits the late callback a second time: call_1 gets the ceiling error at once and the tool\'s real result as a second function_call_output at +32,100 ms in the same generation; wagon S4a owes the ceiling and uncertain-action rule' }, async t => {
  const played = await play(t, 'scenario-03-late-output-after-timeout', { tools: true, scripts: [{ latencyMs: 18_000 }] });
  const { replay } = played;
  const call = replay.calls[0];
  assert.ok(call, `one call was observed: ${describe(replay)}`);
  // The ceiling settles the call locally, and the tool's late answer is not submitted a second time.
  assert.equal(call.outputs.length, 1, `exactly one output submission for the call: ${describe(replay)}`);
  // Scoped to the generation that owed it: a re-submission after a reconnect resumes a lost call, which is a
  // different obligation, never a repeat of this one.
  const late = replay.commands.filter(command => command.epoch === call.epoch && command.at >= call.at + 12_000
    && (command.frame['item'] as Record<string, unknown> | undefined)?.['call_id'] === call.callId);
  assert.deepEqual(late.map(entry => ({ seq: entry.seq, at: entry.at - call.at, output: (entry.frame['item'] as Record<string, unknown>)['output'] })),
    [], `the late callback wrote a second submission for ${call.callId} ${describe(replay)}`);
  assert.equal(/error|timeout|deadline|uncertain/.test(outputOf(played, call.callId)), true,
    `the ceiling's disposition is typed, not a bare success: ${outputOf(played, call.callId)}`);
  invariants(played);
  await replay.release();
});

test('scenario 4: parallel calls finishing in mixed order with failures get one output and one continuation each', { todo: 'current code continues a partial batch: it sends response.create after call_a while call_b of the same delegation still has no result (invariant 2), which the delegation guide forbids by "do not resend it"; wagon S4a owes the single continuation owner' }, async t => {
  const played = await play(t, 'scenario-04-parallel-mixed', {
    tools: true, scripts: [{ fail: true }, { latencyMs: 2_000 }],
  });
  const { replay } = played;
  assert.equal(replay.calls.length, 2, `two calls were observed: ${describe(replay)}`);
  assert.equal(countOf(played, 'response.item.create'), 2, 'one output per call');
  // One continuation decision per ready batch. Invariant 2 is that assertion: it also refuses a continuation
  // sent while another call of the same delegation still has no result.
  assert.equal(replay.batches.every(batch => batch.create !== undefined), true,
    `every ready batch was continued: ${JSON.stringify(replay.batches.map(batch => ({ ids: batch.callIds, create: batch.create?.seq ?? null })))}`);
  assert.notEqual(replay.batches[0]!.create, undefined, 'the batch was continued once');
  // The scripted tool really ran: the failing call carries its failure and the other carries its result.
  assert.equal(outputOf(played, 'call_a').includes('synthetic tool failure') || outputOf(played, 'call_a').includes('error'), true,
    `the failing call carries its failure: ${outputOf(played, 'call_a')}`);
  assert.equal(outputOf(played, 'call_b').includes('Synthetic insight'), true,
    `the succeeding call carries its result, not a journal failure: ${outputOf(played, 'call_b')} journal: ${replay.journalErrors.join('; ')}`);
  invariants(played);
  await replay.release();
});

test('scenario 5: a new call after the continuation is answered and continued once more', async t => {
  const played = await play(t, 'scenario-05-new-call-after-continuation', {
    tools: true, scripts: [{ latencyMs: 1_500 }, { latencyMs: 1_500 }],
  });
  const { replay } = played;
  assert.equal(replay.calls.length, 2, `two calls were observed: ${describe(replay)}`);
  assert.equal(countOf(played, 'response.item.create'), 2, 'one output per call');
  assert.equal(countOf(played, 'response.create'), 2, 'one continuation per ready batch');
  invariants(played);
  await replay.release();
});

test('scenario 6: duplicate lifecycle and call events produce one tool turn', { todo: 'current code reads listening with the call still unanswered after a duplicated terminal event: invariant 5; wagon S4a owes the command ledger and duplicate accounting' }, async t => {
  const played = await play(t, 'scenario-06-duplicate-events', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(countOf(played, 'response.item.create'), 1, `duplicate calls produced one output: ${describe(replay)}`);
  assert.equal(countOf(played, 'response.create'), 1, 'one continuation for the duplicated batch');
  invariants(played);
  await replay.release();
});

test('scenario 7: a missing terminal event never withholds the continuation', async t => {
  const played = await play(t, 'scenario-07-missing-terminal-event', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(countOf(played, 'response.create'), 1, `no response.done arrived, so the continuation was withheld: ${describe(replay)}`);
  invariants(played, { allowUnanswered: true });
  await replay.release();
});

test('scenario 8: a rejected command retries at most once and an async settings failure is typed', async t => {
  const played = await play(t, 'scenario-08-rejected-command', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(countOf(played, 'response.create') <= 2, true, `the rejected continuation was retried more than once: ${describe(replay)}`);
  invariants(played, { allowUnanswered: true });
  await replay.release();
});

test('scenario 9: a failed, incomplete or errored backend ends in a typed disposition', { todo: 'current code answers a failed backend response with a nudge and then a rebuild at 19.2 s, and never reaches audible output nor a typed failure inside the deadline: a failed backend turn ended with neither audible output nor a typed failure; wagon S4a owes the error map' }, async t => {
  const played = await play(t, 'scenario-09-backend-failed', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(replay.receipts.length > 0 || replay.owner.get(replay.liveSessionId).lifecycle === 'terminal', true,
    `a failed backend turn ended with neither audible output nor a typed failure: ${describe(replay)}`);
  invariants(played, { allowUnanswered: true });
  await replay.release();
});

test('scenario 10: a disconnect during output submission settles without a stale write', async t => {
  const played = await play(t, 'scenario-10-disconnect-during-submission', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  // The interrupted submission of the tool output leaves the host on its recovery path, and the recovered
  // generation submits the lost call again exactly once: invariants 1, 3 and 4 are that assertion.
  assert.equal(countOf(played, 'session.start') >= 2, true, `the host never reconnected after the disconnect: ${describe(replay)}`);
  invariants(played, { allowUnanswered: true });
  await replay.release();
});

test('scenario 11: a reconnect never replays an old callback as a new action', async t => {
  const played = await play(t, 'scenario-11-reconnect-old-callbacks', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(countOf(played, 'session.start') >= 2, true, `the host never reconnected: ${describe(replay)}`);
  // Old callbacks arrive on the dead socket: the recovered generation answers, and nothing is written for it
  // twice in one generation (invariants 1, 3 and 4 are that assertion).
  assert.equal(replay.receipts.length > 0, true, `the recovered session never answered: ${describe(replay)}`);
  invariants(played, { allowUnanswered: true });
  await replay.release();
});

test('scenario 12: a commentary acknowledgement with no audio is not delivery', async t => {
  const played = await play(t, 'scenario-12-commentary-no-audio', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  const answerAt = replay.clock.startedAt + 9_000;
  assert.equal(replay.receipts.length > 0, true, `the turn never became audible: ${describe(replay)}`);
  assert.equal(replay.receipts[0]!.at >= answerAt, true,
    `a commentary acknowledgement with no audio counted as delivery at ${replay.receipts[0]!.at - replay.clock.startedAt} ms: ${describe(replay)}`);
  invariants(played, { allowUnanswered: true });
  await replay.release();
});

test('the sanitizer replaces every free text field and keeps the frame order and the provider identifiers', () => {
  const recorded = [
    { at_ms: 0, direction: 'in', event: { type: 'session.input_transcript.delta', delta: 'She said my private words', start_ms: 0, end_ms: 900 } },
    { at_ms: 1_000, direction: 'in', event: { type: 'response.event', delegation_id: 'd_1', event: { type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'search_knowledge', arguments: '{"query":"private query","limit":2}' } } } },
  ];
  const steps = sanitize(recorded);
  const text = JSON.stringify(steps);
  assert.equal(text.includes('private'), false, `a sanitized trace still carries owner words: ${text}`);
  assert.deepEqual(steps.map(step => step.at_ms), [0, 1_000], 'the frame ordering is preserved');
  assert.equal(text.includes('call_1') && text.includes('d_1'), true, 'a provider identifier survives, so a call still joins its output');
  assert.equal((steps[0]!.event as Record<string, unknown>)['start_ms'], 0, 'a numeric field is untouched');
});

test('the sanitizer reads a recorded log as one JSON array and as one frame per line', () => {
  const oneLineEach = [
    '{"at_ms":0,"direction":"in","event":{"type":"session.input_transcript.delta","delta":"owner private words"}}',
    '{"at_ms":900,"direction":"in","event":{"type":"session.started","session":{"id":"sess_1"}}}',
  ].join('\n');
  const steps = sanitize(oneLineEach);
  assert.equal(steps.length, 2, `both frames survived: ${JSON.stringify(steps)}`);
  assert.equal(JSON.stringify(steps).includes('private'), false, 'no owner word survives the line-separated form either');
  assert.deepEqual(steps.map(step => step.at_ms), [0, 900]);
});
