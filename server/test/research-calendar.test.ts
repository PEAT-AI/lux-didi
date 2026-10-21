import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchLedger, ResearchScheduler, createGeminiSelector, runResearch, windowRange, type ResearchDeps } from '../tools/research.js';
import { shapeGcalList } from '../tools/live-shape.js';
import type { IntentSubResult } from '../tools/intent.js';

const signal = (): AbortSignal => new AbortController().signal;
const fixedNow = Date.parse('2026-10-19T12:00:00Z');
function fixture(events: Record<string, unknown>[], opts: { token?: string; pageSize?: number } = {}) {
  const calls: Record<string, unknown>[] = [];
  const deps: ResearchDeps = {
    now: () => fixedNow, configured: ['calendar'], ledger: new ResearchLedger(), timeZone: 'UTC',
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {},
    execute: async subs => subs.map(call => {
      calls.push({ name: call.name, ...call.args });
      if (call.name === 'calendar_list_calendars') return { key: call.key, name: call.name, ok: true, text: '- Main [primary]', originalCharacters: 16, omittedCharacters: 0 };
      const start = Date.parse(String(call.args['timeMin']));
      const end = Date.parse(String(call.args['timeMax']));
      const all = events.filter(event => Date.parse(String(event['start'])) >= start && Date.parse(String(event['start'])) < end);
      const offset = call.args['pageToken'] === 'second' ? (opts.pageSize ?? 12) : 0;
      const received = all.slice(offset, offset + (opts.pageSize ?? 50));
      const page = shapeGcalList({ events: received, ...(offset === 0 && opts.token ? { nextPageToken: opts.token } : {}) });
      return { key: call.key, name: call.name, ok: true, ...page } as IntentSubResult;
    }),
  };
  return { deps, calls };
}
const event = (day: number, n = 0): Record<string, unknown> => ({ id: `d${day}n${n}`, start: `2026-10-${day}T10:${String(n).padStart(2, '0')}:00Z`, summary: `Day ${day} item ${n}` });

test('calendar exact windows use the session zone and resolve both DST midnights', () => {
  const range = windowRange as (window: string, now: number, zone?: string) => { timeMin: string; timeMax: string };
  assert.deepEqual(range('Wednesday this week', fixedNow, 'Asia/Kolkata'), { timeMin: '2026-10-20T18:30:00.000Z', timeMax: '2026-10-21T18:30:00.000Z' });
  assert.deepEqual(range('next Wednesday', fixedNow, 'UTC'), { timeMin: '2026-10-28T00:00:00.000Z', timeMax: '2026-10-29T00:00:00.000Z' });
  const dst = range('2026-11-01', fixedNow, 'America/New_York');
  assert.equal(Date.parse(dst.timeMax) - Date.parse(dst.timeMin), 25 * 60 * 60 * 1000);
  const spring = range('2026-03-08', fixedNow, 'America/New_York');
  assert.equal(Date.parse(spring.timeMax) - Date.parse(spring.timeMin), 23 * 60 * 60 * 1000);
  assert.deepEqual(range('week', Date.parse('2026-10-21T12:00:00Z'), 'UTC'), { timeMin: '2026-10-21T00:00:00.000Z', timeMax: '2026-10-28T00:00:00.000Z' });
  assert.equal(range('this week', Date.parse('2026-10-25T12:00:00Z'), 'UTC').timeMin, '2026-10-19T00:00:00.000Z');
  assert.equal(range('Wednesday', Date.parse('2026-10-21T12:00:00Z'), 'UTC').timeMin, '2026-10-21T00:00:00.000Z');
  assert.equal(range('Wednesday this week', Date.parse('2026-10-23T12:00:00Z'), 'UTC').timeMin, '2026-10-21T00:00:00.000Z');
  assert.throws(() => range('today', fixedNow, 'Invalid/Zone'), /unresolved/);
  assert.throws(() => range('2026-02-30', fixedNow, 'UTC'), /unresolved/);
  assert.throws(() => range('Wednesday tomorrow', fixedNow, 'UTC'), /unresolved/);
});

