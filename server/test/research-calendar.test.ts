import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESEARCH, ResearchLedger, ResearchScheduler, calendarWindowOf, candidateSubs, configuredSourcesForEndpoints, ownerScheduleQuestion, runResearch, windowRange, type ResearchDeps, type ResearchMemo, type ResearchRunLog, type SourceKind } from '../tools/research.js';
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
  assert.equal(first['canContinue'], false, 'both pages of the window are read and spoken in the one run');
  const text = JSON.stringify(first['findings']);
  assert.match(text, /Day 21/); assert.match(text, /Day 22/); assert.match(text, /Day 23/);
  assert.doesNotMatch(text, /27 of 24/);
  await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, signal());
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 2, 'retained events are not reread');
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

test('calendar uses the shared primary collector and never retries a failed page', async () => {
  for (const fail of [false, true]) {
    const h = fixture(Array.from({ length: 15 }, (_, n) => event(19, n)), { token: 'second', pageSize: 12 });
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
      assert.equal(reply['canContinue'], false, 'both pages of the window are read in the one run');
      assert.match(JSON.stringify(reply['findings']), /item 14/);
      const second = await runResearch(h.deps, { action: 'continue', researchId: String(reply['researchId']) }, signal());
      assert.equal(JSON.stringify(second['findings']), '[]', 'a completed window leaves nothing to continue');
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
      if (deadline) clock += 5_000;
      return { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: [event(19, n)], ...(n < 9 ? { nextPageToken: String(n + 1) } : {}) }) };
    });
    const first = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
    // R1: the patience budget is 15 s, so pages start while 5 s more fits: two pages (0 and 5 s), and the third
    // (10 s + 5 s = 15 s) is never started. Exact counts, re-derived from the budget, never lower bounds.
    assert.equal(tokens.length, deadline ? 2 : 7, 'no page starts that cannot finish inside the 15 s patience budget');
    if (deadline) {
      assert.equal((first['calendarCoverage'] as Record<string, unknown>)['received'], 2, 'the pages that fit are kept');
      assert.equal((first['calendarCoverage'] as Record<string, unknown>)['failed'], false, 'a page never started is not a failed page');
      const row = (first['sourceCoverage'] as Record<string, unknown>[]).find(entry => entry['source'] === 'calendar');
      assert.equal(row?.['stop'], 'deadline'); assert.equal(row?.['more'], 'upstream');
    } else assert.equal(first['canContinue'], true);
    await runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, signal());
    assert.equal(tokens.length, deadline ? 4 : 10, 'the follow-up reads on from the kept cursor inside its own 15 s budget');
    assert.equal(new Set(tokens).size, tokens.length, 'each exact page dispatched once, failed pages never retried');
  }
});

test('calendar delivery advances exact event identities even when bounded text is identical', async () => {
  const h = fixture(Array.from({ length: 10 }, (_, n) => ({ id: `event-${n}`, start: '2026-10-19T10:00:00Z', summary: 'Identical long title '.repeat(30) })));
  h.deps.replyLimit = 1_000;
  const first = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'week' }] }, signal());
  const shown = Number((first['calendarCoverage'] as Record<string, unknown>)['shown']);
  assert.ok(shown > 0 && shown < 10, `a reply over its byte budget leaves identical events for the continuation: ${JSON.stringify(first['calendarCoverage'])} ${JSON.stringify(first['note'])}`);
  assert.match(String(first['note']), /left out \d+ calendar events/u);
  h.deps.replyLimit = 6_000;
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
  // K8b: a continue on a run with a read still in flight waits for it, bounded by the first-answer cut, and
  // never replays a page the first reply already carried.
  const nextPromise = scheduler.call({ action: 'continue', researchId: String(first['researchId']) }, signal());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(due !== undefined, 'the continue waits on its own first-answer cut');
  due();
  const next = await nextPromise;
  assert.equal((next['calendarCoverage'] as Record<string, unknown>)['shown'], 0, 'every received event was delivered by the first reply');
  assert.equal(next['status'], 'partial', 'a read still in flight leaves the answer partial');
  assert.match(String(next['note']), /calendar/, 'the read still running is named');
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 2);
});

