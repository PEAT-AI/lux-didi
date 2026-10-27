import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ResearchLedger, companyMetricSubs, configuredSourcesForEndpoints, fallbackSelection, metricWindow, requiredSources,
  researchSourcesForEndpoint, routedSelection, runResearch, shapeBlock,
  type ConfiguredEndpointStatus, type ResearchDeps, type ResearchSourceLog, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { renderMongooseTool } from '../tools/mongoose.js';

/**
 * The literal live shapes of the Mongoose data endpoint, captured 2026-10-27 00:55Z (see the fixture's
 * own provenance line). The test replays them; it never invents a schema or a row.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = [join(HERE, 'fixtures/mongoose-data-live.json'), join(HERE, '../../test/fixtures/mongoose-data-live.json')]
  .find(candidate => existsSync(candidate));
if (FIXTURE === undefined) throw new Error('mongoose-data-live fixture missing');
const LIVE = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  search_fields_result: { status: string; fields: string[]; total: number; has_more: boolean; format: string };
  run_metric_query_call: { name: string; arguments: { title: string; description: string; queryConfig: Record<string, unknown> } };
  run_metric_query_result: Record<string, unknown>;
  trap_observed: string;
};

/** The endpoint's own filter operator enum, from the tool list it published (captured 2026-10-27). */
const PUBLISHED_OPERATORS: readonly string[] = (JSON.parse(readFileSync(join(process.cwd(), 'server/test/fixtures/mongoose-tools-list-literal.json'), 'utf8')) as {
  data: { name: string; inputSchema: { $defs: Record<string, { properties: { operator: { enum: string[] } } }> } }[];
}).data.find(tool => tool.name === 'run_metric_query')?.inputSchema.$defs['s57dd195e34']?.properties.operator.enum ?? [];

/** 26 Oct 2026, the morning after the last day the fixture loaded (25 Oct). */
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const CONFIGURED: readonly SourceKind[] = ['data'];

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Harness { deps: ResearchDeps; executed: IntentSubCall[] }

function harness(execute: (subs: readonly IntentSubCall[]) => Promise<IntentSubResult[]>, configured: readonly SourceKind[] = CONFIGURED): Harness {
  const executed: IntentSubCall[] = [];
  const sources: ResearchSourceLog[] = [];
  const deps: ResearchDeps = {
    now: () => NOW,
    configured,
    execute: async subs => { executed.push(...subs); return execute(subs); },
    emit: () => {},
    log: () => {},
    logSubcall: () => {},
    logJoined: () => {},
    logSource: entry => sources.push(entry),
    ledger: new ResearchLedger(),
  };
  return { deps, executed };
}

/** The fake data endpoint: `search_fields` answers the live field list, `run_metric_query` the live rows. */
function fakeDataEndpoint(calls: readonly IntentSubCall[]): Promise<IntentSubResult[]> {
  return Promise.resolve(calls.map(call => {
    if (call.name === 'search_fields') return sub(call.name, JSON.stringify(LIVE.search_fields_result), true, call.key);
    if (call.name === 'run_metric_query') return sub(call.name, JSON.stringify(LIVE.run_metric_query_result), true, call.key);
    return sub(call.name, '', false, call.key);
  }));
}

test('a number question runs search_fields then run_metric_query on the data endpoint', async () => {
  const h = harness(fakeDataEndpoint);
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'how many users in Indonesia yesterday',
    topic: 'active users Indonesia',
    lookups: [{ source: 'data', query: 'active users Indonesia yesterday' }],
  }, new AbortController().signal);
  assert.deepEqual(h.executed.map(call => call.name), ['search_fields', 'run_metric_query'],
    `the data read is the two calls the live endpoint answers: ${JSON.stringify(h.executed.map(call => call.name))}`);
  const metric = h.executed.find(call => call.name === 'run_metric_query');
  const config = (metric?.args['queryConfig'] ?? {}) as Record<string, unknown>;
  assert.equal(config['exploreName'], 'active_users_daily', 'the published explore name, never a guess');
  assert.deepEqual(config['metrics'], ['active_users_daily_n_active_users']);
  assert.deepEqual(config['dimensions'], ['active_users_daily_event_date_day'], 'a count carries a date dimension');
  const filters = (config['filters'] ?? {}) as { dimensions?: { fieldId: string; operator: string; values: unknown[] }[] };
  const country = filters.dimensions?.find(entry => entry.fieldId === 'active_users_daily_country');
  const window = filters.dimensions?.find(entry => entry.fieldId === 'active_users_daily_event_date_day');
  assert.ok(country && country.operator === 'equals' && country.values.includes('Indonesia'), 'the country filter');
  assert.ok(window && window.operator === 'inBetween', `the date window is the resolved between filter: ${JSON.stringify(window)}`);
  assert.ok(PUBLISHED_OPERATORS.includes(window.operator),
    `the operator the endpoint published: ${window.operator} of ${PUBLISHED_OPERATORS.join(', ')}`);
  assert.deepEqual(window.values, ['2026-10-25', '2026-10-25'], 'yesterday, as the inclusive day the ask named');
  assert.match(JSON.stringify(reply['findings']), /2026-10-25/u, 'the spoken result carries the latest loaded day');
});

