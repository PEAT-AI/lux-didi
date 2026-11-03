import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authority, configuredEffectCheck, type EffectCheckInput, type JournalRecord } from '../tasks/authority.js';

import type { ModelPort, ModelRequest } from '../adapters/model/types.js';

const task = { id: 'task-1', revision: 1, ownerWords: 'Read the mail' };
function setup(answer: boolean | Error = true) {
  const calls: EffectCheckInput[] = [];
  const events: string[] = [];
  const records = new Map<string, JournalRecord>();
  const authority = new Authority({
    checkEffect: async input => { calls.push(input); if (answer instanceof Error) throw answer; return answer; },
    log: event => { events.push(event); },
    journal: {
      get: async id => records.get(id),
      put: async (id, record) => { records.set(id, record); },
    },
  });
  return { authority, calls, events, records };
}
const request = { task, effect: 'draft_email' as const, arguments: { content: 'untrusted' }, validate: () => true };

test('clean reversible write runs without a model call; invalid arguments do not', async () => {
  const { authority, calls } = setup(false);
  assert.deepEqual(await authority.authorize(request), { allow: true });
  assert.equal(calls.length, 0);
  const denied = await authority.authorize({ ...request, validate: () => false });
  assert.equal(denied.allow, false);
  if (!denied.allow) { assert.equal(denied.code, 'invalid_arguments'); assert.ok(denied.repair); }
});

test('mail injection cannot authorize a write; the isolated call has no arguments or target', async () => {
  const { authority, calls } = setup(false);
  authority.expose(task.id, 'mail');
  const result = await authority.authorize(request);
  assert.equal(result.allow, false);
  if (!result.allow) { assert.equal(result.code, 'not_owner_asked'); assert.ok(result.repair); }
  assert.deepEqual(calls, [{ ownerWords: task.ownerWords, effect: 'draft_email' }]);
  await authority.authorize(request);
  assert.equal(calls.length, 1);
});

for (const words of ['Read her mail then draft a reply', 'Read the mail and handle what she asks', 'Draft to whoever owns the migration']) {
  test(`requested effect after exposure: ${words}`, async () => {
    const { authority } = setup();
    authority.expose(task.id, 'mail');
    assert.deepEqual(await authority.authorize({ ...request, task: { ...task, ownerWords: words } }), { allow: true });
  });
}

test('new clause in a revision gets a fresh decision and short follow-up gets prior owner words', async () => {
  const { authority, calls } = setup();
  authority.expose(task.id, 'web');
  await authority.authorize(request);
  await authority.authorize({ ...request, task: { ...task, revision: 2, ownerWords: 'And draft the reply', shortFollowUp: true, precedingOwnerWords: task.ownerWords } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { ownerWords: 'And draft the reply', precedingOwnerWords: task.ownerWords, effect: 'draft_email' });
});

test('retained outside evidence counts; local memory and calendar do not', async () => {
  for (const source of ['mail', 'chat', 'web', 'drive', 'company'] as const) {
    const { authority, calls } = setup();
    authority.expose(task.id, 'memory', [source]);
    await authority.authorize(request);
    assert.equal(calls.length, 1, source);
  }
  const { authority, calls } = setup();
  for (const source of ['memory', 'calendar', 'alarms'] as const) authority.expose(task.id, source);
  await authority.authorize(request);
  assert.equal(calls.length, 0);
});

test('check failure allows and logs; concurrent checks share one call', async () => {
  const { authority, calls, events } = setup(new Error('offline'));
  authority.expose(task.id, 'mail');
  assert.deepEqual(await Promise.all([authority.authorize(request), authority.authorize(request)]), [{ allow: true }, { allow: true }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(events, ['effect_check_failed']);
});

test('delete stages exact target and requires a later finalized turn', async () => {
  const { authority } = setup();
  const deletion = { ...request, effect: 'delete_event' as const, eventId: 'event-a', ownerTurn: 1 };
  const staged = await authority.authorize(deletion);
  assert.equal(staged.allow, false);
  if (!staged.allow) assert.equal(staged.code, 'confirmation_required');
  assert.equal(authority.confirmDelete(task.id, 'event-b', 2), false);
  assert.equal(authority.confirmDelete(task.id, 'event-a', 1), false);
  assert.equal(authority.confirmDelete(task.id, 'event-a', 2), true);
  assert.deepEqual(await authority.authorize({ ...deletion, ownerTurn: 2 }), { allow: true });
});

test('commit journals before execution and a duplicate resolves without another write', async () => {
  const { authority, records } = setup();
  let writes = 0;
  const execute = async () => { assert.equal(records.get('action-a')?.status, 'pending'); writes++; return { saved: true }; };
  const first = await authority.commit('action-a', execute);
  const replay = await authority.commit('action-a', execute);
  assert.equal(writes, 1);
  assert.deepEqual(first, { allow: true, value: { saved: true }, replay: false });
  assert.deepEqual(replay, { allow: true, value: { saved: true }, replay: true });
});

test('configured client receives only owner words and closed effect, never worker context', async () => {
  let sent: ModelRequest | undefined;
  const model: ModelPort = { generate: async (input: ModelRequest) => { sent = input; return { status: 'complete', text: 'yes', providerContent: { role: 'model', parts: [{ text: 'yes' }] }, reason: '', prompt: { version: 'fake', hash: 'fake', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } }; } };
  const check = configuredEffectCheck(model);
  assert.equal(await check({ ownerWords: 'Read and draft', effect: 'draft_email' }), true);
  assert.deepEqual(sent?.context, { items: [], selectedIds: [], maxChars: 0 });
  assert.deepEqual(sent?.contents, [{ role: 'user', parts: [{ text: '{"ownerWords":"Read and draft","effect":"draft_email"}' }] }]);
  assert.equal(sent?.declarations, undefined);
});

test('timeout signal fails open and logs without a clock wait or provider call', async () => {
  const fake = setup();
  const authority = new Authority({ checkEffect: configuredEffectCheck({ generate: async () => assert.fail('provider called') }, { timeoutSignal: () => AbortSignal.abort() }), journal: { get: async id => fake.records.get(id), put: async (id, value) => { fake.records.set(id, value); } }, log: event => { fake.events.push(event); } });
  authority.expose(task.id, 'mail');
  assert.deepEqual(await authority.authorize(request), { allow: true });
  assert.deepEqual(fake.events, ['effect_check_failed']);
});

test('pending outcome is never executed a second time', async () => {
  const { authority, records } = setup();
  records.set('action-a', { status: 'pending' });
  const result = await authority.commit('action-a', async () => assert.fail('duplicate execution'));
  assert.equal(result.allow, false);
  if (!result.allow) assert.equal(result.code, 'outcome_unknown');
});
