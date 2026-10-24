import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarDigestCache, WarmContextCache, assembleContext, calendarDigestFreshMs, calendarDigestReadMs, calendarDigestRefreshMs, chooseStartContext, collectSections, signInNote, warmContextMaxAgeMs } from '../live/warm-context.js';
import { CALENDAR_DIGEST_READ_MS, readCalendarDigest, type CalendarDigestRead, type CalendarDigestReadResult, type GcalListInput, type GoogleResult } from '../connectors/google.js';
import { NAYA_LIVE_BASE, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, composeLiveInstruction, composeLiveSessionInstruction } from '../prompt/live-persona.js';

const sections = {
  persona: 'Naya is the owner\'s assistant.',
  memory: ['Prefers morning calls', 'Lives in Pune'],
  summary: 'Yesterday: release planning.',
  calendar: '10:00 standup, 15:00 review.',
};
/** What a source collection produces: the four slots, with no selection provenance. */
const collected = { ...sections, summaryIds: [] as readonly string[], summaryOmitted: [] as readonly { id: string; reason: 'budget' | 'stale' }[] };
/** What the owner adopts after building a real summary section. */
const withProvenance = { ...sections, summaryIds: ['summary-17'], summaryOmitted: [{ id: 'summary-03', reason: 'budget' as const }] };

/** A local, model-free source set: every getter is a counter, never a socket. */
function sources() {
  const calls = { persona: 0, memory: 0, summary: 0, calendar: 0 };
  return {
    calls,
    value: {
      persona: () => { calls.persona += 1; return sections.persona; },
      memory: () => { calls.memory += 1; return sections.memory; },
      summary: () => { calls.summary += 1; return sections.summary; },
      calendar: () => { calls.calendar += 1; return sections.calendar; },
    },
  };
}

test('the assembly carries persona, memory, the recent summary and the calendar digest in priority order', () => {
  assert.equal(assembleContext(collected, 4_000),
    'Persona: Naya is the owner\'s assistant.\n\n'
    + 'Remembered:\n- Prefers morning calls\n- Lives in Pune\n\n'
    + 'Recent conversation: Yesterday: release planning.\n\n'
    + 'Today: 10:00 standup, 15:00 review.');
});

test('a missing connector simply leaves its section out', () => {
  const text = assembleContext({ ...collected, calendar: undefined, summary: undefined }, 4_000);
  assert.doesNotMatch(text, /Today:/);
  assert.doesNotMatch(text, /Recent conversation:/);
  assert.match(text, /^Persona: /);
});

test('the instruction budget bounds the assembly and truncates in priority order', () => {
  const full = assembleContext(collected, 4_000);
  const bounded = assembleContext(collected, 30);
  assert.ok(bounded.length <= 30, 'the bounded assembly never exceeds the budget, got ' + bounded.length);
  assert.match(bounded, /^Persona: /);
  assert.doesNotMatch(bounded, /Today:/, 'the lowest priority section is what a tight budget drops');
  assert.ok(full.length > bounded.length, 'a larger budget keeps more');
});

test('every source is read exactly once per collection', () => {
  const local = sources();
  const read = collectSections(local.value);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 });
  assert.deepEqual(read, collected);
});

test('a warm start keeps the summary provenance it was assembled with, never empties', () => {
  let now = 900_000;
  const cache = new WarmContextCache({ budget: 4_000, now: () => now });
  cache.adopt(withProvenance);
  const start = chooseStartContext(cache.take(), () => {
    throw new Error('a warm start must not assemble again');
  });
  assert.deepEqual(start.sections.summaryIds, ['summary-17'], 'the selected summary ids travel with the section');
  assert.deepEqual(start.sections.summaryOmitted, [{ id: 'summary-03', reason: 'budget' }]);
});

test('start path A: an assembly inside ten minutes is used as it stands, with no second read', () => {
  const local = sources();
  let now = 1_000_000;
  const cache = new WarmContextCache({ sources: local.value, budget: 4_000, now: () => now });
  cache.refresh();
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 });

  now += warmContextMaxAgeMs - 1;
  const start = chooseStartContext(cache.take(), () => {
    throw new Error('a warm start must not assemble again');
  });
  assert.equal(start.warm, true);
  assert.deepEqual(start.sections, collected);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 }, 'the store is never read twice');
});

