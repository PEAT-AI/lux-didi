import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The only remote tools this connector may ever call, in fixed order. A name outside this
 * envelope is refused even when the remote lists it: the local read classification is the
 * authority, never the remote's readOnlyHint.
 */
export const GOOGLE_TOOLS = ['gmail_get_profile', 'gmail_list', 'gmail_read', 'gcal_calendars', 'gcal_list'] as const;
export type GoogleTool = (typeof GOOGLE_TOOLS)[number];

/** Each family is one stdio endpoint; its catalog is a closed subset of the envelope. */
export const GOOGLE_FAMILIES: Readonly<Record<GoogleFamily, readonly GoogleTool[]>> = {
  gmail: ['gmail_get_profile', 'gmail_list', 'gmail_read'],
  calendar: ['gcal_calendars', 'gcal_list'],
};
export type GoogleFamily = 'gmail' | 'calendar';

/** Bounded argument defaults; a caller may only narrow them. */
export const GOOGLE_DEFAULTS = { listResults: 10, mailListResults: 5, maxListResults: 50, readBodyChars: 4000 } as const;

/**
 * How long one merged calendar window read may spend. It is one remote call per visible calendar and the
 * calendar backend serializes those calls (measured 1.7-6 s each), so the read stops here and reports the
 * calendars it did not reach as unread instead of running until the caller aborts and losing the result.
 */
export const GOOGLE_CALENDAR_READ_MS = 40_000;

export interface GoogleConfig {
  endpointId: string;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  family: GoogleFamily;
  /** Largest `maxResults` any list caller may select. Defaults 50, never above 50. */
  maxListResults?: number;
  /** Bound on a gmail_read plain-text body in characters. Defaults 4000. */
  readBodyChars?: number;
  /**
   * Wall-clock bound on one merged calendar window read, which is one serialized remote call per
   * visible calendar. Defaults 40000 and never above it; the calendars not reached are reported unread.
   */
  calendarReadMs?: number;
}

/** Opaque local evidence, mirroring the Lux knowledge connector shape. */
export interface GoogleEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  tool: GoogleTool;
  source: ResultScope;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}
export interface GoogleRefused { state: 'refused'; reason: string }
export interface GoogleUnknown { state: 'unknown'; reason: string }
export type GoogleResult = GoogleEvidence | GoogleRefused | GoogleUnknown;

export interface GmailListInput { maxResults?: number; q?: string; pageToken?: string }
export interface GmailReadInput { id: string; format?: 'metadata' | 'full' }
export interface GcalCalendarsInput { maxResults?: number; pageToken?: string }
export interface GcalListInput { calendarId?: string; calendarIds?: readonly string[]; maxResults?: number; pageToken?: string; timeMin?: string; timeMax?: string; timeZone?: string; now?: () => number }

/** How many per-calendar event reads a single connector call may keep in flight at once. */
export const GOOGLE_CALENDAR_CONCURRENCY = 6;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The first text content item of a decoded MCP result, without the stored payload round trip. */
function contentText(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed['content']) || parsed['content'].length < 1) return undefined;
  const first = parsed['content'][0];
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : undefined;
}

/** RFC3339 timestamp with a numeric offset, e.g. 2026-10-14T00:00:00+05:30. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The host's local day as an RFC3339 window, carrying the session timezone offset. */
export function localDayWindow(now: number, timeZone: string): { timeMin: string; timeMax: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(now)).find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = name === 'GMT' || name === 'UTC' ? '+00:00' : name.replace(/^GMT/, '');
  const day = `${value('year')}-${value('month')}-${value('day')}`;
  const next = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) + 1));
  const nextDay = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  return { timeMin: `${day}T00:00:00${offset}`, timeMax: `${nextDay}T00:00:00${offset}` };
}

export interface GoogleReader {
  gmailProfile(signal?: AbortSignal): Promise<GoogleResult>;
  gmailList(input: GmailListInput, signal?: AbortSignal): Promise<GoogleResult>;
  gmailRead(input: GmailReadInput, signal?: AbortSignal): Promise<GoogleResult>;
  gcalCalendars(input: GcalCalendarsInput, signal?: AbortSignal): Promise<GoogleResult>;
  gcalList(input: GcalListInput, signal?: AbortSignal): Promise<GoogleResult>;
}

