import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOOKUP_SOURCES, MAX_LOOKUPS, RESEARCH, ResearchLedger, calendarWindowOf, lookupBound, normalizeLookups, researchDeclaration, runResearch,
  validateResearch,
  type ResearchDeps, type ResearchProgress, type ResearchRunLog, type ResearchSourceLog, type ResearchRoutedLog, type ResearchSubcallLog, type ResearchTimer, type SourceKind,
} from '../tools/research.js';
import { declarationsFor } from '../tools/declarations.js';
import { safeEvent } from '../host/log.js';
import type { ToolDefinition } from '../adapters/model/types.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const CONFIGURED: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];

/** The shaped text each connector really returns, so a fixture answer becomes findings. */
const EVIDENCE: Record<string, string> = {
  search_knowledge: '### Release 3k scope (decision | 2026-10-17) [id 123]',
  gmail_list: '- Release notes | from: Ana | date: 2026-10-16 [id m1]',
  mattermost_search: '- the release thread, from Ana',
  mattermost_attention: '- one question from Ana is waiting on him',
  search_mongoose: '- Plantix organisation chart',
};

function sub(name: string, text = EVIDENCE[name] ?? 'evidence', ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

interface Harness {
  deps: ResearchDeps;
  routed: ResearchRoutedLog[];
  sources: ResearchSourceLog[];
  logs: ResearchRunLog[];
  subcalls: ResearchSubcallLog[];
  executed: string[];
  progress: ResearchProgress[];
  selectorCalls: () => number;
}

function harness(opts: {
  now?: () => number;
  configured?: readonly SourceKind[];
  execute?: ResearchDeps['execute'];
  memory?: (query: string) => { lines: string[]; text: string; total: number };
  schedule?: ResearchDeps['schedule'];
  selected?: () => void;
} = {}): Harness {
  const routed: ResearchRoutedLog[] = [];
  const executed: string[] = [];
  const sources: ResearchSourceLog[] = [];
  const logs: ResearchRunLog[] = [];
  const subcalls: ResearchSubcallLog[] = [];
  const progress: ResearchProgress[] = [];
  let selectorCalls = 0;
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
    configured: opts.configured ?? CONFIGURED,
    execute: opts.execute ?? (async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push(call.name);
      return subs.map(call => sub(call.name, EVIDENCE[call.name] ?? 'evidence', true, call.key));
    }),
    emit: event => { progress.push(event); },
    log: event => { logs.push(event); },
    logRouted: event => routed.push(event),
    logSource: event => sources.push(event),
    logSubcall: event => { subcalls.push(event); },
    // A selector that answers, so "it was not called" is a real observation rather than a refusal.
    selector: { select: async () => { selectorCalls += 1; opts.selected?.(); return { questionClass: 'cross_source' as const, actions: [], pUseful: {} }; } },
    ledger: new ResearchLedger(),
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
  return { deps, routed, sources, logs, subcalls, executed, progress, selectorCalls: () => selectorCalls };
}

test('a routed start skips the selector and reads every named layer at once', async () => {
  let clock = 0;
  const entered: string[] = [];
  const gate = deferred<void>();
  const h = harness({
    now: () => clock,
    execute: async (subs: readonly IntentSubCall[]) => {
      entered.push(subs[0]!.name);
      if (entered.length === 2) gate.resolve();
      else await gate.promise;
      clock += 1_000;
      return subs.map(call => sub(call.name, EVIDENCE[call.name] ?? 'evidence', true, call.key));
    },
  });
  const reply = await Promise.race([
    runResearch(h.deps, {
      action: 'start', question: 'where does the project stand and what is waiting on me',
      lookups: [{ source: 'knowledge', query: 'project status' }, { source: 'mail', query: 'from:plantix' }],
    }, new AbortController().signal),
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('lookups did not overlap')), 1_000).unref(); }),
  ]);
  assert.equal(h.selectorCalls(), 0, 'the selector is never called on a routed start');
  assert.deepEqual(entered, ['search_knowledge', 'gmail_list'], 'both lookups were dispatched before either was awaited');
  assert.equal(reply['status'], 'answered');
  assert.deepEqual(reply['sources'], { knowledge: 'ok', mail: 'ok' }, 'one combined reply with per-source status');
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.deepEqual(findings.map(finding => finding.source).sort(), ['knowledge', 'mail']);
});