test('start path B: a stale or absent assembly is assembled now, and adopted for the next start', () => {
  const local = sources();
  let now = 2_000_000;
  const cache = new WarmContextCache({ sources: local.value, budget: 4_000, now: () => now });

  // Absent: the caller assembles, then adopts, so nothing is assembled twice.
  const absent = chooseStartContext(cache.take(), () => collectSections(local.value));
  assert.equal(absent.warm, false);
  assert.deepEqual(absent.sections, collected);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 });
  cache.adopt(absent.sections);
  assert.equal(cache.assemblies, 1);

  // The next start inside the window reuses what was adopted.
  now += warmContextMaxAgeMs - 1;
  const reused = chooseStartContext(cache.take(), () => {
    throw new Error('a warm start must not assemble again');
  });
  assert.equal(reused.warm, true);

  // Stale: ten minutes later the caller assembles again.
  now += 1;
  assert.equal(cache.take(), undefined, 'a ten minute old assembly is not offered');
  const stale = chooseStartContext(cache.take(), () => collectSections(local.value));
  assert.equal(stale.warm, false);
  assert.deepEqual(local.calls, { persona: 2, memory: 2, summary: 2, calendar: 2 }, 'exactly one read on the stale path');
});

test('assembly happens at most once every ten minutes and on demand after a wake', () => {
  const local = sources();
  let now = 3_000_000;
  const cache = new WarmContextCache({ sources: local.value, budget: 4_000, now: () => now });
  assert.equal(cache.take(), undefined, 'nothing is pre-assembled before the first refresh');

  const first = cache.refresh();
  assert.ok(first !== undefined && first.assembledAt === now, 'the first refresh assembles');
  assert.equal(cache.assemblies, 1);

  now += warmContextMaxAgeMs - 1;
  assert.equal(cache.refresh(), first, 'a refresh inside the window returns the same assembly');
  assert.equal(cache.assemblies, 1, 'no re-assembly inside ten minutes');
  assert.equal(local.calls.persona, 1, 'the sources were read once');

  now += 1;
  cache.refresh();
  assert.equal(cache.assemblies, 2, 'ten minutes of age re-assembles');
  assert.equal(local.calls.persona, 2);

  cache.refresh(true);
  assert.equal(cache.assemblies, 3, 'a wake forces a fresh assembly even inside the window');
});

test('a session may only start from a warm assembly younger than ten minutes', () => {
  let now = 5_000_000;
  const cache = new WarmContextCache({ sources: sources().value, budget: 4_000, now: () => now });
  cache.refresh();
  assert.equal(cache.ageMs, 0);
  assert.deepEqual(cache.take()?.sections, collected);

  now += warmContextMaxAgeMs - 1;
  assert.ok(cache.take() !== undefined, 'one millisecond short of ten minutes is still warm');
  now += 1;
  assert.equal(cache.take(), undefined, 'a ten minute old assembly is never used, it is re-assembled instead');
  assert.equal(cache.ageMs, warmContextMaxAgeMs);
});

test('an empty source set assembles nothing rather than an empty block', () => {
  const cache = new WarmContextCache({
    sources: { persona: () => undefined, memory: () => [], summary: () => undefined, calendar: () => undefined },
    budget: 4_000,
  });
  assert.equal(cache.refresh(), undefined);
  assert.equal(cache.take(), undefined);
});

// R7: the digest the cache keeps is what a start composes from, so the composed instruction carries the
// calendar section when the warm assembly holds a digest and none when it does not.
test('R7: the warm assembly\'s digest reaches the composed instruction as the calendar section', () => {
  const cache = new WarmContextCache({ sources: sources().value, budget: 4_000, now: () => 0 });
  const warm = cache.refresh();
  assert.equal(warm?.sections.calendar, sections.calendar, 'the cache keeps the digest');
  const text = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' }).text;
  const compose = (calendar: string | undefined) => composeLiveSessionInstruction({ text, tools: [], records: [],
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, ...(calendar === undefined ? {} : { calendar }) });
  const carried = compose(warm?.sections.calendar);
  assert.ok(carried.text.includes('Today: 10:00 standup, 15:00 review'), 'the digest is in the instruction');
  assert.ok(carried.sections.some(section => section.id === 'calendar'), 'as its own section');
  const empty = compose(undefined);
  assert.equal(empty.sections.some(section => section.id === 'calendar'), false, 'no digest, no section');
  assert.doesNotMatch(empty.text, /Today:/);
});


