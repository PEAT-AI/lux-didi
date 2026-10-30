import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { AlarmScheduler, type Alarm, type AlarmDue } from '../host/alarm-scheduler.js';
import { virtualClock } from './clock.js';

/**
 * Alarm state is the host's own: the real AlarmScheduler over a real Store, with the alarm clock replaced
 * by the virtual one. Nothing here reimplements alarm semantics, so a wake case exercises the production
 * write path (row, state machine, recheck) and only the clock differs.
 */
export interface AlarmWorld {
  set(fireAtUtc: number, label: string, tz: string): Alarm;
  list(): Alarm[];
  cancel(id: string): boolean;
  snooze(id: string, fireAtUtc: number): Alarm | undefined;
  acknowledge(id: string): boolean;
  /** Fires every due virtual timer in order; each due alarm is collected so the caller can speak it. */
  advanceTo(utc: number): AlarmDue[];
  status(id: string): 'scheduled' | 'ringing' | 'done' | 'cancelled' | 'missed';
  ripeCount(): number;
  close(): void;
}

export function alarmWorld(startUtc: number) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-eval-alarms-'));
  const store = new Store(dir, [...toolsMigrations]);
  const clock = virtualClock(startUtc);
  const due: AlarmDue[] = [];
  const scheduler = new AlarmScheduler({ store, clock, emit: event => { due.push(event); } });
  const world: AlarmWorld = {
    set(fireAtUtc, label, tz) {
      const alarm = scheduler.set({ fireAtUtc, tz, label, createdJournalId: 'eval' });
      scheduler.recheck('mutation');
      return alarm;
    },
    list: () => scheduler.list(),
    cancel: id => scheduler.cancel(id),
    snooze(id, fireAtUtc) {
      try { return scheduler.snooze(id, fireAtUtc, 'eval'); } catch { return undefined; }
    },
    acknowledge: id => scheduler.acknowledge(id),
    advanceTo(utc) {
      const before = due.length;
      clock.advanceTo(utc);
      return due.slice(before);
    },
    status(id) {
      const alarm = scheduler.list().find(row => row.id === id);
      if (!alarm) return 'missed';
      return alarm.state === 'pending' ? 'scheduled' : alarm.state;
    },
    ripeCount: () => scheduler.list().filter(alarm => alarm.state === 'ringing').length,
    close() {
      scheduler.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return { world, clock, store, scheduler };
}
