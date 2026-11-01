import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAlarmTime, parseCancelScope, parseSeriesRule, seriesNextFireAt, seriesText, verifyAlarmRule } from '../tools/alarm.js';
import { checkOwnerTime, type TimeSpec } from '../tools/time-check.js';

// Synthetic words and a fixed instant only. These tests never use the system clock.
const now = Date.parse('2026-10-28T13:00:00Z');
const tz = 'Asia/Singapore';
/**
 * T-R1: the model's structured time for a golden row is built from that row's own expected instant in
 * this file's zone, so no expected instant changes. Where the owner's words settle one time, the same
 * row also runs with a model time one hour wrong and the owner's instant must still win.
 */
function modelAt(instant: number, zone = tz): TimeSpec {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  return { mode: 'wall', date: { kind: 'iso', value: `${get('year')}-${get('month')}-${get('day')}` }, local_time: `${get('hour')}:${get('minute')}`, timezone: zone };
}
function ownerWins(words: string, at: number, expected: number, zone = tz): void {
  if (checkOwnerTime(words).status !== 'unique') return;
  const wrong = parseAlarmTime(words, at, zone, modelAt(expected + 3600000, zone));
  assert.equal(wrong.status, 'ready', `${words}: the owner time executes despite a wrong model time`);
  if (wrong.status === 'ready') assert.equal(wrong.fireAtUtc, expected, `${words}: the owner time wins`);
}
/** T-R1 counts for the checker over this file's rows. */
export const goldenReading = { unique: 0, partial: 0, inconclusive: 0 };
function readGolden(words: string): void { goldenReading[checkOwnerTime(words).status] += 1; }


test('alarm: an unqualified eight chooses the next future occurrence', () => {
  const result = parseAlarmTime('set an alarm at 8', now, tz, modelAt(Date.parse('2026-10-29T00:00:00Z')));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
});

test('alarm: an unqualified wake request chooses the next occurrence in the system zone', () => {
  const result = parseAlarmTime('wake me at 8', now, tz, modelAt(Date.parse('2026-10-29T00:00:00Z')));
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
  assert.equal(result.tz, tz);
  assert.equal(result.confirmation, 'Alarm set for Thursday 29 October at 08:00 (Asia/Singapore).');
});

test('alarm: explicit morning and evening resolve without a model-supplied time', () => {
  for (const words of ['set an alarm for tomorrow morning at 8', 'set an alarm at 8 tomorrow morning']) {
    const expected = Date.parse('2026-10-29T00:00:00Z');
    const result = parseAlarmTime(words, now, tz, modelAt(expected));
    ownerWins(words, now, expected);
    readGolden(words);
    assert.equal(result.status, 'ready');
    if (result.status === 'ready') assert.equal(result.fireAtUtc, expected);
  }
  const evening = parseAlarmTime('set an alarm tomorrow at 8 pm', now, tz);
  assert.equal(evening.status, 'ready');
  if (evening.status === 'ready') assert.equal(evening.fireAtUtc, Date.parse('2026-10-29T12:00:00Z'));
});

test('alarm: a relative span is host-derived despite a disagreeing model field', () => {
  // C-TIME: the model states a span, the host adds it to its own clock, and the owner's words win.
  const result = parseAlarmTime('wake me in eight hours', now, tz, { mode: 'relative', amount: 10, unit: 'hours' });
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.equal(result.fireAtUtc, now + 8 * 3600000);
    assert.equal(result.corrected, 'model_time_differs');
  }
  const agreed = parseAlarmTime('wake me in eight hours', now, tz, { mode: 'relative', amount: 8, unit: 'hours' });
  assert.equal(agreed.status, 'ready');
  if (agreed.status === 'ready') assert.equal(agreed.corrected, undefined);
});

test('alarm: without an owner time the model structured time executes', () => {
  const parsed = parseAlarmTime('set an alarm', now, tz, { mode: 'wall', date: { kind: 'tomorrow' }, local_time: '09:00' });
  assert.equal(parsed.status, 'ready');
  if (parsed.status === 'ready') {
    assert.equal(parsed.localTime, '09:00');
    assert.equal(parsed.source, 'model');
  }
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
    const expected = Date.parse(instant);
    const result = parseAlarmTime(words, now, tz, modelAt(expected));
    ownerWins(words, now, expected);
    readGolden(words);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.fireAtUtc, expected);
    assert.equal(result.tz, tz);
  });
}