test('calendar R4: the plan resolves the window itself, with no selector round', async () => {
  const h = scheduleFixture();
  await runResearch(h.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, signal());
  const read = h.calls.find(call => call.name === 'calendar_list_events');
  assert.ok(read !== undefined, 'the plan reads the calendar');
  assert.equal(read.args['timeMin'], windowRange('tomorrow', fixedNow, 'UTC').timeMin, 'tomorrow resolves to the real window start');
  // A question with no window word still names real dates, so the read is never open ended.
  const plain = scheduleFixture();
  await runResearch(plain.deps, { action: 'start', question: 'what is on my calendar' }, signal());
  const today = plain.calls.find(call => call.name === 'calendar_list_events');
  assert.ok(today !== undefined, 'the plan reads the calendar with no window word');
  assert.equal(today.args['timeMin'], windowRange('today', fixedNow, 'UTC').timeMin, 'the default window is today');
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
  const pending = scheduler.call({ action: 'start', question: 'Synthetic held read', lookups: [{ source: 'calendar', query: 'Monday this week' }] }, signal());
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
  const events = [...Array.from({ length: 8 }, (_, n) => event(19, n)), ...Array.from({ length: 8 }, (_, n) => event(20, n)), ...Array.from({ length: 4 }, (_, n) => event(21, n)), ...Array.from({ length: 2 }, (_, n) => event(22, n)), event(23)];
  const h = fixture(events);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'calendar')!;
  assert.match(finding.text, /^calendar: 23 of 23 shown/u);
  for (const title of ['Day 19 item 0', 'Day 19 item 7', 'Day 20 item 7', 'Day 21 item 3', 'Day 22 item 1', 'Day 23 item 0']) assert.match(finding.text, new RegExp(title, 'u'));
  assert.equal(finding.text.split('\n').filter(line => line.startsWith('- ')).length, 5, 'one line per day, not one line per event');
  assert.equal(reply['canContinue'], false);
  assert.match(String(reply['note']), /covers Mon 19 Oct to Fri 23 Oct/u);
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

// ROUTE-1022 K5: the brief's calendar read is the same primary window an explicit today read pays for,
// so a second identical brief read inside the memo window hits the live session's own memo entry.
test('ROUTE-1022 K5: a brief calendar read shares the memo key of an explicit today read', () => {
  const brief = candidateSubs('brief', { question: "what's on my calendar tomorrow", configured: ['calendar', 'knowledge'], evidence: new Map() });
  const read = brief.find(call => call.name === 'calendar_list_events');
  assert.ok(read !== undefined, 'a question about the schedule still reads the calendar');
  const explicit = candidateSubs('calendar_window', { question: 'today', configured: ['calendar'], evidence: new Map(), window: 'today' });
  assert.deepEqual(read.args, explicit[0]!.args, 'same args, so the calendar memo keys them the same');
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
  const memo: ResearchMemo = { calendar: new Map() };
  h.deps.memo = memo;
  const abandoned = new AbortController();
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = h.deps.execute;
  h.deps.execute = async (calls, abort) => {
    if (calls.some(call => call['name'] === 'calendar_list_events')) { started(); await held; }
    return execute(calls, abort);
  };
  const firstRun = runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, abandoned.signal);
  await began;
  abandoned.abort();
  release();
  await firstRun;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(memo.calendar.size, 1, 'the window the cancelled run paid for is kept for the session');
  h.deps.execute = execute;
  const next = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'this week' }] }, signal());
  assert.equal(h.calls.filter(call => call['name'] === 'calendar_list_events').length, 1, 'the kept window is reused, never fetched again');
  assert.match(JSON.stringify(next['findings']), /Day 21 item 0/u);
});

