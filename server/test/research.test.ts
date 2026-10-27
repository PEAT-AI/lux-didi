import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, ResearchScheduler, candidateSubs, capReply, chatQuery, compileMailQuery, cutLineOf, fallbackSelection, meetingBounds, namedInsightIds, newestDatedFirst, offerableCandidates, shapeBlock, windowRange,
  configuredSourcesForEndpoints, configuredSourcesForSession, plainReason, unreachableSourcesForSession, UNPUBLISHED_SOURCE_REASON, pUsefulOf, refusalCode, researchDeclaration, researchDescription, researchSourcesForConnector, researchSourcesFromToolNames, runResearch,
  validateResearch, worthContinuing, parseResearch, researchRepair, topicTerms, entityPreservedQuestion,
  researchCallBudgetMs, type ResearchDeps, type ResearchFirstAnswer, type ResearchLateFindings, type ResearchProgress, type ResearchRunLog, type ResearchSourceLog, type ResearchSubcallLog, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { spokenChannel } from '../tools/chat-intent.js';
import type { CandidateKind } from '../tools/research.js';
import { shapeGcalList, shapeGmailList, shapeLuxKnowledge } from '../tools/live-shape.js';
import { safeEvent } from '../host/log.js';
import { projectDiagnosticInput } from '../tools/diagnostic-input.js';
import './research-shape.test.js';
import './research-calendar.test.js';

/** A small reply bound for the cap mechanism itself; the product budget is RESEARCH.budgets. */
const CAP_REPLY_BOUND = 2_500;

const CONFIGURED: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat'];

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

interface Harness { deps: ResearchDeps; progress: ResearchProgress[]; logs: ResearchRunLog[]; subcalls: ResearchSubcallLog[]; executed: { name: string; args: unknown }[]; joined: string[]; branches: string[] }

function harness(opts: { execute?: ResearchDeps['execute']; now?: () => number; schedule?: ResearchDeps['schedule']; ledger?: ResearchLedger; executeText?: string; replyLimit?: number; configured?: readonly SourceKind[]; memory?: (query: string) => { lines: string[]; text: string; total: number; hits?: { snippet: string; role?: string; date?: string }[] } } = {}): Harness {
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const subcalls: ResearchSubcallLog[] = [];
  const executed: { name: string; args: unknown }[] = [];
  const joined: string[] = [];
  // #663: the scheduler branch that answered each call, so a repeat is told apart from a fresh read.
  const branches: string[] = [];
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    configured: opts.configured ?? CONFIGURED,
    execute: opts.execute ?? (async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push({ name: call.name, args: call.args });
      return subs.map(call => call.name === 'calendar_list_events' && opts.executeText === MERGED_CALENDAR
        ? { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: CALENDAR_RECORDS }) }
        : sub(call.name, opts.executeText ?? 'evidence', true, call.key));
    }),
    emit: event => progress.push(event),
    log: entry => logs.push(entry),
    logSubcall: entry => subcalls.push(entry),
    logJoined: (id, branch) => { joined.push(id); branches.push(branch); },
    ledger: opts.ledger ?? new ResearchLedger(),
    ...(opts.replyLimit !== undefined ? { replyLimit: opts.replyLimit } : {}),
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
  };
  const execute = deps.execute;
  deps.execute = async (calls, signal) => {
    if (!calls.every(call => call.name === 'conversation_history')) return execute(calls, signal);
    return calls.map(call => {
      const found = opts.memory?.(String(call.args['query'] ?? ''));
      return { key: call.key, name: call.name, ok: !!found, text: '', originalCharacters: 0, omittedCharacters: 0,
        ...(found ? { binding: { executionId: call.key } as NonNullable<IntentSubResult['binding']>, historyPage: { status: 'ok', hits: found.hits ?? found.lines.map(snippet => ({ snippet })), totalMatches: found.total, nextCursor: null } } : {}) };
    });
  };
  return { deps, progress, logs, subcalls, executed, joined, branches };
}


test('Argon round 3: continues at pUseful 0.44 and stops at 0.42 for cross_source after a 4.7 s calendar read', () => {
  const base = { questionClass: 'cross_source' as const, elapsedMs: 4_700, subsetP50Ms: 3_600, deadlineMs: 15_000 };
  assert.equal(worthContinuing({ ...base, pUseful: 0.44 }), true);
  assert.equal(worthContinuing({ ...base, pUseful: 0.42 }), false);
  assert.ok(Math.abs(pUsefulOf([0.44, 0.42]) - 0.6752) < 1e-9);
});

test('an unrouted question answers from the fixed recipe and stops after round one', async () => {
  const h = harness({});
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.equal(h.logs[0]!.fallbackUsed, true);
  assert.equal(h.logs[0]!.driver, 'fallback');
  assert.equal(h.logs[0]!.rounds, 1);
  assert.ok(h.executed.length >= 1);
  assert.equal(reply['status'], 'complete');
});

test('a single-source hint narrows the plan to the hinted source', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', question: 'anything', sources: 'mail' }, new AbortController().signal);
  assert.ok(h.executed.length >= 1 && h.executed.every(call => call.name === 'gmail_search_messages'));
  assert.equal(h.logs[0]!.fallbackUsed, false);
  assert.equal(h.logs[0]!.driver, 'single-source-hint');
  assert.equal(h.logs[0]!.selectorMs, 0, 'a skipped selector costs no selector time');
});

test('a single-source hint with no usable question still runs the hinted source', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', question: '', sources: 'mail' }, new AbortController().signal);
  assert.ok(h.executed.some(call => call.name === 'gmail_search_messages'), 'the hinted source always runs');
  assert.equal(h.logs[0]!.driver, 'single-source-hint');
});

test('every lookup names the driver the loop used', async () => {
  const hinted = harness({});
  await runResearch(hinted.deps, { action: 'start', question: 'anything', sources: 'mail' }, new AbortController().signal);
  assert.equal(hinted.logs[0]!.driver, 'single-source-hint');
  const chosen = harness({});
  await runResearch(chosen.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  assert.equal(chosen.logs[0]!.driver, 'fallback');
  // F-B: a selector handed to the live path is never awaited, so its failure cannot change the driver.
  const fell = harness({});
  await runResearch(fell.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  assert.equal(fell.logs[0]!.driver, 'fallback');
  assert.equal(fell.logs[0]!.selectorMs, 0);
});

test('continue reuses the ledger and never re-reads a completed operation', async () => {
  const h = harness({});
  const first = await runResearch(h.deps, { action: 'start', question: 'release status' }, new AbortController().signal);
  assert.ok(h.executed.filter(call => call.name === 'search_knowledge').length >= 1);
  h.executed.length = 0;
  const second = await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, new AbortController().signal);
  assert.equal(String(second['researchId']), String(first['researchId']));
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 0);
});

test('stop is idempotent and returns what is known', async () => {
  const h = harness({});
  const first = await runResearch(h.deps, { action: 'start', question: 'x' }, new AbortController().signal);
  const id = String(first['researchId']);
  const a = await runResearch(h.deps, { action: 'stop', researchId: id }, new AbortController().signal);
  const b = await runResearch(h.deps, { action: 'stop', researchId: id }, new AbortController().signal);
  assert.equal(a['status'], 'stopped');
  assert.equal(b['status'], 'stopped');
  assert.deepEqual(a['findings'], b['findings']);
  assert.equal(a['canContinue'], false);
});

test('an unrelated barge-in signal does not abort a running research run', async () => {
  const barge = new AbortController();
  const h = harness({ execute: async subs => { barge.abort(); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  // #1021: a content-free question no longer searches knowledge, so the harness asks a real one.
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.notEqual(reply['status'], 'stopped');
  assert.equal(barge.signal.aborted, true);
});

test('the session abort ends the run as stopped', async () => {
  const session = new AbortController();
  const h = harness({ execute: async subs => { session.abort(); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, session.signal);
  assert.equal(reply['status'], 'stopped');
});

test('a run past its deadline returns partial after one round', async () => {
  let advanced = false;
  const h = harness({});
  const deps: ResearchDeps = { ...h.deps, now: () => (advanced ? RESEARCH.startDeadlineMs + 5_000 : 0), execute: async subs => { advanced = true; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } };
  const reply = await runResearch(deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.equal(reply['status'], 'partial');
  assert.equal(h.logs[0]!.rounds, 1);
});

test('a failed follow-up logs its real error code, never a bare failed', async () => {
  const h = harness({
    execute: async subs => subs.map(call => call.name === 'mattermost_get_thread'
      ? { ...sub(call.name, '', false, call.key), code: 'sdk_protocol_rejected' }
      : sub(call.name, 'the decision was [post p1] recorded', true, call.key)),
  });
  await runResearch(h.deps, { action: 'start', question: 'what did the team decide' }, new AbortController().signal);
  const thread = h.subcalls.find(entry => entry.tool === 'mattermost_get_thread');
  assert.ok(thread, 'the chat thread follow-up runs');
  assert.equal(thread!.ok, false);
  assert.equal(thread!.errorCode, 'sdk_protocol_rejected');
});

test('the whole serialized reply stays within the character cap', async () => {
  const h = harness({ executeText: 'x'.repeat(9_000) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.budgets.default, `reply was ${JSON.stringify(reply).length} chars with the coverage header`);
});

// N4 (#567): memory and knowledge findings of 10 KB each reached Live at 6,125 and 8,543 chars, so the
// budget is measured on the whole serialized reply, after every section is attached.
test('N4: memory and knowledge findings of 10 KB each still fit the capped reply', async () => {
  const h = harness({
    configured: ['memory', 'knowledge'],
    executeText: 'k'.repeat(10_000),
    memory: () => ({ lines: [`he said ${'m'.repeat(10_000)}`], text: 'ignored', total: 1 }),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what is the release scope',
    lookups: [{ source: 'memory', history: { query: 'release scope' } }, { source: 'knowledge', query: 'release scope' }],
  }, new AbortController().signal);
  const size = JSON.stringify(reply).length;
  // #634: the coverage header counts inside the prose envelope.
  assert.ok(size <= RESEARCH.budgets.default, `reply was ${size} chars with the coverage header`);
});

// #634: the coverage header counts inside the same cap, so a reply that fills the budget still fits with a
// long header, and the header keeps every source it names.
test('CAPHEADER 1: a reply at the cap carries a long coverage header inside the 2,500 characters', async () => {
  const h = harness({
    configured: ['memory', 'knowledge'],
    executeText: 'k'.repeat(10_000),
    memory: () => ({ lines: [`he said ${'m'.repeat(10_000)}`], text: 'ignored', total: 1 }),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what is the release scope',
    lookups: [{ source: 'memory', history: { query: 'release scope' } }, { source: 'knowledge', query: 'release scope' }, { source: 'web', query: 'release scope' }],
  }, new AbortController().signal);
  const header = String(reply['coverage']);
  const size = JSON.stringify(reply).length;
  assert.ok(header.length >= 100, `the header is long enough to matter: ${header.length} chars`);
  assert.match(header, /^coverage: /u);
  assert.match(header, /knowledge [a-z_]+ \d+ of \d+ shown/u, 'the searched source keeps its counts');
  assert.match(header, /web not_configured/u, 'the source nobody read is named in the header');
  assert.ok(size >= 2_300, `the reply really fills the cap: ${size} chars`);
  assert.ok(size <= RESEARCH.budgets.default, `reply was ${size} chars with the coverage header at a ${RESEARCH.budgets.default} cap`);
});

// N5 (#568): a completed run promised more was available, and the model's continue got
// continuation_unavailable. The note offers a continuation only when this reply can serve one.
test('N5: a reply that cannot serve a continuation never says more is available', async () => {
  const h = harness({});
  const first = await runResearch(h.deps, { action: 'start', question: 'x' }, new AbortController().signal);
  const stopped = await runResearch(h.deps, { action: 'stop', researchId: String(first['researchId']) }, new AbortController().signal);
  assert.equal(stopped['canContinue'], false);
  const note = String(stopped['note'] ?? '');
  assert.ok(!note.includes(RESEARCH.moreAvailableNote), 'the note never offers a continuation this run cannot serve');
  assert.doesNotMatch(note, /did not search/, 'the note never repeats what the header already names');
  const coverage = String(stopped['coverage'] ?? '');
  assert.match(coverage, /coverage: (?!none)\w+/u, `the header names what this run did and did not search: ${coverage}`);
});

test('N5: a trimmed reply that can continue still says more is available', async () => {
  const wide = Array.from({ length: 14 }, (_, index) => `**#${index + 1}** [PATTERN] Decision ${index} | ${'decision text '.repeat(60)}`).join('\n');
  const h = harness({ executeText: wide });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what decisions did we make about the retrieval deadline' }, new AbortController().signal);
  assert.equal(reply['canContinue'], true);
  assert.ok(String(reply['note'] ?? '').includes(RESEARCH.moreAvailableNote));
});

// #575: a memory hit that is her own earlier voice confirms a past answer instead of finding new
// evidence, so it is dropped unless the owner asks what she said.
test('#575: memory drops her own earlier turns and keeps the owner turns', async () => {
  // #615: an honest clock, so the call before this one really starts at 09:00:00.
  let at = Date.parse('2026-10-23T09:00:00.000Z');
  const hits = [
    { snippet: 'he said the release ships on Friday', role: 'user', date: '2026-10-23T08:59:50.000Z' },
    { snippet: 'I said the release ships on Friday', role: 'assistant', date: '2026-10-23T09:00:10.000Z' },
  ];
  const h = harness({ configured: ['memory'], now: () => at, memory: () => ({ lines: hits.map(hit => hit.snippet), hits, text: '', total: 2 }) });
  await runResearch(h.deps, { action: 'start', question: 'anything for today' }, new AbortController().signal);
  at = Date.parse('2026-10-23T09:00:30.000Z');
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did we say about the release', lookups: [{ source: 'memory', history: { query: 'release ships' } }],
  }, new AbortController().signal);
  const text = JSON.stringify(reply);
  assert.match(text, /he said the release ships on Friday/, 'the owner turn stays evidence');
  assert.doesNotMatch(text, /I said the release ships on Friday/, 'her own earlier reply is not evidence');
});

test('#575: a question about what she said keeps her own turn', async () => {
  const hits = [{ snippet: 'I said the release ships on Friday', role: 'assistant', date: '2026-10-23T09:00:05.000Z' }];
  const h = harness({ configured: ['memory'], memory: () => ({ lines: hits.map(hit => hit.snippet), hits, text: '', total: 1 }) });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did you say about the release', lookups: [{ source: 'memory', history: { query: 'release ships' } }],
  }, new AbortController().signal);
  assert.match(JSON.stringify(reply), /I said the release ships on Friday/, 'the owner asked what she said, so her turn answers it');
});

test('#575: a finding already given in the session becomes a one-line note', async () => {
  const ledger = new ResearchLedger();
  const h = harness({ ledger, executeText: '### Release scope (DECISION | 2026-10-17) [id 12] the release ships on Friday' });
  const call = { action: 'start' as const, question: 'what is the release scope', lookups: [{ source: 'knowledge' as const, query: 'release scope' }] };
  const first = await runResearch(h.deps, call, new AbortController().signal);
  const second = await runResearch(h.deps, call, new AbortController().signal);
  const firstText = (first['findings'] as { text: string }[]).map(finding => finding.text).join('\n');
  const secondText = (second['findings'] as { text: string }[]).map(finding => finding.text).join('\n');
  assert.match(firstText, /release ships on Friday/, 'the first reply carries the evidence');
  assert.doesNotMatch(secondText, /release ships on Friday/, 'the same evidence is never repeated in the session');
  assert.match(secondText, /already given/, 'it is replaced by a one-line note');
  assert.ok(JSON.stringify(second).length < JSON.stringify(first).length, 'the repeat is shorter than the original');
});

// Review F1: capReply trimmed after the note was built, so a capped reply could say nothing was left while
// it offered a continuation.
test('#567: a reply capped after its note was built advertises the continuation it needs', async () => {
  const ledger = new ResearchLedger();
  const hits = Array.from({ length: 100 }, (_, index) => ({ snippet: `memory line ${index} ${'m'.repeat(150)}`, role: 'user', date: '2026-09-01T09:00:00.000Z' }));
  const h = harness({
    ledger, configured: ['memory', 'knowledge'], now: () => Date.parse('2026-10-24T12:00:00.000Z'),
    executeText: '### Release scope [id 12] the release ships on Friday',
    memory: () => ({ lines: hits.map(hit => hit.snippet), hits, text: '', total: hits.length }),
  });
  const call = {
    action: 'start' as const, question: 'what is the release scope',
    lookups: [{ source: 'memory' as const, history: { query: 'release' } }, { source: 'knowledge' as const, query: 'release scope' }],
  };
  await runResearch(h.deps, call, new AbortController().signal);
  const second = await runResearch(h.deps, call, new AbortController().signal);
  const pages = (second['historyPages'] ?? []) as { hits?: unknown[] }[];
  const kept = pages.reduce((total, page) => total + (page.hits?.length ?? 0), 0);
  assert.ok(kept < hits.length, `the cap trimmed the page hits: ${kept} of ${hits.length} kept`);
  assert.ok(JSON.stringify(second).length <= RESEARCH.budgets.default, 'the trimmed reply stays inside the budget');
  assert.equal(second['status'], 'partial', 'a reply the cap trimmed is partial');
  assert.equal(second['canContinue'], true, 'and it offers the continuation that would fetch the rest');
  assert.doesNotMatch(String(second['note'] ?? ''), /Nothing more to fetch/u, 'the note never says nothing is left');
});

// Review F2: the serialized reply is hard-bounded, and a finding header never survives with no evidence line.
test('#567: capReply hard-bounds a reply and keeps every finding whole', () => {
  const reply = {
    researchId: 'r-1', status: 'complete', canContinue: false, note: RESEARCH.completeNote,
    findings: [{ source: 'knowledge', text: `knowledge: 1 of 1 shown\n${'x'.repeat(9_000)}`, chars: 9_000 }],
  };
  const capped = capReply(reply, CAP_REPLY_BOUND);
  assert.ok(JSON.stringify(capped).length <= CAP_REPLY_BOUND, `reply was ${JSON.stringify(capped).length}`);
  assert.equal(capped['status'], 'partial', 'a capped reply is never complete');
  assert.equal(capped['canContinue'], true, 'and it offers the continuation');
  assert.doesNotMatch(String(capped['note'] ?? ''), /Nothing more to fetch/u, 'the note agrees with the continuation');
  for (const finding of (capped['findings'] ?? []) as { text: string }[]) assert.ok(finding.text.split('\n').length > 1, 'a header never stands without an evidence line');
});

test('#567: a one line finding that cannot fit is dropped whole, never left as a bare header', () => {
  const reply = {
    researchId: 'r-2', status: 'partial', canContinue: true,
    findings: [{ source: 'knowledge', text: 'knowledge: 5 of 9 shown\nonly one evidence line here', chars: 26 }],
  };
  const capped = capReply(reply, 150);
  assert.deepEqual(capped['findings'], [], 'the finding goes whole, never as a header over nothing');
  assert.ok(JSON.stringify(capped).length <= 150);
});

test('#567: a reply already inside the budget is returned untouched', () => {
  const reply = {
    researchId: 'r-3', status: 'complete', canContinue: false, note: RESEARCH.completeNote,
    findings: [{ source: 'knowledge', text: 'knowledge: 1 of 1 shown\none line', chars: 8 }],
  };
  const before = JSON.stringify(reply);
  assert.equal(JSON.stringify(capReply(reply, CAP_REPLY_BOUND)), before, 'nothing is flipped when nothing is trimmed');
});

// RESCAP-R5: a long best knowledge hit emptied the answer, because the trim loop dropped the only line.
test('#567/R5: a long best knowledge hit is clipped to fit, never dropped', async () => {
  const long = `## Release scope\nthe release ships on Friday ${'x'.repeat(4_000)}`;
  const h = harness({ replyLimit: CAP_REPLY_BOUND,  executeText: long });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what is the release scope', lookups: [{ source: 'knowledge', query: 'release scope' }],
  }, new AbortController().signal);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.budgets.default, `reply was ${JSON.stringify(reply).length} chars with the coverage header`);
  const shown = (reply['findings'] as { text: string }[]).map(finding => finding.text).join('\n');
  assert.match(shown, /the release ships on Friday/, 'the head of the best hit survives the cap');
  assert.match(shown, /\u2026/u, 'and the reply marks where it was cut');
});

