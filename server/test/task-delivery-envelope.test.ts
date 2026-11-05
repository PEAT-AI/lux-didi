import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskDelivery, commentaryEnvelope, commentaryItems, extractExact, resultCommentary } from '../tasks/delivery.js';

function decode(text: string) {
  assert.match(text, /^```COMMENTARY\n[^\n]+\n```$/u);
  return JSON.parse(text.slice('```COMMENTARY\n'.length, -4));
}
test('commentary carries exact facts as data, never a host-written spoken sentence', () => {
  const exact = ['Daniel Tepe', 'Thursday 5 November 09:00 CET', 'EUR 1,000,000'];
  const payload = resultCommentary({ status: 'complete', text: 'A result.', findings: [], exact });
  assert.deepEqual(payload, { kind: 'result', exact, content: 'A result.', cause: '', what_failed: '', next_step: '' });
  assert.deepEqual(Object.keys(payload).sort(), ['cause', 'content', 'exact', 'kind', 'next_step', 'what_failed']);
});
test('no_action is an empty typed outcome, not a sentence to read', () => {
  assert.deepEqual(resultCommentary({ status: 'no_action', text: '', findings: [] }),
    { kind: 'no_action', exact: [], content: '', cause: '', what_failed: '', next_step: '' });
});
test('structured model failure has a closed cause without leaking internal detail', () => {
  const result = { status: 'incomplete' as const, text: '', findings: [], failure: { stage: 'model', reason_code: 'provider_rejected', detail: 'private internal diagnostics' }, receipts: [{ status: 'ok' as const, text: 'internal', references: [], next_cursor: null, coverage: '', repair: null }] };
  const payload = resultCommentary(result);
  assert.equal(payload.kind, 'failure');
  assert.equal(payload.cause, 'provider_rejected');
  assert.equal(payload.what_failed, "the helper's model request");
  assert.equal(payload.next_step, '');
  assert.ok(!JSON.stringify(payload).includes('internal'));
});
test('partial gives available content and a gap without inventing a repair', () => {
  const payload = resultCommentary({ status: 'incomplete', text: 'One item available.', findings: [] });
  assert.equal(payload.kind, 'partial'); assert.equal(payload.content, 'One item available.');
});
test('fallback extraction retains names, amounts, dates, times, email and units verbatim', () => {
  const text = 'Daniel Tepe: Thursday 5 November 09:00 CET, EUR 1,000,000, 12 kg; daniel@example.com.';
  const exact = extractExact(text);
  for (const entity of ['Daniel Tepe', 'EUR 1,000,000', '09:00 CET', '12 kg', 'daniel@example.com']) assert.ok(exact.some(value => value.includes(entity)), entity);
  assert.ok(exact.some(entity => entity.includes('5 November')));
  assert.deepEqual(extractExact(text), exact);
});
test('recovery is data, not prose status', () => {
  assert.deepEqual(decode(commentaryEnvelope({ kind: 'recovery', cause: 'connection_dropped', mid_answer: true })),
    { kind: 'recovery', cause: 'connection_dropped', mid_answer: true });
});

test('multipart commentary respects the adapter cap, exact strings and sentence boundaries', () => {
  const exact = ['Daniel Tepe', 'EUR 1,000,000'];
  const content = 'Daniel Tepe has EUR 1,000,000. ' + 'A complete sentence about the result. '.repeat(25);
  const items = commentaryItems(resultCommentary({ status: 'complete', text: content, exact, findings: [] }), 'e1');
  assert.ok(items.length > 2);
  const parts = items.map(item => { assert.ok(item.length <= 450); return decode(item); });
  for (const [index, part] of parts.entries()) {
    assert.equal(part.id, 'e1'); assert.equal(part.part, `${index + 1}/${parts.length}`);
    assert.equal(part.final, index === parts.length - 1);
    assert.ok(!JSON.stringify(part).includes('task_id'));
  }
  assert.equal(parts[0].kind, 'result');
  assert.deepEqual(parts.filter(part => part.section === 'header').flatMap(part => part.exact), exact);
  const spoken = parts.filter(part => part.section === 'content').map(part => part.content);
  assert.equal(spoken.join(' '), content.trim());
  assert.ok(spoken.every(text => text.endsWith('.')));
});
test('header exact list continues without splitting an entity and encoded text respects cap', () => {
  const exact = Array.from({ length: 20 }, (_, i) => `A capitalized name ${i}`);
  const items = commentaryItems({ kind: 'result', exact, content: 'Quoted "value". '.repeat(45), cause: '', what_failed: '', next_step: '' }, 'e2');
  assert.ok(items.every(item => item.length <= 450));
  assert.deepEqual(items.map(decode).filter(part => part.section === 'header').flatMap(part => part.exact), exact);
});
test('an entity larger than a wire item fails closed rather than losing or splitting it', () => {
  const items = commentaryItems({ kind: 'result', exact: ['x'.repeat(500)], content: 'x'.repeat(500), cause: '', what_failed: '', next_step: '' });
  assert.equal(items.length, 1); assert.ok(items[0]!.length <= 450);
  assert.equal(decode(items[0]!).cause, 'invalid_result');
});

test('W3-R3: empty structured failure delivers immediately without delegation, even when requested', () => {
  const sent: string[] = [];
  const delivery = new TaskDelivery({ isCurrent: () => true, append: (_binding, text) => { sent.push(text); return `command${sent.length}`; }, state: () => {} });
  delivery.socket(1);
  const failure = { stage: 'model', reason_code: 'provider_rejected', detail: 'private diagnostics' };
  const answer = { status: 'incomplete' as const, text: '', findings: [], failure };
  delivery.deliver({ task_id: 'failure-task', task_revision: 1, connection_generation: 1 }, answer, true);
  assert.equal(sent.length, 1);
  assert.equal(decode(sent[0]!).kind, 'failure');
  assert.equal(decode(sent[0]!).cause, 'provider_rejected');
  assert.equal(decode(sent[0]!).final, true);
  assert.ok(!sent[0]!.includes('private diagnostics'));
});
test('W3-R3: empty text without a structured failure is no_action, not failure', () => {
  for (const status of ['complete', 'incomplete', 'no_action'] as const) {
    const commentary = resultCommentary({ status, text: '   ', findings: [] });
    assert.equal(commentary.kind, 'no_action'); assert.equal(commentary.content, '');
    assert.deepEqual(commentary.exact, []); assert.equal(commentary.cause, '');
  }
  assert.equal(resultCommentary({ status: 'no_action', text: '', findings: [],
    failure: { stage: 'model', reason_code: 'provider_rejected', detail: '' } }).kind, 'failure');
});
