import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authority, configuredEffectCheck, refusal, REPAIRS, type RefusalCode, type EffectCheckInput, type JournalRecord } from '../tasks/authority.js';

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
  await authority.authorize({ ...request, task: { ...task, revision: 2, ownerWords: 'And draft the reply', precedingOwnerWords: task.ownerWords } });
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
  assert.deepEqual(await authority.authorize({ ...deletion, ownerTurn: 1 }), refusal('confirmation_required'));
  assert.deepEqual(await authority.authorize({ ...deletion, ownerTurn: 2, eventId: 'event-b' }), refusal('confirmation_required'));
  assert.deepEqual(await authority.authorize({ ...deletion, ownerTurn: 3, eventId: 'event-b' }), { allow: true });
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

const refusalCodes: RefusalCode[] = ['invalid_arguments', 'unknown_tool', 'source_unavailable', 'not_owner_asked', 'confirmation_required', 'confirmation_unavailable', 'egress_blocked', 'cancelled', 'superseded', 'deadline_exceeded', 'write_failed', 'outcome_unknown'];
test('closed refusal vocabulary has no legacy phrase, expiry or research codes', () => {
  assert.deepEqual(Object.keys(REPAIRS).sort(), [...refusalCodes].sort());
});
for (const code of refusalCodes) {
  test(`refusal ${code} carries actionable repair and does not block a valid clean task`, async () => {
    const result = refusal(code);
    assert.equal(result.allow, false);
    if (!result.allow) {
      assert.equal(result.code, code);
      assert.ok(result.repair.length > 20);
      assert.match(result.repair, /correct|choose|try|report|ask|use|wait|check|describe/i);
    }
    assert.deepEqual(await setup().authority.authorize(request), { allow: true });
  });
}

test('unknown effect is refused while a registered effect runs', async () => {
  const { authority } = setup();
  const denied = await authority.authorize({ ...request, effect: 'send_mail' as typeof request.effect });
  assert.equal(denied.allow, false);
  if (!denied.allow) assert.equal(denied.code, 'unknown_tool');
  assert.deepEqual(await authority.authorize(request), { allow: true });
});

test('known failed write is not repeated while a different action can succeed', async () => {
  const { authority, records } = setup();
  records.set('failed-action', { status: 'failed' });
  const failed = await authority.commit('failed-action', async () => assert.fail('must not repeat'));
  assert.equal(failed.allow, false);
  if (!failed.allow) assert.equal(failed.code, 'write_failed');
  assert.equal((await authority.commit('new-action', async () => ({ saved: true }))).allow, true);
});

test('uncertain connector failure is not retried; a separate valid action succeeds', async () => {
  const { authority } = setup();
  let attempts = 0;
  const execute = async () => { attempts++; throw new Error('remote outcome lost'); };
  for (let i = 0; i < 2; i++) {
    const result = await authority.commit('uncertain-action', execute);
    assert.equal(result.allow, false);
    if (!result.allow) assert.equal(result.code, 'outcome_unknown');
  }
  assert.equal(attempts, 1);
  assert.equal((await authority.commit('separate-action', async () => 'saved')).allow, true);
});

test('pending outcome is never executed a second time', async () => {
  const { authority, records } = setup();
  records.set('action-a', { status: 'pending' });
  const result = await authority.commit('action-a', async () => assert.fail('duplicate execution'));
  assert.equal(result.allow, false);
  if (!result.allow) assert.equal(result.code, 'outcome_unknown');
});