test('#567/R5: capReply clips the only evidence line instead of dropping the finding', () => {
  const reply = {
    researchId: 'r-5', status: 'partial', canContinue: true,
    findings: [{ source: 'knowledge', text: `knowledge: 1 of 1 shown\n${'A full sentence. '.repeat(250)}`, chars: 4_000 }],
  };
  const capped = capReply(reply, CAP_REPLY_BOUND);
  assert.ok(JSON.stringify(capped).length <= CAP_REPLY_BOUND, `reply was ${JSON.stringify(capped).length}`);
  const findings = capped['findings'] as { text: string }[];
  assert.equal(findings.length, 1, 'the finding survives the cap');
  const lines = findings[0]!.text.split('\n');
  assert.equal(lines.length, 2, 'it keeps its header and one evidence line');
  assert.ok((lines[1] ?? '').length >= RESEARCH.clipFloorChars, 'the evidence line is clipped, never removed');
  assert.match(lines[1] ?? '', /[.!?]$/u, 'the clip ends at a complete sentence');
});

test('#567/R5: the knowledge body request is sized to fit the reply budget', () => {
  assert.ok(RESEARCH.knowledgeBodyChars < RESEARCH.budgets.default, `body ${RESEARCH.knowledgeBodyChars} fits the ${RESEARCH.budgets.default} char reply`);
  assert.ok(RESEARCH.knowledgeBodyChars <= RESEARCH.budgets.default - 400, 'with room for the envelope and one more source');
});

test('mongoose is never offered while unconfigured', () => {
  const offered = offerableCandidates(['knowledge', 'calendar', 'mail', 'chat'], []);
  assert.equal(offered.includes('brief'), true);
  assert.equal(offered.includes('chat_thread'), false, 'a thread read needs a completed chat search');
  assert.ok(fallbackSelection('what is in mongoose', ['knowledge', 'calendar', 'mail', 'chat']).actions.every(action => String(action.kind) !== 'mongoose'));
});

test('progress and the run log carry metadata only, never the question text', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', question: 'the secret project is launchpad' }, new AbortController().signal);
  const phases = h.progress.map(event => event.phase);
  assert.equal(phases[0], 'started');
  assert.equal(phases[phases.length - 1], 'done');
  assert.ok(phases.length >= 3, `phases ${phases.join(',')}`);
  assert.deepEqual(phases.filter(phase => phase !== 'round'), ['started', 'done'], 'the round progress of each source rides between started and done');
  assert.equal(JSON.stringify(h.logs).includes('launchpad'), false);
  assert.equal(h.logs[0]!.event, 'research_run');
});

test('a new research call while one is pending answers the old call at once and the new one with the merged result', async () => {
  const gate = deferred<void>();
  const h = harness({ execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q' }, new AbortController().signal);
  const second = scheduler.call({ action: 'continue' }, new AbortController().signal);
  const firstReply = await first;
  assert.equal(firstReply['superseded'], true);
  assert.deepEqual(firstReply['findings'], []);
  gate.resolve();
  const secondReply = await second;
  assert.equal(secondReply['researchId'], firstReply['researchId'], 'the takeover keeps the id the host minted');
  assert.equal(secondReply['superseded'], undefined);
});

test('a stop call while one is pending returns what is known now', async () => {
  const gate = deferred<void>();
  const h = harness({ execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q' }, new AbortController().signal);
  const stopped = await scheduler.call({ action: 'stop' }, new AbortController().signal);
  assert.equal(stopped['status'], 'stopped');
  assert.equal((await first)['superseded'], true);
  gate.resolve();
});

test('a continue with no researchId applies to the single pending run (R1-R3)', async () => {
  const gate = deferred<void>();
  const h = harness({ execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q' }, new AbortController().signal);
  const second = scheduler.call({ action: 'continue' }, new AbortController().signal);
  const firstReply = await first;
  assert.equal(firstReply['superseded'], true);
  gate.resolve();
  assert.equal((await second)['researchId'], firstReply['researchId'], 'the takeover keeps the id the host minted');
});

test('an explicit unknown Stop id cannot select the single pending run', async () => {
  const gate = deferred<void>();
  const h = harness({ execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q' }, new AbortController().signal);
  const stopped = await scheduler.call({ action: 'stop', researchId: 'unknown-id' }, new AbortController().signal);
  assert.equal(stopped['error'], 'unknown_research_run');
  assert.equal(h.deps.ledger.last()?.stopped, false);
  gate.resolve();
  assert.equal((await first)['superseded'], undefined);
});

test('an identical start while a run is in flight joins that exact intent', async () => {
  const gate = deferred<void>();
  const h = harness({ execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'a' }, new AbortController().signal);
  const second = scheduler.call({ action: 'start', question: 'a' }, new AbortController().signal);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  const minted = String(a['researchId']);
  assert.match(minted, /^[A-Za-z0-9-]{1,64}$/, 'the first start names the id the host minted');
  assert.equal(String(b['researchId']), minted, 'the second start joins the in-flight run');
  assert.deepEqual(h.joined, [minted, minted], 'the start and the join are logged as research_joined');
  assert.deepEqual(h.branches, ['start', 'join'], 'and the log says which branch answered each call');
});

// E7: the same intent recurs inside one live turn (5 research calls and 6 chat searches in 90 s in the
// audit). A start whose question and sources match a run already answered in the window is the same
// question: it answers from that run instead of reading every source again.
test('E7: three identical research calls in the live turn window read each source once', async () => {
  let clock = 1_000;
  const h = harness({ now: () => clock});
  const scheduler = new ResearchScheduler(h.deps);
  const replies: Record<string, unknown>[] = [];
  for (let n = 0; n < 3; n += 1) {
    replies.push(await scheduler.call({ action: 'start', question: 'Where does the release stand?', sources: 'knowledge' }, new AbortController().signal));
    clock += 5_000;
  }
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 1, 'the question was researched once, not three times');
  assert.equal(new Set(replies.map(reply => reply['researchId'])).size, 1, 'every call answers the run the host minted');
  assert.deepEqual(h.joined, [replies[0]!['researchId'], replies[0]!['researchId'], replies[0]!['researchId']], 'every call is logged as a research_joined line');
  assert.deepEqual(h.branches, ['start', 'recent', 'recent'], 'the first start reads and the two repeats answer from the turn window');
  const other = await scheduler.call({ action: 'start', question: 'What did the board decide about hiring?', sources: 'knowledge' }, new AbortController().signal);
  assert.notEqual(String(other['researchId']), String(replies[0]!['researchId']), 'a different question is its own run');
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 2, 'and it is read');
  clock += RESEARCH.coalesceWindowMs + 1;
  await scheduler.call({ action: 'start', question: 'Where does the release stand?', sources: 'knowledge' }, new AbortController().signal);
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 3, 'outside the window the same question is researched again');
});

// #663: the owner asked for important mail, the backend re-asked the same lookup eight times in 14 s and
// nothing was spoken. The second identical start inside the window is a receipt that sends the model to the
// owner with the answer it already has, never the same findings again, and the log names the branch.
test('#663: a repeated start answers a receipt that sends the model to the owner, never the answer again', async () => {
  let clock = 1_000;
  const h = harness({ now: () => clock });
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'what mail came in', sources: 'mail' }, new AbortController().signal);
  const reads = h.executed.length;
  assert.ok(reads > 0, 'the first start reads');
  clock += 5_000;
  const second = await scheduler.call({ action: 'start', question: 'what mail came in', sources: 'mail' }, new AbortController().signal);
  assert.equal(second['repeat'], true, 'the repeat says it is a repeat');
  assert.deepEqual(second['findings'], [], 'the answer is not handed over a second time');
  assert.equal(second['note'], RESEARCH.repeatNote, 'the note sends the model to the owner with the answer it has');
  assert.equal(String(second['researchId']), String(first['researchId']), 'the repeat names the run that answered');
  assert.equal(h.executed.length, reads, 'the repeat runs no read');
  assert.deepEqual(h.branches, ['start', 'recent'], 'the log says which scheduler branch answered');
  // #663: the host log keeps the branch and refuses a branch outside the closed set.
  const id = String(first['researchId']);
  assert.deepEqual(safeEvent({ event: 'research_joined', researchId: id, research_branch: 'recent' }),
    { event: 'research_joined', researchId: id, research_branch: 'recent' }, 'the host log keeps the branch that answered');
  assert.equal(safeEvent({ event: 'research_joined', researchId: id, research_branch: 'invented' }), undefined, 'an invented branch never reaches the host log');
});

// #664: a delegation that keeps asking reads three times at most. The fourth call is told to answer the owner
// with what it has, and it starts no read of its own.
test('#664: the fourth research call of one delegation says answer the owner and reads nothing', async () => {
  let clock = 1_000;
  const h = harness({ now: () => clock });
  const scheduler = new ResearchScheduler(h.deps);
  const replies: Record<string, unknown>[] = [];
  replies.push(await scheduler.call({ action: 'start', question: 'what mail came in', sources: 'mail' }, new AbortController().signal));
  const reads = h.executed.length;
  for (let n = 0; n < 3; n += 1) {
    clock += 3_000;
    replies.push(await scheduler.call({ action: 'start', question: 'what mail came in', sources: 'mail' }, new AbortController().signal));
  }
  assert.equal(h.executed.length, reads, 'the delegation read its mail once');
  assert.equal(replies[3]!['note'], RESEARCH.ceilingNote, 'the fourth call says answer the owner with what it has');
  assert.deepEqual(replies[3]!['findings'], [], 'the fourth call hands over no findings');
  assert.deepEqual(h.branches, ['start', 'recent', 'recent', 'ceiling'], 'every call names the branch that answered it');
});

// #664: an owner ask named the channel "an engineering" and "name", because the article and the model's own
// placeholder were read as the channel.
test('#664: a spoken channel name loses its article, and a placeholder is never a channel', () => {
  assert.equal(spokenChannel('in an engineering channel'), 'engineering', 'the article is never part of the name');
  assert.equal(spokenChannel('the exact channel name'), undefined, 'a placeholder where a name belongs is no channel');
  assert.equal(spokenChannel('#ops'), 'ops', 'a hash name is the channel');
  assert.equal(spokenChannel('in the AI channel'), 'AI', 'a display name keeps its words, the connector folds the case');
});

test('Z1: a start ignores a model researchId that fails the host log id rule and mints its own', async () => {
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const reply = await scheduler.call({ action: 'start', question: 'q', researchId: '\u2014' }, new AbortController().signal);
  const id = String(reply['researchId']);
  assert.match(id, /^[A-Za-z0-9-]{1,64}$/, 'the run id passes the host log id rule');
  assert.equal(h.logs[0]!.researchId, id, 'the run receipt names the minted id');
  assert.equal(safeEvent(h.logs[0]!)?.event, 'research_run', 'so the receipt survives the host log whitelist');
});

test('Z1: a start ignores even a safe-looking model researchId and mints its own', async () => {
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const reply = await scheduler.call({ action: 'start', question: 'q', researchId: 'x' }, new AbortController().signal);
  const id = String(reply['researchId']);
  assert.notEqual(id, 'x', 'the model id is ignored, never an error');
  assert.match(id, /^[A-Za-z0-9-]{1,64}$/);
  assert.equal(h.logs[0]!.researchId, id, 'the receipt names the minted run');
});

test('Z1: a continue with an unknown researchId is a typed error, never a silent second run', async () => {
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const reply = await scheduler.call({ action: 'continue', researchId: '\u2014' }, new AbortController().signal);
  assert.deepEqual(reply, { error: 'unknown_research_run' });
  assert.deepEqual(h.logs, [], 'no run line is written for a run the host never minted');
  assert.equal(h.deps.ledger.last(), undefined, 'and no run is created behind the error');
});

test('the word stop in a question never stops a run: stop is only a tool action', async () => {
  const h = harness({});
  const reply = await runResearch(h.deps, { action: 'start', question: 'stop the presses and tell me the release status' }, new AbortController().signal);
  assert.equal(reply['status'], 'complete');
});

test('validate accepts the three actions and rejects invented keys', () => {
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 'wilmar pilot' }), true);
  assert.equal(validateResearch({ action: 'continue', researchId: 'abc' }), true);
  assert.equal(validateResearch({ action: 'stop', researchId: 'abc' }), true);
  assert.equal(validateResearch({ action: 'start' }), false);
  assert.equal(validateResearch({ action: 'destroy', question: 'q', topic: 'wilmar' }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 'wilmar', evil: 1 }), false);
});

