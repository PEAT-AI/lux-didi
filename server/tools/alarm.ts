type AlarmTime =
  | { status: 'ready'; fireAtUtc: number; tz: string; confirmation: string }
  | { status: 'clarify'; reason: 'ambiguous_time' | 'missing_time' }
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
  const text = words.toLowerCase();
  let fireAtUtc: number;
  let confirmation: string;
  const quantities: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const relative = /\bin\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(minutes?|hours?)\b/.exec(text);
  if (relative) {
    const amount = quantities[relative[1]!] ?? Number(relative[1]);
    if (amount <= 0 || amount > 1440) return { status: 'refused', reason: 'invalid_time' };
    fireAtUtc = now + amount * (relative[2]!.startsWith('hour') ? 3600000 : 60000);
    confirmation = `Alarm set for ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(fireAtUtc)}.`;
  } else {
    const match = /\b(?:at|for)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
    if (!match) return { status: 'clarify', reason: 'missing_time' };
    let hour = quantities[match[1]!] ?? Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const morning = /\bmorning\b|\bwake me\b/.test(text);
    const evening = /\bevening\b|\btonight\b/.test(text);
    const period = match[3] ?? (morning ? 'am' : evening ? 'pm' : undefined);
    if (!period) return { status: 'clarify', reason: 'ambiguous_time' };
    if (hour < 1 || hour > 12 || minute > 59) return { status: 'refused', reason: 'invalid_time' };
    hour = hour % 12 + (period === 'pm' ? 12 : 0);
    const [year, month, day] = localParts(now, tz) as [number, number, number];
    const tomorrow = /\btomorrow\b/.test(text);
    const wall = Date.UTC(year, month - 1, day + (tomorrow ? 1 : 0), hour, minute);
    const resolve = (target: number): number => {
      let instant = target;
      for (let i = 0; i < 3; i++) {
        const [y, m, d, h, min, sec] = localParts(instant, tz) as [number, number, number, number, number, number];
        instant += target - Date.UTC(y, m - 1, d, h, min, sec);
      }
      return instant;
    };
    fireAtUtc = resolve(wall);
    if (fireAtUtc <= now) fireAtUtc = resolve(wall + 86400000);
    const actual = localParts(fireAtUtc, tz);
    if (actual[3] !== hour || actual[4] !== minute) return { status: 'refused', reason: 'invalid_time' };
    const isTomorrow = actual[2] !== day || actual[1] !== month || actual[0] !== year;
    confirmation = `Alarm set for ${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${isTomorrow ? 'tomorrow' : 'this'} ${period === 'am' ? 'morning' : 'evening'}.`;
  }
  if (modelAt !== undefined && (!Number.isFinite(modelAt) || Math.abs(modelAt - fireAtUtc) > 60000)) {
    return { status: 'refused', reason: 'time_mismatch' };
  }
  return { status: 'ready', fireAtUtc, tz, confirmation };
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