test('the routed receipt names the sources, the count and per-source ms, never a query', async () => {
  let clock = 0;
  const h = harness({ now: () => { clock += 250; return clock; } });
  await runResearch(h.deps, {
    action: 'start', question: 'what did we decide about the release',
    lookups: [{ source: 'knowledge', query: 'release 3k decision' }, { source: 'company', query: 'who reports to whom' }],
  }, new AbortController().signal);
  assert.equal(h.routed.length, 1);
  const receipt = h.routed[0]!;
  assert.deepEqual(receipt.sources, ['knowledge', 'company']);
  assert.equal(receipt.lookups, 2);
  assert.equal(receipt.ms.length, 2);
  assert.ok(receipt.ms.every(ms => Number.isInteger(ms) && ms >= 0));
  assert.deepEqual(receipt.outcomes, ['ok', 'ok']);
  assert.doesNotMatch(JSON.stringify(receipt), /release 3k decision|reports to whom/, 'no query text leaves in the receipt');
  assert.deepEqual(safeEvent(receipt), receipt, 'the host log admits the routed receipt unchanged');
});

test('a routed lookup that fails is isolated and the other layers still answer', async () => {
  const h = harness({
    execute: async (subs: readonly IntentSubCall[]) => {
      if (subs[0]!.name === 'gmail_list') throw Error('mail_down');
      return subs.map(call => sub(call.name, EVIDENCE[call.name] ?? 'evidence', true, call.key));
    },
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did he send me about the release',
    lookups: [{ source: 'knowledge', query: 'release' }, { source: 'mail', query: 'release' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { knowledge: 'ok', mail: 'failed' });
  const findings = reply['findings'] as { source: string }[];
  assert.deepEqual(findings.map(finding => finding.source), ['knowledge'], 'the failed source contributes no finding');
  assert.match(String(reply['note']), /could not reach mail/);
  assert.equal(reply['status'], 'answered', 'one good layer answers the call');
});

test('a source the session did not configure is reported unavailable, never dispatched', async () => {
  const h = harness({ configured: ['knowledge'] });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'who is on my team',
    lookups: [{ source: 'company', query: 'team structure' }, { source: 'chat', query: 'team' }],
  }, new AbortController().signal);
  assert.deepEqual(h.executed, [], 'nothing is dispatched for an unconfigured source');
  assert.deepEqual(reply['sources'], { company: 'unavailable', chat: 'unavailable' });
  assert.deepEqual(reply['findings'], []);
  assert.equal(reply['status'], 'partial');
  assert.match(String(reply['note']), /team chat: unavailable \(not configured\); company knowledge: unavailable \(not configured\)/, 'each unread source names itself and its reason, in plain words');
});

// --- #1020: a source that could not be read names itself, and why ---------------------------------

test('#1020: a timed-out source is named as timed out in seconds, beside the source that answered', async () => {
  const h = harness({ configured: ['knowledge', 'chat'] });
  const deps: ResearchDeps = { ...h.deps, unavailableNow: () => [{ source: 'chat', reason: 'timeout' }] };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what is waiting on me', lookups: [{ source: 'chat', query: 'release freeze' }, { source: 'knowledge', query: 'release' }],
  }, new AbortController().signal);
  assert.match(String(reply['note']), /team chat: not read \(timed out after 12 s\)/, 'the timeout is spoken as a timeout, with its budget');
  assert.match(String(reply['note']), /could not reach team chat/, 'and the voiceable clause about it is still there');
  assert.ok((reply['findings'] as { source: string }[]).some(finding => finding.source === 'knowledge'), 'the healthy source still answers in the same reply');
});

