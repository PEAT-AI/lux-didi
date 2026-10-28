import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAlarmTime } from '../tools/alarm.js';

// Synthetic words and a fixed instant only. These tests never use the system clock.
const now = Date.parse('2026-10-28T13:00:00Z');
const tz = 'Asia/Singapore';

test('alarm: an unqualified eight needs clarification, without a write candidate', () => {
  assert.deepEqual(parseAlarmTime('set an alarm at 8', now, tz), { status: 'clarify', reason: 'ambiguous_time' });
});

test('alarm: wake me permits the morning default in the system IANA zone', () => {
  const result = parseAlarmTime('wake me at 8', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
  assert.equal(result.tz, tz);
  assert.equal(result.confirmation, 'Alarm set for 8:00 tomorrow morning.');
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
  parseAlarmTime('wake me at 8', now, 'Europe/London');
  assert.equal(result.fireAtUtc, Date.parse('2026-10-29T12:00:00Z'));
  assert.equal(result.tz, 'America/New_York');
});

test('alarm: spoken number words resolve without relying on a model digit conversion', () => {
  const result = parseAlarmTime('wake me at eight tomorrow morning', now, tz);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.fireAtUtc, Date.parse('2026-10-29T00:00:00Z'));
});
