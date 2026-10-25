import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOOKUP_SOURCES, MAX_LOOKUPS, RESEARCH, ResearchLedger, calendarWindowOf, candidateSubs, chatQuestionWords, fallbackSelection, lookupBound, normalizeLookups, ownerScheduleQuestion, recallQuestion, requiredSources, researchDeclaration, routedSelection, runResearch,
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
  gmail_search_messages: '- Release notes | from: Ana | date: 2026-10-16 [id m1]',
  mattermost_search: '- the release thread, from Ana',
  mattermost_attention: '- one question from Ana is waiting on him',
  // MONGOOSE: the company read dispatches the connector's own tool name, `search`, so the fixture
  // answers under that name; a fixture keyed to the retired `search_mongoose` left the layer empty.
  search: '- Plantix organisation chart',
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
}

function harness(opts: {
  now?: () => number;
  configured?: readonly SourceKind[];
  execute?: ResearchDeps['execute'];
  memory?: (query: string) => { lines: string[]; text: string; total: number };
  schedule?: ResearchDeps['schedule'];
  unavailableNow?: ResearchDeps['unavailableNow'];
} = {}): Harness {
  const routed: ResearchRoutedLog[] = [];
  const executed: string[] = [];
  const sources: ResearchSourceLog[] = [];
  const logs: ResearchRunLog[] = [];
  const subcalls: ResearchSubcallLog[] = [];
  const progress: ResearchProgress[] = [];
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
    configured: opts.configured ?? CONFIGURED,
    ...(opts.unavailableNow === undefined ? {} : { unavailableNow: opts.unavailableNow }),
    execute: opts.execute ?? (async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push(call.name);
      return subs.map(call => sub(call.name, EVIDENCE[call.name] ?? 'evidence', true, call.key));
    }),
    emit: event => { progress.push(event); },
    log: event => { logs.push(event); },
    logRouted: event => routed.push(event),
    logSource: event => sources.push(event),
    logSubcall: event => { subcalls.push(event); },
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
  return { deps, routed, sources, logs, subcalls, executed, progress };
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
  assert.equal('selector' in h.deps, false, 'no selector rides the path a routed start takes');
  assert.deepEqual(entered, ['search_knowledge', 'gmail_search_messages'], 'both lookups were dispatched before either was awaited');
  assert.equal(reply['status'], 'complete');
  assert.deepEqual(reply['sources'], { knowledge: 'ok', mail: 'ok' }, 'one combined reply with per-source status');
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.deepEqual(findings.map(finding => finding.source).sort(), ['knowledge', 'mail']);
});