test('her own memory answers a memory lookup, and is reported unavailable without a reader', async () => {
  const h = harness({
    memory: query => ({
      lines: [`2026-10-14 entry: he asked me to remember the dentist on Friday for ${query}`],
      text: 'ignored',
      total: 1,
    }),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { memory: 'ok' });
  const pages = reply['historyPages'] as { hits: { snippet: string }[] }[];
  assert.equal(pages.length, 1);
  assert.match(pages[0]!.hits[0]!.snippet, /dentist on Friday/);

  const bare = harness();
  const empty = await runResearch(bare.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }],
  }, new AbortController().signal);
  assert.deepEqual(empty['sources'], { memory: 'unavailable' });
  assert.deepEqual(bare.executed, [], 'memory never becomes a connector read');
});

test('an empty memory reader reports empty rather than failed', async () => {
  const h = harness({ memory: () => ({ lines: [], text: '', total: 0 }) });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { memory: 'empty' });
});

test('duplicates collapse and a call carries at most four lookups', () => {
  const lookups = normalizeLookups([
    { source: 'knowledge', query: 'release' },
    { source: 'Knowledge', query: ' RELEASE ' },
    { source: 'mail', query: 'release' },
    { source: 'chat', query: 'release' },
    { source: 'company', query: 'release' },
    { source: 'memory', query: 'release' },
  ]);
  assert.equal(lookups.length, MAX_LOOKUPS);
  assert.deepEqual(lookups.map(lookup => lookup.source), ['knowledge', 'mail', 'chat', 'company']);
  assert.deepEqual(normalizeLookups([{ source: 'nonsense', query: 'x' }, { source: 'mail', query: '  ' }]), []);
  assert.deepEqual(normalizeLookups(undefined), []);
  assert.equal(MAX_LOOKUPS, 4);
});

test('a lookup query is capped like a selector query', () => {
  const [lookup] = normalizeLookups([{ source: 'mail', query: 'x'.repeat(RESEARCH.queryLimitChars + 40) }]);
  assert.equal(lookup!.query.length, RESEARCH.queryLimitChars);
});

test('calendar lookups carry a day or a named window', () => {
  assert.equal(calendarWindowOf('tomorrow'), 'tomorrow');
  assert.equal(calendarWindowOf('week'), 'week');
  assert.equal(calendarWindowOf('2026-10-17'), '2026-10-17');
  assert.equal(calendarWindowOf('meetings on 2026-10-17'), '2026-10-17');
  assert.equal(calendarWindowOf('anything about the release'), 'today');
});

test('the declared lookups key is valid on start only and matches its validator', () => {
  assert.equal(validateResearch({ action: 'start', question: 'q' }), true, 'unrouted start stays valid');
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'memory', query: 'x' }] }), true);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [] }), true);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'mail' }] }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'nonsense', query: 'x' }] }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'mail', query: 'x', extra: 1 }] }), false);
  assert.equal(validateResearch({ action: 'continue', researchId: 'r', lookups: [{ source: 'mail', query: 'x' }] }), false,
    'lookups belong to a start');
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: 'mail' }), false);
});

test('both provider declarations carry lookups, and the Gemini dialect flattens it', () => {
  const declaration = researchDeclaration();
  const properties = declaration.parameters['properties'] as Record<string, { type?: unknown; items?: { properties?: Record<string, { enum?: unknown[] }> } }>;
  const lookups = properties['lookups']!;
  assert.equal(lookups.type, 'array', 'the OpenAI JSON schema keeps the array of objects');
  assert.deepEqual(lookups.items!.properties!['source']!.enum, [...LOOKUP_SOURCES]);
  assert.match(String(declaration.parameters['properties'] && (lookups as unknown as { description: string }).description),
    /memory: .*knowledge: .*company: .*calendar/m, 'the description names the layers one line each');
  const registry: ToolDefinition[] = [{
    name: declaration.name, description: declaration.description, parameters: declaration.parameters, guidance: declaration.guidance,
    effect: 'read', accountId: 'fixture', resourceId: 'fixture', validate: declaration.validate, execute: async () => ({ status: 'failed' as const }),
  }];
  const { declarations } = declarationsFor(registry);
  const gemini = declarations[0]!.parameters['properties'] as Record<string, { type?: unknown; description?: string }>;
  assert.equal(gemini['lookups']!.type, 'STRING', 'the flattened dialect presents lookups as one string');
  assert.match(String(gemini['lookups']!.description), /Original schema: .*"source"/, 'the original schema travels in the description');
});

