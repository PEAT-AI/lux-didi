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
    const match = /\b(?:at|for)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
    if (!match) return { status: 'clarify', reason: 'missing_time' };
    let hour = Number(match[1]);
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