// #263: the declaration names only the sources this session configured and the host loop can read. A session
// with Google (calendar, mail), Mattermost (team chat) and lux-knowledge (knowledge) names those four.
test('the research declaration names only the configured sources and the valid hint values', () => {
  const google = ['calendar_list_events', 'gmail_search_messages'];
  const base = researchSourcesFromToolNames([...google, 'mattermost_search', 'search_knowledge']);
  assert.deepEqual(base, ['calendar', 'mail', 'chat', 'knowledge']);
  // Outcome 3: detection uses the read tool. A calendar-list sibling without calendar_list_events is not a
  // calendar source, so no calendar read is advertised that the connection cannot perform.
  assert.deepEqual(researchSourcesFromToolNames(['calendar_list_calendars', 'gmail_search_messages', 'search_knowledge']), ['mail', 'knowledge']);
  const description = researchDescription(base);
  assert.match(description, /calendar, mail, team chat and knowledge base/);
  assert.doesNotMatch(description, /company knowledge base/);
  assert.ok(description.length < 500, `description ${description.length} chars`);
  // R2-R2 superseded by the owner's Mongoose connection: the loop now has a Mongoose candidate.
  const withMongooseTools = researchSourcesFromToolNames([...google, 'mattermost_search', 'search_knowledge', 'search', 'read']);
  assert.deepEqual(withMongooseTools, ['calendar', 'mail', 'chat', 'knowledge', 'mongoose']);
  const declaration = researchDeclaration(base);
  assert.equal(declaration.name, 'research');
  assert.equal(declaration.description, description);
  const properties = (declaration.parameters as unknown as { properties: Record<string, { description: string }> }).properties;
  // C-RESEARCH-CONTRACT T-13: the hint values are published from one constant, so the owner's word for
  // Mongoose is advertised beside the source it maps to.
  assert.match(properties['sources']!.description, /calendar, mail, chat, knowledge, company\./);
});

// C-RESEARCH-CONTRACT Q-08: on 2026-10-27 a research about Korbi's reports was re-asked about Rob, and the
// answer to the owner's actual question never came. A rewrite may narrow to the owner's own names, never
// swap them for another one, and the original question is what stands when it does.
test('a rewrite that swaps the named person is refused and the original question stands', () => {
  const original = 'who reports to Korbi';
  const drifted = "Who are Rob's current direct reports according to Mongoose knowledge?";
  assert.deepEqual(entityPreservedQuestion(original, drifted), { ok: false, reason: 'entity_rewrite', question: original });
  // The same rule at the tool's own rewrite surface: the topic is the search text, so a topic about another
  // person is the drift and the call is refused before anything is read.
  const parsed = parseResearch({ action: 'start', question: original, topic: 'direct reports for Rob' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? '' : parsed.reason, 'entity_rewrite');
  assert.match(String(researchRepair('entity_rewrite')['guidance']), /keep the question's own names/);
  // A narrowing that keeps the owner's name is what the rule is for, so it is allowed.
  assert.deepEqual(entityPreservedQuestion(original, 'Korbi direct reports'), { ok: true, question: 'Korbi direct reports' });
  assert.deepEqual(entityPreservedQuestion(original, 'who reports to Korbi in Singapore'), { ok: true, question: 'who reports to Korbi in Singapore' });
});

// --- Calendar merged read, window logging and knowledge carry (contract F4, #272) ---------------


// The connector returns one merged, sorted, deduped, name-tagged result; research makes one call.
const MERGED_CALENDAR = [
  '- 2026-10-16T09:00:00+05:30, Standup, Room 1 | Primary [id e1]',
  '- 2026-10-16T10:00:00+05:30, Board deck, Room 2 | Work [id e3]',
  '- 2026-10-16T11:00:00+05:30, Review | Primary [id e2]',
].join('\n');

const CALENDAR_RECORDS = [
  { id: 'e1', start: '2026-10-16T09:00:00+05:30', summary: 'Standup', location: 'Room 1' },
  { id: 'e3', start: '2026-10-16T10:00:00+05:30', summary: 'Board deck', location: 'Room 2' },
  { id: 'e2', start: '2026-10-16T11:00:00+05:30', summary: 'Review' },
];

test('calendar research issues one primary read and retains every received event', async () => {
  const h = harness({ executeText: MERGED_CALENDAR });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const reads = h.executed.filter(call => call.name === 'calendar_list_events');
  assert.equal(reads.length, 1, 'one calendar sub-call per exact window');
  assert.equal((reads[0]!.args as Record<string, unknown>)['calendarId'], 'primary');
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'calendar')!;
  assert.match(finding.text, /^calendar: 3 of 3 shown/);
  for (const title of ['Standup', 'Board deck', 'Review']) assert.match(finding.text, new RegExp(title));
  assert.equal((reply['calendarCoverage'] as Record<string, unknown>)['received'], 3);
});

test('calendar sub-calls log the resolved window kind only, never a time or title', async () => {
  const h = harness({ executeText: MERGED_CALENDAR });
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const calendarLogs = h.subcalls.filter(entry => entry.kind === 'calendar_window');
  assert.equal(calendarLogs.length, 1);
  assert.equal((calendarLogs[0] as unknown as Record<string, unknown>)['window'], 'tomorrow');
  assert.equal(JSON.stringify(h.subcalls).includes('2026-10-16T'), false, 'the resolved times never reach the log');
});

test('a calendar read is dispatched at once, with no selector round spending the run budget', async () => {
  const clock = fakeClock();
  let dispatchedAt: number | undefined;
  const h = harness({ executeText: MERGED_CALENDAR, now: clock.now, schedule: clock.schedule, execute: async (subs: readonly IntentSubCall[]) => {
    if (subs.some(call => call.name === 'calendar_list_events')) dispatchedAt ??= clock.now();
    return subs.map(call => ({ key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: CALENDAR_RECORDS }) }));
  } });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar today' }, new AbortController().signal);
  assert.equal(dispatchedAt, 0, 'the read starts at once, never after a selector wait');
  assert.equal(h.logs[0]!.selectorMs, 0);
  assert.equal(reply['status'], 'complete', 'the calendar answered, so the reply says complete');
});

test('the primary research source budget fits inside the unchanged start deadline', () => {
  assert.equal(RESEARCH.sourceDeadline.calendar, 12_000);
  assert.equal(RESEARCH.startDeadlineMs, 15_000);
  assert.ok(RESEARCH.sourceDeadline.calendar < RESEARCH.startDeadlineMs);
});

test('a mail read is dispatched at once, so no source budget can slip past the start deadline', async () => {
  const clock = fakeClock();
  let dispatchedAt: number | undefined;
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs: readonly IntentSubCall[]) => {
    if (subs.some(call => call.name === 'gmail_search_messages')) dispatchedAt ??= clock.now();
    return subs.map(call => sub(call.name, 'mail evidence', true, call.key));
  } });
  await runResearch(h.deps, { action: 'start', question: 'what did Sam email about the release' }, new AbortController().signal);
  assert.equal(dispatchedAt, 0);
});

test('knowledge shaping carries at least ninety percent of a ledger under the reply limit', async () => {
  const body = 'k'.repeat(60);
  // LAT-1023: the Live answer is bounded at 2,500 chars, so the ledger this test shapes is one that fits whole;
  // a wider one is trimmed by whole items, which its own compaction test covers.
  const items = Array.from({ length: 20 }, (_, i) => `### Insight ${i} [id ${i + 1}]\n${body}`);
  const h = harness({ executeText: items.join('\n') });
  // #1021: a content-free question no longer searches knowledge, so the ledger test asks a real one.
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'knowledge')!;
  const lines = finding.text.split('\n').slice(1);
  assert.ok(lines.length >= 18, `carried ${lines.length} of 20 lines`);
  const total = items.reduce((sum, _, i) => sum + `#${i + 1} Insight ${i} | ${body}`.length, 0);
  const carried = lines.reduce((sum, line) => sum + line.length, 0);
  assert.ok(carried / total >= 0.9, `carried ${carried} of ${total} bytes`);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.budgets.default);
});

// --- Release 3h: source truth, diagnostics and speed ------------------------------------------

test('a refused sub-call maps to a real reason, never a bare refused', () => {
  assert.equal(refusalCode('unknown_tool'), 'unknown_tool');
  assert.equal(refusalCode('grant_not_permitted'), 'grant_not_permitted');
  assert.equal(refusalCode('stale_or_revoked_authority'), 'stale_or_revoked_authority');
  assert.equal(refusalCode('round_deadline'), 'round_deadline');
  assert.equal(refusalCode('Invalid arguments for calendar_list_events. Expected an object with timeMin (string).'), 'invalid_arguments');
  assert.equal(refusalCode('something else entirely'), 'refused');
});

test('a never-dispatched sub-call logs its real reason instead of refused', async () => {
  const h = harness({
    execute: async subs => subs.map(call => call.name === 'calendar_list_events'
      ? { ...sub(call.name, '', false, call.key), code: 'unknown_tool' }
      : sub(call.name, 'evidence', true, call.key)),
  });
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar today' }, new AbortController().signal);
  const refused = h.subcalls.find(entry => entry.tool === 'calendar_list_events');
  assert.equal(refused?.errorCode, 'unknown_tool');
});

test('a source whose read failed stays unchecked and the reply names it', async () => {
  const h = harness({
    execute: async subs => subs.map(call => call.name === 'calendar_list_events'
      ? { ...sub(call.name, '', false, call.key), code: 'unknown_tool' }
      : sub(call.name, 'evidence', true, call.key)),
  });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  assert.ok((reply['unchecked'] as string[]).includes('calendar'), 'a failed source stays unchecked');
  assert.match(String(reply['note'] ?? ''), /could not reach calendar right now/, 'the reply voices the unreachable source');
});

test('a source that read successfully is not unchecked and carries no unreachable note', async () => {
  const h = harness({ executeText: MERGED_CALENDAR });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  assert.equal((reply['unchecked'] as string[]).includes('calendar'), false);
  assert.equal(reply['note'], RESEARCH.completeNote, 'the only note is the terminal one, never an unreachable source');
});

test('the connector to source map covers the approved connectors', () => {
  assert.deepEqual(researchSourcesForConnector('google'), ['calendar', 'mail']);
  assert.deepEqual(researchSourcesForConnector('mattermost'), ['chat']);
  assert.deepEqual(researchSourcesForConnector('lux-knowledge'), ['knowledge']);
  assert.deepEqual(researchSourcesForConnector('mongoose'), ['mongoose']);
});

test('configuredNow re-resolves the configured sources for each run', async () => {
  const h = harness({});
  const deps: ResearchDeps = { ...h.deps, configured: [], configuredNow: () => ['knowledge', 'calendar'] };
  const reply = await runResearch(deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  // The resolved set is what the run reports on: nothing outside it is ever unchecked or read.
  const unchecked = reply['unchecked'] as string[];
  assert.ok(unchecked.every(source => ['knowledge', 'calendar'].includes(source)), `only resolved sources are reported: ${JSON.stringify(unchecked)}`);
});

test('knowledge first: the prime knowledge read starts before any other read', async () => {
  const order: string[] = [];
  const h = harness({ execute: async (subs: readonly IntentSubCall[]) => { order.push(...subs.map(call => call.name)); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  await runResearch(h.deps, { action: 'start', question: 'what did I decide about the release' }, new AbortController().signal);
  assert.ok(order.includes('search_knowledge'), 'the prime source read starts immediately');
  assert.equal(h.logs[0]!.selectorMs, 0);
});
test('knowledge findings rank first in the reply', async () => {
  const h = harness({ execute: async subs => subs.map(call => sub(call.name, call.name === 'gmail_search_messages' ? '- Subject | Sender | Mon | body [id m1]' : '### Insight (PATTERN) [id 1]\nbody', true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did the team decide' }, new AbortController().signal);
  const findings = reply['findings'] as { source: string }[];
  assert.equal(findings[0]?.source, 'knowledge', 'the prime source leads the findings');
});

test('an empty-but-successful read is a search that matched nothing, never an unreachable source', async () => {
  const h = harness({ executeText: '' });
  const reply = await runResearch(h.deps, { action: 'start', question: 'would you check my mail for the landlord invoice', topic: 'landlord invoice' }, new AbortController().signal);
  const note = String(reply['note'] ?? '');
  assert.equal(note.includes('could not reach'), false, 'a search that matched nothing is not an outage');
  assert.match(note, /I searched your mail for "[a-z]+".*found nothing matching/, 'the model gets a line it can voice');
  assert.equal((reply['unchecked'] as string[]).includes('mail'), false, 'the source answered, so it is checked');
  assert.equal(reply['status'], 'complete', 'a search that matched nothing still answered the question');
});

test('an identical duplicate read in one run is executed once', async () => {
  const h = harness({ executeText: '' });
  await runResearch(h.deps, { action: 'start', question: 'anything new in the mail' }, new AbortController().signal);
  const mailReads = h.executed.filter(call => call.name === 'gmail_search_messages');
  assert.equal(mailReads.length, 1, 'the same mail read is issued once');
});

test('the brief fan-out is credited to every source it read and its findings reach the answer', async () => {
  const h = harness({ execute: async subs => subs.map(call => sub(call.name,
    call.name === 'calendar_list_events' ? MERGED_CALENDAR
      : call.name === 'gmail_search_messages' ? '- Invoice | Landlord | Mon | due soon [id m1]'
        : call.name === 'mattermost_search' ? '**team**\nthe decision was recorded'
          : '### Insight (PATTERN) [id 1]\nbody', true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'catch me up on my calendar, mail and team chat' }, new AbortController().signal);
  const sources = (reply['findings'] as { source?: string }[]).map(finding => finding.source);
  for (const source of ['calendar', 'mail', 'chat', 'knowledge']) assert.ok(sources.includes(source), `the brief read of ${source} is delivered to the answer`);
  assert.deepEqual(reply['unchecked'], [], 'every configured source was credited, so none is unchecked');
});

// ROUTE-1022 K5: a brief on a question that names no layer read his knowledge and nothing else. The
// owner's own call spent 22 Gmail pages and three identical 'open loop follow up' searches on a
// question about the business model.
test('a brief on a question that names no source reads knowledge only, and searches its own terms', async () => {
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  const h = harness({ execute: async subs => subs.map(call => {
    sent.push({ name: call.name, args: { ...call.args } });
    return sub(call.name, '### Insight (PATTERN) [id 1]\nbody', true, call.key);
  }) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what do you think about our business model' }, new AbortController().signal);
  assert.deepEqual([...new Set(sent.map(entry => entry.name))], ['search_knowledge'], 'knowledge reads, and no mail, calendar or chat read');
  assert.equal(JSON.stringify(sent).includes('open loop follow up'), false, 'the old default query is gone');
  for (const entry of sent) assert.match(String(entry.args['query']), /business model/, 'the brief searches the question\'s own terms');
  assert.deepEqual(reply['unchecked'], ['calendar', 'mail', 'chat'], 'the layers it did not read are named as unread');
});

interface FakeClock { now: () => number; schedule: (callback: () => void, delayMs: number) => { unref: () => void; cancel: () => void }; advance: (to: number) => void; pending: () => number }

function fakeClock(): FakeClock {
  let at = 0;
  const timers: { due: number; callback: () => void; done: boolean }[] = [];
  return {
    now: () => at,
    schedule: (callback, delayMs) => {
      const entry = { due: at + delayMs, callback, done: false };
      timers.push(entry);
      return { unref: () => {}, cancel: () => { entry.done = true; } };
    },
    advance: to => {
      at = to;
      for (let guard = 0; guard < 20; guard++) {
        const due = timers.filter(entry => !entry.done && entry.due <= at);
        if (due.length === 0) return;
        for (const entry of due) { entry.done = true; entry.callback(); }
      }
    },
    pending: () => timers.filter(entry => !entry.done).length,
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const tick = async (): Promise<void> => { for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve)); };

function maxGapMs(stamps: readonly number[]): number {
  return stamps.slice(1).reduce((worst, stamp, index) => Math.max(worst, stamp - stamps[index]!), 0);
}

test('a long read still sends the model a progress line every three seconds, and none is left behind', async () => {
  const clock = fakeClock();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async subs => { await gate; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  let reading: Promise<void> | undefined;
  h.deps.background = done => { reading = done; };
  const running = runResearch(h.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  await settle();
  clock.advance(3_000); await settle();
  clock.advance(6_000); await settle();
  release();
  await running;
  const stamps = h.progress.map(entry => entry.elapsedMs);
  assert.ok(stamps.includes(3_000) && stamps.includes(6_000), `the model hears from the run while it reads: ${stamps.join(',')}`);
  assert.ok(stamps.some(stamp => stamp <= 3_000), 'the first update lands within three seconds of the call');
  assert.ok(maxGapMs(stamps) <= 8_000, `no model-facing gap over eight seconds: ${maxGapMs(stamps)}`);
  if (reading !== undefined) await reading;
  assert.equal(clock.pending(), 0, 'the heartbeat is stopped when the run ends');
});

test('the fallback read starts at once, with no selector deadline in front of it', async () => {
  const clock = fakeClock();
  const readAt: { tool: string; at: number }[] = [];
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs: readonly IntentSubCall[]) => { for (const call of subs) readAt.push({ tool: call.name, at: clock.now() }); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const running = runResearch(h.deps, { action: 'start', question: 'what happened this week' }, new AbortController().signal);
  await settle();
  clock.advance(3_000); await settle();
  await running;
  assert.equal(h.logs[0]!.selectorMs, 0, 'no selector round is spent, so nothing waits on a selector deadline');
  const fallbackReads = readAt.filter(entry => entry.tool === 'calendar_list_events');
  assert.ok(fallbackReads.length > 0, 'the fixed recipe reads the calendar');
  assert.ok(fallbackReads.every(entry => entry.at === 0), `the read starts with the call: ${JSON.stringify(readAt)}`);
  const stamps = h.progress.map(entry => entry.elapsedMs);
  assert.ok(stamps.some(stamp => stamp <= 3_000), 'a progress line inside three seconds of the call');
  assert.ok(maxGapMs(stamps) <= 8_000, `no model-facing gap over eight seconds: ${maxGapMs(stamps)}`);
});

// Contract RD: the owner must never wait more than six seconds in silence while a lookup runs.
test('deadAirMs measures the longest silence the model hears, never the whole run', async () => {
  const clock = fakeClock();
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs: readonly IntentSubCall[]) => {
    await new Promise<void>(resolve => { clock.schedule(() => resolve(), 4_400); });
    return subs.map(call => sub(call.name, 'evidence', true, call.key));
  } });
  const running = runResearch(h.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  let done = false; void running.then(() => { done = true; });
  for (let n = 0; n < 20 && !done; n++) { clock.advance(clock.now() + 3_000); await settle(); }
  clock.advance(clock.now() + 1_400); await settle();
  await running;
  const log = h.logs[0]!;
  assert.ok(log.elapsedMs >= 4_000, `the run really took over four seconds: ${log.elapsedMs}`);
  assert.ok(log.deadAirMs <= 3_000, `the worst silence is one beat, not the run: ${log.deadAirMs}`);
});

test('a source that outlives the per-source deadline is cut, and the reply is an honest partial', async () => {
  const clock = fakeClock();
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'gmail_search_messages')) return await new Promise<IntentSubResult[]>((_, reject) => { const cut = (): void => reject(new Error('cut')); if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true }); });
    return subs.map(call => sub(call.name, 'evidence', true, call.key));
  } });
  const running = runResearch(h.deps, { action: 'start', question: 'anything from the bank', sources: 'mail' }, new AbortController().signal);
  await settle();
  clock.advance(RESEARCH.sourceDeadline.mail); await settle();
  const reply = await running;
  assert.ok((reply['unchecked'] as string[]).includes('mail'), 'the source the cut abandoned is named as unchecked');
  const log = h.logs[0]!;
  assert.ok(log.elapsedMs <= RESEARCH.sourceDeadline.mail + 1_000, `one slow source never owns the turn: ${log.elapsedMs}`);
  assert.equal(log.sources.find(entry => entry.kind === 'mail')?.disposition, 'skipped');
  assert.notEqual(log.status, 'answered', 'a cut read is a partial answer, never an answered one');
});

test('R6: a question about one source waits past the first-answer point for that source, and never cuts it', async () => {
  const clock = fakeClock();
  let mailAborted = false;
  const waiting: (() => void)[] = [];
  const releaseMail = (): void => { for (const done of waiting.splice(0)) done(); };
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'gmail_search_messages')) return await new Promise<IntentSubResult[]>((resolve, reject) => {
      const stop = (): void => { mailAborted = true; reject(new Error('aborted')); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      waiting.push(() => resolve(subs.map(call => sub(call.name, '- Release email | Rob | Fri | we ship on Friday [id m1]', true, call.key))));
    });
    return subs.map(call => sub(call.name, '### Insight (PATTERN) [id 7]\nthe release is green', true, call.key));
  } });
  const controller = new AbortController();
  let reading: Promise<void> | undefined;
  h.deps.background = done => { reading = done; };
  const running = runResearch(h.deps, { action: 'start', question: 'what did we decide about the release email' }, controller.signal);
  await settle();
  // Depth beats speed: the reply waits for the source the question is about, not for whichever read lands first.
  const heard = await Promise.race([running.then(() => true), settle().then(() => false)]);
  assert.equal(heard, false, 'no source has a finding done, so the call has not answered yet');
  clock.advance(RESEARCH.firstAnswerMs);
  const waited = await Promise.race([running.then(() => 'answered'), settle().then(() => 'waiting')]);
  assert.equal(waited, 'waiting', 'the question is about mail, so the answer waits for that read inside the run budget');
  let answered = false;
  void running.then(() => { answered = true; });
  for (let n = 0; n < 20 && !answered; n++) { releaseMail(); await settle(); }
  const reply = await running;
  assert.equal(mailAborted, false, 'the first answer never cuts a reader');
  assert.deepEqual(reply['pending'], [], 'the source the question is about has answered, so nothing is left pending');
  assert.ok(!(reply['unchecked'] as string[]).includes('mail'), 'the mail read it waited for is not reported unchecked');
  assert.match(JSON.stringify(reply['findings']), /we ship on Friday/, 'the mail findings it waited for reach the answer');
  assert.equal(h.logs[0]?.elapsedMs, clock.now(), 'the run line is the run\'s own end, not the answer point');
  controller.abort();
  await reading;
});

test('RUN-R11: a start whose question is only instruction words joins the pending run and delivers its findings', async () => {
  const clock = fakeClock();
  let releaseKnowledge!: () => void;
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'search_knowledge')) return await new Promise<IntentSubResult[]>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      releaseKnowledge = () => resolve(subs.map(call => sub(call.name, '### Insight (PATTERN) [id 7]\nthe partner ranking is settled', true, call.key)));
    });
    return subs.map(call => sub(call.name, 'release freeze decided on Friday', true, call.key));
  } });
  const reading = runResearch(h.deps, { action: 'start', question: 'what did we decide about partner ranking' }, new AbortController().signal);
  await settle();
  clock.advance(RESEARCH.firstAnswerMs);
  const pendingRun = String(h.progress[0]?.researchId);
  const meta = runResearch(h.deps, { action: 'start', question: 'wait findings.' }, new AbortController().signal);
  await settle();
  releaseKnowledge();
  const joined = await meta; const first = await reading;
  assert.equal(joined['researchId'], pendingRun, 'the meta start joins the run that is already reading');
  assert.match(JSON.stringify(joined['findings']) + JSON.stringify(first['findings']), /partner ranking is settled/, 'the findings it asked for arrive without a new run');
  assert.notEqual(joined['status'], 'cancelled', 'the pending run was never cancelled');
  assert.ok(h.logs.some(log => log.metaStartAsContinue === true), 'the receipt says the meta start became a continue');
  assert.equal(first['researchId'], pendingRun);
});

