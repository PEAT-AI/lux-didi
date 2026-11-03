import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolOutcomeOf } from '../live/tool-outcome.js';
import { CAUSE_NOT_KNOWN, HOST_REFUSAL_CODES, refusalCauseOf } from '../tools/refusal-cause.js';

const cases = [
  [{ status: 'refused', code: 'no_owner_request' }, 'refused', 'no_owner_request'],
  [{ status: 'clarify', reason: 'missing_time' }, 'clarify', 'missing_time'],
  [{ error: 'invalid_arguments' }, 'failed', 'invalid_arguments'],
  [{ total: 0, messages: [] }, 'empty', undefined],
  [{ status: 'error', reason: 'tool_journal_failed' }, 'failed', 'tool_journal_failed'],
  [{ remembered: false, reason: 'owner_text_mismatch' }, 'refused', 'owner_text_mismatch'],
  [{ status: 'refused', code: 'authorization_missing' }, 'refused', 'authorization_missing'],
  [{ status: 'blocked', code: 'owner_turn_required' }, 'blocked', 'owner_turn_required'],
  [{ status: 'partial', answer: 'One synthetic result' }, 'partial', undefined],
  [{ status: 'answered', answer: 'Synthetic answer' }, 'completed', undefined],
  [{}, 'unknown', undefined],
  [{ id: 'synthetic-id-only' }, 'unknown', undefined],
  [{ status: 'unrecognized', text: 'Not a known settlement' }, 'unknown', undefined],
  [{ status: 'complete', findings: [{ text: 'Synthetic research finding' }] }, 'completed', undefined],
  [{ status: 'complete', findings: [], note: 'No matches' }, 'empty', undefined],
  [{ remembered: false, status: 'error', code: 'tool_journal_failed' }, 'failed', 'tool_journal_failed'],
  [{ status: 'completed' }, 'unknown', undefined],
  [{ saved: false, code: 'unrecognized_gate' }, 'unknown', 'unrecognized_gate'],
  [{ code: 'opened', kind: 'url', title: 'Synthetic site' }, 'completed', undefined],
  [{ status: 'set', id: 'synthetic-alarm-id', fire_at_utc: 'synthetic-time' }, 'completed', undefined],
  [{ status: 'set' }, 'unknown', undefined],
  // C-LABELS 3: a calendar create that answered event_created with its id is a settlement, not an unknown.
  [{ status: 'event_created', event_id: 'synthetic-event-id', start: 'synthetic-time', end: 'synthetic-time' }, 'completed', undefined],
  [{ status: 'event_created' }, 'unknown', undefined],
  // G5: a dispatched failure keeps the reason the connector gave next to the collapsed code it maps to,
  // so `tool_call_outcome` can say whether it was an argument refusal or a grant/catalogue miss.
  [{ status: 'failed', code: 'sdk_protocol_rejected', reason: 'invalid-arguments' }, 'failed', 'invalid-arguments'],
  [{ status: 'failed', code: 'tool_not_granted', reason: 'not-in-envelope' }, 'failed', 'tool_not_granted'],
] as const;
for (const [response, outcome, refusalCode] of cases) {
  test(`business outcome ${JSON.stringify(response)}`, () => {
    assert.deepEqual(toolOutcomeOf(response), { outcome, ...(refusalCode ? { refusalCode } : {}) });
  });
}

// Synthetic wire frames exercise each provider's actual send and trace path, without a server.
import { safeEvent } from '../host/log.js';
import { OpenAiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions } from '../adapters/live-voice/index.js';
import { FakeSocket, options } from './openai-live-voice-fixture.js';
import { request, control } from './live-voice-fixture.js';

for (const [index, [response, outcome, refusalCode]] of cases.entries()) {
  test(`business outcome ${index} retains its closed host metadata`, () => {
    const host = safeEvent({ event: 'tool_call_outcome', callKey: 'synthetic-call', tool: 'run_task', ...toolOutcomeOf(response) });
    assert.equal(host?.outcome, outcome);
    assert.equal(host?.refusalCode, refusalCode);
  });
}

