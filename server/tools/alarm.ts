import { randomUUID } from 'node:crypto';
import { checkOwnerTime, type TimeSpec, type WallDay } from './time-check.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';


function localParts(instant: number, tz: string): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(parts.find(p => p.type === key)?.value));
}

/** The wall clock reading of an instant, with the words the commit result reads back. */
export interface AlarmReadBack { date: string; weekday: string; localTime: string; spoken: string }

/** A committed alarm time: the instant, the zone it was read in, and the read-back she says. */
export interface AlarmReady {
  status: 'ready'; fireAtUtc: number; tz: string; localTime: string; date: string; weekday: string;
  confirmation: string; source: 'owner' | 'model' | 'combined';
  /** Set when the model's structured time was not the one committed, so the result can say so. */
  corrected?: 'model_time_differs' | 'model_time_missing';
  series?: SeriesRule;
}
export type AlarmTime = AlarmReady
  | { status: 'clarify'; reason: 'missing_time' | 'ambiguous_time' | 'past_time' };

export function alarmReadBack(instant: number, tz: string): AlarmReadBack {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const localTime = `${get('hour')}:${get('minute')}`;
  return { date, weekday: get('weekday'), localTime, spoken: `${get('weekday')} ${Number(get('day'))} ${get('month')} at ${localTime} (${tz})` };
}

function isZone(value: string | undefined): value is string {
  if (!value) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); return true; } catch { return false; }
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * C-TIME past rule: a wall time with no stated date that already passed today is the next
 * occurrence, while a stated "today" that already passed is asked back, never silently moved.
 */
function commitWall(day: WallDay, hour: number, minute: number, now: number, zone: string, statedToday: boolean): number | 'past_time' {
  const [year, month, date] = localParts(now, zone) as [number, number, number, number, number, number];
  let y = year, m = month, d = date;
  if (day.kind === 'tomorrow') d = date + 1;
  else if (day.kind === 'next_weekday') {
    const delta = (day.weekday - weekdayOf(year, month, date) + 7) % 7;
    d = date + (delta === 0 ? 7 : delta);
  } else if (day.kind === 'iso') {
    const parts = day.value.split('-').map(Number);
    y = parts[0]!; m = parts[1]!; d = parts[2]!;
  }
  const instant = wallInstant(zone, y, m, d, hour, minute);
  if (instant > now) return instant;
  if (day.kind !== 'today' || statedToday) return 'past_time';
  const next = wallInstant(zone, year, month, date + 1, hour, minute);
  return next > now ? next : 'past_time';
}

function modelClock(time: TimeSpec | undefined): { hour: number; minute: number; localTime: string } | undefined {
  if (!time || time.mode !== 'wall') return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(time.local_time);
  if (!match) return undefined;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute, localTime: time.local_time };
}

function modelRelative(time: TimeSpec | undefined): number | undefined {
  if (!time || time.mode !== 'relative') return undefined;
  if (!Number.isFinite(time.amount) || time.amount <= 0) return undefined;
  return time.amount * (time.unit === 'hours' ? 3600000 : 60000);
}

/**
 * C-TIME: the host resolves the time. The model supplies a structured local time, the owner's own
 * words of this ask may override or complete it, and a time nobody settled is asked back once.
 * The model never does the UTC arithmetic.
 */