// ROUTE-1022 (D2): gmail and the calendar are two endpoints on one connector. A gmail endpoint that
// failed its identity proof marked the calendar unreachable too, so every calendar read was skipped.
function scheduleFixture(opts: { unavailable?: readonly { source: SourceKind; reason: string }[] } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const logs: ResearchRunLog[] = [];
  const deps: ResearchDeps = {
    now: () => fixedNow, configured: ['calendar', 'mail'], ledger: new ResearchLedger(), timeZone: 'UTC',
    ...(opts.unavailable === undefined ? {} : { unavailableNow: () => opts.unavailable! }),
    emit() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {}, log: entry => logs.push(entry),
    execute: async subs => subs.map(call => {
      calls.push({ name: call.name, args: { ...call.args } });
      if (call.name === 'calendar_list_calendars') return { key: call.key, name: call.name, ok: true, text: '- Main [primary]', originalCharacters: 16, omittedCharacters: 0 } as IntentSubResult;
      if (call.name === 'calendar_list_events') return { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: [{ id: 'e1', start: '2026-10-20T10:00:00Z', summary: 'Call with Priya' }] }) } as IntentSubResult;
      return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 } as IntentSubResult;
    }),
  };
  return { deps, calls, logs };
}

test('ROUTE-1022: a failed gmail endpoint leaves the calendar readable on a schedule question', async () => {
  const h = scheduleFixture({ unavailable: [{ source: 'mail', reason: 'identity_unverified' }] });
  // TRIAGE-R3: a bare "calls" is the product's daily language, so this ask names its schedule by a word
  // the calendar class keeps, and stays a mail-plus-calendar question.
  const reply = await runResearch(h.deps, { action: 'start', question: 'check my mail and my meetings tomorrow' }, signal());
  assert.ok(h.calls.some(call => call.name === 'calendar_list_events'), 'the calendar endpoint connected, so its read runs');
  assert.equal(h.calls.some(call => call.name === 'gmail_search_messages'), false, 'the mail endpoint is never dispatched to');
  const rows = h.logs.at(-1)!.sources;
  assert.equal(rows.find(row => row.kind === 'calendar')?.disposition, 'completed', 'the calendar read is logged as served');
  assert.deepEqual({ disposition: rows.find(row => row.kind === 'mail')?.disposition, reason: rows.find(row => row.kind === 'mail')?.reason },
    { disposition: 'skipped', reason: 'endpoint_unavailable' }, 'and mail is skipped for the endpoint reason, not silently');
  assert.equal('error' in reply, false);
});

test('ROUTE-1022: a schedule question reads the calendar with no selector in the path', async () => {
  const h = scheduleFixture({ unavailable: [{ source: 'mail', reason: 'identity_unverified' }] });
  assert.equal('selector' in h.deps, false, 'the voice path carries no selector to wait on');
  await runResearch(h.deps, { action: 'start', question: 'what is on my schedule tomorrow' }, signal());
  assert.ok(h.calls.some(call => call.name === 'calendar_list_events'), 'the plan reads the calendar with no selector round');
  assert.equal(h.logs.at(-1)!.driver, 'routed', 'and the run records the router as the decider');
});

test('ROUTE-1022: a schedule question always reads the calendar', async () => {
  const h = scheduleFixture();
  assert.equal(ownerScheduleQuestion('what is on my schedule tomorrow'), true, 'the owner schedule rule names this question');
  await runResearch(h.deps, { action: 'start', question: 'what is on my schedule tomorrow' }, signal());
  assert.ok(h.calls.some(call => call.name === 'calendar_list_events'), 'the owner schedule question reads the calendar');
});

test('ROUTE-1022: a calendar endpoint that is down is skipped with its reason and no error', async () => {
  const h = scheduleFixture({ unavailable: [{ source: 'calendar', reason: 'not_signed_in' }] });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my schedule tomorrow' }, signal());
  assert.equal(h.calls.some(call => call.name === 'calendar_list_events'), false, 'a down endpoint is never dispatched to');
  assert.equal(h.logs.at(-1)!.sources.find(row => row.kind === 'calendar')?.reason, 'endpoint_unavailable', 'the reason names an endpoint outage');
  assert.equal('error' in reply, false, 'the run still answers');
});

