import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, expectCommands, play, trace as describe } from './voice-replay/driver.js';
import type { Command } from './voice-replay/driver.js';
import type { Played } from './voice-replay/driver.js';
import { sanitize } from './voice-replay/sanitize.js';

/**
 * The twelve council scenarios (council-orchestration-1018N, release gate F1). Each drives the real OpenAI
 * adapter and the real host live session together over a virtual clock and asserts the six invariants the
 * council named, plus the scenario's own fault.
 *
 * A scenario the current code fails is marked `todo` with the falsified assertion and the wagon that owes the
 * fix quoted in its own message. The suite runs inside the voice release gate, `scripts/check-live-session.sh`.
 * An invariant is never softened to make a scenario pass.
 */

const invariants = (played: Played): void => {
  const violations = played.violations().list;
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
/** Continuation creates only: the opener create a fresh call now sends at session.started answers no batch, so it
 *  is never the continuation these scenarios are about (contract 1023 N3). */
const continuations = (played: Played): number => {
  const log = played.replay.commands;
  const first = log.findIndex(entry => entry.type === 'response.item.create');
  return log.slice(first === -1 ? log.length : first).filter(entry => entry.type === 'response.create').length;
};

test('scenario 1: silent fill frames through a call keep the obligation and the continuation', async t => {
  const played = await play(t, 'scenario-01-silent-fill', { tools: true, scripts: [{ latencyMs: 3_000 }] });
  invariants(played);
  const { replay } = played;
  assert.equal(replay.calls.length, 1, `one call was observed: ${describe(replay)}`);
  // The wire order the docs require: submit the result, then continue. Fill frames change nothing.
  expectCommands(replay.commands, ['session.start', 'response.item.create', 'response.create']);
  assert.equal(countOf(played, 'response.item.create'), 1, 'one function_call_output for the call');
  assert.equal(continuations(played), 1, 'the continuation is not withheld by fill frames');
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
  assert.equal(continuations(played) >= 1, true, `the continuation was withheld after a barge-in: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 3: a late output after a timeout is not repeated and does not revive a settled turn', async t => {
  const played = await play(t, 'scenario-03-late-output-after-timeout', { tools: true, scripts: [{ latencyMs: 18_000 }] });
  const { replay } = played;
  const call = replay.calls[0];
  assert.ok(call, `one call was observed: ${describe(replay)}`);
  // The ceiling settles the call locally, and the tool's late answer is not submitted a second time. Scoped to
  // the generation that owed it: a re-submission after a reconnect resumes a lost call, which is a different
  // obligation, never a repeat of this one.
  const submissions = replay.commands.filter(command => command.epoch === call.epoch
    && (command.frame['item'] as Record<string, unknown> | undefined)?.['call_id'] === call.callId);
  assert.equal(submissions.length, 1, `exactly one output submission for ${call.callId} ${describe(replay)}`);
  // Which clock settled the call: the host says so itself. The owner's ceiling logs `tool_ceiling_hit` when it
  // answers, and the scripted tool's real budget (driver.ts `budgets.timeoutMs`) logs nothing of the kind, so a
  // call settled by anything other than the ceiling fails here instead of reading as a ceiling that ran early.
  assert.equal(replay.hostEvents.some(event => event['event'] === 'tool_ceiling_hit'), true,
    `the owner's ceiling did not settle ${call.callId}, something earlier did (host events: ${JSON.stringify(replay.hostEvents.map(event => event['event']))})`);
  // The ceiling is what answered, at the host limit, not the tool: a late callback is a receipt, never a write
  // (live/index.ts #withCeiling's `late` callback and the timeout branch that answers through the owner).
  assert.equal(submissions[0]!.at - call.at >= 12_000, true,
    `the ceiling, not the tool, answered ${call.callId} at +${submissions[0]!.at - call.at} ms: ${describe(replay)}`);
  assert.equal(/error|timeout|deadline|uncertain/.test(outputOf(played, call.callId)), true,
    `the ceiling's disposition is typed, not a bare success: ${outputOf(played, call.callId)}`);
  // The tool's real result landed 6 s after the settlement; it must never reach the provider.
  assert.equal(outputOf(played, call.callId).includes('Synthetic insight'), false,
    `the late tool result was written to the provider: ${outputOf(played, call.callId)}`);
  invariants(played);
  await replay.release();
});

test('scenario 4: parallel calls finishing in mixed order with failures get one output and one continuation each', async t => {
  const played = await play(t, 'scenario-04-parallel-mixed', {
    tools: true, scripts: [{ fail: true }, { latencyMs: 2_000 }],
  });
  const { replay } = played;
  assert.equal(replay.calls.length, 2, `two calls were observed: ${describe(replay)}`);
  assert.equal(countOf(played, 'response.item.create'), 2, 'one output per call');
  // One continuation decision per ready batch. Invariant 2 is that assertion: it also refuses a continuation
  // sent while another call of the same delegation still has no result.
  assert.equal(replay.batches.every(batch => batch.creates.length === 1), true,
    `every ready batch was continued once: ${JSON.stringify(replay.batches.map(batch => ({ ids: batch.callIds, creates: batch.creates.map(command => command.seq) })))}`);
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
  assert.equal(continuations(played), 2, 'one continuation per ready batch');
  invariants(played);
  await replay.release();
});

test('scenario 6: duplicate lifecycle and call events produce one tool turn', async t => {
  const played = await play(t, 'scenario-06-duplicate-events', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(countOf(played, 'response.item.create'), 1, `duplicate calls produced one output: ${describe(replay)}`);
  assert.equal(continuations(played), 1, 'one continuation for the duplicated batch');
  // The repeated events close resp_1 once, so the call the duplicate named is never left owing a typed loss
  // (openai.ts, the endedResponses branch: "a duplicated terminal event is the same end").
  assert.deepEqual(replay.dispositions.filter(entry => entry.callId === 'call_1'), [],
    `the duplicate was closed as a second obligation: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 7: a missing terminal event never withholds the continuation', async t => {
  const played = await play(t, 'scenario-07-missing-terminal-event', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(continuations(played), 1, `no response.done arrived, so the continuation was withheld: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 8: a rejected command retries at most once and an async settings failure is typed', async t => {
  const played = await play(t, 'scenario-08-rejected-command', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(continuations(played) <= 2, true, `the rejected continuation was retried more than once: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 9: a failed, incomplete or errored backend ends in a typed disposition', async t => {
  const played = await play(t, 'scenario-09-backend-failed', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(replay.receipts.length > 0 || replay.owner.get(replay.liveSessionId).lifecycle === 'terminal', true,
    `a failed backend turn ended with neither audible output nor a typed failure: ${describe(replay)}`);
  // A failed status is not a silent end: the adapter emits a typed turnFailed once no continuation was sent
  // (openai.ts, the response.done status branch), and the host settles the turn with that code.
  assert.equal(replay.projections.some(entry => entry.terminalCode === 'backend_failed'), true,
    `the failed backend turn carried no typed failure code: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 10: a disconnect during output submission settles without a stale write', async t => {
  const played = await play(t, 'scenario-10-disconnect-during-submission', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  // The interrupted submission of the tool output leaves the host on its recovery path, and the recovered
  // generation submits the lost call again exactly once: invariants 1, 3 and 4 are that assertion.
  assert.equal(countOf(played, 'session.start') >= 2, true, `the host never reconnected after the disconnect: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 11: a reconnect never replays an old callback as a new action', async t => {
  const played = await play(t, 'scenario-11-reconnect-old-callbacks', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  assert.equal(countOf(played, 'session.start') >= 2, true, `the host never reconnected: ${describe(replay)}`);
  // Old callbacks arrive on the dead socket: the recovered generation answers, and nothing is written for it
  // twice in one generation (invariants 1, 3 and 4 are that assertion).
  assert.equal(replay.receipts.length > 0, true, `the recovered session never answered: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 12: a commentary acknowledgement with no audio is not delivery', async t => {
  const played = await play(t, 'scenario-12-commentary-no-audio', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  const answerAt = replay.clock.startedAt + 9_000;
  assert.equal(replay.receipts.length > 0, true, `the turn never became audible: ${describe(replay)}`);
  assert.equal(replay.receipts[0]!.at >= answerAt, true,
    `a commentary acknowledgement with no audio counted as delivery at ${replay.receipts[0]!.at - replay.clock.startedAt} ms: ${describe(replay)}`);
  invariants(played);
  await replay.release();
});

test('scenario 13: a provider error frame mid tool turn ends in a typed failure, not a silent rebuild', { todo: 'current code ends the response a provider error frame interrupted and never emits turnFailed, so the turn is answered and continued, the provider stays silent after its own error, and the host only rebuilds at 18 s: invariant 6, the turn never became audible and never failed with a typed disposition inside the deadline; the fix belongs to the wagon that owns the generic provider error path (openai.ts providerError, the endResponse(undefined) that no turnFailed follows)' }, async t => {
  const played = await play(t, 'scenario-13-provider-error', { tools: true, scripts: [{ latencyMs: 1_500 }] });
  const { replay } = played;
  const call = replay.calls[0];
  assert.ok(call, `one call was observed: ${describe(replay)}`);
  // An error frame ends the response it names, but it is not the end of the turn: the turn still owes an answer
  // or a typed failure, and the deadline judges which. A silent rebuild is neither (openai.ts providerError:
  // the generic path ends the response with no turnFailed, so the host has nothing to settle on).
  assert.equal(replay.receipts.length > 0 || replay.projections.some(entry => entry.terminalCode !== null), true,
    `the provider error left the turn with neither an audible answer nor a typed failure: ${describe(replay)}`);
  invariants(played);
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

/** The minimum an invariant needs: one call answered once, and the continuation decisions recorded after it. */
const probe = (creates: number, terminal: { state: string; code: string | null } | undefined, audible: boolean) => {
  const output: Command = { seq: 1, at: 1_000, type: 'response.item.create', epoch: 0,
    frame: { item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' } } };
  const decisions: Command[] = Array.from({ length: creates }, (_unused, index) =>
    ({ seq: 2 + index, at: 1_010 + index, type: 'response.create', epoch: 0, frame: {} }));
  const call = { callId: 'call_1', name: 'search_knowledge', at: 900, epoch: 0, delegationId: 'd_1', outputs: [output], deliveryAt: undefined };
  return analyse({
    calls: [call],
    batches: [{ epoch: 0, at: 1_000, callIds: ['call_1'], creates: decisions }],
    commands: [output, ...decisions],
    projections: terminal ? [{ at: 5_000, cause: 'probe', state: 'ended', lifecycle: 'terminal', terminal: terminal.state, terminalCode: terminal.code }] : [],
    receipts: audible ? [{ at: 2_000, bytes: 4_800, durationMs: 100 }] : [],
    dispositions: [],
    deadlineMs: 10_000,
  }).list;
};

test('invariant 2 refuses a batch continued twice, and accepts it continued once', () => {
  const duplicated = probe(2, undefined, true);
  assert.equal(duplicated.some(entry => entry.includes('invariant 2') && entry.includes('continued 2 times')), true,
    `a double continuation must violate invariant 2: ${JSON.stringify(duplicated)}`);
  assert.deepEqual(probe(1, undefined, true), [], 'one continuation for one batch is clean');
  const withheld = analyse({
    calls: [{ callId: 'call_1', name: 'search_knowledge', at: 900, epoch: 0, delegationId: 'd_1', outputs: [{ seq: 1, at: 1_000, type: 'response.item.create', epoch: 0, frame: { item: { type: 'function_call_output', call_id: 'call_1' } } }], deliveryAt: undefined }],
    batches: [{ epoch: 0, at: 1_000, callIds: ['call_1'], creates: [] }],
    commands: [], projections: [], receipts: [{ at: 2_000, bytes: 4_800, durationMs: 100 }], dispositions: [], deadlineMs: 10_000,
  }).list;
  assert.equal(withheld.some(entry => entry.includes('no continuation followed')), true,
    `a withheld continuation must violate invariant 2: ${JSON.stringify(withheld)}`);
});

test('invariant 6 refuses every silent terminal word the host really emits and accepts a typed failure', () => {
  // LiveTerminalOutcome (server/live/types.ts:127-128): only `failed` and `deadline` carry a code and mean the
  // turn itself failed. Every other word is a silent end and cannot excuse a missing answer.
  for (const silent of ['closed', 'cancelled', 'not_started', 'outcome_unknown', 'expired', 'revoked', 'journal_limit', 'consumer_backpressure']) {
    const violations = probe(1, { state: silent, code: null }, false);
    assert.equal(violations.some(entry => entry.includes('invariant 6')), true,
      `a ${silent} end must violate invariant 6: ${JSON.stringify(violations)}`);
  }
  assert.equal(probe(1, { state: 'closed', code: 'remote_closed' }, false).some(entry => entry.includes('invariant 6')), true,
    'a closed end with a code is still a silent end');
  assert.equal(probe(1, { state: 'failed', code: null }, false).some(entry => entry.includes('invariant 6')), true,
    'a failed end with no code is not typed');
  assert.deepEqual(probe(1, { state: 'failed', code: 'provider_error' }, false), [], 'a failed end with a code is a typed failure');
  assert.deepEqual(probe(1, { state: 'deadline', code: 'deadline' }, false), [], 'a deadline with a code is a typed failure');
  assert.deepEqual(probe(1, undefined, true), [], 'audible output ends the turn correctly');
});