export function parseAlarmTime(words: string, now: number, tz: string, time?: TimeSpec): AlarmTime {
  const checked = checkOwnerTime(words);
  const zone = time?.mode === 'wall' && isZone(time.timezone) ? time.timezone : tz;
  const clock = modelClock(time);
  const relative = modelRelative(time);
  const series = parseSeriesRule(words);

  const ready = (fireAtUtc: number, source: AlarmReady['source'], corrected?: AlarmReady['corrected']): AlarmTime => {
    const readBack = alarmReadBack(fireAtUtc, zone);
    let result: AlarmReady = {
      status: 'ready', fireAtUtc, tz: zone, localTime: readBack.localTime, date: readBack.date, weekday: readBack.weekday,
      confirmation: `Alarm set for ${readBack.spoken}.`, source, ...(corrected ? { corrected } : {}),
    };
    if (series) {
      // The owner's resolved wall time is the rule's time; an ambiguous bare hour reads as the
      // morning one for a series, so today's clock never decides a recurring wall time.
      const [hour, minute] = readBack.localTime.split(':').map(Number);
      const explicit = /\b(?:am|pm|morning|evening|tonight|night|noon|midnight)\b/i.test(words) || /\d{1,2}:\d{2}/.test(words);
      const rule: SeriesRule = { ...series, hour: explicit ? hour! : hour! % 12, minute: minute!, tz: zone };
      const fireAt = seriesNextFireAt(rule, now);
      const ruleReadBack = alarmReadBack(fireAt, zone);
      result = { ...result, fireAtUtc: fireAt, localTime: ruleReadBack.localTime, date: ruleReadBack.date, weekday: ruleReadBack.weekday,
        series: rule, confirmation: `Alarm set for ${ruleReadBack.spoken}; repeats ${seriesText(rule)}.` };
    }
    return result;
  };

  // The owner stated one time: it executes, whether the model agreed, differed or said nothing.
  if (checked.status === 'unique' && checked.relative) {
    const instant = now + checked.relative.amount * (checked.relative.unit === 'hours' ? 3600000 : 60000);
    const agreed = time === undefined ? 'model_time_missing' : relative === checked.relative.amount * (checked.relative.unit === 'hours' ? 3600000 : 60000) ? undefined : 'model_time_differs';
    return ready(instant, 'owner', agreed);
  }
  if (checked.status === 'unique') {
    const localTime = checked.localTime as string;
    const [hour, minute] = localTime.split(':').map(Number);
    const statedToday = checked.day?.kind === 'today';
    const instant = commitWall(checked.day ?? { kind: 'today' }, hour!, minute!, now, zone, statedToday);
    if (instant === 'past_time') return { status: 'clarify', reason: 'past_time' };
    const agreed = time === undefined ? 'model_time_missing' : clock === undefined ? 'model_time_differs' : clock.localTime === localTime ? undefined : 'model_time_differs';
    return ready(instant, 'owner', agreed);
  }

  // The owner constrained part of it: combine, and override only the fields they constrained.
  if (checked.status === 'partial') {
    if (checked.hour !== undefined) {
      let hour = checked.hour;
      if (clock && (hour < 12 ? clock.hour % 12 === hour : clock.hour === hour)) hour = clock.hour;
      const minute = checked.minute ?? clock?.minute ?? 0;
      const day = checked.day ?? (time?.mode === 'wall' ? time.date : { kind: 'today' as const });
      const statedToday = checked.day?.kind === 'today';
      const instant = commitWall(day, hour, minute, now, zone, statedToday);
      if (instant === 'past_time') return { status: 'clarify', reason: 'past_time' };
      return ready(instant, clock ? 'combined' : 'owner', clock ? undefined : 'model_time_missing');
    }
    if (!clock) {
      if (relative !== undefined) return ready(now + relative, 'model');
      return { status: 'clarify', reason: 'ambiguous_time' };
    }
    const day = checked.day ?? (time?.mode === 'wall' ? time.date : { kind: 'today' as const });
    const instant = commitWall(day, clock.hour, clock.minute, now, zone, checked.day?.kind === 'today');
    if (instant === 'past_time') return { status: 'clarify', reason: 'past_time' };
    return ready(instant, 'combined');
  }

  // The words settled nothing: a valid model time executes and is read back.
  if (clock) {
    const instant = commitWall(time?.mode === 'wall' ? time.date : { kind: 'today' }, clock.hour, clock.minute, now, zone, false);
    if (instant === 'past_time') return { status: 'clarify', reason: 'past_time' };
    return ready(instant, 'model');
  }
  if (relative !== undefined) return ready(now + relative, 'model');
  if (time) return { status: 'clarify', reason: time.mode === 'wall' ? 'past_time' : 'missing_time' };
  return { status: 'clarify', reason: 'missing_time' };
}
export const ALARM_NAMES = ['set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm'] as const;
export type AlarmToolName = typeof ALARM_NAMES[number];
export const ALARM_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'owner-alarms' } as const;
export interface AlarmArguments { id?: string; time?: TimeSpec; label?: string; kind?: SeriesKind; weekdays?: number[] }
const WEEKDAY_LIMIT = 7;
const weekdayList = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.length <= WEEKDAY_LIMIT
  && value.every(day => Number.isInteger(day) && day >= 0 && day <= 6) && new Set(value).size === value.length;

