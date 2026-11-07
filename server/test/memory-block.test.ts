import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryItem } from '../domain/memory-items.js';
import { compileMemoryBlock, MEMORY_BACKGROUND } from '../prompt/memory-block.js';
import { CONTEXT_BUDGET, estimatedTokens } from '../prompt/context-budget.js';

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

test('M19 D7: identity selection keeps the base outcome while accumulating once per part', () => {
  // 300 admitted candidates: the pre-M19 loop re-ran the whole selection for each one.
  const entries = Array.from({ length: 300 }, (_, index) => ({
    id: `entry-${String(index).padStart(3, '0')}`, text: `${String(index).padStart(3, '0')}${'E'.repeat(37)}`,
  }));
  const result = compileMemoryBlock({ ...input, items: [], entries });
  // The same acceptance test, applied once per candidate over the accumulating part.
  const budget = CONTEXT_BUDGET.memory.identity.ceiling;
  const expected: string[] = [];
  const rejected: string[] = [];
  let text = '# Who he is';
  for (const entry of entries) {
    const next = [text, `- ${entry.text}`].join('\n\n');
    if (estimatedTokens('\n\n' + next) > budget) { rejected.push(entry.id); continue; }
    text = next;
    expected.push(entry.id);
  }
  assert.ok(expected.length > 10 && rejected.length > 10, 'the fixture must straddle the budget boundary');
  assert.deepEqual(result.selectedIds.filter(id => id !== 'clock'), expected);
  assert.deepEqual(result.omitted.map(omitted => omitted.id), rejected);
  assert.ok(result.text.includes(text), 'the selected part text is unchanged');
});

// DREAM-1 (#940): the owner learns a durable fact in one call and must still know it at the next start.
// Legacy context records carry owner authority and a full salience, so at base they fill the identity
// budget first and every fact and preference the dreaming turn just wrote is dropped for budget.
test('coverage-first: durable facts and preferences reach the start block under legacy context pressure', () => {
  const facts = Array.from({ length: 12 }, (_, index) => item(`fact-${index}`, {
    text: `Fact ${index}: his sister Ana lives in Lisbon ${index}`, salience: 0.2 }));
  const preferences = Array.from({ length: 12 }, (_, index) => item(`pref-${index}`, {
    kind: 'preference', text: `Preference ${index}: he wants tea, never coffee ${index}`, salience: 0.2 }));
  const legacy = Array.from({ length: 60 }, (_, index) => ({
    id: `entry-${index}`, text: `Legacy context line ${index} ${'detail '.repeat(24)}`, salience: 1 }));
  const result = compileMemoryBlock({ ...input, items: [...facts, ...preferences], entries: legacy });
  for (const typed of [...facts, ...preferences]) assert.ok(result.selectedIds.includes(typed.id), `${typed.id} must reach the start block`);
  assert.equal(result.omitted.filter(value => value.reason === 'budget' && /^(fact|pref)-/.test(value.id)).length, 0);
  assert.ok(estimatedTokens(result.text) <= CONTEXT_BUDGET.sections.memory.ceiling);
});

test('a plan the clock has passed is never selected and ranks no better than the nearest dated loop', () => {
  const day = 86_400_000;
  const result = compileMemoryBlock({ ...input, items: [
    item('expired-plan', { kind: 'plan', eventAt: now - day, text: 'Old plan: he flies to Phuket' }),
    item('tomorrow-plan', { kind: 'plan', eventAt: now + day, text: 'Tomorrow plan: he drives to Bogor' }),
    item('undated-loop', { kind: 'transient_state', eventAt: null, text: 'Undated state: the kitchen tap leaks' }),
  ] });
  assert.ok(!result.selectedIds.includes('expired-plan'));
  assert.ok(result.omitted.some(value => value.id === 'expired-plan' && value.reason === 'expired'));
  assert.ok(result.text.indexOf('Tomorrow plan') < result.text.indexOf('Undated state'), 'the nearer plan outranks the undated equal-salience loop');
});

test('the selector accounting matches the composed block size it actually renders', () => {
  const items = Array.from({ length: 40 }, (_, index) => item(`acc-${index}`, { text: `Accounting fixture line ${index} ${'word '.repeat(12)}`, salience: 1 }));
  const result = compileMemoryBlock({ ...input, items });
  const accounting = result.parts.reduce((sum, part) => sum + part.estimatedTokens, 0);
  const composed = estimatedTokens(result.text);
  assert.ok(Math.abs(accounting - composed) <= composed * 0.05, `accounting ${accounting} vs composed ${composed}`);
});

test('an allowance tighter than the composed memory section drops the lowest ranked whole item', () => {
  const items = Array.from({ length: 40 }, (_, index) => item(`tight-${index}`, { text: `Tight fixture line ${index} ${'word '.repeat(12)}`, salience: 1 - index / 100 }));
  const roomy = compileMemoryBlock({ ...input, items });
  const tight = compileMemoryBlock({ ...input, items, allowanceTokens: 400 });
  assert.ok(estimatedTokens(tight.text) <= 400);
  assert.ok(tight.selectedIds.length < roomy.selectedIds.length);
  assert.ok(tight.omitted.some(value => value.reason === 'budget') || tight.selectedIds.length === 0);
});

// Review B1: the trim dropped `ranked[last]`, and a summary is always pushed last, so the rebuilt block
// was identical and the loop never ended. A start that overruns computes an allowance near 0, so this
// path is the one every overrunning call takes.
test('an allowance tighter than the whole block ends with summaries selected and never cuts an item', () => {
  const summaries = [{ id: 'summary-a', sessionId: 'sess-a', startedAt: now - 3_600_000,
    text: 'Yesterday he asked about the boiler repair and the plumber rang back', openLoop: 'chase the plumber invoice' }];
  const items = [item('fact-a', { text: 'Fact: his sister Ana lives in Lisbon' })];
  const result = compileMemoryBlock({ ...input, items, summaries, allowanceTokens: 60 });
  assert.ok(estimatedTokens(result.text) <= 60, `composed ${estimatedTokens(result.text)} tokens exceeds the allowance`);
  assert.equal(result.summaryIds.length, 0);
  assert.ok(result.omitted.some(value => value.id === 'summary-a'));
});

// Review M2: one pooled coverage share let a burst of long preferences spend it all and evict the facts,
// which is the DREAM-1 symptom one level down. Each covered kind keeps its own bounded share.
test('a burst of long preferences cannot spend the coverage share and evict the durable facts', () => {
  const long = (index: number): string => `Preference ${index}: ` + `he insists on the same routine here ${index} `.repeat(6);
  const preferences = Array.from({ length: 12 }, (_, index) => item(`longpref-${index}`, {
    kind: 'preference', text: long(index), salience: 0.9 }));
  const facts = Array.from({ length: 12 }, (_, index) => item(`burst-fact-${index}`, {
    text: `Fact ${index}: his sister Ana lives in Lisbon ${index}`, salience: 0.2 }));
  const result = compileMemoryBlock({ ...input, items: [...preferences, ...facts] });
  for (const fact of facts) assert.ok(result.selectedIds.includes(fact.id), `${fact.id} must survive the preference burst`);
  assert.ok(result.omitted.some(value => value.reason === 'budget'));
  assert.ok(estimatedTokens(result.text) <= CONTEXT_BUDGET.sections.memory.ceiling);
});
