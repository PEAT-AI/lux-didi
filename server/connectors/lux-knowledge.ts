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

export interface LuxKnowledgeSource {
  endpointId: string;
  url: string;
  account: string;
  resource: string;
  schemaDigest: string;
  generation: number;
}

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
  search(input: LuxKnowledgeSearchInput): Promise<LuxKnowledgeResult>;
  get(input: LuxKnowledgeGetInput): Promise<LuxKnowledgeResult>;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
/** `undefined` means the input is well formed; otherwise a reason with no dispatch. */
function validateSearch(input: unknown, config: LuxKnowledgeConfig): string | undefined {
  if (!isPlainObject(input) || !hasExactKeys(input, ['query', 'limit'])) return 'invalid-search-input';
  const query = input.query;
  const limit = input.limit;
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > config.maxQueryChars) return 'invalid-query';
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > config.maxSearchLimit) return 'search-limit-out-of-budget';
  return undefined;
}
function validateGet(input: unknown, config: LuxKnowledgeConfig): string | undefined {
  if (!isPlainObject(input) || !hasExactKeys(input, ['ids'])) return 'invalid-get-input';
  const ids = input.ids;
  if (!Array.isArray(ids)) return 'ids-not-array';
  if (ids.length === 0) return 'ids-empty';
  if (ids.length > config.maxGetIds) return 'get-batch-out-of-budget';
  if (!ids.every(id => Number.isSafeInteger(id) && (id as number) > 0)) return 'ids-not-positive-integer';
  if (new Set(ids).size !== ids.length) return 'ids-not-unique';
  return undefined;
}
/** Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change. */
function preflight(registry: McpRegistry, config: LuxKnowledgeConfig, tool: LuxKnowledgeTool): string | undefined {
  let grant: ReadGrant | undefined;
  try {
    registry.endpoint(config.endpointId);
    grant = registry.currentGrant(config.endpointId);
  } catch { return 'source-unavailable'; }
  if (!grant) return 'grant-absent';
  if (grant.schemaDigest !== config.schemaDigest) return 'schema-drift';
  if (grant.generation !== config.generation) return 'grant-generation-mismatch';
  if (grant.account !== config.account || grant.resource !== config.resource) return 'grant-scope-mismatch';
  const visible = registry.visibleTools(config.endpointId).map(definition => definition.name);
  if (visible.some(name => !ELIGIBLE.has(name))) return 'ineligible-tool-granted';
  if (!visible.includes(tool)) return 'required-definition-absent';
  return undefined;
}

export function createLuxKnowledgeReader(options: LuxKnowledgeOptions): LuxKnowledgeReader {
  const { port, registry, config } = options;

  async function dispatch(tool: LuxKnowledgeTool, args: Record<string, unknown>, requestedIds?: readonly number[]): Promise<LuxKnowledgeResult> {
    const request: CallRequest = {
      endpointId: config.endpointId,
      toolName: tool,
      arguments: args,
      generation: config.generation,
      account: config.account,
      resource: config.resource,
    };
    const result = await port.call(request);
    if (isFailed(result)) {
      return result.state === 'refused'
        ? { state: 'refused', reason: result.reason }
        : { state: 'unknown', reason: result.reason };
    }
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
    async search(input: LuxKnowledgeSearchInput): Promise<LuxKnowledgeResult> {
      const invalid = validateSearch(input, config);
      if (invalid) return { state: 'refused', reason: invalid };
      const denied = preflight(registry, config, 'search_knowledge');
      if (denied) return { state: 'refused', reason: denied };
      return dispatch('search_knowledge', { query: input.query, limit: input.limit, include_sensitive: false });
    },
    async get(input: LuxKnowledgeGetInput): Promise<LuxKnowledgeResult> {
      const invalid = validateGet(input, config);
      if (invalid) return { state: 'refused', reason: invalid };
      const denied = preflight(registry, config, 'get_insight');
      if (denied) return { state: 'refused', reason: denied };
      const ids = [...input.ids];
      return dispatch('get_insight', { ids, include_links: false }, ids);
    },
  };
}
