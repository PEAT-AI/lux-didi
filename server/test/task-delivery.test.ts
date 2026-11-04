import { safeEvent } from '../host/log.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskDelivery, splitSpokenText, DELIVERY_HEARD_MS } from '../tasks/delivery.js';
const identity = { task_id: 't', task_revision: 1, connection_generation: 1 };
function fixture() {
  const reconnectTexts: string[] = []; let current = true, reconnects = 0; const pending = new Set<() => void>();
  const sends: { id: string; text: string; command: string }[] = [], states: string[] = [];
  const delivery = new TaskDelivery({ isCurrent: () => current,
    append: (id, text) => { const command = `c${sends.length}`; sends.push({ id, text, command }); return command; },
    reconnect: text => { reconnectTexts.push(text); reconnects++; return true; },
    state: (identity, state) => { const event = safeEvent({ event: 'task_delivery', taskId: identity.task_id, revision: identity.task_revision, state }); assert.ok(event, `delivery state ${state} must survive safeEvent`); states.push(String(event.state)); },
    after: (_ms, callback) => { pending.add(callback); return () => { pending.delete(callback); }; },
  });
  return { delivery, sends, states, reconnectTexts, stale: () => { current = false; }, reconnects: () => reconnects,
    advance: () => { const callbacks = [...pending]; pending.clear(); callbacks.forEach(callback => callback()); } };
}
const answer = (text: string) => ({ status: 'complete' as const, text, findings: [] });
test('spoken chunks preserve sentences and remain at most 450 characters', () => {
  const text = `${'Synthetic sentence. '.repeat(70)}${'x'.repeat(500)}`;
  const chunks = splitSpokenText(text);
  assert.ok(chunks.every(chunk => chunk.length <= 450));
  assert.equal(chunks.join(' ').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.ok(DELIVERY_HEARD_MS > 0);
});
test('delivery holds for owner speech and output, separates sent accepted and heard', () => {
  const f = fixture(); f.delivery.attach(identity, 'd1'); f.delivery.activity({ outputQuiet: false, ownerSpeaking: true });
  f.delivery.deliver(identity, answer('Synthetic answer.'));
  assert.equal(f.sends.length, 0);
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: false }); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.states, ['sent']);
  f.delivery.accepted('c0'); assert.deepEqual(f.states, ['sent', 'accepted']);
  f.delivery.transcript('Other speech.'); assert.equal(f.states.includes('heard'), false);
  f.delivery.transcript('Synthetic answer.'); assert.equal(f.states.at(-1), 'heard');
});
test('chunks stay ordered on one delegation and wait until quiet', () => {
  const f = fixture(); f.delivery.attach(identity, 'd1');
  const first = 'A'.repeat(440) + '.'; f.delivery.deliver(identity, answer(`${first} Second sentence.`));
  assert.equal(f.sends.length, 1);
  f.delivery.activity({ outputQuiet: false, ownerSpeaking: false }); f.delivery.transcript(first);
  assert.equal(f.sends.length, 1);
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: false });
  assert.equal(f.sends[1]?.text, 'Second sentence.'); assert.ok(f.sends.every(sent => sent.id === 'd1'));
});
test('unheard answer retries once reconnects once then retains undelivered', () => {
  const f = fixture(); f.delivery.attach(identity, 'd1'); f.delivery.deliver(identity, answer('Synthetic answer.'));
  f.advance(); assert.equal(f.sends.length, 2);
  f.advance(); assert.equal(f.reconnects(), 1);
  f.delivery.reconnected(); f.advance(); assert.equal(f.states.at(-1), 'undelivered');
  assert.equal(f.delivery.undelivered?.answer.text, 'Synthetic answer.');
  f.advance(); assert.equal(f.reconnects(), 1); assert.equal(f.sends.length, 2);
});
test('stale answers never append and owner speech holds retry', () => {
  const f = fixture(); f.delivery.attach(identity, 'd1'); f.delivery.deliver(identity, answer('Synthetic answer.'));
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: true }); f.advance(); assert.equal(f.sends.length, 1);
  f.stale(); f.delivery.activity({ outputQuiet: true, ownerSpeaking: false }); f.advance(); assert.equal(f.sends.length, 1);
});
test('rejection uses bounded fallback and reconnect transcript proves heard', () => {
  const f = fixture(); f.delivery.attach(identity, 'd1'); f.delivery.deliver(identity, answer('Synthetic answer.'));
  f.delivery.rejected('c0'); assert.equal(f.sends.length, 2);
  f.delivery.rejected('c1'); assert.equal(f.reconnects(), 1);
  f.delivery.transcript('Synthetic answer.'); assert.equal(f.states.at(-1), 'heard'); f.advance(); assert.equal(f.delivery.undelivered, undefined);
});

test('a delivery deadline during other output defers fallback until quiet', () => {
  const f = fixture(); f.delivery.attach(identity, 'd1'); f.delivery.deliver(identity, answer('Synthetic answer.'));
  f.delivery.activity({ outputQuiet: false, ownerSpeaking: false }); f.advance();
  assert.equal(f.sends.length, 1);
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: false }); assert.equal(f.sends.length, 2);
  f.delivery.activity({ outputQuiet: false, ownerSpeaking: false }); f.advance();
  assert.equal(f.reconnects(), 0);
  f.delivery.activity({ outputQuiet: true, ownerSpeaking: false }); assert.equal(f.reconnects(), 1);
});


test('a reconnect is not sent or accepted until the fresh session is ready', () => {
  const f = fixture(); f.delivery.deliver(identity, answer('Synthetic ready answer.'));
  assert.equal(f.reconnects(), 1); assert.deepEqual(f.states, ['reconnect']);
  f.advance(); assert.equal(f.delivery.undelivered, undefined, 'no heard deadline runs before setup acknowledgement');
  f.delivery.reconnected(); assert.deepEqual(f.states, ['reconnect', 'sent', 'accepted']);
  f.delivery.transcript('Synthetic ready answer.'); f.advance();
  assert.equal(f.states.at(-1), 'heard'); assert.equal(f.delivery.undelivered, undefined);
});
test('reconnect instructions contain only the not-yet-heard answer chunks', () => {
  const f = fixture(), first = 'a'.repeat(440) + '.';
  f.delivery.attach(identity, 'd'); f.delivery.deliver(identity, answer(first + ' Second sentence.'));
  f.delivery.transcript(first); f.delivery.rejected('c1'); f.delivery.rejected('c2');
  assert.deepEqual(f.reconnectTexts, ['Second sentence.']);
});

test('VOICE-R15: every delivery state and lifecycle identity survives closed safe audit serialization', () => {
  for (const state of ['sent', 'accepted', 'heard', 'retry', 'reconnect', 'undelivered']) {
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
