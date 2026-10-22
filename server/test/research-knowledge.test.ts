import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, candidateSubs, knowledgeQuery, runResearch, shapeBlock,
  type ResearchDeps, type ResearchSourceLog, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

// Two sources, so the run plans across them instead of taking the single-source path.
const CONFIGURED: readonly SourceKind[] = ['knowledge', 'chat'];

function sub(name: string, text = 'evidence', ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Harness { deps: ResearchDeps; sources: ResearchSourceLog[]; executed: IntentSubCall[] }

function harness(opts: { execute: ResearchDeps['execute']; now?: () => number }): Harness {
  const sources: ResearchSourceLog[] = [];
  const executed: IntentSubCall[] = [];
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    configured: CONFIGURED,
    execute: opts.execute,
    emit: () => {},
    log: () => {},
    logSubcall: () => {},
    logJoined: () => {},
    logSource: entry => sources.push(entry),
    ledger: new ResearchLedger(),
  };
  return { deps, sources, executed };
}

/** A real search reply shape: the H1 header, the italic retrieval metadata, one cut hit. */
const CUT_SEARCH = [
  '# Knowledge Search',
  '_confidence: medium · mode: reranked · top score: 0.37 · relevant candidate: yes_',
  '**#123** [TECHNICAL_DECISION] Retrieval deadline',
  'the deadline is the fifteenth of the month',
  'Score: 0.467 · status: live · score: 0.37',
  'truncated: yes (5,432 chars stored)',
].join('\n');

const LONG_BODY = [
  '# Knowledge Search',
  '**#123** [TECHNICAL_DECISION] Retrieval deadline',
  `the deadline is the fifteenth${' and the corpus keeps the rest'.repeat(120)}`,
].join('\n');

test('K3: the model-authored knowledge query is clipped to ten content terms, and filler never rides', () => {
  const sentence = 'what did we decide about the wriggler three layer schema migration deadline for the owner dashboard';
  const shaped = knowledgeQuery(sentence);
  const terms = shaped.split(' ');
  assert.equal(RESEARCH.knowledgeQueryTerms, 10);
  assert.equal(terms.length, 8);
  assert.deepEqual(terms, ['decide', 'wriggler', 'three', 'layer', 'schema', 'migration', 'deadline', 'dashboard']);
  assert.ok(!terms.includes('about') && !terms.includes('owner'), 'filler is dropped before the budget is counted');
  assert.ok(!sentence.startsWith(shaped), 'the whole spoken sentence never reaches the search');
  const [call] = candidateSubs('knowledge_search', { question: sentence, configured: CONFIGURED, evidence: new Map() });
  assert.equal(String(call!.args['query']), shaped);
  const longer = 'decide wriggler three layer schema migration deadline dashboard harvester pipeline ledger';
  assert.deepEqual(knowledgeQuery(longer).split(' ').slice(-1), ['pipeline'], 'the tenth term is the last one that fits');
  assert.equal(knowledgeQuery(longer).split(' ').length, 10);
  const named = knowledgeQuery('lux meeting transcript results about', 'what did we cover in the prep call with Maria');
  assert.ok(named.split(' ').includes('maria'), 'a name the question spoke survives the clip');
});

test('K4: a known project name in the question supplies a hint, and never a hard filter', () => {
  const hinted = candidateSubs('knowledge_search', { question: 'how is the Wriggler pipeline doing', configured: CONFIGURED, evidence: new Map() });
  assert.equal(hinted[0]!.args['project_hint'], 'Wriggler');
  assert.equal('project' in hinted[0]!.args, false);
  const plain = candidateSubs('knowledge_search', { question: 'what did we decide about the retrieval deadline', configured: CONFIGURED, evidence: new Map() });
  assert.equal('project_hint' in plain[0]!.args, false);
  assert.equal('project' in plain[0]!.args, false);
});

test('K6: a question with no content words asks rather than searching filler', () => {
  assert.deepEqual(candidateSubs('knowledge_search', { question: 'what is that', configured: CONFIGURED, evidence: new Map() }), []);
  assert.equal(candidateSubs('knowledge_search', { question: 'wriggler pipeline', configured: CONFIGURED, evidence: new Map() }).length, 1);
  // A model query of one domain word survives: it is a search string, never a spoken sentence.
  const [one] = candidateSubs('knowledge_search', { question: 'who is on my team', query: 'team', configured: CONFIGURED, evidence: new Map() });
  assert.equal(one!.args['query'], 'team');
});

test('K5 and K7: the confidence line reaches the finding, and the two score scales do not', () => {
  const block = shapeBlock('knowledge_search', [sub('search_knowledge', CUT_SEARCH)]);
  assert.equal(block.lines[0], 'knowledge: confidence=medium top=0.37 candidates=yes');
  assert.ok(!block.text.includes('Score:'), 'the incomparable per-hit score line is dropped');
  assert.ok(block.lines.some(line => line.endsWith('cut at 3000 chars')), 'the search reply carries the full body window');
  const bare = shapeBlock('knowledge_search', [sub('search_knowledge', '**#9** [PATTERN] A plain hit')]);
  assert.ok(!bare.lines.some(line => line.startsWith('knowledge: confidence')));
});

