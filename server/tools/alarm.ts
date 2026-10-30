import { randomUUID } from 'node:crypto';
import type { SQLRow, Transaction } from '../contracts/storage.js';

type AlarmTime =
  | { status: 'ready'; fireAtUtc: number; tz: string; confirmation: string; label: string; series?: SeriesRule }
  | { status: 'clarify'; reason: 'missing_time' | 'missing_timezone' | 'unsupported_time_expression' }
  | { status: 'refused'; reason: 'time_mismatch' | 'invalid_time' };

function localParts(instant: number, tz: string): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(parts.find(p => p.type === key)?.value));
}

/** Interpret owner words, never use a model argument to choose the instant. */
function parseSingleAlarmTime(input: string, now: number, tz: string, modelAt?: number): AlarmTime {
  // A recurrence phrase describes the series, never a wall time, so it leaves the time text.
  const words = stripSeriesWords(input);
  // Labels come from owner input, not the model's arguments.
  const trailing = /\b(?:and\s+((?:give|tell|show|read)\b.*)|that\s+(.+))$/i.exec(words);
  const reminder = /\bremind me\b/i.test(words)
    ? /\bto\s+(?!(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)(.+)$/i.exec(words) : null;
  const labelMatch = trailing ?? reminder;
  const label = (trailing ? trailing[1] ?? trailing[2] : reminder?.[1])?.trim() ?? '';
  const timeWords = labelMatch ? words.slice(0, labelMatch.index) : words;
  let text = timeWords.toLowerCase().replace(/\b([ap])\s*\.\s*m\.?/g, '$1m');
  text = text.replace(/\b(?:um|uh|like|so)\b|\s-\s/g, ' ').replace(/(\d)\s*:\s*(\d)/g, '$1:$2')
    .replace(/\b([ap]m)(?:\s+\1)+\b/g, '$1').replace(/\bfor\s+(today|tomorrow|tonight)\b/g, '$1')
    .replace(/\b(\d{1,2})\s+([ap]m)\s+(\d{1,2})\b/g, '$1:$3 $2')
    .replace(/\bin\s+(?:an?|one)\s+hour\b/g, 'in one hour');
  text = text.replace(/\bwake me\s+up\b/g, 'wake me').replace(/\bremind me\b/g, ' ').replace(/\btoday\b/g, '').replace(/\bfor\s+(?!\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|twenty\b|thirty\b|forty\b|fifty\b|quarter\b|half\b|noon\b|midnight\b)[a-z]+\s+(?=(?:\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|twenty\b|thirty\b|forty\b|fifty\b|quarter\b|half\b|noon\b|midnight\b))/, 'for ');
  text = text.replace(/\b(alarm|wake me)\s+(?=(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/, '$1 at ');
  const named: Record<string, string> = { 'utc time': 'UTC', 'gmt time': 'UTC', 'singapore time': 'Asia/Singapore', sgt: 'Asia/Singapore', utc: 'UTC', gmt: 'UTC', 'new york time': 'America/New_York', 'eastern time': 'America/New_York', 'central time': 'America/Chicago', 'mountain time': 'America/Denver', 'pacific time': 'America/Los_Angeles' };
  const zonePattern = /\b(singapore time|new york time|utc time|gmt time|sgt|utc|gmt|[a-z_+-]+(?:\/[a-z_+-]+)+|[a-z]+ time)\b/g;
  const zones = [...text.matchAll(zonePattern)];
  const zone = zones.at(-1)?.[0];
  const suffix = /\b([A-Z]{2,8})[.!?]?\s*$/.exec(words)?.[1];
  if (zone) { tz = named[zone] ?? zone; text = text.replace(zonePattern, ' '); }
  else if (suffix && !['AM', 'PM'].includes(suffix)) { tz = suffix; text = text.replace(new RegExp(`\\b${suffix.toLowerCase()}[.!?]?\\s*$`), ''); }
  try { tz = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone; }
  catch { return { status: 'clarify', reason: 'missing_timezone' }; }
  const values: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
  const number = (value: string): number => {
    if (/^\d+$/.test(value)) return Number(value);
    const parts = value.trim().split(/[ -]+/);
    if (parts.some(part => values[part] === undefined) || parts.length > 2) return NaN;
    if (parts.length === 2 && !(parts[0] === 'oh' || (values[parts[0]!]! >= 20 && values[parts[1]!]! < 10))) return NaN;
    return parts.reduce((sum, part) => sum + values[part]!, 0);
  };
  text = text.replace(/\b([ap]m)(?:\s+\1)+\b/g, '$1');
  // Find time expressions independently of the owner's action wording.
  const temporal = new RegExp(`\\b(?:in\\s+)?(?:\\d{1,2}|${Object.keys(values).join('|')}|half|quarter|noon|midnight)\\b`);
  const first = temporal.exec(text);
  if (first) {
    const before = text.slice(0, first.index);
    const context = before.match(/\b(?:tomorrow|morning|evening)\b/g)?.join(' ') ?? '';
    text = `${context} ${text.slice(first.index)}`.trim();
    // Relative speech often finishes with the request rather than starting with it.
    text = text.replace(/(minutes?|hours?)\s+(?:from now\s*)?(?:can you|could you|please)\b[^0-9]*$/, '$1')
      .replace(/(minutes?|hours?)\s+from now\s*$/, '$1');
    if (!/^in\b/.test(text)) text = `at ${text}`;
  }
  if ([...text.matchAll(/\b(?:am|pm)\b/g)].length > 1) return { status: 'clarify', reason: 'unsupported_time_expression' };
  // Strip only the first action prefix: a later alarm clause must not erase an earlier time.
  let fireAtUtc: number;
  const relative = new RegExp(`\\bin\\s+((?:\\d+|${Object.keys(values).join('|')})(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?)\\s+(minutes?|hours?)\\b`).exec(text);
  if (relative) {
    const prefix = text.slice(0, relative.index).replace(/^\s*snooze\b/, '').replace(/\bplease\b|[,;:]/g, '').trim();
    if (prefix) return { status: 'clarify', reason: 'unsupported_time_expression' };
    const amount = number(relative[1]!);
    if (!Number.isFinite(amount)) return { status: 'clarify', reason: 'unsupported_time_expression' };
    if (amount <= 0 || amount > 1440) return { status: 'refused', reason: 'invalid_time' };
    const rest = text.slice(relative.index + relative[0].length).replace(/\bplease\b/g, '').trim();
    if (rest) return { status: 'clarify', reason: 'unsupported_time_expression' };
    fireAtUtc = now + amount * (relative[2]!.startsWith('hour') ? 3600000 : 60000);
  } else {
    // Select the first temporal introducer and consume its entire remainder, never prefer a later "at".
    const start = /\b(?:at|for)\s+|\b(?:noon|midnight)\b/.exec(text);
    if (!start) {
      if (modelAt !== undefined && Number.isFinite(modelAt) && modelAt > now) {
        const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(modelAt);
        return { status: 'ready', fireAtUtc: modelAt, tz, label, confirmation: `Alarm set for ${dateTime} (${tz}).` };
      }
      return { status: 'clarify', reason: 'missing_time' };
    }
    const prefix = text.slice(0, start.index).replace(/^\s*snooze\b/, '')
      .replace(/\b(?:tomorrow|morning|evening|tonight|am|pm|in|the|for|please)\b|[,;:]/g, '').trim();
    if (prefix) return { status: 'clarify', reason: 'unsupported_time_expression' };
    let expression = text.slice(start.index + (/^(?:noon|midnight)$/.test(start[0]) ? 0 : start[0].length)).trim();
    expression = expression.replace(/^(?:(?:tomorrow|morning|evening|tonight|in the morning|in the evening)\s+)+at\s+/, '');
    const tomorrow = /\btomorrow\b/.test(text);
    const period = /\bam\b|\bmorning\b/.test(text) || /\bwake me\b/.test(words) && !/\bpm\b|\bevening\b/.test(text) ? 'am'
      : /\bpm\b|\bevening\b|\btonight\b/.test(text) ? 'pm' : undefined;
    expression = expression.replace(/\b(?:in the morning|in the evening|tomorrow|morning|evening|tonight|am|pm|please)\b/g, '').replace(/[.!?,]+$/, '').trim();
    const namedTime = expression === 'noon' || expression === 'midnight';
    let hour: number;
    let minute = 0;
    let offset = 0;
    // A colon time above 12 already names its own meridian: "22:30" is a wall time, never an ambiguous hour.
    let exact = false;
    if (namedTime) {
      hour = expression === 'noon' ? 12 : 0;
    } else {
      const past = /^(quarter|half|[\w -]+?)\s+(past|to)\s+([\w -]+)$/.exec(expression);
      const digits = /^(\d{1,2}):(\d{2})$/.exec(expression);
      if (past) {
        hour = number(past[3]!);
        offset = past[1] === 'quarter' ? 15 : past[1] === 'half' ? 30 : number(past[1]!);
        if (past[2] === 'to') offset = -offset;
        if (!Number.isFinite(offset) || Math.abs(offset) > 59) return { status: 'clarify', reason: 'unsupported_time_expression' };
      } else if (digits) {
        hour = Number(digits[1]); minute = Number(digits[2]);
        exact = hour > 12;
      } else {
        const tokens = expression.split(/\s+/);
        hour = number(tokens.shift() ?? '');
        if (tokens.length) minute = number(tokens.join(' '));
      }
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return { status: 'clarify', reason: 'unsupported_time_expression' };
      if (exact ? hour > 23 || minute > 59 : hour < 1 || hour > 12 || minute < 0 || minute > 59) return { status: 'refused', reason: 'invalid_time' };
      if (!exact && period) hour = hour % 12 + (period === 'pm' ? 12 : 0);
    }
    const [year, month, day] = localParts(now, tz) as [number, number, number];
    const resolve = (target: number): number => {
      let instant = target;
      for (let i = 0; i < 3; i++) {
        const [y, m, d, h, min, sec] = localParts(instant, tz) as [number, number, number, number, number, number];
        instant += target - Date.UTC(y, m - 1, d, h, min, sec);
      }
      return instant;
    };
    const candidates = !exact && !period && !namedTime ? [hour % 12, hour % 12 + 12] : [hour];
    const instants = candidates.flatMap(h => [0, 1].map(extra => resolve(Date.UTC(year, month - 1, day + (tomorrow ? 1 : 0) + extra, h, minute + offset))))
      .filter(instant => instant > now).sort((a, b) => a - b);
    fireAtUtc = instants[0]!;
    const actual = localParts(fireAtUtc, tz);
    const expectedMinute = ((minute + offset) % 60 + 60) % 60;
    if (actual[4] !== expectedMinute) return { status: 'refused', reason: 'invalid_time' };
  }
  const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(fireAtUtc);
  return { status: 'ready', fireAtUtc, tz, label, confirmation: `Alarm set for ${dateTime} (${tz}).` };
}

/** Repeated speech finals may restate the same time; every stated time must agree. */
function parsePlainAlarmTime(words: string, now: number, tz: string, modelAt?: number): AlarmTime {
  const direct = parseSingleAlarmTime(words, now, tz, modelAt);
  if (direct.status !== 'clarify' || direct.reason !== 'unsupported_time_expression') return direct;
  const text = words.toLowerCase().replace(/\b([ap])\s*\.\s*m\.?/g, '$1m')
    .replace(/(\d)\s*:\s*(\d)/g, '$1:$2').replace(/\b(\d{1,2})\s+([ap]m)\s+(\d{1,2})\b/g, '$1:$3 $2')
    .replace(/\b(?:um|uh|like|so)\b|\s-\s/g, ' ').replace(/\bin\s+an?\s+hour\b/g, 'in one hour');
  const periods = [...new Set(text.match(/\b[ap]m\b/g) ?? [])];
  if (periods.length > 1) return direct;
  const unit = '(?:one|two|three|four|five|six|seven|eight|nine)';
  const num = `(?:\\d{1,2}|(?:twenty|thirty|forty|fifty)(?:[ -]${unit})?|${unit}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)`;
  const period = '(?:\\s+[ap]m)?';
  const clock = `(?:\\d{1,2}:\\d{2}|${num}(?:[ -]+${num})?)${period}`;
  const pattern = new RegExp(`\\bin\\s+${num}\\s+(?:minutes?|hours?)\\b|\\b(?:quarter|half|${num})(?:\\s+minutes?)?\\s+(?:past|to)\\s+${num}${period}\\b|\\b\\d{1,2}:\\d{2}${period}\\b|\\b${num}(?:[ -]+${num})?\\s+[ap]m\\b|\\b(?:at|on|for)\\s+${clock}\\b|\\b(?:noon|midnight)\\b`, 'g');
  const matches = [...text.matchAll(pattern)];
  const expressions = matches.map(match => match[0]);
  const remainder = text.replace(pattern, ' ');
  if (/\b(?:minutes?|hours?)\b/.test(remainder)) return direct;
  const leftoverNumbers = remainder.match(new RegExp(`\\b${num}\\b`, 'g')) ?? [];
  if (leftoverNumbers.some(value => !expressions.some(expression => expression.replace(/^(?:at|on|for)\s+/, '').startsWith(value + ' ')))) return direct;
  if (!expressions.length) return direct;
  const zone = [...text.matchAll(/\b(?:[a-z_+-]+\/[a-z_+-]+|[a-z]+ time|sgt|utc|gmt)\b/g)].at(-1)?.[0] ?? '';
  const day = /\btomorrow\b/.test(text) ? 'tomorrow' : /\btonight\b/.test(text) ? 'tonight' : '';
  let agreed: Extract<AlarmTime, { status: 'ready' }> | undefined;
  for (let expression of expressions) {
    expression = expression.replace(/\s+minutes?\s+(past|to)\s+/, ' $1 ');
    const relative = /^in\b/.test(expression);
    const suffix = relative ? '' : `${!/\b[ap]m\b/.test(expression) ? periods[0] ?? '' : ''} ${day}`;
    const parsed = parseSingleAlarmTime(`${relative ? '' : 'at '}${expression.replace(/^(?:at|on|for)\s+/, '')} ${suffix} ${zone}`.trim(), now, tz, modelAt);
    if (parsed.status !== 'ready') return parsed;
    if (agreed && Math.floor(agreed.fireAtUtc / 60000) !== Math.floor(parsed.fireAtUtc / 60000)) return { status: 'clarify', reason: 'unsupported_time_expression' };
    agreed = parsed;
  }
  return agreed ?? direct;
}

/** A recurrence phrase turns a one-shot alarm into a series whose next occurrence is materialised. */
export function parseAlarmTime(words: string, now: number, tz: string, modelAt?: number): AlarmTime {
  const parsed = parsePlainAlarmTime(words, now, tz, modelAt);
  const spec = parseSeriesRule(words);
  if (!spec || parsed.status !== 'ready') return parsed;
  // The owner's resolved wall time is the rule's time. An ambiguous bare hour reads as the morning
  // one for a series ("every Saturday at ten" is Saturday 10:00), while an evening or pm word, or a
  // colon time, names its own meridian, so today's clock never decides a recurring wall time.
  const [, , , resolvedHour, minute] = localParts(parsed.fireAtUtc, tz) as [number, number, number, number, number, number];
  const explicit = /\b(?:am|pm|morning|evening|tonight|night|noon|midnight)\b/i.test(words) || /\d{1,2}:\d{2}/.test(words);
  const rule: SeriesRule = { ...spec, hour: explicit ? resolvedHour : resolvedHour % 12, minute, tz };
  const fireAtUtc = seriesNextFireAt(rule, now);
  const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(fireAtUtc);
  return { ...parsed, fireAtUtc, series: rule, confirmation: `Alarm set for ${dateTime} (${tz}); repeats ${seriesText(rule)}.` };
}

export const ALARM_NAMES = ['set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm'] as const;
export type AlarmToolName = typeof ALARM_NAMES[number];
export const ALARM_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'owner-alarms' } as const;
export interface AlarmArguments { id?: string; fire_at_utc?: number; kind?: SeriesKind; weekdays?: number[] }
const WEEKDAY_LIMIT = 7;
export function validateAlarmArguments(args: unknown): args is AlarmArguments {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  const weekdays = value.weekdays;
  return Object.keys(value).every(key => key === 'id' || key === 'fire_at_utc' || key === 'kind' || key === 'weekdays')
    && (value.id === undefined || typeof value.id === 'string' && value.id.length > 0 && value.id.length < 200)
    && (value.fire_at_utc === undefined || typeof value.fire_at_utc === 'number' && Number.isFinite(value.fire_at_utc))
    && (value.kind === undefined || value.kind === 'daily' || value.kind === 'weekdays' || value.kind === 'weekly')
    && (weekdays === undefined || Array.isArray(weekdays) && weekdays.length <= WEEKDAY_LIMIT
      && weekdays.every(day => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)
      && new Set(weekdays).size === weekdays.length);
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

/** A recurrence phrase names the series, never a wall time, so it leaves the time text. */
function stripSeriesWords(text: string): string {
  if (!/\b(?:every|each|daily|weekdays?)\b/i.test(text)) return text;
  return text
    .replace(new RegExp(`\\b(?:every|each)\\s+(?:single\\s+)?(?:day|weekdays?|${DAY_PATTERN})s?(?:\\s*(?:,|and|&)\\s*(?:day|weekdays?|${DAY_PATTERN})s?)*`, 'gi'), ' ')
    .replace(/\bon\s+weekdays?\b/gi, ' ')
    .replace(/\bweekdays?\b/gi, ' ')
    .replace(/\bdaily\b/gi, ' ')
    .replace(/\s+/g, ' ');
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
