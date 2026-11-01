/**
 * C-TIME: the narrow checker over the owner's own words of the current ask.
 *
 * It recognizes an anchored clock ("at 6 pm", "18:00", "eighteen hundred", "half past six"),
 * a day word and a simple duration ("in ten minutes"). It never takes the first number of the
 * sentence: "one-time", "one hour call" and a clock inside the reminder subject yield no clock.
 * Two different times, or a day with no clock, are not a time the host may execute on its own,
 * so the model's structured time carries those cases.
 */

/** The wall date a time spec names. */
export type WallDay =
  | { kind: 'today' }
  | { kind: 'tomorrow' }
  | { kind: 'next_weekday'; weekday: number }
  | { kind: 'iso'; value: string };

/** Wall clock in a zone: the model's structured time, resolved by the host, never pre-converted. */
export interface WallTimeSpec { mode: 'wall'; date: WallDay; local_time: string; timezone?: string }
export interface RelativeTimeSpec { mode: 'relative'; amount: number; unit: 'minutes' | 'hours' }
export type TimeSpec = WallTimeSpec | RelativeTimeSpec;

/** A day the owner named. */
export type OwnerDay = { kind: 'today' } | { kind: 'tomorrow' } | { kind: 'next_weekday'; weekday: number };

export interface OwnerClock {
  /** A settled 24 hour wall clock reading, "HH:MM". */
  localTime?: string;
  /** The hour and minute the words fix, when the meridian is still open. */
  hour?: number;
  minute?: number;
  /** Whether the words fixed the minutes, so a model minute never overrides a spoken one. */
  minutesStated?: boolean;
  day?: OwnerDay;
  relative?: { amount: number; unit: 'minutes' | 'hours' };
}

export type OwnerTimeCheck =
  /** One time the owner stated, with every field the words fix. */
  | ({ status: 'unique' } & OwnerClock)
  /** A day or an hour without a settled clock: the model may complete the missing fields. */
  | ({ status: 'partial' } & OwnerClock)
  /** Nothing usable, or two times that disagree: the model's time is the only executable one. */
  | { status: 'inconclusive'; reason: 'no_time' | 'several_times' };

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
// Longest word first, so "eighteen" is never read as "eight" plus a suffix.
const WORD_UNITS = ['nineteen', 'eighteen', 'seventeen', 'sixteen', 'fifteen', 'fourteen', 'thirteen', 'twelve',
  'eleven', 'ten', 'nine', 'eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one', 'zero'];