// ROUTE-R2: a grant gap and an outage both read `skipped` before, so a missing read grant looked
// exactly like a dead endpoint in the run log.
test('ROUTE-R2: an unpublished calendar grant is logged as not_granted, not as an outage', async () => {
  const h = scheduleFixture({ unavailable: [{ source: 'calendar', reason: 'source_not_granted' }] });
  await runResearch(h.deps, { action: 'start', question: 'what is on my schedule tomorrow' }, signal());
  const row = h.logs.at(-1)!.sources.find(entry => entry.kind === 'calendar');
  assert.deepEqual({ disposition: row?.disposition, reason: row?.reason }, { disposition: 'skipped', reason: 'not_granted' });
});

// ROUTE-1022: the host registry keys the two Google endpoints `gmail` and `calendar`, both with
// connector `google`. Availability must follow the endpoint id, never the connector.
test('ROUTE-1022: end-to-end availability follows the endpoint id, not the shared connector', () => {
  assert.deepEqual(configuredSourcesForEndpoints([
    { id: 'calendar', connector: 'google', state: 'connected' },
    { id: 'gmail', connector: 'google', state: 'error', reasonCode: 'identity_unverified' },
  ]), [{ source: 'mail', reason: 'identity_unverified' }], 'a failed gmail proof names mail alone');
  assert.deepEqual(configuredSourcesForEndpoints([
    { id: 'gmail', connector: 'google', state: 'connected' },
    { id: 'calendar', connector: 'google', state: 'error', reasonCode: 'not_signed_in' },
  ]), [{ source: 'calendar', reason: 'not_signed_in' }], 'and a calendar failure never speaks for mail');
});

test('ROUTE-1022: a general question about the week does not force a calendar read', async () => {
  const h = scheduleFixture();
  await runResearch(h.deps, { action: 'start', question: 'what did the team say this week' }, signal());
  // F8: bare "week" is the product's daily language, so the forcing rule stays with the questions the defect named.
  assert.equal(ownerScheduleQuestion('what did the team say this week'), false);
});

// --- F7: a calendar list with a further page says nothing about the window that was asked for ---

test('F7: a partially read calendar list never takes the completion line from a complete reply', async () => {
  const h = fixture([event(19)]);
  h.deps.execute = async subs => subs.map(call => call.name === 'calendar_list_calendars'
    ? { key: call.key, name: call.name, ok: true, text: '- Work [work@example.com]\n- Home [home@example.com]', originalCharacters: 40, omittedCharacters: 0, calendarScope: { received: 20, partial: true } }
    : { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: [event(19)] }) });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar today' }, signal());
  assert.equal(reply['calendarCoverage'] !== undefined, true, 'the calendar was read');
  assert.equal((reply['calendarCoverage'] as Record<string, unknown>)['calendarListComplete'], false, 'the list really is partial');
  assert.equal(reply['note'], RESEARCH.completeNote, 'and the completion line is still there, never displaced by the list flag');
});

// --- Release 4: an unresolved window is its own reason, and a resolvable one still reads -----------

test('release 4: a window the grammar cannot resolve names its own reason instead of an endpoint outage', async () => {
  const h = fixture([event(20)]);
  const reply = await runResearch(h.deps, {
    action: 'start',
    lookups: [{ source: 'calendar', query: 'sometime soon' }, { source: 'calendar', query: 'tomorrow' }],
  }, signal());
  assert.ok(h.calls.some(call => call.name === 'calendar_list_events'), 'the resolvable window still reads the calendar');
  const unavailable = reply['unavailable'] as Record<string, string> | undefined;
  assert.equal(unavailable?.['calendar'], 'window_unparsed', 'the reason is the closed window token, never an endpoint outage');
  assert.match(String(reply['note']), /could not resolve that calendar date or window/u, 'and the reply carries the guidance the model voices');
  assert.equal(/endpoint_unavailable/u.test(JSON.stringify(reply)), false, 'no outage is claimed for a window the grammar cannot parse');
});

test('#574: a day read prints the attendee names it was given', async () => {
  const party = Array.from({ length: 12 }, (_, n) => ({ displayName: `Person ${n}` }));
  const h = fixture([{ id: 'a1', start: '2026-10-19T09:00:00Z', summary: 'Design review', attendees: party }]);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'today' }] }, signal());
  const text = JSON.stringify(reply['findings']);
  assert.match(text, /Person 7/);
  assert.doesNotMatch(text, /Person 8/, 'the ninth name is never spoken');
  assert.match(text, /12 people: /u, 'the true head count is given');
  assert.match(text, /and 4 more/, 'the four names left out are counted');
  assert.match(text, /Person 0, Person 1, Person 2, Person 3, Person 4, Person 5, Person 6, Person 7 and 4 more/u, 'every spoken name is whole');
});

