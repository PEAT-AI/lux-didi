import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, ResearchScheduler, candidateSubs, cutLineOf, fallbackSelection, namedInsightIds, offerableCandidates, shapeBlock,
  configuredSourcesForEndpoints, configuredSourcesForSession, plainReason, unreachableSourcesForSession, UNPUBLISHED_SOURCE_REASON, pUsefulOf, refusalCode, researchDeclaration, researchDescription, researchSourcesForConnector, researchSourcesFromToolNames, runResearch,
  validateResearch, worthContinuing,
  researchCallBudgetMs, type ResearchDeps, type ResearchFirstAnswer, type ResearchLateFindings, type ResearchProgress, type ResearchRunLog, type ResearchSourceLog, type ResearchSubcallLog, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import type { CandidateKind } from '../tools/research.js';
import { shapeGcalList, shapeGmailList, shapeLuxKnowledge } from '../tools/live-shape.js';
import { safeEvent } from '../host/log.js';
import { projectDiagnosticInput } from '../tools/diagnostic-input.js';
import './research-shape.test.js';
import './research-calendar.test.js';

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

interface Harness { deps: ResearchDeps; progress: ResearchProgress[]; logs: ResearchRunLog[]; subcalls: ResearchSubcallLog[]; executed: { name: string; args: unknown }[]; joined: string[] }

