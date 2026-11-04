import { AlarmScheduler } from '../host/alarm-scheduler.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, commitAlarmEffect } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/index.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { Authority, createTaskAuthority } from '../tasks/authority.js';
import { createRegistry, type TaskTool } from '../tasks/tools.js';
import { connectorExecutor } from '../tasks/connectors.js';
import { insertAlarmSeries, linkAlarmOccurrence, seriesNextFireAt } from '../tools/alarm.js';

export function alarmHarness(t: TestContext, recheck: () => void = () => {}, now: () => number = Date.now, timezone = 'UTC') {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-task-alarm-'));
  const migrations = [...domainMigrations, ...liveMigrations, ...toolsMigrations];
  const store = new Store(directory, migrations);
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic' });
  t.after(async () => { await port.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, grantMode: 'owner-trusted-reads',
    lookupAuthority: async () => null, timezone, alarms: { now, recheck, health: () => ({ degraded: false, reasons: [] }) } });
  const task = { id: 'synthetic-task', revision: 1, ownerWords: '', ownerTurn: 1, exposures: [] };
  let tools: Map<string, TaskTool>;
  const authority = createTaskAuthority(new Authority({ journal: store.taskEffectJournal(), checkEffect: async () => true, log() {} }), {
    isCurrent: (id, revision) => id === task.id && revision === task.revision,
    taskContext: id => id === task.id ? task : undefined, hostUrls: () => [], registry: () => tools,
  });
  tools = createRegistry({ authority, execute: connectorExecutor([], owner.taskExecutors('synthetic-session')) });
  const call = async (name: string, args: Record<string, unknown>, words: string) => {
    task.ownerWords = words;
    const tool = tools.get(name); assert.ok(tool);
    const omitted = Object.fromEntries(Object.entries(tool.parameters.properties as Record<string, { type?: unknown }>).filter(([, schema]) => Array.isArray(schema.type) && schema.type.includes('null')).map(([key]) => [key, null]));
    return tool.run({ ...omitted, ...args }, { task_id: task.id, task_revision: task.revision, operation_id: randomUUID(), connection_generation: 1 }, new AbortController().signal);
  };
  return { store, directory, migrations, call, task, tools, owner };
}