test('L8-01: a day read carries the organizer and the true head count, never a character marker', async () => {
  const party = [{ displayName: 'Robin Vale' }, { displayName: 'Ari Andor' }, { email: 'dana.d@example.invalid' }, { email: 'kim.l@example.invalid' }];
  const h = fixture([{ id: `${'e'.repeat(60)}_${'7'.repeat(79)}`, start: '2026-10-19T09:00:00Z', summary: 'Re: demo / Example', attendees: party,
    organizer: { displayName: 'Wes Rowan' }, htmlLink: 'https://calendar.google.com/event?eid=e1', description: 'Agenda. '.repeat(40) },
    { id: 'b2', start: '2026-10-19T11:00:00Z', summary: 'Second meeting', attendees: [{ displayName: 'Robin Vale' }] }]);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'today' }] }, signal());
  const text = JSON.stringify(reply['findings']);
  assert.match(text, /attendees: 4 people: Robin Vale, Ari Andor, dana\.d@example\.invalid, kim\.l@example\.invalid/u, `every attendee reaches the answer: ${text}`);
  assert.match(text, /organizer: Wes Rowan/u, `the organizer reaches the answer: ${text}`);
  assert.equal(/\+\d+ chars/u.test(text), false, `no character count marker: ${text}`);
});

test('#574: a long header never cuts a name from the attendee list', () => {
  const party = Array.from({ length: 12 }, (_, n) => ({ displayName: `Person ${n}` }));
  const shaped = shapeGcalList({ events: [{ id: 'a1', start: '2026-10-19T09:00:00Z', summary: 'Design review', location: 'L'.repeat(200), attendees: party }] });
  const line = shaped.text.split('\n').find(entry => entry.trimStart().startsWith('attendees: '));
  assert.ok(line !== undefined, 'the attendees line survives the event bound');
  assert.match(line.trim(), /^attendees: 12 people: (Person \d+(, Person \d+)* and \d+ more|Person \d+(, Person \d+)*)$/u, `no name is cut: ${line}`);
  const spoken = line.match(/Person \d+/gu)?.length ?? 0;
  const others = /and (\d+) more/u.exec(line)?.[1];
  assert.equal(spoken + Number(others ?? 0), 12, `every attendee is either spoken or counted: ${line}`);
  assert.ok(spoken < 12, 'a header this long cannot carry every name');
});

test('#574: a helper that truncated its own attendee list never gets a spoken headcount', () => {
  const party = Array.from({ length: 12 }, (_, n) => ({ displayName: `Person ${n}` }));
  const shaped = shapeGcalList({ events: [{ id: 'a1', start: '2026-10-19T09:00:00Z', summary: 'Design review', attendees: party, attendeesOmitted: true }] });
  const line = shaped.text.split('\n').find(entry => entry.trimStart().startsWith('attendees: '));
  assert.ok(line !== undefined, 'the attendees line survives the event bound');
  assert.match(line.trim(), / and others$/u, `a truncated source list only supports the unnumbered form: ${line}`);
  assert.doesNotMatch(line, /\d+ others/u, `and never a count the helper did not send: ${line}`);
});

test('#3: an empty calendar read says the calendar was searched, never that it was skipped', async () => {
  const h = fixture([]);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'today' }] }, signal());
  const note = String(reply['note'] ?? '');
  assert.equal(/did not search/u.test(note), false, `the calendar was read, so the note never says it was skipped: ${note}`);
  assert.match(note, /I searched your calendar/u, `the note names the read it made: ${note}`);
});