test('the routed receipt names the sources, the count and per-source ms, never a query', async () => {
  let clock = 0;
  const h = harness({ now: () => { clock += 250; return clock; } });
  const reply = await runResearch(h.deps, {
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
  assert.match(JSON.stringify(reply['findings']), /Plantix organisation chart/, 'the company layer answered with the line it read');
  assert.doesNotMatch(JSON.stringify(receipt), /release 3k decision|reports to whom/, 'no query text leaves in the receipt');
  assert.deepEqual(safeEvent(receipt), receipt, 'the host log admits the routed receipt unchanged');
});

test('a routed lookup that fails is isolated and the other layers still answer', async () => {
  const h = harness({
    execute: async (subs: readonly IntentSubCall[]) => {
      if (subs[0]!.name === 'gmail_search_messages') throw Error('mail_down');
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
  assert.equal(reply['status'], 'complete', 'one good layer answers the call');
});

test('ROUTE-1022 K11: a model-written mail lookup reads one page, never the whole mailbox', async () => {
  const dispatched: Record<string, unknown>[] = [];
  const h = harness({ execute: async (subs: readonly IntentSubCall[]) => {
    for (const call of subs) dispatched.push({ ...call.args });
    return subs.map(call => sub(call.name, '- Invoice | Landlord | Mon | due soon [id m1]', true, call.key));
  } });
  await runResearch(h.deps, {
    action: 'start', question: 'agricon mail', topic: 'agricon', lookups: [{ source: 'mail', mail: { q: 'agricon', maxResults: 100 } }],
  }, new AbortController().signal);
  const pages = dispatched.filter(args => typeof args['q'] === 'string');
  assert.ok(pages.length > 0, 'the mail lookup dispatched a page');
  for (const args of pages) assert.ok(Number(args['maxResults']) <= RESEARCH.pageResults.mail, `every page is clamped (${String(args['maxResults'])})`);
  assert.equal(pages[0]!['maxResults'], RESEARCH.pageResults.mail, 'the requested page size is clamped to the mail page');
  assert.match(String(pages[0]!['q']), /agricon/, 'and the model query is what is asked');
});

test('ROUTE-1022 K5: a brief on a question that names no layer reads knowledge only', async () => {
  const subs = candidateSubs('brief', { question: 'what do you think about our business model', topic: 'business model', configured: CONFIGURED, evidence: new Map() });
  assert.deepEqual(subs.map(call => call.name), ['search_knowledge'], 'no mail, calendar or chat read');
  assert.equal(JSON.stringify(subs).includes('open loop follow up'), false, 'the default query is gone');
  assert.match(String(subs[0]!.args['query']), /business model/);
});

test('ROUTE-1022 K5: a brief on a question that names a layer reads that layer too', async () => {
  const subs = candidateSubs('brief', { question: "what's on my calendar tomorrow", topic: 'calendar', configured: CONFIGURED, evidence: new Map() });
  const names = subs.map(call => call.name);
  assert.ok(names.includes('calendar_list_events'), 'the layer the question names is read');
  assert.equal(names.includes('mattermost_search'), false, 'a layer it did not name is not');
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
  assert.equal(calendarWindowOf('anything about the release'), '', 'an unparseable window is never today (#5)');
});

test('the declared lookups key is valid on start only and matches its validator', () => {
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't' }), true, 'unrouted start stays valid');
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't', lookups: [{ source: 'memory', query: 'x' }] }), true);
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't', lookups: [] }), true);
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't', lookups: [{ source: 'mail' }] }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't', lookups: [{ source: 'nonsense', query: 'x' }] }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't', lookups: [{ source: 'mail', query: 'x', extra: 1 }] }), false);
  assert.equal(validateResearch({ action: 'continue', researchId: 'r', lookups: [{ source: 'mail', query: 'x' }] }), false,
    'lookups belong to a start');
  assert.equal(validateResearch({ action: 'start', question: 'q', topic: 't', lookups: 'mail' }), false);
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

