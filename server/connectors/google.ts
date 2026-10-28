import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { SOURCE_DISPATCH, SOURCE_CHILD_DISPATCHES, type SourceDispatchEvidence } from '../adapters/mcp/port.js';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The only remote tools this connector may ever call, in fixed order. A name outside this
 * envelope is refused even when the remote lists it: the local read classification is the
 * authority, never the remote's readOnlyHint.
 */
export const GOOGLE_TOOLS = ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message', 'calendar_list_calendars', 'calendar_list_events', 'drive_search_files', 'drive_get_file'] as const;
export type GoogleTool = (typeof GOOGLE_TOOLS)[number];

/** Each family is one stdio endpoint; its catalog is a closed subset of the envelope. */
export const GOOGLE_FAMILIES: Readonly<Record<GoogleFamily, readonly GoogleTool[]>> = {
  gmail: ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message'],
  calendar: ['calendar_list_calendars', 'calendar_list_events'],
  // C-OPEN 2: read-only Drive metadata (lux-cli drive family, C-DRIVE.md), its own endpoint and token.
  drive: ['drive_search_files', 'drive_get_file'],
};
export type GoogleFamily = 'gmail' | 'calendar' | 'drive';

/** Bounded argument defaults; a caller may only narrow them. */
export const GOOGLE_DEFAULTS = { listResults: 10, mailListResults: 10, maxListResults: 50, readBodyChars: 4000 } as const;

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
  /** Bound on a gmail_read_message plain-text body in characters. Defaults 4000. */
  readBodyChars?: number;
  /**
   * Wall-clock bound on one merged calendar window read, which is one serialized remote call per
   * visible calendar. Defaults 40000 and never above it; the calendars not reached are reported unread.
   */
  calendarReadMs?: number;
}