test('#4: the calendar counts add up, shown plus left out equals the total', async () => {
  const events = Array.from({ length: 15 }, (_, n) => ({ id: `b${n}`, start: `2026-10-19T${String(9 + n).padStart(2, '0')}:00:00Z`, summary: `Booking ${n} with a long enough name to spend the reply room` }));
  const h = fixture(events);
  h.deps.replyLimit = 1_400;
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'today' }] }, signal());
  const text = JSON.stringify(reply);
  const header = /calendar: (\d+) of (\d+) shown/u.exec(text);
  const note = /I left out (\d+) calendar events?/u.exec(text);
  assert.ok(header !== null, `the reply carries a calendar count: ${text.slice(0, 400)}`);
  const leftOut = note === null ? 0 : Number(note[1]);
  assert.equal(Number(header[1]) + leftOut, Number(header[2]), `shown plus left out equals the total, got ${header[0]} and ${note?.[0] ?? 'no omission note'}`);
});

test('#5: the window grammar reads every declared form out of the sentence and refuses the rest', async () => {
  const table: [string, string][] = [
    ['what is on my calendar tomorrow', 'tomorrow'],
    ['what do I have on Wednesday', 'wednesday'],
    ['what does next week look like', 'next week'],
    ['what is on my calendar this week', 'this week'],
    ['meetings on 2026-10-17', '2026-10-17'],
  ];
  for (const [question, window] of table) assert.equal(calendarWindowOf(question), window, question);
  assert.equal(calendarWindowOf('anything about the release'), '', 'a sentence with no window word names none');
  assert.equal(calendarWindowOf('what is on my calendar', 'today'), 'today', 'a caller may name today for a question that carries no window');
  assert.equal(calendarWindowOf('Wednesday tomorrow'), '', 'two window words name no single window');
  assert.equal(calendarWindowOf('the week after next', 'today'), '', 'a window word the grammar cannot read is never today');
});

test('#5: a day read follows the sentence, and an unparseable window reads nothing', async () => {
  const events = [event(19)];
  const tomorrow = fixture(events);
  await runResearch(tomorrow.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'tomorrow' }] }, signal());
  const read = tomorrow.calls.find(call => call['name'] === 'calendar_list_events')!;
  assert.equal(read['timeMin'], '2026-10-20T00:00:00.000Z', 'tomorrow is the day after the fixture clock');
  const none = fixture(events);
  const reply = await runResearch(none.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'the week after next' }] }, signal());
  assert.equal(none.calls.filter(call => call['name'] === 'calendar_list_events').length, 0, 'an unparseable window reads nothing');
  assert.equal((reply['unavailable'] as Record<string, string> | undefined)?.['calendar'], 'window_unparsed');
});

test('#7: a single-day read drops the previous day all-day entry and keeps the day own all-day entry', async () => {
  const h = fixture([
    { id: 'allday-prev', start: '2026-10-18', summary: 'Company offsite' },
    { id: 'allday-today', start: '2026-10-19', summary: 'Release day' },
    { id: 'timed', start: '2026-10-19T09:00:00Z', summary: 'Standup' },
  ]);
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: 'today' }] }, signal());
  const text = JSON.stringify(reply['findings']);
  assert.doesNotMatch(text, /Company offsite/, 'the prior day all-day entry is not part of this answer');
  assert.match(text, /Release day/, 'the day own all-day entry stays, with no invented time');
  assert.match(text, /Standup/);
});

// C-CAL8: a synthetic day at a fixed local time, so a window, a cap and an ordering are read as the owner sees them.
function dayFixture(events: Record<string, unknown>[], opts: { now?: number; replyLimit?: number; configured?: readonly SourceKind[] } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const now = opts.now ?? fixedNow;
  const deps: ResearchDeps = {
    now: () => now, configured: opts.configured ?? ['calendar'], ledger: new ResearchLedger(), timeZone: 'UTC',
    ...(opts.replyLimit === undefined ? {} : { replyLimit: opts.replyLimit }),
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {},
    execute: async subs => subs.map(call => {
      calls.push({ name: call.name, args: { ...call.args } });
      if (call.name === 'calendar_list_calendars') return { key: call.key, name: call.name, ok: true, text: '- Main [primary]', originalCharacters: 16, omittedCharacters: 0 } as IntentSubResult;
      if (call.name === 'calendar_list_events') {
        const start = Date.parse(String(call.args['timeMin']));
        const end = Date.parse(String(call.args['timeMax']));
        const within = events.filter(event => Date.parse(String(event['start'])) >= start && Date.parse(String(event['start'])) < end);
        return { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: within }) } as IntentSubResult;
      }
      return { key: call.key, name: call.name, ok: true, text: '- Synthetic evidence line', originalCharacters: 26, omittedCharacters: 0 } as IntentSubResult;
    }),
  };
  return { deps, calls };
}
const syntheticHour = (hour: number, summary = `Synthetic ${hour}`): Record<string, unknown> => ({ id: `s${hour}`, start: `2026-10-19T${String(hour).padStart(2, '0')}:00:00Z`, summary });
const dayHours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