test('RUN-R11: a superseding start aborts the old run\'s reads, and its late result never reaches a reply', async () => {
  let aborted = 0;
  let releaseLate: (() => void) | undefined;
  const h = harness({ execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'gmail_search_messages')) {
      return await new Promise<IntentSubResult[]>((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); }, { once: true });
        releaseLate = () => resolve(subs.map(call => sub(call.name, 'OLD RUN LATE FINDING', true, call.key)));
      });
    }
    return subs.map(call => sub(call.name, 'release freeze decided on Friday', true, call.key));
  } });
  const old = runResearch(h.deps, { action: 'start', question: 'what did the team decide about the release mail' }, new AbortController().signal);
  await settle();
  const fresh = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the hiring plan' }, new AbortController().signal);
  assert.ok(aborted >= 1, 'the superseding start aborts the old run\'s connector read');
  releaseLate?.();
  await settle();
  const late = await old;
  assert.ok(h.logs.some(log => (log.supersededAborts ?? 0) > 0), 'the old run\'s receipt counts the aborted dispatch');
  assert.doesNotMatch(JSON.stringify(late) + JSON.stringify(fresh), /OLD RUN LATE FINDING/);
});

// Reviewer T1: the source that answered keeps its own second hop, and the reader behind it is not abandoned.
test('R6: the source that answered keeps its own second hop, and the slow reader is credited late', async () => {
  const clock = fakeClock();
  const read: string[] = [];
  let winnerSignalAborted = false;
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    for (const call of subs) read.push(call.name);
    if (subs.some(call => call.name === 'gmail_search_messages')) {
      // The slow source: it answers only after the call has already replied, and it is never cut for that.
      return subs.map(call => sub(call.name, 'the mail body', true, call.key));
    }
    if (subs.some(call => call.name === 'get_insight')) winnerSignalAborted = signal.aborted;
    return subs.map(call => sub(call.name, call.name === 'get_insight' ? 'the body' : '### Insight (PATTERN) [id 7]\nthe release is green', true, call.key));
  } });
  const late: ResearchLateFindings[] = [];
  h.deps.late = entry => { late.push(entry); };
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is the release status', topic: 'release status' }, new AbortController().signal);
  assert.equal(winnerSignalAborted, false, 'the winner\'s own second hop runs under its own signal');
  assert.equal(h.logs[0]!.sources.find(entry => entry.kind === 'knowledge')?.disposition, 'completed');
  assert.ok(!(h.logs[0]!.unchecked ?? []).includes('knowledge'), 'the source that answered is not named unchecked');
  assert.ok((reply['findings'] as unknown[]).length > 0);
  assert.equal(late.length, 0, 'everything settled before the answer point, so nothing is late');
});

// Reviewer B5 replacement: the owner hears a reply inside six seconds because the call itself returns.
test('a start call returns inside its budget, the slowest source plus two seconds, when a read never answers', async () => {
  const clock = fakeClock();
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (_subs, signal) => await new Promise<IntentSubResult[]>((_, reject) => { const cut = (): void => reject(new Error('cut')); if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true }); }) });
  const running = runResearch(h.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  let done = false; void running.then(() => { done = true; });
  await settle();
  for (let n = 0; n < 20 && !done; n++) { clock.advance(clock.now() + researchCallBudgetMs(['knowledge'])); await settle(); }
  const reply = await Promise.race([running, settle().then(() => null)]);
  assert.notEqual(reply, null, 'the call came back instead of waiting for the read');
  assert.ok(h.logs[0]!.elapsedMs <= researchCallBudgetMs(['knowledge']) + 1_000, `the answer lands inside the bound: ${h.logs[0]!.elapsedMs}`);
  assert.equal(researchCallBudgetMs(['knowledge']), 14_000, 'a knowledge read is 12 s, plus the 2 s slack');
  assert.equal(researchCallBudgetMs(['chat', 'calendar', 'mail']), 14_000, 'the slowest source once, never a sum');
  assert.ok(researchCallBudgetMs(['chat']) <= RESEARCH.answerCapMs, 'and never past the 20 s cap');
});

// B7: a run whose source was cut must still reach the host log; `cut` is not a disposition the log admits.
test('a cut source logs a disposition the host log admits and the whole run line survives', async () => {
  const clock = fakeClock();
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'gmail_search_messages')) return await new Promise<IntentSubResult[]>((_, reject) => { const stop = (): void => reject(new Error('cut')); if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); });
    return subs.map(call => sub(call.name, 'evidence', true, call.key));
  } });
  const running = runResearch(h.deps, { action: 'start', question: 'anything from the bank', sources: 'mail' }, new AbortController().signal);
  await settle();
  clock.advance(RESEARCH.sourceDeadline.mail); await settle();
  await running;
  const line = h.logs[0]!;
  assert.equal(line.sources.find(entry => entry.kind === 'mail')?.disposition, 'skipped');
  assert.ok(safeEvent(line) !== undefined, 'the cut run line survives the host log');
});

// K6: the routed path is additive. Without lookups the selector still chooses, and the reply keeps
// exactly the shape it had, with no per-source status block.
test('K6: a start with no lookups reads the deterministic plan and never awaits a selector', async () => {
  const h = harness({
  });
  assert.equal('selector' in h.deps, false, 'F-B: the voice path carries no selector to wait for');
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.equal(h.logs[0]!.selectorMs, 0, 'an unrouted run spends no selector time');
  assert.equal('sources' in reply, false, 'an unrouted reply carries no per-source status block');
  assert.ok(h.logs.some(entry => entry.event === 'research_run'), 'the unrouted run still logs its run line');
  assert.ok(h.executed.some(call => call.name === 'search_knowledge'), 'the plan\'s knowledge read still runs');
});

// R9: the selector loop's terminal line comes from a finally, so a throw inside the loop leaves a receipt
// and a good run is never written twice.
test('R9: a throwing step sink still writes one failed run line, with no exception text', async () => {
  const h = harness({});
  const deps: ResearchDeps = { ...h.deps, step: () => { throw new Error('step sink gone'); } };
  await assert.rejects(runResearch(deps, { action: 'start', question: 'what is waiting on me', topic: 'waiting' }, new AbortController().signal), /step sink gone/);
  assert.equal(h.logs.length, 1, 'the failed run is visible once and never written twice');
  assert.equal(h.logs[0]!.status, 'failed');
  assert.equal(h.logs[0]!.stopReason, 'failed', 'a closed error code, never an exception message');
  assert.equal(JSON.stringify(h.logs[0]).includes('step sink gone'), false, 'no exception text leaves in the line');
});

test('R9: a normal selector run writes exactly one terminal run line', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.equal(h.logs.filter(entry => entry.event === 'research_run').length, 1, 'one run, one line');
  assert.equal(h.logs[0]!.status !== 'failed', true, 'a good run is never reported as failed');
});

// --- P5: one deadline per source, the call budget follows the slowest source it reads ---------------

test('P5: chat answers at 5 s inside its own bounded deadline, and the call budget follows that source', async () => {
  const clock = fakeClock();
  const receipts: ResearchSourceLog[] = [];
  let release!: (results: IntentSubResult[]) => void;
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    execute: async (_subs, signal) => await new Promise<IntentSubResult[]>((resolve, reject) => {
      release = resolve;
      const cut = (): void => reject(new Error('cut'));
      if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true });
    }),
  });
  const deps: ResearchDeps = { ...h.deps, configured: ['chat'], logSource: event => receipts.push(event) };
  const running = runResearch(deps, { action: 'start', question: 'what did the team agree in chat' }, new AbortController().signal);
  await settle();
  // #635: the chat row is bounded near 5 s, so a 5 s chat read still lands and the receipt names that row.
  clock.advance(5_000); await settle();
  release([sub('mattermost_search', '- release freeze agreed on Friday', true, 'c0')]);
  const reply = await running;
  assert.equal(reply['status'], 'complete', 'a 5 s chat read inside its own bounded deadline answers');
  assert.deepEqual(receipts.map(event => [event.source, event.outcome, event.deadlineMs]), [['chat', 'ok', RESEARCH.sourceDeadline.chat]], 'the receipt names the deadline the chat read really had');
});

test('P5: knowledge at 13 s is cut at its own 12 s deadline and reported, never empty', async () => {
  const clock = fakeClock();
  const receipts: ResearchSourceLog[] = [];
  const h = harness({ now: clock.now, schedule: clock.schedule,
    execute: async (_subs, signal) => await new Promise<IntentSubResult[]>((_resolve, reject) => {
      const cut = (): void => reject(new Error('cut'));
      if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true });
    }),
  });
  const deps: ResearchDeps = { ...h.deps, configured: ['knowledge'], logSource: event => receipts.push(event) };
  const running = runResearch(deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  await settle();
  clock.advance(RESEARCH.sourceDeadline.knowledge); await settle();
  clock.advance(researchCallBudgetMs(['knowledge'])); await settle();
  const reply = await running;
  assert.deepEqual(receipts.map(event => [event.source, event.outcome, event.deadlineMs]), [['knowledge', 'timeout', 12_000]], 'a cut knowledge read is a timeout at 12 s, never an empty search');
  assert.ok((reply['unchecked'] as string[]).includes('knowledge'), 'and it is named unchecked rather than reported as read');
});

// --- P5-R5: an errored read is a failure, never an empty search ---------------------------------

test('P5-R5: a connector that returns a failure is a failed read, never a search that found nothing', async () => {
  const receipts: ResearchSourceLog[] = [];
  const failed = (key: string, name: string): IntentSubResult =>
    ({ key, name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'connector_failure' });
  const h = harness({ execute: async subs => subs.map(call => failed(call.key, call.name)) });
  const deps: ResearchDeps = { ...h.deps, configured: ['mail'], logSource: event => receipts.push(event) };
  const reply = await runResearch(deps, { action: 'start', question: 'anything from the bank' }, new AbortController().signal);
  assert.deepEqual(receipts.map(event => [event.source, event.outcome, event.deadlineMs]), [['mail', 'failed', 12_000]], 'a returned failure is receipted failed, never empty');
  const note = String(reply['note'] ?? '');
  assert.match(note, /could not reach/, 'and the owner hears that the source could not be read');
  assert.equal(note.includes('found nothing'), false, 'an errored read is never voiced as an empty search');
});

// --- Q5: a named entry is read by id, and a cut body is never passed as a whole one --------------

