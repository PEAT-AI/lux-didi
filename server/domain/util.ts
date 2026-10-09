import { randomUUID } from 'node:crypto';
import { badRequest } from './contract.ts';

export function newId(): string {
  return randomUUID();
}

export function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${field} is required`);
  }
  return value;
}

export function assertTimeZone(value: unknown, field = 'timeZone'): string {
  if (typeof value !== 'string' || value.length === 0) badRequest(`${field} is required`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    badRequest(`${field} is not an IANA time zone`);
  }
  return value;
}

export function assertLimit(limit: unknown, field = 'limit'): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    badRequest(`${field} must be a positive integer`);
  }
  return limit;
}

// Case- and diacritic-insensitive folding for deterministic keyword recall.
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function tokenize(query: string): string[] {
  return fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// --- IANA local-day boundaries (no external dependency) --------------------

function tzOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - utcMs;
}

/** UTC instant of 00:00 local for `YYYY-MM-DD` in an IANA zone. */
export function localMidnightUtc(dateLocal: string, timeZone: string): number {
  assertTimeZone(timeZone);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal);
  if (!m) badRequest('date must be YYYY-MM-DD');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  // Two passes settle DST transitions.
  let ms = guess - tzOffsetMs(timeZone, guess);
  ms = guess - tzOffsetMs(timeZone, ms);
  return ms;
}

/** [startUtc, endUtcExclusive) for the local calendar day. */
export function localDayBounds(dateLocal: string, timeZone: string): { start: number; end: number } {
  const start = localMidnightUtc(dateLocal, timeZone);
  const d = new Date(`${dateLocal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const next = d.toISOString().slice(0, 10);
  return { start, end: localMidnightUtc(next, timeZone) };
}