const WORD_TENS = ['fifty', 'forty', 'thirty', 'twenty'];
const WORD_NUMBER = `(?:${[...WORD_TENS, ...WORD_UNITS].join('|')})(?:[ -](?:${WORD_UNITS.join('|')}))?`;
const NUMBER = `(?:\\d{1,2}|${WORD_NUMBER})`;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A clock mentioned beside a subject is a reference to it, not the time of the ask. */
const SUBJECT_NOUN = /^\s*(?:meeting|call|appointment|class|flight|train|event|show|game|block|slot|standup|sync)\b/;
/** Filler never carries a time, and a German "um ... uhr" reads as the anchor it is. */
const FILLER = /\b(?:um|uh|ah|er|erm|hm|you know|y'?know|i mean)\b/g;

function valueOf(token: string): number | undefined {
  const parts = token.trim().toLowerCase().split(/[ -]+/).filter(part => part.length > 0);
  if (!parts.length || parts.length > 2) return undefined;
  const values = parts.map(part => UNITS[part] ?? (/^\d{1,2}$/.test(part) ? Number(part) : undefined));
  if (values.some(value => value === undefined)) return undefined;
  return values.reduce((sum, value) => sum! + value!, 0);
}

interface Candidate { index: number; hour: number; minute: number; exact: boolean; stated: boolean; length: number }

function collect(text: string): Candidate[] {
  const found: Candidate[] = [];
  const push = (match: RegExpExecArray, hour: number | undefined, minute: number, exact: boolean, stated = true): void => {
    if (hour === undefined || !Number.isInteger(hour) || hour > 24 || minute > 59) return;
    if (found.some(item => item.index === match.index)) return;
    found.push({ index: match.index, hour, minute, exact, stated, length: match[0].length });
  };
  // "half past six", "quarter to seven", "ten to seven", "twenty five past six".
  for (const match of text.matchAll(new RegExp(`\\b(half|quarter|(?:${NUMBER})(?:\\s+minutes?)?)\\s+(past|to)\\s+(${NUMBER})(?:\\s*([ap])m\\b)?`, 'g')) as Iterable<RegExpExecArray>) {
    let base = valueOf(match[3]!); if (base === undefined) continue;
    if (base === 12) base = 12;
    const amount = match[1] === 'half' ? 30 : match[1] === 'quarter' ? 15 : valueOf(match[1]!.replace(/\s+minutes?$/, ''));
    if (amount === undefined) continue;
    const offset = match[2] === 'to' ? -amount : amount;
    const total = base * 60 + offset;
    if (total < 0) continue;
    const hour = Math.floor(total / 60), minute = total % 60;
    // "ten to seven" and "half past six" are settled readings, never an open meridian.
    push(match, match[4] === undefined ? hour : settle(hour, match[4]!), minute, true);
  }
  // "eighteen hundred".
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})\\s+hundred\\b`, 'g')) as Iterable<RegExpExecArray>) {
    const hour = valueOf(match[1]!);
    if (hour === undefined || hour > 24) continue;
    push(match, hour, 0, hour > 12);
  }
  // "18:00", "6.30 pm".
  for (const match of text.matchAll(/\b(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*([ap])m\b)?/g)) {
    const hour = Number(match[1]), minute = Number(match[2]);
    if (hour > 24 || minute > 59) continue;
    const settled = match[3] === undefined ? hour : settle(hour, match[3]);
    push(match, settled, minute, match[3] !== undefined || hour > 12);
  }
  // "six thirty pm": the hour and its minutes are both spoken.
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})\\s+(${NUMBER})\\s*([ap])m\\b`, 'g')) as Iterable<RegExpExecArray>) {
    const hour = valueOf(match[1]!); const minute = valueOf(match[2]!);
    if (hour === undefined || hour > 12 || minute === undefined || minute > 59) continue;
    push(match, settle(hour, match[3]!), minute, true);
  }
  // "eleven ten in the morning", "seven oh five in the morning": the hour, its minutes and the period.
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})\\s+(?:oh\\s+)?(${NUMBER})\\s+(?:in\\s+the\\s+)?(morning|afternoon|evening|night|tonight)\\b`, 'g')) as Iterable<RegExpExecArray>) {
    const hour = valueOf(match[1]!); const minute = valueOf(match[2]!);
    if (hour === undefined || hour > 12 || minute === undefined || minute > 59) continue;
    const period = match[3] === 'morning' ? 'am' : 'pm';
    push(match, settle(hour, period), minute, true);
  }
  // "11 pm 40": the minutes follow the meridian, as spoken.
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})\\s*([ap])m\\s+(\\d{1,2})\\b`, 'g')) as Iterable<RegExpExecArray>) {
    const hour = valueOf(match[1]!);
    const minute = Number(match[3]);
    if (hour === undefined || minute > 59) continue;
    push(match, settle(hour, match[2]!), minute, true);
  }
  // "6 pm", "6pm", "six p.m.".
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})\\s*([ap])m\\b`, 'g')) as Iterable<RegExpExecArray>) {
    const hour = valueOf(match[1]!);
    if (hour === undefined) continue;
    push(match, settle(hour, match[2]!), 0, true);
  }
  // "noon", "midnight".
  for (const match of text.matchAll(/\b(noon|midday|midnight)\b/g)) {
    push(match, match[1] === 'midnight' ? 0 : 12, 0, true);
  }
  // A bare number only counts behind an anchor, and never when it counts something else.
  for (const match of text.matchAll(new RegExp(`\\b(?:at|by|around|for)\\s+(${NUMBER})(?![:.\\d])(?!\\s*(?:past|to|hundred|[ap]m)\\b)(?!\\s*(?:o'?\\s?clock\\b)?[\\s-]*(?:time|times|hour|hours|minute|minutes|day|days|week|weeks|months?|years?|percent|people|of)\\b)`, 'g')) as Iterable<RegExpExecArray>) {
    const hour = valueOf(match[1]!);
    if (hour === undefined || hour > 24) continue;
    push(match, hour, 0, hour > 12);
  }
  // The longest, most settled reading of one span wins: "ten past five pm" is one clock, never a
  // clock inside a clock, and "eighteen hundred" is not "eight" plus a suffix.
  const ordered = [...found].sort((a, b) => b.length - a.length || Number(b.exact) - Number(a.exact) || a.index - b.index);
  const kept: Candidate[] = [];
  for (const item of ordered) {
    if (kept.some(other => item.index < other.index + other.length && other.index < item.index + item.length)) continue;
    kept.push(item);
  }
  return kept.sort((a, b) => a.index - b.index);
}

