import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { AlarmScheduler, AlarmShellBridge, type AlarmDue, type AlarmShellFrame } from '../host/alarm-scheduler.js';
import { randomUUID } from 'node:crypto';
import { cancelAlarmSeries, insertAlarmSeries, linkAlarmOccurrence, listPendingAlarms, seriesNextFireAt } from '../tools/alarm.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-alarm-'));
  const store = new Store(dir, toolsMigrations);
  let now = Date.parse('2026-10-28T00:00:00Z');
  const due: AlarmDue[] = [];
  const timers: Array<() => void> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { assert.ok(ms >= 0 && ms <= 60000); timers.push(fn); return timers.length; },
    clearTimeout: (_id: unknown) => {},
  };
  const create = () => new AlarmScheduler({ store, clock, emit: event => due.push(event) });
  const scheduler = create();
  t.after(() => { scheduler.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, scheduler, due, timers, create, now: () => now, advance: (ms: number) => { now += ms; } };
}

test('alarm scheduler: due commit precedes delivery and reconnect preserves the deadline', t => {
  const f = fixture(t);
  const row = f.scheduler.set({ fireAtUtc: f.now() + 1000, tz: 'UTC', label: '', createdJournalId: 'synthetic-journal' });
  assert.equal(f.scheduler.list()[0]?.state, 'pending');
  f.advance(1000);
  f.scheduler.recheck('clock_changed');
  assert.equal(f.due.length, 1);
  assert.equal(f.scheduler.list()[0]?.state, 'ringing');
  const deadline = f.due[0]!.ringDeadlineUtc;
  assert.equal(deadline, f.now() + 600000);
  f.scheduler.stop();
  f.advance(45000);
  const recovered = f.create();
  recovered.recheck('start');
  assert.equal(f.due.length, 2);
  assert.equal(f.due[1]!.id, row.id);
  assert.equal(f.due[1]!.ringDeadlineUtc, deadline);
  recovered.recheck('mutation');
  assert.equal(f.due.length, 2, 'ordinary requery must not replay an already delivered occurrence');
  f.advance(600000);
  recovered.recheck('wake');
  assert.equal(recovered.list()[0]?.state, 'missed');
  assert.equal(f.due.length, 2);
  recovered.stop();
});

test('alarm scheduler: nineteen minutes late rings; twenty-one is missed', t => {
  const f = fixture(t);
  f.scheduler.set({ fireAtUtc: f.now() + 1000, tz: 'UTC', label: '', createdJournalId: 'j1' });
  f.scheduler.set({ fireAtUtc: f.now() + 121000, tz: 'UTC', label: '', createdJournalId: 'j2' });
  f.advance(1261000);
  f.scheduler.recheck('wake');
  assert.equal(f.due.length, 1);
  assert.equal(f.scheduler.list().find(row => row.createdJournalId === 'j1')?.state, 'missed');
  assert.equal(f.scheduler.list().find(row => row.createdJournalId === 'j2')?.state, 'ringing');
  assert.equal(f.due[0]?.createdJournalId, 'j2');
});

test('alarm scheduler: bounded waits and simultaneous alarms', t => {
  const f = fixture(t);
  const at = f.now() + 86400000;
  for (let i = 0; i < 2; i++) f.scheduler.set({ fireAtUtc: at, tz: 'Asia/Singapore', label: '', createdJournalId: `j${i}` });
  f.scheduler.recheck('start');
  f.advance(-3600000);
  f.scheduler.recheck('clock_changed');
  assert.equal(f.due.length, 0);
  f.advance(90000000);
  f.scheduler.recheck('clock_changed');
  assert.equal(f.due.length, 2);
  assert.equal(new Set(f.due.map(row => row.id)).size, 2);
});

test('alarm scheduler: snooze completes old occurrence atomically and cannot resurrect it', t => {
  const f = fixture(t);
  const original = f.scheduler.set({ fireAtUtc: f.now() + 1000, tz: 'UTC', label: '', createdJournalId: 'j' });
  f.advance(1000);
  f.scheduler.recheck('wake');
  const next = f.scheduler.snooze(original.id, f.now() + 300000, 'j2');
  assert.equal(f.scheduler.list().find(row => row.id === original.id)?.state, 'done');
  assert.equal(next.state, 'pending');
  assert.throws(() => f.scheduler.snooze(original.id, f.now() + 300000, 'j3'), /alarm_not_active/);
  f.scheduler.recheck('reconnect');
  assert.equal(f.due.length, 1);
  assert.equal(f.scheduler.cancel(next.id), true);
  f.advance(300000);
  f.scheduler.recheck('wake');
  assert.equal(f.due.length, 1);
});