test('an unrouted start reads the deterministic plan and never touches memory', async () => {
  const h = harness({ memory: () => { throw Error('memory must not be read'); } });
  await runResearch(h.deps, { action: 'start', question: 'where does the project stand', lookups: [] }, new AbortController().signal);
  assert.equal('selector' in h.deps, false, 'F-B: no lookups never means a selector round');
  assert.ok(h.executed.includes('search_knowledge'), 'the knowledge prime read is dispatched, exactly as before');
  assert.equal('selector' in h.deps, false, 'F-B: the plan never comes from a selector');
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
    return subs.map(call => call.name === 'calendar_list_events'
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
  assert.equal(read!.name, 'calendar_list_events');
  assert.equal(read!.args['calendarId'], 'primary', 'the primary calendar only, never the 22-calendar merge');
  assert.equal(listed!.name, 'calendar_list_calendars', 'the list rides along only to say what was not read');
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
  // #635: a cut read is named as a timeout with its budget, never as a source that failed.
  assert.match(String(reply['note']), /not read \(timed out after 12 s\)/u);
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
  assert.deepEqual(names, ['calendar_list_events', 'calendar_list_calendars', 'calendar_list_events'], 'the calendar list is dispatched once for both windows');
  assert.deepEqual(h.sources.map(event => event.source), ['calendar', 'calendar']);
  assert.deepEqual(h.sources.map(event => event.outcome), ['ok', 'ok']);
  const windows = calendar.calls()[0]!.filter(call => call.name === 'calendar_list_events').map(call => `${String(call.args['timeMin'])}|${String(call.args['timeMax'])}`);
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
  assert.deepEqual(receipts.map(event => [event.source, event.outcome, event.deadlineMs]), [['chat', 'unavailable', RESEARCH.sourceDeadline.chat]]);
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

// --- F8: the schedule router reads schedule words, never the product's daily words ---------------

test('F8: a daily word is not schedule intent, and a schedule question still is', async () => {
  assert.equal(ownerScheduleQuestion('any calls today'), false, 'calls and today are the product vocabulary, not a schedule');
  assert.equal(ownerScheduleQuestion('did Dana send that today'), false, 'today alone never routes the calendar');
  assert.equal(ownerScheduleQuestion('what is on my calendar today'), true, 'the owner naming her calendar still routes it');
  assert.equal(ownerScheduleQuestion('any meetings this week'), true);
  assert.equal(ownerScheduleQuestion('add it to the agenda'), true);
});

// --- F6: an identical read inside one live session is paid once ---------------------------------

// MED-1022: the read's key carries the question's own words, so the same read means the same question;
// a paraphrase of it is a different query and pays for its own dispatch.
test('F6: the same knowledge read twice inside the session window is dispatched once', async () => {
  const h = harness({});
  h.deps.memo = { calendar: new Map() };
  const first = await runResearch(h.deps, { action: 'start', question: 'what is the release scope', lookups: [{ source: 'knowledge', query: 'release scope' }] }, new AbortController().signal);
  const second = await runResearch(h.deps, { action: 'start', question: 'what is the release scope', lookups: [{ source: 'knowledge', query: 'release scope' }] }, new AbortController().signal);
  assert.notEqual(first['researchId'], second['researchId'], 'two distinct runs, two distinct ids');
  assert.equal(h.executed.filter(name => name === 'search_knowledge').length, 1, 'the second run reuses the answer instead of paying for it again');
  // #575 supersedes the repeat here: the session already delivered this block, so the second reply
  // names it in one line instead of handing the same evidence over again.
  assert.match(JSON.stringify(second['findings']), /knowledge: already given/u, 'the reused read is named, never repeated');
});

// ONE-1023: four near-identical lookups in one call are one search, and two lookups of the same
// window are one calendar read; the receipt counts what the shared dispatch served.
test('ONE-1023: identical reads inside one run dispatch once and are counted', async () => {
  const h = harness({ now: () => 0 });
  const lookups = [
    { source: 'calendar', query: 'what is on my calendar today' },
    { source: 'calendar', query: "what's on today" },
    { source: 'knowledge', query: 'read full post body budget review' },
    { source: 'knowledge', query: 'budget review' },
  ];
  const reply = await runResearch(h.deps, { action: 'start', question: 'what do we know about the budget review', lookups }, new AbortController().signal);
  assert.equal(h.executed.filter(name => name === 'calendar_list_events').length, 1, 'one window, one calendar read');
  assert.equal(h.executed.filter(name => name === 'search_knowledge').length, 1, 'the same normalized query, one search');
  const knowledge = h.sources.filter(entry => entry.source === 'knowledge');
  assert.equal(knowledge.at(-1)?.knowledge?.deduped, 1, 'the receipt counts the read the dispatch shared');
  assert.match(JSON.stringify(reply), /Release 3k scope/u, 'the shared read reaches the reply');
});

// DATES-R1 F2: the day filter decision is the read's own, never a flag for the whole run.
test('DATES-R1: a read that kept its day filter reports past_window beside one that dropped it', async () => {
  const now = Date.parse('2026-10-23T04:30:00Z');
  const h = harness({
    now: () => now,
    execute: async subs => subs.map(call => {
      const filtered = 'meeting_date_from' in call.args;
      // The question's own terms ride after the lookup's, so the lookup word decides here.
      const hiring = String(call.args['query'] ?? '').startsWith('hiring');
      const text = filtered && !hiring ? '' : '### budget review [id 41]\nthe budget review is agreed';
      return sub(call.name, text, true, call.key);
    }),
  });
  const lookups = [{ source: 'knowledge', query: 'budget review' }, { source: 'knowledge', query: 'hiring plan' }];
  await runResearch({ ...h.deps, timeZone: 'Asia/Kolkata' }, { action: 'start', question: "what did we decide in yesterday's meeting about the budget review and the hiring plan", lookups }, new AbortController().signal);
  const receipts = h.sources.filter(entry => entry.source === 'knowledge');
  assert.equal(receipts.length, 2, 'one receipt per knowledge read');
  assert.deepEqual(receipts.map(entry => entry.knowledge?.dayFilter).sort(), ['dropped_on_empty', 'past_window'], 'the read whose filter was dropped says so, the read that kept its filter says that instead');
});

// --- Release 4: a failed later page never throws away the pages already read ----------------------

test('release 4: a gmail page that fails after three good pages keeps the items it delivered', async () => {
  let page = 0;
  const h = harness({
    execute: async subs => subs.map(call => {
      if (call.name !== 'gmail_search_messages') return sub(call.name, EVIDENCE[call.name] ?? 'evidence', true, call.key);
      page += 1;
      if (page <= 3) {
        const message = { id: `m${page}`, threadId: `t${page}`, internalDate: '2026-10-20T10:00:00Z', line: `[id m${page}] message ${page}`, bodyTruncated: false };
        return { key: call.key, name: call.name, ok: true, text: message.line, originalCharacters: message.line.length, omittedCharacters: 0, mailPage: { messages: [message], received: 1, invalid: 0, localOmitted: 0, nextPageToken: `page${page}` } } as IntentSubResult;
      }
      return { key: call.key, name: call.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'upstream_unavailable' } as IntentSubResult;
    }),
  });
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'mail', query: 'newer_than:2d' }] }, new AbortController().signal);
  const row = h.sources.find(entry => entry.source === 'mail');
  assert.ok(row !== undefined, 'the mail source has its own receipt');
  assert.equal(row!.outcome, 'ok', 'the source delivered, so it is not a failed read');
  assert.ok(safeEvent(row as unknown as Record<string, unknown>) !== undefined, 'and the host log admits the partial receipt');
  const receipt = row as unknown as Record<string, unknown>;
  assert.equal(receipt['partial'], 'pages_failed', 'and the receipt carries the closed partial marker');
  assert.equal(receipt['failedPages'], 1, 'with the count of pages it lost');
  const findings = reply['findings'] as { source: string; text: string }[];
  const mailText = findings.filter(finding => finding.source === 'mail').map(finding => finding.text).join('\n');
  for (const id of ['m1', 'm2', 'm3']) assert.match(mailText, new RegExp(id, 'u'), `the page ${id} items survive the later failure`);
});