function validWallDay(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const day = value as Record<string, unknown>;
  if (day.kind === 'today' || day.kind === 'tomorrow') return Object.keys(day).length === 1;
  if (day.kind === 'next_weekday') return Object.keys(day).length === 2 && Number.isInteger(day.weekday) && (day.weekday as number) >= 0 && (day.weekday as number) <= 6;
  return day.kind === 'iso' && Object.keys(day).length === 2 && typeof day.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.value);
}

/** C-TIME: the closed shape of the structured time the model may supply. */
export function validateTimeSpec(value: unknown): value is TimeSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  if (spec.mode === 'relative') {
    return Object.keys(spec).every(key => key === 'mode' || key === 'amount' || key === 'unit')
      && typeof spec.amount === 'number' && Number.isFinite(spec.amount) && spec.amount > 0 && spec.amount <= 10080
      && (spec.unit === 'minutes' || spec.unit === 'hours');
  }
  if (spec.mode !== 'wall') return false;
  return Object.keys(spec).every(key => key === 'mode' || key === 'date' || key === 'local_time' || key === 'timezone')
    && validWallDay(spec.date)
    && typeof spec.local_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(spec.local_time)
    && (spec.timezone === undefined || typeof spec.timezone === 'string' && spec.timezone.length > 0 && spec.timezone.length < 64 && isZone(spec.timezone));
}

export function validateAlarmArguments(args: unknown): args is AlarmArguments {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).every(key => key === 'id' || key === 'time' || key === 'label' || key === 'kind' || key === 'weekdays')
    && (value.id === undefined || typeof value.id === 'string' && value.id.length > 0 && value.id.length < 200)
    && (value.time === undefined || validateTimeSpec(value.time))
    && (value.label === undefined || typeof value.label === 'string' && value.label.length <= 200)
    && (value.kind === undefined || value.kind === 'daily' || value.kind === 'weekdays' || value.kind === 'weekly')
    && (value.weekdays === undefined || weekdayList(value.weekdays));
}

export type SeriesKind = 'daily' | 'weekdays' | 'weekly';
/** A series keeps its own timezone, so a host zone change or travel never moves it. */
export interface SeriesRule { kind: SeriesKind; weekdays: number[]; hour: number; minute: number; tz: string }
export type SeriesSpec = { kind: SeriesKind; weekdays: number[] };

const DAY_WORDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_TITLES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_PATTERN = DAY_WORDS.join('|');
const DAY_WORDS_PATTERN = new RegExp(`\\b(${DAY_PATTERN})s?\\b`, 'g');

/** Recurrence is read from the owner's words only: "every day", "on weekdays", "every Saturday and Sunday". */
export function parseSeriesRule(words: string): SeriesSpec | undefined {
  const text = words.toLowerCase();
  if (/\bweekdays?\b/.test(text)) return { kind: 'weekdays', weekdays: [1, 2, 3, 4, 5] };
  if (!/\b(?:every|each|daily)\b/.test(text)) return undefined;
  if (/\b(?:every|each)\s+day\b/.test(text) || /\bdaily\b/.test(text)) return { kind: 'daily', weekdays: [] };
  const days = [...new Set([...text.matchAll(DAY_WORDS_PATTERN)].map(match => DAY_WORDS.indexOf(match[1] as typeof DAY_WORDS[number])))]
    .filter(day => day >= 0).sort((a, b) => a - b);
  return days.length ? { kind: 'weekly', weekdays: days } : undefined;
}

function matchesSeriesDay(rule: SeriesRule, day: number): boolean {
  if (rule.kind === 'daily') return true;
  if (rule.kind === 'weekdays') return day >= 1 && day <= 5;
  return rule.weekdays.includes(day);
}

/** The local wall time in `tz`, resolved through the same inversion a one-shot alarm uses. */
function wallInstant(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const [y, m, d, h, min] = localParts(instant, tz) as [number, number, number, number, number, number];
    instant += target - Date.UTC(y, m - 1, d, h, min);
  }
  return instant;
}

