import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, ResearchScheduler, createGeminiSelector, fallbackSelection, offerableCandidates,
  parseSelector, pUsefulOf, researchDeclaration, researchDescription, researchSourcesFromToolNames, runResearch,
  validateResearch, worthContinuing,
  type ResearchDeps, type ResearchProgress, type ResearchRunLog, type ResearchSelector, type ResearchSubcallLog, type SelectorOutput, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import './research-shape.test.js';

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

interface Harness { deps: ResearchDeps; progress: ResearchProgress[]; logs: ResearchRunLog[]; subcalls: ResearchSubcallLog[]; executed: { name: string; args: unknown }[] }

function harness(opts: { selector?: ResearchSelector | undefined; execute?: ResearchDeps['execute']; now?: () => number; ledger?: ResearchLedger; executeText?: string; replyLimit?: number } = {}): Harness {
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const subcalls: ResearchSubcallLog[] = [];
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
    logSubcall: entry => subcalls.push(entry),
    ledger: opts.ledger ?? new ResearchLedger(),
    ...(opts.replyLimit !== undefined ? { replyLimit: opts.replyLimit } : {}),
    ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
  };
  return { deps, progress, logs, subcalls, executed };
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
  assert.equal(h.logs[0]!.driver, 'fallback');
  assert.equal(h.logs[0]!.rounds, 1);
  assert.ok(h.executed.length >= 1);
  assert.equal(reply['status'], 'answered');
});

test('a single-source hint narrows the offered kinds and still runs the selector', async () => {
  let selectCalls = 0;
  let firstOffered: string[] = [];
  const counting: ResearchSelector = { select: async input => { selectCalls += 1; if (selectCalls === 1) firstOffered = [...input.candidates]; return { questionClass: 'cross_source', actions: [{ kind: 'mail_search', query: 'in:inbox newer_than:2d' }], pUseful: { mail_search: 0.9 } }; } };
  const h = harness({ selector: counting });
  await runResearch(h.deps, { action: 'start', question: 'anything', sources: 'mail' }, new AbortController().signal);
  assert.equal(selectCalls >= 1, true);
  assert.deepEqual(firstOffered, ['mail_search']);
  assert.ok(h.executed.length >= 1 && h.executed.every(call => call.name === 'gmail_list'));
  assert.equal(h.logs[0]!.fallbackUsed, false);
  assert.equal(h.logs[0]!.driver, 'single-source-hint');
});

test('a single-source hint with no usable question still runs the hinted source', async () => {
  const h = harness({ selector: undefined });
  await runResearch(h.deps, { action: 'start', question: '', sources: 'mail' }, new AbortController().signal);
  assert.ok(h.executed.some(call => call.name === 'gmail_list'), 'the hinted source always runs');
  assert.equal(h.logs[0]!.driver, 'single-source-hint');
});

