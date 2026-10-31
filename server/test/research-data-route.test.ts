import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ResearchLedger, candidateSubs, companyMetricSubs, companySubs, configuredSourcesForEndpoints, dataReplySubs, fallbackSelection,
  metricWindow, requiredSources,
  researchSourcesForEndpoint, routedSelection, runResearch, shapeBlock,
  type ConfiguredEndpointStatus, type ResearchDeps, type ResearchSourceLog, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { renderMongooseTool } from '../tools/mongoose.js';

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

/**
 * The fake data endpoint at the served shape: `ask_data_agent` answers with a job, `data_agent_job` reads it.
 * `jobReplies` is the queue of job envelopes this endpoint hands back, in call order.
 */
function fakeDataEndpoint(jobReplies: string[]): (calls: readonly IntentSubCall[]) => Promise<IntentSubResult[]> {
  return (calls: readonly IntentSubCall[]) => Promise.resolve(calls.map(call => {
    // The projection is what the research layer reads, so the fake answers with the projected envelope.
    if (call.name === 'ask_data_agent' || call.name === 'data_agent_job') {
      const envelope = JSON.parse(jobReplies.shift() ?? JOB_ANSWERED) as Record<string, unknown>;
      return sub(call.name, renderMongooseTool(envelope).text, true, call.key);
    }
    return sub(call.name, '', false, call.key);
  }));
}

const JOB_RUNNING = JSON.stringify({ job_id: 'job-7', status: 'running', next_step: null, request_id: 'req-7' });
const JOB_NEEDS_REPLY = JSON.stringify({ job_id: 'job-7', status: 'needs_reply', clarification: 'Which country do you mean?', request_id: 'req-7' });
const JOB_ANSWERED = JSON.stringify({
  job_id: 'job-7', status: 'answered', answer_number: 2424,
  definition: 'daily active users on the latest loaded day', assumptions: ['one row per user per day'],
  request_id: 'req-7',
});

test('#641: a KPI question reaches ask_data_agent verbatim and returns the job answer after a running poll', async () => {
  const h = harness(fakeDataEndpoint([JOB_RUNNING, JOB_ANSWERED]));
  const question = 'how many users in Indonesia yesterday';
  const reply = await runResearch(h.deps, {
    action: 'start',
    question,
    topic: 'active users Indonesia',
    lookups: [{ source: 'data', query: 'active users Indonesia yesterday' }],
  }, new AbortController().signal);
  const names = h.executed.map(call => call.name);
  assert.equal(names.includes('run_metric_query') || names.includes('search_fields'), false,
    'the retired Lightdash field search and metric query are never dispatched');
  assert.deepEqual(h.executed.filter(call => call.name === 'ask_data_agent')[0]?.args, { question },
    "the owner's question goes to the agent verbatim");
  assert.deepEqual(h.executed.filter(call => call.name === 'data_agent_job')[0]?.args, { job_id: 'job-7', op: 'get' },
    'a running job is read again by its id');
  const spoken = JSON.stringify(reply);
  assert.match(spoken, /2424/u, `the job's answer reaches the reply: ${spoken}`);
  assert.match(spoken, /daily active users on the latest loaded day/u, 'with its definition beside it');
});

test('#641: a needs_reply clarification is put back to the owner, and the answer returns to the same job', async () => {
  const h = harness(fakeDataEndpoint([JOB_NEEDS_REPLY]));
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'how many users in Indonesia yesterday',
    topic: 'active users Indonesia',
    lookups: [{ source: 'data', query: 'active users Indonesia yesterday' }],
  }, new AbortController().signal);
  const spoken = JSON.stringify(reply);
  assert.match(spoken, /Which country do you mean\?/u, `the clarification is said word for word: ${spoken}`);
  const run = h.deps.ledger.find(String(reply['researchId']));
  assert.deepEqual(run?.dataJob, { jobId: 'job-7', awaitingOwner: true }, 'the run remembers the job it owes an answer');
  // The owner's own words are what goes back: no rephrasing, no second question to the agent.
  assert.deepEqual(dataReplySubs('job-7', 'Indonesia'), [
    { key: 'm0', name: 'data_agent_job', args: { job_id: 'job-7', op: 'reply', text: 'Indonesia' } },
  ]);
});

test('#641: a coverage question asks the data capability router before it reads the corpus', () => {
  const subs = companySubs('do we have forecast coverage for rice in Indonesia', 'do we have forecast coverage for rice in Indonesia');
  assert.equal(subs[0]?.name, 'check_data_capability', `the router is asked first: ${JSON.stringify(subs)}`);
  assert.deepEqual(subs[0]?.args, { countries: ['Indonesia'], needs_forecast: true });
  assert.equal(subs.at(-1)?.name, 'search', 'and the corpus read follows it');
});