/** The first wall time of the series strictly after `afterUtc`, computed in the series' own timezone. */
export function seriesNextFireAt(rule: SeriesRule, afterUtc: number): number {
  const [year, month, day] = localParts(afterUtc, rule.tz) as [number, number, number];
  for (let add = 0; add <= 7; add++) {
    const probe = new Date(Date.UTC(year, month - 1, day + add));
    if (!matchesSeriesDay(rule, probe.getUTCDay())) continue;
    const instant = wallInstant(rule.tz, probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), rule.hour, rule.minute);
    const [, , , hour, minute] = localParts(instant, rule.tz) as [number, number, number, number, number, number];
    // A wall time inside a zone's DST gap does not exist that day, so the next match carries the series.
    if (hour !== rule.hour || minute !== rule.minute || instant <= afterUtc) continue;
    return instant;
  }
  throw Error('series_no_next_occurrence');
}

/** "every Saturday at 10:00 Singapore time", the wording the owner hears back. */
export function seriesText(rule: SeriesRule): string {
  const zone = (rule.tz.split('/').at(-1) ?? rule.tz).replace(/_/g, ' ');
  const clock = `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`;
  const days = rule.kind === 'daily' ? 'every day'
    : rule.kind === 'weekdays' ? 'every weekday'
    : `every ${rule.weekdays.map(day => DAY_TITLES[day]).join(' and ')}`;
  return `${days} at ${clock} ${zone} time`;
}

/** A model-supplied rule is authority only when the owner's finalized words state it. */
export function verifyAlarmRule(args: { kind?: SeriesKind; weekdays?: number[] }, spec: SeriesSpec | undefined): boolean {
  if (args.kind === undefined && args.weekdays === undefined) return true;
  if (!spec) return false;
  if (args.kind !== undefined && args.kind !== spec.kind) return false;
  if (args.weekdays !== undefined && [...args.weekdays].sort((a, b) => a - b).join(',') !== spec.weekdays.join(',')) return false;
  return true;
}

/** "skip this Saturday" cancels one occurrence; "stop the Saturday cardio reminders" cancels the series. */
export function parseCancelScope(words: string): 'occurrence' | 'series' {
  const text = words.toLowerCase();
  if (/\b(?:skip|just this|this once|only this|not this one|next week)\b/.test(text)) return 'occurrence';
  if (/\bseries\b|\brecurring\b|\brepeating\b|\breminders?\b|\bevery (?:day|weekday|weekdays|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:stop|all) (?:the|my)\b/.test(text)) return 'series';
  return 'occurrence';
}

export interface AlarmSeries { id: string; kind: SeriesKind; weekdays: number[]; localTime: string; tz: string; label: string; state: 'active' | 'cancelled'; createdJournalId: string }
const SERIES_COLUMNS = 'id,rule_kind,weekdays,local_time,tz,label,state,created_journal_id';

function readSeries(row: SQLRow): AlarmSeries {
  const weekdays = String(row.weekdays ?? '') === '' ? [] : String(row.weekdays).split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return { id: String(row.id), kind: row.rule_kind as SeriesKind, weekdays, localTime: String(row.local_time), tz: String(row.tz),
    label: String(row.label), state: row.state as 'active' | 'cancelled', createdJournalId: String(row.created_journal_id) };
}

export function seriesRuleOf(series: AlarmSeries): SeriesRule {
  const [hour, minute] = series.localTime.split(':').map(Number) as [number, number];
  return { kind: series.kind, weekdays: series.weekdays, hour, minute, tz: series.tz };
}

export function insertAlarmSeries(tx: Transaction, input: { id: string; rule: SeriesRule; label: string; createdJournalId: string }): void {
  const clock = `${String(input.rule.hour).padStart(2, '0')}:${String(input.rule.minute).padStart(2, '0')}`;
  tx.run('INSERT INTO alarm_series(id,rule_kind,weekdays,local_time,tz,label,state,created_journal_id) VALUES(?,?,?,?,?,?,?,?)',
    [input.id, input.rule.kind, input.rule.kind === 'weekly' ? input.rule.weekdays.join(',') : '', clock, input.rule.tz, input.label, 'active', input.createdJournalId]);
}

export function linkAlarmOccurrence(tx: Transaction, alarmId: string, seriesId: string): void {
  tx.run('INSERT INTO alarm_occurrences(alarm_id,series_id) VALUES(?,?)', [alarmId, seriesId]);
}

/** A snooze successor continues the same series, so the series never loses its one pending occurrence. */
export function carryOccurrenceSeries(tx: Transaction, fromAlarmId: string, toAlarmId: string): void {
  const link = tx.get('SELECT series_id FROM alarm_occurrences WHERE alarm_id=?', [fromAlarmId]);
  if (link) linkAlarmOccurrence(tx, toAlarmId, String(link.series_id));
}