test('alarm atomicity: lost confirmation replays one alarm and a durable task receipt', async t => {
  const h = alarmHarness(t);
  const args = { text: 'synthetic reminder', at: new Date(Date.now() + 60_000).toISOString() };
  // Simulate losing the response only after the real task call has committed.
  await assert.rejects((async () => {
    assert.equal((await h.call('alarm_create', args, 'wake me in one minute')).status, 'ok');
    throw new Error('synthetic_lost_confirmation');
  })(), /synthetic_lost_confirmation/);
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
  const replay = await h.call('alarm_create', args, 'wake me in one minute');
  assert.equal(replay.status, 'ok');
  assert.equal(replay.receipt?.state, 'committed');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
  h.store.close(); // A restarted process must acquire the released single-writer lock.
  const recovered = new Store(h.directory, h.migrations);
  try {
    assert.equal(recovered.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
    assert.equal(recovered.transaction(tx => tx.get("SELECT COUNT(*) AS n FROM task_effect_journal WHERE status='succeeded'")?.n), 1);
  } finally { recovered.close(); }
});

test('SOURCE DEFECT alarm atomicity: scheduler failure after insertion retains a replayable receipt', async t => {
  let crash = true;
  const h = alarmHarness(t, () => { if (crash) { crash = false; throw new Error('synthetic_crash_after_commit'); } });
  const args = { text: 'synthetic crash reminder', at: new Date(Date.now() + 60_000).toISOString() };
  // The real task authority catches executor errors. The committed alarm must still
  // have a successful durable receipt, not a failed action that cannot be retried.
  await h.call('alarm_create', args, 'wake me in one minute');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
  const replay = await h.call('alarm_create', args, 'wake me in one minute');
  assert.equal(replay.status, 'ok', 'the committed alarm must replay after scheduler notification fails');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
  assert.equal(h.store.transaction(tx => tx.get("SELECT COUNT(*) AS n FROM task_effect_journal WHERE status='succeeded'")?.n), 1);
});

test('SOURCE DEFECT C-RECUR: recurring task creation persists one replay-safe series', async t => {
  const h = alarmHarness(t);
  const rule = { kind: 'weekly' as const, weekdays: [6], hour: 10, minute: 0, tz: 'Asia/Singapore' };
  const args = { text: 'synthetic cardio', at: new Date(seriesNextFireAt(rule, Date.now())).toISOString() };
  await h.call('alarm_create', args, 'every Saturday at ten remind me to do one hour of cardio');
  await h.call('alarm_create', args, 'every Saturday at ten remind me to do one hour of cardio');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_series')?.n), 1);
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_occurrences')?.n), 1);
});

async function cancelHarness(t: TestContext) {
  const h = alarmHarness(t);
  const rule = { kind: 'weekly' as const, weekdays: [6], hour: 10, minute: 0, tz: 'Asia/Singapore' };
  const seriesId = randomUUID(), occurrenceId = randomUUID();
  const fireAtUtc = seriesNextFireAt(rule, Date.now());
  h.store.transaction(tx => {
    insertAlarmSeries(tx, { id: seriesId, rule, label: 'synthetic cardio', createdJournalId: 'synthetic-scope' });
    tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,'pending','synthetic-scope')", [occurrenceId, fireAtUtc, rule.tz, 'synthetic cardio']);
    linkAlarmOccurrence(tx, occurrenceId, seriesId);
  });
  const cancel = (args: Record<string, string>, _journalId: string, words: string) => h.call('alarm_cancel', args, words);
  const series = () => h.store.transaction(tx => ({ state: String(tx.get('SELECT state FROM alarm_series WHERE id=?', [seriesId])?.state), pending: Number(tx.get("SELECT COUNT(*) AS n FROM alarm_occurrences o JOIN alarms a ON a.id=o.alarm_id WHERE o.series_id=? AND a.state IN ('pending','ringing')", [seriesId])?.n) }));
  return { ...h, cancel, series, seriesId, occurrenceId, rule, fireAtUtc };
}

test('SOURCE DEFECT C-RECUR M2: skip this Saturday with a series id cancels only that occurrence', async t => {
  const h = await cancelHarness(t);
  await h.cancel({ id: h.seriesId, scope: 'occurrence' }, 'synthetic-skip-journal', 'skip this Saturday');
  assert.equal(h.series().state, 'active', 'the owner said one Saturday, so the series stays');
  assert.equal(h.series().pending, 1, 'the next occurrence is materialised at once');
  assert.equal(h.store.transaction(tx => tx.get('SELECT state FROM alarms WHERE id=?', [h.occurrenceId])?.state), 'cancelled');
  const next = h.store.transaction(tx => tx.get("SELECT a.fire_at_utc FROM alarm_occurrences o JOIN alarms a ON a.id=o.alarm_id WHERE o.series_id=? AND a.state='pending'", [h.seriesId]));
  assert.equal(Number(next?.fire_at_utc), seriesNextFireAt(h.rule, h.fireAtUtc));
});

test('SOURCE DEFECT C-RECUR M2: stop the Saturday cardio reminders with an occurrence id cancels the series', async t => {
  const h = await cancelHarness(t);
  await h.cancel({ id: h.occurrenceId, scope: 'series' }, 'synthetic-stop-journal', 'stop the Saturday cardio reminders');
  assert.equal(h.series().state, 'cancelled', 'the owner said the reminders, so the series is cancelled, not deleted');
  assert.equal(h.series().pending, 0, 'no occurrence is left behind');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_series')?.n), 1, 'the cancelled series row is kept');
});

