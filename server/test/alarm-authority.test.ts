import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerTasks } from '../tools/owner-task.js';
import { parseAlarmTime } from '../tools/alarm.js';

for (const [operation, words] of [
  ['set_alarm', 'wake me at 8'], ['list_alarms', 'show my alarms'],
  ['cancel_alarm', 'cancel my alarm'], ['snooze_alarm', 'snooze my alarm for five minutes'],
] as const) {
  test(`alarm authority: ${operation} requires an unexpired finalized owner request`, () => {
    let now = 1000;
    const gate = new OwnerTasks(() => now);
    assert.equal(gate.authorize('s', operation, 'target').code, 'no_owner_request');
    gate.observe('s', 'j1', words);
    assert.equal(gate.authorize('s', operation, 'target').code, 'allowed');
    assert.equal(gate.authorize('other', operation, 'target').code, 'no_owner_request');
    // D2: ten minutes of owner silence ends the task, so the ask is gone rather than merely expired.
    now += 600001;
    assert.equal(gate.authorize('s', operation, 'target').code, 'no_owner_request');
  });
}

test('alarm authority: a fragment fills only an explicit host clarification and does not extend age', () => {
  let mono = 0;
  const gate = new OwnerTasks(() => mono);
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
  // D2 replaces the two minute window: the ask stands for ten minutes after his LAST final (mono 100000),
  // so only then does the task end and the receipt stop replaying.
  mono = 100000 + 600001;
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'no_owner_request');
});

test('hear104 alarm authority: finals join while the task lives and a model reply closes nothing', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'set an alarm at eleven ten');
  gate.observe('s', 'j2', 'a.m. Singapore time');
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').words, 'set an alarm at eleven ten a.m. Singapore time');
  // D2: no model turnComplete closes the task, so the operation still stands after a model reply.
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'allowed');
  // An unrelated question keeps the operation open, and the owner's next fragment still joins it.
  gate.observe('s', 'j3', 'what is the weather?');
  gate.observe('s', 'j4', 'at eleven ten');
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'allowed');
});

test('alarm authority: a recurring ask authorizes one set_alarm and a replay creates nothing', () => {
  const gate = new OwnerTasks();
  gate.observe('s', 'j-recur', 'Every Saturday at ten remind me to do one hour of cardio.');
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'allowed');
  const request = gate.currentId('s');
  assert.ok(request);
  assert.equal(gate.claim('s', 'set_alarm', 'alarm', request).code, 'allowed');
  // The operation is consumed by its committed success: a retry of the same target replays the
  // receipt, a different target is spent, and no model turnComplete closes anything.
  gate.commit('s', 'set_alarm', 'alarm', { status: 'set', id: 'a1' });
  const replay = gate.authorize('s', 'set_alarm', 'alarm');
  assert.equal(replay.code, 'idempotent');
  assert.deepEqual(replay.code === 'idempotent' ? replay.receipt : undefined, { status: 'set', id: 'a1' });
  assert.equal(gate.authorize('s', 'set_alarm', 'other').code, 'grant_spent');
});
