import { randomUUID } from 'node:crypto';
import type { StorePort, SQLRow, Transaction } from '../contracts/storage.js';

export type AlarmState = 'pending' | 'ringing' | 'done' | 'cancelled' | 'missed';
export interface Alarm {
  id: string; fireAtUtc: number; tz: string; label: string; state: AlarmState;
  createdJournalId: string; ringStartedAtUtc: number | null; ringDeadlineUtc: number | null;
}
export interface AlarmDue extends Alarm { state: 'ringing'; ringStartedAtUtc: number; ringDeadlineUtc: number }
export interface AlarmClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export type AlarmRecheck = 'start' | 'reconnect' | 'wake' | 'clock_changed' | 'timezone_changed' | 'mutation' | 'timer';
const read = (row: SQLRow): Alarm => ({
  id: String(row.id), fireAtUtc: Number(row.fire_at_utc), tz: String(row.tz), label: String(row.label),
  state: row.state as AlarmState, createdJournalId: String(row.created_journal_id),
  ringStartedAtUtc: row.ring_started_at_utc === null ? null : Number(row.ring_started_at_utc),
  ringDeadlineUtc: row.ring_deadline_utc === null ? null : Number(row.ring_deadline_utc),
});

/** SQLite owns the occurrence and deadline; delivery never changes either. */
export class AlarmScheduler {
  private timer: unknown;
  private stopped = false;
  private delivered = new Set<string>();
  constructor(private readonly options: { store: StorePort; clock: AlarmClock; emit(event: AlarmDue): void }) {}
  list(): Alarm[] {
    return this.options.store.transaction(tx => tx.all('SELECT * FROM alarms ORDER BY fire_at_utc,id').map(read));
  }
  private insert(tx: Transaction, input: { fireAtUtc: number; tz: string; label: string; createdJournalId: string }): Alarm {
    const alarm: Alarm = { ...input, id: randomUUID(), state: 'pending', ringStartedAtUtc: null, ringDeadlineUtc: null };
    tx.run('INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,?,?)',
      [alarm.id, alarm.fireAtUtc, alarm.tz, alarm.label, alarm.state, alarm.createdJournalId]);
    return alarm;
  }
  set(input: { fireAtUtc: number; tz: string; label: string; createdJournalId: string }): Alarm {
    const row = this.options.store.transaction(tx => this.insert(tx, input));
    this.recheck('mutation');
    return row;
  }
  cancel(id: string): boolean {
    const changed = this.options.store.transaction(tx => tx.run("UPDATE alarms SET state='cancelled' WHERE id=? AND state IN ('pending','ringing')", [id]));
    this.recheck('mutation');
    return changed === 1;
  }
  acknowledge(id: string): boolean {
    const changed = this.options.store.transaction(tx => tx.run("UPDATE alarms SET state='done' WHERE id=? AND state='ringing'", [id]));
    this.recheck('mutation');
    return changed === 1;
  }
  snooze(id: string, fireAtUtc: number, createdJournalId: string): Alarm {
    const row = this.options.store.transaction(tx => {
      const old = tx.get("SELECT * FROM alarms WHERE id=? AND state IN ('pending','ringing')", [id]);
      if (!old) throw Error('alarm_not_active');
      tx.run("UPDATE alarms SET state='done' WHERE id=?", [id]);
      return this.insert(tx, { fireAtUtc, tz: String(old.tz), label: String(old.label), createdJournalId });
    });
    this.recheck('mutation');
    return row;
  }
  recheck(reason: AlarmRecheck): void {
    if (this.stopped) return;
    const { clock, store } = this.options;
    if (this.timer !== undefined) clock.clearTimeout(this.timer);
    this.timer = undefined;
    const now = clock.now();
    const ringing = store.transaction(tx => {
      tx.run("UPDATE alarms SET state='missed' WHERE state='pending' AND fire_at_utc<=?", [now - 1200000]);
      tx.run("UPDATE alarms SET state='missed' WHERE state='ringing' AND ring_deadline_utc<=?", [now]);
      tx.run("UPDATE alarms SET state='ringing',ring_started_at_utc=?,ring_deadline_utc=? WHERE state='pending' AND fire_at_utc<=?", [now, now + 600000, now]);
      return tx.all("SELECT * FROM alarms WHERE state='ringing' ORDER BY fire_at_utc,id").map(read) as AlarmDue[];
    });
    // Reconnect replays the same id and persisted deadline. The shell deduplicates occurrences.
    for (const alarm of ringing) {
      if (this.delivered.has(alarm.id) && reason !== 'reconnect') continue;
      this.options.emit(alarm);
      this.delivered.add(alarm.id);
    }
    const active = this.list().filter(row => row.state === 'pending' || row.state === 'ringing');
    if (active.length) {
      const next = Math.min(...active.map(row => row.state === 'pending' ? row.fireAtUtc : row.ringDeadlineUtc!));
      this.timer = clock.setTimeout(() => this.recheck('timer'), Math.max(0, Math.min(60000, next - now)));
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
