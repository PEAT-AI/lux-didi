import { SOURCE_DISPATCH, type SourceDispatchEvidence } from '../adapters/mcp/port.js';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/** The only remote tools this connector may ever call, in fixed order. No caller override. */
export const LUX_KNOWLEDGE_TOOLS = ['search_knowledge', 'get_insight'] as const;
export type LuxKnowledgeTool = (typeof LUX_KNOWLEDGE_TOOLS)[number];

export interface LuxKnowledgeConfig {
  includeSensitive?: boolean;
  endpointId: string;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  /** Request budget: largest `limit` a search caller may select. */
  maxSearchLimit: number;
  /** Batch budget: largest number of IDs a get caller may select. */
  maxGetIds: number;
  /** Bound on query length in characters. */
  maxQueryChars: number;
}

/** The lux-knowledge 3r search bounds: `max_chars` and `deadline_ms` are validated here, not trusted from the caller. */
export const KNOWLEDGE_BODY_MIN_CHARS = 200;
export const KNOWLEDGE_BODY_MAX_CHARS = 6_000;
export const KNOWLEDGE_DEADLINE_MIN_MS = 500;
export const KNOWLEDGE_DEADLINE_MAX_MS = 30_000;
/** MED-1022: the server's own `snippet_chars` range, the bound on each hit after the first. */
export const KNOWLEDGE_SNIPPET_MIN_CHARS = 100;
export const KNOWLEDGE_SNIPPET_MAX_CHARS = 6_000;

/** MED-1022: a meeting bound is a real calendar day, never a date-shaped string. */
export function isCalendarDay(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

export interface LuxKnowledgeSearchInput {
  query: string;
  limit: number;
  /** 3r: snippets (the old shape) or bounded stored bodies; MED-1022 adds the voice shape. */
  detail?: 'snippets' | 'bodies' | 'voice';
  /** 3r: per-body character cap, within the server's own 200..6000 range. */
  maxChars?: number;
  /** 3r: the search's own time budget, within the server's own 500..30000 range. */
  deadlineMs?: number;
  /** K4: rank inside one project tag. The owner's own corpus is project tagged; a filter is never guessed. */
  project?: string;
  /** K4: boost one project's entries without excluding any other. */
  projectHint?: string;
  /** MED-1022: the voice shape's bound on each further hit, within the server's 100..6000 range. */
  snippetChars?: number;
  /** MED-1022: an ISO day the connector narrows to; inclusive, in the owner's zone. */
  meetingDateFrom?: string;
  meetingDateTo?: string;
}
export interface LuxKnowledgeGetInput { ids: number[]; include_links?: boolean }

export interface HttpLuxKnowledgeSource {
  toolName: string;
  endpointId: string;
  url: string;
  account: string;
  resource: string;
  schemaDigest: string;
  generation: number;
}
/** Transport-specific provenance: stdio carries no url, only the safe binding digest. */
export interface StdioLuxKnowledgeSource {
  toolName: string;
  endpointId: string;
  transport: 'stdio';
  bindingDigest: string;
  account: string;
  resource: string;
  schemaDigest: string;
  generation: number;
}
export type LuxKnowledgeSource = HttpLuxKnowledgeSource | StdioLuxKnowledgeSource;

/** Opaque local evidence. Classification is constant `unknown`; markdown can never change it. */
export interface LuxKnowledgeEvidence extends SourceDispatchEvidence {
  decodedResult: unknown;
  classification: 'unknown';
  capability: 'local-only';
  tool: LuxKnowledgeTool;
  source: LuxKnowledgeSource;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}

export interface LuxKnowledgeRefused { state: 'refused'; reason: string }
export interface LuxKnowledgeUnknown { state: 'unknown'; reason: string }

export type LuxKnowledgeResult =
  | (LuxKnowledgeEvidence & {
      state: 'completed' | 'tool-error' | 'protocol-error';
      /** get() only: caller-requested IDs, NOT verified returned entities. */
      requestedIds?: readonly number[];
    })
  | LuxKnowledgeRefused
  | LuxKnowledgeUnknown;

export interface LuxKnowledgeReader {
  search(input: LuxKnowledgeSearchInput, signal?: AbortSignal): Promise<LuxKnowledgeResult>;
  get(input: LuxKnowledgeGetInput, signal?: AbortSignal): Promise<LuxKnowledgeResult>;
}

export interface LuxKnowledgeOptions {
  port: McpPort;
  registry: McpRegistry;
  config: LuxKnowledgeConfig;
}

const ELIGIBLE: ReadonlySet<string> = new Set<string>(LUX_KNOWLEDGE_TOOLS);

/** Distinguishes the adapter's non-completed outcomes from a completed protocol result. */
type FailedCall = { state: 'refused' | 'unknown'; reason: string };
function isFailed(result: CallResult): result is FailedCall {
  return result.state === 'refused' || result.state === 'unknown';
}

/** Config budgets must be real; never silently defaulted or clamped to an invented floor. */
function requirePositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('invalid-connector-config');
  return value as number;
}

