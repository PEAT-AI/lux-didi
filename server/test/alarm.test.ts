import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAlarmTime } from '../tools/alarm.js';

// Synthetic words and a fixed instant only. These tests never use the system clock.
const now = Date.parse('2026-10-28T13:00:00Z');
const tz = 'Asia/Singapore';

test('alarm: an unqualified eight chooses the next future occurrence', () => {
  const result = parseAlarmTime('set an alarm at 8', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
});

test('alarm: an unqualified wake request chooses the next occurrence in the system zone', () => {
  const result = parseAlarmTime('wake me at 8', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
  assert.equal(result.tz, tz);
  assert.equal(result.confirmation, 'Alarm set for 29/10/2026, 08:00 (Asia/Singapore).');
});

test('alarm: explicit morning and evening resolve without a model-supplied time', () => {
  for (const words of ['set an alarm for tomorrow morning at 8', 'set an alarm at 8 tomorrow morning']) {
    const result = parseAlarmTime(words, now, tz);
    assert.equal(result.status, 'ready');
    if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
  }
  const evening = parseAlarmTime('set an alarm tomorrow at 8 pm', now, tz);
  assert.equal(evening.status, 'ready');
  if (evening.status === 'ready') assert.equal(evening.fireAtUtc, Date.parse('2026-10-29T12:00:00Z'));
});

test('alarm: relative eight hours is host-derived, with bounded argument skew', () => {
  const result = parseAlarmTime('wake me in eight hours', now, tz, now + 8 * 3600000 + 5000);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, now + 8 * 3600000);
  assert.deepEqual(parseAlarmTime('wake me in eight hours', now, tz, now + 3600000), {
    status: 'refused', reason: 'time_mismatch',
  });
});

test('alarm: a model time alone cannot manufacture an owner time request', () => {
  assert.deepEqual(parseAlarmTime('tell me the weather', now, tz, now + 3600000), {
    status: 'clarify', reason: 'missing_time',
  });
});

test('alarm: a resolved instant remains fixed when the system time zone changes', () => {
  const result = parseAlarmTime('wake me at 8', now, 'America/New_York');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.fireAtUtc, Date.parse('2026-10-29T12:00:00Z'));
  const london = parseAlarmTime('wake me at 8', now, 'Europe/London');
  assert.equal(london.status, 'ready');
  if (london.status !== 'ready') return;
  assert.equal(london.fireAtUtc, Date.parse('2026-10-29T08:00:00Z'));
  assert.equal(london.tz, 'Europe/London');
  assert.equal(result.fireAtUtc, Date.parse('2026-10-29T12:00:00Z'));
  assert.equal(result.tz, 'America/New_York');
});

test('alarm: spoken number words resolve without relying on a model digit conversion', () => {
  const result = parseAlarmTime('wake me at eight tomorrow morning', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
});


// The transcription spellings here are synthetic reproductions, not owner content.
for (const [words, instant] of [
  ['set an alarm at eleven ten in the morning', '2026-10-29T03:10:00Z'],
  ['set an alarm at 11:10 a.m. Singapore time', '2026-10-29T03:10:00Z'],
  ['set an alarm at 11:10 am SGT', '2026-10-29T03:10:00Z'],
  ['set an alarm at seven oh five in the morning', '2026-10-28T23:05:00Z'],
  ['set an alarm at ten past eleven in the morning', '2026-10-29T03:10:00Z'],
  ['set an alarm at half past six in the morning', '2026-10-28T22:30:00Z'],
  ['set an alarm at quarter to eight in the morning', '2026-10-28T23:45:00Z'],
  ['set an alarm at noon', '2026-10-29T04:00:00Z'],
  ['set an alarm at midnight', '2026-10-28T16:00:00Z'],
  ['set an alarm at eleven ten tonight', '2026-10-28T15:10:00Z'],
  ['set an alarm at eleven ten tomorrow morning', '2026-10-29T03:10:00Z'],
  ['set an alarm in 20 minutes', '2026-10-28T13:20:00Z'],
  ['set an alarm at eight', '2026-10-29T00:00:00Z'],
] as const) {
  test(`direct102 alarm golden: ${words}`, () => {
    const result = parseAlarmTime(words, now, tz);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.fireAtUtc, Date.parse(instant));
    assert.equal(result.tz, tz);
  });
}