test('an unrouted start keeps the selector path and never touches memory', async () => {
  const h = harness({ memory: () => { throw Error('memory must not be read'); } });
  await runResearch(h.deps, { action: 'start', question: 'where does the project stand', lookups: [] }, new AbortController().signal);
  assert.equal(h.selectorCalls(), 1, 'no lookups means today\'s selector');
  assert.ok(h.executed.includes('search_knowledge'), 'the knowledge prime read is dispatched, exactly as before');
  assert.ok(!h.executed.includes('mattermost_search'), 'and nothing the selector did not choose');
  assert.deepEqual(h.routed, [], 'no routed receipt without lookups');
});

// --- N3: the calendar read, the cut-short outcome and same-source coalescing ---------------------

const CALENDAR_EVENT = '- 2026-10-16T09:00:00+05:30, Standup, Room 1 | Primary [id e1]';
const CALENDAR_LIST = '- Work [work@example.com]\n- Home [home]\n- Family [family]';

/** The calendar layer's real answer: one primary-calendar event read plus the calendar list. */
function calendarExecute(clock: { value: number }, slowMs = 0): { execute: ResearchDeps['execute']; calls: () => IntentSubCall[][]; live: () => boolean[] } {
  const batches: IntentSubCall[][] = [];
  const live: boolean[] = [];
  const execute: ResearchDeps['execute'] = async (subs: readonly IntentSubCall[], signal: AbortSignal) => {
    batches.push(subs.map(call => ({ ...call })));
    live.push(!signal.aborted);
    clock.value += slowMs;
    return subs.map(call => call.name === 'gcal_list'
      ? sub(call.name, CALENDAR_EVENT, true, call.key)
      : sub(call.name, CALENDAR_LIST, true, call.key));
  };
  return { execute, calls: () => batches, live: () => live };
}

test('a routed calendar read is one bounded primary-calendar call that names what it did not read', async () => {
  const clock = { value: 0 };
  const calendar = calendarExecute(clock);
  const h = harness({ now: () => clock.value, execute: calendar.execute });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what is on my calendar', lookups: [{ source: 'calendar', query: 'what is on next week' }],
  }, new AbortController().signal);
  assert.equal(calendar.calls().length, 1, 'one execution for the calendar layer');
  const [read, listed] = calendar.calls()[0]!;
  assert.equal(read!.name, 'gcal_list');
  assert.equal(read!.args['calendarId'], 'primary', 'the primary calendar only, never the 22-calendar merge');
  assert.equal(listed!.name, 'gcal_calendars', 'the list rides along only to say what was not read');
  const findings = (reply['findings'] ?? []) as { source: string; text: string }[];
  const found = findings.find(finding => finding.source === 'calendar');
  assert.ok(found !== undefined, 'the calendar layer answers');
  assert.match(found!.text, /Standup/, 'with a real event line');
  assert.match(found!.text, /not read: 2 other calendars/, 'and it says the other calendars were not read');
});

test('a slow calendar read still settles ok with a line inside the run deadline, never empty', async () => {
  const clock = { value: 0 };
  const calendar = calendarExecute(clock, 6_000);
  const receipts: ResearchSourceLog[] = [];
  const h = harness({ now: () => clock.value, execute: calendar.execute });
  const deps: ResearchDeps = { ...h.deps, logSource: event => receipts.push(event) };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what is on my calendar', lookups: [{ source: 'calendar', query: 'what is on this week' }],
  }, new AbortController().signal);
  assert.deepEqual(receipts.map(event => event.outcome), ['ok'], 'a 6 s read is ok, never empty');
  assert.ok(receipts[0]!.ms < RESEARCH.startDeadlineMs, `the read settles at ${receipts[0]!.ms} ms, inside ${RESEARCH.startDeadlineMs} ms`);
  const findings = (reply['findings'] ?? []) as { source: string; text: string }[];
  assert.ok(findings.some(finding => finding.source === 'calendar' && finding.text.includes('Standup')), 'the owner hears the event');
});

