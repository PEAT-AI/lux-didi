import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryItem } from '../domain/memory-items.js';
import { compileMemoryBlock, omissionRecord } from '../prompt/memory-block.js';
import { CONTEXT_BUDGET, estimatedTokens } from '../prompt/context-budget.js';

const now = Date.UTC(2026, 10, 6, 17);
const item = (id: string, patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id, kind: 'durable_fact', text: `Synthetic fact ${id}`, subject: id, validFrom: now - 1000,
  validUntil: null, eventAt: null, eventTz: null, eventText: null, place: null,
  authority: 'derived', status: 'active', supersededBy: null, salience: 0.5,
  createdAt: now - 1000, createdBy: 'synthetic', generation: 1, ...patch,
});
const input = { now, timeZone: 'Asia/Jakarta', clock: 'Saturday 7 November 2026, 00:00', entries: [], summaries: [] };

// L6 (#940): 1,557 omission lines in five call starts. The start reports its omissions once, by reason
// and kind, and still names what it selected so a later diagnosis can follow the block forward.
test('one aggregated omission record per start block carries counts by reason and kind plus the selected ids', () => {
  const day = 86_400_000;
  const facts = Array.from({ length: 12 }, (_, index) => item(`fact-${index}`, {
    text: `Fact ${index}: his sister Ana lives in Lisbon ${index}`, salience: 0.2 }));
  const preferences = Array.from({ length: 12 }, (_, index) => item(`pref-${index}`, {
    kind: 'preference', text: `Preference ${index}: he wants tea, never coffee ${index}`, salience: 0.2 }));
  const legacy = Array.from({ length: 60 }, (_, index) => ({
    id: `entry-${index}`, text: `Legacy context line ${index} ${'detail '.repeat(24)}`, salience: 1 }));
  const block = compileMemoryBlock({ ...input, items: [
    ...facts, ...preferences,
    item('expired-plan', { kind: 'plan', eventAt: now - day, text: 'Old plan: he flies to Phuket' }),
    item('duplicate', { text: 'Fact 0: his sister Ana lives in Lisbon 0' }),
  ], entries: legacy });
  const kindOf = (id: string) => [...facts, ...preferences, item('expired-plan', { kind: 'plan', eventAt: now - day })].find(candidate => candidate.id === id)?.kind;
  const record = omissionRecord({ ...block, kindOf });
  assert.equal(record.event, 'live_context_items_omitted');
  assert.equal(record.omitted, block.omitted.length);
  assert.equal(record.selected, block.selectedIds.length);
  assert.deepEqual(record.selectedIds, block.selectedIds);
  assert.equal(record.reasons.expired, 1);
  assert.equal(record.reasons.duplicate, 1);
  assert.ok(record.reasons.budget > 0);
  assert.equal(record.kinds.plan, 1);
  assert.equal(Object.values(record.reasons).reduce((sum, count) => sum + count, 0), block.omitted.length);
  assert.ok(estimatedTokens(block.text) <= CONTEXT_BUDGET.sections.memory.ceiling);
});

test('the aggregated record is content free and counts only the kinds the memory store writes', () => {
  const block = compileMemoryBlock({ ...input, items: [
    item('fact-a', { text: 'Fact: he moved to Lisbon' }),
    item('plan-a', { kind: 'plan', eventAt: now + 86_400_000, text: 'Plan: he drives to Bogor' }),
  ] });
  const record = omissionRecord({ ...block, kindOf: () => 'durable_fact' });
  assert.equal(JSON.stringify(record).includes('Lisbon'), false);
  for (const kind of Object.keys(record.kinds)) assert.ok(['durable_fact', 'preference', 'person_role', 'transient_state', 'plan', 'promise', 'open_question', 'correction', 'decision'].includes(kind), kind);
  assert.deepEqual(record.kinds, {});
});

// Review M3: a busy start built more than 128 selected ids, host/log.ts rejected the record and the
// single L6 line vanished with nothing replacing it. The record now caps the ids and states the drop.
test('the aggregated record survives a busy start by capping its ids and stating the truncation', () => {
  const block = compileMemoryBlock({ ...input, items: [
    item('fact-a', { text: 'Fact: his sister Ana lives in Lisbon' }),
    item('fact-b', { kind: 'preference', text: 'Preference: he wants tea, never coffee' }),
  ] });
  const selectedIds = Array.from({ length: 200 }, (_, index) => `record-${index}`);
  const record = omissionRecord({ ...block, selectedIds, kindOf: () => 'durable_fact' });
  assert.equal(record.selected, 200);
  assert.equal(record.selectedIds.length, 128);
  assert.equal(record.selectedTruncated, 72);
  assert.deepEqual(record.selectedIds, selectedIds.slice(0, 128));
  const small = omissionRecord({ ...block, kindOf: () => 'durable_fact' });
  assert.deepEqual(small.selectedIds, block.selectedIds);
  assert.equal(small.selectedTruncated, 0);
});
