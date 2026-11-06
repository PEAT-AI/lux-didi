import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_BUDGET, estimatedTokens, selectWholeItems } from '../prompt/context-budget.js';

test('startup allocation fits the estimated target and retains hard-admission headroom', () => {
  assert.equal(CONTEXT_BUDGET.target, 9_000);
  assert.equal(CONTEXT_BUDGET.hard, 14_000);
  assert.ok(Object.values(CONTEXT_BUDGET.sections).reduce((sum, section) => sum + section.ceiling, 0) <= CONTEXT_BUDGET.target);
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