test('every lookup names the driver the loop used', async () => {
  const hinted = harness({ selector: knowledge });
  await runResearch(hinted.deps, { action: 'start', question: 'anything', sources: 'mail' }, new AbortController().signal);
  assert.equal(hinted.logs[0]!.driver, 'single-source-hint');
  const chosen = harness({ selector: knowledge });
  await runResearch(chosen.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  assert.equal(chosen.logs[0]!.driver, 'selector');
  const timedOut: ResearchSelector = { select: async () => { throw new Error('aborted'); } };
  const fell = harness({ selector: timedOut });
  await runResearch(fell.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  assert.equal(fell.logs[0]!.driver, 'fallback');
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

test('a continue with no researchId applies to the single pending run (R1-R3)', async () => {
  const gate = deferred<void>();
  const h = harness({ selector: knowledge, execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q', researchId: 'r3' }, new AbortController().signal);
  const second = scheduler.call({ action: 'continue' }, new AbortController().signal);
  assert.equal((await first)['superseded'], true);
  gate.resolve();
  assert.equal((await second)['researchId'], 'r3');
});

test('a stop with an unknown researchId applies to the single pending run (R1-R3)', async () => {
  const gate = deferred<void>();
  const h = harness({ selector: knowledge, execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'q', researchId: 'r4' }, new AbortController().signal);
  const stopped = await scheduler.call({ action: 'stop', researchId: 'unknown-id' }, new AbortController().signal);
  assert.equal(stopped['status'], 'stopped');
  assert.equal(String(stopped['researchId']), 'r4');
  assert.equal((await first)['superseded'], true);
  gate.resolve();
});

test('with several runs pending an unknown-id stop keeps current behaviour (R1-R3)', async () => {
  const gate = deferred<void>();
  const h = harness({ selector: knowledge, execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'a', researchId: 'p1' }, new AbortController().signal);
  const second = scheduler.call({ action: 'start', question: 'b', researchId: 'p2' }, new AbortController().signal);
  const stopped = await scheduler.call({ action: 'stop', researchId: 'nope' }, new AbortController().signal);
  assert.equal(stopped['status'], 'stopped');
  assert.equal(String(stopped['researchId']), 'nope');
  assert.equal(await Promise.race([first.then(() => 'first'), second.then(() => 'second'), Promise.resolve('none')]), 'none');
  gate.resolve();
  await first; await second;
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

// #263: the declaration names only the sources this session configured and the host loop can read. A session
// with Google (calendar, mail), Mattermost (team chat) and lux-knowledge (knowledge) names those four.
test('the research declaration names only the configured sources and the valid hint values', () => {
  const google = ['gcal_calendars', 'gmail_list'];
  const base = researchSourcesFromToolNames([...google, 'mattermost_search', 'search_knowledge']);
  assert.deepEqual(base, ['calendar', 'mail', 'chat', 'knowledge']);
  const description = researchDescription(base);
  assert.match(description, /calendar, mail, team chat and knowledge base/);
  assert.doesNotMatch(description, /company knowledge base/);
  assert.ok(description.length < 500, `description ${description.length} chars`);
  // R2-R2: the loop has no Mongoose candidate, so a Mongoose-configured session still names only the four.
  const withMongooseTools = researchSourcesFromToolNames([...google, 'mattermost_search', 'search_knowledge', 'ask_mongoose', 'search_mongoose']);
  assert.deepEqual(withMongooseTools, ['calendar', 'mail', 'chat', 'knowledge']);
  const declaration = researchDeclaration(base);
  assert.equal(declaration.name, 'research');
  assert.equal(declaration.description, description);
  const properties = (declaration.parameters as unknown as { properties: Record<string, { description: string }> }).properties;
  assert.match(properties['sources']!.description, /calendar, mail, chat, knowledge\./);
});

// --- Calendar fan-out, window logging and knowledge carry (contract F4, #272) ------------------

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const calendarSelector: ResearchSelector = {
  async select() { return { questionClass: 'quick_fact', actions: [{ kind: 'calendar_window', window: 'tomorrow' }], pUseful: { calendar_window: 1 } }; },
};

const CALENDARS = '- Primary [primary]\n- Work [work]';
const CALENDAR_EVENTS: Record<string, string> = {
  primary: '- 2026-10-16T09:00:00+05:30, Standup, Room 1 [id e1]\n- 2026-10-16T11:00:00+05:30, Review [id e2]',
  work: '- 2026-10-16T10:00:00+05:30, Board deck, Room 2 [id e3]\n- 2026-10-16T09:00:00+05:30, Standup, Room 1 [id e1]',
};
const calendarExecute: ResearchDeps['execute'] = async subs => subs.map(call => sub(
  call.name,
  call.name === 'gcal_calendars' ? CALENDARS : (CALENDAR_EVENTS[String(call.args['calendarId'])] ?? ''),
  true, call.key,
));

test('calendar research reads every listed calendar, merges, sorts, dedupes by id and names each line', async () => {
  const h = harness({ selector: calendarSelector, execute: calendarExecute });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'calendar')!;
  assert.match(finding.text, /^calendar: 3 of 3 shown/);
  assert.deepEqual(finding.text.split('\n').slice(1), [
    '2026-10-16T09:00:00+05:30 | Standup | Room 1 | 0 attendees | Primary',
    '2026-10-16T10:00:00+05:30 | Board deck | Room 2 | 0 attendees | Work',
    '2026-10-16T11:00:00+05:30 | Review | 0 attendees | Primary',
  ]);
  const reads = h.executed.filter(call => call.name === 'gcal_list').map(call => String((call.args as Record<string, unknown>)['calendarId']));
  assert.deepEqual([...reads].sort(), ['primary', 'work']);
});

test('calendar sub-calls log the resolved window kind only, never a time or title', async () => {
  const h = harness({ selector: calendarSelector, execute: calendarExecute });
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const calendarLogs = h.subcalls.filter(entry => entry.kind === 'calendar_window');
  assert.ok(calendarLogs.length >= 3);
  for (const entry of calendarLogs) assert.equal((entry as unknown as Record<string, unknown>)['window'], 'tomorrow');
  assert.equal(JSON.stringify(h.subcalls).includes('2026-10-16T'), false, 'the resolved times never reach the log');
});

test('per-calendar reads run concurrently, bounded at six, with no sleeps', async () => {
  const listed = Array.from({ length: 8 }, (_, i) => `- Cal ${i} [c${i}]`).join('\n');
  let inFlight = 0, peak = 0;
  const gates: (() => void)[] = [];
  const execute: ResearchDeps['execute'] = async subs => {
    if (subs.length === 1 && subs[0]!.name === 'gcal_list') {
      const id = String(subs[0]!.args['calendarId']);
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise<void>(resolve => gates.push(resolve));
      inFlight -= 1;
      return subs.map(call => sub(call.name, `- 2026-10-16T01:00:00+05:30, Event [id ${id}]`, true, call.key));
    }
    return subs.map(call => sub(call.name, call.name === 'gcal_calendars' ? listed : 'evidence', true, call.key));
  };
  const h = harness({ selector: calendarSelector, execute });
  const run = runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  let done = false; void run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100 && gates.length < 6; i += 1) await tick();
  assert.equal(peak, 6, 'at most six per-calendar reads are in flight at once');
  assert.ok(gates.length >= 6, 'the reads overlap rather than run one at a time');
  for (let i = 0; i < 200 && !done; i += 1) { for (const gate of gates.splice(0)) gate(); await tick(); }
  for (const gate of gates.splice(0)) gate();
  await run;
  assert.ok(peak <= 6);
});

test('knowledge shaping carries at least ninety percent of a 41-item ledger under the reply limit', async () => {
  const body = 'k'.repeat(60);
  const items = Array.from({ length: 41 }, (_, i) => `### Insight ${i} [id ${i + 1}]\n${body}`);
  const h = harness({ selector: knowledge, executeText: items.join('\n') });
  const reply = await runResearch(h.deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'knowledge')!;
  const lines = finding.text.split('\n').slice(1);
  assert.ok(lines.length >= 37, `carried ${lines.length} of 41 lines`);
  const total = items.reduce((sum, _, i) => sum + `#${i + 1} Insight ${i} | ${body}`.length, 0);
  const carried = lines.reduce((sum, line) => sum + line.length, 0);
  assert.ok(carried / total >= 0.9, `carried ${carried} of ${total} bytes`);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.replyLimitChars);
});