export interface GoogleOptions { port: McpPort; registry: McpRegistry; config: GoogleConfig }

const ELIGIBLE: ReadonlySet<string> = new Set<string>(GOOGLE_TOOLS);
type FailedCall = { state: 'refused' | 'unknown'; reason: string };
function isFailed(result: CallResult): result is FailedCall {
  return result.state === 'refused' || result.state === 'unknown';
}
function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('invalid-connector-budget');
  return value as number;
}
function requirePositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('invalid-connector-config');
  return value as number;
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  family: GoogleFamily; maxListResults: number; readBodyChars: number; calendarReadMs: number;
}

/** A family the config names must be a real one; an unknown family is a config fault, never a silent default. */
export function googleFamilyTools(family: unknown): { ok: true; family: GoogleFamily; tools: readonly GoogleTool[] } | { ok: false; reason: string } {
  if (family !== 'gmail' && family !== 'calendar') return { ok: false, reason: 'unknown-family' };
  return { ok: true, family, tools: GOOGLE_FAMILIES[family] };
}

/** Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change. */
function preflight(registry: McpRegistry, settings: Settings, tool: GoogleTool): string | undefined {
  let grant: ReadGrant | undefined;
  try {
    registry.endpoint(settings.endpointId);
    grant = registry.currentGrant(settings.endpointId);
  } catch { return 'source-unavailable'; }
  if (!grant) return 'grant-absent';
  if (grant.schemaDigest !== settings.schemaDigest) return 'schema-drift';
  if (grant.generation !== settings.generation) return 'grant-stale';
  if (grant.effect !== 'read') return 'grant-not-read';
  const visible = registry.visibleTools(settings.endpointId).map(definition => definition.name);
  if (visible.some(name => !ELIGIBLE.has(name))) return 'ineligible-tool-granted';
  if (!grant.toolNames.includes(tool)) return 'tool-not-granted';
  if (!visible.includes(tool)) return 'required-definition-absent';
  return undefined;
}