// --- LAT-1023: answers come sooner and the call stays light --------------------------------------

test('LAT-1023: a run stops after two tool-bearing rounds and the receipt says the cap was hit', async () => {
  const h = harness({ execute: async subs => subs.map(call => sub(call.name, '', true, call.key)) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what decisions did we make about the retrieval deadline' }, new AbortController().signal);
  const line = h.logs[0]!;
  assert.equal(line.rounds, 2, 'the initial parallel round and at most one continuation round');
  assert.deepEqual(line.perRound.map(row => row.chosen), [['knowledge_search'], ['brief']], 'two rounds were dispatched, never a third');
  assert.equal(line.roundCapHit, 2, 'and the receipt names the cap with its round count');
  assert.ok((line.unchecked ?? []).length > 0, 'evidence was left unread when the cap ended the run');
  assert.equal(RESEARCH.startRounds, 2, 'the initial parallel round and one continuation');
  assert.equal(RESEARCH.continueRounds, 2, 'a continued run may not buy a third round');
  assert.equal(typeof reply['status'], 'string', 'the answer is composed from what the two rounds hold');
  assert.doesNotMatch(JSON.stringify(reply), /no such|does not exist/iu, 'and never claims a record does not exist');
});

test('LAT-1023: a run that answers in its first round never claims the cap', async () => {
  const h = harness({});
  await runResearch(h.deps, { action: 'start', question: 'what decisions did we make about the retrieval deadline' }, new AbortController().signal);
  assert.equal(h.logs[0]!.rounds, 1);
  assert.equal(h.logs[0]!.roundCapHit, undefined, 'an answered first round hit no cap');
});

// #579/TRIAGE-R1 5: the plurals, gmail, inbox, messages, dm(s) and chats name their own source, a time
// word alone never swaps the named source for the calendar, and a weekday or an exact date is the calendar.
test('#579/TRIAGE-R1 5: every new word form routes to its source and a window word does not steal it', () => {
  const table: [string, SourceKind[]][] = [
    ['what did the emails say about the retainer', ['mail']],
    ['any gmail from Priya', ['mail']],
    ['is my inbox clear', ['mail']],
    ['what did the chats say about the freeze', ['chat']],
    ['anything from the dms yesterday', ['chat']],
    ['what did the mattermost team decide', ['chat']],
    ['any messages', ['chat']],
    ['any important emails today', ['mail']],
    ['what happened in the chats this week', ['chat']],
    ["what's on thursday", ['calendar']],
    ['what have I got on 2026-10-30', ['calendar']],
  ];
  for (const [question, sources] of table) assert.deepEqual(requiredSources(question), sources, question);
  const today = routedSelection('any important emails today', CONFIGURED, Date.parse('2026-10-21T05:30:00Z'));
  assert.ok(today !== undefined, 'a mail ask with a time word is a deterministic selection');
  assert.ok(today.actions.some(action => action.kind === 'mail_search'), 'it reads mail');
  assert.ok(!today.actions.some(action => action.kind === 'calendar_window'), 'a time word never pulls the calendar in');
  const thursday = routedSelection("what's on thursday", CONFIGURED, Date.parse('2026-10-21T05:30:00Z'));
  assert.ok(thursday !== undefined && thursday.actions.some(action => action.kind === 'calendar_window'), 'a weekday reads the calendar');
});

// TRIAGE-R1 6: "anything urgent" names no source, so what came in is a mail, a chat and a calendar read,
// and her own memory is offered beside them.
test('TRIAGE-R1 6: a triage ask routes to mail, chat and calendar, with the memory route beside them', () => {
  assert.deepEqual(requiredSources('anything urgent?'), ['mail', 'chat', 'calendar']);
  const selection = routedSelection('anything urgent?', CONFIGURED, Date.parse('2026-10-21T05:30:00Z'));
  assert.ok(selection !== undefined, 'a triage ask is a deterministic selection');
  const kinds = selection.actions.map(action => action.kind).sort();
  assert.deepEqual(kinds, ['calendar_window', 'chat_search', 'knowledge_search', 'mail_search'], 'the three sources and her memory');
  for (const kind of ['mail_search', 'chat_search', 'calendar_window'] as const) {
    assert.ok(selection.pUseful[kind] !== undefined, `${kind} is offered`);
  }
});

// TRIAGE-R3: a recall ask is her own remembered history, so it reads memory and never the knowledge
// store, and the deterministic router does not turn it into a chat search on the word "said".
test('TRIAGE-R3: a recall ask routes to memory', () => {
  const table = [
    'what did we say about the pricing deck',
    'you told me the release was friday',
    'do you remember the hawthorn decision',
  ];
  for (const question of table) {
    assert.deepEqual(requiredSources(question), ['memory'], question);
    assert.equal(routedSelection(question, CONFIGURED, Date.parse('2026-10-21T05:30:00Z')), undefined, `${question} is a memory read, not a router candidate`);
  }
  // E2 (#605): a discussion form reads her own memory. #635: the chat beside it only when the ask names the
  // chat surface, because a recall ask that names no chat is a memory read and no chat leg runs.
  const discussion = 'last time we talked about the deadline';
  assert.deepEqual(requiredSources(discussion), ['memory'], discussion);
  assert.deepEqual(requiredSources('what did we discuss in the team chat about the boat'), ['memory', 'chat'], 'a recall ask that names the chat still reads it');
  assert.equal(routedSelection(discussion, CONFIGURED, Date.parse('2026-10-21T05:30:00Z')), undefined, `${discussion} is a memory read, not a router candidate`);
});

// E1 (#605): the routed chat read used the question's prose as its search text, so the topic never
// reached the search. The topic words are the search; a model query only fills in when none was named.
test('E1: a message ask searches chat on the topic words and never reads mail', () => {
  const question = 'did anyone message me about the budget';
  assert.deepEqual(requiredSources(question), ['chat'], 'a message is a chat word alone');
  const selection = fallbackSelection(question, CONFIGURED, Date.parse('2026-10-21T05:30:00Z'));
  assert.equal(selection.actions.some(action => action.kind === 'mail_search'), false, 'no mail lookup is offered');
  const subs = candidateSubs('chat_search', { question, topic: 'budget', query: question, configured: CONFIGURED, evidence: new Map(), nowMs: Date.parse('2026-10-21T05:30:00Z'), timeZone: 'Asia/Kolkata' });
  assert.equal(subs[0]?.args['query'], 'budget', 'the topic is the chat search text');
});

// E2 (#605): the discussion forms never reached memory, and the attention form never named Rob.
test('E2: a two-name discussion ask routes to memory and chat, and an attention ask to the three inboxes', () => {
  assert.deepEqual(requiredSources('What did Rob and Naya discuss about the boat'), ['memory'], 'a two-name discussion ask reads memory alone');
  assert.deepEqual(requiredSources('What did Rob and Naya discuss in the boat channel'), ['memory', 'chat']);
  assert.deepEqual(requiredSources("What needs Rob's attention"), ['mail', 'chat', 'calendar']);
  const selection = routedSelection("what needs rob's attention", CONFIGURED, Date.parse('2026-10-21T05:30:00Z'));
  assert.ok(selection !== undefined, 'an attention ask is a deterministic selection');
  assert.deepEqual(selection.actions.map(action => action.kind).sort(), ['calendar_window', 'chat_search', 'knowledge_search', 'mail_search']);
});

// --- #635: chat only when the ask needs it, a bounded chat read, and a timeout called a timeout --------

interface FakeClock { now: () => number; schedule: ResearchTimer; advance: (to: number) => void }

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
  };
}