test('a read cut by the deadline reports timeout and the reply says so, never nothing matched', async () => {
  const controller = new AbortController();
  const h = harness({
    execute: async (subs: readonly IntentSubCall[]) => {
      controller.abort();
      return subs.map(call => sub(call.name, '', false, call.key));
    },
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did we decide', lookups: [{ source: 'knowledge', query: 'release decision' }],
  }, controller.signal);
  assert.deepEqual(h.routed[0]!.outcomes, ['timeout'], 'a cut read is its own outcome, never empty');
  assert.deepEqual(h.sources.map(event => event.outcome), ['timeout'], 'and the per-lookup receipt says so');
  assert.match(String(reply['note']), /cut short/i);
  assert.doesNotMatch(String(reply['note']), /found nothing matching/i, 'nothing matched is never said about a cut read');
});

test('a dispatch that throws without a deadline stays failed, never timeout', async () => {
  const h = harness({ execute: async () => { throw new Error('connector down'); } });
  await runResearch(h.deps, {
    action: 'start', question: 'what did we decide', lookups: [{ source: 'knowledge', query: 'release decision' }],
  }, new AbortController().signal);
  assert.deepEqual(h.routed[0]!.outcomes, ['failed']);
});

test('two lookups on one source coalesce into one execution, each reporting its own outcome', async () => {
  const batches: string[][] = [];
  const h = harness({
    execute: async (subs: readonly IntentSubCall[]) => {
      batches.push(subs.map(call => call.name));
      return subs.map((call, index) => sub(call.name, index === 0 ? EVIDENCE['search_knowledge']! : '', true, call.key));
    },
  });
  await runResearch(h.deps, {
    action: 'start', question: 'what did we decide about the release',
    lookups: [{ source: 'knowledge', query: 'release decision' }, { source: 'knowledge', query: 'who owns the release' }],
  }, new AbortController().signal);
  assert.equal(batches.length, 1, 'one knowledge execution for both queries, so neither starves the other');
  assert.equal(batches[0]!.length, 2, 'carrying both queries');
  assert.deepEqual(h.sources.map(event => event.source), ['knowledge', 'knowledge']);
  assert.deepEqual(h.sources.map(event => event.outcome), ['ok', 'empty'], 'each lookup keeps its own outcome');
});

test('the per-lookup receipt carries source, outcome and ms and never a query', async () => {
  const h = harness({ now: () => 5 });
  await runResearch(h.deps, {
    action: 'start', question: 'where does the project stand', lookups: [{ source: 'knowledge', query: 'secret release plan' }],
  }, new AbortController().signal);
  assert.equal(h.sources.length, 1);
  const receipt = h.sources[0]!;
  assert.deepEqual(Object.keys(receipt).sort(), ['coalesced', 'deadlineMs', 'event', 'knowledge', 'ms', 'outcome', 'researchId', 'source'], 'the receipt names the deadline the read was given, the batch it shared and the body window it asked for');
  assert.equal(receipt.coalesced, 1, 'a lone lookup is a batch of one');
  assert.equal(receipt.source, 'knowledge');
  assert.equal(receipt.outcome, 'ok');
  assert.deepEqual(safeEvent(receipt), receipt, 'the host log admits a knowledge receipt, its window included');
  assert.equal(JSON.stringify(receipt).includes('secret release plan'), false, 'never the query text');
});

// --- N3 review F1/F2: the calendar budget and the batch the router hands it -----------------------

test('the batch bound grows with the lookup count for every source except the calendar', () => {
  assert.equal(lookupBound('calendar', 1, 15_000), RESEARCH.sourceDeadline.calendar);
  assert.equal(lookupBound('calendar', 2, 15_000), RESEARCH.sourceDeadline.calendar, 'two windows never double the calendar budget');
  assert.ok(lookupBound('calendar', 2, 15_000) < RESEARCH.startDeadlineMs, 'and it stays inside the start deadline, never equal to it');
  assert.equal(lookupBound('knowledge', 1, 15_000), RESEARCH.sourceDeadline.knowledge);
  assert.equal(lookupBound('knowledge', 2, 30_000), RESEARCH.sourceDeadline.knowledge * 2, 'a coalesced batch buys the time each lookup needs');
  assert.equal(lookupBound('knowledge', 2, 15_000), 15_000, 'never past what the run has left');
  assert.equal(lookupBound('knowledge', 4, 9_000), 9_000, 'never past what the run has left');
});