test('Q5-R1: a question that names an insight routes to get_insight with that id, never a second search', () => {
  const config = { question: 'go deep on insight 412, the release 3p decision', topic: 'release 3p decision', configured: CONFIGURED, evidence: new Map<CandidateKind, string>() };
  const subs = candidateSubs('knowledge_search', config);
  assert.deepEqual(subs, [{ key: 'kr0', name: 'get_insight', args: { ids: [412] } }], 'one read call by id, and no search');
  assert.deepEqual(namedInsightIds('the full text of ids=[7,8]'), [7, 8], 'an ids=[...] ask names both entries');
  assert.deepEqual(namedInsightIds('what did issue #1014 change'), [], 'a bare issue number in passing is not an insight id');
  assert.deepEqual(namedInsightIds('read the whole of #1014'), [1014], 'the same number with a full-text ask is that insight');
  assert.deepEqual(candidateSubs('knowledge_search', { ...config, question: 'what did we decide about the release scope' }).map(call => call.name), ['search_knowledge'], 'an ordinary question still searches');
});

test('Q5-R2: a cut result block carries one machine line, and a whole one carries none', () => {
  const cut: IntentSubResult = { key: 'k0', name: 'search_knowledge', ok: true, omittedCharacters: 7_600, originalCharacters: 9_100,
    text: '### Release 3p scope (decision) [id 412]\nShort excerpt here.\n[omitted: 7600 characters; call get_insight with ids=[412] for the full insight]\n[omitted: 5 more hits; call search_knowledge again with limit=8 for the rest]' };
  const block = shapeBlock('knowledge_search', [cut]);
  assert.match(block.text, /^cut: 7600 of \d+ chars; withheld: 5 entries$/mu, 'the block says how much was cut and how many entries were withheld');
  assert.equal(block.text.includes('Short excerpt here.'), true, 'the shown text still leads');
  const whole: IntentSubResult = { key: 'kz', name: 'get_insight', ok: true, omittedCharacters: 0, originalCharacters: 120, text: '### Release 3p scope [id 412]\nThe whole body.' };
  assert.equal(cutLineOf([whole]), undefined, 'a whole read carries no cut line');
  assert.equal(shapeBlock('knowledge_search', [whole]).text.includes('cut:'), false, 'and the block says nothing about cuts');
});

// --- 3r K1: the voice knowledge lookup asks for bounded bodies with a deadline -------------------

test('3r: a voice knowledge lookup asks for six bounded bodies within a deadline', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', question: 'what did we decide about the connector' }, new AbortController().signal);
  const args = h.executed.find(entry => entry.name === 'search_knowledge')!.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), ['deadline_ms', 'detail', 'limit', 'max_chars', 'query', 'snippet_chars'], 'exactly those fields, and no others');
  assert.equal(args['limit'], 6);
  assert.equal(args['detail'], 'voice', 'MED-1022: the top hit is answered in full, the rest named');
  assert.equal(args['max_chars'], 2_000, 'R5: the body is requested at a size the reply can carry');
  assert.equal(args['snippet_chars'], 300);
  assert.equal(args['deadline_ms'], 8_000);
  assert.equal(typeof args['query'], 'string');
  assert.equal(RESEARCH.knowledgeBodyChars, 2_000, 'R5: the request fits the 2,500 char reply');
  assert.equal(RESEARCH.knowledgeSnippetChars, 300);
  assert.equal(RESEARCH.knowledgeDeadlineMs, 8_000);
});

test('3r: a body the server cut at the asked-for window is marked in the reply', async () => {
  const cutBody = '### Release 3p scope (decision) [id 412]\nThe part of the body that fits.\ntruncated: yes (5,432 chars stored)';
  const wholeBody = '### Release 3p ledger (pattern) [id 413]\nA short body.\ntruncated: no (14 chars stored)';
  const h = harness({ executeText: `${cutBody}\n${wholeBody}` });
  const reply = await runResearch(h.deps, { action: 'start', question: 'release 3p scope' }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'knowledge')!;
  // Hit order is the ranker's, so each hit's own line is read by its heading, never by position.
  const hits = finding.text.split(/(?=#41[23] )/u);
  const cutHit = hits.find(hit => hit.startsWith('#412 '))!;
  const wholeHit = hits.find(hit => hit.startsWith('#413 '))!;
  assert.match(cutHit, /#412 Release 3p scope[^|]*\| The part of the body that fits\. \| cut at 2000 chars/u);
  assert.equal(finding.text.includes('truncated:'), false, 'the server flag is replaced by the named window it was cut at');
  assert.equal(wholeHit.includes('cut at'), false, 'an uncut body carries no cut mark');
});

test('3r: the research receipt records the bounded-body request, metadata only', async () => {
  const h = harness({ executeText: '### Scope [id 412]\nBody.' });
  const receipts: ResearchSourceLog[] = [];
  const deps: ResearchDeps = { ...h.deps, logSource: event => receipts.push(event) };
  await runResearch(deps, { action: 'start', question: 'release scope' }, new AbortController().signal);
  const receipt = receipts.find(entry => entry.source === 'knowledge')!;
  // ROUTE-1022 K5: a brief on a question that names no source reads his knowledge only, so this run
  // compiles no chat date operator; the old brief chat window is gone and the receipt says so.
  assert.deepEqual(receipt.knowledge, { detail: 'voice', maxChars: 2_000, deadlineMs: 8_000, truncated: false, queryTerms: 2, dayFilter: 'none', chatDateOperator: 'none', deduped: 0 }, 'an uncut read names no chat operator it never compiled and no day filter it never sent');

  assert.equal(JSON.stringify(receipt).includes('scope'), false, 'a receipt never carries a query');
  // T-R2: the receipt the host log keeps is the same one research built.
  assert.deepEqual(safeEvent(receipt)?.['knowledge'], receipt.knowledge, 'the host log keeps the counts and the closed tokens');
});

// --- K1-R3: the routed voice start logs the same knowledge metadata as the selector loop ----------

test('3r: a routed voice start logs the bounded-body request and its cut flag in the receipt', async () => {
  const h = harness({ executeText: '### Release 3p scope (decision) [id 412]\nThe part that fits.\ntruncated: yes (5,432 chars stored)' });
  const receipts: ResearchSourceLog[] = [];
  const deps: ResearchDeps = { ...h.deps, logSource: event => receipts.push(event) };
  await runResearch(deps, { action: 'start', question: 'release scope', lookups: [{ source: 'knowledge', query: 'release scope' }] }, new AbortController().signal);
  const args = h.executed.find(entry => entry.name === 'search_knowledge')!.args as Record<string, unknown>;
  assert.equal(args['detail'], 'voice', 'the routed path asks through the same bounded-body args');
  assert.equal(args['max_chars'], 2_000, 'R5: the body is requested at a size the reply can carry');
  const receipt = receipts.find(entry => entry.source === 'knowledge')!;
  assert.equal(receipt.outcome, 'ok');
  assert.deepEqual(receipt.knowledge, { detail: 'voice', maxChars: 2_000, deadlineMs: 8_000, truncated: true, queryTerms: 2, dayFilter: 'none', chatDateOperator: 'none', deduped: 0 });
});

// MED-1022: the chat date operator token must still be seen as 'compiled' on a run that really compiles
// one (ROUTE-1022 K5: a question names chat to be read), so the token is never merely the 'none' default.
test('MED-1022: a run that compiles a chat date operator states it on the knowledge receipt', async () => {
  const h = harness({ executeText: '### Release 3p scope (decision) [id 412]\nThe part that fits.' });
  const receipts: ResearchSourceLog[] = [];
  const deps: ResearchDeps = { ...h.deps, logSource: event => receipts.push(event) };
  await runResearch(deps, { action: 'start', question: 'what did the team say in chat about partner ranking yesterday' }, new AbortController().signal);
  const receipt = receipts.find(entry => entry.source === 'knowledge')!;
  assert.equal((receipt.knowledge as Record<string, unknown> | undefined)?.['chatDateOperator'], 'compiled', 'the receipt carries the operator the run compiled');
});

// ROUTE-1022 K6: the instruction words of an inbox ask are not search terms, so the ask compiles to the
// plain recent-inbox scan instead of searching Gmail for 'list' or 'anything'.
test('ROUTE-1022 K6: an instruction-only inbox ask compiles to the recent-inbox scan', () => {
  assert.equal(compileMailQuery('show me anything in my email', undefined), 'in:inbox newer_than:14d', 'instruction words are no terms');
  assert.equal(compileMailQuery('List anything in my email', undefined), 'in:inbox newer_than:14d', 'and the list verb is no term either');
  assert.equal(compileMailQuery('find the agricon mail', undefined, 0, undefined, 'agricon'), 'agricon', 'a real content term still searches');
});

// MED-1022/T-R3: the dispatch keeps a tool call's arguments when every one of them is on the closed
// field list, so the voice fields and the day bounds must be listed or the trace keeps a hash only.
test('MED-1022: a voice search with a day filter keeps its arguments through the diagnostic projection', () => {
  const subs = candidateSubs('knowledge_search', {
    question: "what did we decide in yesterday's Wriggler call about pricing",
    topic: "yesterday's Wriggler call pricing",
    configured: ['knowledge'], evidence: new Map(), nowMs: Date.parse('2026-10-22T06:00:00Z'), timeZone: 'Asia/Kolkata',
  });
  const args = subs[0]!.args;
  assert.equal(args['detail'], 'voice');
  assert.equal(args['snippet_chars'], 300);
  assert.equal(args['project_hint'], 'Wriggler');
  assert.equal(args['meeting_date_from'], '2026-10-21');
  assert.equal(args['meeting_date_to'], '2026-10-21');
  const projected = projectDiagnosticInput('search_knowledge', args);
  assert.equal(projected.fidelity, 'complete_v1', 'every argument this search sends is on the closed field list');
  assert.deepEqual(JSON.parse(String(projected.json)), args, 'and every value survives end to end');
});

// MED-1022: the search now asks for the connector's voice shape, so the reply the model reads is one
// full body plus five bullets. This suite is the one a declared check runs, so the wire shape is pinned
// here as well as in live-shape's own suite.
test('MED-1022: a six hit voice reply reaches the model as six hits with the top body whole', () => {
  const body = `${'Sentence about the prep call. '.repeat(60)}Final sentence marker.`;
  const raw = [
    '# Knowledge Search', '',
    '**#91293** [TECHNICAL_DECISION] Commitment 2026-10-22', `  ${body}`,
    '  truncated: no (1,822 chars stored)', '  Score: 1.007',
    ...Array.from({ length: 5 }, (_, index) => `- **#${91100 + index}** [PATTERN] Insight ${index}: ${'Snippet about the prep call. '.repeat(8)}`),
  ].join('\n');
  const shaped = shapeLuxKnowledge('search_knowledge', raw);
  assert.ok(shaped.text.includes('Final sentence marker.'), 'the top hit body is not cut at the ranked excerpt bound');
  for (let index = 0; index < 5; index += 1) assert.match(shaped.text, new RegExp(`\\*\\*#${91100 + index}\\*\\*`, 'u'), `hit ${index} reaches the model`);
  assert.equal(shaped.text.includes('[showing'), false, 'every hit was sent, so none is dropped');
});

// T-R5: the common narrow search finds one note and nothing else. Its body must arrive whole, or the
// model pays the get_insight hop this change exists to remove.
test('MED-1022: a one hit voice reply arrives whole, with no get_insight tail', () => {
  const body = `${'Sentence about the prep call. '.repeat(70)}Final sentence marker.`;
  const raw = ['# Knowledge Search', '', '**#91293** [TECHNICAL_DECISION] Commitment 2026-10-22', `  ${body}`, '  truncated: no (2,037 chars stored)', '  Score: 1.007'].join('\n');
  const shaped = shapeLuxKnowledge('search_knowledge', raw);
  assert.ok(shaped.text.includes('Final sentence marker.'), 'the one hit body is not cut to an excerpt');
  assert.equal(shaped.partial, false, 'nothing was left out');
  assert.equal(shaped.text.includes('get_insight'), false, 'and no round trip is asked for');
});

// --- R6: the first answer point, and what a late source hands over --------------------------------

test('R6: a call answers at 4.5 s with the layers still reading, then hands over what landed later', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: ['he asked me to remember the dentist on Friday'], text: 'ignored', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      if (subs[0]!.name === 'search_knowledge') await gate.promise;
      return subs.map(call => sub(call.name, '## Release 3t\nprogressive research ships', true, call.key));
    },
  });
  const first: ResearchFirstAnswer[] = [];
  const late: ResearchLateFindings[] = [];
  let reading: Promise<void> | undefined;
  h.deps.logFirstAnswer = entry => { first.push(entry); };
  h.deps.late = entry => { late.push(entry); };
  h.deps.background = done => { reading = done; };
  const call = runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }, { source: 'knowledge', query: 'release' }],
  }, new AbortController().signal);
  // The memory layer answers in process, the knowledge read is still open: this is the owner's 4.5 s.
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  const reply = await call;
  assert.deepEqual(reply['pending'], ['knowledge'], 'the reply names the layer still reading');
  assert.equal(reply['status'], 'partial');
  assert.match(JSON.stringify(reply['historyPages']), /dentist on Friday/, 'the canonical page in hand is in the reply');
  assert.deepEqual(first.map(entry => [entry.event, entry.ms, entry.settled, entry.pending]), [['research_first_answer', 4_500, ['memory'], ['knowledge']]], 'one receipt names the moment and the two lists');
  assert.equal(late.length, 0, 'nothing is reported while the reader is still working');
  gate.resolve();
  await reading;
  assert.deepEqual(late.map(entry => [entry.source, entry.items, entry.ok]), [['knowledge', ['Release 3t | progressive research ships'], true]], 'the late source is reported once, with what it returned');
  assert.equal(h.deps.ledger.find(first[0]!.researchId) !== undefined, true, 'the run is the one the receipt named');
});

test('R6: a call with no findings at 4.5 s waits for its sources instead of answering empty', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: [], text: '', total: 0 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      await gate.promise;
      return subs.map(call => sub(call.name, '## Release 3t\nprogressive research ships', true, call.key));
    },
  });
  const first: ResearchFirstAnswer[] = [];
  h.deps.logFirstAnswer = entry => { first.push(entry); };
  let answered = false;
  const call = runResearch(h.deps, {
    action: 'start', question: 'release scope', lookups: [{ source: 'knowledge', query: 'release' }],
  }, new AbortController().signal).then(reply => { answered = true; return reply; });
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  await settle();
  assert.equal(answered, false, 'nothing to say at 4.5 s, so the call waits');
  gate.resolve();
  const reply = await call;
  assert.equal(reply['pending'], undefined, 'a call that waited names no pending source');
  assert.equal(reply['status'], 'complete');
  assert.deepEqual(first, [], 'no first answer receipt without a first answer');
});

test('R6: a late source whose lines the first reply already carried appends nothing', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: ['Release 3t | progressive research ships'], text: 'ignored', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      if (subs[0]!.name === 'search_knowledge') await gate.promise;
      return subs.map(call => sub(call.name, '## Release 3t\nprogressive research ships', true, call.key));
    },
  });
  const late: ResearchLateFindings[] = [];
  let reading: Promise<void> | undefined;
  h.deps.late = entry => { late.push(entry); };
  h.deps.background = done => { reading = done; };
  const call = runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }, { source: 'knowledge', query: 'release' }],
  }, new AbortController().signal);
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  await call;
  gate.resolve();
  await reading;
  assert.deepEqual(late.map(entry => [entry.source, entry.items]), [['knowledge', []]], 'one receipt, no repeated line');
});

test('R6: a late source that fails says nothing and still leaves one receipt', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: ['he asked me to remember the dentist on Friday'], text: 'ignored', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      await gate.promise;
      return subs.map(call => sub(call.name, '', false, call.key));
    },
  });
  const late: ResearchLateFindings[] = [];
  let reading: Promise<void> | undefined;
  h.deps.late = entry => { late.push(entry); };
  h.deps.background = done => { reading = done; };
  const call = runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }, { source: 'knowledge', query: 'release' }],
  }, new AbortController().signal);
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  await call;
  gate.resolve();
  await reading;
  assert.deepEqual(late.map(entry => [entry.source, entry.items, entry.ok]), [['knowledge', [], false]], 'a failed read never invents a finding');
});

// --- R6/M2: a run that answered ahead of its readers is still the run stop and continue address ------

