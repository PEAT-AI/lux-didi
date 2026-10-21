import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, candidateSubs, knowledgeHydrateIds, knowledgeQuery, runResearch, shapeBlock,
  type ResearchDeps, type ResearchSourceLog, type ResearchSelector, type SelectorOutput, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

// Two sources: with one configured source the run takes the deterministic single-source path and the
// selector is never called, which is not the path this suite is about.
const CONFIGURED: readonly SourceKind[] = ['knowledge', 'chat'];

function sub(name: string, text = 'evidence', ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Harness { deps: ResearchDeps; sources: ResearchSourceLog[]; executed: IntentSubCall[]; offered: string[][] }

function harness(opts: { selector: ResearchSelector; execute: ResearchDeps['execute']; now?: () => number }): Harness {
  const sources: ResearchSourceLog[] = [];
  const executed: IntentSubCall[] = [];
  const offered: string[][] = [];
  const selector: ResearchSelector = {
    select: async (input, signal) => { offered.push([...input.candidates]); return opts.selector.select(input, signal); },
  };
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
    selector,
  };
  return { deps, sources, executed, offered };
}

const selectorOf = (...outputs: SelectorOutput[]): ResearchSelector => ({
  select: async () => outputs.shift() ?? { questionClass: 'cross_source', actions: [], pUseful: {} },
});

/** A real search reply shape: the H1 header, the italic retrieval metadata, one cut hit. */
const CUT_SEARCH = [
  '# Knowledge Search',
  '_confidence: low · mode: reranked · top score: 0.21 · relevant candidate: yes_',
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

test('K3: the model-authored knowledge query is clipped to five content terms', () => {
  const sentence = 'what did we decide about the wriggler three layer schema migration deadline for the owner dashboard';
  const shaped = knowledgeQuery(sentence);
  const terms = shaped.split(' ');
  assert.equal(RESEARCH.knowledgeQueryTerms, 5);
  assert.equal(terms.length, 5);
  assert.deepEqual(terms, ['decide', 'about', 'wriggler', 'three', 'layer']);
  assert.ok(!sentence.startsWith(shaped), 'the whole spoken sentence never reaches the search');
  const [call] = candidateSubs('knowledge_search', { question: sentence, configured: CONFIGURED, evidence: new Map() });
  assert.equal(String(call!.args['query']), shaped);
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
});

test('K5 and K7: the confidence line reaches the finding, and the two score scales do not', () => {
  const block = shapeBlock('knowledge_search', [sub('search_knowledge', CUT_SEARCH)]);
  assert.equal(block.lines[0], 'knowledge: confidence=low top=0.21 candidates=yes');
  assert.ok(!block.text.includes('Score:'), 'the incomparable per-hit score line is dropped');
  assert.ok(block.lines.some(line => line.endsWith('cut at 1200 chars')), 'a search snippet stays short');
  const bare = shapeBlock('knowledge_search', [sub('search_knowledge', '**#9** [PATTERN] A plain hit')]);
  assert.ok(!bare.lines.some(line => line.startsWith('knowledge: confidence')));
});

test('K2: an opened body renders at 3000 characters and a search hit keeps the server window', () => {
  const opened = shapeBlock('knowledge_search', [sub('get_insight', LONG_BODY)]);
  assert.equal(RESEARCH.knowledgeBodyChars, 3_000);
  assert.ok(opened.lines[0]!.endsWith('cut at 3000 chars'), opened.lines[0]!.slice(-40));
  assert.equal(opened.source, 'knowledge');
  // P5-R1 holds: a search hit is bounded by the server's own window, never cut again in the host.
  const whole = 'x'.repeat(4_000);
  const searched = shapeBlock('knowledge_search', [sub('search_knowledge', `### Long insight (DECISION | 2026-10-19) [id 7]\n${whole}`)]);
  assert.ok(searched.lines[0]!.endsWith(whole));
});

test('K1: a cut search reply is followed by a read of the top id, inside the same read', async () => {
  const searched = selectorOf(
    { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } },
  );
  const calls: IntentSubCall[] = [];
  const h = harness({
    selector: searched,
    execute: async subs => { for (const call of subs) calls.push(call); return subs.map(call => sub(call.name, call.name === 'search_knowledge' ? CUT_SEARCH : LONG_BODY, true, call.key)); },
  });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline' }, new AbortController().signal);
  const read = calls.find(call => call.name === 'get_insight');
  assert.deepEqual(read?.args, { ids: [123] });
  const findings = reply['findings'] as { source: string; text: string }[];
  const knowledge = findings.find(finding => finding.source === 'knowledge');
  assert.ok(knowledge !== undefined && knowledge.text.includes('cut at 3000 chars'), 'the opened body reaches the reply');
});

test('K1: a reply that proved its hit complete opens nothing', async () => {
  const searched = selectorOf(
    { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } },
  );
  const calls: IntentSubCall[] = [];
  const h = harness({
    selector: searched,
    execute: async subs => { for (const call of subs) calls.push(call); return subs.map(call => sub(call.name, '**#123** [PATTERN] A whole hit\ntruncated: no', true, call.key)); },
  });
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline' }, new AbortController().signal);
  assert.equal(calls.filter(call => call.name === 'get_insight').length, 0);
});

test('K1 and K5: a reply that calls its own match weak never triggers a body read', async () => {
  const low = CUT_SEARCH;
  assert.deepEqual(knowledgeHydrateIds(low, new Set()), [], 'a low-confidence match is not opened');
  assert.deepEqual(knowledgeHydrateIds(low.replace('_confidence: low', '_confidence: high'), new Set()), [123]);
  assert.deepEqual(knowledgeHydrateIds(low.replace('_confidence: low', '_confidence: high'), new Set([123])), [], 'a complete hit is not opened');
});

test('K8: knowledge latency is stated at its measured p50, and the log carries the read span not the wait', async () => {
  assert.equal(RESEARCH.p50Seconds.knowledge, 2.9);
  let clock = 0;
  const searched = selectorOf(
    { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } },
  );
  const selector: ResearchSelector = { select: async () => { clock += 3_000; return searched.select({} as never, new AbortController().signal); } };
  const h = harness({
    selector,
    now: () => clock,
    execute: async subs => { clock += 1_200; return subs.map(call => sub(call.name, CUT_SEARCH, true, call.key)); },
  });
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline' }, new AbortController().signal);
  const knowledge = h.sources.find(entry => entry.source === 'knowledge');
  assert.equal(knowledge?.ms, 1_200, 'the batch wait the prime read spent before selection is not its latency');
});
