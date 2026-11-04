import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authority, type JournalRecord, type EffectKind } from '../tasks/authority.js';
import { parseAlarmTime } from '../tools/alarm.js';

function harness() {
  const journal = new Map<string, JournalRecord>();
  const checks: string[] = [];
  const authority = new Authority({
    journal: { get: async id => journal.get(id), put: async (id, record) => { journal.set(id, record); } },
    checkEffect: async input => { checks.push(input.ownerWords); return input.ownerWords.includes('alarm'); },
    log() {},
  });
  return { authority, journal, checks };
}

// OwnerRequests' expiring session grants were retired. A host-created task now supplies
// identity and finalized owner context; local alarms are free until outside exposure.
for (const effect of ['set_alarm', 'cancel_alarm', 'snooze_alarm'] satisfies EffectKind[]) {
  test(`alarm authority: ${effect} admits a local task and checks exposed owner context`, async () => {
    const { authority, checks } = harness();
    const request = { task: { id: 'synthetic-task', revision: 1, ownerWords: 'change my alarm' }, effect,
      arguments: {}, validate: () => true };
    assert.deepEqual(await authority.authorize(request), { allow: true });
    assert.deepEqual(checks, [], 'unexposed local effects need no model check');
    authority.expose(request.task.id, 'web');
    assert.deepEqual(await authority.authorize(request), { allow: true });
    assert.deepEqual(checks, ['change my alarm']);
    const unrelated = { ...request, task: { ...request.task, revision: 2, ownerWords: 'what is the weather?' } };
    assert.deepEqual(await authority.authorize(unrelated), { allow: false, code: 'not_owner_asked',
      repair: 'The owner has not asked for this kind of action. Report that fact and ask what they want done.' });
  });
}

test('alarm authority: clarified finalized words retain the original time context', async () => {
  const { authority, checks } = harness();
  const wall = Date.parse('2026-10-28T13:00:00Z');
  assert.deepEqual(parseAlarmTime('set an alarm', wall, 'Asia/Singapore'), { status: 'clarify', reason: 'missing_time' });
  const ownerWords = 'set an alarm in one minute';
  assert.equal(parseAlarmTime(ownerWords, wall, 'Asia/Singapore').status, 'ready');
  authority.expose('synthetic-task', 'web');
  assert.deepEqual(await authority.authorize({ task: { id: 'synthetic-task', revision: 2, ownerWords },
    effect: 'set_alarm', arguments: {}, validate: () => true }), { allow: true });
  assert.deepEqual(checks, [ownerWords], 'authority receives host task context, not tool text');
});

test('alarm authority: recurring operation replay returns its durable result without executing again', async () => {
  const { authority, journal } = harness();
  let creates = 0;
  const create = async () => { creates++; return { id: 'synthetic-series' }; };
  assert.deepEqual(await authority.commit('synthetic-task:alarm-create', create),
    { allow: true, value: { id: 'synthetic-series' }, replay: false });
  assert.deepEqual(await authority.commit('synthetic-task:alarm-create', create),
    { allow: true, value: { id: 'synthetic-series' }, replay: true });
  assert.equal(creates, 1);
  assert.deepEqual(journal.get('synthetic-task:alarm-create'), { status: 'succeeded', value: { id: 'synthetic-series' } });
});
