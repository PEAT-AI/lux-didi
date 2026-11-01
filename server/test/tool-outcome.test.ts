import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolOutcomeOf } from '../live/tool-outcome.js';
import { ADMISSION_BLOCK_REASONS, RESEARCH_REFUSAL_REASONS, ResearchAdmission, admissionBlocked, researchRepair } from '../tools/research.js';
import { HOST_REFUSAL_CODES, REFUSAL_CAUSES, UNKNOWN_REFUSAL, refusalCauseOf, runningState } from '../tools/refusal-cause.js';

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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { liveTracePort } from '../trace/record.js';
import { safeEvent } from '../host/log.js';
import { GeminiLiveVoiceAdapter, OpenAiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions } from '../adapters/live-voice/index.js';
import { FakeSocket, options as openaiOptions } from './openai-live-voice-fixture.js';
import { options as geminiOptions, request, control } from './live-voice-fixture.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const provider of ['openai', 'gemini'] as const) {
  for (const delivered of [true, false]) for (const [index, [response, outcome, refusalCode]] of cases.entries()) {
    test(`${provider} wire delivered=${delivered} business outcome ${index}: ${outcome}`, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'didi-truth-'));
      const store = new Store(directory);
      t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
      const trace = liveTracePort({ port: store, liveSessionId: 'synthetic-truth', connectionEpoch: 'e0' });
      const socket = new FakeSocket();
      const socketFactory: NonNullable<LiveVoiceAdapterOptions['socketFactory']> = () => {
        queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); });
        return socket as unknown as ReturnType<NonNullable<LiveVoiceAdapterOptions['socketFactory']>>;
      };
      const adapter = provider === 'openai' ? new OpenAiLiveVoiceAdapter(openaiOptions({ socketFactory })) : new GeminiLiveVoiceAdapter(geminiOptions({ socketFactory }));
      const session = adapter.open(request(), { ...control(), trace });
      t.after(() => session.close());
      const events = (async () => { for await (const _event of session.events) { /* drain provider events */ } })();
      await tick();
      socket.deliver(provider === 'openai' ? { type: 'session.started', session: { id: 'synthetic' } } : { setupComplete: {} });
      await session.ready;
      const names = ['set_alarm', 'set_alarm', 'trello_read', 'mattermost_chat', 'mattermost_chat', 'remember_note', 'stage_lux_note'];
      const call = { id: 'synthetic-call', name: names[index] ?? 'research', args: {} };
      if (provider === 'openai') {
        socket.deliver({ type: 'session.delegation.created', delegation: { id: 'd1', offset_ms: 0, response_id: 'r1' } });
        socket.deliver({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.created', response: { id: 'r1' } } });
        socket.deliver({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: call.id, name: call.name, arguments: '{}' } } });
        await tick();
        socket.deliver({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.done', response: { id: 'r1', status: 'completed' } } });
      } else socket.deliver({ toolCall: { functionCalls: [call] } });
      await tick();
      if (!delivered) socket.send = () => { throw new Error('synthetic wire failure'); };
      const sent = session.sendToolResponse({ responses: [{ id: call.id, name: call.name, response }] });
      await tick();
      if (!delivered) assert.equal(sent, 'failed');
      const rows = store.transaction(tx => tx.all('SELECT outcome, outcome_code, delivered FROM trace_call'));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, outcome);
      assert.equal(rows[0]!.outcome_code, refusalCode ?? null);
      assert.equal(rows[0]!.delivered, Number(delivered));
      const host = safeEvent({ event: 'tool_call_outcome', callKey: call.id, tool: call.name, ...toolOutcomeOf(response) });
      assert.equal(host?.outcome, outcome);
      assert.equal(host?.refusalCode, refusalCode);
      const frames = socket.sent.map(frame => JSON.parse(frame));
      assert.equal(frames.some(frame => provider === 'openai' ? frame.item?.type === 'function_call_output' : frame.toolResponse?.functionResponses?.length === 1), delivered);
      session.close(); await events;
    });
  }
}

