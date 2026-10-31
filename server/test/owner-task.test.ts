import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerTasks, ownerCommands, ownerDurationMinutes, OWNER_TASK_IDLE_MS } from '../tools/owner-task.js';
import { requestRefusal } from '../tools/owner-task.js';
import { parseAlarmTime } from '../tools/alarm.js';

const kinds = (words: string): string[] => ownerCommands(words).map(command => command.kind);

// D2 (a): one plain owner ask reaches each write kind, with no cue hunting and no model reading.
for (const [kind, words] of [
  ['set_alarm', 'wake me at eight tomorrow'],
  ['create_event', 'put cardio in my calendar at eleven'],
  ['draft_email', 'draft an email to Sam about lunch'],
  ['draft_chat', 'draft a mattermost message to Sam'],
  ['delete_event', 'cancel my calendar block'],
  ['lux_note', 'note that the boiler code is 4471'],
  ['open', 'open my calendar'],
  ['list_alarms', 'show my alarms'],
  ['cancel_alarm', 'cancel my alarm'],
  ['snooze_alarm', 'snooze my alarm for five minutes'],
] as const) {
  test(`D2: a plain ask grants ${kind}`, () => {
    const gate = new OwnerTasks(() => 0);
    gate.observe('s', 'j1', words);
    assert.equal(gate.authorize('s', kind, 'target').code, 'allowed', words);
  });
}

test('D2: the same ask grants each kind it names, and nothing it does not', () => {
  assert.deepEqual(kinds('draft an email to Sam and put lunch in my calendar at noon'), ['create_event', 'draft_email']);
  assert.deepEqual(kinds('the alarm in the movie was loud'), ['set_alarm']);
  assert.deepEqual(kinds('cancel my alarm and show my alarms'), ['list_alarms', 'cancel_alarm']);
  assert.deepEqual(kinds('remember this and open my inbox'), ['lux_note', 'open']);
});

// D2: a bare noun mention, a question, a negation and a past statement grant nothing.
test('D2 (h): noncommands create nothing and grant nothing', () => {
  const gate = new OwnerTasks(() => 0);
  for (const words of ['I put the meeting in my calendar yesterday', "don't book anything", 'did you book the gym?', 'what is on my calendar?']) {
    assert.deepEqual(kinds(words), [], words);
    gate.observe('s', 'j', words);
    assert.equal(gate.authorize('s', 'create_event', 'target').code, 'no_owner_request', words);
  }
});

// D2: note, save and remember need the owner's own save cue; a bare mention is not authority.
test('D2 (f): a note call without an owner save cue is refused', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'the boiler note is in the garage folder');
  assert.equal(gate.authorize('s', 'lux_note', 'note').code, 'no_owner_request');
  gate.observe('s', 'j2', 'notier dir: der Schlüssel liegt im Schrank');
  assert.equal(gate.authorize('s', 'lux_note', 'note').code, 'allowed');
});

// D2: text from a read is never authority, so a read ask grants no write of any kind.
test('D2 (f): an owner read-mail ask grants no tool-result-driven write', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'read my mail from Sam');
  gate.source('s', 'web', gate.currentId('s')!);
  assert.equal(gate.authorize('s', 'draft_email', 'draft').code, 'no_owner_request');
  assert.equal(gate.authorize('s', 'create_event', 'event').code, 'no_owner_request');
  assert.equal(gate.externalContentPresent('s'), true);
});

// D2 (c): filler and a clarifying question between the ask and the call never refuse.
test('D2 (c): filler and a clarify keep the operation; the owner answer executes', () => {
  let mono = 0;
  const gate = new OwnerTasks(() => mono);
  gate.observe('s', 'j1', 'set an alarm');
  const first = gate.authorize('s', 'set_alarm', 'alarm');
  assert.equal(first.code, 'allowed');
  assert.deepEqual(parseAlarmTime(first.words!, Date.parse('2026-10-28T13:00:00Z'), 'Asia/Singapore'), { status: 'clarify', reason: 'missing_time' });
  gate.clarify('s', 'set_alarm', 'missing_time');
  // The model answers with a question of its own, and the owner fills a moment later.
  gate.observe('s', 'j2', 'hmm, ok');
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'allowed');
  mono = 200_000;
  gate.observe('s', 'j3', 'in one minute');
  const joined = gate.authorize('s', 'set_alarm', 'alarm');
  assert.equal(joined.code, 'allowed');
  assert.equal(parseAlarmTime(joined.words!, Date.parse('2026-10-28T13:00:00Z'), 'Asia/Singapore').status, 'ready');
});

// D2 (b): a sentence split by endpointing arrives as three finals and still yields one operation.
test('D2 (b): three finals of one calendar sentence yield exactly one operation with his times', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'put a block in my calendar');
  gate.observe('s', 'j2', 'tomorrow at noon');
  gate.observe('s', 'j3', 'for two hours');
  const ask = gate.authorize('s', 'create_event', 'event');
  assert.equal(ask.code, 'allowed');
  assert.match(ask.words!, /tomorrow at noon/);
  assert.match(ask.words!, /for two hours/);
  assert.deepEqual(ownerCommands(ask.words!).filter(command => command.kind === 'create_event').map(command => command.fields.durationMinutes), [120]);
  assert.equal(gate.audit('s', 'create_event').ownerFinals, 3);
});