// Exercises the real permission layer through the worker port, not FakeAuthority.
import { createTaskAuthority } from '../tasks/authority.js';
import { createRegistry } from '../tasks/tools.js';
import type { ToolResult } from '../tasks/results.js';
const portResult: ToolResult = { status: 'ok', text: 'Saved.', references: [], next_cursor: null, coverage: 'Complete.', repair: null };
function portFixture(answer = true) {
  let current = true, checked = 0, executed = 0;
  const records = new Map<string, JournalRecord>();
  const permission = new Authority({ checkEffect: async () => { checked++; return answer; }, log: () => {}, journal: { get: async id => records.get(id), put: async (id, value) => { records.set(id, value); } } });
  const context = { isCurrent: () => current, taskContext: () => ({ id: 't', revision: 1, ownerWords: 'Save this note', ownerTurn: 7, exposures: ['mail'] as const }), hostUrls: () => [] as string[], registry: () => registry };
  const port = createTaskAuthority(permission, context);
  const registry = createRegistry({ authority: port, execute: async () => portResult });
  const request = { task_id: 't', task_revision: 1, operation_id: 'op', connection_generation: 1, tool: 'remember_note', effect: 'local' as const, args: { text: 'Synthetic note' }, outside_text: false };
  return { port, request, records, stale: () => { current = false; }, checked: () => checked, executed: () => executed, execute: async () => { executed++; return portResult; } };
}
test('worker authority rejects stale and cancelled before admission, paired with current admission', async () => {
  const stale = portFixture(); stale.stale();
  assert.equal((await stale.port.authorize(stale.request, stale.execute, new AbortController().signal)).repair, REPAIRS.superseded);
  assert.equal(stale.checked(), 0); assert.equal(stale.executed(), 0);
  const cancelled = portFixture();
  assert.equal((await cancelled.port.authorize(cancelled.request, cancelled.execute, AbortSignal.abort())).repair, REPAIRS.cancelled);
  assert.equal(cancelled.checked(), 0);
  const valid = portFixture(); assert.equal((await valid.port.authorize(valid.request, valid.execute, new AbortController().signal)).status, 'ok'); assert.equal(valid.executed(), 1);
});
test('worker authority denial cannot execute, paired with owner-requested write', async () => {
  const denied = portFixture(false);
  assert.equal((await denied.port.authorize(denied.request, denied.execute, new AbortController().signal)).repair, REPAIRS.not_owner_asked);
  assert.equal(denied.executed(), 0);
  const valid = portFixture(); await valid.port.authorize(valid.request, valid.execute, new AbortController().signal); assert.equal(valid.checked(), 1); assert.equal(valid.executed(), 1);
});
test('worker commit identity deduplicates revisions but not different arguments', async () => {
  const f = portFixture(); const signal = new AbortController().signal;
  await f.port.authorize(f.request, f.execute, signal);
  await f.port.authorize({ ...f.request, task_revision: 2, operation_id: 'new' }, f.execute, signal);
  assert.equal(f.executed(), 1);
  await f.port.authorize({ ...f.request, args: { text: 'Different note' } }, f.execute, signal);
  assert.equal(f.executed(), 2);
});

test('abortion during admission cannot reach commit, paired with unaborted write', async () => {
  const abort = new AbortController(); let executed = 0;
  const permission = new Authority({ checkEffect: async () => { abort.abort(); return true; }, log: () => {}, journal: { get: async () => undefined, put: async () => {} } });
  const port = createTaskAuthority(permission, { isCurrent: () => true,
    taskContext: () => ({ id: 't', revision: 1, ownerWords: 'Save this note', ownerTurn: 1, exposures: ['mail'] }),
    hostUrls: () => [], registry: () => registry });
  const registry = createRegistry({ authority: port, execute: async () => portResult });
  const request = portFixture().request;
  const result = await port.authorize(request, async () => { executed++; return portResult; }, abort.signal);
  assert.equal(result.repair, REPAIRS.cancelled); assert.equal(executed, 0);
  const valid = portFixture(); await valid.port.authorize(valid.request, valid.execute, new AbortController().signal); assert.equal(valid.executed(), 1);
});

import { TASK_EFFECTS } from '../tasks/authority.js';
test('each registry write has a closed effect mapping and accepted open schema replaces old kinds', () => {
  const f = portFixture();
  const registry = createRegistry({ authority: f.port, execute: async () => portResult });
  for (const tool of registry.values()) if (tool.effect !== 'none') assert.ok(TASK_EFFECTS[tool.name], tool.name);
  assert.ok(registry.has('find_file'));
  assert.deepEqual((registry.get('open')!.parameters.properties as Record<string, { enum?: string[] }>).kind!.enum, ['web', 'app', 'file', 'source']);
});

