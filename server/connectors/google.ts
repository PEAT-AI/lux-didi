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
export const GOOGLE_DEFAULTS = { listResults: 10, maxListResults: 50, readBodyChars: 4000 } as const;

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
}

/** Opaque local evidence, mirroring the Lux knowledge connector shape. */
export interface GoogleEvidence {
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
export interface GcalListInput { calendarId?: string; maxResults?: number; pageToken?: string; now?: () => number }

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
  family: GoogleFamily; maxListResults: number; readBodyChars: number;
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
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
    return evidence;
  }

  /** Refuses a family's tool on the other endpoint before any dispatch. */
  function gate(tool: GoogleTool): string | undefined {
    return preflight(registry, settings, tool);
  }
  function listArgs(input: { maxResults?: number; pageToken?: string }): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
    const args: Record<string, unknown> = {};
    if (input.maxResults !== undefined) {
      if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > settings.maxListResults) return { ok: false, reason: 'max-results-out-of-budget' };
      args['maxResults'] = input.maxResults;
    } else {
      args['maxResults'] = Math.min(GOOGLE_DEFAULTS.listResults, settings.maxListResults);
    }
    if (input.pageToken !== undefined) {
      if (typeof input.pageToken !== 'string' || input.pageToken.length < 1 || input.pageToken.length > 4096) return { ok: false, reason: 'invalid-page-token' };
      args['pageToken'] = input.pageToken;
    }
    return { ok: true, args };
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
      const bounded = listArgs(input);
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
      const bounded = listArgs(input);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      return dispatch('gcal_calendars', bounded.args, signal);
    },
    async gcalList(input: GcalListInput, signal?: AbortSignal): Promise<GoogleResult> {
      const denied = gate('gcal_list');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = listArgs(input);
      if (!bounded.ok) return { state: 'refused', reason: bounded.reason };
      const calendarId = input.calendarId ?? 'primary';
      if (typeof calendarId !== 'string' || calendarId.length < 1 || calendarId.length > 4096) return { state: 'refused', reason: 'invalid-calendar-id' };
      bounded.args['calendarId'] = calendarId;
      const now = (input.now ?? Date.now)();
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      const start = day.getTime();
      bounded.args['timeMin'] = new Date(start).toISOString();
      bounded.args['timeMax'] = new Date(start + 24 * 60 * 60 * 1000).toISOString();
      return dispatch('gcal_list', bounded.args, signal);
    },
  };
}
