import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, candidateSubs, capReply, fallbackSelection, knowledgeQuery, runResearch, shapeBlock,
  type ResearchDeps, type ResearchSourceLog, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { GMAIL_BODY_CHARS, shapeLuxKnowledge } from '../tools/live-shape.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import { subResultOf } from '../live/index.js';
import { createHash } from 'node:crypto';
import type { McpPort } from '../adapters/mcp/port.js';
import type { ConnectionPolicy } from '../tools/types.js';

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

/** #580: the server's own ranker line for a query nothing in the vault matches. */
const NO_CANDIDATE = [
  '# Knowledge Search',
  '_confidence: low · top score: 0.11 · relevant candidate: no_',
  '**#900** [PATTERN] Unrelated engineering note',
  'the vault keeps an unrelated engineering note about socket timeouts',
].join('\n');

/** #580: a synthetic MCP entity with the ranker's own line, and the policy that admits it. */
function projectedKnowledge(text: string): Record<string, unknown> {
  const entity = Buffer.from(JSON.stringify({ content: [{ type: 'text', text }] }), 'utf8');
  const sha = createHash('sha256').update(entity).digest('hex');
  const expiresAt = Date.now() + 60_000;
  const policy: ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'owner', connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { id: 'endpoint', url: 'https://synthetic.invalid/mcp', account: 'account', resource: 'resource', credentialRef: 'private:synthetic-reference' },
    toolNames: ['search_knowledge'], schemaDigest: 'schema',
    sourcePolicy: { id: 'synthetic-policy', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
    route: { identity: 'synthetic-route', allowedClasses: ['private'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
  };
  const port = { readSlice: () => ({ state: 'available', bytes: entity.slice(), byteLength: entity.length, sha256: sha, expiresAt: expiresAt }) } as unknown as McpPort;
  return projectLuxResult({
    state: 'completed', tool: 'search_knowledge', observedAt: 1, decodedResult: { content: [{ type: 'text', text }] },
    source: { endpointId: 'endpoint', url: 'https://synthetic.invalid/mcp', schemaDigest: 'schema', toolName: 'search_knowledge', generation: 1, account: 'account', resource: 'resource' },
    coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
    projection: { text: text, omitted: false, originalCharacters: text.length, omittedCharacters: 0 },
    response: { state: 'available', handle: 'handle', sha256: sha, byteLength: entity.length, expiresAt: expiresAt, encoding: 'http-response-entity' },
  }, policy, port).response;
}

test('#580: the projection carries the ranker confidence on the response, not only inside its text', () => {
  const response = projectedKnowledge(NO_CANDIDATE);
  assert.deepEqual(response['knowledgeConfidence'], { confidence: 'low', top: '0.11', candidates: 'no' }, 'the named carrier survives the projection');
  assert.equal(typeof response['text'], 'string', 'and the model-visible text is unchanged in kind');
});

test('#580: a no-candidate low-confidence knowledge read carries the confidence and is voiced as no match', () => {
  const shaped = shapeLuxKnowledge('search_knowledge', NO_CANDIDATE);
  assert.deepEqual(shaped.knowledgeConfidence, { confidence: 'low', top: '0.11', candidates: 'no' }, 'the shape reads the ranker line before it strips it');
  // E4 (#611): the field is never injected here: it rides the live sub-result the batched path builds.
  const block = shapeBlock('knowledge_search', [subResultOf('k0', 'search_knowledge', { text: shaped.text, knowledgeConfidence: shaped.knowledgeConfidence }, true)]);
  assert.ok(block.lines.includes('knowledge: confidence=low top=0.11 candidates=no'), `the finding leads with the confidence, got ${JSON.stringify(block.lines)}`);
  assert.ok(block.lines.includes('knowledge: nothing matched this ask'), 'a low-confidence no-candidate match is voiced as no match');
  assert.equal(block.lines.some(line => line.includes('relevant candidate:')), false, 'the raw ranker line is never voiced as a hit');
  const carried = shapeBlock('knowledge_search', [{ ...sub('search_knowledge', shaped.text), knowledgeConfidence: { confidence: 'low', top: '0.11', candidates: 'no' } }]);
  assert.deepEqual(carried.lines, block.lines, 'the carried confidence and the read one voice the same finding');
});

test('#580: a run voices the weak knowledge match as nothing matching', async () => {
  const shaped = shapeLuxKnowledge('search_knowledge', NO_CANDIDATE);
  const h = harness({ execute: async subs => subs.map(call => ({ ...sub(call.name, shaped.text, true, call.key), ...(shaped.knowledgeConfidence === undefined ? {} : { knowledgeConfidence: shaped.knowledgeConfidence }) })) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what does the vault hold about dark triad' }, new AbortController().signal);
  assert.match(JSON.stringify(reply['findings']), /knowledge: confidence=low top=0\.11 candidates=no/u, 'the voiced finding carries the confidence');
  assert.match(JSON.stringify(reply['findings']), /nothing matched this ask/u, 'and is voiced as no match');
});

test('#5: a clipped knowledge hit counts as shown, never as left out', () => {
  const line = `#1 a long hit ${'x'.repeat(400)}`;
  const reply = { researchId: 'r', status: 'complete', findings: [{ source: 'knowledge', text: `knowledge: 1 of 1 shown\n${line}`, chars: line.length }] };
  const capped = capReply(reply, JSON.stringify(reply).length - 100);
  const text = (capped['findings'] as { text: string }[])[0]!.text;
  assert.match(text, /knowledge: 1 of 1 shown/u, `the clipped hit is still shown: ${text.slice(0, 80)}`);
  assert.ok(text.split('\n').length === 2, 'the one hit is still voiced');
});

test('#580: the confidence travels as a field and never spends the result budget', () => {
  const body = 'the vault entry says the deadline is the fifteenth. '.repeat(120);
  const plain = shapeLuxKnowledge('search_knowledge', body);
  const marked = shapeLuxKnowledge('search_knowledge', `_confidence: low · top score: 0.11 · relevant candidate: no_\n${body}`);
  assert.deepEqual(marked.knowledgeConfidence, { confidence: 'low', top: '0.11', candidates: 'no' }, 'the mark is carried as a field');
  const evidence = (text: string): string => text.replace(/\[omitted:[^\]]*\]/gu, '');
  assert.ok(evidence(plain.text).length <= GMAIL_BODY_CHARS, `the plain result holds the path budget, got ${evidence(plain.text).length}`);
  assert.equal(marked.text, plain.text, 'and the carried confidence costs the model text nothing');
});

test('K3: the model-authored knowledge query is clipped to ten content terms, and filler never rides', () => {
  const sentence = 'what did we decide about the wriggler three layer schema migration deadline for the owner dashboard';
  const shaped = knowledgeQuery(sentence);
  const terms = shaped.split(' ');
  assert.equal(RESEARCH.knowledgeQueryTerms, 10);
  assert.equal(terms.length, 8);
  assert.deepEqual(terms, ['decide', 'wriggler', 'three', 'layer', 'schema', 'migration', 'deadline', 'dashboard']);
  assert.ok(!terms.includes('about') && !terms.includes('owner'), 'filler is dropped before the budget is counted');
  assert.ok(!sentence.startsWith(shaped), 'the whole spoken sentence never reaches the search');
  const [call] = candidateSubs('knowledge_search', { question: sentence, topic: sentence, configured: CONFIGURED, evidence: new Map() });
  assert.equal(String(call!.args['query']), shaped);
  const longer = 'decide wriggler three layer schema migration deadline dashboard harvester pipeline ledger';
  assert.deepEqual(knowledgeQuery(longer).split(' ').slice(-1), ['pipeline'], 'the tenth term is the last one that fits');
  assert.equal(knowledgeQuery(longer).split(' ').length, 10);
  const named = knowledgeQuery('lux meeting transcript results about', 'what did we cover in the prep call with Maria');
  assert.ok(named.split(' ').includes('maria'), 'a name the question spoke survives the clip');
});

test('K4: a known project name in the question supplies a hint, and never a hard filter', () => {
  const hinted = candidateSubs('knowledge_search', { question: 'how is the Wriggler pipeline doing', topic: 'Wriggler pipeline', configured: CONFIGURED, evidence: new Map() });
  assert.equal(hinted[0]!.args['project_hint'], 'Wriggler');
  assert.equal('project' in hinted[0]!.args, false);
  const plain = candidateSubs('knowledge_search', { question: 'what did we decide about the retrieval deadline', topic: 'retrieval deadline', configured: CONFIGURED, evidence: new Map() });
  assert.equal('project_hint' in plain[0]!.args, false);
  assert.equal('project' in plain[0]!.args, false);
});

test('K6: a question with no content words asks rather than searching filler', () => {
  assert.deepEqual(candidateSubs('knowledge_search', { question: 'what is that', topic: 'that', configured: CONFIGURED, evidence: new Map() }), []);
  assert.equal(candidateSubs('knowledge_search', { question: 'wriggler pipeline', topic: 'wriggler pipeline', configured: CONFIGURED, evidence: new Map() }).length, 1);
  // A model query of one domain word survives: it is a search string, never a spoken sentence.
  const [one] = candidateSubs('knowledge_search', { question: 'who is on my team', topic: 'team', query: 'team', configured: CONFIGURED, evidence: new Map() });
  assert.equal(one!.args['query'], 'team');
});

test('K5 and K7: the confidence line reaches the finding, and the two score scales do not', () => {
  const block = shapeBlock('knowledge_search', [sub('search_knowledge', CUT_SEARCH)]);
  assert.equal(block.lines[0], 'knowledge: confidence=medium top=0.37 candidates=yes');
  assert.ok(!block.text.includes('Score:'), 'the incomparable per-hit score line is dropped');
  assert.ok(block.lines.some(line => line.endsWith(`cut at ${RESEARCH.knowledgeBodyChars} chars`)), 'the search reply carries the body window it asked for');
  const bare = shapeBlock('knowledge_search', [sub('search_knowledge', '**#9** [PATTERN] A plain hit')]);
  assert.ok(!bare.lines.some(line => line.startsWith('knowledge: confidence')));
});

test('ROUTE-1022: a body read is never clipped by the host, and the search window it asks for fits the reply', () => {
  const opened = shapeBlock('knowledge_search', [sub('get_insight', LONG_BODY)]);
  assert.equal(RESEARCH.knowledgeBodyChars, 2_000, 'R5 (RESCAP-R5): the window is sized to fit the reply budget');
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
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline', topic: 'retrieval deadline' }, new AbortController().signal);
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
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline', topic: 'retrieval deadline' }, new AbortController().signal);
  assert.equal(executed.filter(call => call.name === 'search_knowledge').length, 1, 'exactly one knowledge call');
  assert.equal(executed.filter(call => call.name === 'get_insight').length, 0, 'no get_insight hop');
  const search = executed.find(call => call.name === 'search_knowledge')!;
  assert.equal(search.args['max_chars'], RESEARCH.knowledgeBodyChars);
  assert.equal(RESEARCH.knowledgeOpenIds, 0);
});

test('ROUTE-1022: a knowledge reply that would overrun the reply budget is trimmed to the hits that fit', async () => {
  const longBody = Array.from({ length: 6 }, (_, index) => `**#${index + 1}** [PATTERN] Hit ${index} | ${'x'.repeat(2_900)}`).join('\n');
  const h = harness({ execute: async subs => subs.map(call => sub(call.name, longBody, true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the retrieval deadline', topic: 'retrieval deadline' }, new AbortController().signal);
  const bytes = JSON.stringify(reply).length;
  // #634: the coverage header counts inside the reply cap, so the whole reply keeps the one bound.
  assert.ok(bytes <= RESEARCH.replyLimitChars, `reply bytes ${bytes} over the ${RESEARCH.replyLimitChars} reply budget`);
});

// --- ONE-1023: notes live in the past, and a day filter never hides them -----------------------

const FRIDAY = Date.parse('2026-10-23T04:30:00Z');

test('ONE-1023: a question about today reads the notes that exist, with no day filter', async () => {
  const executed: IntentSubCall[] = [];
  const h = harness({
    now: () => FRIDAY,
    execute: async subs => { executed.push(...subs); return subs.map(call => sub(call.name, '### 2026-10-16 budget review [id 41]\nwe agreed the budget review', true, call.key)); },
  });
  const reply = await runResearch({ ...h.deps, timeZone: 'Asia/Kolkata' }, { action: 'start', question: 'what meetings do I have today', topic: 'meetings' }, new AbortController().signal);
  const searched = executed.find(call => call.name === 'search_knowledge');
  assert.ok(searched !== undefined, 'the knowledge read still runs');
  assert.equal('meeting_date_from' in searched.args, false, 'a day that has not passed cannot be filtered on');
  assert.match(JSON.stringify(reply), /budget review/u, 'the earlier notes answer the question');
});

test('ONE-1023: a filtered search that matched nothing retries once without the filter', async () => {
  const executed: IntentSubCall[] = [];
  const h = harness({
    now: () => FRIDAY,
    execute: async subs => {
      executed.push(...subs);
      return subs.map(call => sub(call.name, 'meeting_date_from' in call.args ? '' : '### budget review [id 41]\nthe budget review is agreed', true, call.key));
    },
  });
  const reply = await runResearch({ ...h.deps, timeZone: 'Asia/Kolkata' }, { action: 'start', question: "what did we decide in yesterday's meeting about the budget review", topic: "what did we decide in yesterday's meeting about the budget review" }, new AbortController().signal);
  const searches = executed.filter(call => call.name === 'search_knowledge');
  assert.equal(searches.length, 2, 'one retry, never more');
  assert.equal('meeting_date_from' in searches[0]!.args, true, 'the first read carries the past day');
  assert.equal(searches[0]!.args['meeting_date_from'], '2026-10-22', 'the past day is the owner zone day before the run clock');
  assert.equal('meeting_date_from' in searches[1]!.args, false, 'the retry drops it');
  assert.match(JSON.stringify(reply), /budget review is agreed/u, 'the hit reaches the reply');
  const receipt = h.sources.filter(entry => entry.source === 'knowledge').at(-1);
  assert.equal(receipt?.knowledge?.dayFilter, 'dropped_on_empty', 'the receipt says the filter was dropped');
});

// #631: the ask names the layer so the router can read it; the layer's name is never a search term. A
// name whose layer this run cannot read is the ask's subject and stays a term.
test('#631: the source name an ask speaks is the route, never a knowledge term', () => {
  const ask = (topic: string, question = topic): string =>
    String(candidateSubs('knowledge_search', { question, topic, configured: CONFIGURED, evidence: new Map() })[0]?.args['query']);
  assert.equal(ask('lux knowledge about determinism', 'check lux knowledge about determinism'), 'determinism', 'the named layer is dropped, the subject kept');
  assert.equal(ask('the vault determinism'), 'determinism', 'the vault is the same layer in another name');
  assert.equal(ask('dark triad lux knowledge', 'what do we know about dark triad'), 'dark triad', 'a trailing source name is dropped too');
  assert.equal(ask('mongoose release'), 'mongoose release', 'mongoose is no layer this run may read, so the word is content');
  // The word that is dropped still routes: the layer the owner named is the one that is read.
  assert.ok(fallbackSelection('check lux knowledge about determinism', CONFIGURED).actions.some(action => action.kind === 'knowledge_search'), 'the named layer is still read');
});

test('#631: a mail ask names the layer, and the layer name is no Gmail term', () => {
  const MAIL_RUN: readonly SourceKind[] = ['knowledge', 'mail', 'mongoose'];
  const q = (topic: string, question: string): string =>
    String(candidateSubs('mail_search', { question, topic, configured: MAIL_RUN, evidence: new Map() })[0]?.args['q']);
  assert.ok(!/\binbox\b/u.test(q('inbox about the invoice', 'what is in my inbox about the invoice').replace(/in:inbox/gu, '')), 'inbox is the layer, not a term');
  assert.ok(!/\bmongoose\b/u.test(q('mongoose invoice', 'what did the mongoose invoice email say')), 'and a source word the mail run may read is dropped');
  assert.match(q('mongoose invoice', 'what did the mongoose invoice email say'), /invoice/u, 'the subject still searches');
});

// #631 R1/R2: the strip is not the topic's alone. A model-authored query, and the fallback recipe, are
// the same search text and lose the same routing words; a name whose source is off the route stays.
test('#631: a model-authored knowledge query loses the source word too', () => {
  const asked = (query: string): string => String(candidateSubs('knowledge_search', {
    question: 'check lux knowledge about determinism', query, configured: CONFIGURED, evidence: new Map(),
  })[0]?.args['query']);
  assert.equal(asked('lux determinism'), 'determinism', 'the model query is stripped like the topic');
});

test('#631: an authored Gmail query keeps its operators and loses the source words', () => {
  const MAIL_RUN: readonly SourceKind[] = ['knowledge', 'mail', 'mongoose'];
  const [call] = candidateSubs('mail_search', {
    question: 'what did the mongoose invoice email say', query: 'in:inbox mongoose invoice', topic: 'invoice', configured: MAIL_RUN, evidence: new Map(),
  });
  assert.equal(String(call?.args['q']), 'in:inbox invoice', 'the operator stays, the layer name goes');
});

test('#631: the fallback mail recipe keeps a name whose source is off the route', () => {
  const FALLBACK: readonly SourceKind[] = ['knowledge', 'mail'];
  const mail = fallbackSelection('what did Helm mail about the Mongoose release', FALLBACK).actions.find(action => action.kind === 'mail_search');
  assert.match(String(mail?.query), /mongoose/u, 'mongoose is no layer this run may read, so the fallback keeps the word');
});

// #631 R3/R4: a routing word is stripped in the phrase an ask names its layer with, never as ordinary
// content ("web analytics" is a subject, "drive growth" is a verb).
test('#631: a bare source word that is content stays a term', () => {
  const mail = (topic: string): string => String(candidateSubs('mail_search', {
    question: 'what did the web analytics thread say', topic, configured: ['knowledge', 'mail', 'web'], evidence: new Map(),
  })[0]?.args['q']);
  assert.match(mail('web analytics thread'), /web/u, 'web analytics is a subject, not the layer');
  const known = (topic: string): string => String(candidateSubs('knowledge_search', {
    question: topic, topic, configured: CONFIGURED, evidence: new Map(),
  })[0]?.args['query']);
  assert.match(known('drive growth plan'), /drive/u, 'drive growth is the verb, not the layer');
  assert.match(known('chats about the release'), /chats/u, 'chats is the noun, not the layer');
});