test('task recurrence tools accept an explicit rule and update the durable series, not a one-shot substitute', async t => {
  const now = Date.UTC(2030, 0, 1);
  const h = alarmHarness(t, () => {}, () => now, 'UTC');
  const rule = { kind: 'daily' as const, weekdays: [], hour: 12, minute: 0, tz: 'UTC' };
  const created = await h.call('alarm_create', { text: 'synthetic daily', at: new Date(now + 3_600_000).toISOString(), recurrence: rule }, 'set this repeating reminder');
  assert.equal(created.status, 'ok', created.repair ?? created.text);
  const id = created.references[0]!.id;
  assert.equal(h.store.transaction(tx => tx.get('SELECT rule_kind FROM alarm_series WHERE id=?', [id])?.rule_kind), 'daily');
  const weekly = { ...rule, kind: 'weekly' as const, weekdays: [6], hour: 10 };
  const updated = await h.call('alarm_update', { id, text: null, at: null, recurrence: weekly }, 'change the repeating rule');
  assert.equal(updated.status, 'ok', updated.repair ?? updated.text);
  const persisted = h.store.transaction(tx => tx.get('SELECT rule_kind,weekdays,local_time FROM alarm_series WHERE id=?', [id]));
  assert.equal(persisted?.rule_kind, 'weekly');
  assert.equal(persisted?.weekdays, '6');
  assert.equal(persisted?.local_time, '10:00');
  assert.equal(Number(h.store.transaction(tx => tx.get('SELECT fire_at_utc FROM alarms WHERE id=?', [id])?.fire_at_utc)), seriesNextFireAt(weekly, now));
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_occurrences WHERE series_id=?', [id])?.n), 1);
});


test('atomic alarm receipt rolls back with the alarm and respects disabled content retention', t => {
  const h = alarmHarness(t);
  const identity = 'synthetic-atomic-policy';
  const value = { status: 'ok' as const, text: 'synthetic receipt content', references: [], next_cursor: null, coverage: '', repair: null };
  assert.throws(() => commitAlarmEffect(h.store, identity, tx => {
    tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES('synthetic-rollback',?,'UTC','synthetic','pending','synthetic')", [Date.now() + 60000]);
    throw Error('synthetic-rollback');
  }), /synthetic-rollback/);
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 0);
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM task_effect_journal')?.n), 0);
  const journal = h.store.taskEffectJournal();
  commitAlarmEffect(h.store, identity, () => value);
  assert.equal(h.store.transaction(tx => tx.get('SELECT value FROM task_effect_journal')?.value), null);
  return journal.get(identity).then(record => {
    assert.equal(record?.status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(record), /synthetic receipt content/);
  });
});

for (const action of ['update', 'cancel'] as const) {
  test(`alarm ${action}: missing and stale ids fail honestly, active id still commits`, async t => {
    const now = Date.UTC(2026, 10, 4, 12);
    const h = alarmHarness(t, () => {}, () => now);
    h.store.transaction(tx => {
      for (const [id, state] of [['synthetic-active', 'pending'], ['synthetic-stale', 'cancelled']]) {
        tx.run('INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,?,?)',
          [id!, now + 120_000, 'UTC', 'Synthetic reminder', state!, 'synthetic-seed']);
      }
    });
    const args = (id: string) => action === 'update' ? { id, text: 'Updated synthetic reminder' } : { id };
    for (const id of ['synthetic-missing', 'synthetic-stale']) {
      const result = await h.call(`alarm_${action}`, args(id), `Please ${action} that alarm`);
      assert.equal(result.status, 'failed');
      assert.match(result.repair ?? '', /That alarm is not active/);
      assert.match(result.repair ?? '', /synthetic-active/, 'repair includes the still-active alternatives');
      assert.doesNotMatch(result.repair ?? '', /outcome.*unknown|unknown.*outcome/i);
      assert.equal(h.store.transaction(tx => tx.get("SELECT COUNT(*) AS n FROM task_effect_journal WHERE status IN ('pending','unknown','outcome_unknown')"))?.n, 0);
      assert.equal(h.store.transaction(tx => tx.get('SELECT state FROM alarms WHERE id=?', ['synthetic-active']))?.state, 'pending');
    }
    const valid = await h.call(`alarm_${action}`, args('synthetic-active'), `Please ${action} that alarm`);
    assert.equal(valid.status, 'ok', valid.repair ?? valid.text);
    const active = h.store.transaction(tx => tx.get('SELECT state,label FROM alarms WHERE id=?', ['synthetic-active']));
    assert.equal(active?.state, action === 'cancel' ? 'cancelled' : 'pending');
    if (action === 'update') assert.equal(active?.label, 'Updated synthetic reminder');
  });
}