test('the KPI route carries no Lightdash metric query and no field search', () => {
  const subs = companyMetricSubs('how many active users in Indonesia yesterday').subs;
  assert.deepEqual(subs.map(call => call.name), ['ask_data_agent']);
  assert.equal(JSON.stringify(subs).includes('run_metric_query'), false);
  assert.equal(JSON.stringify(subs).includes('search_fields'), false);
});

test('the job answer reaches the projection with its status, number, definition and assumptions', () => {
  const projected = renderMongooseTool(JSON.parse(JOB_ANSWERED));
  assert.match(projected.text, /^job job-7 status=answered/u, `the machine line leads: ${projected.text}`);
  assert.match(projected.text, /2424/u, 'the answer number is carried');
  assert.match(projected.text, /one row per user per day/u, 'and its assumptions');
  const shaped = shapeBlock('company_metric', [sub('ask_data_agent', projected.text)]);
  assert.equal(shaped.source, 'data', 'the answer is attributed to the numbers source');
});

test('a running job is never presented as an answer', () => {
  const projected = renderMongooseTool(JSON.parse(JOB_RUNNING));
  assert.match(projected.text, /^job job-7 status=running/u);
  assert.doesNotMatch(projected.text, /answer_number/u, 'a running job carries no number to say');
});

test('a needs_reply job says the clarification word for word', () => {
  const projected = renderMongooseTool(JSON.parse(JOB_NEEDS_REPLY));
  assert.match(projected.text, /^job job-7 status=needs_reply/u);
  assert.match(projected.text, /clarification: Which country do you mean\?/u);
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
  // `may` and `march` are ordinary English words: a preposition or a year is what makes them a month.
  { question: 'how many users in Indonesia in May', start: '2026-05-01', end: '2026-05-31' },
  { question: 'how many users in Indonesia in May 2025', start: '2025-05-01', end: '2025-05-31' },
  { question: 'how many users in Indonesia in March', start: '2026-03-01', end: '2026-03-31' },
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

test('an ambiguous month word that names no month resolves to no window, so the ask is refused', () => {
  // At base both asks were refused; a confident May or March here would be a number nobody asked for.
  assert.equal(metricWindow('how many users may we have in Indonesia', WINDOW_NOW), undefined);
  assert.equal(metricWindow('how many users march through onboarding in Indonesia', WINDOW_NOW), undefined);
});

test('an out-of-range day count is no window, never a silent read of today', () => {
  assert.equal(metricWindow('how many users in Indonesia last 400 days', WINDOW_NOW), undefined);
  assert.equal(metricWindow('how many users in Indonesia last 0 days', WINDOW_NOW), undefined);
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

test('the contract\'s own phrasing, "users in Indonesia last month", reaches the data route and dispatches September', () => {
  // The word "users" plus a window the resolver reads is a count ask, whether or not it says "how many".
  for (const question of ['users in Indonesia last month', "what's the number of users in Indonesia last month"]) {
    assert.deepEqual(requiredSources(question), ['data'], `the data route: ${question}`);
    const configured: readonly SourceKind[] = ['knowledge', 'data'];
    const selection = routedSelection(question, configured, WINDOW_NOW);
    assert.ok(selection?.actions.some(action => action.kind === 'company_metric'), `the count candidate: ${question}`);
    assert.ok(fallbackSelection(question, configured, WINDOW_NOW).actions
      .some(action => action.kind === 'company_metric'), `and the keyword fallback: ${question}`);
  }
  const subs = candidateSubs('company_metric', {
    question: 'users in Indonesia last month', topic: 'users Indonesia last month', configured: ['data'],
    evidence: new Map(), nowMs: WINDOW_NOW,
  });
  assert.deepEqual(subs.map(call => call.name), ['ask_data_agent'], 'the one call the endpoint answers a count with');
  assert.deepEqual(subs[0]?.args, { question: 'users in Indonesia last month' },
    "the owner's words go to the agent verbatim, window and all");
});

test('a knowledge ask about numbers still reads knowledge, which the count route does not claim', () => {
  assert.deepEqual(requiredSources('what did we decide about the user growth plan'), []);
  assert.ok(fallbackSelection('what did we decide about the user growth plan', ['knowledge']).actions
    .some(action => action.kind === 'knowledge_search'));
});