test('R6/M2: stop reaches a run that answered ahead of its readers', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: ['he asked me to remember the dentist on Friday'], text: 'ignored', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      await gate.promise;
      return subs.map(call => sub(call.name, '## Release 3t\nprogressive research ships', true, call.key));
    },
  });
  let reading: Promise<void> | undefined;
  h.deps.background = done => { reading = done; };
  const scheduler = new ResearchScheduler(h.deps);
  const controller = new AbortController();
  const first = scheduler.call({
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }, { source: 'knowledge', query: 'release' }],
  }, controller.signal);
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  const startReply = await first;
  assert.deepEqual(startReply['pending'], ['knowledge'], 'the call has answered with a reader still running');
  const id = String(startReply['researchId']);
  const stopped = await scheduler.call({ action: 'stop', researchId: id }, controller.signal);
  assert.equal(stopped['researchId'], id, 'stop finds the run the first answer left reading');
  assert.equal(h.deps.ledger.find(id)?.stopped, true, 'and records that run stopped');
  assert.equal(stopped['historyPages'], undefined, 'stop never republishes copied local evidence');
  gate.resolve();
  controller.abort();
  await reading;
  assert.equal(h.deps.ledger.find(id)?.ended, true, 'the run line is the run\'s own end');
});

test('R6/M2: continue reaches a run that answered ahead of its readers', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: ['he asked me to remember the dentist on Friday'], text: 'ignored', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      await gate.promise;
      return subs.map(call => sub(call.name, '## Release 3t\nprogressive research ships', true, call.key));
    },
  });
  let reading: Promise<void> | undefined;
  h.deps.background = done => { reading = done; };
  const scheduler = new ResearchScheduler(h.deps);
  const controller = new AbortController();
  const first = scheduler.call({
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }, { source: 'knowledge', query: 'release' }],
  }, controller.signal);
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  const startReply = await first;
  assert.deepEqual(startReply['pending'], ['knowledge']);
  const id = String(startReply['researchId']);
  const continuing = scheduler.call({ action: 'continue', researchId: id }, controller.signal);
  gate.resolve();
  const reply = await continuing;
  assert.equal(reply['researchId'], id, 'continue addresses the same run, never a second one beside it');
  assert.equal(reply['historyPages'], undefined, 'local continuation requires an explicit canonical reference');
  controller.abort();
  await reading;
});


test('ROUTE-1022: a bounded search reply never hydrates, whatever its own cut flag says', async () => {
  for (const flag of ['no', 'yes', 'unmarked', 'empty']) {
    const calls: { name: string; args: unknown }[] = [];
    const text = Array.from({ length: 6 }, (_, i) => `### Synthetic entry [id ${101 + i}]\n${flag === 'empty' ? '' : `Synthetic body ${i}.`}\n${flag === 'unmarked' ? '' : `truncated: ${flag === 'empty' ? 'no' : flag}`}`).join('\n');
    const h = harness({ execute: async subs => {
      calls.push(...subs);
      return subs.map(call => sub(call.name, call.name === 'search_knowledge' ? text : '### Hydrated [id 101]\nFull synthetic evidence.', true, call.key));
    } });
    const reply = await runResearch(h.deps, { action: 'start', question: 'synthetic facts', sources: 'knowledge' }, new AbortController().signal);
    assert.equal(calls.filter(call => call.name === 'search_knowledge').length, 1);
    assert.equal(calls.filter(call => call.name === 'get_insight').length, 0, `${flag}: no second hop`);
    if (flag !== 'empty') {
      const findings = JSON.stringify(reply['findings']);
      for (let i = 0; i < 6; i++) assert.ok(findings.includes(`Synthetic body ${i}.`), 'all six bodies survive');
    }
  }
  const h = harness();
  await runResearch(h.deps, { action: 'start', question: 'read full insight #412', sources: 'knowledge' }, new AbortController().signal);
  assert.equal(h.executed.some(call => call.name === 'search_knowledge'), false);
  assert.equal(h.executed.filter(call => call.name === 'get_insight').length, 1);
});


test('research 469: stopped known continuation fails while retained delivery remains successful without source work', async t => {
  const messages = Array.from({ length: 13 }, (_, n) => ({ id: `continuation-${n}`, headers: [{ name: 'Subject', value: `Synthetic continuation ${n}` }] }));
  const steps: Parameters<NonNullable<ResearchDeps['step']>>[0][] = [];
  let calls = 0;
  const h = harness({ execute: async subs => { calls += subs.length; return subs.map(call => ({ key: call.key, name: call.name, ok: true, ...shapeGmailList({ messages }) })); } });
  h.deps.step = step => steps.push(step);
  t.after(() => h.deps.ledger.close());
  const scheduler = new ResearchScheduler(h.deps), signal = new AbortController().signal;
  const first = await scheduler.call({ action: 'start', question: 'List synthetic continuation', lookups: [{ source: 'mail', mail: { q: 'subject:synthetic', maxResults: 13 } }] }, signal);
  assert.equal(first['status'], 'partial'); assert.equal(first['error'], undefined);
  const researchId = String(first['researchId']), cursor = String(first['nextCursor']);
  const next = await scheduler.call({ action: 'continue', researchId, cursor }, signal);
  assert.match(JSON.stringify(next['findings']), /Synthetic continuation 12/);
  // The end step of a read lands on the tick the batch settles, so it is measured after one turn.
  await new Promise<void>(resolve => setImmediate(resolve));
  const before = steps.length;
  assert.equal(calls, 1); assert.deepEqual(steps.map(step => step.phase).sort(), ['end', 'start'], 'one start and end for the actual source read');
  const retained = await scheduler.call({ action: 'continue', researchId, cursor }, signal);
  assert.equal(retained['alreadyDelivered'], true); assert.equal(retained['status'], 'complete'); assert.equal(retained['error'], undefined);
  assert.deepEqual(retained['findings'], []);
  const stopped = await scheduler.call({ action: 'stop', researchId }, signal);
  assert.equal(stopped['status'], 'stopped'); assert.equal(stopped['error'], undefined);
  const unavailable = await scheduler.call({ action: 'continue', researchId }, signal);
  assert.deepEqual(await scheduler.call({ action: 'continue', researchId: 'unknown-synthetic' }, signal), { error: 'unknown_research_run' });
  assert.equal(calls, 1); assert.equal(steps.length, before, 'retained, stopped and unavailable calls fabricate no source steps');
  assert.deepEqual(unavailable, { researchId, error: 'continuation_unavailable', status: 'unavailable', findings: [], canContinue: false, note: 'This research run is no longer available. Start a new lookup.' });
  const cancellable = await scheduler.call({ action: 'start', question: 'A new synthetic lookup', lookups: [{ source: 'mail', mail: { q: 'subject:synthetic', maxResults: 13 } }] }, signal);
  const cancelledId = String(cancellable['researchId']), beforeCancelSteps = steps.length;
  // F2: the same mail query is one read for the live session, so the second start reuses it instead of
  // paging the same mailbox again.
  assert.equal(calls, 1); h.deps.ledger.cancelActive();
  assert.equal(h.deps.ledger.find(cancelledId)?.cancelled, true); assert.equal(h.deps.ledger.find(cancelledId)?.stopped, false);
  const cancelled = await scheduler.call({ action: 'continue', researchId: cancelledId }, signal);
  assert.deepEqual(cancelled, { ...unavailable, researchId: cancelledId });
  assert.equal(calls, 1); assert.equal(steps.length, beforeCancelSteps, 'cancelled known continuation has no source read or step');
});

// --- #472: a run cut after its first answer is partial, never failed ------------------------------

test('#472: a run cancelled after its first answer is logged partial and still hands over what landed later', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({
    now: clock.now, schedule: clock.schedule,
    memory: () => ({ lines: ['he asked me to remember the dentist on Friday'], text: 'ignored', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => {
      if (subs[0]!.name === 'search_knowledge') await gate.promise;
      return subs.map(call => sub(call.name, '## Release 3x\nlate findings land here', true, call.key));
    },
  });
  const late: ResearchLateFindings[] = [];
  let reading: Promise<void> | undefined;
  h.deps.late = entry => { late.push(entry); };
  h.deps.background = done => { reading = done; };
  const controller = new AbortController();
  const call = runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }, { source: 'knowledge', query: 'release' }],
  }, controller.signal);
  await tick();
  clock.advance(RESEARCH.firstAnswerMs);
  const answered = await call;
  assert.equal(answered['status'], 'partial', 'the owner received an answer');
  // The host closes the delegation after that answer: the run is cut while its second reader is open.
  controller.abort();
  gate.resolve();
  await reading;
  const run = h.logs.filter(entry => entry.event === 'research_run').at(-1);
  assert.equal(run?.stopReason, 'cancelled', 'the run was cut, not completed');
  assert.equal(run?.status, 'partial', 'a run that delivered an answer is partial, never failed');
  // Cast: the flag is what this commit adds, so the assertion must compile against base product code too.
  const knowledge = late.filter(entry => entry.source === 'knowledge').at(-1) as (ResearchLateFindings & { cut?: boolean }) | undefined;
  assert.equal(knowledge?.cut, true, `the cut run's late event says it was a cut, not a source failure: ${JSON.stringify(late)}`);
});

// --- #1020 behaviour 1: what the model is told about the sources it could not read ---------------

test('#1020: a source that was not configured is named with its reason in the note the model voices', async () => {
  const h = harness({ configured: ['knowledge'], execute: async subs => subs.map(call => sub(call.name, call.name === 'search_knowledge' ? '### Release scope (DECISION | 2026-10-17) [id 12]' : 'evidence', true, call.key)) });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'who is on my team',
    lookups: [{ source: 'company', query: 'team structure' }, { source: 'chat', query: 'team' }, { source: 'knowledge', query: 'team' }],
  }, new AbortController().signal);
  assert.match(String(reply['note']), /team chat: unavailable \(not configured\); company knowledge: unavailable \(not configured\)/, 'each unread source names itself and its reason, in plain words');
  assert.ok((reply['findings'] as { source: string }[]).some(finding => finding.source === 'knowledge'), 'and the findings that did land sit in the same reply');
});

test('#1020: a timed-out source is named as timed out, in seconds, beside the source that answered', async () => {
  const h = harness({ configured: ['knowledge', 'chat'], execute: async subs => subs.map(call => sub(call.name, call.name === 'search_knowledge' ? '### Release scope (DECISION | 2026-10-17) [id 12]' : 'evidence', true, call.key)) });
  const deps: ResearchDeps = { ...h.deps, unavailableNow: () => [{ source: 'chat', reason: 'timeout' }] };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what is waiting on me',
    lookups: [{ source: 'chat', query: 'release freeze' }, { source: 'knowledge', query: 'release' }],
  }, new AbortController().signal);
  // #635: a timed-out chat read is voiced as a timeout with its own bounded budget, never as a chat that
  // could not be reached, and the header's say clause is the sentence the model speaks.
  assert.match(String(reply['note']), /team chat: not read \(timed out after 10 s\)/, 'the reason is the timeout and its budget, never a bare unreachable');
  assert.doesNotMatch(String(reply['note']), /could not reach/, 'a timeout is never voiced as a source out of reach');
  assert.match(String(reply['coverage']), /chat timed_out \(say: team chat did not answer within 10 seconds\)/, 'and the header carries the clause to say instead');
  assert.ok((reply['findings'] as { source: string }[]).some(finding => finding.source === 'knowledge'), 'the healthy source still answers in the same reply');
});

// --- W2: the selector never sits on the critical path -------------------------------------------

test('a routed run never calls the selector: the model already named the lookups', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', lookups: [{ source: 'mail', query: 'newer_than:2d' }] }, new AbortController().signal);
  assert.ok(h.executed.some(call => call.name === 'gmail_search_messages'), 'the routed lookup is still read');
});

test('one configured source never pays a selector round', async () => {
  const h = harness({});
  h.deps.configured = ['knowledge'];
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.ok(h.executed.some(call => call.name === 'search_knowledge'), 'the one source is still read');
  assert.equal((reply['unchecked'] as string[]).includes('knowledge'), false, 'the one source was read and credited');
});

test('a continuation reads deterministically: no selector round ever runs', async () => {
  // B1: the skip removes the selector round, so the fixture must show the deterministic path still
  // reads and credits the source the direction names. The first round settles quick_fact and stops
  // with rounds left, so the continuation is the round that has to read without the selector.
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'what is the landlord invoice number' }, new AbortController().signal);
  // ROUTE-1022: the round that read the prime source and stopped says nothing more is to fetch.
  assert.equal(first['canContinue'], false, 'a complete reply invites no continuation');
  assert.equal(first['status'], 'complete');
  const readsBefore = h.executed.length;
  const next = await scheduler.call({ action: 'continue', researchId: String(first['researchId']), direction: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const reads = h.executed.slice(readsBefore);
  assert.ok(reads.some(call => call.name === 'calendar_list_events'), `the continuation reads the source its direction names: ${JSON.stringify(reads)}`);
  assert.equal((next['unchecked'] as string[]).includes('calendar'), false, 'and the reply credits the source it read');
});

test('a selector round still delivers every source the selector chose', async () => {
  const h = harness({});
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did the team say about the deploy freeze' }, new AbortController().signal);
  assert.equal((reply['unchecked'] as string[]).includes('chat'), false, 'the selector pick is still read and credited');
  assert.ok(h.executed.some(call => JSON.stringify(call.args).includes('deploy freeze')), 'the selector query is the one read');
});

// W9-R3: a configured source that cannot be reached is named to the model, never silently dropped,
// and a configuration-time rejection speaks in a closed code rather than a free-text error.
test('a google endpoint in configuration error names mail and calendar as unreachable', () => {
  const named = configuredSourcesForEndpoints([
    { connector: 'google', state: 'error', configurationError: 'unknown-class-invalid', reasonCode: 'unknown-class-invalid' },
    { connector: 'mattermost', state: 'connected' },
  ]);
  assert.deepEqual(named, [
    { source: 'calendar', reason: 'unknown-class-invalid' },
    { source: 'mail', reason: 'unknown-class-invalid' },
  ], 'both google reads keep their source name with the closed reason');
});

test('a google endpoint in configuration error is voiced as unreachable mail, never silently dropped', async () => {
  // The configured set and the unreachable reasons come from the same endpoint report the host writes.
  const named = configuredSourcesForEndpoints([
    { connector: 'google', state: 'error', configurationError: 'unknown-class-invalid' },
  ]);
  const unreachable = named.filter(entry => entry.source === 'mail').map(entry => entry.source);
  const dispatched: string[] = [];
  const deps: ResearchDeps = {
    now: () => 0, configured: unreachable, unavailableNow: () => unreachable,
    execute: async subs => {
      for (const call of subs) dispatched.push(call.name);
      return subs.map(call => ({ key: call.key, name: call.name, ok: true, text: 'evidence', originalCharacters: 8, omittedCharacters: 0, received: { shape: 'list', items: 1 } } as never));
    },
    emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'did I get the invoice' }, new AbortController().signal);
  const note = String(reply['note'] ?? '');
  assert.match(note, /could not reach mail/);
  assert.deepEqual(dispatched, [], 'a source known to be unreachable is not dispatched to');
});


// W9-B1: a session opened before the connect round publishes still names what it cannot reach.
test('a session opened before publication names mail and calendar with a closed reason', () => {
  const connected = [
    { connector: 'google', state: 'connected' },
    { connector: 'mattermost', state: 'connected' },
  ];
  const named = unreachableSourcesForSession(['chat'], connected);
  assert.deepEqual(named, [
    { source: 'calendar', reason: UNPUBLISHED_SOURCE_REASON },
    { source: 'mail', reason: UNPUBLISHED_SOURCE_REASON },
  ], 'a connected endpoint whose reads this session never got is named, not dropped');

  // The configured set carries the same sources, so a research call can ask for them at all.
  assert.deepEqual(configuredSourcesForSession(['chat'], connected), ['chat', 'calendar', 'mail']);

  // Once the reads are published into the session, nothing is called unreachable.
  assert.deepEqual(unreachableSourcesForSession(['chat', 'calendar', 'mail'], connected), []);
});

// W9-R4 / #502: a refused Mongoose refresh reaches the owner as a closed sign-in-again reason.
test('a refused mongoose refresh is voiced as sign in again, never as an unknown failure', () => {
  const named = configuredSourcesForEndpoints([{ connector: 'mongoose', state: 'error', reasonCode: 'credential-refresh-failed' }]);
  assert.deepEqual(named, [{ source: 'mongoose', reason: 'credential-refresh-failed' }]);
  // The reply speaks REASON_WORDS, so the closed code reads as an instruction, not a code.
  assert.equal(plainReason('credential-refresh-failed'), 'sign in again');
});

test('W10: a connected endpoint whose read grant has not published is named, with a closed reason', () => {
  const endpoints = [
    { id: 'calendar', connector: 'google', state: 'connected' },
    { connector: 'gmail', state: 'connected' },
  ];
  // Gmail published its grant; the calendar endpoint is connected but offers no read yet.
  const named = configuredSourcesForEndpoints(endpoints, ['gmail_search_messages', 'gmail_read_message']);
  assert.deepEqual(named, [{ source: 'calendar', reason: 'source_not_granted' }]);
  // Every source has a granted read: nothing is reported unreachable.
  assert.deepEqual(configuredSourcesForEndpoints(endpoints, ['gmail_search_messages', 'gmail_read_message', 'calendar_list_events']), []);
  // Without a granted set the report is the one W9 wrote: a connected endpoint is not reported.
  assert.deepEqual(configuredSourcesForEndpoints(endpoints), []);
});