test('direct102: an unknown spoken zone clarifies instead of falling back to the host zone', () => {
  const result = parseAlarmTime('set an alarm at 11:10 am Atlantis time', now, tz);
  assert.deepEqual(result, { status: 'clarify', reason: 'missing_timezone' });
});

test('direct102: an unconsumed minute expression never silently schedules the hour', () => {
  const result = parseAlarmTime('set an alarm at eleven flibberty minutes in the morning', now, tz);
  assert.deepEqual(result, { status: 'clarify', reason: 'unsupported_time_expression' });
});


test('direct102 alarm: browser wording in a compound ask is not mistaken for a relative interval', () => {
  const result = parseAlarmTime('open any deck in my browser and set an alarm in twenty minutes', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, now + 20 * 60000);
});

test('direct102 alarm: a clarified zone overrides the unrecognized earlier zone', () => {
  const result = parseAlarmTime('set an alarm at eleven ten Atlantis time a.m. Singapore time', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-29T03:10:00Z'));
});

for (const words of [
  'set an alarm for eleven at seven',
  'set an alarm at seven for eleven',
  'set an alarm noon at seven',
  'set an alarm for noon at seven',
  'set an alarm for eleven in twenty minutes',
  'set an alarm eleven at seven',
  'set an alarm for seven am eleven pm',
  'set an alarm at seven and at eleven',
  'set an alarm at seven and set an alarm in twenty minutes',
  'set an alarm eleven and set an alarm at seven',
]) {
  test(`R5 F2: multiple time expressions clarify without choosing a suffix: ${words}`, () => {
    assert.deepEqual(parseAlarmTime(words, now, tz), { status: 'clarify', reason: 'unsupported_time_expression' });
  });
}

for (const words of ['set an alarm for tomorrow at seven', 'set an alarm for  tomorrow at seven', 'set an alarm for tomorrow seven am']) {
  test(`R5 F2: one date-qualified time remains valid: ${words}`, () => {
    const parsed = parseAlarmTime(words, now, tz);
    assert.equal(parsed.status, 'ready');
    if (parsed.status === 'ready') assert.equal(parsed.fireAtUtc, Date.parse('2026-10-28T23:00:00Z'));
  });
}

for (const words of [
  'Well, okay, set an alarm for ten past six p.m. today',
  'set an alarm for um ten past six p.m.',
  'wake me up tomorrow at eight and give me a summary',
  'remind me in nine minutes that I have to call the library',
]) test(`hear104 time and label: ${words}`, () => {
  const result = parseAlarmTime(words, now, tz);
  assert.equal(result.status, 'ready');
  if (words.includes('summary')) assert.equal('label' in result && result.label, 'give me a summary');
  if (words.includes('library')) assert.equal('label' in result && result.label, 'I have to call the library');
});

test('hear104 wake without a period means the next morning, not this evening', () => {
  const result = parseAlarmTime('wake me up at 8', Date.parse('2026-11-01T17:09:00Z'), 'UTC');
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-11-02T08:00:00Z'));
});
test('hear104 relative reminder preserves owner label and ignores model-selected time', () => {
  const result = parseAlarmTime('remind me in 10 minutes that I have to call the library', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.equal(result.fireAtUtc, now + 600000);
    assert.equal(result.label, 'I have to call the library');
  }
});
test('hear104 quarter-to is a time, not a trailing label', () => {
  const result = parseAlarmTime('set an alarm at quarter to eight', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.label, '');
});

test('hear104 a pending bare-number follow-up supplies hour and minute', () => {
  const result = parseAlarmTime('set an alarm Ten five, today', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-28T14:05:00Z'));
});

for (const [words, minute] of [
  ['set an alarm for fi twenty past five p.m.', 20],
  ['set an alarm for um five past five p.m.', 5],
  ['set an alarm for fi ten past five p.m.', 10],
] as const) test(`hear104 R5 one filler before spoken time: ${words}`, () => {
  const result = parseAlarmTime(words, now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.UTC(2026, 9, 29, 9, minute));
});
for (const time of [
  '5', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'five past five', 'twenty past five', 'twenty-five to five', 'thirty past five', 'forty past five', 'fifty to five',
  'quarter past five', 'half past five', 'noon', 'midnight',
]) test(`hear104 R5 filler does not change the instant: ${time}`, () => {
  const clean = parseAlarmTime(`set an alarm for ${time}`, now, tz);
  assert.equal(clean.status, 'ready');
  assert.deepEqual(parseAlarmTime(`set an alarm for um ${time}`, now, tz), clean);
});