// The run schedules its own cut before it dispatches, so the clock moves only once the read is in flight.
const flushed = async (): Promise<void> => { for (let tick = 0; tick < 12; tick += 1) await new Promise(resolve => setImmediate(resolve)); };

// #635: "write up what I discussed" and "remind me what we discussed" carry a chat word as their subject,
// not as a source, so neither reads the chat. An ask that names the chat surface still does.
test('#635: a writing ask and a pure recall ask run no chat leg', async () => {
  const writing = 'write up what I discussed with the team about the release';
  assert.ok(!requiredSources(writing).includes('chat'), 'a summarise ask does not route the chat');
  assert.equal(fallbackSelection(writing, CONFIGURED, Date.parse('2026-10-21T05:30:00Z')).actions.some(action => action.kind === 'chat_search'), false, 'and the fallback selector offers no chat read');
  const recall = 'remind me what we discussed about the release';
  assert.ok(!requiredSources(recall).includes('chat'), 'a pure recall ask does not route the chat');
  assert.equal(fallbackSelection(recall, CONFIGURED, Date.parse('2026-10-21T05:30:00Z')).actions.some(action => action.kind === 'chat_search'), false, 'and the fallback selector offers no chat read there either');
  assert.ok(requiredSources('what did the team say in the release channel yesterday').includes('chat'), 'an ask that names the chat surface still routes it');
  assert.ok(requiredSources('what did Ana say in chat about the release').includes('chat'), 'and so does an ask that names the chat itself');
  const h = harness();
  await runResearch(h.deps, { action: 'start', question: writing }, new AbortController().signal);
  assert.ok(!h.executed.includes('mattermost_search'), `no chat leg runs for a summarise ask (${h.executed.join(', ')})`);
});