test('an undated count is refused with count_needs_date_window, never dispatched', async () => {
  const h = harness(fakeDataEndpoint);
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'how many users in Indonesia',
    topic: 'active users Indonesia',
    lookups: [{ source: 'data', query: 'active users Indonesia' }],
  }, new AbortController().signal);
  assert.equal(h.executed.filter(call => call.name === 'run_metric_query').length, 0,
    'the undated all-time sum never reaches the endpoint');
  const spoken = JSON.stringify(reply);
  assert.match(spoken, /count_needs_date_window/u, `the closed code: ${spoken}`);
  assert.match(spoken, /ask the owner which window to use/u, 'the repair asks the owner for a window she can express');
  assert.match(spoken, /last month/u, 'and names the windows she can use');
  assert.match(spoken, /year to date/u);
});

test('the count guard refuses an undated metric query at the argument boundary', () => {
  const dated = companyMetricSubs('active users Indonesia yesterday', 'how many users in Indonesia yesterday', NOW);
  assert.ok('subs' in dated && dated.subs.length === 2);
  const undated = companyMetricSubs('active users Indonesia', 'how many users in Indonesia', NOW);
  assert.deepEqual(undated, { refusal: 'count_needs_date_window' });
});

test('the metric result names its latest day, not only the number', () => {
  const projected = renderMongooseTool(LIVE.run_metric_query_result);
  assert.match(projected.text, /2026-10-25/u, 'the rows reach the projection with their date');
  assert.match(projected.text, /2424/u, 'and with their value');
  const shaped = shapeBlock('company_metric', [sub('run_metric_query', projected.text)]);
  assert.equal(shaped.source, 'data');
  assert.match(shaped.text, /2026-10-25/u);
  assert.match(shaped.text, /latest day loaded/u);
});

function endpoint(id: string, state: string, reasonCode?: string): ConfiguredEndpointStatus {
  return { id, connector: 'mongoose', state, ...(reasonCode === undefined ? {} : { reasonCode }) };
}

test('an unsigned crm endpoint hides neither the knowledge nor the data source', () => {
  assert.deepEqual(researchSourcesForEndpoint(endpoint('mongoose-crm', 'configured', 'not_signed_in')), [],
    'crm is not a research source');
  const sources = configuredSourcesForEndpoints([
    endpoint('mongoose-knowledge', 'connected'), endpoint('mongoose-data', 'connected'), endpoint('mongoose-crm', 'configured', 'not_signed_in'),
  ]);
  assert.deepEqual(sources, [], 'no source is marked unreachable');
});

test('a connecting knowledge endpoint leaves data available, and the reverse holds', () => {
  const knowledgeDown = configuredSourcesForEndpoints([
    endpoint('mongoose-knowledge', 'configured', 'not_signed_in'), endpoint('mongoose-data', 'connected'),
  ]);
  assert.deepEqual(knowledgeDown.map(entry => entry.source), ['mongoose'], 'only knowledge is unreachable');
  const dataDown = configuredSourcesForEndpoints([
    endpoint('mongoose-knowledge', 'connected'), endpoint('mongoose-data', 'configured', 'not_signed_in'),
  ]);
  assert.deepEqual(dataDown.map(entry => entry.source), ['data'], 'only data is unreachable');
});

/**
 * The count windows, asserted on one fixed `now`: the moment the owner's failed ask ran. The dates are the
 * inclusive days the data endpoint's `inBetween` filter takes.
 */
const WINDOW_NOW = Date.parse('2026-10-27T07:02:00Z');

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
    assert.deepEqual(metricWindow(item.question, WINDOW_NOW), { start: item.start, end: item.end });
  });
}

test('a count with no readable window resolves to nothing, so the count is refused', () => {
  assert.equal(metricWindow('how many users in Indonesia', WINDOW_NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia ever', WINDOW_NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia all time', WINDOW_NOW), undefined);
});

test('an out-of-range day count is no window, never a silent read of today', () => {
  assert.equal(metricWindow('how many users in Indonesia last 400 days', WINDOW_NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia last 0 days', WINDOW_NOW), undefined);
});

test('the last month count is the published inBetween filter the live fixture carries', () => {
  const subs = companyMetricSubs('active users Indonesia last month', 'how many users we had in Indonesia last month', WINDOW_NOW);
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
  const refused = companyMetricSubs('active users Indonesia', 'how many users in Indonesia without a date', WINDOW_NOW);
  assert.deepEqual(refused, { refusal: 'count_needs_date_window' });
});

test('a count question naming users is routed to the data endpoint', () => {
  const question = 'how many users we had in Indonesia last month';
  assert.deepEqual(requiredSources(question), ['data'], 'the data route, not the knowledge default');
  const configured: readonly SourceKind[] = ['knowledge', 'data'];
  const selection = routedSelection(question, configured, WINDOW_NOW);
  assert.ok(selection, 'the route is deterministic');
  assert.ok(selection.actions.some(action => action.kind === 'company_metric'), `the count candidate: ${JSON.stringify(selection.actions)}`);
  const fallback = fallbackSelection(question, configured, WINDOW_NOW);
  assert.ok(fallback.actions.some(action => action.kind === 'company_metric'), 'and the keyword fallback offers it too');
});

test('a knowledge ask about numbers still reads knowledge, which the count route does not claim', () => {
  assert.deepEqual(requiredSources('what did we decide about the user growth plan'), []);
  assert.ok(fallbackSelection('what did we decide about the user growth plan', ['knowledge']).actions
    .some(action => action.kind === 'knowledge_search'));
});
