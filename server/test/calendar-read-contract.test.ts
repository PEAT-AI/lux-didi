import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarRange } from '../tools/calendar-window.js';
import { registeredCalendarArguments, runResearch, ResearchLedger, VoiceReplyBook, capVoiceReply, type ResearchDeps } from '../tools/research.js';
import { shapeGcalList } from '../tools/live-shape.js';
import type { IntentSubCall } from '../tools/intent.js';

const now = Date.parse('2026-10-29T12:00:00Z');
function harness(failed = false) {
  const calls: IntentSubCall[] = [];
  const deps: ResearchDeps = {
    emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
    now: () => now, timeZone: 'UTC', configured: ['calendar', 'mail'],
    execute: async subs => {
      calls.push(...subs);
      return subs.map(call => ({ key: call.key, name: call.name, ok: !failed, text: failed ? 'provider_failed' : '', originalCharacters: 0, omittedCharacters: 0 }));
    },
  };
  return { calls, deps };
}

test('registered calendar args discard both unknown keys and clamp the declared cap', () => {
  const args = registeredCalendarArguments({ calendarId: 'synthetic', maxResults: 100, timeZone: 'UTC', madeUp: true }, () => ({ properties: { calendarId: {}, maxResults: { maximum: 50 } } }));
  assert.deepEqual(args, { calendarId: 'synthetic', maxResults: 50 });
});

test('named wedding search reaches two weeks ahead instead of the current day', async () => {
  const h = harness();
  await runResearch(h.deps, { action: 'start', question: "do you find Sam's wedding", lookups: [{ source: 'calendar', query: "Sam's wedding" }] }, new AbortController().signal);
  const args = h.calls.find(call => call.name === 'calendar_list_events')?.args;
  assert.ok(args);
  assert.equal(args['q'], "Sam's wedding");
  assert.ok(Date.parse(String(args['timeMin'])) <= now - 31 * 86400000);
  assert.ok(Date.parse(String(args['timeMax'])) >= now + 183 * 86400000);
});

test('research clamps a mail page of 50 to 25 before executing', async () => {
  const h = harness();
  await runResearch(h.deps, { action: 'start', question: 'find the synthetic release email', lookups: [{ source: 'mail', mail: { q: 'synthetic release', maxResults: 50 } }] }, new AbortController().signal);
  assert.equal(h.calls.find(call => call.name === 'gmail_search_messages')?.args['maxResults'], 25);
});

for (const source of ['calendar', 'mail'] as const) {
  test(`${source} failure is spoken as an unread source, not empty`, async () => {
    const h = harness(true);
    const reply = await runResearch(h.deps, { action: 'start', question: `read my ${source} today`, lookups: [source === 'calendar' ? { source, query: 'today' } : { source, mail: { q: 'synthetic' } }] }, new AbortController().signal);
    const text = JSON.stringify(reply);
    assert.match(text, new RegExp(`couldn't read your ${source}`));
    assert.doesNotMatch(text, /found nothing matching/);
  });
}

for (const [phrase, start, end] of [
  ['next week', '2026-11-02', '2026-11-09'],
  ['this week', '2026-10-26', '2026-11-02'],
  ['coming days', '2026-10-29', '2026-11-05'],
] as const) {
  test(`${phrase} reads the complete range`, async () => {
    assert.deepEqual(calendarRange(phrase, now, 'UTC'), { timeMin: `${start}T00:00:00.000Z`, timeMax: `${end}T00:00:00.000Z` });
    const h = harness();
    await runResearch(h.deps, { action: 'start', question: `what is on my calendar in the ${phrase}`, lookups: [{ source: 'calendar', query: phrase }] }, new AbortController().signal);
    const args = h.calls.find(call => call.name === 'calendar_list_events')?.args;
    assert.equal(args?.['timeMin'], `${start}T00:00:00.000Z`);
    assert.equal(args?.['timeMax'], `${end}T00:00:00.000Z`);
  });
}