// #646: the run's own recall branch added the chat leg on the discussion forms alone, so "what did we
// discuss with the team" (a MEMORY_WORDS recall that names no chat surface) waited on a chat read it never
// needed. The recall exception belongs to `chatQuestionWords`, and the run's branch, the route and the
// fallback all read that one need rule.
test('#646: a recall ask that mentions the team runs no chat leg and answers from memory', async () => {
  const recall = 'what did we discuss with the team about the release';
  assert.ok(recallQuestion(recall), 'the ask is a recall ask');
  assert.equal(chatQuestionWords(recall), false, 'and the one need rule reads no chat in it');
  assert.deepEqual(requiredSources(recall), ['memory'], 'the route is her own memory');
  const at = Date.parse('2026-10-21T05:30:00Z');
  assert.equal(routedSelection(recall, CONFIGURED, at), undefined, 'the router claims no candidate for it');
  assert.equal(fallbackSelection(recall, CONFIGURED, at).actions.some(action => action.kind === 'chat_search'), false, 'and the fallback selector offers no chat read either');
  const h = harness({ memory: () => ({ lines: ['2026-10-14 entry: we agreed the release ships on Friday'], text: '', total: 1 }) });
  const reply = await runResearch(h.deps, { action: 'start', question: recall }, new AbortController().signal);
  assert.ok(!h.executed.includes('mattermost_search'), `no chat leg runs for a recall ask (${h.executed.join(', ')})`);
  assert.deepEqual(reply['sources'], { memory: 'ok' }, 'and her memory alone answers it');
});

