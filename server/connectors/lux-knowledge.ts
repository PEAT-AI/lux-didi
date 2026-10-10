import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/** The only remote tools this connector may ever call, in fixed order. No caller override. */
export const LUX_KNOWLEDGE_TOOLS = ['search_knowledge', 'get_insight'] as const;
export type LuxKnowledgeTool = (typeof LUX_KNOWLEDGE_TOOLS)[number];

export interface LuxKnowledgeConfig {
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

export interface LuxKnowledgeSearchInput { query: string; limit: number }
export interface LuxKnowledgeGetInput { ids: number[] }

export interface HttpLuxKnowledgeSource {
  endpointId: string;
  url: string;
  account: string;
  resource: string;
  schemaDigest: string;
  generation: number;
}
/** Transport-specific provenance: stdio carries no url, only the safe binding digest. */
export interface StdioLuxKnowledgeSource {
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
export interface LuxKnowledgeEvidence {
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return undefined;
  const record: { [key: string]: PropertyDescriptor } = {};
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    record[key] = descriptor;
  }
  for (const key of keys) if (!(key in record)) return undefined;
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
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
}

function validateSearch(input: unknown, budgets: Budgets): { ok: true; query: string; limit: number } | { ok: false; reason: string } {
  const record = readExactRecord(input, ['query', 'limit']);
  if (record === undefined) return { ok: false, reason: 'invalid-search-input' };
  const query = record['query']!.value;
  const limit = record['limit']!.value;
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > budgets.maxQueryChars) return { ok: false, reason: 'invalid-query' };
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > budgets.maxSearchLimit) return { ok: false, reason: 'search-limit-out-of-budget' };
  return { ok: true, query, limit: limit as number };
}
function validateGet(input: unknown, budgets: Budgets): { ok: true; ids: number[] } | { ok: false; reason: string } {
  const record = readExactRecord(input, ['ids']);
  if (record === undefined) return { ok: false, reason: 'invalid-get-input' };
  return readIds(record['ids']!.value, budgets.maxGetIds);
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
  const settings: Settings = {
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
      capability: 'local-only',
      tool,
      source: { ...result.source },
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
      // Copy the validated primitives into the exact outgoing arguments once.
      const args: Record<string, unknown> = { query: validated.query, limit: validated.limit, include_sensitive: false };
      return dispatch('search_knowledge', args, signal);
    },
    async get(input: LuxKnowledgeGetInput, signal?: AbortSignal): Promise<LuxKnowledgeResult> {
      const validated = validateGet(input, settings);
      if (!validated.ok) return { state: 'refused', reason: validated.reason };
      const denied = preflight(registry, settings, 'get_insight');
      if (denied) return { state: 'refused', reason: denied };
      const ids = validated.ids;
      const args: Record<string, unknown> = { ids: [...ids], include_links: false };
      return dispatch('get_insight', args, signal, ids);
    },
  };
}