function eventsHarness(count = 1) {
  const h = harness();
  const shaped = shapeGcalList({ events: Array.from({ length: count }, (_, i) => ({ id: `synthetic-${i}`, summary: `Synthetic event ${i}`, start: { dateTime: `2026-11-0${2 + i % 7}T12:00:00Z` }, attendees: [{ displayName: 'Sam', responseStatus: 'accepted' }, { displayName: 'Jo', responseStatus: 'tentative' }] })) });
  h.deps.execute = async calls => {
    h.calls.push(...calls);
    return calls.map(call => ({ key: call.key, name: call.name, ok: true, text: call.name === 'calendar_list_events' ? shaped.text : '', originalCharacters: shaped.originalCharacters, omittedCharacters: 0, ...(call.name === 'calendar_list_events' ? { calendarPage: shaped.calendarPage } : {}) }));
  };
  return h;
}

test('research calendar projection keeps attendee names and response status', async () => {
  const h = eventsHarness();
  const reply = await runResearch(h.deps, { action: 'start', question: 'who is in my meeting next week', lookups: [{ source: 'calendar', query: 'next week' }] }, new AbortController().signal);
  const text = JSON.stringify(reply['findings']);
  assert.match(text, /Sam.*accepted/);
  assert.match(text, /Jo.*tentative/);
});

test('a second calendar ask in one session still returns event titles', async () => {
  const h = eventsHarness();
  const ask = { action: 'start', question: 'what is on my calendar next week', lookups: [{ source: 'calendar', query: 'next week' }] };
  const first = await runResearch(h.deps, ask, new AbortController().signal);
  const second = await runResearch(h.deps, ask, new AbortController().signal);
  assert.match(JSON.stringify(first['findings']), /Synthetic event 0/);
  assert.match(JSON.stringify(second['findings']), /Synthetic event 0/);
});

test('a 28-event week fits the voice page or names the remaining items and cursor', async () => {
  const h = eventsHarness(28);
  const reply = await runResearch(h.deps, { action: 'start', question: 'what is on my calendar next week', lookups: [{ source: 'calendar', query: 'next week' }] }, new AbortController().signal);
  const page = capVoiceReply(reply, new VoiceReplyBook());
  const text = JSON.stringify(page);
  assert.ok(text.length <= 3000);
  const heard = Array.from({ length: 28 }, (_, i) => new RegExp(`Synthetic event ${i}(?![0-9])`).test(text)).filter(Boolean).length;
  assert.ok(heard === 28 || /\+\d+ more/.test(text), `${heard} heard without a remainder count`);
  if (heard < 28) { assert.equal(typeof page['pageCursor'], 'string'); assert.doesNotMatch(text, /nothing more to fetch/); }
});

test('capped findings expose the asked-for DM source before a large knowledge result', async () => {
  const h = harness();
  h.deps.configured = ['knowledge', 'chat'];
  h.deps.execute = async calls => calls.map(call => ({ key: call.key, name: call.name, ok: true, text: call.name === 'search_knowledge' ? `### ${'Synthetic knowledge '.repeat(180)} [id 1]` : '- Synthetic direct message from Sam', originalCharacters: 4000, omittedCharacters: 0 }));
  const reply = await runResearch(h.deps, { action: 'start', question: 'show my DMs and related knowledge', lookups: [{ source: 'knowledge', query: 'synthetic' }, { source: 'chat', query: 'synthetic' }] }, new AbortController().signal);
  const page = capVoiceReply(reply, new VoiceReplyBook());
  assert.match(JSON.stringify(page['findings']), /Synthetic direct message/);
});

for (const source of ['calendar', 'mail'] as const) test(`a skipped ${source} leg is not an empty search`, async () => {
  const h = harness();
  h.deps.configured = [];
  const reply = await runResearch(h.deps, { action: 'start', question: `read my ${source} today`, lookups: [source === 'calendar' ? { source, query: 'today' } : { source, mail: { q: 'synthetic' } }] }, new AbortController().signal);
  assert.match(JSON.stringify(reply), new RegExp(`couldn't read your ${source}`));
  assert.doesNotMatch(JSON.stringify(reply), /found nothing matching/);
});