test('cancelling an acknowledged and snoozed recurring alarm settles every outstanding occurrence', async t => {
  let now = Date.UTC(2030, 0, 1, 8);
  let scheduler: AlarmScheduler | undefined;
  const h = alarmHarness(t, () => scheduler?.recheck('mutation'), () => now);
  const due: string[] = [];
  scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => now, setTimeout: () => 1, clearTimeout() {} }, emit: alarm => due.push(alarm.id) });
  t.after(() => scheduler?.stop());
  const created = await h.call('alarm_create', { text: 'Synthetic recurring reminder', at: new Date(now + 60_000).toISOString(), recurrence: { kind: 'daily', weekdays: [], hour: 8, minute: 1, tz: 'UTC' } }, 'remind me every day at 08:01');
  assert.equal(created.status, 'ok', created.repair ?? created.text);
  const originalId = created.references[0]!.id;
  now += 60_000;
  scheduler.recheck('mutation');
  assert.deepEqual(due, [originalId]);
  assert.equal(scheduler.acknowledge(originalId), true, 'actual acknowledgment materializes the next occurrence');
  const seriesId = h.store.transaction(tx => String(tx.get('SELECT series_id FROM alarm_occurrences WHERE alarm_id=?', [originalId])!.series_id));
  const outstanding = () => h.store.transaction(tx => tx.all("SELECT a.id,a.fire_at_utc,a.state FROM alarms a JOIN alarm_occurrences o ON o.alarm_id=a.id WHERE o.series_id=? AND a.state IN ('pending','ringing')", [seriesId]));
  assert.equal(outstanding().length, 1, 'acknowledgment has really materialized the next daily occurrence');
  const snoozed = await h.call('alarm_update', { id: originalId, at: new Date(now + 5 * 60_000).toISOString() }, 'snooze this alarm for five minutes');
  assert.equal(snoozed.status, 'ok', snoozed.repair ?? snoozed.text);
  const snoozedId = snoozed.references[0]!.id;
  assert.notEqual(snoozedId, originalId);
  const pending = outstanding();
  assert.equal(pending.length, 2, 'the snooze and materialized daily occurrence both belong to the real series');
  const cancelled = await h.call('alarm_cancel', { id: snoozedId, scope: 'series' }, 'cancel the entire recurring alarm series');
  assert.equal(cancelled.status, 'ok', cancelled.repair ?? cancelled.text);
  assert.equal(cancelled.receipt?.state, 'committed');
  assert.equal(h.store.transaction(tx => tx.get('SELECT state FROM alarm_series WHERE id=?', [seriesId])!.state), 'cancelled');
  assert.deepEqual(outstanding(), [], 'successful series cancellation leaves no occurrence that can ring');
  for (const row of pending) assert.equal(h.store.transaction(tx => tx.get('SELECT state FROM alarms WHERE id=?', [String(row.id)])!.state), 'cancelled');
  now = Math.max(...pending.map(row => Number(row.fire_at_utc))) + 1;
  scheduler.recheck('mutation');
  assert.deepEqual(due, [originalId], 'neither cancelled occurrence emits alarm_due after both deadlines');
});