test('calendar dense week preserves later weekdays and unique evidence with retained remainder', async () => {
  const events = [...Array.from({ length: 8 }, (_, n) => event(19, n)), ...Array.from({ length: 4 }, (_, n) => event(20, n)), event(21), event(22), event(23)];
  const h = fixture(events, { token: 'second', pageSize: 12 });
  const first = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }, { source: 'calendar', query: 'calendar this week' }] }, signal());
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 2, 'both upstream pages, exact duplicate window once');
  assert.equal(first['canContinue'], true);
  const second = await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, signal());
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 2, 'retained events are not reread');
  const text = JSON.stringify(second['findings']);
  assert.match(text, /Day 21/); assert.match(text, /Day 22/); assert.match(text, /Day 23/);
  assert.doesNotMatch(text, /27 of 24/);
});

test('calendar exact weekday intents read distinct days and unsupported dates dispatch nothing', async () => {
  const h = fixture([event(21), event(22), event(23)]);
  const reply = await runResearch(h.deps, { action: 'start', lookups: ['Wednesday', 'Thursday', 'Friday'].map(day => ({ source: 'calendar', query: `${day} this week` })) }, signal());
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 3);
  assert.equal(new Set(h.calls.filter(call => call['name'] === 'calendar_list_events').map(call => call['timeMin'])).size, 3);
  for (const day of [21, 22, 23]) assert.match(JSON.stringify(reply['findings']), new RegExp(`Day ${day}`));
  for (const query of ['release plans', '2026-02-30', 'Wednesday tomorrow', '2026-10-21 or 2026-10-22']) {
    const bad = fixture([]);
    const response = await runResearch(bad.deps, { action: 'start', lookups: [{ source: 'calendar', query }] }, signal());
    assert.equal(bad.calls.length, 0, query);
    assert.match(String(response['note']), /could not resolve/);
    assert.equal(response['canContinue'], false);
  }
});

test('calendar page coverage distinguishes exhausted, empty progress, repeated tokens and failed reads', async () => {
  for (const mode of ['full', 'empty-progress', 'repeat', 'failure'] as const) {
    const h = fixture([]);
    let pageCalls = 0;
    h.deps.execute = async subs => subs.map(call => {
      if (call.name !== 'calendar_list_events') return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0, calendarScope: { received: 20, partial: true } };
      pageCalls++;
      if (mode === 'failure' && pageCalls === 2) return { key: call.key, name: call.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'transport_unavailable' };
      const events = mode === 'empty-progress' && pageCalls === 1 ? [] : mode === 'full' ? Array.from({ length: 12 }, (_, n) => event(19, n)) : [event(19, pageCalls)];
      const nextPageToken = mode === 'full' || (mode === 'empty-progress' && pageCalls === 2) ? undefined : 'cursor';
      return { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events, ...(nextPageToken ? { nextPageToken } : {}) }) };
    });
    const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
    assert.equal(pageCalls, mode === 'full' ? 1 : 2, mode);
    const coverage = reply['calendarCoverage'] as Record<string, unknown>;
    assert.equal(coverage['calendarListComplete'], false);
    assert.equal(coverage['upstreamRemaining'], false);
    assert.equal(coverage['failed'], mode === 'repeat' || mode === 'failure');
    assert.ok(Number(coverage['shown']) <= Number(coverage['received']));
    await runResearch(h.deps, { action: 'continue', researchId: String(reply['researchId']) }, signal());
    assert.equal(pageCalls, mode === 'full' ? 1 : 2, 'failed reads never replay on continuation');
  }
});

test('calendar retained remainder is invalidated by a new start, cancellation, close and authority loss', async () => {
  for (const mode of ['new-start', 'cancel', 'close', 'stop', 'authority'] as const) {
    const h = fixture(Array.from({ length: 12 }, (_, n) => event(19, n)));
    let allowed = true;
    // The actual Live integration below proves original journal bindings. This seam isolates lifecycle invalidation.
    if (mode === 'authority') {
      const execute = h.deps.execute;
      h.deps.execute = async (calls, abort) => (await execute(calls, abort)).map(result => ({ ...result, binding: { executionId: result.key } as NonNullable<IntentSubResult['binding']> }));
      h.deps.authorizeEvidence = () => allowed;
    }
    const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
    const previous = h.calls.length;
    if (mode === 'new-start') await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'unsupported' }] }, signal());
    if (mode === 'cancel') h.deps.ledger.cancelActive();
    if (mode === 'close') h.deps.ledger.close();
    if (mode === 'stop') await runResearch(h.deps, { action: 'stop', researchId: String(reply['researchId']) }, signal());
    if (mode === 'authority') allowed = false;
    const after = await runResearch(h.deps, { action: 'continue', researchId: String(reply['researchId']) }, signal());
    assert.equal(h.calls.length, previous);
    assert.deepEqual(after['findings'], []);
    assert.equal(after['canContinue'], false);
  }
});