export function createGoogleReader(options: GoogleOptions): GoogleReader {
  const { port, registry, config } = options;
  const family = googleFamilyTools(config.family);
  if (!family.ok) throw new Error('invalid-connector-config');
  const settings: Settings = {
    endpointId: config.endpointId,
    account: config.account,
    resource: config.resource,
    schemaDigest: config.schemaDigest,
    generation: requirePositiveSafeInteger(config.generation),
    family: family.family,
    maxListResults: Math.min(positive(config.maxListResults, GOOGLE_DEFAULTS.maxListResults), GOOGLE_DEFAULTS.maxListResults),
    readBodyChars: positive(config.readBodyChars, GOOGLE_DEFAULTS.readBodyChars),
    calendarReadMs: Math.min(positive(config.calendarReadMs, GOOGLE_CALENDAR_READ_MS), GOOGLE_CALENDAR_READ_MS),
  };
  if (settings.readBodyChars > GOOGLE_DEFAULTS.readBodyChars) throw new Error('invalid-connector-config');

  async function dispatch(tool: GoogleTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<GoogleResult> {
    const request: CallRequest = {
      endpointId: settings.endpointId,
      toolName: tool,
      arguments: args,
      generation: settings.generation,
      account: settings.account,
      resource: settings.resource,
    };
    if (signal?.aborted) return { state: 'refused', reason: 'cancelled-before-dispatch' };
    const result = await port.call(request, signal);
    if (isFailed(result)) {
      return result.state === 'refused'
        ? { state: 'refused', reason: result.reason }
        : { state: 'unknown', reason: result.reason };
    }
    if (signal?.aborted) return { state: 'unknown', reason: 'cancelled-after-dispatch' };
    const evidence: GoogleEvidence = {
      state: result.state,
      tool,
      source: { ...result.source },
      observedAt: result.freshness.receivedAt,
      coverage: structuredClone(result.coverage),
      decodedResult: structuredClone(result.decodedResult),
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
    return evidence;
  }

  /** Refuses a family's tool on the other endpoint before any dispatch. */
  function gate(tool: GoogleTool): string | undefined {
    return preflight(registry, settings, tool);
  }
  function listArgs(input: { maxResults?: number; pageToken?: string }, defaultResults: number = GOOGLE_DEFAULTS.listResults): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
    const args: Record<string, unknown> = {};
    if (input.maxResults !== undefined) {
      if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > settings.maxListResults) return { ok: false, reason: 'max-results-out-of-budget' };
      args['maxResults'] = input.maxResults;
    } else {
      args['maxResults'] = Math.min(defaultResults, settings.maxListResults);
    }
    if (input.pageToken !== undefined) {
      if (typeof input.pageToken !== 'string' || input.pageToken.length < 1 || input.pageToken.length > 4096) return { ok: false, reason: 'invalid-page-token' };
      args['pageToken'] = input.pageToken;
    }
    return { ok: true, args };
  }

  /** The RFC3339 window for one event read: explicit args, else the host local day. */
  function eventWindow(input: GcalListInput): { ok: true; timeMin: string | undefined; timeMax: string | undefined } | { ok: false; reason: string } {
    const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const window = input.timeMin !== undefined || input.timeMax !== undefined
      ? { timeMin: input.timeMin, timeMax: input.timeMax }
      : localDayWindow((input.now ?? Date.now)(), timeZone);
    if (window.timeMin !== undefined && (typeof window.timeMin !== 'string' || !RFC3339.test(window.timeMin) || window.timeMin.length > 64)) return { ok: false, reason: 'invalid-time-window' };
    if (window.timeMax !== undefined && (typeof window.timeMax !== 'string' || !RFC3339.test(window.timeMax) || window.timeMax.length > 64)) return { ok: false, reason: 'invalid-time-window' };
    return { ok: true, timeMin: window.timeMin, timeMax: window.timeMax };
  }

  /** The `data` object of one completed google envelope, decoded from the local result, never the payload. */
  function envelopeData(evidence: GoogleEvidence): Record<string, unknown> {
    const text = contentText(evidence.decodedResult);
    if (text === undefined) return {};
    let envelope: unknown;
    try { envelope = JSON.parse(text); } catch { return {}; }
    return isRecord(envelope) && isRecord(envelope['data']) ? envelope['data'] : {};
  }

  function calendarsOf(evidence: GoogleEvidence): { id: string; name: string; primary: boolean }[] {
    const list = envelopeData(evidence)['calendars'];
    if (!Array.isArray(list)) return [];
    return list.filter(isRecord).map(entry => ({ id: typeof entry['id'] === 'string' ? entry['id'] : '', name: String(entry['summary'] ?? entry['name'] ?? 'calendar'), primary: entry['primary'] === true })).filter(entry => entry.id.length > 0);
  }

  function eventsOf(evidence: GoogleEvidence): Record<string, unknown>[] {
    const list = envelopeData(evidence)['events'];
    return Array.isArray(list) ? list.filter(isRecord) : [];
  }

  function startOf(event: Record<string, unknown>): string {
    const start = event['start'];
    if (isRecord(start)) return String(start['dateTime'] ?? start['date'] ?? '');
    return String(start ?? '');
  }

  /**
   * One merged event read over every selected calendar: resolve the selected set (or take the caller's
   * list), read each calendar in bounded parallel, and return one result sorted by start with a shared
   * event deduplicated by id and each event tagged with its calendar name.
   */
  async function gcalWindow(baseArgs: Record<string, unknown>, explicit: readonly string[] | undefined, signal?: AbortSignal): Promise<GoogleResult> {
    // The merged read is one serialized remote call per visible calendar, so it carries a wall-clock
    // budget of its own: a read that runs until the caller aborts loses its whole result to the result
    // gate, so it stops short and reports the calendars it did not reach as unread.
    const stopAt = Date.now() + settings.calendarReadMs;
    const listed = await dispatch('gcal_calendars', { maxResults: Math.min(GOOGLE_DEFAULTS.listResults, settings.maxListResults) }, signal);
    if (listed.state !== 'completed') return listed;
    // The owner's primary calendar is always read first and awaited inside the sub-deadline; every other
    // calendar is read concurrently afterwards, and whichever does not finish before the caller's deadline
    // is reported as unread (never silently dropped).
    const calendars = calendarsOf(listed).sort((a, b) => Number(b.primary) - Number(a.primary));
    const names = new Map(calendars.map(entry => [entry.id, entry.name]));
    const selected = explicit ?? calendars.map(entry => entry.id);
    const out: (GoogleEvidence | undefined)[] = new Array(selected.length);
    let failure: GoogleResult | undefined;
    let refusal: GoogleResult | undefined;
    const record = (index: number, result: GoogleResult): void => {
      if (result.state === 'completed') out[index] = result;
      else if (result.state === 'refused') refusal ??= result;
      else failure ??= result;
    };
    const primaryOnly = explicit === undefined && selected.length > 0 && calendars[0]?.primary === true;
    // 1. The primary calendar, awaited on its own so it never loses the race to the deadline.
    if (primaryOnly && signal?.aborted !== true && Date.now() < stopAt) record(0, await dispatch('gcal_list', { ...baseArgs, calendarId: selected[0]! }, signal));
    // 2. Every remaining calendar, concurrently, cut short by the caller's deadline.
    let next = primaryOnly ? 1 : 0;
    const worker = async (): Promise<void> => {
      while (next < selected.length && signal?.aborted !== true && Date.now() < stopAt) {
        const index = next++;
        record(index, await dispatch('gcal_list', { ...baseArgs, calendarId: selected[index]! }, signal));
      }
    };
    const width = Math.max(1, Math.min(GOOGLE_CALENDAR_CONCURRENCY, Math.max(0, selected.length - next)));
    await Promise.race([
      Promise.all(Array.from({ length: width }, worker)),
      new Promise<void>(resolve => { if (signal?.aborted === true) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); }),
      new Promise<void>(resolve => { const left = stopAt - Date.now(); if (left <= 0) resolve(); else setTimeout(resolve, left).unref(); }),
    ]);
    // A credentialed or failed read must stay visible: never an empty success.
    if (out.every(entry => entry === undefined) && (failure ?? refusal) !== undefined) return (failure ?? refusal)!;
    const unread = selected.filter((_, index) => out[index] === undefined).length;
    const merged: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const [index, evidence] of out.entries()) {
      const id = selected[index];
      if (evidence === undefined || id === undefined) continue;
      const name = names.get(id) ?? 'calendar';
      for (const event of eventsOf(evidence)) {
        const eventId = typeof event['id'] === 'string' ? event['id'] : '';
        if (eventId && seen.has(eventId)) continue;
        if (eventId) seen.add(eventId);
        merged.push({ ...structuredClone(event), calendar: name });
      }
    }
    merged.sort((a, b) => startOf(a).localeCompare(startOf(b)));
    return {
      state: 'completed', tool: 'gcal_list',
      source: structuredClone(listed.source), observedAt: listed.observedAt, coverage: structuredClone(listed.coverage),
      decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data: unread > 0 ? { events: merged, partial: { unread } } : { events: merged } }) }] },
      projection: structuredClone(listed.projection),
      response: structuredClone(listed.response),
    };
  }

  return {
    async gmailProfile(signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gmail_get_profile');
      if (denied) return { state: 'refused', reason: denied };
      return dispatch('gmail_get_profile', {}, signal);
    },
    async gmailList(input: GmailListInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gmail_list');
      if (denied) return { state: 'refused', reason: denied };
      // The digest renders at most GMAIL_LIST_MESSAGES (5) lines and the remote gmail_list issues one
      // metadata GET per listed message, so requesting more only adds sequential round trips without
      // changing what the owner sees. A caller may still raise maxResults explicitly up to the budget.
      const bounded = listArgs(input, GOOGLE_DEFAULTS.mailListResults);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      if (input.q !== undefined) {
        if (typeof input.q !== 'string' || input.q.length < 1 || input.q.length > 2048) return { state: 'refused', reason: 'invalid-query' };
        bounded.args['q'] = input.q;
      }
      return dispatch('gmail_list', bounded.args, signal);
    },
    async gmailRead(input: GmailReadInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gmail_read');
      if (denied) return { state: 'refused', reason: denied };
      if (typeof input.id !== 'string' || input.id.length < 1 || input.id.length > 4096) return { state: 'refused', reason: 'invalid-message-id' };
      const format = input.format ?? 'metadata';
      if (format !== 'metadata' && format !== 'full') return { state: 'refused', reason: 'invalid-format' };
      return dispatch('gmail_read', { id: input.id, format }, signal);
    },
    async gcalCalendars(input: GcalCalendarsInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gcal_calendars');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = listArgs(input, GOOGLE_DEFAULTS.listResults);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      return dispatch('gcal_calendars', bounded.args, signal);
    },
    async gcalList(input: GcalListInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gcal_list');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = listArgs(input, GOOGLE_DEFAULTS.listResults);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      const window = eventWindow(input);
      if (!window.ok) return { state: 'refused', reason: window.reason };
      bounded.args['timeMin'] = window.timeMin;
      bounded.args['timeMax'] = window.timeMax;
      // No calendarId (or an explicit list) means every selected calendar, merged into one result.
      if (input.calendarIds !== undefined) {
        const ids = input.calendarIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 4096)) return { state: 'refused', reason: 'invalid-calendar-ids' };
        return await gcalWindow(bounded.args, ids, signal);
      }
      if (input.calendarId === undefined) return await gcalWindow(bounded.args, undefined, signal);
      const calendarId = input.calendarId;
      if (typeof calendarId !== 'string' || calendarId.length < 1 || calendarId.length > 4096) return { state: 'refused', reason: 'invalid-calendar-id' };
      bounded.args['calendarId'] = calendarId;
      return dispatch('gcal_list', bounded.args, signal);
    },
  };
}

