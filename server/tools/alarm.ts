type AlarmTime =
  | { status: 'ready'; fireAtUtc: number; tz: string; confirmation: string; label: string }
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
export function parseAlarmTime(words: string, now: number, tz: string, modelAt?: number): AlarmTime {
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
  text = text.replace(/\bwake me\s+up\b/g, 'wake me').replace(/\btoday\b/g, '').replace(/\bfor\s+(?!\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|twenty\b|thirty\b|forty\b|fifty\b|quarter\b|half\b|noon\b|midnight\b)[a-z]+\s+(?=(?:\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|twenty\b|thirty\b|forty\b|fifty\b|quarter\b|half\b|noon\b|midnight\b))/, 'for ');
  text = text.replace(/\b(alarm|wake me)\s+(?=(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/, '$1 at ');
  const named: Record<string, string> = { 'singapore time': 'Asia/Singapore', sgt: 'Asia/Singapore', utc: 'UTC', gmt: 'UTC', 'new york time': 'America/New_York', 'eastern time': 'America/New_York', 'central time': 'America/Chicago', 'mountain time': 'America/Denver', 'pacific time': 'America/Los_Angeles' };
  const zonePattern = /\b(singapore time|new york time|sgt|utc|gmt|[a-z_+-]+(?:\/[a-z_+-]+)+|[a-z]+ time)\b/g;
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
    const prefix = text.slice(0, relative.index).replace(/^.*?\b(?:alarm|wake me|remind me)\b/, '').replace(/^\s*snooze\b/, '').replace(/\bplease\b|[,;:]/g, '').trim();
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
    if (!start) return { status: 'clarify', reason: 'missing_time' };
    const prefix = text.slice(0, start.index).replace(/^.*?\b(?:alarm|wake me|remind me)\b/, '').replace(/^\s*snooze\b/, '')
      .replace(/\b(?:tomorrow|morning|evening|tonight|am|pm|in|the|for|please)\b|[,;:]/g, '').trim();
    if (prefix) return { status: 'clarify', reason: 'unsupported_time_expression' };
    let expression = text.slice(start.index + (/^(?:noon|midnight)$/.test(start[0]) ? 0 : start[0].length)).trim();
    expression = expression.replace(/^(?:(?:tomorrow|morning|evening|tonight|in the morning|in the evening)\s+)+at\s+/, '');
    const tomorrow = /\btomorrow\b/.test(text);
    const period = /\bam\b|\bmorning\b/.test(text) || /\bwake me\b/.test(text) && !/\bpm\b|\bevening\b/.test(text) ? 'am'
      : /\bpm\b|\bevening\b|\btonight\b/.test(text) ? 'pm' : undefined;
    expression = expression.replace(/\b(?:in the morning|in the evening|tomorrow|morning|evening|tonight|am|pm|please)\b/g, '').replace(/[.!?,]+$/, '').trim();
    const namedTime = expression === 'noon' || expression === 'midnight';
    let hour: number;
    let minute = 0;
    let offset = 0;
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
      } else {
        const tokens = expression.split(/\s+/);
        hour = number(tokens.shift() ?? '');
        if (tokens.length) minute = number(tokens.join(' '));
      }
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return { status: 'clarify', reason: 'unsupported_time_expression' };
      if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return { status: 'refused', reason: 'invalid_time' };
      if (period) hour = hour % 12 + (period === 'pm' ? 12 : 0);
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
    const candidates = !period && !namedTime ? [hour % 12, hour % 12 + 12] : [hour];
    const instants = candidates.flatMap(h => [0, 1].map(extra => resolve(Date.UTC(year, month - 1, day + (tomorrow ? 1 : 0) + extra, h, minute + offset))))
      .filter(instant => instant > now).sort((a, b) => a - b);
    fireAtUtc = instants[0]!;
    const actual = localParts(fireAtUtc, tz);
    const expectedMinute = ((minute + offset) % 60 + 60) % 60;
    if (actual[4] !== expectedMinute) return { status: 'refused', reason: 'invalid_time' };
  }
  if (modelAt !== undefined && (!Number.isFinite(modelAt) || Math.abs(modelAt - fireAtUtc) > 60000)) {
    return { status: 'refused', reason: 'time_mismatch' };
  }
  const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(fireAtUtc);
  return { status: 'ready', fireAtUtc, tz, label, confirmation: `Alarm set for ${dateTime} (${tz}).` };
}

export const ALARM_NAMES = ['set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm'] as const;
export type AlarmToolName = typeof ALARM_NAMES[number];
export const ALARM_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'owner-alarms' } as const;
export interface AlarmArguments { id?: string; fire_at_utc?: number }
export function validateAlarmArguments(args: unknown): args is AlarmArguments {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).every(key => key === 'id' || key === 'fire_at_utc')
    && (value.id === undefined || typeof value.id === 'string' && value.id.length > 0 && value.id.length < 200)
    && (value.fire_at_utc === undefined || typeof value.fire_at_utc === 'number' && Number.isFinite(value.fire_at_utc));
}