test('calendar selector uses the shared primary collector and never retries a failed page', async () => {
  for (const fail of [false, true]) {
    const h = fixture(Array.from({ length: 15 }, (_, n) => event(19, n)), { token: 'second', pageSize: 12 });
    h.deps.selector = { select: async () => ({ questionClass: 'quick_fact', actions: [{ kind: 'calendar_window', window: 'this week' }], pUseful: { calendar_window: 1 } }) };
    const execute = h.deps.execute;
    let calls = 0;
    h.deps.execute = async (subs, abort) => {
      calls += subs.filter(call => call.name === 'calendar_list_events').length;
      if (fail) return subs.map(call => ({ key: call.key, name: call.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'transport_unavailable' }));
      return execute(subs, abort);
    };
    const reply = await runResearch(h.deps, { action: 'start', question: 'calendar this week', sources: 'calendar' }, signal());
    assert.equal(calls, fail ? 1 : 2);
    assert.ok(h.calls.filter(call => call['name'] === 'calendar_list_events').every(call => call['calendarId'] === 'primary'));
    if (!fail) {
      assert.equal(reply['canContinue'], true);
      const second = await runResearch(h.deps, { action: 'continue', researchId: String(reply['researchId']) }, signal());
      assert.match(JSON.stringify(second['findings']), /item 14/);
      assert.equal(calls, 2);
    }
  }
});

test('calendar collection keeps one source deadline across pages and resumes an undispatched exact cursor', async () => {
  for (const deadline of [false, true]) {
    const h = fixture([]);
    let clock = fixedNow;
    h.deps.now = () => clock;
    const tokens: (string | undefined)[] = [];
    h.deps.execute = async subs => subs.map(call => {
      if (call.name !== 'calendar_list_events') return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 };
      const token = call.args['pageToken'] as string | undefined;
      tokens.push(token);
      const n = token ? Number(token) : 0;
      if (deadline) clock += 5000;
      return { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: [event(19, n)], ...(n < 9 ? { nextPageToken: String(n + 1) } : {}) }) };
    });
    const first = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
    assert.equal(tokens.length, deadline ? 3 : 7, 'source deadline is shared; maxOps also includes the scope read');
    if (deadline) {
      assert.equal((first['calendarCoverage'] as Record<string, unknown>)['received'], 2, 'the third page missed the one source deadline');
      assert.equal((first['calendarCoverage'] as Record<string, unknown>)['failed'], true);
    } else assert.equal(first['canContinue'], true);
    await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, signal());
    assert.equal(tokens.length, deadline ? 3 : 10);
    assert.equal(new Set(tokens).size, tokens.length, 'each exact page dispatched once, failed pages never retried');
  }
});

test('calendar delivery advances exact event identities even when bounded text is identical', async () => {
  const h = fixture(Array.from({ length: 10 }, (_, n) => ({ id: `event-${n}`, start: '2026-10-19T10:00:00Z', summary: 'Identical long title '.repeat(30) })));
  h.deps.replyLimit = 3_000;
  const first = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
  const shown = Number((first['calendarCoverage'] as Record<string, unknown>)['shown']);
  assert.ok(shown > 0 && shown < 10, 'a reply over its byte budget leaves identical events for the continuation');
  assert.match(String(first['note']), /left out \d+ calendar events/u);
  const second = await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, signal());
  assert.equal((second['calendarCoverage'] as Record<string, unknown>)['shown'], 10 - shown, 'delivery advances by identity, never by identical text');
  assert.equal(second['canContinue'], false);
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 1);
});

