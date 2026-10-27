import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ResearchLedger, companyMetricSubs, configuredSourcesForEndpoints, researchSourcesForEndpoint, runResearch, shapeBlock,
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
  assert.ok(window && window.operator === 'between', `the date window is the resolved between filter: ${JSON.stringify(window)}`);
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
  assert.match(spoken, /refused this count/u, 'the one-line repair');
  assert.match(spoken, /ask the owner/u, 'the repair asks the owner for a window she can express');
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