test('direct102 alarm: browser wording in a compound ask is not mistaken for a relative interval', () => {
  const result = parseAlarmTime('open any deck in my browser and set an alarm in twenty minutes', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, now + 20 * 60000);
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
    const parsed = parseAlarmTime(words, now, tz);
    assert.equal(parsed.status, 'clarify', words);
    if (parsed.status === 'clarify') assert.ok(['missing_time', 'ambiguous_time'].includes(parsed.reason), `${words}: ${parsed.reason}`);
  });
}

for (const words of ['set an alarm for tomorrow at seven', 'set an alarm for  tomorrow at seven', 'set an alarm for tomorrow seven am']) {
  test(`R5 F2: one date-qualified time remains valid: ${words}`, () => {
    const expected = Date.parse('2026-10-28T23:00:00Z');
    const parsed = parseAlarmTime(words, now, tz, modelAt(expected));
    assert.equal(parsed.status, 'ready');
    if (parsed.status === 'ready') assert.equal(parsed.fireAtUtc, expected);
  });
}

// C-TIME design change: "ten past six p.m. today" states today, and at this fixture's now that
// instant has already passed, so it asks back (requirement 4) instead of arming a past alarm.
test('hear104 time and label: a stated today already past asks back', () => {
  assert.deepEqual(parseAlarmTime('Well, okay, set an alarm for ten past six p.m. today', now, tz), { status: 'clarify', reason: 'past_time' });
});
for (const words of [
  'set an alarm for um ten past six p.m.',
  'wake me up tomorrow at eight and give me a summary',
  'remind me in nine minutes that I have to call the library',
]) test(`hear104 time and label: ${words}`, () => {
  const result = parseAlarmTime(words, now, tz);
  assert.equal(result.status, 'ready');
  // C-TIME: the label is the model's argument now, so this asserts the clock survived the subject clause.
  if (words.includes('summary')) assert.match(result.confirmation, /^Alarm set for /);
  if (words.includes('library')) assert.equal(result.fireAtUtc, now + 540000);
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
    assert.match(result.confirmation, /^Alarm set for /, 'the read-back replaces the extracted label');
  }
});
test('hear104 quarter-to is a time, not a trailing label', () => {
  const result = parseAlarmTime('set an alarm at quarter to eight', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.match(result.confirmation, /^Alarm set for /);
});

test('hear104 a pending bare-number follow-up supplies hour and minute', () => {
  const result = parseAlarmTime('set an alarm Ten five, today', now, tz, modelAt(Date.parse('2026-10-28T14:05:00Z')));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-28T14:05:00Z'));
});

for (const [words, minute] of [
  ['set an alarm for fi twenty past five p.m.', 20],
  ['set an alarm for um five past five p.m.', 5],
  ['set an alarm for fi ten past five p.m.', 10],
] as const) test(`hear104 R5 one filler before spoken time: ${words}`, () => {
  const expected = Date.UTC(2026, 9, 29, 9, minute);
  const result = parseAlarmTime(words, now, tz, modelAt(expected));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, expected);
});
for (const time of [
  '5', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'five past five', 'twenty past five', 'twenty-five to five', 'thirty past five', 'forty past five', 'fifty to five',
  'quarter past five', 'half past five', 'noon', 'midnight',
]) test(`hear104 R5 filler does not change the instant: ${time}`, () => {
  const model = modelAt(Date.parse('2026-10-29T09:00:00Z'));
  const clean = parseAlarmTime(`set an alarm for ${time}`, now, tz, model);
  assert.equal(clean.status, 'ready');
  assert.deepEqual(parseAlarmTime(`set an alarm for um ${time}`, now, tz, model), clean);
});

