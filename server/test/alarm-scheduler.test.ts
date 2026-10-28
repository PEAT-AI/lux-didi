import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { AlarmScheduler, type AlarmDue } from '../host/alarm-scheduler.js';

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