// D2 (e): an amendment amends the same operation; a second unrelated event needs new owner words.
test('D2 (e): an amendment amends one operation and a new event needs new owner words', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'put cardio in my calendar at eleven');
  gate.observe('s', 'j2', 'make it an hour');
  const amended = gate.authorize('s', 'create_event', 'event-1');
  assert.equal(amended.code, 'allowed');
  assert.match(amended.words!, /make it an hour/);
  assert.equal(gate.claim('s', 'create_event', 'event-1', gate.currentId('s')!).code, 'allowed');
  gate.commit('s', 'create_event', 'event-1', { status: 'created', id: 'e1' }, gate.currentId('s')!);
  // A second event with no new owner words is refused, not silently created.
  assert.equal(gate.authorize('s', 'create_event', 'event-2').code, 'grant_spent');
  gate.observe('s', 'j3', 'put the dentist in my calendar on Friday at nine');
  assert.equal(gate.authorize('s', 'create_event', 'event-2').code, 'allowed');
});

// D4: the intent is journaled before dispatch and a replay with a new provider call id returns the receipt.
test('D4: a replay of the committed operation returns the receipt and writes nothing again', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'put lunch in my calendar at noon');
  assert.equal(gate.authorize('s', 'create_event', 'event-args').code, 'allowed');
  const receipt = { status: 'created', event_id: 'e-1' };
  assert.equal(gate.claim('s', 'create_event', 'event-args', gate.currentId('s')!).code, 'allowed');
  // Journaled before dispatch: the claim alone already refuses a second dispatch of other arguments.
  assert.equal(gate.authorize('s', 'create_event', 'other-args').code, 'grant_spent');
  gate.commit('s', 'create_event', 'event-args', receipt, gate.currentId('s')!);
  // A new provider call id is irrelevant: the key is (taskId, operationId).
  const replay = gate.authorize('s', 'create_event', 'event-args');
  assert.equal(replay.code, 'idempotent');
  assert.deepEqual(replay.code === 'idempotent' ? replay.receipt : undefined, receipt);
});

test('D4: a change of canonical arguments against the same operation is refused', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'set an alarm at seven');
  assert.equal(gate.authorize('s', 'set_alarm', 'seven').code, 'allowed');
  assert.equal(gate.claim('s', 'set_alarm', 'seven', gate.currentId('s')!).code, 'allowed');
  assert.equal(gate.claim('s', 'set_alarm', 'eight', gate.currentId('s')!).code, 'grant_spent');
});

test('D2: a failed dispatch returns the operation, and an owner cancel ends the task', () => {
  const gate = new OwnerTasks(() => 0);
  gate.observe('s', 'j1', 'set an alarm at seven');
  assert.equal(gate.authorize('s', 'set_alarm', 'seven').code, 'allowed');
  gate.claim('s', 'set_alarm', 'seven', gate.currentId('s')!);
  gate.failed('s', 'set_alarm', 'seven', gate.currentId('s')!);
  assert.equal(gate.authorize('s', 'set_alarm', 'seven').code, 'allowed');
  gate.observe('s', 'j2', 'forget it');
  assert.equal(gate.authorize('s', 'set_alarm', 'seven').code, 'no_owner_request');
});

test('D2: a task closes on ten minutes of owner silence, not on a model turn or a rebuild', () => {
  let mono = 0;
  const gate = new OwnerTasks(() => mono);
  gate.observe('s', 'j1', 'wake me at seven');
  mono = OWNER_TASK_IDLE_MS - 1;
  // A provider rebuild touches nothing: the operation and its words are still there.
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'allowed');
  mono = OWNER_TASK_IDLE_MS + 1;
  assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'no_owner_request');
});

// RULING G-R1: every wake-up phrasing the owner uses is one set_alarm construction.
for (const words of [
  'wake up at 10:30 and remind me to go to sport',
  'wake me at 7 and brief me',
  'check in with me in an hour about the deploy',
  'in 20 minutes remind me',
  'weck mich um 7',
  'erinner mich um sieben an den Termin',
]) {
  test(`G-R1: "${words}" is a set_alarm command`, () => {
    assert.deepEqual(kinds(words), ['set_alarm'], words);
    const gate = new OwnerTasks(() => 0);
    gate.observe('s', 'j1', words);
    assert.equal(gate.authorize('s', 'set_alarm', 'alarm').code, 'allowed', words);
  });
}

test('D2: German-mixed phrasing is read by the same deterministic constructions', () => {
  assert.deepEqual(kinds('weck mich um sieben'), ['set_alarm']);
  assert.deepEqual(kinds('trag morgen einen Termin ein'), ['create_event']);
  assert.deepEqual(kinds('öffne die Mail app'), ['open']);
});

test('D2: a length the owner named is pinned on the operation', () => {
  assert.equal(ownerDurationMinutes('for two hours'), 120);
  assert.equal(ownerDurationMinutes('for 90 minutes'), 90);
  assert.equal(ownerDurationMinutes('at eleven'), undefined);
});

test('every refusal the operation layer returns carries the host sentence for its code', () => {
  for (const code of ['no_owner_request', 'request_expired', 'grant_spent']) {
    assert.equal(requestRefusal(code).status, 'refused');
    assert.ok(requestRefusal(code).say.length > 0);
  }
});
