import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryItem } from '../domain/memory-items.js';
import { compileMemoryBlock, MEMORY_BACKGROUND } from '../prompt/memory-block.js';
import { estimatedTokens } from '../prompt/context-budget.js';

const now = Date.UTC(2026, 10, 6, 17);
const item = (id: string, patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id, kind: 'durable_fact', text: `Synthetic fact ${id}`, subject: id, validFrom: now - 1000,
  validUntil: null, eventAt: null, eventTz: null, eventText: null, place: null,
  authority: 'derived', status: 'active', supersededBy: null, salience: 0.5,
  createdAt: now - 1000, createdBy: 'synthetic', generation: 1, ...patch,
});
const input = { now, timeZone: 'Asia/Jakarta', clock: 'Saturday 7 November 2026, 00:00', entries: [], summaries: [] };

test('background block contains all parts, applies supersession and expiry before ranking', () => {
  const result = compileMemoryBlock({ ...input, items: [item('old', { supersededBy: 'new' }), item('new'),
    item('expired', { kind: 'transient_state', validUntil: now - 1 }),
    item('plan', { kind: 'promise', text: 'Visit the observatory', eventAt: now, place: 'Hill station' })] });
  assert.ok(result.text.startsWith(MEMORY_BACKGROUND));
  const headings = ['# Now', '# Who he is', '# Open loops', '# Last conversations'];
  for (let index = 1; index < headings.length; index++) assert.ok(result.text.indexOf(headings[index - 1]!) < result.text.indexOf(headings[index]!));
  assert.ok(!result.text.includes('Synthetic fact old'));
  assert.ok(!result.text.includes('Synthetic fact expired'));
  assert.ok(result.text.includes('Synthetic fact new'));
  assert.match(result.text, /7 Nov 2026.*Visit the observatory.*Hill station/);
  assert.ok(estimatedTokens(result.text) <= 2_000);
});

test('already admitted summaries have no age or data-class filter and pack newest first', () => {
  const summaries = [
    { id: 'old-call', sessionId: 'old-call', startedAt: now - 100 * 86_400_000, text: 'An older admitted conversation' },
    { id: 'recent-call', sessionId: 'recent-call', startedAt: now, text: 'The latest admitted conversation' },
  ];
  const result = compileMemoryBlock({ ...input, items: [], summaries });
  assert.ok(result.text.indexOf('[session:recent-call]') < result.text.indexOf('[session:old-call]'));
  assert.deepEqual(result.summaryIds, ['recent-call', 'old-call']);
});

test('explicit owner authority outranks salience, duplicate facts render once, unresolved overdue promises stay', () => {
  const result = compileMemoryBlock({ ...input, items: [
    item('derived', { salience: 1 }), item('explicit', { authority: 'explicit_owner', salience: 0 }),
    item('duplicate', { text: 'Synthetic fact explicit', kind: 'plan' }),
    item('overdue', { kind: 'promise', eventAt: now - 30 * 86_400_000 }),
  ] });
  assert.ok(result.text.indexOf('Synthetic fact explicit') < result.text.indexOf('Synthetic fact derived'));
  assert.equal(result.text.split('Synthetic fact explicit').length - 1, 1);
  assert.ok(result.text.includes('Synthetic fact overdue'));
});

test('floor mode retains all headings and whole recent summaries without truncation', () => {
  const summaries = Array.from({ length: 10 }, (_, index) => ({ id: `call-${index}`, sessionId: `call-${index}`, startedAt: now - index, text: `${index} ${'summary '.repeat(80)}` }));
  const result = compileMemoryBlock({ ...input, items: [], summaries, floors: true });
  assert.ok(result.text.includes('# Last conversations'));
  assert.ok(result.summaryIds.length >= 2);
  for (const id of result.summaryIds) assert.ok(result.text.includes(summaries.find(summary => summary.id === id)!.text));
  assert.ok(estimatedTokens(result.text) <= 2_000);
});

test('summary provenance keeps the summary id distinct from its source session marker', () => {
  const summary = { id: 'summary-uuid', sessionId: 'source-session', startedAt: now, text: 'Synthetic source conversation' };
  const result = compileMemoryBlock({ ...input, items: [], summaries: [summary] });
  assert.deepEqual(result.summaryIds, ['summary-uuid']);
  assert.ok(result.text.includes('[session:source-session]'));
  assert.ok(!result.text.includes('[session:summary-uuid]'));
});