test('C-RECUR: every day resolves the owner 24-hour wall time and the following day', () => {
  const t0 = Date.parse('2026-10-30T15:00:00+08:00');
  const result = parseAlarmTime('Every day at 22:30 remind me to go to bed.', t0, tz);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready' || !result.series) return;
  assert.equal(result.fireAtUtc, Date.parse('2026-10-30T22:30:00+08:00'));
  assert.match(result.confirmation, /^Alarm set for /);
  assert.equal(seriesNextFireAt(result.series, result.fireAtUtc), Date.parse('2026-10-31T22:30:00+08:00'));
  assert.equal(seriesText(result.series), 'every day at 22:30 Singapore time');
  assert.match(result.confirmation, /every day at 22:30 Singapore time/);
});

test('C-RECUR: every Saturday before and after ten, and the week after the fire', () => {
  const beforeAt = Date.parse('2026-10-31T09:00:00+08:00');
  const before = parseAlarmTime('Every Saturday at ten remind me to do one hour of cardio.', beforeAt, tz, modelAt(Date.parse('2026-10-31T10:00:00+08:00')));
  assert.equal(before.status, 'ready');
  if (before.status !== 'ready' || !before.series) return;
  assert.equal(before.fireAtUtc, Date.parse('2026-10-31T10:00:00+08:00'));
  assert.match(before.confirmation, /^Alarm set for /);
  assert.equal(seriesNextFireAt(before.series, before.fireAtUtc), Date.parse('2026-11-07T10:00:00+08:00'));
  assert.equal(seriesText(before.series), 'every Saturday at 10:00 Singapore time');
  const after = parseAlarmTime('Every Saturday at ten remind me to do one hour of cardio.', Date.parse('2026-10-31T11:00:00+08:00'), tz, modelAt(Date.parse('2026-11-07T10:00:00+08:00')));
  assert.equal(after.status, 'ready');
  if (after.status === 'ready') assert.equal(after.fireAtUtc, Date.parse('2026-11-07T10:00:00+08:00'));
});

test('C-RECUR: weekdays skip the weekend, and a fired weekday occurrence moves to the next weekday', () => {
  const friday = parseAlarmTime('Every weekday at nine am remind me to stretch.', Date.parse('2026-10-30T15:00:00+08:00'), tz);
  assert.equal(friday.status, 'ready');
  if (friday.status !== 'ready' || !friday.series) return;
  assert.equal(friday.fireAtUtc, Date.parse('2026-11-02T09:00:00+08:00'));
  assert.equal(seriesNextFireAt(friday.series, friday.fireAtUtc), Date.parse('2026-11-03T09:00:00+08:00'));
  const spoken = parseAlarmTime('on weekdays at nine am remind me to stretch', Date.parse('2026-10-30T15:00:00+08:00'), tz);
  assert.equal(spoken.status, 'ready');
  if (spoken.status === 'ready') assert.equal(spoken.fireAtUtc, Date.parse('2026-11-02T09:00:00+08:00'));
});

test('C-RECUR: an evening half past ten and a weekly weekday set stay exact', () => {
  const evening = parseAlarmTime('every day at half past ten in the evening remind me to wind down', Date.parse('2026-10-30T15:00:00+08:00'), tz);
  assert.equal(evening.status, 'ready');
  if (evening.status !== 'ready' || !evening.series) return;
  assert.equal(evening.series.hour, 22);
  assert.equal(evening.series.minute, 30);
  assert.deepEqual(parseSeriesRule('every saturday and sunday at ten'), { kind: 'weekly', weekdays: [0, 6] });
  const weekend = parseAlarmTime('every saturday and sunday at ten remind me to run', Date.parse('2026-10-30T15:00:00+08:00'), tz, modelAt(Date.parse('2026-10-31T10:00:00+08:00')));
  assert.equal(weekend.status, 'ready');
  if (weekend.status === 'ready' && weekend.series) assert.equal(seriesText(weekend.series), 'every Sunday and Saturday at 10:00 Singapore time');
});