test('calendar in-flight continuation retains received events and never replays the already dispatched pending page', async () => {
  const h = fixture(Array.from({ length: 15 }, (_, n) => event(19, n)), { token: 'second', pageSize: 12 });
  let due: (() => void) | undefined;
  h.deps.schedule = (callback, delay) => { if (delay === 4500) due = callback; return { unref() {}, cancel() {} }; };
  let pageStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { pageStarted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = h.deps.execute;
  h.deps.execute = async (calls, abort) => {
    if (calls.some(call => call.args['pageToken'])) { pageStarted(); await held; }
    return execute(calls, abort);
  };
  const scheduler = new ResearchScheduler(h.deps);
  const firstPromise = scheduler.call({ action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
  await started;
  assert.ok(due); due();
  const first = await firstPromise;
  assert.equal((first['calendarCoverage'] as Record<string, unknown>)['shown'], 12, 'the whole first page is spoken, not eight events of it');
  const next = await scheduler.call({ action: 'continue', researchId: String(first['researchId']) }, signal());
  assert.equal((next['calendarCoverage'] as Record<string, unknown>)['shown'], 0, 'every received event was delivered by the first reply');
  assert.equal((next['calendarCoverage'] as Record<string, unknown>)['failed'], true, 'the superseded pending page cannot be replayed');
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 2);
});

test('calendar R4: real selector JSON parsing preserves named windows and refuses invalid or missing windows', async () => {
  for (const window of ['Wednesday this week', 'next Wednesday', 'this week', 'whenever', 42, undefined]) {
    const h = fixture([event(21), event(28)]);
    h.deps.timeZone = 'UTC';
    // W2: one configured source has nothing to select, so a selector round needs a second source.
    h.deps.configured = ['calendar', 'mail'];
    h.deps.selector = createGeminiSelector({ generate: async () => ({
      status: 'complete', text: JSON.stringify({ questionClass: 'quick_fact', actions: [{ kind: 'calendar_window', ...(window !== undefined ? { window } : {}) }], pUseful: { calendar_window: 1 } }),
      providerContent: { role: 'model', parts: [] }, reason: 'synthetic', prompt: { version: 'synthetic', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null },
    }) });
    const reply = await runResearch(h.deps, { action: 'start', question: 'Synthetic named calendar window' }, signal());
    const calls = h.calls.filter(call => call['name'] === 'calendar_list_events');
    if (typeof window === 'string' && window !== 'whenever') {
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!['timeMin'], windowRange(window, fixedNow, 'UTC').timeMin, String(window));
    } else {
      assert.equal(calls.length, 0, String(window));
      assert.match(String(reply['note']), /could not resolve/);
    }
  }
});

test('calendar R5: scheduler Stop invalidates a completed retained run before later Continue', async () => {
  const h = fixture(Array.from({ length: 12 }, (_, n) => event(19, n)));
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'Synthetic week', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
  const id = String(first['researchId']);
  const calls = h.calls.length;
  const stopped = await scheduler.call({ action: 'stop', researchId: id }, signal());
  assert.equal(h.deps.ledger.find(id)?.stopped, true);
  assert.equal(stopped['canContinue'], false);
  assert.deepEqual(stopped['findings'], []);
  const after = await scheduler.call({ action: 'continue', researchId: id }, signal());
  assert.deepEqual(after['findings'], []);
  assert.equal(after['canContinue'], false);
  assert.equal(h.calls.length, calls);
});

test('calendar R6: a distinct Scheduler Start owns a new window and invalidates in-flight retained evidence', async () => {
  const h = fixture([]);
  h.deps.timeZone = 'UTC';
  let due: (() => void) | undefined, entered!: () => void, release!: () => void;
  h.deps.schedule = (callback, delay) => { if (delay === 4500) due = callback; return { unref() {}, cancel() {} }; };
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const late: string[] = [];
  h.deps.late = event => { if (event.items.length) late.push(event.researchId); };
  h.deps.execute = async subs => {
    h.calls.push(...subs.map(call => ({ name: call.name, ...call.args })));
    if (subs.some(call => call.args['pageToken'])) { entered(); await held; }
    return subs.map(call => call.name === 'calendar_list_calendars'
      ? { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 }
      : { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: Array.from({ length: 12 }, (_, n) => ({ id: `${call.args['timeMin']}:${n}`, start: call.args['timeMin'], summary: `Synthetic ${call.args['timeMin']} event ${n}` })), ...(!call.args['pageToken'] && String(call.args['timeMin']).startsWith('2026-10-19') ? { nextPageToken: 'held-monday-page' } : {}) }) });
  };
  const scheduler = new ResearchScheduler(h.deps);
  const pending = scheduler.call({ action: 'start', question: 'Synthetic Monday', lookups: [{ source: 'calendar', query: 'Monday this week' }] }, signal());
  await started; assert.ok(due); due();
  const first = await pending;
  try {
    const next = await scheduler.call({ action: 'start', question: 'Synthetic Wednesday', lookups: [{ source: 'calendar', query: 'Wednesday this week' }] }, signal());
    assert.notEqual(next['researchId'], first['researchId']);
    assert.equal(h.deps.ledger.evidenceCurrent(String(first['researchId'])), false);
    assert.match(JSON.stringify(next['findings']), /2026-10-21/);
    assert.doesNotMatch(JSON.stringify(next['findings']), /2026-10-19/);
    const old = await scheduler.call({ action: 'continue', researchId: String(first['researchId']) }, signal());
    assert.deepEqual(old['findings'], []); assert.equal(old['canContinue'], false);
  } finally { release(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call['pageToken'] === 'held-monday-page').length, 1);
  assert.deepEqual(late, [], 'the superseded calendar source cannot publish late findings');
});