function harness(opts: { execute?: ResearchDeps['execute']; now?: () => number; schedule?: ResearchDeps['schedule']; ledger?: ResearchLedger; executeText?: string; replyLimit?: number; configured?: readonly SourceKind[]; memory?: (query: string) => { lines: string[]; text: string; total: number } } = {}): Harness {
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const subcalls: ResearchSubcallLog[] = [];
  const executed: { name: string; args: unknown }[] = [];
  const joined: string[] = [];
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
    logJoined: id => joined.push(id),
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
        ...(found ? { binding: { executionId: call.key } as NonNullable<IntentSubResult['binding']>, historyPage: { status: 'ok', hits: found.lines.map(snippet => ({ snippet })), totalMatches: found.total, nextCursor: null } } : {}) };
    });
  };
  return { deps, progress, logs, subcalls, executed, joined };
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
  assert.ok(JSON.stringify(reply).length <= RESEARCH.replyLimitChars, `reply was ${JSON.stringify(reply).length} chars`);
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
  assert.deepEqual(h.joined, [minted], 'the join is logged as research_joined');
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
  assert.deepEqual(h.joined, [replies[0]!['researchId'], replies[0]!['researchId']], 'both later calls are logged as joins');
  const other = await scheduler.call({ action: 'start', question: 'What did the board decide about hiring?', sources: 'knowledge' }, new AbortController().signal);
  assert.notEqual(String(other['researchId']), String(replies[0]!['researchId']), 'a different question is its own run');
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 2, 'and it is read');
  clock += RESEARCH.coalesceWindowMs + 1;
  await scheduler.call({ action: 'start', question: 'Where does the release stand?', sources: 'knowledge' }, new AbortController().signal);
  assert.equal(h.executed.filter(call => call.name === 'search_knowledge').length, 3, 'outside the window the same question is researched again');
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
  assert.equal(validateResearch({ action: 'start', question: 'q' }), true);
  assert.equal(validateResearch({ action: 'continue', researchId: 'abc' }), true);
  assert.equal(validateResearch({ action: 'stop', researchId: 'abc' }), true);
  assert.equal(validateResearch({ action: 'start' }), false);
  assert.equal(validateResearch({ action: 'destroy', question: 'q' }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', evil: 1 }), false);
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
  const withMongooseTools = researchSourcesFromToolNames([...google, 'mattermost_search', 'search_knowledge', 'ask_mongoose', 'search_mongoose']);
  assert.deepEqual(withMongooseTools, ['calendar', 'mail', 'chat', 'knowledge', 'mongoose']);
  const declaration = researchDeclaration(base);
  assert.equal(declaration.name, 'research');
  assert.equal(declaration.description, description);
  const properties = (declaration.parameters as unknown as { properties: Record<string, { description: string }> }).properties;
  assert.match(properties['sources']!.description, /calendar, mail, chat, knowledge\./);
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

test('knowledge shaping carries at least ninety percent of a 41-item ledger under the reply limit', async () => {
  const body = 'k'.repeat(60);
  const items = Array.from({ length: 41 }, (_, i) => `### Insight ${i} [id ${i + 1}]\n${body}`);
  const h = harness({ executeText: items.join('\n') });
  // #1021: a content-free question no longer searches knowledge, so the ledger test asks a real one.
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'knowledge')!;
  const lines = finding.text.split('\n').slice(1);
  assert.ok(lines.length >= 37, `carried ${lines.length} of 41 lines`);
  const total = items.reduce((sum, _, i) => sum + `#${i + 1} Insight ${i} | ${body}`.length, 0);
  const carried = lines.reduce((sum, line) => sum + line.length, 0);
  assert.ok(carried / total >= 0.9, `carried ${carried} of ${total} bytes`);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.replyLimitChars);
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
  const reply = await runResearch(h.deps, { action: 'start', question: 'would you check my mail for the landlord invoice' }, new AbortController().signal);
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
  const reply = await runResearch(h.deps, { action: 'start', question: 'catch me up' }, new AbortController().signal);
  const sources = (reply['findings'] as { source?: string }[]).map(finding => finding.source);
  for (const source of ['calendar', 'mail', 'chat', 'knowledge']) assert.ok(sources.includes(source), `the brief read of ${source} is delivered to the answer`);
  assert.deepEqual(reply['unchecked'], [], 'every configured source was credited, so none is unchecked');
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
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
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
  await assert.rejects(runResearch(deps, { action: 'start', question: 'what is waiting on me' }, new AbortController().signal), /step sink gone/);
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

test('P5: chat answers at 6 s inside its own 12 s deadline, and the call budget follows that source', async () => {
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
  clock.advance(6_000); await settle();
  release([sub('mattermost_search', '- release freeze agreed on Friday', true, 'c0')]);
  const reply = await running;
  assert.equal(reply['status'], 'complete', 'a 6 s chat read inside its 12 s deadline answers');
  assert.deepEqual(receipts.map(event => [event.source, event.outcome, event.deadlineMs]), [['chat', 'ok', 12_000]], 'the receipt names the deadline the chat read really had');
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
  const config = { question: 'go deep on insight 412, the release 3p decision', configured: CONFIGURED, evidence: new Map<CandidateKind, string>() };
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
  assert.equal(args['max_chars'], 3_000);
  assert.equal(args['snippet_chars'], 300);
  assert.equal(args['deadline_ms'], 8_000);
  assert.equal(typeof args['query'], 'string');
  assert.equal(RESEARCH.knowledgeBodyChars, 3_000);
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
  assert.match(cutHit, /#412 Release 3p scope[^|]*\| The part of the body that fits\. \| cut at 3000 chars/u);
  assert.equal(finding.text.includes('truncated:'), false, 'the server flag is replaced by the named window it was cut at');
  assert.equal(wholeHit.includes('cut at'), false, 'an uncut body carries no cut mark');
});

test('3r: the research receipt records the bounded-body request, metadata only', async () => {
  const h = harness({ executeText: '### Scope [id 412]\nBody.' });
  const receipts: ResearchSourceLog[] = [];
  const deps: ResearchDeps = { ...h.deps, logSource: event => receipts.push(event) };
  await runResearch(deps, { action: 'start', question: 'release scope' }, new AbortController().signal);
  const receipt = receipts.find(entry => entry.source === 'knowledge')!;
  // ROUTE-1022: the brief bundle reads chat with its own default window, so the receipt says compiled.
  assert.deepEqual(receipt.knowledge, { detail: 'voice', maxChars: 3_000, deadlineMs: 8_000, truncated: false, queryTerms: 2, dateFilter: false, chatDateOperator: 'compiled' }, 'the receipt says where the chat window came from');

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
  assert.equal(args['max_chars'], 3_000);
  const receipt = receipts.find(entry => entry.source === 'knowledge')!;
  assert.equal(receipt.outcome, 'ok');
  assert.deepEqual(receipt.knowledge, { detail: 'voice', maxChars: 3_000, deadlineMs: 8_000, truncated: true, queryTerms: 2, dateFilter: false, chatDateOperator: 'none' });
});

// MED-1022/T-R3: the dispatch keeps a tool call's arguments when every one of them is on the closed
// field list, so the voice fields and the day bounds must be listed or the trace keeps a hash only.
test('MED-1022: a voice search with a day filter keeps its arguments through the diagnostic projection', () => {
  const subs = candidateSubs('knowledge_search', {
    question: "what did we decide in yesterday's Wriggler call about pricing",
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
  assert.match(String(reply['note']), /team chat: not read \(timed out after 12 s\)/, 'the reason is the timeout and its budget, never a bare unreachable');
  assert.match(String(reply['note']), /could not reach team chat/, 'and the voiceable clause about it is still there');
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
  assert.equal(h.joined.length, 1);
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