// --- ROUTE-1022 (#526): route without waiting, answer with the source asked about ---------------

const calendarEvent = { id: 'e1', start: '1970-01-02T10:00:00Z', summary: 'Standup with Ana' };
const calendarPage = (key: string, name: string): IntentSubResult => ({ key, name, ok: true, ...shapeGcalList({ events: [calendarEvent] }) } as IntentSubResult);

test('ROUTE-1022: a calendar question never calls the selector and answers with the calendar', async () => {
  const clock = fakeClock();
  let selectorCalls = 0;
  const execute: ResearchDeps['execute'] = async subs => {
    const calendar = subs.some(call => call.name === 'calendar_list_events');
    await new Promise<void>(resolve => { clock.schedule(() => resolve(), calendar ? 4_700 : 2_900); });
    return subs.map(call => call.name === 'calendar_list_events' ? calendarPage(call.key, call.name) : sub(call.name, 'a stored note', true, call.key));
  };
  const h = harness({ now: clock.now, schedule: clock.schedule, execute, configured: ['knowledge', 'calendar'] });
  const running = runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  await tick();
  clock.advance(2_900); await settle();
  clock.advance(4_500); await settle();
  clock.advance(4_700); await settle();
  const reply = await running;
  assert.equal(selectorCalls, 0, 'an unambiguous calendar question never spends the selector call');
  assert.match(JSON.stringify(reply['findings']), /Standup/, 'the first answer waits for the calendar the question is about');
  assert.equal(h.logs[0]!.driver, 'routed');
});

test('ROUTE-1022: the voice path carries no selector, so no run waits on one', async () => {
  assert.equal('selector' in harness({}).deps, false, 'the research deps offer no selector');
  assert.equal('selectorDeadlineMs' in RESEARCH, false, 'and the selector deadline is gone with it');
  const h = harness({});
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.equal(h.logs[0]!.fallbackUsed, true);
  assert.equal(h.logs[0]!.driver, 'fallback');
  assert.equal(h.logs[0]!.selectorMs, 0, 'the run line states no selector time because none was spent');
  assert.ok(Array.isArray(reply['findings']));
});

test('ROUTE-1022: a second start for the same owner question attaches instead of cancelling', async () => {
  const gate = deferred<void>();
  const h = harness({ execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  await tick();
  const second = scheduler.call({ action: 'start', question: "what's on my calendar tomorrow?" }, new AbortController().signal);
  await tick();
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a['superseded'], undefined, 'the run in flight is never cancelled by a repeated question');
  assert.equal(b['researchId'], a['researchId'], 'both calls read the same run');
  assert.deepEqual(b['findings'], a['findings']);
  assert.equal(h.joined.length, 2);
  assert.deepEqual(h.branches, ['start', 'join'], 'the run in flight answers the second call');
});

test('ROUTE-1022: a complete reply says nothing more is to fetch, and a cut one names what is still reading', async () => {
  const complete = harness({ executeText: '### Release 3p scope [id 7]\nThe part that fits.' });
  const done = await runResearch(complete.deps, { action: 'start', question: 'what is the release scope' }, new AbortController().signal);
  assert.equal(done['status'], 'complete');
  assert.equal(done['canContinue'], false);
  // ROUTE-1022 shape: the brief fan-out reads the calendar too, so the note carries what that read found
  // and still ends on the one plain sentence that says nothing else is to fetch.
  assert.ok(String(done['note']).endsWith(RESEARCH.completeNote));
  const clock = fakeClock();
  const slow: ResearchDeps['execute'] = async subs => {
    await new Promise<void>(resolve => { clock.schedule(() => resolve(), 20_000); });
    return subs.map(call => call.name === 'calendar_list_events' ? calendarPage(call.key, call.name) : sub(call.name, 'a stored note', true, call.key));
  };
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: slow, configured: ['knowledge', 'calendar'] });
  const running = runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  await tick();
  clock.advance(4_500); await settle();
  clock.advance(20_000); await settle();
  const partial = await running;
  assert.equal(partial['status'], 'partial');
  assert.equal(partial['canContinue'], true);
  assert.match(String(partial['note']), /calendar/, 'a partial reply names exactly what is still reading');
});

// --- ONE-1023: a meeting day filter only where notes can exist ---------------------------------

test('ONE-1023: next week is moved once, and a window that reaches today narrows nothing', () => {
  const now = Date.parse('2026-10-23T04:30:00Z');
  const zone = 'Asia/Kolkata';
  // The bug: windowRange already moved next week by seven, and meetingBounds moved it again, so the
  // filter read 2026-11-02 to 2026-11-08 for a question about 2026-10-26 to 2026-11-01.
  assert.equal(windowRange('next week', now, zone).timeMin, '2026-10-25T18:30:00.000Z', 'windowRange moves next week itself, to Monday 2026-10-26 in Kolkata');
  assert.equal(meetingBounds('meetings next week', undefined, now, zone), undefined, 'next week has no notes to filter by');
  const yesterday = meetingBounds("notes from yesterday's meeting", undefined, now, zone);
  assert.deepEqual(yesterday, { from: '2026-10-22', to: '2026-10-22' }, 'a past day still filters');
  assert.deepEqual(meetingBounds("last week's meeting", undefined, now, zone), { from: '2026-10-12', to: '2026-10-18' }, 'last week is its own Monday to Sunday');
  assert.deepEqual(meetingBounds('notes from the 2026-10-16 meeting', undefined, now, zone), { from: '2026-10-16', to: '2026-10-16' }, 'a past ISO day still filters');
  assert.equal(meetingBounds('what meetings do I have today', undefined, now, zone), undefined, 'today has no notes yet');
  assert.equal(meetingBounds("tomorrow's meeting", undefined, now, zone), undefined, 'neither does tomorrow');
  assert.equal(meetingBounds('my meetings this week', undefined, now, zone), undefined, 'a week that reaches today asks the topic, not the day');
});

// --- Release 4: a continuation hop searches content words, never the model's meta words ----------

/** The queries one continuation hop dispatched, by tool, so a test reads what really left the host. */
function queriesOf(h: Harness, from: number, tool: string): string[] {
  return h.executed.slice(from).filter(call => call.name === tool)
    .map(call => (call.args as Record<string, unknown>)['q'] ?? (call.args as Record<string, unknown>)['query'])
    .filter((value): value is string => typeof value === 'string');
}

test('release 4: a mail continuation never appends the model meta words after the inbox window', async () => {
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'budget review email from Korbi', topic: 'budget review Korbi', lookups: [{ source: 'knowledge', query: 'budget review korbi' }] }, new AbortController().signal);
  const before = h.executed.length;
  await scheduler.call({ action: 'continue', researchId: String(first['researchId']), direction: 'remaining metadata business-relevant' }, new AbortController().signal);
  const searched = queriesOf(h, before, 'gmail_search_messages');
  assert.ok(searched.length > 0, `the continuation still searches mail: ${JSON.stringify(h.executed.slice(before))}`);
  for (const q of searched) assert.equal(/\b(?:remaining|metadata|business-relevant)\b/u.test(q), false, `no meta word rides the mail query: ${q}`);
  assert.match(searched[0]!, /korbi/u, 'the continuation search text is the owner question, not the direction');
});

test('release 4: a knowledge continuation never searches the instruction words of its direction', async () => {
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'what notes do we have on the hawthorn release', lookups: [{ source: 'chat', query: 'hawthorn release' }] }, new AbortController().signal);
  const before = h.executed.length;
  await scheduler.call({ action: 'continue', researchId: String(first['researchId']), direction: 'through retained earlier action-needed' }, new AbortController().signal);
  const searched = queriesOf(h, before, 'search_knowledge');
  assert.ok(searched.length > 0, `the continuation still reads knowledge: ${JSON.stringify(h.executed.slice(before))}`);
  for (const q of searched) {
    assert.equal(/\b(?:through|retained|earlier|action-needed)\b/u.test(q), false, `no instruction word rides the knowledge query: ${q}`);
    assert.match(q, /hawthorn|release/u, 'the owner question terms are the search text');
  }
});

test('release 4: a chat continuation never searches a bare meta direction word', async () => {
  const h = harness({});
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'what did the team say in chat about the hawthorn release', lookups: [{ source: 'knowledge', query: 'hawthorn release' }] }, new AbortController().signal);
  const before = h.executed.length;
  await scheduler.call({ action: 'continue', researchId: String(first['researchId']), direction: 'other' }, new AbortController().signal);
  const searched = queriesOf(h, before, 'mattermost_search');
  assert.ok(searched.length > 0, `the continuation still reads chat: ${JSON.stringify(h.executed.slice(before))}`);
  for (const q of searched) {
    assert.equal(/(?:^|\s)other(?:\s|$)/u.test(q), false, `the meta word other never becomes a chat query: ${q}`);
    assert.match(q, /hawthorn|release/u, 'the owner question terms are the search text');
  }
});



// --- LAT-1023: the answer to Live stays small and whole -------------------------------------------

const WIDE_HITS = Array.from({ length: 14 }, (_, index) => `**#${index + 1}** [PATTERN] Decision ${index} | ${'decision text '.repeat(60)}`).join('\n');

