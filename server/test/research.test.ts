import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, ResearchScheduler, createGeminiSelector, fallbackSelection, offerableCandidates,
  parseSelector, pUsefulOf, runResearch, validateResearch, worthContinuing,
  type ResearchDeps, type ResearchProgress, type ResearchRunLog, type ResearchSelector, type SelectorOutput, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

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

interface Harness { deps: ResearchDeps; progress: ResearchProgress[]; logs: ResearchRunLog[]; executed: { name: string; args: unknown }[] }

function harness(opts: { selector?: ResearchSelector | undefined; execute?: ResearchDeps['execute']; now?: () => number; ledger?: ResearchLedger; executeText?: string } = {}): Harness {
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const executed: { name: string; args: unknown }[] = [];
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    configured: CONFIGURED,
    execute: opts.execute ?? (async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push({ name: call.name, args: call.args });
      return subs.map(call => sub(call.name, opts.executeText ?? 'evidence', true, call.key));
    }),
    emit: event => progress.push(event),
    log: entry => logs.push(entry),
    ledger: opts.ledger ?? new ResearchLedger(),
    ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
  };
  return { deps, progress, logs, executed };
}

const selectorOf = (output: SelectorOutput): ResearchSelector => ({ select: async () => output });
const knowledge = selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } });

test('Argon round 3: continues at pUseful 0.44 and stops at 0.42 for cross_source after a 4.7 s calendar read', () => {
  const base = { questionClass: 'cross_source' as const, elapsedMs: 4_700, subsetP50Ms: 3_600, deadlineMs: 15_000 };
  assert.equal(worthContinuing({ ...base, pUseful: 0.44 }), true);
  assert.equal(worthContinuing({ ...base, pUseful: 0.42 }), false);
  assert.ok(Math.abs(pUsefulOf([0.44, 0.42]) - 0.6752) < 1e-9);
});

test('the timeout and invalid selector output fall back to the fixed recipe and stop after round one', async () => {
  const timedOut: ResearchSelector = { select: async () => { throw new Error('aborted'); } };
  assert.equal(parseSelector('not json at all'), null);
  const h = harness({ selector: timedOut });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did the team decide about the release' }, new AbortController().signal);
  assert.equal(h.logs[0]!.fallbackUsed, true);
  assert.equal(h.logs[0]!.rounds, 1);
  assert.ok(h.executed.length >= 1);
  assert.equal(reply['status'], 'answered');
});

test('a single-source hint skips the round-1 selector', async () => {
  let selectCalls = 0;
  const counting: ResearchSelector = { select: async () => { selectCalls += 1; return { questionClass: 'cross_source', actions: [], pUseful: {} }; } };
  const h = harness({ selector: counting });
  await runResearch(h.deps, { action: 'start', question: 'anything', sources: 'mail' }, new AbortController().signal);
  assert.equal(selectCalls, 0);
  assert.ok(h.executed.length >= 1 && h.executed.every(call => call.name === 'gmail_list'));
  assert.equal(h.logs[0]!.fallbackUsed, false);
});

test('continue reuses the ledger and never re-reads a completed operation', async () => {
  const h = harness({ selector: knowledge });
  const first = await runResearch(h.deps, { action: 'start', question: 'release status' }, new AbortController().signal);
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 1);
  h.executed.length = 0;
  const second = await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, new AbortController().signal);
  assert.equal(String(second['researchId']), String(first['researchId']));
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 0);
});