test('the calendar read is handed a live signal and settles well inside the start deadline', async () => {
  const clock = { value: 0 };
  const calendar = calendarExecute(clock, 6_000);
  const h = harness({ now: () => clock.value, execute: calendar.execute });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what is on my calendar', lookups: [{ source: 'calendar', query: 'what is on this week' }],
  }, new AbortController().signal);
  assert.deepEqual(calendar.live(), [true], 'the batch was not already aborted when the read started');
  assert.ok(RESEARCH.sourceDeadline.calendar < RESEARCH.startDeadlineMs, 'the bound itself is inside the run deadline');
  const findings = (reply['findings'] ?? []) as { source: string; text: string }[];
  assert.ok(findings.some(finding => finding.source === 'calendar'), 'and the read answered');
});

test('two calendar windows share one calendar-list read and one budget, each reporting its own outcome', async () => {
  const clock = { value: 0 };
  const calendar = calendarExecute(clock);
  const h = harness({ now: () => clock.value, execute: calendar.execute });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what is on my calendar',
    lookups: [{ source: 'calendar', query: 'today' }, { source: 'calendar', query: 'next week' }],
  }, new AbortController().signal);
  assert.equal(calendar.calls().length, 1, 'one execution for both windows');
  const names = calendar.calls()[0]!.map(call => call.name);
  assert.deepEqual(names, ['gcal_list', 'gcal_calendars', 'gcal_list'], 'the calendar list is dispatched once for both windows');
  assert.deepEqual(h.sources.map(event => event.source), ['calendar', 'calendar']);
  assert.deepEqual(h.sources.map(event => event.outcome), ['ok', 'ok']);
  const windows = calendar.calls()[0]!.filter(call => call.name === 'gcal_list').map(call => `${String(call.args['timeMin'])}|${String(call.args['timeMax'])}`);
  assert.equal(new Set(windows).size, 2, 'and each window is its own read');
  assert.ok(lookupBound('calendar', 2, RESEARCH.startDeadlineMs) === RESEARCH.sourceDeadline.calendar, 'two windows get one read budget, never two');
  const findings = (reply['findings'] ?? []) as { source: string; text: string }[];
  assert.ok(findings.some(finding => finding.source === 'calendar'), 'the calendar layer answers for both windows');
});

// --- P5: a source that cannot serve a read keeps its reason -------------------------------------

test('P5: a dead connector is reported unavailable with its reason, never empty and never a timeout', async () => {
  const h = harness({ configured: ['knowledge', 'chat'] });
  const receipts: ResearchSourceLog[] = [];
  const deps: ResearchDeps = {
    ...h.deps,
    unavailableNow: () => [{ source: 'chat', reason: 'connector_failure mattermost stage=credential' }],
    logSource: event => receipts.push(event),
  };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what is waiting on me', lookups: [{ source: 'chat', query: 'release freeze' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { chat: 'unavailable' }, 'unavailable is its own outcome, never empty');
  assert.deepEqual(reply['unavailable'], { chat: 'connector_failure mattermost stage=credential' }, 'and the reply carries the reason the connector gave');
  assert.deepEqual(receipts.map(event => [event.source, event.outcome, event.deadlineMs]), [['chat', 'unavailable', 12_000]]);
  assert.deepEqual(h.executed, [], 'the dead connector is never asked');
});