// C-HOSTFACTS (10.8): F7. Every refusal a tool hands the model carries closed facts, never a sentence to
// recite: the code, what actually ran, the host's cause category, the unmet prerequisite and the one
// supported next step. A refusal never authorizes a retry; a code the host cannot explain stays unknown.
test('C-HOSTFACTS every closed refusal code carries structured facts, never a recitable sentence', () => {
  for (const code of [...ADMISSION_BLOCK_REASONS, ...RESEARCH_REFUSAL_REASONS, ...HOST_REFUSAL_CODES]) {
    const facts: Record<string, unknown> = { ...refusalCauseOf(code) };
    assert.equal(facts['code'], code, `${code}: the closed code stays visible`);
    assert.equal(facts['retryPermitted'], false, `${code}: a refusal never permits a retry`);
    assert.notEqual(facts['cause'], 'unknown', `${code}: the host holds this cause`);
    // Every non-null value is a closed token or an identifier, so no field can carry a script.
    for (const [field, value] of Object.entries(facts)) {
      if (value === null || typeof value === 'boolean') continue;
      assert.match(String(value), /^[A-Za-z][A-Za-z0-9_]{0,63}$/u, `${code}: ${field} is a closed token, got ${value}`);
    }
  }
});

test('C-HOSTFACTS an unexplained code stays unknown and grants nothing', () => {
  const unknown = refusalCauseOf('a_code_this_host_never_closed');
  assert.deepEqual({ ...unknown }, { ...UNKNOWN_REFUSAL, code: 'a_code_this_host_never_closed' });
  assert.equal(unknown.cause, 'unknown');
  assert.equal(unknown.executed, 'unknown');
  assert.equal(unknown.prerequisite, null);
  assert.equal(unknown.retryPermitted, false);
  assert.equal(unknown.nextAction, 'report_unknown_code');
  // An unclosed-shape code is metadata only, and is not even repeated as a token.
  assert.equal(refusalCauseOf('not a code').code, 'unnamed_code');
});

// C-HOSTFACTS: the refused argument shape she is handed carries its facts and its unmet prerequisite.
test('C-HOSTFACTS a refused research argument carries its facts and that nothing was searched', () => {
  const reply = researchRepair('topic_required');
  assert.equal(reply['reason'], 'topic_required');
  assert.equal(reply['code'], 'topic_required');
  assert.equal(reply['executed'], 'nothing_ran');
  assert.equal(reply['cause'], REFUSAL_CAUSES.topic_required.cause);
  assert.equal(reply['field'], 'topic');
  assert.equal(reply['prerequisite'], 'non_empty_field');
  assert.equal(reply['nextAction'], 'resend_corrected_arguments');
  assert.equal(reply['retryPermitted'], false);
});

// C-HOSTFACTS: F6. The rebuild shape that lost her sense of what had finished: the result reached her, the
// provider generation was replaced, and nothing was running afterwards. The refusal she receives then says
// from the host's own record that nothing is running, and it never reads as work in progress.
test('C-HOSTFACTS after a rebuild the turn_spent refusal says nothing is running', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'synthetic web question'), { admitted: true });
  admission.delivered('synthetic-run-1');
  // The rebuild: the same admission object outlives the generation, and no scheduler run survives it.
  const reply = admissionBlocked('turn_spent', undefined, admission.running());
  assert.deepEqual(admission.running(), []);
  assert.deepEqual(reply['state'], { anyRunning: false, running: [] });
  assert.equal(reply['cause'], REFUSAL_CAUSES.turn_spent.cause);
  assert.equal(reply['nextAction'], REFUSAL_CAUSES.turn_spent.nextAction);
  assert.doesNotMatch(JSON.stringify(reply), /still (reading|looking|searching)|results? (is|are) (still )?(coming|on the way)/iu);
});

// C-HOSTFACTS: while one run really is in flight the refusal names it from the host's own record, and the
// record is the same object across a rebuild.
test('C-HOSTFACTS the running record names the running work and clears when it settles', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  admission.working('synthetic web question');
  assert.deepEqual(admission.running(), ['the research for "synthetic web question"']);
  assert.deepEqual(runningState(admission.running()),
    { anyRunning: true, running: ['the research for "synthetic web question"'] });
  admission.settledWork();
  assert.deepEqual(admission.running(), []);
  assert.deepEqual(runningState(admission.running()), { anyRunning: false, running: [] });
  assert.deepEqual(admissionBlocked('no_turn_since_result', undefined, admission.running())['state'],
    { anyRunning: false, running: [] });
});
