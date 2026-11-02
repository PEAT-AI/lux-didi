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
  const formatter = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...options }).formatToParts(instant);
  const long = formatter({ year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const iso = formatter({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const get = (parts: Intl.DateTimeFormatPart[], type: string): string => parts.find(part => part.type === type)?.value ?? '';
  const date = `${get(iso, 'year')}-${get(iso, 'month')}-${get(iso, 'day')}`;
  const localTime = `${get(long, 'hour')}:${get(long, 'minute')}`;
  return { date, weekday: get(long, 'weekday'), localTime,
    spoken: `${get(long, 'weekday')} ${Number(get(long, 'day'))} ${get(long, 'month')} at ${localTime} (${tz})` };
}

/**
 * C-DIAG109: the clock she is handed with a committed alarm is read from the clock the tool runs on, never
 * from the stamp of the ask, so a research or provider delay shows in the figures instead of being hidden.
 * The distance to the instant is the host's arithmetic, so the model never counts and never recites a line.
 */
export function alarmDistance(fireAtUtc: number, tz: string, now: number): { nowLocalTime: string; minutesAway: number } {
  return { nowLocalTime: alarmReadBack(now, tz).localTime, minutesAway: Math.max(0, Math.round((fireAtUtc - now) / 60_000)) };
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
      // "at six" fixes the hour but not half of the day: a model time settles the meridian, and
      // "wake me" permits the morning default the owner's words carry. A bare set asks.
      if (!clock && !/\bwake (?:me|up)\b/i.test(words)) return { status: 'clarify', reason: 'ambiguous_time' };
      let hour = checked.hour;
      if (clock && (hour < 12 ? clock.hour % 12 === hour : clock.hour === hour)) hour = clock.hour;
      else if (!clock) hour = hour === 12 ? 0 : hour;
      const minute = checked.minutesStated === true ? checked.minute ?? 0 : clock?.minute ?? 0;
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

/** C-ALARM: the weekday names the declaration offers, Sunday first so the index is the weekday number. */
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** The flat day the model declares, read as the internal wall day: a word he said or an ISO date. */
function wallDayOf(value: string): WallDay | undefined {
  const word = value.trim().toLowerCase();
  if (word === 'today') return { kind: 'today' };
  if (word === 'tomorrow') return { kind: 'tomorrow' };
  const weekday = WEEKDAY_NAMES.indexOf(word as typeof WEEKDAY_NAMES[number]);
  if (weekday >= 0) return { kind: 'next_weekday', weekday };
  return /^\d{4}-\d{2}-\d{2}$/.test(word) ? { kind: 'iso', value: word } : undefined;
}

/** Every field the time argument declares, and the ones a voice model fills when it has nothing. */
const TIME_FIELDS = ['mode', 'date', 'local_time', 'timezone', 'amount', 'unit'] as const;
const WALL_FIELDS: readonly string[] = ['date', 'local_time', 'timezone'];
const RELATIVE_FIELDS: readonly string[] = ['amount', 'unit'];

/** A null, an empty string or an empty list is a field the model did not fill, never a value. */
const absentValue = (value: unknown): boolean => value === undefined || value === null || value === ''
  || (Array.isArray(value) && value.length === 0);

/** C-ALARM: what the boundary made of the model's time: read as a spec, absent, or the rule it breaks. */
export type TimeRead = { state: 'absent' } | { state: 'read'; spec: TimeSpec } | { state: 'refused'; violation: string };

/**
 * C-ALARM: the model's flat time read as the internal spec. A field it filled with null or an empty
 * string, and a field the chosen mode does not read, count as absent; the mode is inferred when the
 * fields make it clear. An unknown key, an unreadable day or a clock that is not HH:MM refuses, and
 * the violation names the rule, never a value.
 */
export function readTimeSpec(value: unknown): TimeRead {
  if (absentValue(value)) return { state: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) return { state: 'refused', violation: 'time:not_object' };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !(TIME_FIELDS as readonly string[]).includes(key))) return { state: 'refused', violation: 'time:unknown_key' };
  const fields: Record<string, unknown> = {};
  for (const key of TIME_FIELDS) if (!absentValue(raw[key])) fields[key] = raw[key];
  if (Object.keys(fields).length === 0) return { state: 'absent' };
  const stated = fields['mode'];
  if (stated !== undefined && stated !== 'wall' && stated !== 'relative') return { state: 'refused', violation: 'time:mode_unknown' };
  const wall = WALL_FIELDS.some(key => key in fields);
  const relative = RELATIVE_FIELDS.some(key => key in fields);
  const mode = stated ?? (wall && !relative ? 'wall' : relative && !wall ? 'relative' : undefined);
  if (mode === undefined) return { state: 'refused', violation: 'time:mode_ambiguous' };
  if (mode === 'relative') {
    const amount = fields['amount'];
    const unit = fields['unit'];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10080) return { state: 'refused', violation: 'time:amount_range' };
    if (unit !== 'minutes' && unit !== 'hours') return { state: 'refused', violation: 'time:unit_value' };
    return { state: 'read', spec: { mode: 'relative', amount, unit } };
  }
  const dayWord = fields['date'];
  const day = dayWord === undefined ? { kind: 'today' as const } : typeof dayWord === 'string' ? wallDayOf(dayWord) : undefined;
  if (day === undefined) return { state: 'refused', violation: 'time:date_unreadable' };
  const localTime = fields['local_time'];
  if (typeof localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) return { state: 'refused', violation: 'time:clock_format' };
  const zone = fields['timezone'];
  if (zone !== undefined && (typeof zone !== 'string' || !isZone(zone))) return { state: 'refused', violation: 'time:timezone_value' };
  return { state: 'read', spec: { mode: 'wall', date: day, local_time: localTime, ...(zone !== undefined ? { timezone: zone } : {}) } };
}

/** C-ALARM: one retry sentence stating what each field of the time argument accepts. */
export const ALARM_ARGUMENT_GUIDANCE = 'Send time as an object: date accepts today, tomorrow, a weekday name or YYYY-MM-DD; local_time is HH:MM on a 24 hour clock; amount is a positive number with unit minutes or hours; timezone is an IANA zone name; kind is daily, weekdays or weekly. Omit every field the mode does not use, and omit mode itself when the fields make it clear.';

const ALARM_KEYS: readonly string[] = ['id', 'time', 'label', 'kind', 'weekdays'];
const ALARM_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const argumentPath = (key: string): string => ALARM_KEY_PATTERN.test(key) ? key : 'arguments';

/** C-ALARM: the first argument the host cannot read, as the closed `key:rule` token the log accepts. */
export function alarmRejection(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments:not_object';
  const value = args as Record<string, unknown>;
  const undeclared = Object.keys(value).find(key => !ALARM_KEYS.includes(key));
  if (undeclared !== undefined) return `${argumentPath(undeclared)}:undeclared`;
  const time = readTimeSpec(value['time']);
  if (time.state === 'refused') return time.violation;
  const id = value['id'];
  if (!absentValue(id) && (typeof id !== 'string' || id.length >= 200)) return 'id:format';
  const label = value['label'];
  if (!absentValue(label) && (typeof label !== 'string' || label.length > 200)) return 'label:long';
  const kind = value['kind'];
  if (!absentValue(kind) && kind !== 'daily' && kind !== 'weekdays' && kind !== 'weekly') return 'kind:type';
  const weekdays = value['weekdays'];
  if (!absentValue(weekdays) && !weekdayList(weekdays)) return 'weekdays:format';
  return undefined;
}

/** C-ALARM: the model's alarm arguments read as the internal shapes, or undefined when refused. */
export function alarmArguments(args: unknown): AlarmArguments | undefined {
  if (alarmRejection(args) !== undefined) return undefined;
  const value = args as Record<string, unknown>;
  const time = readTimeSpec(value['time']);
  const id = value['id'], label = value['label'], kind = value['kind'], weekdays = value['weekdays'];
  return {
    ...(absentValue(id) ? {} : { id: id as string }),
    ...(time.state === 'read' ? { time: time.spec } : {}),
    ...(absentValue(label) ? {} : { label: label as string }),
    ...(absentValue(kind) ? {} : { kind: kind as SeriesKind }),
    ...(absentValue(weekdays) ? {} : { weekdays: weekdays as number[] }),
  };
}

export function validateAlarmArguments(args: unknown): args is AlarmArguments {
  return alarmArguments(args) !== undefined;
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