test('alarm scheduler: persisted instant and zone survive a real process time-zone change', t => {
  const f = fixture(t);
  const priorZone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(zone, 'America/New_York');
    const row = f.scheduler.set({ fireAtUtc: f.now() + 86400000, tz: zone, label: '', createdJournalId: 'zone-change' });
    process.env.TZ = 'Europe/London';
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London');
    f.scheduler.recheck('timezone_changed');
    const stored = f.store.transaction(tx => tx.get('SELECT fire_at_utc,tz FROM alarms WHERE id=?', [row.id]));
    assert.equal(stored?.fire_at_utc, row.fireAtUtc);
    assert.equal(stored?.tz, 'America/New_York');
    assert.equal(f.scheduler.list().find(alarm => alarm.id === row.id)?.fireAtUtc, row.fireAtUtc);
  } finally {
    if (priorZone === undefined) delete process.env.TZ;
    else process.env.TZ = priorZone;
  }
});

test('alarm scheduler: a queued due timer rechecks the instant after a backward clock jump', t => {
  const f = fixture(t);
  const at = f.now() + 1000;
  const alarm = f.scheduler.set({ fireAtUtc: at, tz: 'UTC', label: '', createdJournalId: 'backward' });
  f.scheduler.recheck('start');
  const queued = f.timers.at(-1)!;
  assert.equal(typeof queued, 'function');
  f.advance(1001); // The original timer is due, but its callback has not run yet.
  f.advance(-2000);
  queued(); // Deliver the already-queued callback against the new wall clock.
  assert.equal(f.due.length, 0);
  assert.equal(f.scheduler.list().find(row => row.id === alarm.id)?.state, 'pending');
  assert.equal(f.scheduler.list().find(row => row.id === alarm.id)?.fireAtUtc, at);
  f.advance(2000);
  f.scheduler.recheck('clock_changed');
  assert.equal(f.due.length, 1);
  const deadline = f.due[0]!.ringDeadlineUtc;
  f.advance(-2000);
  f.scheduler.recheck('clock_changed');
  assert.equal(f.due.length, 1);
  const ringing = f.scheduler.list().find(row => row.id === alarm.id)!;
  assert.equal(ringing.state, 'ringing');
  assert.equal(ringing.ringDeadlineUtc, deadline);
});

test('C-SAFETY: operator stop cancels pending and ringing alarms through scheduler state', t => {
  const f = fixture(t);
  const ringing = f.scheduler.set({ fireAtUtc: f.now() + 1000, tz: 'UTC', label: '', createdJournalId: 'synthetic-ring' });
  f.scheduler.set({ fireAtUtc: f.now() + 60000, tz: 'UTC', label: '', createdJournalId: 'synthetic-pending' });
  f.advance(1000); f.scheduler.recheck('timer');
  assert.equal(f.scheduler.list().find(row => row.id === ringing.id)?.state, 'ringing');
  assert.equal((f.scheduler as AlarmScheduler & { cancelAll(): number }).cancelAll(), 2);
  assert.ok(f.scheduler.list().every(row => row.state === 'cancelled'));
});

const SERIES_TZ = 'Asia/Singapore';
const saturday = { kind: 'weekly' as const, weekdays: [6], hour: 10, minute: 0, tz: SERIES_TZ };

function openSeries(f: ReturnType<typeof fixture>, rule: Parameters<typeof seriesNextFireAt>[0]) {
  const seriesId = randomUUID();
  const firstId = randomUUID();
  const fireAtUtc = seriesNextFireAt(rule, f.now());
  f.store.transaction(tx => {
    insertAlarmSeries(tx, { id: seriesId, rule, label: 'do one hour of cardio', createdJournalId: 'synthetic-series' });
    tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,'pending','synthetic-series')", [firstId, fireAtUtc, rule.tz, 'do one hour of cardio']);
    linkAlarmOccurrence(tx, firstId, seriesId);
  });
  f.scheduler.recheck('mutation');
  return { seriesId, firstId, fireAtUtc };
}

function pendingRows(f: ReturnType<typeof fixture>) {
  return f.store.transaction(tx => tx.all("SELECT id,fire_at_utc FROM alarms WHERE state IN ('pending','ringing') ORDER BY fire_at_utc,id")
    .map(row => ({ id: String(row.id), fireAtUtc: Number(row.fire_at_utc) })));
}

function seriesState(f: ReturnType<typeof fixture>, seriesId: string) {
  return f.store.transaction(tx => tx.get('SELECT state FROM alarm_series WHERE id=?', [seriesId])?.state);
}

test('C-RECUR: a restart between fire and acknowledgement keeps exactly one pending occurrence', t => {
  const f = fixture(t);
  const s = openSeries(f, saturday);
  assert.equal(pendingRows(f).length, 1);
  f.advance(s.fireAtUtc - f.now());
  f.scheduler.recheck('timer');
  assert.equal(f.scheduler.list().find(row => row.id === s.firstId)?.state, 'ringing');
  f.scheduler.stop();
  const recovered = f.create();
  recovered.recheck('start');
  recovered.recheck('reconnect');
  assert.equal(pendingRows(f).length, 1, 'a restart never materialises a second occurrence');
  recovered.acknowledge(s.firstId);
  const next = pendingRows(f);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.fireAtUtc, seriesNextFireAt(saturday, s.fireAtUtc));
  recovered.stop();
});