test('ROUTE-1022: a body read is never clipped by the host, and the search window it asks for is 3000', () => {
  const opened = shapeBlock('knowledge_search', [sub('get_insight', LONG_BODY)]);
  assert.equal(RESEARCH.knowledgeBodyChars, 3_000);
  assert.equal(opened.lines[0]!.includes('cut at'), false, 'a body read reaches the reply whole');
  assert.equal(opened.source, 'knowledge');
  // F3: the wider window belongs to a body read. A named-id read stays whole.
  const deepBody = `${'Deep body sentence. '.repeat(400)}End of the entry.`;
  const named = shapeBlock('knowledge_search', [sub('get_insight', `### Release 3p scope [id 412]\n${deepBody}`, true, 'kr0')]);
  assert.ok(named.lines[0]!.includes('End of the entry.'), 'a named-id read is never clipped by the host');
  assert.ok(named.lines[0]!.length > RESEARCH.replyLimitChars);
  // P5-R1 holds: a search hit is bounded by the server's own window, never cut again in the host.
  const whole = 'x'.repeat(4_000);
  const searched = shapeBlock('knowledge_search', [sub('search_knowledge', `### Long insight (DECISION | 2026-10-19) [id 7]\n${whole}`)]);
  assert.ok(searched.lines[0]!.endsWith(whole));
});

test('K8: knowledge latency is stated at its measured p50, and the log carries the read span not the wait', async () => {
  assert.equal(RESEARCH.p50Seconds.knowledge, 2.9);
  let clock = 0;
  // The read runs its own span on the run's clock, and the source line is stamped from that span, never
  // from the whole run.
  const h = harness({
    now: () => clock,
    execute: async subs => { clock += 1_200; return subs.map(call => sub(call.name, CUT_SEARCH, true, call.key)); },
  });
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline' }, new AbortController().signal);
  const knowledge = h.sources.find(entry => entry.source === 'knowledge');
  assert.equal(knowledge?.ms, 1_200, 'the source line carries the read span, not the whole run');
});

// --- ROUTE-1022 (#526): one knowledge call, full bodies -----------------------------------------

// ROUTE-1022 K7: the model's own instruction words ('wait findings.', 'continue web results') reached the
// knowledge query and spent its term budget. They are stop words now, so the question's terms answer.
test('ROUTE-1022 K7: an instruction sentence is no knowledge query', () => {
  assert.equal(knowledgeQuery('wait findings.', 'wait findings.'), '', 'nothing is left to search');
  const subs = candidateSubs('knowledge_search', { question: 'wait findings.', configured: ['knowledge'], evidence: new Map() });
  assert.deepEqual(subs, [], 'a lookup of pure instruction dispatches no search');
  assert.equal(knowledgeQuery('continue web results agricon 2026', 'continue web results agricon 2026'), 'agricon 2026', 'the content terms survive');
  assert.deepEqual(candidateSubs('knowledge_search', { question: 'wait findings', query: 'wait findings.', configured: ['knowledge'], evidence: new Map() }), [],
    'an authored instruction query falls back to no search rather than a sentence');
});

test('ROUTE-1022: a knowledge question is one search call, with the full body window and no second hop', async () => {
  const executed: IntentSubCall[] = [];
  const h = harness({
    execute: async subs => subs.map(call => {
      executed.push(call);
      return sub(call.name, CUT_SEARCH, true, call.key);
    }) });
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline' }, new AbortController().signal);
  assert.equal(executed.filter(call => call.name === 'search_knowledge').length, 1, 'exactly one knowledge call');
  assert.equal(executed.filter(call => call.name === 'get_insight').length, 0, 'no get_insight hop');
  const search = executed.find(call => call.name === 'search_knowledge')!;
  assert.equal(search.args['max_chars'], RESEARCH.knowledgeBodyChars);
  assert.equal(RESEARCH.knowledgeOpenIds, 0);
});

test('ROUTE-1022: a knowledge reply that would overrun the reply budget is trimmed to the hits that fit', async () => {
  const longBody = Array.from({ length: 6 }, (_, index) => `**#${index + 1}** [PATTERN] Hit ${index} | ${'x'.repeat(2_900)}`).join('\n');
  const h = harness({ execute: async subs => subs.map(call => sub(call.name, longBody, true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline' }, new AbortController().signal);
  const bytes = JSON.stringify(reply).length;
  assert.ok(bytes <= RESEARCH.replyLimitChars, `reply bytes ${bytes} over the ${RESEARCH.replyLimitChars} budget`);
});
