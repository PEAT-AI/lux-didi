import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
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
  const authority = createTaskAuthority(new Authority({ journal: store.taskEffectJournal(() => true), checkEffect: async () => true, log() {} }), {
    isCurrent: (id, revision) => id === task.id && revision === task.revision,
    taskContext: id => id === task.id ? task : undefined, hostUrls: () => [], registry: () => tools,
  });
  tools = createRegistry({ authority, execute: connectorExecutor([], owner.taskExecutors('synthetic-session')) });
  const call = async (name: string, args: Record<string, unknown>, words: string) => {
    task.ownerWords = words;
    const tool = tools.get(name); assert.ok(tool);
    return tool.run(args, { task_id: task.id, task_revision: task.revision, operation_id: randomUUID(), connection_generation: 1 }, new AbortController().signal);
  };
  return { store, directory, migrations, call, task, tools };
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