// #646: a recall ask that names the chat surface still reads it, so the exception stays the exception.
test('#646: a recall ask that names a channel still reads the chat', async () => {
  const recall = 'what did we discuss in the release channel about the release';
  assert.equal(chatQuestionWords(recall), true, 'the ask names the chat surface, so it needs the chat');
  assert.deepEqual(requiredSources(recall), ['memory', 'chat'], 'so the route carries her memory and the chat');
  const h = harness({ memory: () => ({ lines: ['2026-10-14 entry: we agreed the release ships on Friday'], text: '', total: 1 }) });
  await runResearch(h.deps, { action: 'start', question: recall }, new AbortController().signal);
  assert.ok(h.executed.includes('mattermost_search'), `an ask that names the channel reads it (${h.executed.join(', ')})`);
});

// #645: the chat read keeps a row of its own inside the turn, so one slow connector never spends the
// ask's whole 12 s. #635 put it at 6 s, under the 5 to 12 s a real read takes, which cut 27 of 30 chat
// reads before anything arrived; 10 s is above the real read and under the 12 s connector timeout, so a
// cut is the exception with the #635 wording. What arrived is used, and a timed out read says so.
test('#645: the chat read is bounded at ten seconds, and a timed out one says timed out', async () => {
  assert.equal(RESEARCH.sourceDeadline.chat, 10_000, `the chat budget is ten seconds (${RESEARCH.sourceDeadline.chat} ms)`);
  assert.ok(RESEARCH.sourceDeadline.chat < RESEARCH.sourceDeadline.mail, 'and under the 12 s the other connectors keep');
  assert.ok(RESEARCH.sourceDeadline.chat > RESEARCH.firstAnswerMs, 'and above the 4.5 s the session releases at, so a late chat finding still lands');
  assert.equal(lookupBound('chat', 1, RESEARCH.answerCapMs), RESEARCH.sourceDeadline.chat, 'a lone chat lookup is given the chat budget');
  const clock = fakeClock();
  const h = harness({
    now: clock.now,
    schedule: clock.schedule,
    execute: async (_subs: readonly IntentSubCall[], signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return [];
    },
  });
  const call = runResearch(h.deps, {
    action: 'start', question: 'what did the team say in chat about the release',
    lookups: [{ source: 'chat', query: 'release' }],
  }, new AbortController().signal);
  await flushed();
  clock.advance(RESEARCH.sourceDeadline.chat);
  const reply = await call;
  const header = String(reply['coverage']);
  assert.match(header, /chat timed_out/u, `a chat read that timed out with nothing arrived says timed_out (${header})`);
  assert.doesNotMatch(header, /chat provider_failed/u, 'a timeout is never voiced as a provider failure');
  assert.match(header, /chat timed_out \(say: team chat took too long\)/u, `and the voiceable clause says it took too long (${header})`);
  const note = String(reply['note']);
  assert.match(note, /team chat: not read \(timed out after 10 s\)/u, `the note names the timeout and its budget (${note})`);
  assert.doesNotMatch(note, /could not reach/u, 'and never that the chat was out of reach');
});