test('P5-R5: a routed read that returns a failure is failed, never empty', async () => {
  const receipts: ResearchSourceLog[] = [];
  const failed = (key: string, name: string): IntentSubResult =>
    ({ key, name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'connector_failure' });
  const h = harness({ configured: ['knowledge'], execute: async subs => subs.map(call => failed(call.key, call.name)) });
  const deps: ResearchDeps = { ...h.deps, logSource: event => receipts.push(event) };
  const reply = await runResearch(deps, {
    action: 'start', question: 'where does the project stand', lookups: [{ source: 'knowledge', query: 'project status' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { knowledge: 'failed' }, 'a returned failure is its own outcome, never empty');
  assert.deepEqual(receipts.map(event => [event.source, event.outcome]), [['knowledge', 'failed']]);
  const note = String(reply['note'] ?? '');
  assert.equal(note.includes('found nothing'), false, 'an errored read is never voiced as an empty search');
  assert.match(note, /could not reach/, 'and the reply says the source could not be reached');
});

// --- Q5-R1: a named entry is read whole, never searched for again ------------------------------

test('Q5-R1: a lookup that names an insight reads it by id and returns the whole body, never a second search', async () => {
  const body = `${'Deep body sentence. '.repeat(400)}End of the entry.`;
  const executed: string[] = [];
  const h = harness({ execute: async (subs: readonly IntentSubCall[]) => {
    for (const call of subs) executed.push(call.name);
    return subs.map(call => sub(call.name, call.name === 'get_insight' ? `### Release 3p scope [id 412]\n${body}` : 'evidence', true, call.key));
  } });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'go deep on insight 412, the release 3p scope',
    lookups: [{ source: 'knowledge', query: 'insight 412' }],
  }, new AbortController().signal);
  assert.deepEqual(executed, ['get_insight'], 'one read call by id, and no search at all');
  const findings = reply['findings'] as { text: string }[];
  assert.ok(findings.length > 0, 'the read reaches the reply');
  assert.ok(findings[0]!.text.includes('End of the entry.'), 'the whole body is returned, up to the connector body cap');
  assert.ok(findings[0]!.text.length > RESEARCH.replyLimitChars, `a read is not trimmed to the search reply budget (${findings[0]!.text.length} chars)`);
});

// --- 3r R1: honest empty reads, model-facing progress, metadata-only lookup receipts -------------

test('a mail read that matched nothing is searched and nothing matched, never unreachable', async () => {
  const h = harness({ execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name, '', true, call.key)) });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'any mail about invoices', lookups: [{ source: 'mail', query: 'subject:invoice' }],
  }, new AbortController().signal);
  assert.deepEqual(h.sources.map(event => event.outcome), ['empty'], 'a successful read with no match is empty, never failed');
  const note = String(reply['note'] ?? '');
  assert.match(note, /searched your mail/i, 'the reply names the source it searched');
  assert.match(note, /found nothing matching/i, 'and says that nothing matched');
  assert.doesNotMatch(note, /could not reach/i, 'a connector that answered is never called unreachable');
});

test('a slow routed read tells the model it is alive at most five seconds apart', async () => {
  const clock = { value: 0 };
  const timers: (() => void)[] = [];
  const schedule: ResearchTimer = (callback: () => void) => {
    timers.push(callback);
    return { unref: () => {}, cancel: () => { const at = timers.indexOf(callback); if (at >= 0) timers.splice(at, 1); } };
  };
  const fire = (): number => { const due = timers.splice(0, timers.length); for (const callback of due) callback(); return due.length; };
  const gate = deferred<void>();
  const h = harness({
    now: () => clock.value,
    schedule,
    execute: async (subs: readonly IntentSubCall[]) => { await gate.promise; return subs.map(call => sub(call.name, EVIDENCE[call.name] ?? 'evidence', true, call.key)); },
  });
  const run = runResearch(h.deps, {
    action: 'start', question: 'what is waiting on me', lookups: [{ source: 'mail', query: 'is:unread' }],
  }, new AbortController().signal);
  // Let the routed read reach its first await, then walk the fake clock past two progress windows.
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  clock.value = 3_000;
  assert.ok(fire() > 0, 'the routed read schedules a progress beat instead of going silent');
  clock.value = 8_000;
  fire();
  gate.resolve();
  await run;
  const beats = h.progress.map(event => event.elapsedMs).filter(ms => ms > 0);
  assert.ok(beats.length >= 2, `the model hears progress while the sources run (${beats.length} beats)`);
  const gaps = [0, ...beats].map((ms, index, all) => ms - (all[index - 1] ?? 0));
  assert.ok(gaps.every(gap => gap <= 5_000), `no silence longer than five seconds (${gaps.join(', ')})`);
});