// 1015: the host's calendar digest owner. The six states below are the whole contract: a read fills the
// cache with its fetch time, a start never waits on one, and a failure is never reported as an empty day.
// A fake connector scripts the latency and a virtual clock stands in for wall time, so no test sleeps.
const digestMonday = Date.parse('2026-10-19T04:00:00Z'); // Monday 09:30 in Asia/Kolkata
const digestEvent = { id: 'e1', summary: 'standup', start: { dateTime: '2026-10-19T04:30:00Z' } };

type DigestScript = { latencyMs?: number; events?: readonly Record<string, unknown>[]; fail?: 'refused' | 'throw' | 'hang' };
/** One fake connector read: its latency is paid on the virtual clock, so a 6 s read costs no test time. */
function digestConnector(script: DigestScript, clock: { now: number }): CalendarDigestRead & { calls: GcalListInput[] } {
  const calls: GcalListInput[] = [];
  return {
    calls,
    async gcalList(input: GcalListInput, _signal?: AbortSignal): Promise<GoogleResult> {
      calls.push(input);
      if (script.fail === 'hang') return await new Promise<GoogleResult>(() => {});
      clock.now += script.latencyMs ?? 0;
      if (script.fail === 'throw') throw new Error('connector down');
      if (script.fail === 'refused') return { state: 'refused', reason: 'tool-not-granted' };
      const data = { events: [...(script.events ?? [digestEvent])] };
      return { state: 'completed', tool: 'calendar_list_events', observedAt: clock.now,
        decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data }) }] },
        source: {}, coverage: {}, projection: {}, response: {} } as unknown as GoogleResult;
    },
  };
}
function digestCache(script: DigestScript, start = digestMonday, intervalMs?: number) {
  const clock = { now: start };
  const read = digestConnector(script, clock);
  const cache = new CalendarDigestCache(async () => await readCalendarDigest(read, { now: () => clock.now, timeZone: 'Asia/Kolkata' }),
    { now: () => clock.now, timeZone: 'Asia/Kolkata', ...(intervalMs === undefined ? {} : { intervalMs }) });
  return { cache, read, clock, script };
}

test('1015: a 6 s read fills the cache and the next start uses it with state present and no read', async () => {
  const { cache, read, clock } = digestCache({ latencyMs: 6_000 });
  const filled = await cache.refresh();
  assert.equal(filled.state, 'present', 'a read inside the 30 s budget is a present day');
  assert.equal(filled.items, 1);
  assert.equal(filled.fetchedAt, digestMonday + 6_000, 'the fetch time is when the read finished');
  assert.match(filled.text ?? '', /^10:00 standup$/, 'local host time, as before');
  const started = await cache.forStart();
  assert.equal(started.state, 'present', 'the next start reads the cache, not the connector');
  assert.equal(started.items, 1);
  assert.equal(read.calls.length, 1, 'the start itself dispatches nothing');
  assert.equal(clock.now, digestMonday + 6_000, 'and no clock moved waiting for it');
});

test('1022: a start never waits on a calendar read, an empty cache is stated absent', async () => {
  const { cache } = digestCache({ fail: 'hang' });
  void cache.refresh();
  const startedAt = Date.now();
  const started = await cache.forStart();
  const waited = Date.now() - startedAt;
  assert.equal(started.state, 'absent', 'no digest yet is said out loud, never an empty day');
  assert.equal(started.text, undefined);
  assert.ok(waited < 1_000, `create never blocks on a connector read (${waited} ms)`);
});

test('1022: a digest that lands after a start is there for the next one', async () => {
  const { cache, read } = digestCache({});
  const filling = cache.refresh();
  await cache.forStart();
  await filling;
  assert.equal((await cache.forStart()).state, 'present', 'the read that landed is used by the next start');
  assert.equal(read.calls.length, 1, 'and a start never dispatches a read of its own');
});

test('1015: a stale cache whose refresh does not arrive is reported stale with its own fetch time', async () => {
  const { cache, clock, script } = digestCache({});
  await cache.refresh();
  clock.now += calendarDigestFreshMs;
  script.fail = 'hang';
  const started = await cache.forStart();
  assert.equal(started.state, 'stale', 'the receipt says stale, not that a read just timed out');
  assert.equal(started.text, undefined, 'and the aged text never rides the assembly');
  assert.equal(started.fetchedAt, digestMonday, 'the answer carries the last real fetch time, so ageMs is honest');
});

