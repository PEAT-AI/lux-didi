import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentaryEnvelope, extractExact, resultCommentary } from '../tasks/delivery.js';

function decode(text: string) {
  assert.match(text, /^```COMMENTARY\n[^\n]+\n```$/u);
  return JSON.parse(text.slice('```COMMENTARY\n'.length, -4));
}
test('commentary carries exact facts as data, never a host-written spoken sentence', () => {
  const exact = ['Daniel Tepe', 'Thursday 5 November 09:00 CET', 'EUR 1,000,000'];
  const payload = decode(resultCommentary({ status: 'complete', text: 'A result.', findings: [], exact }));
  assert.deepEqual(payload, { kind: 'result', exact, content: 'A result.', cause: '', what_failed: '', next_step: '' });
  assert.deepEqual(Object.keys(payload).sort(), ['cause', 'content', 'exact', 'kind', 'next_step', 'what_failed']);
});
test('no_action is an empty typed outcome, not a sentence to read', () => {
  assert.deepEqual(decode(resultCommentary({ status: 'no_action', text: '', findings: [] })),
    { kind: 'no_action', exact: [], content: '', cause: '', what_failed: '', next_step: '' });
});
test('structured model failure has a closed cause without leaking internal detail', () => {
  const result = { status: 'incomplete' as const, text: '', findings: [], failure: { stage: 'model', reason_code: 'provider_rejected', detail: 'private internal diagnostics' }, receipts: [{ id: 'internal' }] };
  const payload = decode(resultCommentary(result));
  assert.equal(payload.kind, 'failure');
  assert.equal(payload.cause, 'provider_rejected');
  assert.equal(payload.what_failed, "the helper's model request");
  assert.equal(payload.next_step, '');
  assert.ok(!JSON.stringify(payload).includes('internal'));
});
test('partial gives available content and a gap without inventing a repair', () => {
  const payload = decode(resultCommentary({ status: 'incomplete', text: 'One item available.', findings: [] }));
  assert.equal(payload.kind, 'partial'); assert.equal(payload.content, 'One item available.');
});
test('fallback extraction retains names, amounts, dates, times, email and units verbatim', () => {
  const text = 'Daniel Tepe: Thursday 5 November 09:00 CET, EUR 1,000,000, 12 kg; daniel@example.com.';
  const exact = extractExact(text);
  for (const entity of ['Daniel Tepe', 'EUR 1,000,000', '09:00 CET', '12 kg', 'daniel@example.com']) assert.ok(exact.includes(entity), entity);
  assert.ok(exact.some(entity => entity.includes('5 November')));
  assert.deepEqual(extractExact(text), exact);
});
test('recovery is data, not prose status', () => {
  assert.deepEqual(decode(commentaryEnvelope({ kind: 'recovery', cause: 'connection_dropped', mid_answer: true })),
    { kind: 'recovery', cause: 'connection_dropped', mid_answer: true });
});