/** Opaque local evidence, mirroring the Lux knowledge connector shape. */
export interface GoogleEvidence extends SourceDispatchEvidence {
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
/** C-DRIVE drive_search_files: a name query, optional type filter and window, at most ten files. */
export interface DriveSearchInput { query: string; mime_types?: readonly string[]; modified_after?: string; limit?: number }
export interface DriveGetInput { file_id: string }
/** The Drive search page bounds (C-DRIVE): 1 to 10, five when the caller names none. */
export const DRIVE_LIMIT = { default: 5, max: 10 } as const;
export interface GcalListInput {
  calendarId?: string; calendarIds?: readonly string[]; maxResults?: number; pageToken?: string; timeMin?: string; timeMax?: string; timeZone?: string; now?: () => number;
  /** The caller's remaining source budget as an absolute epoch ms; the fan-out never plans past it. */
  deadlineAt?: number;
}

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
  driveSearch(input: DriveSearchInput, signal?: AbortSignal): Promise<GoogleResult>;
  driveGet(input: DriveGetInput, signal?: AbortSignal): Promise<GoogleResult>;
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

/**
 * C-DEPTH11: a completed helper result that carries no JSON envelope at all. A helper that crashed, was
 * killed early or wrote a half message leaves one of these, and it must never read as an honest empty.
 */
function hasEnvelope(result: CompletedResult): boolean {
  const text = contentText(result.decodedResult);
  if (text === undefined || text.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && isRecord(parsed['data']);
  } catch { return false; }
}

/**
 * C-DEPTH11: a calendar the owner subscribed to (holidays, week numbers, contacts' birthdays) rather than
 * owns. Google serves these as group calendars; a calendar whose entry carries no accessRole is never
 * excluded, so a helper that omits the field cannot hide the owner's own calendar.
 * Provenance: https://developers.google.com/workspace/calendar/api/v3/reference/calendarList#resource
 */
const SUBSCRIBED_CALENDAR = /@group\.v\.calendar\.google\.com$/u;
function isOwnerCalendar(calendar: { id: string; primary: boolean; role: string }): boolean {
  if (SUBSCRIBED_CALENDAR.test(calendar.id)) return false;
  return calendar.role === '' || calendar.primary || calendar.role === 'owner';
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  family: GoogleFamily; maxListResults: number; readBodyChars: number; calendarReadMs: number;
}

/** A family the config names must be a real one; an unknown family is a config fault, never a silent default. */
export function googleFamilyTools(family: unknown): { ok: true; family: GoogleFamily; tools: readonly GoogleTool[] } | { ok: false; reason: string } {
  if (family !== 'gmail' && family !== 'calendar' && family !== 'drive') return { ok: false, reason: 'unknown-family' };
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
    // C-DEPTH11/#648: no payload at all is a failed read with one closed code, never a completed read that
    // reaches the model as an honest empty.
    if (!hasEnvelope(result)) return { state: 'unknown', reason: 'empty-payload' };
    const evidence: GoogleEvidence = {
      state: result.state,
      tool,
      source: { ...result.source },
      ...(result[SOURCE_DISPATCH] ? {[SOURCE_DISPATCH]:result[SOURCE_DISPATCH]} : {}),
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

  function calendarsOf(evidence: GoogleEvidence): { id: string; name: string; primary: boolean; role: string }[] {
    const list = envelopeData(evidence)['calendars'];
    if (!Array.isArray(list)) return [];
    return list.filter(isRecord).map(entry => ({ id: typeof entry['id'] === 'string' ? entry['id'] : '', name: String(entry['summary'] ?? entry['name'] ?? 'calendar'), primary: entry['primary'] === true, role: typeof entry['accessRole'] === 'string' ? entry['accessRole'] : '' })).filter(entry => entry.id.length > 0);
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
  /**
   * R5/R6: the helper gained an `include` projection for attendees and organizer, and an older helper refuses any
   * argument it does not declare. So the field is sent only when the accepted schema advertises it.
   */
  function includeArgs(): Record<string, unknown> {
    try {
      const definition = registry.visibleTools(settings.endpointId).find(entry => entry.name === 'calendar_list_events');
      const properties = (definition?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      return properties !== undefined && properties['include'] !== undefined ? { include: ['attendees', 'organizer'] } : {};
    } catch { return {}; }
  }

  async function gcalWindow(baseArgs: Record<string, unknown>, explicit: readonly string[] | undefined, signal?: AbortSignal, deadlineAt?: number): Promise<GoogleResult> {
    baseArgs = { ...baseArgs, ...includeArgs() };
    // The merged read is one serialized remote call per visible calendar, so it carries a wall-clock
    // budget of its own: a read that runs until the caller aborts loses its whole result to the result
    // gate, so it stops short and reports the calendars it did not reach as unread. A caller that names
    // its own remaining source budget bounds the read tighter than this constant, never looser (#473).
    const stopAt = Math.min(Date.now() + settings.calendarReadMs, deadlineAt ?? Number.POSITIVE_INFINITY);
    const listed = await dispatch('calendar_list_calendars', { maxResults: Math.min(GOOGLE_DEFAULTS.listResults, settings.maxListResults) }, signal);
    if (listed.state !== 'completed') return listed;
    // The owner's primary calendar is always read first and awaited inside the sub-deadline; every other
    // calendar is read concurrently afterwards, and whichever does not finish before the caller's deadline
    // is reported as unread (never silently dropped).
    const calendars = calendarsOf(listed).sort((a, b) => Number(b.primary) - Number(a.primary));
    const names = new Map(calendars.map(entry => [entry.id, entry.name]));
    // C-DEPTH11: the default read is the owner's own calendars. A subscribed holiday, week-number or
    // contacts calendar is read only when the caller names it, because reading every subscription used up
    // the read budget and answered a schedule question with public holidays.
    const selected = explicit ?? calendars.filter(isOwnerCalendar).map(entry => entry.id);
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
    if (primaryOnly && signal?.aborted !== true && Date.now() < stopAt) record(0, await dispatch('calendar_list_events', { ...baseArgs, calendarId: selected[0]! }, signal));
    // 2. Every remaining calendar, concurrently, cut short by the caller's deadline.
    let next = primaryOnly ? 1 : 0;
    const worker = async (): Promise<void> => {
      while (next < selected.length && signal?.aborted !== true && Date.now() < stopAt) {
        const index = next++;
        record(index, await dispatch('calendar_list_events', { ...baseArgs, calendarId: selected[index]! }, signal));
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
    const unread = selected.filter((_, index) => out[index] === undefined).map(id => names.get(id) ?? id);
    const merged: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    // C-DEPTH11: an older helper cannot be asked for attendees, so a served event with no attendee list is
    // marked unrequested rather than reported as an event with nobody on it.
    const attendeeDataRequested = Object.keys(includeArgs()).length > 0;
    for (const [index, evidence] of out.entries()) {
      const id = selected[index];
      if (evidence === undefined || id === undefined) continue;
      const name = names.get(id) ?? 'calendar';
      for (const event of eventsOf(evidence)) {
        const eventId = typeof event['id'] === 'string' ? event['id'] : '';
        if (eventId && seen.has(eventId)) continue;
        if (eventId) seen.add(eventId);
        merged.push({ ...structuredClone(event), calendar: name, ...(attendeeDataRequested ? {} : { attendeesUnavailable: true }) });
      }
    }
    merged.sort((a, b) => startOf(a).localeCompare(startOf(b)));
    return {
      state: 'completed', tool: 'calendar_list_events',
      [SOURCE_CHILD_DISPATCHES]: [listed,...out.filter((entry): entry is GoogleEvidence => entry !== undefined)].flatMap(entry => entry[SOURCE_DISPATCH] ? [entry[SOURCE_DISPATCH]!] : []),
      source: structuredClone(listed.source), observedAt: listed.observedAt, coverage: structuredClone(listed.coverage),
      decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data: unread.length > 0 ? { events: merged, partial: { unread: unread.length, calendars: unread } } : { events: merged } }) }] },
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
      const denied = gate('gmail_search_messages');
      if (denied) return { state: 'refused', reason: denied };
      // The helper fetches the listed messages' metadata in one batched call, so the request is no longer
      // paced by sequential round trips; the digest still renders at most GMAIL_LIST_MESSAGES (10) lines
      // and a caller may raise maxResults explicitly up to the budget.
      const bounded = listArgs(input, GOOGLE_DEFAULTS.mailListResults);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      if (input.q !== undefined) {
        if (typeof input.q !== 'string' || input.q.length < 1 || input.q.length > 2048) return { state: 'refused', reason: 'invalid-query' };
        bounded.args['q'] = input.q;
      }
      return dispatch('gmail_search_messages', bounded.args, signal);
    },
    async gmailRead(input: GmailReadInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gmail_read_message');
      if (denied) return { state: 'refused', reason: denied };
      if (typeof input.id !== 'string' || input.id.length < 1 || input.id.length > 4096) return { state: 'refused', reason: 'invalid-message-id' };
      const format = input.format ?? 'full';
      if (format !== 'metadata' && format !== 'full') return { state: 'refused', reason: 'invalid-format' };
      return dispatch('gmail_read_message', { id: input.id, format }, signal);
    },
    async gcalCalendars(input: GcalCalendarsInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('calendar_list_calendars');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = listArgs(input, GOOGLE_DEFAULTS.listResults);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      return dispatch('calendar_list_calendars', bounded.args, signal);
    },
    async gcalList(input: GcalListInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('calendar_list_events');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = listArgs(input, GOOGLE_DEFAULTS.listResults);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      const window = eventWindow(input);
      if (!window.ok) return { state: 'refused', reason: window.reason };
      bounded.args['timeMin'] = window.timeMin;
      bounded.args['timeMax'] = window.timeMax;
      // The fan-out plans inside the caller's remaining source budget when it names one (#473).
      const deadlineAt = typeof input.deadlineAt === 'number' && Number.isFinite(input.deadlineAt) ? input.deadlineAt : undefined;
      // No calendarId (or an explicit list) means every selected calendar, merged into one result.
      if (input.calendarIds !== undefined) {
        const ids = input.calendarIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 4096)) return { state: 'refused', reason: 'invalid-calendar-ids' };
        return await gcalWindow(bounded.args, ids, signal, deadlineAt);
      }
      if (input.calendarId === undefined) return await gcalWindow(bounded.args, undefined, signal, deadlineAt);
      const calendarId = input.calendarId;
      if (typeof calendarId !== 'string' || calendarId.length < 1 || calendarId.length > 4096) return { state: 'refused', reason: 'invalid-calendar-id' };
      bounded.args['calendarId'] = calendarId;
      // #574: a single-calendar day read carries the same attendee and organizer projection as a merged one.
      return dispatch('calendar_list_events', { ...bounded.args, ...includeArgs() }, signal);
    },
    async driveSearch(input: DriveSearchInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('drive_search_files');
      if (denied) return { state: 'refused', reason: denied };
      if (typeof input.query !== 'string' || input.query.trim().length < 1 || input.query.length > 200) return { state: 'refused', reason: 'invalid-query' };
      const args: Record<string, unknown> = { query: input.query.trim() };
      if (input.mime_types !== undefined) {
        const types = input.mime_types;
        if (!Array.isArray(types) || types.length < 1 || types.length > 8 || !types.every(type => typeof type === 'string' && /^[a-z0-9.+-]{1,40}\/[A-Za-z0-9.+-]{1,120}$/.test(type))) return { state: 'refused', reason: 'invalid-mime-types' };
        args['mime_types'] = [...types];
      }
      if (input.modified_after !== undefined) {
        if (typeof input.modified_after !== 'string' || !RFC3339.test(input.modified_after)) return { state: 'refused', reason: 'invalid-time-window' };
        args['modified_after'] = input.modified_after;
      }
      const limit = input.limit ?? DRIVE_LIMIT.default;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > DRIVE_LIMIT.max) return { state: 'refused', reason: 'limit-out-of-budget' };
      args['limit'] = limit;
      return dispatch('drive_search_files', args, signal);
    },
    async driveGet(input: DriveGetInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('drive_get_file');
      if (denied) return { state: 'refused', reason: denied };
      // A Drive file id is an opaque token; anything else is refused before it reaches the helper.
      if (typeof input.file_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.file_id)) return { state: 'refused', reason: 'invalid-file-id' };
      return dispatch('drive_get_file', { file_id: input.file_id }, signal);
    },
  };
}