test('1015: a failing read is failed, never empty, and an unconfigured connector says so', async () => {
  for (const fail of ['throw', 'refused'] as const) {
    const { cache } = digestCache({ fail });
    assert.equal((await cache.refresh()).state, 'failed', `a ${fail} read is a failure`);
    assert.equal((await cache.forStart()).state, 'failed', 'and a start repeats the failure rather than an empty day');
  }
  assert.equal((await readCalendarDigest(undefined, { now: () => digestMonday, timeZone: 'Asia/Kolkata' })).state, 'unconfigured');
});

// 556: the digest owner dies with the host and never outlives a read. A read that never answers
// ends at the ten second deadline with one closed line, and a close aborts the read it started.
test('556: a digest read that never answers ends at ten seconds with the closed timeout event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { now: digestMonday };
  const read = digestConnector({ fail: 'hang' }, clock);
  const events: unknown[] = [];
  const cache = new CalendarDigestCache(async () => await readCalendarDigest(read, { now: () => clock.now, timeZone: 'Asia/Kolkata' }),
    { now: () => clock.now, timeZone: 'Asia/Kolkata', log: event => events.push(event) });
  const reading = cache.refresh('timer');
  t.mock.timers.tick(calendarDigestReadMs - 1);
  assert.deepEqual(events, [], 'a read inside the deadline reports nothing');
  t.mock.timers.tick(1);
  const settled = await reading;
  assert.equal(settled.state, 'timeout', 'a read past the deadline is a timeout, never an empty day');
  assert.deepEqual(events, [{ event: 'calendar_digest_timeout', reason: 'timer', ms: 0 }],
    'one closed line names the deadline and the edge that owed the read');
  assert.equal(read.calls.length, 1, 'and the read is not dispatched a second time');
});

test('556: host close aborts the digest read it started and logs nothing after the exit', async () => {
  const clock = { now: digestMonday };
  const signals: AbortSignal[] = [];
  const events: unknown[] = [];
  const cache = new CalendarDigestCache(async signal => { signals.push(signal); return await new Promise<CalendarDigestReadResult>(() => {}); },
    { now: () => clock.now, timeZone: 'Asia/Kolkata', log: event => events.push(event) });
  const reading = cache.refresh('timer');
  assert.equal(signals.length, 1, 'the read is in flight');
  assert.equal(signals[0]!.aborted, false, 'and it is not aborted while the host lives');
  cache.stop();
  assert.equal(signals[0]!.aborted, true, 'close aborts the read instead of leaving it running');
  assert.equal((await reading).state, 'timeout', 'the read that was cut is said to be a read that never answered');
  assert.deepEqual(events, [], 'no digest event is logged after host_exit');
});

test('1015: a truly empty day is the one case that reports empty', async () => {
  const { cache } = digestCache({ events: [] });
  const filled = await cache.refresh();
  assert.equal(filled.state, 'empty');
  assert.equal(filled.text, undefined, 'the slot stays out of the assembly');
  assert.equal(filled.items, 0);
});

test('1015: an unconfigured connector is never cached, so a start asks again once the grant arrives', async () => {
  const clock = { now: digestMonday };
  let granted = false;
  const cache = new CalendarDigestCache(async () => (granted
    ? { state: 'present' as const, text: '10:00 standup', items: 1, fetchedAt: clock.now }
    : { state: 'unconfigured' as const, text: undefined, items: 0, fetchedAt: clock.now }),
    { now: () => clock.now, timeZone: 'Asia/Kolkata' });
  assert.equal((await cache.refresh()).state, 'unconfigured', 'the background read says the connector is not configured');
  assert.equal((await cache.forStart()).state, 'absent', 'an unconfigured read never answers a start, and never an empty day');
  granted = true;
  await cache.refresh();
  assert.equal((await cache.forStart()).state, 'present', 'the next start reads the calendar the owner just granted');
});

