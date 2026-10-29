import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolOutcomeOf } from '../live/tool-outcome.js';

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
  [{ status: 'unrecognized', text: 'Not a known settlement' }, 'unknown', undefined],
  [{ status: 'complete', findings: [{ text: 'Synthetic research finding' }] }, 'completed', undefined],
  [{ status: 'complete', findings: [], note: 'No matches' }, 'empty', undefined],
  [{ remembered: false, status: 'error', code: 'tool_journal_failed' }, 'failed', 'tool_journal_failed'],
  [{ status: 'completed' }, 'unknown', undefined],
  [{ saved: false, code: 'unrecognized_gate' }, 'unknown', 'unrecognized_gate'],
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