/**
 * Reads an exact plain-data record once: own keys (symbols and non-enumerable included) must be
 * exactly `keys`, every entry must be a data property (no accessors), and every value is taken
 * from the same descriptor read. This is a strict data DTO boundary, not a Proxy sandbox.
 */
function readExactRecord(value: unknown, keys: readonly string[]): { [key: string]: PropertyDescriptor } | undefined {
  return readAllowedRecord(value, keys);
}

/** The same strict read for an argument set whose trailing keys are optional; an unknown key still refuses. */
function readAllowedRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): { [key: string]: PropertyDescriptor } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const own = Reflect.ownKeys(value);
  const record: { [key: string]: PropertyDescriptor } = {};
  for (const key of own) {
    if (typeof key !== 'string' || !(required.includes(key) || optional.includes(key))) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    record[key] = descriptor;
  }
  for (const key of required) if (!(key in record)) return undefined;
  return record;
}

/** Copies a dense array of positive safe integers once, rejecting holes, extras and accessors. */
function readIds(value: unknown, max: number): { ok: true; ids: number[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: 'ids-not-array' };
  if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false, reason: 'ids-not-dense' };
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || (lengthDescriptor.value as number) < 0) {
    return { ok: false, reason: 'ids-not-dense' };
  }
  const length = lengthDescriptor.value as number;
  const own = Reflect.ownKeys(value);
  if (own.length !== length + 1 || own.some(key => typeof key !== 'string')) return { ok: false, reason: 'ids-not-dense' };
  if (length === 0) return { ok: false, reason: 'ids-empty' };
  if (length > max) return { ok: false, reason: 'get-batch-out-of-budget' };
  const ids: number[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return { ok: false, reason: 'ids-not-dense' };
    const id = descriptor.value;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) return { ok: false, reason: 'ids-not-positive-integer' };
    ids.push(id as number);
  }
  const seen = new Set<number>();
  for (const id of ids) { if (seen.has(id)) return { ok: false, reason: 'ids-not-unique' }; seen.add(id); }
  return { ok: true, ids };
}

interface Budgets { maxSearchLimit: number; maxGetIds: number; maxQueryChars: number }
interface Settings extends Budgets {
  includeSensitive: boolean;
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
}