test('stop is idempotent and returns what is known', async () => {
  const h = harness({ selector: knowledge });
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
  const h = harness({ selector: knowledge, execute: async subs => { barge.abort(); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const reply = await runResearch(h.deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.notEqual(reply['status'], 'stopped');
  assert.equal(barge.signal.aborted, true);
});

test('the session abort ends the run as stopped', async () => {
  const session = new AbortController();
  const h = harness({ selector: knowledge, execute: async subs => { session.abort(); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const reply = await runResearch(h.deps, { action: 'start', question: 'anything' }, session.signal);
  assert.equal(reply['status'], 'stopped');
});

test('a run past its deadline returns partial after one round', async () => {
  let advanced = false;
  const h = harness({ selector: selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9, chat_search: 0.9 } }) });
  const deps: ResearchDeps = { ...h.deps, now: () => (advanced ? RESEARCH.startDeadlineMs + 5_000 : 0), execute: async subs => { advanced = true; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } };
  const reply = await runResearch(deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.equal(reply['status'], 'partial');
  assert.equal(h.logs[0]!.rounds, 1);
});

test('the whole serialized reply stays within the character cap', async () => {
  const h = harness({ selector: selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }, { kind: 'chat_search' }], pUseful: { knowledge_search: 0.9, chat_search: 0.9 } }), executeText: 'x'.repeat(9_000) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.replyLimitChars, `reply was ${JSON.stringify(reply).length} chars`);
});

test('mongoose is never offered while unconfigured', () => {
  const offered = offerableCandidates(['knowledge', 'calendar', 'mail', 'chat'], []);
  assert.equal(offered.includes('brief'), true);
  assert.equal(offered.includes('chat_thread'), false, 'a thread read needs a completed chat search');
  assert.ok(fallbackSelection('what is in mongoose', ['knowledge', 'calendar', 'mail', 'chat']).actions.every(action => String(action.kind) !== 'mongoose'));
});

test('progress and the run log carry metadata only, never the question text', async () => {
  const h = harness({ selector: knowledge });
  await runResearch(h.deps, { action: 'start', question: 'the secret project is launchpad' }, new AbortController().signal);
  assert.deepEqual(h.progress.map(event => event.phase), ['started', 'round', 'done']);
  assert.equal(JSON.stringify(h.logs).includes('launchpad'), false);
  assert.equal(h.logs[0]!.event, 'research_run');
});

test('a new research call while one is pending answers the old call at once and the new one with the merged result', async () => {
  const gate = deferred<void>();
  const h = harness({ selector: knowledge, execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q', researchId: 'r1' }, new AbortController().signal);
  const second = scheduler.call({ action: 'continue', researchId: 'r1' }, new AbortController().signal);
  const firstReply = await first;
  assert.equal(firstReply['superseded'], true);
  assert.deepEqual(firstReply['findings'], []);
  gate.resolve();
  const secondReply = await second;
  assert.equal(secondReply['researchId'], 'r1');
  assert.equal(secondReply['superseded'], undefined);
});

test('a stop call while one is pending returns what is known now', async () => {
  const gate = deferred<void>();
  const h = harness({ selector: knowledge, execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q', researchId: 'r2' }, new AbortController().signal);
  const stopped = await scheduler.call({ action: 'stop', researchId: 'r2' }, new AbortController().signal);
  assert.equal(stopped['status'], 'stopped');
  assert.equal((await first)['superseded'], true);
  gate.resolve();
});

test('the word stop in a question never stops a run: stop is only a tool action', async () => {
  const h = harness({ selector: knowledge });
  const reply = await runResearch(h.deps, { action: 'start', question: 'stop the presses and tell me the release status' }, new AbortController().signal);
  assert.equal(reply['status'], 'answered');
});

test('validate accepts the three actions and rejects invented keys', () => {
  assert.equal(validateResearch({ action: 'start', question: 'q' }), true);
  assert.equal(validateResearch({ action: 'continue', researchId: 'abc' }), true);
  assert.equal(validateResearch({ action: 'stop', researchId: 'abc' }), true);
  assert.equal(validateResearch({ action: 'start' }), false);
  assert.equal(validateResearch({ action: 'destroy', question: 'q' }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', evil: 1 }), false);
});

test('parseSelector rejects invented kinds and clamps out-of-range pUseful', () => {
  const parsed = parseSelector('{"questionClass":"cross_source","actions":[{"kind":"invented"}],"pUseful":{"knowledge_search":7}}');
  assert.deepEqual(parsed?.actions, []);
  assert.equal(parsed?.pUseful['knowledge_search'], 1);
});

test('createGeminiSelector parses one complete text answer and treats a non-complete status as no output', async () => {
  let calls = 0;
  const ok = createGeminiSelector({ async generate() { calls += 1; return { status: 'complete', text: '{"questionClass":"quick_fact","actions":[],"pUseful":{}}' } as never; } });
  const parsed = await ok.select({ question: 'q', configured: CONFIGURED, completed: [], candidates: ['knowledge_search'] }, new AbortController().signal);
  assert.equal(parsed?.questionClass, 'quick_fact');
  const bad = createGeminiSelector({ async generate() { return { status: 'error', text: '' } as never; } });
  assert.equal(await bad.select({ question: 'q', configured: CONFIGURED, completed: [], candidates: ['knowledge_search'] }, new AbortController().signal), null);
  assert.equal(calls, 1);
});
