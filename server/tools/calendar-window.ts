const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const unresolved = (): never => { throw Error('unresolved_calendar_window'); };

/**
 * Resolve each boundary in the declared zone; the two offsets may differ.
 *
 * C-CAL8: today is the owner's day from now on, not from local midnight, so a schedule ask at 13:43 reads
 * the meetings still ahead instead of calling three of them already past. The local midnight stays the
 * right boundary for every other window, and the tomorrow, week and date forms are untouched.
 */
export function calendarRange(window: string, nowMs: number, timeZone: string, fromNow = false): { timeMin: string; timeMax: string } {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { return unresolved(); }
  const parts = (ms: number): number[] => {
    const map = Object.fromEntries(format.formatToParts(ms).map(part => [part.type, part.value]));
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(map[key]));
  };
  const [year, month, day] = parts(nowMs);
  let date = Date.UTC(year!, month! - 1, day!);
  const value = window.trim().toLowerCase();
  let days = 1;
  const weekday = new Date(date).getUTCDay();
  if (value === 'tomorrow') date += 86400000;
  else if (value === 'week') days = 7;
  else if (value === 'this week' || value === 'next week') {
    date -= ((weekday + 6) % 7) * 86400000;
    if (value === 'next week') date += 7 * 86400000;
    days = 7;
  } else if (value === 'today') { /* Already local today. */ }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    date = Date.UTC(y!, m! - 1, d!);
    if (new Date(date).toISOString().slice(0, 10) !== value) return unresolved();
  } else {
    const match = /^(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)( this week)?$/.exec(value);
    if (!match || (match[1] && match[3])) return unresolved();
    const target = DAYS.indexOf(match[2]!);
    if (match[1] || match[3]) date += (-((weekday + 6) % 7) + (target + 6) % 7 + (match[1] ? 7 : 0)) * 86400000;
    else date += ((target - weekday + 7) % 7) * 86400000;
  }
  const midnight = (localDate: number): string => {
    let guess = localDate;
    for (let n = 0; n < 5; n++) {
      const [y, m, d, h, min, sec] = parts(guess);
      const represented = Date.UTC(y!, m! - 1, d!, h!, min!, sec!);
      const delta = localDate - represented;
      if (delta === 0) return new Date(guess).toISOString();
      guess += delta;
    }
    return unresolved();
  };
  const start = fromNow && days === 1 && date === Date.UTC(year!, month! - 1, day!) ? new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString() : midnight(date);
  return { timeMin: start, timeMax: midnight(date + days * 86400000) };
}