test('identity floor remains 400 estimated tokens after charging the shared background header', () => {
  const text = 'S'.repeat(1_200);
  const result = compileMemoryBlock({ ...input, items: [], entries: [{ id: 'identity-floor', text }], floors: true });
  assert.ok(result.text.includes(text), 'the shared header must not consume the protected identity floor');
  assert.ok(estimatedTokens(result.text) <= 2_000);
});

test('explicit entry and typed identity facts share one authority and salience ranking', () => {
  const entry = { id: 'entry', text: 'A lower salience explicit entry', salience: 0.1 };
  const typed = item('typed', { authority: 'explicit_owner', salience: 0.9 });
  const result = compileMemoryBlock({ ...input, entries: [entry], items: [typed] });
  assert.ok(result.text.indexOf(typed.text) < result.text.indexOf(entry.text));
});


test('only an identical rendered loop suppresses summary work, not another fact sharing its subject', () => {
  const subject = 'synthetic-shared-subject';
  const summary = { id: 'summary-loop', sessionId: 'session-loop', startedAt: input.now - 1,
    text: 'Synthetic earlier discussion', subject, openLoop: 'Synthetic unresolved follow-up' };
  const oversized = item('oversized-loop', { kind: 'promise', subject, text: 'Q'.repeat(2_000) });
  const omitted = compileMemoryBlock({ ...input, entries: [], items: [oversized], summaries: [summary] });
  assert.ok(omitted.omitted.some(value => value.id === oversized.id && value.reason === 'budget'));
  assert.ok(omitted.text.includes(summary.openLoop));
  const rendered = compileMemoryBlock({ ...input, entries: [], items: [item('rendered-loop', { kind: 'promise', subject, text: summary.openLoop })], summaries: [summary] });
  assert.ok(rendered.text.includes(summary.openLoop));
  assert.ok(rendered.text.includes(summary.text));
  assert.equal(rendered.text.split(summary.openLoop).length - 1, 1);
  const distinct = { ...summary, openLoop: 'Another synthetic unresolved follow-up' };
  const both = compileMemoryBlock({ ...input, entries: [], items: [item('same-subject-loop', { kind: 'promise', subject, text: summary.openLoop })], summaries: [distinct] });
  assert.ok(both.text.includes(summary.openLoop));
  assert.ok(both.text.includes(distinct.openLoop), 'a subject is not an identity for every unresolved fact about it');
});

test('a duplicate summary body does not erase its distinct unresolved work', () => {
  const text = 'Synthetic already-known fact';
  const loop = 'Synthetic distinct unresolved question';
  const result = compileMemoryBlock({ ...input, entries: [{ id: 'known', text }], items: [],
    summaries: [{ id: 'summary', sessionId: 'session', startedAt: input.now - 1, text, openLoop: loop }] });
  assert.equal(result.text.split(text).length - 1, 1);
  assert.ok(result.text.includes(loop));
});

test('an oversized duplicate in one part cannot mask the same fact that fits another part', () => {
  const text = 'F'.repeat(1_100);
  const result = compileMemoryBlock({ ...input, floors: true, entries: [], items: [
    item('large-loop', { kind: 'promise', authority: 'explicit_owner', text }),
    item('fitting-identity', { kind: 'durable_fact', authority: 'derived', text }),
  ] });
  assert.ok(result.selectedIds.includes('fitting-identity'));
  assert.ok(result.omitted.some(value => value.id === 'large-loop' && value.reason === 'budget'));
  assert.equal(result.text.split(text).length - 1, 1);
});

test('an omitted summary cannot suppress work from an older summary that fits', () => {
  const loop = 'Synthetic still-unresolved follow-up';
  const result = compileMemoryBlock({ ...input, entries: [], items: [], summaries: [
    { id: 'oversized', sessionId: 'large-session', startedAt: input.now - 1, text: 'B'.repeat(4_000), openLoop: loop },
    { id: 'fitting', sessionId: 'small-session', startedAt: input.now - 2, text: 'Synthetic short discussion', openLoop: loop },
  ] });
  assert.deepEqual(result.summaryIds, ['fitting']);
  assert.ok(result.text.includes(loop));
});