test('VOICE-R3 deletion confirmation is call-scoped exact-target latest-turn and fails closed', async () => {
  let current = { id: 'first', revision: 1, ownerWords: 'Delete the synthetic event', latestOwnerWords: 'Delete the synthetic event', ownerTurn: 1, exposures: [] as const };
  let fail = false, executed = 0; const seen: EffectCheckInput[] = [];
  const authority = new Authority({ checkEffect: async input => { seen.push(input); if (fail) throw new Error('synthetic timeout'); return input.ownerWords === 'Yes, delete it'; }, log: () => {}, journal: { get: async () => undefined, put: async () => {} } });
  const port = createTaskAuthority(authority, { isCurrent: () => true, taskContext: () => current, hostUrls: () => [], registry: () => registry });
  const registry = createRegistry({ authority: port, execute: async () => portResult });
  const deletion = (eventId = 'event-a') => port.authorize({ task_id: current.id, task_revision: current.revision, operation_id: `op${current.ownerTurn}`, connection_generation: 1, tool: 'delete_event', effect: 'destructive', args: { id: eventId }, outside_text: false }, async () => { executed++; return portResult; }, new AbortController().signal);
  assert.equal((await deletion()).repair, REPAIRS.confirmation_required);
  current.latestOwnerWords = 'Yes, delete it';
  assert.equal((await deletion()).repair, REPAIRS.confirmation_required, 'same turn cannot confirm');
  assert.equal(seen.length, 0);
  current = { ...current, id: 'second', ownerTurn: 2, latestOwnerWords: 'What is the weather?' };
  assert.equal((await deletion()).status, 'failed'); assert.equal(executed, 0);
  current = { ...current, ownerTurn: 3, latestOwnerWords: 'Yes, delete it' }; fail = true;
  assert.equal((await deletion()).status, 'failed'); assert.equal(executed, 0);
  fail = false; current = { ...current, ownerTurn: 4 };
  assert.equal((await deletion('event-b')).repair, REPAIRS.confirmation_required);
  assert.equal((await deletion('event-b')).repair, REPAIRS.confirmation_required, 'new target cannot inherit confirmation');
  current = { ...current, id: 'third', ownerTurn: 5 };
  assert.equal((await deletion('event-b')).status, 'ok'); assert.equal(executed, 1);
  assert.deepEqual(seen.at(-1), { effect: 'confirm_delete_event', ownerWords: 'Yes, delete it' });
  authority.endCall();
  current = { ...current, id: 'fourth', ownerTurn: 6 };
  assert.equal((await deletion('event-b')).repair, REPAIRS.confirmation_required, 'stage dies with call');
});

test('earlier owner context is always available to the ordinary effect check', async () => {
  const { authority, calls } = setup(); authority.expose(task.id, 'mail');
  await authority.authorize({ ...request, task: { ...task, precedingOwnerWords: 'Earlier synthetic owner request' } });
  assert.equal(calls[0]?.precedingOwnerWords, 'Earlier synthetic owner request');
});

test('VOICE-R5 a replaced stage cannot be confirmed by an older deferred check', async () => {
  let resolve!: (answer: boolean) => void; let checking!: () => void;
  const started = new Promise<void>(done => { checking = done; });
  const authority = new Authority({ checkEffect: async () => { checking(); return new Promise<boolean>(done => { resolve = done; }); }, log: () => {}, journal: { get: async () => undefined, put: async () => {} } });
  let current = { id: 't', revision: 1, ownerWords: 'Delete the event', latestOwnerWords: 'Delete the event', ownerTurn: 1, exposures: [] as const };
  const port = createTaskAuthority(authority, { isCurrent: () => true, taskContext: () => current, hostUrls: () => [], registry: () => registry });
  let writes = 0;
  const registry = createRegistry({ authority: port, execute: async () => portResult });
  const deletion = (id: string) => port.authorize({ task_id: 't', task_revision: 1, operation_id: id, connection_generation: 1, tool: 'delete_event', effect: 'destructive', args: { id }, outside_text: false }, async () => { writes++; return portResult; }, new AbortController().signal);
  await deletion('A'); current = { ...current, ownerTurn: 2, latestOwnerWords: 'Yes, delete it' };
  const a = deletion('A'); await started;
  assert.equal((await deletion('B')).repair, REPAIRS.confirmation_required);
  resolve(true);
  assert.equal((await a).repair, REPAIRS.confirmation_required); assert.equal(writes, 0);
  assert.equal(authority.stagedDeletion()?.eventId, 'B');
});

test('VOICE-R5 a sequential confirmation consumes its exact stage once', async () => {
  const { authority } = setup();
  const deletion = { ...request, effect: 'delete_event' as const, eventId: 'A', ownerTurn: 1 };
  assert.deepEqual(await authority.authorize(deletion), refusal('confirmation_required'));
  assert.deepEqual(await authority.authorize({ ...deletion, ownerTurn: 2 }), { allow: true });
  assert.equal(authority.stagedDeletion(), undefined);
  assert.deepEqual(await authority.authorize({ ...deletion, ownerTurn: 2 }), refusal('confirmation_required'));
  assert.equal(authority.stagedDeletion()?.ownerTurn, 2);
});