/** The most one warm calendar digest may put in the session's Today: line (issue 339). */
export const CALENDAR_DIGEST_CHARS = 400;
/** How long the digest's single primary-calendar read may take before the slot stays absent. */
export const CALENDAR_DIGEST_READ_MS = 5_000;

/** The one read the warm digest needs: the configured connector reader, or the fake a test supplies. */
export interface CalendarDigestRead {
  gcalList(input: GcalListInput, signal?: AbortSignal): Promise<GoogleResult>;
}

/**
 * Today's events on the owner's primary calendar as one bounded line, or undefined when the
 * connector is unconfigured, the read fails or the day is empty. One read, local host time and no
 * model call, so a silent session start that finds nothing here leaves the slot out entirely.
 */
export async function buildCalendarDigest(read: CalendarDigestRead | undefined, input: { now: number; timeZone: string }): Promise<string | undefined> {
  if (read === undefined) return undefined;
  const window = localDayWindow(input.now, input.timeZone);
  let result: GoogleResult;
  try {
    result = await read.gcalList({ calendarId: 'primary', timeMin: window.timeMin, timeMax: window.timeMax, maxResults: GOOGLE_DEFAULTS.listResults }, AbortSignal.timeout(CALENDAR_DIGEST_READ_MS));
  } catch { return undefined; }
  if (result.state !== 'completed') return undefined;
  const text = contentText(result.decodedResult);
  if (text === undefined) return undefined;
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { return undefined; }
  const data = isRecord(envelope) && isRecord(envelope['data']) ? envelope['data'] : {};
  const events = Array.isArray(data['events']) ? data['events'].filter(isRecord) : [];
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: input.timeZone });
  const lines: string[] = [];
  let length = 0;
  for (const event of events) {
    const start = event['start'];
    const stamp = isRecord(start) && typeof start['dateTime'] === 'string' ? clock.format(new Date(start['dateTime'])) : 'all day';
    const summary = typeof event['summary'] === 'string' ? event['summary'].trim() : '';
    const line = stamp + ' ' + (summary.length ? summary : 'untitled');
    const next = lines.length ? ', ' + line : line;
    if (length + next.length > CALENDAR_DIGEST_CHARS) break;
    lines.push(line);
    length += next.length;
  }
  return lines.length ? lines.join(', ') : undefined;
}