test('C-RECUR: a duplicate recheck does not double-materialise, and a missed occurrence materialises one', t => {
  const f = fixture(t);
  const s = openSeries(f, saturday);
  f.advance(s.fireAtUtc - f.now());
  f.scheduler.recheck('timer');
  f.scheduler.acknowledge(s.firstId);
  f.scheduler.recheck('mutation');
  f.scheduler.recheck('mutation');
  f.scheduler.recheck('wake');
  const next = pendingRows(f);
  assert.equal(next.length, 1);
  f.advance(next[0]!.fireAtUtc - f.now() + 21 * 60000);
  f.scheduler.recheck('wake');
  assert.equal(f.scheduler.list().find(row => row.id === next[0]!.id)?.state, 'missed');
  const afterMiss = pendingRows(f);
  assert.equal(afterMiss.length, 1, 'a missed occurrence settles its series exactly once');
  assert.equal(afterMiss[0]!.fireAtUtc, seriesNextFireAt(saturday, next[0]!.fireAtUtc));
});

test('C-RECUR: skipping one occurrence keeps the series, cancelling the series stops it', t => {
  const f = fixture(t);
  const s = openSeries(f, saturday);
  assert.equal(f.scheduler.cancel(s.firstId), true);
  const next = pendingRows(f);
  assert.equal(next.length, 1, 'skipping one Saturday keeps exactly one pending occurrence');
  assert.equal(next[0]!.fireAtUtc, seriesNextFireAt(saturday, s.fireAtUtc));
  assert.equal(seriesState(f, s.seriesId), 'active');
  const cancelled = f.store.transaction(tx => cancelAlarmSeries(tx, s.seriesId));
  assert.equal(cancelled, 1);
  assert.equal(seriesState(f, s.seriesId), 'cancelled');
  assert.equal(pendingRows(f).length, 0);
  assert.equal(f.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_series')?.n), 1, 'a cancelled series is kept, never silently deleted');
});

test('C-RECUR: snoozing moves the ringing occurrence only and the series continues', t => {
  const f = fixture(t);
  const s = openSeries(f, saturday);
  f.advance(s.fireAtUtc - f.now());
  f.scheduler.recheck('timer');
  const snoozed = f.scheduler.snooze(s.firstId, f.now() + 300000, 'synthetic-snooze');
  assert.equal(pendingRows(f).length, 1);
  assert.equal(f.store.transaction(tx => tx.get('SELECT series_id FROM alarm_occurrences WHERE alarm_id=?', [snoozed.id])?.series_id), s.seriesId);
  f.advance(300000);
  f.scheduler.recheck('timer');
  f.scheduler.acknowledge(snoozed.id);
  const next = pendingRows(f);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.fireAtUtc, seriesNextFireAt(saturday, snoozed.fireAtUtc), 'the series keeps its own schedule, not the snoozed hour');
});

test('C-RECUR: list shows the rule with its next occurrence, and stop cancels the series without deleting it', t => {
  const f = fixture(t);
  const s = openSeries(f, { kind: 'daily', weekdays: [], hour: 22, minute: 30, tz: SERIES_TZ });
  const entries = f.store.transaction(tx => listPendingAlarms(tx));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.series?.id, s.seriesId);
  assert.equal(entries[0]?.series?.text, 'every day at 22:30 Singapore time');
  assert.equal((f.scheduler as AlarmScheduler & { cancelAll(): number }).cancelAll(), 1);
  assert.equal(seriesState(f, s.seriesId), 'cancelled');
  assert.equal(pendingRows(f).length, 0);
  f.scheduler.recheck('wake');
  assert.equal(pendingRows(f).length, 0, 'a stopped series never materialises another occurrence');
});

test('C-RECUR: operator stop publishes the settled state so the shell stops ringing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-alarm-stop-'));
  const store = new Store(dir, toolsMigrations);
  let now = Date.parse('2026-10-28T00:00:00Z');
  const frames: AlarmShellFrame[] = [];
  const shell = new AlarmShellBridge();
  const unbind = shell.bind(frame => { frames.push(frame); return true; });
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  // The runtime wires exactly this pair: changed -> alarmShell.state(rows).
  const scheduler = new AlarmScheduler({ store, clock, emit: () => {}, changed: rows => shell.state(rows) });
  t.after(() => { unbind(); scheduler.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  scheduler.set({ fireAtUtc: now + 1000, tz: 'UTC', label: '', createdJournalId: 'synthetic-stop' });
  now += 1000;
  scheduler.recheck('timer');
  const ringing = frames.at(-1);
  assert.equal(ringing?.type, 'alarm_state');
  assert.equal(ringing?.type === 'alarm_state' ? ringing.alarms[0]?.state : undefined, 'ringing');
  frames.length = 0;
  assert.equal((scheduler as AlarmScheduler & { cancelAll(): number }).cancelAll(), 1);
  const settled = frames.at(-1);
  assert.equal(settled?.type, 'alarm_state', 'the shell bridge receives a state frame on stop');
  assert.equal(settled?.type === 'alarm_state' ? settled.alarms[0]?.state : undefined, 'cancelled', 'the frame carries the cancelled rows, so the ring stops');
});
