import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarRange } from '../tools/calendar-window.js';
import { registeredCalendarArguments, runResearch, ResearchLedger, type ResearchDeps } from '../tools/research.js';
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
