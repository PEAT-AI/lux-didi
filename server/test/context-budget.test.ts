import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_BUDGET, estimatedTokens, selectWholeItems } from '../prompt/context-budget.js';

test('startup floors fit the target and optional ceilings retain hard-admission headroom', () => {
  assert.deepEqual(CONTEXT_BUDGET.sections.memory, { ceiling: 2_500, floor: 1_800 });
  assert.deepEqual(CONTEXT_BUDGET.memory, {
    now: { ceiling: 100, floor: 100 }, identity: { ceiling: 800, floor: 500 },
    loops: { ceiling: 600, floor: 350 }, conversations: { ceiling: 1_000, floor: 800 },
  });
  assert.equal(CONTEXT_BUDGET.target, 9_000);
  assert.equal(CONTEXT_BUDGET.hard, 14_000);
  assert.ok(Object.values(CONTEXT_BUDGET.sections).reduce((sum, section) => sum + section.floor, 0) <= CONTEXT_BUDGET.target);
  assert.ok(Object.values(CONTEXT_BUDGET.sections).reduce((sum, section) => sum + section.ceiling, 0) < CONTEXT_BUDGET.hard);
  assert.equal(estimatedTokens('x'.repeat(32)), 10);
  assert.equal(estimatedTokens('x'), 1);
});

test('whole-item selection charges headings and separators and never clips content', () => {
  const selected = selectWholeItems('Heading', [{ id: 'large', text: 'x'.repeat(80) }, { id: 'small', text: 'whole item' }], 15);
  assert.deepEqual(selected.selectedIds, ['small']);
  assert.deepEqual(selected.omitted, [{ id: 'large', reason: 'budget' }]);
  assert.equal(selected.text, 'Heading\n\nwhole item');
  assert.ok(estimatedTokens(selected.text) <= 15);
});