/**
 * D1-R4: the helper's own account pin, as the catalogue declares it. The lux-cli Google helper compares
 * every refreshed id_token's verified email with LUX_GOOGLE_MCP_ACCOUNT and refuses every read otherwise
 * (tools/google-mcp/google_mcp/creds.py, assert_identity), so a child pinned to another account can only
 * act as that account. Didi refuses such a child, and a child with no pin at all, before registration.
 */
export const GOOGLE_HELPER_ACCOUNT_ENV = 'LUX_GOOGLE_MCP_ACCOUNT';

export function googleAccountPinRefused(
  entry: { connector: string; transport?: string; env?: Readonly<Record<string, string>> },
  ownerIdentity: string | null,
): boolean {
  if (ownerIdentity === null || entry.connector !== 'google' || entry.transport !== 'stdio') return false;
  const pinned = entry.env?.[GOOGLE_HELPER_ACCOUNT_ENV];
  return typeof pinned !== 'string' || pinned.trim().toLowerCase() !== ownerIdentity.trim().toLowerCase();
}

/**
 * C-OPEN 6: a Google helper that runs from the reports folder (a private working copy that may be
 * archived at any time) is unsafe wiring. True when the command, or the interpreter its first line
 * names, sits under <home>/.lux/reports, as written or resolved. A file that cannot be read is the
 * connector's own failure to report, never this notice.
 */
