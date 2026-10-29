type AlarmTime =
  | { status: 'ready'; fireAtUtc: number; tz: string; confirmation: string }
  | { status: 'clarify'; reason: 'ambiguous_time' | 'missing_time' | 'missing_timezone' | 'unsupported_time_expression' }
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
  let text = words.toLowerCase().replace(/\b([ap])\s*\.\s*m\.?/g, '$1m');
  const zone = /\b(singapore time|sgt|utc|gmt|[a-z_+-]+(?:\/[a-z_+-]+)+|[a-z]+ time)\b/i.exec(text);
  if (zone) {
    const named: Record<string, string> = { 'singapore time': 'Asia/Singapore', sgt: 'Asia/Singapore', utc: 'UTC', gmt: 'UTC' };
    tz = named[zone[0]] ?? zone[0];
    text = text.slice(0, zone.index) + text.slice(zone.index + zone[0].length);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: tz }).format(now); }
  catch { return { status: 'clarify', reason: 'missing_timezone' }; }
  const values: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
  const number = (value: string): number => {
    if (/^\d+$/.test(value)) return Number(value);
    const parts = value.trim().split(/[ -]+/);
    if (parts.some(part => values[part] === undefined) || parts.length > 2) return NaN;
    if (parts.length === 2 && !(parts[0] === 'oh' || (values[parts[0]!]! >= 20 && values[parts[1]!]! < 10))) return NaN;
    return parts.reduce((sum, part) => sum + values[part]!, 0);
  };
  let fireAtUtc: number;
  const relative = /\bin\s+([\w -]+?)\s+(minutes?|hours?)\b/.exec(text);
  if (relative) {
    const amount = number(relative[1]!);
    if (!Number.isFinite(amount)) return { status: 'clarify', reason: 'unsupported_time_expression' };
    if (amount <= 0 || amount > 1440) return { status: 'refused', reason: 'invalid_time' };
    const rest = text.slice(relative.index + relative[0].length).replace(/\bplease\b/g, '').trim();
    if (rest) return { status: 'clarify', reason: 'unsupported_time_expression' };
    fireAtUtc = now + amount * (relative[2]!.startsWith('hour') ? 3600000 : 60000);
  } else {
    const start = /\b(?:at|for)\s+/.exec(text);
    const noon = /\b(noon|midnight)\b/.exec(text);
    if (!start && !noon) return { status: 'clarify', reason: 'missing_time' };
    let expression = text.slice(start ? start.index + start[0].length : noon!.index).trim();
    const tomorrow = /\btomorrow\b/.test(expression);
    const period = /\bam\b|\bmorning\b/.test(expression) || /\bwake me\b/.test(text) ? 'am'
      : /\bpm\b|\bevening\b|\btonight\b/.test(expression) ? 'pm' : undefined;
    expression = expression.replace(/\b(?:in the morning|in the evening|tomorrow|morning|evening|tonight|am|pm|please)\b/g, '').replace(/[.!?,]+$/, '').trim();
    let hour: number;
    let minute = 0;
    let offset = 0;
    if (expression === 'noon' || expression === 'midnight') {
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
    const candidates = !period && !noon ? [hour % 12, hour % 12 + 12] : [hour];
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
  return { status: 'ready', fireAtUtc, tz, confirmation: `Alarm set for ${dateTime} (${tz}).` };
}

export const ALARM_NAMES = ['set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm'] as const;
export type AlarmToolName = typeof ALARM_NAMES[number];
export const ALARM_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'owner-alarms' } as const;
interface OwnerAsk { journalId: string; words: string; at: number }
/** Only the finalized microphone transcription branch may feed this authority window. */
export class AlarmOwnerGate {
  private turns = new Map<string, OwnerAsk[]>();
  observeOwnerFinal(session: string, journalId: string, words: string, at: number): void {
    const old = (this.turns.get(session) ?? []).filter(turn => at - turn.at <= 120000);
    this.turns.set(session, [...old, { journalId, words: words.slice(0, 2000), at }].slice(-2));
  }
  authorize(session: string, operation: AlarmToolName, now: number): OwnerAsk | undefined {
    const turns = this.turns.get(session) ?? [];
    const last = turns.at(-1);
    if (!last || now < last.at || now - last.at > 120000) return;
    const words = turns.map(turn => turn.words).join(' ');
    const pattern = operation === 'set_alarm' ? /\bwake me\b|\b(?:set|make|create)\b.*\balarm\b/i
      : operation === 'cancel_alarm' ? /\b(?:cancel|delete|remove|stop)\b.*\balarm\b/i
      : operation === 'snooze_alarm' ? /\bsnooze\b/i : /./;
    if (!pattern.test(last.words)) {
      const continuation = operation === 'cancel_alarm' ? /^(?:my|the|that|this)?\s*alarm\b/i
        : /^(?:at|for|in|tomorrow|this|next|tonight|morning|evening|\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
      if (!continuation.test(last.words.trim())) return;
    }
    return pattern.test(words) ? { ...last, words } : undefined;
  }
  consume(session: string, journalId: string): void {
    if (this.turns.get(session)?.at(-1)?.journalId === journalId) this.turns.delete(session);
  }
  clear(session: string): void { this.turns.delete(session); }
}

export interface AlarmArguments { id?: string; fire_at_utc?: number }
export function validateAlarmArguments(args: unknown): args is AlarmArguments {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).every(key => key === 'id' || key === 'fire_at_utc')
    && (value.id === undefined || typeof value.id === 'string' && value.id.length > 0 && value.id.length < 200)
    && (value.fire_at_utc === undefined || typeof value.fire_at_utc === 'number' && Number.isFinite(value.fire_at_utc));
}
