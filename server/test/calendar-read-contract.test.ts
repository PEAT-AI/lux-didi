import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarRange } from '../tools/calendar-window.js';
import { shapeGcalList } from '../tools/live-shape.js';

const now = Date.parse('2026-10-29T12:00:00Z');
for (const [phrase, start, end] of [
  ['next week', '2026-11-02', '2026-11-09'],
  ['this week', '2026-10-26', '2026-11-02'],
  ['coming days', '2026-10-29', '2026-11-05'],
] as const) {
  test(`${phrase} calendar window spans the complete range`, () => {
    assert.deepEqual(calendarRange(phrase, now, 'UTC'), { timeMin: `${start}T00:00:00.000Z`, timeMax: `${end}T00:00:00.000Z` });
  });
}

function events(count = 1) {
  return { events: Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${i}`, summary: `Synthetic event ${i}`, calendar: 'Synthetic calendar',
    start: { dateTime: `2026-11-0${2 + i % 7}T12:00:00Z` },
    attendees: [{ displayName: 'Sam', responseStatus: 'accepted' }, { displayName: 'Jo', responseStatus: 'tentative' }],
  })) };
}

test('native calendar projection retains attendee names and response statuses', () => {
  const result = shapeGcalList(events());
  assert.match(result.text, /Synthetic event 0/);
  assert.match(result.text, /Sam/);
  assert.match(result.text, /accepted/);
  assert.match(result.text, /Jo/);
  assert.match(result.text, /tentative/);
});

test('a repeated native calendar projection retains the event title', () => {
  const page = events();
  assert.equal(shapeGcalList(page).text, shapeGcalList(page).text);
  assert.match(shapeGcalList(page).text, /Synthetic event 0/);
});

test('native calendar projection retains all 28 events without a spoken page cap', () => {
  const result = shapeGcalList(events(28));
  for (let i = 0; i < 28; i++) assert.match(result.text, new RegExp(`Synthetic event ${i}\\b`));
  assert.equal(result.omittedCharacters, 0);
});