// #635: a chat read that answered in part and then ran out of its budget is a partial timeout under the fake
// clock, not a complete read and not a whole-run abort.
test('#635: a chat read cut by its own budget after it answered is a partial timeout', async () => {
  const clock = fakeClock();
  const h = harness({
    now: clock.now,
    schedule: clock.schedule,
    execute: async (subs: readonly IntentSubCall[], signal?: AbortSignal) => {
      if (subs.some(call => call.name === 'mattermost_get_thread')) {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted === true) { reject(new Error('aborted')); return; }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return subs.map(call => sub(call.name, '- the release thread opened [post abc123]', true, call.key));
    },
  });
  const call = runResearch(h.deps, { action: 'start', question: 'what did the team say in chat about the release' }, new AbortController().signal);
  await flushed();
  clock.advance(RESEARCH.sourceDeadline.chat);
  const reply = await call;
  const header = String(reply['coverage']);
  const note = String(reply['note']);
  assert.match(header, /chat partial_timeout 1 of 1 shown/u, `a read that answered and then ran out of its budget keeps what it read and is partial (${header})`);
  assert.match(note, /team chat read took too long/u, `the voice says the read took too long (${note})`);
  assert.doesNotMatch(note, /could not reach/u, 'a cut read is never a source out of reach');
});

// #639: the eval's company asks went question only, and with the three Mongoose endpoints behind a sign-in
// the reply never said so. A company ask is a source in its own right, read beside the knowledge base, and
// an endpoint that cannot serve it is named with the closed reason the typed lookup already speaks.
test('#639: a question only company ask reads the company layer beside the knowledge base', async () => {
  const h = harness();
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'do we know Plantix, our customer',
  }, new AbortController().signal);
  assert.ok(h.executed.includes('search'), `the company read was dispatched (${h.executed.join(', ')})`);
  assert.ok(h.executed.includes('search_knowledge'), 'and the knowledge base answered beside it');
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.ok(findings.some(finding => finding.source === 'mongoose' && finding.text.includes('Plantix organisation chart')),
    `the company layer carried its own finding (${JSON.stringify(findings.map(finding => finding.source))})`);
  assert.equal(String(reply['note'] ?? '').includes('company knowledge'), false, 'a signed in company read is never spoken as unavailable');
});

test('#639: a question only company ask whose endpoints are not signed in says so, and still answers from knowledge', async () => {
  const h = harness({ unavailableNow: () => [{ source: 'mongoose', reason: 'not_signed_in' }] });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'do we know Plantix, our customer',
  }, new AbortController().signal);
  const note = String(reply['note'] ?? '');
  assert.match(note, /company knowledge: unavailable \(not signed in\)/u, `the voice says the company layer is not signed in (${note})`);
  const header = String(reply['coverage'] ?? '');
  assert.match(header, /mongoose /u, `the header names the company source the ask wanted (${header})`);
  assert.equal(h.executed.includes('search'), false, 'a dead endpoint is never handed the question');
  const findings = reply['findings'] as { source: string }[];
  assert.ok(findings.some(finding => finding.source === 'knowledge'), 'the knowledge source still answers beside it');
});

test('#639: an ask with no company word never routes to the company layer', async () => {
  const h = harness();
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar this week' }, new AbortController().signal);
  assert.equal(h.executed.includes('search'), false, `no company read for a calendar ask (${h.executed.join(', ')})`);
});

// #639: the route class is the one place a route is decided, so the company words are proven here and the
// reading order is proven to keep the existing two source cap, company last.
test('#639: the company route class names the ask and keeps the two source cap', () => {
  assert.deepEqual(requiredSources('do we know Plantix'), ['mongoose'], 'a company ask names the company source');
  assert.deepEqual(requiredSources('what did our customer say about the renewal'), ['mongoose'], 'and so does a customer ask');
  assert.deepEqual(requiredSources('what do we know about the release plan'), [], 'the generic knowledge ask is not a company ask');
  assert.deepEqual(requiredSources('what did our customer write in the mail'), ['mail', 'mongoose'], 'a company ask that also names mail keeps both');
  assert.deepEqual(requiredSources('the mail about our customer and the calendar'), ['calendar', 'mail'], 'three named sources keep the first two of the route order, so the company source sits last');
  const routed = routedSelection('do we know Plantix', CONFIGURED);
  assert.ok(routed !== undefined, 'an unambiguous company ask is routed without spending the selector');
  assert.ok(routed.actions.some(action => String(action.kind) === 'company_search'), `the routed selection reads the company layer (${JSON.stringify(routed.actions.map(action => action.kind))})`);
});