/** The series' single pending or ringing occurrence, the one "skip this Saturday" settles. */
export function pendingOccurrenceOf(tx: Transaction, seriesId: string): string | undefined {
  const row = tx.get("SELECT o.alarm_id FROM alarm_occurrences o JOIN alarms a ON a.id=o.alarm_id WHERE o.series_id=? AND a.state IN ('pending','ringing') ORDER BY a.fire_at_utc,o.alarm_id LIMIT 1", [seriesId]);
  return row ? String(row.alarm_id) : undefined;
}

export function alarmSeriesRow(tx: Transaction, id: string): AlarmSeries | undefined {
  const row = tx.get(`SELECT ${SERIES_COLUMNS} FROM alarm_series WHERE id=?`, [id]);
  return row ? readSeries(row) : undefined;
}

export function alarmSeriesOfOccurrence(tx: Transaction, alarmId: string): AlarmSeries | undefined {
  const row = tx.get(`SELECT ${SERIES_COLUMNS} FROM alarm_series WHERE id IN (SELECT series_id FROM alarm_occurrences WHERE alarm_id=?)`, [alarmId]);
  return row ? readSeries(row) : undefined;
}

/**
 * The one pending occurrence of an active series, inserted by the transaction that settled the previous one:
 * a restart, a repeated recheck or a crash can never leave zero or two pending occurrences.
 */
export function materialiseSeriesOccurrence(tx: Transaction, alarmId: string, nowUtc: number): string | undefined {
  const link = tx.get('SELECT o.series_id,a.fire_at_utc FROM alarm_occurrences o JOIN alarms a ON a.id=o.alarm_id WHERE o.alarm_id=?', [alarmId]);
  if (!link) return undefined;
  const series = alarmSeriesRow(tx, String(link.series_id));
  if (!series || series.state !== 'active') return undefined;
  if (tx.get("SELECT 1 FROM alarm_occurrences o JOIN alarms a ON a.id=o.alarm_id WHERE o.series_id=? AND a.state IN ('pending','ringing')", [series.id])) return undefined;
  const base = Math.max(Number(link.fire_at_utc), nowUtc);
  const fireAtUtc = seriesNextFireAt(seriesRuleOf(series), base);
  const id = randomUUID();
  tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,'pending',?)", [id, fireAtUtc, series.tz, series.label, series.createdJournalId]);
  linkAlarmOccurrence(tx, id, series.id);
  return id;
}

/** Stop a whole series: its pending occurrence and the series row, never a silent row delete. */
export function cancelAlarmSeries(tx: Transaction, seriesId: string): number {
  tx.run("UPDATE alarm_series SET state='cancelled' WHERE id=?", [seriesId]);
  return tx.run("UPDATE alarms SET state='cancelled' WHERE state IN ('pending','ringing') AND id IN (SELECT alarm_id FROM alarm_occurrences WHERE series_id=?)", [seriesId]);
}

export interface AlarmListEntry {
  id: string; fireAtUtc: number; tz: string; label: string; state: string;
  series?: { id: string; rule: SeriesKind; weekdays: number[]; localTime: string; text: string };
}

/** Pending and ringing occurrences, each carrying its series rule and therefore its next occurrence. */
export function listPendingAlarms(tx: Transaction): AlarmListEntry[] {
  const rows = tx.all(`SELECT a.id,a.fire_at_utc,a.tz,a.label,a.state,o.series_id FROM alarms a
    LEFT JOIN alarm_occurrences o ON o.alarm_id=a.id WHERE a.state IN ('pending','ringing') ORDER BY a.fire_at_utc,a.id`);
  return rows.map(row => {
    const entry: AlarmListEntry = { id: String(row.id), fireAtUtc: Number(row.fire_at_utc), tz: String(row.tz), label: String(row.label), state: String(row.state) };
    const series = row.series_id === null || row.series_id === undefined ? undefined : alarmSeriesRow(tx, String(row.series_id));
    if (series) entry.series = { id: series.id, rule: series.kind, weekdays: series.weekdays, localTime: series.localTime, text: seriesText(seriesRuleOf(series)) };
    return entry;
  });
}