function validateSearch(input: unknown, budgets: Budgets): { ok: true; args: LuxKnowledgeSearchInput } | { ok: false; reason: string } {
  const record = readAllowedRecord(input, ['query', 'limit'], ['detail', 'maxChars', 'deadlineMs', 'project', 'projectHint', 'snippetChars', 'meetingDateFrom', 'meetingDateTo']);
  if (record === undefined) return { ok: false, reason: 'invalid-search-input' };
  const query = record['query']!.value;
  const limit = record['limit']!.value;
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > budgets.maxQueryChars) return { ok: false, reason: 'invalid-query' };
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > budgets.maxSearchLimit) return { ok: false, reason: 'search-limit-out-of-budget' };
  const detail = record['detail']?.value;
  const maxChars = record['maxChars']?.value;
  const deadlineMs = record['deadlineMs']?.value;
  const project = record['project']?.value;
  const projectHint = record['projectHint']?.value;
  const snippetChars = record['snippetChars']?.value;
  const meetingDateFrom = record['meetingDateFrom']?.value;
  const meetingDateTo = record['meetingDateTo']?.value;
  // K4: a project tag is a name the corpus carries, never a pattern the model composed.
  const projectName = (value: unknown): boolean => value === undefined || (typeof value === 'string' && /^[\w.@-]{1,64}$/u.test(value));
  if (!projectName(project) || !projectName(projectHint)) return { ok: false, reason: 'invalid-project' };
  if (detail !== undefined && detail !== 'snippets' && detail !== 'bodies' && detail !== 'voice') return { ok: false, reason: 'invalid-detail' };
  if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || (maxChars as number) < KNOWLEDGE_BODY_MIN_CHARS || (maxChars as number) > KNOWLEDGE_BODY_MAX_CHARS)) return { ok: false, reason: 'max-chars-out-of-range' };
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || (deadlineMs as number) < KNOWLEDGE_DEADLINE_MIN_MS || (deadlineMs as number) > KNOWLEDGE_DEADLINE_MAX_MS)) return { ok: false, reason: 'deadline-ms-out-of-range' };
  if (snippetChars !== undefined && (!Number.isSafeInteger(snippetChars) || (snippetChars as number) < KNOWLEDGE_SNIPPET_MIN_CHARS || (snippetChars as number) > KNOWLEDGE_SNIPPET_MAX_CHARS)) return { ok: false, reason: 'snippet-chars-out-of-range' };
  if (!isCalendarDay(meetingDateFrom) || !isCalendarDay(meetingDateTo)) return { ok: false, reason: 'invalid-meeting-date' };
  return {
    ok: true,
    args: {
      query, limit: limit as number,
      ...(detail === undefined ? {} : { detail: detail as 'snippets' | 'bodies' | 'voice' }),
      ...(maxChars === undefined ? {} : { maxChars: maxChars as number }),
      ...(deadlineMs === undefined ? {} : { deadlineMs: deadlineMs as number }),
      ...(project === undefined ? {} : { project: project as string }),
      ...(projectHint === undefined ? {} : { projectHint: projectHint as string }),
      ...(snippetChars === undefined ? {} : { snippetChars: snippetChars as number }),
      ...(meetingDateFrom === undefined ? {} : { meetingDateFrom: meetingDateFrom as string }),
      ...(meetingDateTo === undefined ? {} : { meetingDateTo: meetingDateTo as string }),
    },
  };
}
function validateGet(input: unknown, budgets: Budgets): { ok: true; ids: number[]; includeLinks: boolean } | { ok: false; reason: string } {
  const hasLinks = typeof input === 'object' && input !== null && !Array.isArray(input) && 'include_links' in (input as Record<string, unknown>);
  const record = readExactRecord(input, hasLinks ? ['ids', 'include_links'] : ['ids']);
  if (record === undefined) return { ok: false, reason: 'invalid-get-input' };
  const links = record['include_links'];
  if (links !== undefined && typeof links.value !== 'boolean') return { ok: false, reason: 'invalid-get-input' };
  const ids = readIds(record['ids']!.value, budgets.maxGetIds);
  if (!ids.ok) return ids;
  return { ok: true, ids: ids.ids, includeLinks: links?.value === true };
}

/** Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change. */
function preflight(registry: McpRegistry, settings: Settings, tool: LuxKnowledgeTool): string | undefined {
  let grant: ReadGrant | undefined;
  try {
    registry.endpoint(settings.endpointId);
    grant = registry.currentGrant(settings.endpointId);
  } catch { return 'source-unavailable'; }
  if (!grant) return 'grant-absent';
  if (grant.schemaDigest !== settings.schemaDigest) return 'schema-drift';
  if (grant.generation !== settings.generation) return 'grant-generation-mismatch';
  if (grant.account !== settings.account || grant.resource !== settings.resource) return 'grant-scope-mismatch';
  const visible = registry.visibleTools(settings.endpointId).map(definition => definition.name);
  if (visible.some(name => !ELIGIBLE.has(name))) return 'ineligible-tool-granted';
  if (!visible.includes(tool)) return 'required-definition-absent';
  return undefined;
}