test('C-CAL8: a schedule ask at 13:43 reads and speaks the rest of the day from now, never the meetings already past', async () => {
  const now = Date.parse('2026-10-19T13:43:00Z');
  const h = dayFixture(dayHours.map(hour => syntheticHour(hour)), { now });
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is my schedule today' }, signal());
  const read = h.calls.find(call => call.name === 'calendar_list_events');
  assert.ok(read !== undefined, 'the schedule ask reads the calendar');
  assert.equal(read.args['timeMin'], '2026-10-19T13:43:00.000Z', 'today starts at now, not at local midnight');
  assert.equal(read.args['timeMax'], '2026-10-20T00:00:00.000Z', 'the end of the owner day is unchanged');
  const text = JSON.stringify(reply['findings']);
  for (const hour of [14, 15, 16, 17]) assert.match(text, new RegExp(`Synthetic ${hour}\\b`), `the meetings still ahead are spoken: ${hour}`);
  for (const hour of [8, 9, 10, 11, 12, 13]) assert.doesNotMatch(text, new RegExp(`Synthetic ${hour}\\b`), `a meeting already past is not offered as the rest of the day: ${hour}`);
});

test('C-CAL8: a schedule ask that names the morning keeps the past, and tomorrow is unchanged', async () => {
  const now = Date.parse('2026-10-19T13:43:00Z');
  const morning = dayFixture(dayHours.map(hour => syntheticHour(hour)), { now });
  await runResearch(morning.deps, { action: 'start', question: 'what happened on my calendar this morning' }, signal());
  assert.equal(morning.calls.find(call => call.name === 'calendar_list_events')?.args['timeMin'], '2026-10-19T00:00:00.000Z', 'the morning ask reads from local midnight');
  const tomorrow = dayFixture(dayHours.map(hour => syntheticHour(hour)), { now });
  await runResearch(tomorrow.deps, { action: 'start', question: 'what is on my calendar tomorrow' }, signal());
  assert.equal(tomorrow.calls.find(call => call.name === 'calendar_list_events')?.args['timeMin'], '2026-10-20T00:00:00.000Z', 'tomorrow still starts at its own midnight');
});

test('C-CAL8: under cap pressure the calendar drops the events already past, keeps the last of the day and counts what it left out', async () => {
  const now = Date.parse('2026-10-19T13:43:00Z');
  const events = dayHours.map(hour => syntheticHour(hour, `Synthetic ${hour} ${'detail '.repeat(12).trim()}`));
  const h = dayFixture(events, { now, replyLimit: 900 });
  const reply = await runResearch(h.deps, { action: 'start', lookups: [{ source: 'calendar', query: '2026-10-19' }] }, signal());
  const text = JSON.stringify(reply['findings']);
  assert.match(text, /Synthetic 17\b/, 'the last meeting of the day survives the cap');
  assert.doesNotMatch(text, /Synthetic 8\b/, 'the earliest meeting is the first one dropped');
  assert.match(text, /plus \d+ earlier events? left out/, `the reply names what it left out by count: ${text.slice(0, 300)}`);
  const shown = /calendar (\d+) of (\d+) shown/u.exec(text);
  assert.ok(shown !== null, `the calendar count is still spoken: ${text.slice(0, 200)}`);
  const leftOut = /plus (\d+) earlier/u.exec(text);
  assert.equal(Number(shown[1]) + Number(leftOut?.[1] ?? 0), Number(shown[2]), 'shown plus left out equals the total');
});
