import { randomUUID } from 'node:crypto';
import { alarmSchedulerStarted } from './events.js';
import type { AlarmLogEvent, AlarmSchedulerEvent } from './events.js';
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
  constructor(private readonly options: { store: StorePort; clock: AlarmClock; emit(event: AlarmDue): void; changed?(alarms: Alarm[]): void; log?(event: AlarmLogEvent | AlarmSchedulerEvent): void }) {}
  private record(alarm: Alarm, event: AlarmLogEvent['event'], reason: AlarmLogEvent['reason']): void {
    try { this.options.log?.({ event, reason, alarmId: alarm.id, scheduledMs: alarm.fireAtUtc, actualMs: this.options.clock.now() }); }
    catch { /* Diagnostic storage must never become the ringing reliability path. */ }
  }
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
    this.record(row, 'alarm_set', 'owner_request');
    this.recheck('mutation');
    return row;
  }
  cancel(id: string): boolean {
    const changed = this.options.store.transaction(tx => tx.run("UPDATE alarms SET state='cancelled' WHERE id=? AND state IN ('pending','ringing')", [id]));
    this.recheck('mutation');
    return changed === 1;
  }
  acknowledge(id: string): boolean {
    const alarm = this.options.store.transaction(tx => {
      const row = tx.get("SELECT * FROM alarms WHERE id=? AND state='ringing'", [id]);
      if (!row) return undefined;
      tx.run("UPDATE alarms SET state='done' WHERE id=?", [id]);
      return read(row);
    });
    if (alarm) this.record(alarm, 'alarm_acknowledged', 'owner_speech');
    this.recheck('mutation');
    return alarm !== undefined;
  }
  snooze(id: string, fireAtUtc: number, createdJournalId: string): Alarm {
    const row = this.options.store.transaction(tx => {
      const old = tx.get("SELECT * FROM alarms WHERE id=? AND (state IN ('pending','ringing') OR (state='done' AND ring_deadline_utc>?)) AND NOT EXISTS(SELECT 1 FROM alarm_snoozes WHERE alarm_id=alarms.id)", [id, this.options.clock.now()]);
      if (!old) throw Error('alarm_not_active');
      tx.run("UPDATE alarms SET state='done' WHERE id=?", [id]);
      const next = this.insert(tx, { fireAtUtc, tz: String(old.tz), label: String(old.label), createdJournalId });
      tx.run('INSERT INTO alarm_snoozes(alarm_id,next_alarm_id) VALUES(?,?)', [id, next.id]);
      return next;
    });
    this.record(row, 'alarm_set', 'owner_request');
    this.recheck('mutation');
    return row;
  }
  recheck(reason: AlarmRecheck): void {
    if (this.stopped) return;
    const { clock, store } = this.options;
    if (this.timer !== undefined) clock.clearTimeout(this.timer);
    this.timer = undefined;
    const now = clock.now();
    const { ringing, missed } = store.transaction(tx => {
      const before = tx.all("SELECT * FROM alarms WHERE state IN ('pending','ringing')").map(read);
      tx.run("UPDATE alarms SET state='missed' WHERE state='pending' AND fire_at_utc<=?", [now - 1200000]);
      tx.run("UPDATE alarms SET state='missed' WHERE state='ringing' AND ring_deadline_utc<=?", [now]);
      tx.run("UPDATE alarms SET state='ringing',ring_started_at_utc=?,ring_deadline_utc=? WHERE state='pending' AND fire_at_utc<=?", [now, now + 600000, now]);
      return {
        ringing: tx.all("SELECT * FROM alarms WHERE state='ringing' ORDER BY fire_at_utc,id").map(read) as AlarmDue[],
        missed: before.filter(row => row.state === 'pending' ? row.fireAtUtc <= now - 1200000 : row.ringDeadlineUtc! <= now),
      };
    });
    for (const alarm of missed) this.record(alarm, 'alarm_missed', alarm.state === 'pending' ? 'too_late' : 'deadline_elapsed');
    // Reconnect replays the same id and persisted deadline. The shell deduplicates occurrences.
    for (const alarm of ringing) {
      if (this.delivered.has(alarm.id) && reason !== 'reconnect') continue;
      this.record(alarm, 'alarm_due', alarm.ringStartedAtUtc === now && !this.delivered.has(alarm.id) ? 'due' : 'recovered');
      try { this.options.emit(alarm); this.delivered.add(alarm.id); }
      catch { this.record(alarm, 'alarm_degraded', 'shell_unreachable'); }
    }
    const rows = this.list();
    // #751: one start line with the pending count, so a restart that dropped the schedule is visible in the log.
    if (reason === 'start') {
      try { this.options.log?.(alarmSchedulerStarted(rows.filter(row => row.state === 'pending').length)); }
      catch { /* Diagnostic storage must never become the ringing reliability path. */ }
    }
    this.options.changed?.(rows);
    const active = rows.filter(row => row.state === 'pending' || row.state === 'ringing');
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

export type AlarmShellReason = 'shell_unreachable' | 'assertion_failed' | 'notifications_denied';
export type AlarmShellFrame = { type: 'alarm_due'; alarm: AlarmDue } | { type: 'alarm_state'; alarms: Alarm[] };
/** One local shell transport, independent of the provider session and its availability. */
export class AlarmShellBridge {
  private sender: ((frame: AlarmShellFrame) => boolean) | undefined;
  private capabilities: { assertion: boolean; notifications: boolean } | undefined;
  bind(sender: (frame: AlarmShellFrame) => boolean): () => void {
    this.sender = sender;
    this.capabilities = undefined;
    return () => {
      if (this.sender === sender) { this.sender = undefined; this.capabilities = undefined; }
    };
  }
  report(capabilities: { assertion: boolean; notifications: boolean }): void {
    if (this.sender) this.capabilities = capabilities;
  }
  health(): { degraded: boolean; reasons: AlarmShellReason[] } {
    if (!this.sender) return { degraded: true, reasons: ['shell_unreachable'] };
    const reasons: AlarmShellReason[] = [];
    if (!this.capabilities?.assertion) reasons.push('assertion_failed');
    if (!this.capabilities?.notifications) reasons.push('notifications_denied');
    return { degraded: reasons.length > 0, reasons };
  }
  private send(frame: AlarmShellFrame): void {
    try { if (this.sender?.(frame) === false) this.sender = undefined; }
    catch { this.sender = undefined; }
  }
  publish(alarm: AlarmDue): void { this.send({ type: 'alarm_due', alarm }); }
  state(alarms: Alarm[]): void { this.send({ type: 'alarm_state', alarms }); }
}

/** Reserve an occurrence before creating a session, so failures and reconnects cannot retry it. */
export class AlarmSessionCoordinator {
  constructor(private readonly options: {
    store: StorePort; hasLiveSession(): boolean;
    open(setup: import('../live/types.js').AlarmSessionSetup, idempotencyKey: string): string;
    degraded(id: string, reason: 'live_session_no_channel' | 'provider_unavailable'): void;
  }) {}
  attempt(id: string, ownerDisplayName: string): { status: 'live' | 'unavailable' | 'attempted' | 'created'; liveSessionId?: string } {
    const alarm = this.options.store.transaction(tx => {
      const row = tx.get("SELECT * FROM alarms WHERE id=? AND state='ringing'", [id]);
      if (!row || !tx.run('INSERT OR IGNORE INTO alarm_session_attempts(alarm_id) VALUES(?)', [id])) return undefined;
      return read(row);
    });
    if (!alarm) return { status: 'attempted' };
    const alreadyLive = this.options.hasLiveSession();
    try {
      const scheduledTime = new Intl.DateTimeFormat('en-GB', { timeZone: alarm.tz, hour: '2-digit', minute: '2-digit' }).format(alarm.fireAtUtc);
      const liveSessionId = this.options.open({ ownerDisplayName, scheduledTime, label: alarm.label, alarmId: id, ringDeadlineUtc: alarm.ringDeadlineUtc! }, `alarm:${id}`);
      this.options.store.transaction(tx => tx.run('UPDATE alarm_session_attempts SET live_session_id=? WHERE alarm_id=?', [liveSessionId, id]));
      return { status: alreadyLive ? 'live' : 'created', liveSessionId };
    } catch {
      this.options.degraded(id, 'provider_unavailable');
      return { status: 'unavailable' };
    }
  }
}