export function createLuxKnowledgeReader(options: LuxKnowledgeOptions): LuxKnowledgeReader {
  const { port, registry, config } = options;
  // Capture stable settings once; later caller mutation of `config` cannot change behavior.
  if (config.includeSensitive !== undefined && typeof config.includeSensitive !== 'boolean') throw Error('invalid-connector-config');
  const settings: Settings = {
    includeSensitive: config.includeSensitive === true,
    endpointId: config.endpointId,
    account: config.account,
    resource: config.resource,
    schemaDigest: config.schemaDigest,
    generation: requirePositiveSafeInteger(config.generation),
    maxSearchLimit: requirePositiveSafeInteger(config.maxSearchLimit),
    maxGetIds: requirePositiveSafeInteger(config.maxGetIds),
    maxQueryChars: requirePositiveSafeInteger(config.maxQueryChars),
  };

  async function dispatch(tool: LuxKnowledgeTool, args: Record<string, unknown>, signal?: AbortSignal, requestedIds?: readonly number[]): Promise<LuxKnowledgeResult> {
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
    const evidence: LuxKnowledgeEvidence = {
      classification: 'unknown',
      decodedResult: structuredClone(result.decodedResult),
      capability: 'local-only',
      tool,
      source: { ...result.source },
      ...(result[SOURCE_DISPATCH] ? {[SOURCE_DISPATCH]:result[SOURCE_DISPATCH]} : {}),
      observedAt: result.freshness.receivedAt,
      coverage: structuredClone(result.coverage),
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
    return requestedIds === undefined
      ? { state: result.state, ...evidence }
      : { state: result.state, ...evidence, requestedIds: [...requestedIds] };
  }

  return {
    async search(input: LuxKnowledgeSearchInput, signal?: AbortSignal): Promise<LuxKnowledgeResult> {
      const validated = validateSearch(input, settings);
      if (!validated.ok) return { state: 'refused', reason: validated.reason };
      const denied = preflight(registry, settings, 'search_knowledge');
      if (denied) return { state: 'refused', reason: denied };
      // Copy the validated primitives into the exact outgoing arguments once. The 3r fields travel
      // only when the caller asked for them, so a snippet search keeps the old wire shape.
      const args: Record<string, unknown> = { query: validated.args.query, limit: validated.args.limit, include_sensitive: settings.includeSensitive };
      if (validated.args.detail !== undefined) args['detail'] = validated.args.detail;
      if (validated.args.maxChars !== undefined) args['max_chars'] = validated.args.maxChars;
      if (validated.args.deadlineMs !== undefined) args['deadline_ms'] = validated.args.deadlineMs;
      if (validated.args.project !== undefined) args['project'] = validated.args.project;
      if (validated.args.projectHint !== undefined) args['project_hint'] = validated.args.projectHint;
      if (validated.args.snippetChars !== undefined) args['snippet_chars'] = validated.args.snippetChars;
      if (validated.args.meetingDateFrom !== undefined) args['meeting_date_from'] = validated.args.meetingDateFrom;
      if (validated.args.meetingDateTo !== undefined) args['meeting_date_to'] = validated.args.meetingDateTo;
      return dispatch('search_knowledge', args, signal);
    },
    async get(input: LuxKnowledgeGetInput, signal?: AbortSignal): Promise<LuxKnowledgeResult> {
      const validated = validateGet(input, settings);
      if (!validated.ok) return { state: 'refused', reason: validated.reason };
      const denied = preflight(registry, settings, 'get_insight');
      if (denied) return { state: 'refused', reason: denied };
      const ids = validated.ids;
      const args: Record<string, unknown> = { ids: [...ids], include_links: validated.includeLinks };
      return dispatch('get_insight', args, signal, ids);
    },
  };
}