for (const wireFailure of [false, true]) {
  test(`client task answer preserves exact content, wireFailure=${wireFailure}`, async t => {
    const socket = new FakeSocket();
    const socketFactory: NonNullable<LiveVoiceAdapterOptions['socketFactory']> = () => {
      queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); });
      return socket as unknown as ReturnType<NonNullable<LiveVoiceAdapterOptions['socketFactory']>>;
    };
    const session = new OpenAiLiveVoiceAdapter(options({ socketFactory })).open(request(), control());
    const drained = (async () => { for await (const event of session.events) void event; })();
    t.after(async () => { session.close(); await drained; });
    await new Promise<void>(resolve => setImmediate(resolve));
    socket.deliver({ type: 'session.started', session: { id: 'synthetic' } });
    await session.ready;
    const text = 'The synthetic receipt is A17.';
    assert.equal(session.sendTaskAnswer!({ delegationId: 'missing', text }), undefined);
    socket.deliver({ type: 'session.delegation.created', delegation: { id: 'd1' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    if (wireFailure) socket.send = () => { throw new Error('synthetic wire failure'); };
    const commandId = session.sendTaskAnswer!({ delegationId: 'd1', text });
    const frames = socket.sent.map(frame => JSON.parse(frame));
    const commentary = frames.filter(frame => frame.type === 'session.commentary.append');
    assert.equal(commentary.length, Number(!wireFailure));
    if (wireFailure) assert.equal(commandId, undefined);
    else {
      assert.equal(commentary[0].event_id, commandId);
      assert.equal(commentary[0].delegation_id, 'd1');
      assert.equal(commentary[0].content, text);
      assert.equal(typeof commandId, 'string');
    }
    assert.equal(frames.some(frame => frame.type === 'response.create' || frame.type === 'response.item.create'), false);
  });
}

// C-TOOLTRUTH (10.8): F7. Every refusal a tool hands the model states its true cause in one plain sentence the
// model can repeat, plus what will or will not happen next. A code whose honest cause the host does not hold
// says so and never guesses, so nothing she is handed invites an invented cause.
test('C-TOOLTRUTH every closed refusal code carries a plain cause and a next line', () => {
  for (const code of HOST_REFUSAL_CODES) {
    const { cause, next } = refusalCauseOf(code);
    assert.ok(cause.trim().length > 20, `${code}: the cause is one plain sentence, got ${cause}`);
    assert.match(cause, /^[A-Z].*\.$/u, `${code}: the cause is a finished sentence, got ${cause}`);
    assert.match(next, /^[A-Z].*\.$/u, `${code}: the next line is a finished sentence, got ${next}`);
    // A cause is a statement the host can back. It never asks the owner for anything, and it never asks the
    // model to ask the owner for anything the host did not itself decide.
    assert.doesNotMatch(cause, /[?\u2013\u2014]/u, `${code}: the cause is a statement, got ${cause}`);
    assert.doesNotMatch(cause, /\b(ask|tell|repeat|say|request)\b/iu, `${code}: the cause instructs nobody, got ${cause}`);
    assert.notEqual(cause.toLowerCase().replace(/[^a-z]+/gu, ' ').trim(), code.replace(/_+/gu, ' '),
      `${code}: the cause names the reason, it does not echo the code`);
  }
});

test('C-TOOLTRUTH a refusal code the table does not know says the reason is not known', () => {
  const { cause, next } = refusalCauseOf('a_code_this_host_never_closed');
  assert.equal(cause, 'the reason is not known');
  assert.equal(CAUSE_NOT_KNOWN, 'the reason is not known');
  assert.match(next, /^[A-Z].*\.$/u);
  assert.doesNotMatch(next, /[?\u2013\u2014]/u);
  // The code stays visible as closed metadata, and nothing is invented about it.
  assert.match(next, /a_code_this_host_never_closed/u);
  assert.match(refusalCauseOf('not a code').next, /an unnamed code/u);
});

