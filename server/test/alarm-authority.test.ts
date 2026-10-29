import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerRequests } from '../tools/owner-request.js';
import { parseAlarmTime } from '../tools/alarm.js';

for (const [operation, words] of [
  ['set_alarm', 'wake me at 8'], ['list_alarms', 'show my alarms'],
  ['cancel_alarm', 'cancel my alarm'], ['snooze_alarm', 'snooze my alarm for five minutes'],
] as const) {
  test(`alarm authority: ${operation} requires an unexpired finalized owner request`, () => {
    let now = 1000;
    const gate = new OwnerRequests(() => now);
    assert.equal(gate.authorize('s', operation, 'target').code, 'no_owner_request');
    gate.observe('s', 'j1', words);
    assert.equal(gate.authorize('s', operation, 'target').code, 'allowed');
    assert.equal(gate.authorize('other', operation, 'target').code, 'no_owner_request');
    now += 120001;
    assert.equal(gate.authorize('s', operation, 'target').code, 'request_expired');
  });
}

test('alarm authority: a fragment fills only an explicit host clarification and does not extend age', () => {
  let mono = 0;
  const gate = new OwnerRequests(() => mono);
  const wall = Date.parse('2026-10-28T13:00:00Z');
  gate.observe('s', 'j1', 'set an alarm');
  const ask = gate.authorize('s', 'set_alarm', 'alarm');
  const missing = parseAlarmTime(ask.words!, wall, 'Asia/Singapore');
  assert.deepEqual(missing, { status: 'clarify', reason: 'missing_time' });
  gate.clarify('s', 'set_alarm', 'missing_time');
  mono = 100000;
  gate.observe('s', 'j2', 'in one minute');
  const joined = gate.authorize('s', 'set_alarm', 'alarm');
  const parsed = parseAlarmTime(joined.words!, wall, 'Asia/Singapore');
  assert.equal(parsed.status, 'ready');
  gate.commit('s', 'set_alarm', 'alarm', { status: 'set' });
  assert.equal(gate.authorize('s', 'set_alarm', 'other').code, 'grant_spent');
  mono = 120001;
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'request_expired');
});

test('hear104 alarm authority: finals join until the completed answer', () => {
  const gate = new OwnerRequests(() => 0);
  gate.observe('s', 'j1', 'set an alarm at eleven ten');
  gate.observe('s', 'j2', 'a.m. Singapore time');
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').words, 'set an alarm at eleven ten a.m. Singapore time');
  gate.answered('s');
  gate.observe('s', 'j3', 'what is the weather?');
  gate.observe('s', 'j4', 'a.m. Singapore time');
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'no_owner_request');
});
