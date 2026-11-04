import { safeEvent } from '../host/log.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskDelivery, splitSpokenText, NO_LOOKUP_COMMENTARY } from '../tasks/delivery.js';
const identity = { task_id: 't', task_revision: 1, connection_generation: 1 };
const answer = (text: string) => ({ status: 'complete' as const, text, findings: [] });
function fixture() {
  let current = true;
  const sends: { id: string | null; text: string; command: string }[] = [], states: string[] = [];
  const delivery = new TaskDelivery({ isCurrent: () => current,
    append: (id, text) => { const command = `c${sends.length}`; sends.push({ id, text, command }); return command; },
    state: (_identity, state) => { assert.ok(safeEvent({ event: 'task_delivery', taskId: 't', revision: 1, state })); states.push(state); } });
  return { delivery, sends, states, stale: () => { current = false; }, reconnects: () => 0 };
}
test('spoken chunks preserve text and remain at most 450 characters', () => {
  const text = `${'Synthetic sentence. '.repeat(70)}${'x'.repeat(500)}`;
  const chunks = splitSpokenText(text);
  assert.ok(chunks.every(chunk => chunk.length <= 450));
  assert.equal(chunks.join(' ').replace(/\s/g, ''), text.replace(/\s/g, ''));
});
test('delivery holds for owner speech and output until both are quiet', () => {
  const f = fixture(); f.delivery.socket(1); f.delivery.activity({ outputQuiet: false, ownerSpeaking: true });
  f.delivery.deliver(identity, answer('Synthetic answer.')); assert.equal(f.sends.length, 0);
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: true }); assert.equal(f.sends.length, 0);
  f.delivery.activity({ outputQuiet: false, ownerSpeaking: false }); assert.equal(f.sends.length, 0);
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: false }); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.states, ['sent']);
  f.delivery.accepted(f.sends[0]!.command); assert.deepEqual(f.states, ['sent', 'accepted']);
  assert.equal(f.delivery.waitingAnswer(), undefined);
});
test('stale results and stale receipts cannot deliver, paired with a valid result', () => {
  const f = fixture(); f.delivery.deliver(identity, answer('Synthetic valid.')); assert.equal(f.sends.length, 1);
  f.stale(); f.delivery.accepted(f.sends[0]!.command); f.delivery.deliver(identity, answer('Synthetic stale.'));
  assert.equal(f.sends.length, 1); assert.deepEqual(f.states, ['sent']);
});
test('socket loss retains only the unacknowledged remainder and waits for ready', () => {
  const f = fixture(); f.delivery.socket(1); f.delivery.attach(identity, 'old');
  f.delivery.deliver(identity, answer('Synthetic sentence. '.repeat(40)));
  f.delivery.accepted(f.sends[0]!.command); const pending = f.sends[1]!.text;
  f.delivery.disconnected(); f.delivery.socket(2, false); assert.equal(f.sends.length, 2);
  f.delivery.accepted(f.sends[1]!.command); assert.equal(f.states.filter(s => s === 'accepted').length, 1);
  f.delivery.ready(); assert.equal(f.sends.length, 3); assert.equal(f.sends[2]!.id, null);
  assert.equal(f.sends[2]!.text, pending);
  f.delivery.accepted(f.sends[2]!.command); assert.equal(f.delivery.waitingAnswer(), undefined);
});
test('no_action tells an open delegation the situation, and otherwise sends nothing', () => {
  const f = fixture(); const result = { status: 'no_action' as const, text: '', findings: [] };
  f.delivery.deliver(identity, result); assert.equal(f.sends.length, 0);
  f.delivery.attach(identity, 'd1'); f.delivery.deliver(identity, result);
  assert.equal(f.sends[0]!.text, NO_LOOKUP_COMMENTARY);
  f.delivery.accepted(f.sends[0]!.command); assert.equal(f.delivery.waitingAnswer(), undefined);
});
test('VOICE-R15: every delivery state and lifecycle identity survives closed safe audit serialization', () => {
  for (const state of ['sent', 'accepted', 'retry', 'undelivered']) {
    const event = { event: 'task_delivery', taskId: 'synthetic-task', revision: 2, state };
    assert.deepEqual(safeEvent(event), event);
    assert.equal(safeEvent({ ...event, text: 'Synthetic forbidden payload' }), undefined);
  }
  const lifecycle = { event: 'task_lifecycle', taskId: 'synthetic-task', revision: 2, generation: 3, phase: 'complete', count: 1, ms: 2 };
  assert.deepEqual(safeEvent(lifecycle), lifecycle);
  assert.equal(safeEvent({ ...lifecycle, text: 'Synthetic forbidden payload' }), undefined);
  assert.equal(safeEvent({ event: 'task_delivery', taskId: 'synthetic-task', revision: 2, state: 'unknown' }), undefined);
});

test('C-DELIVERY: a generation without delegation appends on the open line', () => {
  const f = fixture(); f.delivery.socket(1);
  f.delivery.deliver(identity, answer('Synthetic open line answer.'));
  assert.equal(f.reconnects(), 0);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]?.id, null);
});
test('C-DELIVERY: acceptance advances chunks without transcript and never replays accepted text', () => {
  const f = fixture(); f.delivery.socket(1); f.delivery.attach(identity, 'd1');
  f.delivery.deliver(identity, answer('Synthetic sentence. '.repeat(40)));
  assert.equal(f.sends.length, 1);
  f.delivery.accepted(f.sends[0]!.command);
  assert.equal(f.sends.length, 2);
  f.delivery.accepted(f.sends[1]!.command);
  const count = f.sends.length;
  f.delivery.socket(2); f.delivery.activity({ outputQuiet: true, ownerSpeaking: false });
  assert.equal(f.sends.length, count);
  assert.equal(f.reconnects(), 0);
});
test('C-DELIVERY: a rejection retries once on the same line and then fails', () => {
  const f = fixture(); f.delivery.socket(1); f.delivery.attach(identity, 'd1');
  f.delivery.deliver(identity, answer('Synthetic rejected answer.'));
  f.delivery.rejected(f.sends[0]!.command);
  f.delivery.rejected(f.sends[1]!.command);
  assert.equal(f.sends.length, 2);
  assert.equal(f.reconnects(), 0);
  assert.equal(f.states.at(-1), 'undelivered');
});

test('C-DELIVERY: once quiet starts a chunk sequence, acknowledgements drain it back to back', () => {
  const f = fixture(); f.delivery.deliver(identity, answer('Synthetic sentence. '.repeat(40)));
  f.delivery.activity({ outputQuiet: false, ownerSpeaking: false });
  f.delivery.accepted(f.sends[0]!.command); assert.equal(f.sends.length, 2);
  f.delivery.accepted(f.sends[1]!.command); assert.equal(f.delivery.waitingAnswer(), undefined);
});