test('1015: a cache older than 30 min is stale, leaves the slot out and triggers a refresh', async () => {
  const { cache, read, clock } = digestCache({});
  await cache.refresh();
  assert.equal(cache.current()?.state, 'present');
  clock.now += calendarDigestFreshMs;
  const stale = cache.current();
  assert.equal(stale?.state, 'stale', 'the age, not the read, is the problem');
  assert.equal(stale?.text, undefined, 'stale text never reaches an assembly');
  assert.equal(read.calls.length, 2, 'reading a stale cache kicks the refresh');
});

test('1015: a day change past local midnight refreshes the cache', async () => {
  // Monday 23:50 IST, so twenty minutes later is a Tuesday and the digest is still well inside 30 min.
  const { cache, read, clock } = digestCache({}, Date.parse('2026-10-19T18:20:00Z'));
  await cache.refresh();
  clock.now += 20 * 60 * 1000;
  assert.equal(cache.current()?.state, 'stale', 'yesterday\'s digest does not answer today');
  assert.equal(read.calls.length, 2, 'the rollover refreshes it');
  assert.equal(read.calls[0]!.timeMin, '2026-10-19T00:00:00+05:30');
  assert.equal(read.calls[1]!.timeMin, '2026-10-20T00:00:00+05:30', 'the refreshed read asks for the new local day');
});

test('1015: the digest read budget is 30 s, so the aborted 5 s read cannot be a timeout again', () => {
  assert.equal(CALENDAR_DIGEST_READ_MS, 30_000);
  assert.equal(calendarDigestRefreshMs, 15 * 60 * 1000, 'the background owner refreshes every 15 min');
  assert.equal(calendarDigestFreshMs, 30 * 60 * 1000, 'a start accepts a cache under 30 min old');
});

test('1015: the background owner reads at host start and on every interval until it is stopped', async t => {
  // The interval is the owner's own seam, so mock timers drive it instead of a real 15 minute wait. Each
  // tick is followed by a settle, because a read already in flight is shared rather than dispatched again.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { cache, read } = digestCache({});
  const settle = async () => { await cache.refresh(); };
  cache.begin();
  assert.equal(read.calls.length, 1, 'the host start read happens before any call arrives');
  await settle();
  t.mock.timers.tick(calendarDigestRefreshMs);
  assert.equal(read.calls.length, 2, 'and one every fifteen minutes, off the request path');
  t.mock.timers.tick(calendarDigestRefreshMs);
  assert.equal(read.calls.length, 2, 'a tick while that read is still in flight shares it, never a second read');
  await settle();
  t.mock.timers.tick(calendarDigestRefreshMs);
  assert.equal(read.calls.length, 3, 'the owner keeps the digest current while the host runs');
  await settle();
  cache.stop();
  t.mock.timers.tick(calendarDigestRefreshMs * 4);
  assert.equal(read.calls.length, 3, 'a stopped host reads nothing');
});

test('a parked sign-in is one short line at call start and nothing when Mongoose is fine', () => {
  const parked = [{ id: 'mongoose', connector: 'mongoose', state: 'error', reasonCode: 'needs_sign_in' }];
  const line = signInNote(parked);
  assert.ok(line, 'a parked sign-in is said once');
  assert.match(line!, /say that once/i);
  assert.match(line!, /Settings/);
  assert.doesNotMatch(line!, /token|bearer|http/i, 'the line carries no credential or URL');
  assert.equal(signInNote([{ id: 'mongoose', connector: 'mongoose', state: 'connected', reasonCode: null }]), undefined);
  assert.equal(signInNote([{ id: 'gmail', connector: 'google', state: 'error', reasonCode: 'unreachable' }]), undefined);
  // The host report carries the bare credential code and error, which is the shape Live really passes.
  assert.ok(signInNote([{ id: 'mongoose', connector: 'mongoose', state: 'error', error: 'credential-refresh-failed' }]));
  assert.equal(signInNote([{ id: 'mongoose', connector: 'mongoose', state: 'error', error: 'credential-refresh-busy' }]), undefined, 'a busy refresh is not a sign-in');
  // F3: the line is Mongoose only, so no other connector can make Naya say a Mongoose sentence.
  assert.equal(signInNote([{ id: 'gmail', connector: 'google', state: 'error', reasonCode: 'needs_sign_in' }]), undefined);
  assert.equal(signInNote([{ id: 'mattermost', connector: 'mattermost', state: 'error', error: 'credential-missing' }]), undefined, 'a Mattermost credential fault is not a Mongoose sign-in');
  assert.equal(signInNote([]), undefined);
});
