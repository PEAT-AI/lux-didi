import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  companyMetricSubs, fallbackSelection, metricWindow, requiredSources, routedSelection, type SourceKind,
} from '../tools/research.js';

/**
 * W3: the count windows. Every case reads the same `now` the owner's failed ask ran at, and the dates are
 * the inclusive days the data endpoint's `inBetween` filter takes. Conventions under test: `last N days` ends
 * today and starts N-1 days back; `last N months` ends today and starts the same day-of-month N months back;
 * `this X` ends today, `last X` is the whole previous period; a named month, quarter or year without one means
 * its most recent occurrence that has already begun.
 */
const NOW = Date.parse('2026-10-27T07:02:00Z');

const CASES: readonly { question: string; start: string; end: string; convention?: string }[] = [
  { question: 'how many users we had in Indonesia last month', start: '2026-09-01', end: '2026-09-30' },
  { question: 'how many users in Indonesia in September', start: '2026-09-01', end: '2026-09-30' },
  { question: 'how many users in Indonesia in September 2026', start: '2026-09-01', end: '2026-09-30' },
  { question: 'how many users in Indonesia in September 2025', start: '2025-09-01', end: '2025-09-30' },
  { question: 'how many users in Indonesia in Sept', start: '2026-09-01', end: '2026-09-30' },
  // A month with no year that has not begun yet means last year's occurrence.
  { question: 'how many users in Indonesia in December', start: '2025-12-01', end: '2025-12-31' },
  { question: 'how many users in Indonesia this month', start: '2026-10-01', end: '2026-10-27' },
  { question: 'how many users in Indonesia last quarter', start: '2026-07-01', end: '2026-09-30' },
  { question: 'how many users in Indonesia this quarter', start: '2026-10-01', end: '2026-10-27' },
  { question: 'how many users in Indonesia in Q1 2026', start: '2026-01-01', end: '2026-03-31' },
  { question: 'how many users in Indonesia in Q4', start: '2026-10-01', end: '2026-10-27' },
  { question: 'how many users we had this year', start: '2026-01-01', end: '2026-10-27' },
  { question: 'how many users we had year to date', start: '2026-01-01', end: '2026-10-27' },
  { question: 'how many users we had last year', start: '2025-01-01', end: '2025-12-31' },
  { question: 'how many users we had in 2025', start: '2025-01-01', end: '2025-12-31' },
  // The month convention, stated where the window is asserted: N months back, same day-of-month, ending today.
  { question: 'how many users in Indonesia last 3 months', start: '2026-07-27', end: '2026-10-27', convention: 'last N months ends today and starts the same day-of-month N months back' },
  { question: 'how many users in Indonesia last 30 days', start: '2026-09-28', end: '2026-10-27', convention: 'last N days ends today and starts N-1 days back' },
  { question: 'how many users in Indonesia today', start: '2026-10-27', end: '2026-10-27' },
  { question: 'how many users in Indonesia yesterday', start: '2026-10-26', end: '2026-10-26' },
  { question: 'how many users in Indonesia this week', start: '2026-10-26', end: '2026-10-27' },
  { question: 'how many users in Indonesia last week', start: '2026-10-19', end: '2026-10-25' },
];

for (const item of CASES) {
  test(`the window of "${item.question}" is ${item.start}..${item.end}${item.convention === undefined ? '' : ` (${item.convention})`}`, () => {
    assert.deepEqual(metricWindow(item.question, NOW), { start: item.start, end: item.end });
  });
}

test('a count with no readable window resolves to nothing, so the count is refused', () => {
  assert.equal(metricWindow('how many users in Indonesia', NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia ever', NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia all time', NOW), undefined);
});

test('an out-of-range day count is no window, never a silent read of today', () => {
  assert.equal(metricWindow('how many users in Indonesia last 400 days', NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia last 0 days', NOW), undefined);
});

test('the last month count is the published inBetween filter the live fixture carries', () => {
  const subs = companyMetricSubs('active users Indonesia last month', 'how many users we had in Indonesia last month', NOW);
  assert.ok('subs' in subs, 'the count is dispatched');
  const metric = subs.subs.find(call => call.name === 'run_metric_query');
  const config = (metric?.args['queryConfig'] ?? {}) as Record<string, unknown>;
  const filters = (config['filters'] ?? {}) as { dimensions?: { fieldId: string; operator: string; values: unknown[] }[]; type?: string };
  assert.equal(filters.type, 'and', 'the fixture filter shape');
  const country = filters.dimensions?.find(entry => entry.fieldId === 'active_users_daily_country');
  assert.deepEqual(country, { fieldId: 'active_users_daily_country', operator: 'equals', values: ['Indonesia'] });
  const window = filters.dimensions?.find(entry => entry.fieldId === 'active_users_daily_event_date_day');
  assert.deepEqual(window, {
    fieldId: 'active_users_daily_event_date_day', operator: 'inBetween', values: ['2026-09-01', '2026-09-30'],
  }, 'the September window, in the shape the endpoint published');
});

test('an undated count is the closed refusal, and nothing reaches the endpoint', () => {
  const refused = companyMetricSubs('active users Indonesia', 'how many users in Indonesia without a date', NOW);
  assert.deepEqual(refused, { refusal: 'count_needs_date_window' });
});

test('a count question naming users is routed to the data endpoint', () => {
  const question = 'how many users we had in Indonesia last month';
  assert.deepEqual(requiredSources(question), ['data'], 'the data route, not the knowledge default');
  const configured: readonly SourceKind[] = ['knowledge', 'data'];
  const selection = routedSelection(question, configured, NOW);
  assert.ok(selection, 'the route is deterministic');
  assert.ok(selection.actions.some(action => action.kind === 'company_metric'), `the count candidate: ${JSON.stringify(selection.actions)}`);
  const fallback = fallbackSelection(question, configured, NOW);
  assert.ok(fallback.actions.some(action => action.kind === 'company_metric'), 'and the keyword fallback offers it too');
});

test('a knowledge ask about numbers still reads knowledge, which the count route does not claim', () => {
  assert.deepEqual(requiredSources('what did we decide about the user growth plan'), []);
  assert.ok(fallbackSelection('what did we decide about the user growth plan', ['knowledge']).actions
    .some(action => action.kind === 'knowledge_search'));
});