test('every lookup receipt carries its coalesced count, never a query or a result', async () => {
  const h = harness();
  await runResearch(h.deps, {
    action: 'start', question: 'anything from Ana or about the invoice',
    lookups: [{ source: 'mail', query: 'from:ana' }, { source: 'mail', query: 'subject:invoice' }],
  }, new AbortController().signal);
  assert.equal(h.sources.length, 2, 'one receipt per lookup');
  // Read as a record so the base, whose receipt type carries no count yet, runs this test red at runtime.
  const coalesced = h.sources.map(event => (event as unknown as Record<string, unknown>)['coalesced']);
  assert.deepEqual(coalesced, [2, 2], 'both receipts name the batch they shared');
  const wire = JSON.stringify(h.sources);
  assert.ok(!wire.includes('ana') && !wire.includes('invoice'), `the receipt carries no query text (${wire})`);
  const safe = safeEvent(h.sources[0]!);
  assert.ok(safe !== undefined, 'the host log keeps the receipt');
  assert.equal(safe['coalesced'], 2, 'and keeps the coalesced count it was given');
});

// #280: a routed run used to return without its terminal run line, so every smoke probe read
// research_run 0. One line per run, the same shape the selector loop writes, plus one subcall line
// per routed lookup.
test('a routed run writes one run line with the routed driver and one subcall', async () => {
  let clock = 0;
  const h = harness({ now: () => { clock += 500; return clock; } });
  await runResearch(h.deps, {
    action: 'start', question: 'what did we decide about the release',
    lookups: [{ source: 'knowledge', query: 'release 3k decision' }],
  }, new AbortController().signal);
  assert.equal(h.logs.length, 1, 'exactly one terminal run line per routed run');
  const line = h.logs[0]!;
  assert.equal(line.event, 'research_run');
  assert.equal(line.driver, 'routed');
  assert.equal(line.rounds, 1);
  assert.equal(line.status, 'answered');
  assert.ok(line.replyBytes > 0, 'the run line sizes the reply it returned');
  assert.deepEqual(line.sources.map(source => source.kind), ['knowledge']);
  assert.deepEqual(line.sources.map(source => source.disposition), ['completed']);
  assert.deepEqual(safeEvent(line), line, 'the host log admits the routed run line unchanged');
  assert.equal(h.subcalls.length, 1, 'one subcall line per routed lookup');
  const subcall = h.subcalls[0]!;
  assert.equal(subcall.event, 'research_subcall');
  assert.equal(subcall.ok, true);
  assert.equal(subcall.researchId, line.researchId);
  assert.deepEqual(safeEvent(subcall), subcall, 'the host log admits the routed subcall line unchanged');
  assert.doesNotMatch(JSON.stringify(line), /release 3k decision/, 'no query text leaves in the run line');
});

test('a two-lookup routed run writes two subcall lines and one run line', async () => {
  const h = harness();
  await runResearch(h.deps, {
    action: 'start', question: 'where does the project stand and what is waiting on me',
    lookups: [{ source: 'knowledge', query: 'project status' }, { source: 'mail', query: 'from:plantix' }],
  }, new AbortController().signal);
  assert.equal(h.subcalls.length, 2, 'one subcall line per lookup, even when the reads coalesce');
  assert.equal(h.logs.length, 1, 'still exactly one terminal run line');
  assert.deepEqual(h.logs[0]!.sources.map(source => source.kind), ['knowledge', 'mail']);
  assert.equal(h.logs[0]!.status, 'answered');
});

test('a routed run that throws still writes its terminal run line, once, with a closed code', async () => {
  const h = harness();
  const deps: ResearchDeps = { ...h.deps, emit: event => { if (event.phase === 'done') throw new Error('beat sink gone'); } };
  await assert.rejects(runResearch(deps, {
    action: 'start', question: 'what is waiting on me',
    lookups: [{ source: 'knowledge', query: 'waiting on me' }],
  }, new AbortController().signal), /beat sink gone/);
  assert.equal(h.logs.length, 1, 'the errored run is visible and never written twice');
  assert.equal(h.logs[0]!.status, 'failed');
  assert.equal(h.logs[0]!.stopReason, 'failed', 'a closed error code, never an exception message');
  assert.equal(JSON.stringify(h.logs[0]).includes('beat sink gone'), false, 'no exception text leaves in the line');
});