test('calendar R5: omitted-id Stop resolves and invalidates the last completed run in both owners', async () => {
  for (const schedulerOwner of [false, true]) {
    const h = fixture(Array.from({ length: 12 }, (_, n) => event(19, n)));
    const scheduler = new ResearchScheduler(h.deps);
    const call = (input: Parameters<typeof runResearch>[1]) => schedulerOwner ? scheduler.call(input, signal()) : runResearch(h.deps, input, signal());
    const first = await call({ action: 'start', question: 'Synthetic week', lookups: [{ source: 'calendar', query: 'week' }] });
    await call({ action: 'stop' });
    assert.equal(h.deps.ledger.find(String(first['researchId']))?.stopped, true);
    const after = await call({ action: 'continue', researchId: String(first['researchId']) });
    assert.deepEqual(after['findings'], []); assert.equal(after['canContinue'], false);
  }
});

test('calendar R6: an explicit retired id cannot retarget a different pending run', async () => {
  const h = fixture(Array.from({ length: 12 }, (_, n) => event(19, n)));
  h.deps.timeZone = 'UTC';
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'Synthetic Monday', lookups: [{ source: 'calendar', query: 'Monday this week' }] }, signal());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = h.deps.execute;
  h.deps.execute = async (subs, abort) => { if (subs.some(call => String(call.args['timeMin']).startsWith('2026-10-21'))) { entered(); await held; } return execute(subs, abort); };
  const next = scheduler.call({ action: 'start', question: 'Synthetic Wednesday', lookups: [{ source: 'calendar', query: 'Wednesday this week' }] }, signal());
  await started;
  const current = h.deps.ledger.last()!;
  try {
    const retired = await scheduler.call({ action: 'continue', researchId: String(first['researchId']) }, signal());
    assert.equal(retired['researchId'], first['researchId']);
    assert.deepEqual(retired['findings'], []);
    assert.equal(h.deps.ledger.find(current.researchId)?.stopped, false);
    assert.equal(h.deps.ledger.find(current.researchId)?.cancelled, false);
    const unknown = await scheduler.call({ action: 'stop', researchId: 'unminted-id' }, signal());
    assert.equal(unknown['error'], 'unknown_research_run');
    assert.equal(h.deps.ledger.find(current.researchId)?.stopped, false);
  } finally { release(); }
  await next;
});

// --- #1020: a calendar answer states the window it read -------------------------------------------

test('#1020: a week-long calendar read whose events sit in one day says so, and is never spoken as a clear week', async () => {
  const h = fixture([event(21)]);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  assert.match(String(reply['note']), /calendar: covers Wed 21 Oct only; the rest of Mon 19 Oct to Sun 25 Oct was NOT read/, 'the covered days and the days never covered are said in one line');
  assert.deepEqual((reply['findings'] as { source: string }[]).map(finding => finding.source), ['calendar'], 'the one day it did cover still answers');
});