function settle(hour: number, meridiem: string): number {
  if (meridiem === 'p') return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

function dayOf(text: string): OwnerDay | undefined {
  if (/\btomorrow\b/.test(text)) return { kind: 'tomorrow' };
  if (/\btoday\b/.test(text) || /\btonight\b/.test(text)) return { kind: 'today' };
  const next = new RegExp(`\\bnext\\s+(${WEEKDAYS.join('|')})\\b`).exec(text);
  const bare = new RegExp(`\\b(?:on\\s+|this\\s+)?(${WEEKDAYS.join('|')})\\b`).exec(text);
  const match = next ?? bare;
  if (!match) return undefined;
  const weekday = WEEKDAYS.indexOf(match[1]!);
  return weekday < 0 ? undefined : { kind: 'next_weekday', weekday };
}

function periodOf(text: string): 'am' | 'pm' | undefined {
  if (/\b(?:morning|mornings)\b/.test(text) && !/\btomorrow\s+evening\b/.test(text)) return 'am';
  if (/\b(?:evening|tonight|night|afternoon)\b/.test(text)) return 'pm';
  return undefined;
}

/** Simple durations the host can add to its own clock: "in ten minutes", "in an hour". */
function relativeOf(text: string): { amount: number; unit: 'minutes' | 'hours' } | undefined {
  if (/\bin\s+(?:an?|one)\s+hour\b/.test(text)) return { amount: 1, unit: 'hours' };
  if (/\bin\s+half\s+an\s+hour\b/.test(text)) return { amount: 30, unit: 'minutes' };
  const match = new RegExp(`\\bin\\s+(${NUMBER})\\s+(minutes?|hours?)\\b`).exec(text);
  if (!match) return undefined;
  const amount = valueOf(match[1]!);
  if (amount === undefined || amount <= 0) return undefined;
  return { amount, unit: match[2]!.startsWith('hour') ? 'hours' : 'minutes' };
}

/** The owner's words of one ask, checked. Never a model argument, never an earlier final. */
export function checkOwnerTime(words: string): OwnerTimeCheck {
  const text = ` ${words.toLowerCase()} `
    .replace(/([ap])\.\s*m\.?/g, '$1m')
    .replace(/\b(\d)\s*:\s*(\d)\b/g, '$1:$2')
    .replace(/\bo'?\s?clock\b/g, '')
    .replace(FILLER, ' ')
    .replace(/\buhr\b/g, ' ')
    .replace(/\s+/g, ' ');

  const relative = relativeOf(text);
  const day = dayOf(text);
  const period = periodOf(text);
  const clocks = collect(text).filter(candidate => !SUBJECT_NOUN.test(text.slice(candidate.index + candidate.length)));

  // A span and a clock in one ask are not a settled time: the model's structured time carries that.
  if (relative && clocks.length) return { status: 'inconclusive', reason: 'several_times' };
  if (relative) return { status: 'unique', relative, ...(day ? { day } : {}) };

  if (!clocks.length) {
    if (day) return { status: 'partial', day };
    return { status: 'inconclusive', reason: 'no_time' };
  }

  // A period word settles an hour that had no meridian of its own.
  const settled = clocks.map(candidate => candidate.exact || period === undefined
    ? { hour: candidate.hour, minute: candidate.minute, exact: candidate.exact, stated: candidate.stated }
    : { hour: period === 'pm' ? (candidate.hour === 12 ? 12 : candidate.hour + 12) : (candidate.hour === 12 ? 0 : candidate.hour), minute: candidate.minute, exact: true, stated: candidate.stated });

  const distinct = new Set(settled.map(clock => `${clock.hour}:${clock.minute}`));
  if (distinct.size > 1) return { status: 'inconclusive', reason: 'several_times' };

  const [only] = settled;
  const clock = only!;
  const localTime = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  if (clock.exact) return { status: 'unique', localTime, ...(day ? { day } : {}) };
  // "at six" names an hour but not half of the day: the model may settle the meridian.
  return { status: 'partial', hour: clock.hour, minute: clock.minute, minutesStated: clock.stated, ...(day ? { day } : {}) };
}