export function googleMcpPathUnsafe(command: string, home: string): boolean {
  const reports = resolve(home, '.lux', 'reports');
  let reportsReal = reports;
  try { reportsReal = realpathSync(reports); } catch { /* an absent folder still names the place */ }
  const under = (path: string): boolean => [reports, reportsReal].some(root => path === root || path.startsWith(`${root}${sep}`));
  const real = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
  const commandReal = real(command);
  if (commandReal === undefined) return false;
  const candidates = [command, commandReal];
  let head = '';
  try {
    const fd = openSync(commandReal, 'r');
    try { const buffer = Buffer.alloc(512); head = buffer.toString('utf8', 0, readSync(fd, buffer, 0, 512, 0)); } finally { closeSync(fd); }
  } catch { head = ''; }
  const interpreter = /^#!\s*(\S+)/.exec(head)?.[1];
  if (interpreter !== undefined && isAbsolute(interpreter)) candidates.push(interpreter, real(interpreter) ?? interpreter);
  return candidates.some(under);
}

/** The most one warm calendar digest may put in the session's Today: line (issue 339). */
export const CALENDAR_DIGEST_CHARS = 400;
/**
 * The digest's single primary-calendar read budget (1015). It used to be 5 s, which aborted a read the
 * connector itself allows 40 s for and which measures 1.7 to 6 s, so a Monday morning read was cut
 * short and reported as an empty day.
 */
export const CALENDAR_DIGEST_READ_MS = 30_000;

/** The one read the warm digest needs: the configured connector reader, or the fake a test supplies. */
export interface CalendarDigestRead {
  gcalList(input: GcalListInput, signal?: AbortSignal): Promise<GoogleResult>;
}

/** What one digest read reached. `stale` belongs to the cache that holds it, never to a read. */
export type CalendarDigestReadState = 'present' | 'empty' | 'failed' | 'timeout' | 'unconfigured';