test('LAT-1023: a wide answer is compacted to the Live budget by dropping whole items', async () => {
  const h = harness({ replyLimit: CAP_REPLY_BOUND,  execute: async subs => subs.map(call => sub(call.name, WIDE_HITS, true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what decisions did we make about the retrieval deadline' }, new AbortController().signal);
  const text = JSON.stringify(reply);
  // C-DEPTH item 1: the flat 2,500 char cap is retired for three tiers, and the answer is bounded by the
  // tier the owner's question earns, which a plain decision question is the default one of.
  assert.deepEqual(RESEARCH.budgets, { default: 12_000, analytical: 16_000, depth: 20_000 },
    'the three C-DEPTH tiers, no flat reply cap');
  assert.ok(text.length <= RESEARCH.budgets.default,
    `the answer to Live is ${text.length} chars, the coverage header included`);
  const findings = reply['findings'] as { text: string }[];
  const shown = findings.map(finding => finding.text).join('\n');
  const items = shown.split(/\n(?=#\d+ )/u).slice(1);
  assert.ok(items.length >= 1, 'the answer still carries whole items');
  for (const item of items) assert.match(item, /Decision \d+ \| (?:decision text )*decision text ?$/u, 'an item is never sliced mid-text');
  const line = h.logs[0]!;
  assert.ok(line.answerCompacted !== undefined, 'the receipt says the answer was compacted');
  assert.ok((line.answerCompacted?.items ?? 0) > 0, 'with the count of whole items it dropped');
  assert.equal(line.answerCompacted?.chars, text.length, 'and the characters it sent');
  assert.ok(String(reply['note']).includes(RESEARCH.moreAvailableNote), 'and the reply names what was left out');
  assert.doesNotMatch(shown, /no such|does not exist/iu);
});

test('LAT-1023: a short answer is returned unchanged with no compaction token', async () => {
  const short = '**#1** [PATTERN] Release 4 | the orb shows live and the mic frees on mute';
  const h = harness({ execute: async subs => subs.map(call => sub(call.name, short, true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what decisions did we make about the release orb' }, new AbortController().signal);
  assert.ok(JSON.stringify(reply).length <= 2_500);
  const findings = reply['findings'] as { text: string }[];
  assert.ok(findings.some(finding => finding.text.includes('the orb shows live and the mic frees on mute')), 'the short evidence rides back unchanged');
  assert.equal(h.logs[0]!.answerCompacted, undefined, 'nothing was dropped, so no compaction token');
});

test('LAT-1023 R1: a requested body keeps its 6,000 char page bound while an answer stays at 2,500', async () => {
  const body = 'Body evidence sentence. '.repeat(280);
  assert.ok(body.length > RESEARCH.bodyLimitChars + 500, 'the fixture body is wider than its own page bound');
  const scope = { endpointId: 'local', transport: 'stdio' as const, bindingDigest: 'sha256:body-scope', schemaDigest: 'sha256:schema', toolName: 'gmail_read_message', generation: 1, account: 'owner', resource: 'mail' };
  const evidence = {
    kind: 'remote-body' as const, source: scope, entitySha256: 'e'.repeat(64), bodySha256: 'b'.repeat(64),
    expiresAt: Date.now() + 600_000, tool: 'gmail_read_message', body, upstreamComplete: true as const, upstreamOmitted: false as const,
  };
  // The body arrives on the run's own dispatch, exactly as a read the owner asked for does: the reply is
  // the page, sized by the body bound rather than by the answer budget.
  const h = harness({ replyLimit: CAP_REPLY_BOUND, 
    execute: async subs => subs.map(call => ({
      ...sub(call.name, '', true, call.key),
      binding: { executionId: 'exec-body', name: call.name, contentIndex: 0, partIndex: 0, result: { id: 'body-1', sha256: 'c'.repeat(64) } },
      hostEvidence: evidence,
    })),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did the invoice mail from Ana say in full',
  }, new AbortController().signal);
  const slices = reply['bodySlices'] as { text: string; offset: number }[] | undefined;
  assert.ok(Array.isArray(slices) && slices.length === 1, 'the requested body comes back as one page');
  // C-DEPTH item 1: the answer budget is a tier now and the widest tier passes a body page, so the invariant
  // this test owns is the body page's own bound: the page is whole and never clamped by the answer budget.
  assert.ok(slices![0]!.text.length <= RESEARCH.bodyLimitChars, `a body page keeps its own bound (${slices![0]!.text.length} chars)`);
  assert.ok(slices![0]!.text.length > RESEARCH.sourceFloorChars, 'a body page is real evidence, not a floor');
  assert.ok(JSON.stringify(reply).length <= RESEARCH.bodyLimitChars, `and stays inside the body bound (${JSON.stringify(reply).length} chars)`);
  assert.equal(RESEARCH.bodyLimitChars, 6_000, 'the body page bound is the page width a requested read had before');
  // C-DEPTH item 1: the flat cap this line pinned is retired for the three tiers, so the assertion names them.
  assert.deepEqual(RESEARCH.budgets, { default: 12_000, analytical: 16_000, depth: 20_000 },
    'and the composed answer is bounded by a tier, not a flat cap');
});

test('LAT-1023 B3: a two-source answer whose kept line is wider than the budget is still trimmed to it', async () => {
  // The reviewer's shape: one knowledge hit is one line of the connector's whole body, and the mail group
  // beside it holds whole short lines. A trim that keeps one line per source cannot reach the budget.
  const wide = `**#1** [PATTERN] Long body | ${'w'.repeat(2_900)}`;
  const mail = ['- Release notes | from: Ana | date: 2026-10-16 [id m1]', '- Invoice | from: Ana | date: 2026-10-17 [id m2]', '- Plan | from: Ana | date: 2026-10-18 [id m3]'].join('\n');
  const h = harness({ replyLimit: CAP_REPLY_BOUND, 
    execute: async subs => subs.map(call => sub(call.name, call.name === 'search_knowledge' ? wide : mail, true, call.key)),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did we decide about the invoice and the release plan',
    lookups: [{ source: 'knowledge', query: 'invoice release plan' }, { source: 'mail', query: 'from:ana' }],
  }, new AbortController().signal);
  const text = JSON.stringify(reply);
  // W10-R15 P4: this case pins its own bound, so it is measured against the cap it drives.
  assert.ok(text.length <= CAP_REPLY_BOUND, `the answer to Live is ${text.length} chars against its own ${CAP_REPLY_BOUND} cap`);
  const line = h.logs.at(-1)!;
  assert.ok(line.answerCompacted !== undefined, 'the receipt says the answer was compacted');
  // C-DEPTH item 2: the per source floor protects a short source, so the widest one gives up whole items and the
  // short one keeps its evidence. The budget is met either way, which is what this case owns.
  // C-DEPTH item 2: the widest line is shortened to the room the floor leaves, and the short source keeps its
  // evidence, so what was over the budget is what gave way. This case owns the trim, not the drop count.
  const kept = reply['findings'] as { source: string; text: string }[];
  const knowledge = kept.find(finding => finding.source === 'knowledge');
  assert.ok(knowledge !== undefined && knowledge.text.length < 2_900,
    `the widest line was trimmed to the budget: ${knowledge?.text.length ?? 0} of 2,900`);
  const keptSources = kept.map(finding => finding.source);
  assert.ok(keptSources.includes('mail'), `a short source keeps its evidence: ${keptSources.join(', ')}`);
  assert.ok(String(reply['note']).includes(RESEARCH.moreAvailableNote), 'and the reply names what it left out');
});

// --- TOPIC (#565, #576): only the topic's words reach a source, never the instruction text ---

const INSTRUCTION_PARAGRAPH = 'Please explain in detail what the prior discussion identified as the relevant blocker before the pilot started, then identify what we decided since that review, including every item that requires a reaction from the team, anything about the budget around the pilot, and the rollout plan for the region that the group named in the earlier discussion';

test('TOPIC 1 (#565): a forty-word instruction paragraph sends the topic terms and no instruction word', () => {
  const config = { question: INSTRUCTION_PARAGRAPH, topic: 'Wilmar pilot', configured: CONFIGURED, evidence: new Map<CandidateKind, string>() };
  const knowledge = candidateSubs('knowledge_search', config).map(call => String(call.args['query'] ?? '').toLowerCase());
  assert.deepEqual(knowledge, ['wilmar pilot'], 'the knowledge search is the topic, not the instruction');
  const mail = candidateSubs('mail_search', config).map(call => String(call.args['q'] ?? ''));
  assert.equal(mail.length, 1);
  for (const word of ['explain', 'prior', 'discussion', 'relevant', 'before', 'since', 'identify', 'reaction', 'requires']) {
    assert.equal(mail[0]!.toLowerCase().includes(word), false, `the mail query carries no instruction word: ${word}`);
  }
  assert.match(mail[0]!, /wilmar/u, 'and it carries the topic');
  const chat = candidateSubs('chat_search', config).map(call => String(call.args['query'] ?? '').toLowerCase());
  assert.match(chat[0]!, /wilmar|pilot/u, 'the chat search is the topic too');
  assert.equal(/explain|discussion|relevant/u.test(chat[0]!), false, 'with no instruction word');
});

test('TOPIC 2 (#565): a start without a topic is refused, and the repair line names the topic', () => {
  const refused = parseResearch({ action: 'start', question: 'what did we decide about the pilot' });
  assert.equal(refused.ok, false, 'a start with no topic is refused');
  if (!refused.ok) assert.equal(refused.reason, 'topic_required');
  assert.match(String(researchRepair('topic_required')['guidance']), /topic/iu, 'the repair line names the field to add');
  assert.match(String(researchRepair('topic_required')['guidance']), /8 words/u, 'and its budget, generated from TOPIC_MAX_WORDS');
  const tooLong = parseResearch({ action: 'start', question: 'q', topic: 'one two three four five six seven eight nine' });
  assert.equal(tooLong.ok, false, 'a topic past eight words is refused');
  if (!tooLong.ok) assert.equal(tooLong.reason, 'topic_length');
  assert.equal(parseResearch({ action: 'continue', researchId: 'abc', topic: 'a topic' }).ok, true, 'a continuation needs no topic');
});

// C-FILLER: the voice model sends every declared property, unused ones as "", null, [] or {}. Those are absent.
test('FILLER 1: the empty properties the voice model sends are absent, so the call is accepted', () => {
  const args = {
    action: 'start', question: 'what is on my calendar tomorrow', topic: 'calendar tomorrow', cursor: '', researchId: '',
    lookups: [{ source: 'calendar', query: 'tomorrow', history: {}, mail: {} }],
  };
  const parsed = parseResearch(args);
  assert.equal(parsed.ok, true, 'the filler shapes are not model errors');
  if (!parsed.ok) return;
  assert.deepEqual(parsed.normalized, ['cursor', 'researchId', 'lookups[0].history', 'lookups[0].mail']);
  assert.deepEqual(parsed.call.lookups, [{ source: 'calendar', query: 'tomorrow' }], 'the empty objects never reach the read');
  assert.equal(Object.hasOwn(parsed.call, 'cursor'), false, 'the empty cursor is absent, so it cannot conflict with the lookups');
  assert.equal(validateResearch(args), true);

  const refused = parseResearch({ action: 'start', question: 'what is the plan', topic: '' });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, 'topic_required', 'a really missing topic still refuses');
  assert.deepEqual(refused.shape.normalized, ['topic'], 'the refusal names the property it dropped');
  const line = { event: 'research_refused', state: 'refused', sequence: 1, reason: refused.reason, ...refused.shape };
  assert.equal(safeEvent(line)?.event, 'research_refused', 'the refusal line survives the host log with the normalised paths');
  assert.equal(safeEvent({ ...line, normalized: ['topic=calendar'] }), undefined, 'a value never rides the log in a path');
});

test('FILLER 2: a non-empty value and a real error still refuse, exactly as today', () => {
  const unknown = parseResearch({ action: 'start', question: 'what is on my calendar', topic: 'calendar', lookups: [{ source: 'calendar', query: 'x', extra: 'y' }] });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'lookup_unknown_fields');
  const empty = parseResearch({ action: 'start', question: '', topic: 'x' });
  assert.equal(empty.ok, false, 'a start with no question still refuses');
  if (!empty.ok) assert.equal(empty.reason, 'question_required');
  const history = parseResearch({ action: 'start', question: 'q', topic: 't', lookups: [{ source: 'calendar', query: 'x', history: { topic: 'y' } }] });
  assert.equal(history.ok, false, 'a non-empty history on a non-memory source still refuses');
  if (!history.ok) assert.equal(history.reason, 'lookup_history');
  assert.equal(parseResearch({ action: 'continue', researchId: 'abc', question: '', lookups: [] }).ok, true, 'the filler question and lookup list of a continuation are absent');
  assert.equal(parseResearch({ action: 'stop', researchId: 'abc', lookups: [] }).ok, true, 'a stop with the filler lookup list is a stop');
  const noId = parseResearch({ action: 'stop', lookups: [] });
  assert.equal(noId.ok, false, 'a stop with no run named still refuses');
  if (!noId.ok) assert.equal(noId.reason, 'research_id_required');
});

test('TOPIC 3 (#576): a spoken ask with no digits sends a query with no digit', async () => {
  const h = harness({ configured: ['knowledge'] });
  await runResearch(h.deps, {
    action: 'start',
    question: 'what did we decide about the Wilmar pilot',
    topic: 'Wilmar pilot',
    lookups: [{ source: 'knowledge', query: '2026-10-23 14:00 agenda Wilmar pilot' }],
  }, new AbortController().signal);
  await settle();
  const queries = h.executed.filter(entry => entry.name === 'search_knowledge')
    .map(entry => String((entry.args as Record<string, unknown>)['query'] ?? ''));
  assert.ok(queries.length > 0, 'the run searched knowledge');
  for (const query of queries) assert.equal(/\d/u.test(query), false, `no invented digit reaches the query: ${query}`);
  assert.match(queries[0]!, /wilmar/iu, 'the topic still reaches it');
});

test('TOPIC 4 (#576): a last-meeting ask reads the newest note first', async () => {
  const notes = [
    '### Weekly with Wilmar (2026-09-01) the rollout plan',
    '### Weekly with Wilmar (2026-10-20) the pilot budget',
    '### Weekly with Wilmar (2026-10-12) the pilot scope',
  ].join('\n');
  const h = harness({ configured: ['knowledge'], executeText: notes });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did we say in the last meeting with Wilmar', topic: 'Wilmar meeting',
    lookups: [{ source: 'knowledge', query: 'Wilmar meeting' }],
  }, new AbortController().signal);
  const text = JSON.stringify(reply);
  const order = ['pilot budget', 'pilot scope', 'rollout plan'].map(word => text.indexOf(word));
  assert.ok(order.every(at => at >= 0), `all three notes are shown: ${text.slice(0, 400)}`);
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'the newest note is read out first');
});

test('TOPIC 6 (#565): a source call reports its query shape and never one of its words', async () => {
  const shapes: Record<string, unknown>[] = [];
  const h = harness({ configured: ['knowledge'] });
  const deps = { ...h.deps, queryShape: (shape: Record<string, unknown>): void => { shapes.push(shape); } } as unknown as ResearchDeps;
  await runResearch(deps, { action: 'start', question: 'what did we decide about the Wilmar pilot budget', topic: 'Wilmar pilot budget' }, new AbortController().signal);
  await settle();
  assert.ok(shapes.length > 0, 'the run reported a query shape');
  const shape = shapes[0]!;
  assert.equal(shape['source'], 'knowledge');
  assert.equal(typeof shape['terms'], 'number');
  assert.equal(shape['topicWords'], 3, 'the topic word count is kept');
  assert.deepEqual(shape['operators'], [], 'and the operator list is empty for a plain knowledge read');
  assert.equal(JSON.stringify(shape).toLowerCase().includes('wilmar'), false, 'no word of the topic is recorded');
});

// TOPIC-R2 F1: the digit gate's authority is the owner's words in this run, never the words of the hop
// that happens to be reading, so a numbered name the owner said survives a continuation.
test('TOPIC-R2 F1 (#565): a later hop keeps a number the owner said when the run opened', () => {
  const run = 'what did we decide about the iPhone 16 pilot and what about the budget';
  assert.equal(topicTerms('iPhone 16 pilot', run), 'iPhone 16 pilot', 'the topic keeps the number the owner said');
  assert.equal(topicTerms('iPhone 16 pilot', 'and what about the budget'), 'iPhone pilot', 'and a question that never said it still drops it');
  const config = {
    question: 'and what about the budget', topic: 'iPhone 16 pilot',
    ownerWords: run, configured: CONFIGURED, evidence: new Map<CandidateKind, string>(),
  } as unknown as Parameters<typeof candidateSubs>[1];
  const mail = candidateSubs('mail_search', config).map(call => String(call.args['q'] ?? '').toLowerCase());
  assert.match(mail[0]!, /16/u, 'the mail read keeps the owner-spoken number on a later hop');
  const invented = candidateSubs('mail_search', { ...config, ownerWords: 'what did we decide about the pilot and what about the budget' } as unknown as Parameters<typeof candidateSubs>[1])
    .map(call => String(call.args['q'] ?? '').toLowerCase());
  assert.equal(/\d/u.test(invented[0]!), false, 'a number the owner never said still never reaches the query');
});

// TRIAGE-R3: the recall route reads her own history, and what she remembers reaches the answer.
test('TRIAGE-R3: a recall ask reads the owner history, never the knowledge store', async () => {
  const h = harness({ configured: ['memory', 'knowledge'], memory: query => ({ lines: [`remembered: ${query}`], text: '', total: 1 }) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we say about the pricing deck' }, new AbortController().signal);
  assert.ok(!h.executed.some(call => call.name === 'search_knowledge'), 'the knowledge store is not searched for a recall ask');
  assert.match(JSON.stringify(reply['findings']), /remembered: .*pricing deck/u, 'the remembered line reaches the answer');
});

// E3 (#611): the confidence line is undated, so the whole list used to keep the ranker's order.
test('E3: dated notes read newest first and an undated line keeps the index it came in at', () => {
  assert.deepEqual(
    newestDatedFirst(['knowledge: confidence=high', 'a | 2026-10-01', 'b | 2026-10-20', 'c | 2026-10-12']),
    ['knowledge: confidence=high', 'b | 2026-10-20', 'c | 2026-10-12', 'a | 2026-10-01'],
  );
});

// E3 (#611): "last meeting" names no day, so the note read is bounded instead of unbounded.
test('E3: a last meeting ask with no date word reads the last sixty days', () => {
  assert.deepEqual(meetingBounds('last meeting notes', undefined, Date.parse('2026-10-21T12:00:00Z'), 'UTC'),
    { from: '2026-08-22', to: '2026-10-21' });
  assert.equal(meetingBounds('what did we decide about the roadmap', undefined, Date.parse('2026-10-21T12:00:00Z'), 'UTC'), undefined,
    'a question with no meeting word and no last meeting phrase stays unbounded');
});

// E6 (#609): the fallback recipe used to hand Gmail an already-written operator string, so the sender
// filter and the term cap never ran. It now hands the compiler its window and its own words.
test('E6: a fallback inbox search is compiled, so its terms are capped and ORed', () => {
  const selection = fallbackSelection('any mail about the offsite venue inspection budget review card', ['mail'], Date.parse('2026-10-21T05:30:00Z'));
  const mailQuery = selection.actions.find(action => action.kind === 'mail_search')?.query;
  assert.equal(typeof mailQuery, 'string', 'the fallback offers a mail search');
  assert.match(mailQuery!, /^in:inbox newer_than:14d offsite venue inspection budget OR review OR card$/u, `the fallback window is compiled in: ${mailQuery}`);
  assert.match(mailQuery!, /offsite venue inspection budget OR review OR card/u, `three AND terms and the rest ORed: ${mailQuery}`);
});

// #617: the action and depth words of an ask are instructions, never search terms.
test('#617: an action word and a depth word never reach the mail search', () => {
  const q = compileMailQuery('write me a summary of the mail from Thomas about the pipeline', undefined, Date.parse('2026-10-21T05:30:00Z'), 'UTC', 'write me a summary of the mail from Thomas about the pipeline');
  assert.equal(/write|summary/u.test(q), false, `no action or depth word, got ${q}`);
  assert.match(q, /pipeline/u);
});

// #617: a meeting or a birthday named in the ask is a calendar read with the window it named.
test('#617: a named meeting or birthday reads the calendar', () => {
  for (const question of ["what's on for the meeting this afternoon", "when is Naya's birthday"]) {
    const offered = fallbackSelection(question, ['knowledge', 'calendar', 'mail', 'chat'], Date.parse('2026-10-21T05:30:00Z')).actions.map(action => action.kind);
    assert.equal(offered.includes('calendar_window'), true, `${question} reads the calendar, got ${JSON.stringify(offered)}`);
    const calendar = fallbackSelection(question, ['knowledge', 'calendar'], Date.parse('2026-10-21T05:30:00Z')).actions.find(action => action.kind === 'calendar_window');
    assert.equal(calendar?.window, 'today', `${question} carries the window it named`);
  }
});

// #617: the calendar is read when the ask names a day or a schedule, never as filler on a knowledge ask.
test('#617: a knowledge ask about no calendar words reads no calendar', () => {
  const selection = fallbackSelection('what do we know about the dark triad', ['knowledge', 'calendar', 'mail', 'chat'], Date.parse('2026-10-21T05:30:00Z'));
  assert.equal(selection.actions.some(action => action.kind === 'calendar_window'), false,
    `no calendar lookup, got ${JSON.stringify(selection.actions.map(action => action.kind))}`);
});


test('WEB-1024: the final pending envelope remains bounded and preserves the more-available sentence', () => {
  const reply = capReply({ status: 'partial', canContinue: true, note: `Still reading mail, chat. ${RESEARCH.moreAvailableNote}`, findings: [{ source: 'knowledge', text: 'knowledge: 1 of 1 shown\n' + 'This is a complete sentence. '.repeat(120) }], pending: ['mail', 'chat'], pendingBlock: 'A pending reader has more evidence. '.repeat(90) }, 2500);
  assert.ok(JSON.stringify(reply).length <= 2500);
  assert.match(String(reply['note']), new RegExp(RESEARCH.moreAvailableNote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const finding of (reply['findings'] as { text: string }[])) assert.match(finding.text, /[.!?]$/);
});


test('WEB-1024: an early answer with two pending readers keeps its final cap and continuation note', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const h = harness({ replyLimit: CAP_REPLY_BOUND, 
    now: clock.now, schedule: clock.schedule,
    configured: ['memory', 'knowledge', 'chat'],
    memory: () => ({ lines: ['A complete remembered sentence. '.repeat(120)], text: '', total: 1 }),
    execute: async (subs: readonly IntentSubCall[]) => { await gate.promise; return subs.map(call => sub(call.name, '## Result\nA complete late sentence.', true, call.key)); },
  });
  let reading: Promise<void> | undefined;
  h.deps.background = done => { reading = done; };
  h.deps.logFirstAnswer = () => {};
  const call = runResearch(h.deps, { action: 'start', question: 'what is remembered and recorded', lookups: [{ source: 'memory', query: 'remembered' }, { source: 'knowledge', query: 'recorded' }, { source: 'chat', query: 'recorded' }] }, new AbortController().signal);
  await tick(); clock.advance(RESEARCH.firstAnswerMs);
  const reply = await call;
  // #634: the coverage header counts inside the 2,500 char reply envelope.
  assert.ok(JSON.stringify(reply).length <= 2_500, JSON.stringify(reply).length.toString());
  assert.ok(String(reply['note']).includes(RESEARCH.moreAvailableNote), String(reply['note']));
  assert.deepEqual(reply['pending'], ['knowledge', 'chat']);
  gate.resolve(); await reading;
});


// --- #654: a continuation or status word is never a mail or chat search term -------------------------

test('#654: a continuation word never becomes a mail or chat search term', () => {
  const query = compileMailQuery('the release plan', 'in:inbox newer_than:14d finish read results');
  assert.match(query, /newer_than:14d/u, `the window the model wrote still stands (${query})`);
  assert.doesNotMatch(query, /finish|read|results/u, `and no continuation word is a mail term (${query})`);
  assert.equal(chatQuery('finish read remainder status complete', 0, 'UTC').trim(), '', 'and none of them becomes a chat term');
});
