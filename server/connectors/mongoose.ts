import type { CallRequest, CompletedResult, McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The only remote Mongoose tools this connector may ever read, in fixed order.
 * Writes (create/update/claim ticket, authoring tools) are deliberately absent: no
 * caller override can add them, and a grant carrying an unlisted name is refused.
 */
export const MONGOOSE_TOOLS = [
  'ask_mongoose',
  'search_mongoose',
  'get_knowledge_item',
  'read_knowledge_body',
  'get_company_profile',
  'list_tickets',
  'get_ticket',
] as const;
export type MongooseTool = (typeof MONGOOSE_TOOLS)[number];

export interface MongooseConfig {
  endpointId: string;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  /** Request budget: largest `limit` a search caller may select. */
  maxSearchLimit: number;
  /** Batch budget: largest `limit` a list caller may select. */
  maxGetIds: number;
  /** Bound on query or question length in characters. */
  maxQueryChars: number;
}

/** Opaque local evidence: classification is a constant, remote markdown can never change it. */
export interface MongooseEvidence {
  classification: 'unknown';
  capability: 'local-only';
  tool: MongooseTool;
  source: CompletedResult['source'];
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}
export interface MongooseRefused { state: 'refused'; reason: string }
export interface MongooseUnknown { state: 'unknown'; reason: string }
export type MongooseResult =
  | (MongooseEvidence & { state: 'completed' | 'tool-error' | 'protocol-error' })
  | MongooseRefused
  | MongooseUnknown;

export interface MongooseReader {
  ask(question: string, limit: number, signal?: AbortSignal): Promise<MongooseResult>;
  search(query: string, limit: number, signal?: AbortSignal): Promise<MongooseResult>;
  getKnowledgeItem(id: string, signal?: AbortSignal): Promise<MongooseResult>;
  readKnowledgeBody(id: string, signal?: AbortSignal): Promise<MongooseResult>;
  companyProfile(signal?: AbortSignal): Promise<MongooseResult>;
  listTickets(limit: number, signal?: AbortSignal): Promise<MongooseResult>;
  getTicket(id: string, signal?: AbortSignal): Promise<MongooseResult>;
}

export interface MongooseOptions {
  port: McpPort;
  registry: McpRegistry;
  config: MongooseConfig;
}

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MONGOOSE_TOOLS);

/** Distinguishes the adapter's non-completed outcomes from a completed protocol result. */
type FailedCall = { state: 'refused' | 'unknown'; reason: string };
function isFailed(result: { state: string }): result is FailedCall {
  return result.state === 'refused' || result.state === 'unknown';
}

function positiveSafeInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  maxSearchLimit: number; maxGetIds: number; maxQueryChars: number;
}

/**
 * Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change:
 * a caller can never widen the grant, and an unexpected granted tool refuses the whole call.
 */
function preflight(registry: McpRegistry, settings: Settings, tool: MongooseTool): string | undefined {
  let grant;
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

export function createMongooseReader(options: MongooseOptions): MongooseReader {
  const { port, registry, config } = options;
  const settings: Settings = {
    endpointId: config.endpointId,
    account: config.account,
    resource: config.resource,
    schemaDigest: config.schemaDigest,
    generation: config.generation,
    maxSearchLimit: config.maxSearchLimit,
    maxGetIds: config.maxGetIds,
    maxQueryChars: config.maxQueryChars,
  };

  async function dispatch(tool: MongooseTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult> {
    const denied = preflight(registry, settings, tool);
    if (denied) return { state: 'refused', reason: denied };
    if (signal?.aborted) return { state: 'refused', reason: 'cancelled-before-dispatch' };
    const request: CallRequest = {
      endpointId: settings.endpointId,
      toolName: tool,
      arguments: args,
      generation: settings.generation,
      account: settings.account,
      resource: settings.resource,
    };
    const result = await port.call(request, signal);
    if (isFailed(result)) return { state: result.state, reason: result.reason };
    if (signal?.aborted) return { state: 'unknown', reason: 'cancelled-after-dispatch' };
    const evidence: MongooseEvidence = {
      classification: 'unknown',
      capability: 'local-only',
      tool,
      source: structuredClone(result.source),
      observedAt: result.freshness.receivedAt,
      coverage: structuredClone(result.coverage),
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
    return { state: result.state, ...evidence };
  }

  const intArgs = (key: string, value: number, max: number): Record<string, unknown> | undefined =>
    positiveSafeInteger(value, max) ? { [key]: value } : undefined;

  return {
    async ask(question, limit, signal) {
      if (!boundedText(question, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-question' };
      const bounded = intArgs('limit', limit, settings.maxSearchLimit);
      if (!bounded) return { state: 'refused', reason: 'ask-limit-out-of-budget' };
      return dispatch('ask_mongoose', { question, ...bounded }, signal);
    },
    async search(query, limit, signal) {
      if (!boundedText(query, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-query' };
      const bounded = intArgs('limit', limit, settings.maxSearchLimit);
      if (!bounded) return { state: 'refused', reason: 'search-limit-out-of-budget' };
      return dispatch('search_mongoose', { query, ...bounded }, signal);
    },
    async getKnowledgeItem(id, signal) {
      if (!boundedText(id, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('get_knowledge_item', { id }, signal);
    },
    async readKnowledgeBody(id, signal) {
      if (!boundedText(id, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('read_knowledge_body', { id }, signal);
    },
    async companyProfile(signal) {
      return dispatch('get_company_profile', {}, signal);
    },
    async listTickets(limit, signal) {
      const bounded = intArgs('limit', limit, settings.maxGetIds);
      if (!bounded) return { state: 'refused', reason: 'list-limit-out-of-budget' };
      return dispatch('list_tickets', bounded, signal);
    },
    async getTicket(id, signal) {
      if (!boundedText(id, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('get_ticket', { id }, signal);
    },
  };
}