test('#1020: a paged calendar read never claims more shown than total, and a cut one says what it missed', async () => {
  const h = fixture([event(21), event(22), event(23)], { token: 'second', pageSize: 2 });
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  for (const finding of (reply['findings'] ?? []) as { text: string }[]) {
    for (const match of finding.text.matchAll(/(\d+) of (\d+) shown/gu)) assert.ok(Number(match[1]) <= Number(match[2]), `${match[0]} in ${finding.text.split('\n')[0]}`);
  }
});

// W2: the calendar fan-out is bounded by the run's own source budget, never by the connector's constant.

test('every calendar read carries the run remaining source budget as an absolute deadline', async () => {
  const h = fixture([event(19)]);
  await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'today' }] }, signal());
  const reads = h.calls.filter(call => call['name'] === 'calendar_list_events');
  assert.ok(reads.length > 0, 'the run read the calendar');
  for (const call of reads) assert.equal(call['deadlineAt'], fixedNow + 12_000, 'the connector is bounded by the caller budget, never by the 40 s constant');
});

test('E8: a whole calendar week comes back at once, one compact line per day', async () => {
  const events = [...Array.from({ length: 8 }, (_, n) => event(19, n)), ...Array.from({ length: 4 }, (_, n) => event(20, n)), event(21), event(22), event(23)];
  const h = fixture(events);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'calendar')!;
  assert.match(finding.text, /^calendar: 23 of 23 shown/u);
  for (const title of ['Day 19 item 0', 'Day 19 item 7', 'Day 20 item 3', 'Day 21 item 0', 'Day 23 item 0']) assert.match(finding.text, new RegExp(title, 'u'));
  assert.equal(finding.text.split('\n').length - 1, 5, 'one line per day, not one line per event');
  assert.equal(reply['canContinue'], false);
  assert.equal(reply['note'], undefined, 'a whole window needs no trim line');
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 1, 'the whole window is one read');
  assert.ok(Number(h.calls.find(call => call['name'] === 'calendar_list_events')!['maxResults']) > 12, 'the read asks for the window, not one page of twelve');
});

test('E8: a trimmed calendar answer says how many events it left out', async () => {
  const events = Array.from({ length: 30 }, (_, n) => ({ id: `e${n}`, start: `2026-10-${19 + Math.floor(n / 6)}T${String(10 + (n % 6)).padStart(2, '0')}:00:00Z`, summary: `Budget item ${n} with a long title that fills the reply budget` }));
  const h = fixture(events);
  h.deps.replyLimit = 900;
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  const shown = Number((reply['calendarCoverage'] as Record<string, unknown>)['shown']);
  assert.ok(shown > 0 && shown < 30, 'the byte budget trims the answer instead of the window being cut to eight events');
  assert.match(String(reply['note']), /I left out \d+ calendar events to keep this answer short\./u);
  assert.equal(reply['canContinue'], true, 'the left-out events are still reachable');
});

test('E8: one calendar list and one window read per live session', async () => {
  const h = fixture(Array.from({ length: 6 }, (_, n) => event(20, n)));
  const scheduler = new ResearchScheduler(h.deps);
  const first = await scheduler.call({ action: 'start', question: 'what is on this week', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  const second = await scheduler.call({ action: 'start', question: 'overview of the week ahead', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  assert.notEqual(first['researchId'], second['researchId']);
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 1, 'the same window inside the turn window is never fetched twice');
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_calendars').length, 1, 'the calendar list is read once per session');
  assert.match(JSON.stringify(second['findings']), /Day 20 item 0/u);
});

test('E8: a cancelled run keeps the window it paid for, and the next run reuses it', async () => {
  const h = fixture(Array.from({ length: 6 }, (_, n) => event(21, n)));
  const scheduler = new ResearchScheduler(h.deps);
  const abandoned = new AbortController();
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = h.deps.execute;
  h.deps.execute = async (calls, abort) => {
    if (calls.some(call => call['name'] === 'calendar_list_events')) { started(); await held; }
    return execute(calls, abort);
  };
  const firstRun = scheduler.call({ action: 'start', question: 'what is on this week', lookups: [{ source: 'calendar', query: 'this week' }] }, abandoned.signal);
  await began;
  abandoned.abort();
  release();
  await firstRun;
  h.deps.execute = execute;
  const next = await scheduler.call({ action: 'start', question: 'and the week ahead', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 1, 'the window the cancelled run paid for is reused, never fetched again');
  assert.match(JSON.stringify(next['findings']), /Day 21 item 0/u);
});