/** One digest read with its honest state and the time it finished, so a caller can cache it. */
export interface CalendarDigestReadResult {
  readonly state: CalendarDigestReadState;
  readonly text: string | undefined;
  readonly items: number;
  readonly fetchedAt: number;
}

/**
 * Today's events on the owner's primary calendar as one bounded line, with the state the read reached:
 * `present` or `empty` for a completed read, `failed` for a refusal or an unreadable answer and
 * `timeout` for a read the budget aborted. A failure is never reported as an empty day. One read,
 * local host time and no model call, so a silent session start that finds nothing leaves the slot out.
 */
export async function readCalendarDigest(read: CalendarDigestRead | undefined, input: { now: () => number; timeZone: string }, budgetMs = CALENDAR_DIGEST_READ_MS): Promise<CalendarDigestReadResult> {
  const absent = (state: CalendarDigestReadState): CalendarDigestReadResult => ({ state, text: undefined, items: 0, fetchedAt: input.now() });
  if (read === undefined) return absent('unconfigured');
  const window = localDayWindow(input.now(), input.timeZone);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let result: GoogleResult;
  try {
    result = await read.gcalList({ calendarId: 'primary', timeMin: window.timeMin, timeMax: window.timeMax, maxResults: GOOGLE_DEFAULTS.listResults }, controller.signal);
  } catch { return absent(controller.signal.aborted ? 'timeout' : 'failed'); }
  finally { clearTimeout(timer); }
  if (controller.signal.aborted) return absent('timeout');
  if (result.state !== 'completed') return absent('failed');
  const text = contentText(result.decodedResult);
  if (text === undefined) return absent('failed');
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { return absent('failed'); }
  const data = isRecord(envelope) && isRecord(envelope['data']) ? envelope['data'] : {};
  const events = Array.isArray(data['events']) ? data['events'].filter(isRecord) : [];
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: input.timeZone });
  const clockOf = (event: Record<string, unknown>): string => {
    const start = event['start'];
    return isRecord(start) && typeof start['dateTime'] === 'string' ? clock.format(new Date(start['dateTime'])) : 'all day';
  };
  const atOf = (event: Record<string, unknown>): number | undefined => {
    const start = event['start'];
    const at = isRecord(start) && typeof start['dateTime'] === 'string' ? Date.parse(start['dateTime']) : Number.NaN;
    return Number.isFinite(at) ? at : undefined;
  };
  // C-CAL8: the meetings still ahead come first, then the clockless all-day entries, then what is past, so a
  // bounded digest always carries the next events instead of the ones the owner already sat through.
  const now = input.now();
  const timed = events.map(event => ({ event, at: atOf(event) }));
  const ahead = timed.filter(item => item.at !== undefined && item.at >= now);
  const allDay = timed.filter(item => item.at === undefined);
  const past = timed.filter(item => item.at !== undefined && item.at < now);
  const lines = [...ahead, ...allDay, ...past].map(item => {
    const summary = typeof item.event['summary'] === 'string' ? item.event['summary'].trim() : '';
    return clockOf(item.event) + ' ' + (summary.length ? summary : 'untitled');
  });
  if (lines.length === 0) return absent('empty');
  const digestText = (kept: number): string => (kept < lines.length ? `${lines.slice(0, kept).join(', ')}, +${lines.length - kept} more` : lines.join(', '));
  let kept = 0;
  let length = 0;
  for (const line of lines) {
    const next = kept === 0 ? line : ', ' + line;
    if (length + next.length > CALENDAR_DIGEST_CHARS) break;
    kept += 1;
    length += next.length;
  }
  // C-CAL8: a digest that cuts ends with `+N more`, so a bounded line is never read as the whole day.
  while (kept > 1 && digestText(kept).length > CALENDAR_DIGEST_CHARS) kept -= 1;
  // C-CAL8 F3: no event fits the bound at all, so the slot says nothing rather than a comma and a count.
  if (kept === 0) return absent('empty');
  return { state: 'present', text: digestText(kept), items: kept, fetchedAt: input.now() };
}

/**
 * The text-only projection of one digest read (issue 339), for a caller that wants the slot or nothing.
 * The state-bearing reader above is what the host's cache uses; nothing here can tell a failure from
 * an empty day, which is why the cache never goes through it.
 */
export async function buildCalendarDigest(read: CalendarDigestRead | undefined, input: { now: number; timeZone: string }): Promise<string | undefined> {
  return (await readCalendarDigest(read, { now: () => input.now, timeZone: input.timeZone })).text;
}