test('C-RECUR: a host time zone change never moves a series', () => {
  const t0 = Date.parse('2026-10-30T15:00:00+08:00');
  const parsed = parseAlarmTime('Every Saturday at ten remind me to do cardio.', t0, tz, modelAt(Date.parse('2026-10-31T10:00:00+08:00')));
  assert.equal(parsed.status, 'ready');
  if (parsed.status !== 'ready' || !parsed.series) return;
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(parsed.series.tz, 'Asia/Singapore');
    assert.equal(seriesNextFireAt(parsed.series, t0), Date.parse('2026-10-31T10:00:00+08:00'));
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('C-RECUR: a model rule that the owner did not say is refused, and the owner\'s words win', () => {
  const daily = { kind: 'daily' as const, weekdays: [] };
  const weekly = { kind: 'weekly' as const, weekdays: [6] };
  assert.equal(verifyAlarmRule({}, weekly), true);
  assert.equal(verifyAlarmRule({ kind: 'weekly', weekdays: [6] }, weekly), true);
  assert.equal(verifyAlarmRule({ kind: 'daily' }, weekly), false);
  assert.equal(verifyAlarmRule({ kind: 'weekly', weekdays: [0] }, weekly), false);
  assert.equal(verifyAlarmRule({ kind: 'daily' }, undefined), false);
  assert.equal(verifyAlarmRule({ kind: 'daily' }, daily), true);
});

test('C-RECUR: cancel words choose one occurrence or the whole series', () => {
  assert.equal(parseCancelScope('skip this Saturday'), 'occurrence');
  assert.equal(parseCancelScope('cancel the alarm'), 'occurrence');
  assert.equal(parseCancelScope('stop the Saturday cardio reminders'), 'series');
  assert.equal(parseCancelScope('cancel the recurring reminder'), 'series');
});

test('C-RECUR: a non-recurring ask keeps its one-shot instant', () => {
  const oneShot = parseAlarmTime('set an alarm at 8', now, tz);
  assert.equal(oneShot.status, 'ready');
  if (oneShot.status === 'ready') assert.equal(oneShot.series, undefined);
  assert.equal(parseSeriesRule('set an alarm on Monday at ten'), undefined);
});

// #107: the owner's own wake-up, brief and check-in words carry their label and their clock.
test('#107 the owner phrasing that must reach the alarm block', () => {
  const now_ = Date.parse('2026-10-28T02:00:00Z');
  const wake = parseAlarmTime('wake up at 10:30 and remind me to go to sport', now_, tz);
  assert.equal(wake.status, 'ready');
  if (wake.status === 'ready') {
    assert.match(wake.confirmation, /^Alarm set for /);
  }
  const brief = parseAlarmTime('wake me at 7 and brief me', now_, tz);
  assert.equal(brief.status, 'ready');
  if (brief.status === 'ready') assert.match(brief.confirmation, /^Alarm set for /);
  const checkIn = parseAlarmTime('check in with me in an hour about the deck', now_, tz);
  assert.equal(checkIn.status, 'ready');
  if (checkIn.status === 'ready') {
    assert.match(checkIn.confirmation, /^Alarm set for /);
    assert.equal(checkIn.fireAtUtc, now_ + 3_600_000);
  }
  for (const ask of ['wake me at 7 and tell me about the deck', 'wake me at 7 and talk to me about the deck',
    'check in with me at 7 about the deck']) {
    const subject = parseAlarmTime(ask, now_, tz, modelAt(Date.parse('2026-10-28T07:00:00+08:00')));
    assert.equal(subject.status, 'ready', ask);
    if (subject.status === 'ready') assert.match(subject.confirmation, /^Alarm set for /, ask);
  }
  // A stated clock after the subject belongs to the alarm, never to the label.
  for (const ask of ['tell me about the deck at 9', 'talk to me about the deck at 9',
    'check in with me at 7 about the deck']) {
    const clocked = parseAlarmTime(ask, now_, tz, modelAt(Date.parse('2026-10-28T09:00:00+08:00')));
    assert.equal(clocked.status, 'ready', ask);
    if (clocked.status === 'ready') {
      assert.match(clocked.confirmation, /^Alarm set for /, ask);
      assert.doesNotMatch(clocked.confirmation.replace(/^Alarm set for /, ''), /\d{1,2}:\d{2}.*\d{1,2}:\d{2}/, ask);
    }
  }
  const standaloneBrief = parseAlarmTime('brief me at 7', now_, tz);
  assert.equal(standaloneBrief.status, 'ready');
  if (standaloneBrief.status === 'ready') assert.match(standaloneBrief.confirmation, /^Alarm set for /);
});
