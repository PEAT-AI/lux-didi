import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, ResearchScheduler, createGeminiSelector, fallbackSelection, offerableCandidates,
  parseSelector, pUsefulOf, refusalCode, researchDeclaration, researchDescription, researchSourcesForConnector, researchSourcesFromToolNames, runResearch,
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

interface Harness { deps: ResearchDeps; progress: ResearchProgress[]; logs: ResearchRunLog[]; subcalls: ResearchSubcallLog[]; executed: { name: string; args: unknown }[]; joined: string[] }

function harness(opts: { selector?: ResearchSelector | undefined; execute?: ResearchDeps['execute']; now?: () => number; schedule?: ResearchDeps['schedule']; ledger?: ResearchLedger; executeText?: string; replyLimit?: number } = {}): Harness {
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const subcalls: ResearchSubcallLog[] = [];
  const executed: { name: string; args: unknown }[] = [];
  const joined: string[] = [];
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
    logJoined: id => joined.push(id),
    ledger: opts.ledger ?? new ResearchLedger(),
    ...(opts.replyLimit !== undefined ? { replyLimit: opts.replyLimit } : {}),
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
    ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
  };
  return { deps, progress, logs, subcalls, executed, joined };
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

test('a single-source hint narrows the offered kinds and skips the selector entirely', async () => {
  let selectCalls = 0;
  const counting: ResearchSelector = { select: async () => { selectCalls += 1; return { questionClass: 'cross_source', actions: [{ kind: 'mail_search', query: 'in:inbox newer_than:2d' }], pUseful: { mail_search: 0.9 } }; } };
  const h = harness({ selector: counting });
  await runResearch(h.deps, { action: 'start', question: 'anything', sources: 'mail' }, new AbortController().signal);
  assert.equal(selectCalls, 0, 'the single-source path never calls the selector');
  assert.ok(h.executed.length >= 1 && h.executed.every(call => call.name === 'gmail_list'));
  assert.equal(h.logs[0]!.fallbackUsed, false);
  assert.equal(h.logs[0]!.driver, 'single-source-hint');
  assert.equal(h.logs[0]!.selectorMs, 0, 'a skipped selector costs no selector time');
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

test('a failed follow-up logs its real error code, never a bare failed', async () => {
  const h = harness({
    selector: selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'chat_search' }], pUseful: { chat_search: 0.9 } }),
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

test('a second start while a run is in flight joins that run instead of starting a second one', async () => {
  const gate = deferred<void>();
  const h = harness({ selector: knowledge, execute: async subs => { await gate.promise; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const scheduler = new ResearchScheduler(h.deps);
  const first = scheduler.call({ action: 'start', question: 'a', researchId: 'p1' }, new AbortController().signal);
  const second = scheduler.call({ action: 'start', question: 'b', researchId: 'p2' }, new AbortController().signal);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(String(a['researchId']), 'p1');
  assert.equal(String(b['researchId']), 'p1', 'the second start joins the in-flight run');
  assert.deepEqual(h.joined, ['p1'], 'the join is logged as research_joined');
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
  const google = ['gcal_list', 'gmail_list'];
  const base = researchSourcesFromToolNames([...google, 'mattermost_search', 'search_knowledge']);
  assert.deepEqual(base, ['calendar', 'mail', 'chat', 'knowledge']);
  // Outcome 3: detection uses the read tool. A calendar-list sibling without gcal_list is not a
  // calendar source, so no calendar read is advertised that the connection cannot perform.
  assert.deepEqual(researchSourcesFromToolNames(['gcal_calendars', 'gmail_list', 'search_knowledge']), ['mail', 'knowledge']);
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

// --- Calendar merged read, window logging and knowledge carry (contract F4, #272) ---------------

const calendarSelector: ResearchSelector = {
  async select() { return { questionClass: 'quick_fact', actions: [{ kind: 'calendar_window', window: 'tomorrow' }], pUseful: { calendar_window: 1 } }; },
};

// The connector returns one merged, sorted, deduped, name-tagged result; research makes one call.
const MERGED_CALENDAR = [
  '- 2026-10-16T09:00:00+05:30, Standup, Room 1 | Primary [id e1]',
  '- 2026-10-16T10:00:00+05:30, Board deck, Room 2 | Work [id e3]',
  '- 2026-10-16T11:00:00+05:30, Review | Primary [id e2]',
].join('\n');

test('calendar research issues one merged sub-call per question and shapes every event', async () => {
  const h = harness({ selector: calendarSelector, executeText: MERGED_CALENDAR });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const reads = h.executed.filter(call => call.name === 'gcal_list');
  assert.equal(reads.length, 1, 'one calendar sub-call per question');
  assert.equal((reads[0]!.args as Record<string, unknown>)['calendarId'], undefined, 'the connector resolves the selected set');
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'calendar')!;
  assert.match(finding.text, /^calendar: 3 of 3 shown/);
  assert.deepEqual(finding.text.split('\n').slice(1), [
    '2026-10-16T09:00:00+05:30 | Standup | Room 1 | Primary',
    '2026-10-16T10:00:00+05:30 | Board deck | Room 2 | Work',
    '2026-10-16T11:00:00+05:30 | Review | Primary',
  ]);
});

test('calendar sub-calls log the resolved window kind only, never a time or title', async () => {
  const h = harness({ selector: calendarSelector, executeText: MERGED_CALENDAR });
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  const calendarLogs = h.subcalls.filter(entry => entry.kind === 'calendar_window');
  assert.equal(calendarLogs.length, 1);
  assert.equal((calendarLogs[0] as unknown as Record<string, unknown>)['window'], 'tomorrow');
  assert.equal(JSON.stringify(h.subcalls).includes('2026-10-16T'), false, 'the resolved times never reach the log');
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

// --- Release 3h: source truth, diagnostics and speed ------------------------------------------

test('a refused sub-call maps to a real reason, never a bare refused', () => {
  assert.equal(refusalCode('unknown_tool'), 'unknown_tool');
  assert.equal(refusalCode('grant_not_permitted'), 'grant_not_permitted');
  assert.equal(refusalCode('stale_or_revoked_authority'), 'stale_or_revoked_authority');
  assert.equal(refusalCode('round_deadline'), 'round_deadline');
  assert.equal(refusalCode('Invalid arguments for gcal_list. Expected an object with timeMin (string).'), 'invalid_arguments');
  assert.equal(refusalCode('something else entirely'), 'refused');
});

test('a never-dispatched sub-call logs its real reason instead of refused', async () => {
  const selector = selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'calendar_window', window: 'today' }], pUseful: { calendar_window: 1 } });
  const h = harness({
    selector,
    execute: async subs => subs.map(call => call.name === 'gcal_list'
      ? { ...sub(call.name, '', false, call.key), code: 'unknown_tool' }
      : sub(call.name, 'evidence', true, call.key)),
  });
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar today' }, new AbortController().signal);
  const refused = h.subcalls.find(entry => entry.tool === 'gcal_list');
  assert.equal(refused?.errorCode, 'unknown_tool');
});

test('a source whose read failed stays unchecked and the reply names it', async () => {
  const h = harness({
    selector: calendarSelector,
    execute: async subs => subs.map(call => call.name === 'gcal_list'
      ? { ...sub(call.name, '', false, call.key), code: 'unknown_tool' }
      : sub(call.name, 'evidence', true, call.key)),
  });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  assert.ok((reply['unchecked'] as string[]).includes('calendar'), 'a failed source stays unchecked');
  assert.match(String(reply['note'] ?? ''), /could not reach calendar right now/, 'the reply voices the unreachable source');
});

test('a source that read successfully is not unchecked and carries no unreachable note', async () => {
  const h = harness({ selector: calendarSelector, executeText: MERGED_CALENDAR });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, new AbortController().signal);
  assert.equal((reply['unchecked'] as string[]).includes('calendar'), false);
  assert.equal(reply['note'], undefined);
});

test('the connector to source map covers the approved connectors', () => {
  assert.deepEqual(researchSourcesForConnector('google'), ['calendar', 'mail']);
  assert.deepEqual(researchSourcesForConnector('mattermost'), ['chat']);
  assert.deepEqual(researchSourcesForConnector('lux-knowledge'), ['knowledge']);
  assert.deepEqual(researchSourcesForConnector('mongoose'), []);
});

test('configuredNow re-resolves the configured sources for each run', async () => {
  const h = harness({ selector: knowledge });
  const deps: ResearchDeps = { ...h.deps, configured: [], configuredNow: () => ['knowledge', 'calendar'] };
  const reply = await runResearch(deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.ok((reply['unchecked'] as string[]).includes('calendar'), 'a configured source not read is reported');
});

test('knowledge first: a knowledge read starts before the selector returns', async () => {
  const order: string[] = [];
  const gate = deferred<void>();
  const selector: ResearchSelector = { async select() { order.push('selector-start'); await gate.promise; return { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } }; } };
  const h = harness({ selector, execute: async subs => { order.push(...subs.map(sub => sub.name)); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const running = runResearch(h.deps, { action: 'start', question: 'what did I decide about the release' }, new AbortController().signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(order.includes('search_knowledge'), 'the prime source read starts immediately');
  assert.equal(order.includes('selector-start'), true, 'the selector runs in parallel with the knowledge read');
  assert.ok(order.indexOf('search_knowledge') < order.indexOf('selector-start'), 'the knowledge read starts before the selector');
  gate.resolve();
  await running;
});

test('knowledge findings rank first in the reply', async () => {
  const selector = selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'mail_search', query: 'in:inbox newer_than:2d' }, { kind: 'knowledge_search' }], pUseful: { mail_search: 0.9, knowledge_search: 0.9 } });
  const h = harness({ selector, execute: async subs => subs.map(call => sub(call.name, call.name === 'gmail_list' ? '- Subject | Sender | Mon | body [id m1]' : '### Insight (PATTERN) [id 1]\nbody', true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did the team decide' }, new AbortController().signal);
  const findings = reply['findings'] as { source: string }[];
  assert.equal(findings[0]?.source, 'knowledge', 'the prime source leads the findings');
});

test('an empty-but-successful read is a search that matched nothing, never an unreachable source', async () => {
  const selector = selectorOf({ questionClass: 'quick_fact', actions: [{ kind: 'mail_search', query: 'from:landlord invoice' }], pUseful: { mail_search: 1 } });
  const h = harness({ selector, executeText: '' });
  const reply = await runResearch(h.deps, { action: 'start', question: 'would you check my mail for the landlord invoice' }, new AbortController().signal);
  const note = String(reply['note'] ?? '');
  assert.equal(note.includes('could not reach'), false, 'a search that matched nothing is not an outage');
  assert.match(note, /I searched your mail for "invoice" and found nothing matching/, 'the model gets a line it can voice');
  assert.equal((reply['unchecked'] as string[]).includes('mail'), false, 'the source answered, so it is checked');
  assert.equal(reply['status'], 'answered', 'a search that matched nothing still answered the question');
});

test('an identical duplicate read in one run is executed once', async () => {
  const twice = selectorOf({ questionClass: 'quick_fact', actions: [{ kind: 'mail_search', query: 'newer_than:2d' }, { kind: 'mail_search', query: 'newer_than:2d' }], pUseful: { mail_search: 0.9 } });
  const h = harness({ selector: twice, executeText: '' });
  await runResearch(h.deps, { action: 'start', question: 'anything new in the mail' }, new AbortController().signal);
  const mailReads = h.executed.filter(call => call.name === 'gmail_list');
  assert.equal(mailReads.length, 1, 'the same mail read is issued once');
});

test('the brief fan-out is credited to every source it read and its findings reach the answer', async () => {
  const selector = selectorOf({ questionClass: 'cross_source', actions: [{ kind: 'brief' }], pUseful: { brief: 1 } });
  const h = harness({ selector, execute: async subs => subs.map(call => sub(call.name,
    call.name === 'gcal_list' ? MERGED_CALENDAR
      : call.name === 'gmail_list' ? '- Invoice | Landlord | Mon | due soon [id m1]'
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

function maxGapMs(stamps: readonly number[]): number {
  return stamps.slice(1).reduce((worst, stamp, index) => Math.max(worst, stamp - stamps[index]!), 0);
}

test('a long read still sends the model a progress line every three seconds, and none is left behind', async () => {
  const clock = fakeClock();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ selector: knowledge, now: clock.now, schedule: clock.schedule, execute: async subs => { await gate; return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
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
  assert.equal(clock.pending(), 0, 'the heartbeat is stopped when the run ends');
});

test('when the selector deadline passes the fallback starts at once and the model already has an update', async () => {
  const clock = fakeClock();
  let abortSelector!: (error: Error) => void;
  const selector: ResearchSelector = { select: () => new Promise<SelectorOutput>((_, reject) => { abortSelector = reject; }) };
  const readAt: { tool: string; at: number }[] = [];
  const h = harness({ selector, now: clock.now, schedule: clock.schedule, execute: async subs => { for (const call of subs) readAt.push({ tool: call.name, at: clock.now() }); return subs.map(call => sub(call.name, 'evidence', true, call.key)); } });
  const running = runResearch(h.deps, { action: 'start', question: 'what is on my calendar today' }, new AbortController().signal);
  await settle();
  clock.advance(3_000); await settle();
  clock.advance(RESEARCH.selectorDeadlineMs); await settle();
  abortSelector(new Error('aborted'));
  await running;
  assert.equal(h.logs[0]!.fallbackUsed, true, 'the deadline falls back to the fixed recipe');
  const fallbackReads = readAt.filter(entry => entry.tool === 'gcal_list');
  assert.ok(fallbackReads.length > 0, 'the fallback reads the calendar');
  assert.ok(fallbackReads.every(entry => entry.at === RESEARCH.selectorDeadlineMs), `the fallback read starts the moment the selector gives up: ${JSON.stringify(readAt)}`);
  const stamps = h.progress.map(entry => entry.elapsedMs);
  assert.ok(stamps.some(stamp => stamp <= 3_000), 'a progress line inside three seconds of the call');
  assert.ok(maxGapMs(stamps) <= 8_000, `no model-facing gap over eight seconds: ${maxGapMs(stamps)}`);
});

// Contract RD: the owner must never wait more than six seconds in silence while a lookup runs.
test('deadAirMs measures the longest silence the model hears, never the whole run', async () => {
  const clock = fakeClock();
  const gate = deferred<void>();
  const slowSelector: ResearchSelector = { select: async () => { await gate.promise; return { questionClass: 'quick_fact', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } }; } };
  const h = harness({ selector: slowSelector, now: clock.now, schedule: clock.schedule });
  const running = runResearch(h.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  await settle();
  clock.advance(3_000); await settle();
  clock.advance(6_000); await settle();
  gate.resolve();
  await running;
  const log = h.logs[0]!;
  assert.ok(log.elapsedMs >= 6_000, `the run really took six seconds: ${log.elapsedMs}`);
  assert.ok(log.deadAirMs <= 3_000, `the worst silence is one beat, not the run: ${log.deadAirMs}`);
});

test('a source that outlives the per-source deadline is cut, and the reply is an honest partial', async () => {
  const clock = fakeClock();
  const selector = selectorOf({ questionClass: 'quick_fact', actions: [{ kind: 'mail_search' }], pUseful: { mail_search: 0.9 } });
  const h = harness({ selector, now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'gmail_list')) return await new Promise<IntentSubResult[]>((_, reject) => { const cut = (): void => reject(new Error('cut')); if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true }); });
    return subs.map(call => sub(call.name, 'evidence', true, call.key));
  } });
  const running = runResearch(h.deps, { action: 'start', question: 'anything from the bank' }, new AbortController().signal);
  await settle();
  clock.advance(RESEARCH.sourceDeadlineMs); await settle();
  const reply = await running;
  assert.ok((reply['unchecked'] as string[]).includes('mail'), 'the source the cut abandoned is named as unchecked');
  const log = h.logs[0]!;
  assert.ok(log.elapsedMs <= RESEARCH.sourceDeadlineMs + 1_000, `one slow source never owns the turn: ${log.elapsedMs}`);
  assert.equal(log.sources.find(entry => entry.kind === 'mail')?.disposition, 'cut');
  assert.notEqual(log.status, 'answered', 'a cut read is a partial answer, never an answered one');
});

test('the turn returns as soon as the first sufficient source answers, without waiting for the rest', async () => {
  const clock = fakeClock();
  const selector = selectorOf({ questionClass: 'quick_fact', actions: [{ kind: 'knowledge_search' }, { kind: 'mail_search' }], pUseful: { knowledge_search: 0.9, mail_search: 0.9 } });
  const h = harness({ selector, now: clock.now, schedule: clock.schedule, execute: async (subs, signal) => {
    if (subs.some(call => call.name === 'gmail_list')) return await new Promise<IntentSubResult[]>((_, reject) => { const cut = (): void => reject(new Error('cut')); if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true }); });
    return subs.map(call => sub(call.name, 'evidence', true, call.key));
  } });
  const running = runResearch(h.deps, { action: 'start', question: 'what did the team decide' }, new AbortController().signal);
  const heard = await Promise.race([running.then(() => true), settle().then(() => false)]);
  assert.equal(heard, true, 'the reply comes back while the slow source is still reading');
  const reply = await running;
  assert.ok((reply['unchecked'] as string[]).includes('mail'), 'the source left behind is named, never silently dropped');
  assert.equal(h.logs[0]!.elapsedMs, 0, 'the answer was ready before the slow source could spend any deadline');
});

// Reviewer T1: the early-return winner keeps its own second hop and its source stays credited.
test('the first sufficient source keeps its own second hop and the read stays answered', async () => {
  const selector = selectorOf({ questionClass: 'quick_fact', actions: [{ kind: 'knowledge_search' }, { kind: 'mail_search' }], pUseful: { knowledge_search: 0.9, mail_search: 0.9 } });
  const read: string[] = [];
  const h = harness({ selector, execute: async (subs, signal) => {
    for (const call of subs) read.push(call.name);
    if (subs.some(call => call.name === 'gmail_list')) {
      // The slow source never answers: it is the one the early return may abandon.
      return await new Promise<IntentSubResult[]>((_, reject) => { const stop = (): void => reject(new Error('abandoned')); if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); });
    }
    return subs.map(call => sub(call.name, call.name === 'get_insight' ? 'the body' : 'the release is green [id 7]', true, call.key));
  } });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did the team decide' }, new AbortController().signal);
  assert.ok(read.includes('get_insight'), 'the winner opened the insight it found');
  assert.equal(h.logs[0]!.sources.find(entry => entry.kind === 'knowledge')?.disposition, 'completed');
  assert.equal(h.logs[0]!.status, 'answered', 'a read that answered is not a partial answer');
  assert.ok((reply['findings'] as unknown[]).length > 0);
});

// Reviewer B5 replacement: the owner hears a reply inside six seconds because the call itself returns.
test('a start call returns inside six seconds even when its first read never answers', async () => {
  const clock = fakeClock();
  const selector = selectorOf({ questionClass: 'quick_fact', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 0.9 } });
  const h = harness({ selector, now: clock.now, schedule: clock.schedule, execute: async (_subs, signal) => await new Promise<IntentSubResult[]>((_, reject) => { const cut = (): void => reject(new Error('cut')); if (signal.aborted) cut(); else signal.addEventListener('abort', cut, { once: true }); }) });
  const running = runResearch(h.deps, { action: 'start', question: 'what is the release status' }, new AbortController().signal);
  await settle();
  clock.advance(RESEARCH.answerWithinMs); await settle();
  const reply = await Promise.race([running, settle().then(() => null)]);
  assert.notEqual(reply, null, 'the call came back instead of waiting for the read');
  assert.ok(h.logs[0]!.elapsedMs <= RESEARCH.answerWithinMs + 1_000, `the answer lands inside the bound: ${h.logs[0]!.elapsedMs}`);
});
